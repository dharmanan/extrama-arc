'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const {
  getArcProvider,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  ARC_POOL_TOPOLOGY,
} = require('./arcService');

// One hour, matching the marketplace contract's immutable TRADING_CUTOFF.
// Duplicated here deliberately: this is a read-only projection of onchain
// truth, not a second source of it. If the deployed constant ever changes,
// this must be updated to match -- it is never trusted blindly.
const TRADING_CUTOFF_SECONDS = 3600;

const CONTRACT_STATUSES = ['ENTRY_OPEN', 'LOCKED', 'SETTLED', 'CANCELLED'];
const LISTING_STATUSES = ['ACTIVE', 'SOLD', 'CANCELLED', 'INVALIDATED'];

const MARKETPLACE_ABI = [
  'function nextListingId() view returns (uint256)',
  'function getListing(uint256 listingId) view returns (tuple(address seller,address ticket,uint256 tokenId,uint256 askUsdc,uint256 roundId,uint64 createdAt,uint8 status))',
  'function isListingBuyable(uint256 listingId) view returns (bool)',
];

const TICKET_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
];

const USDC_ALLOWANCE_ABI = [
  'function allowance(address owner,address spender) view returns (uint256)',
];

const POOL_ABI = [
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
];

const MARKETPLACE_INTERFACE = new ethers.Interface(MARKETPLACE_ABI);
const TICKET_INTERFACE = new ethers.Interface(TICKET_ABI);
const POOL_INTERFACE = new ethers.Interface(POOL_ABI);

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)',
];
const MULTICALL3_INTERFACE = new ethers.Interface(MULTICALL3_ABI);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same transient-vs-deterministic distinction as the round-state reader:
// only transport noise is retried, never a real revert.
function isTransientRpcError(error) {
  if (!error) return false;

  const codes = [error?.error?.code, error?.info?.error?.code];
  if (codes.includes(-32005)) return true;

  const messages = [
    error?.error?.message,
    error?.info?.error?.message,
    error?.shortMessage,
    error?.message,
  ];
  if (messages.some((message) => String(message || '').toLowerCase().includes('rate limit'))) {
    return true;
  }

  if (['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'UNKNOWN_ERROR'].includes(error.code)) {
    return true;
  }
  if (error.code === 'CALL_EXCEPTION' && (error.data === null || error.data === undefined)) {
    return true;
  }
  return false;
}

function backoffWithJitter(attempt) {
  const base = 250 * (2 ** attempt);
  return base * (0.5 + Math.random());
}

async function rpcRead(operation, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error) || attempt === attempts - 1) {
        throw error;
      }
      await sleep(backoffWithJitter(attempt));
    }
  }
  throw lastError;
}

let multicall3Availability = null;
let multicall3ProbePromise = null;

async function hasMulticall3(provider) {
  if (multicall3Availability !== null) return multicall3Availability;
  if (!multicall3ProbePromise) {
    multicall3ProbePromise = rpcRead(() => provider.getCode(MULTICALL3_ADDRESS))
      .then((code) => {
        multicall3Availability = code !== '0x';
        return multicall3Availability;
      })
      .finally(() => {
        multicall3ProbePromise = null;
      });
  }
  return multicall3ProbePromise;
}

async function readMulticall3(provider, calls) {
  if (!(await hasMulticall3(provider))) {
    throw new Error('arc_multicall3_not_found');
  }

  const data = MULTICALL3_INTERFACE.encodeFunctionData('aggregate3', [calls]);
  const raw = await rpcRead(() => provider.call({ to: MULTICALL3_ADDRESS, data }));
  const [results] = MULTICALL3_INTERFACE.decodeFunctionResult('aggregate3', raw);
  if (results.length !== calls.length) {
    throw new Error('arc_multicall3_result_mismatch');
  }
  return results;
}

async function readMulticall3InChunks(provider, calls, chunkSize = 100) {
  const results = [];
  for (let index = 0; index < calls.length; index += chunkSize) {
    results.push(...await readMulticall3(provider, calls.slice(index, index + chunkSize)));
  }
  return results;
}

function decodeMulticallResult(iface, fnName, result) {
  if (!result?.success) return null;
  try {
    return iface.decodeFunctionResult(fnName, result.returnData);
  } catch {
    return null;
  }
}

function toIso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function formatUsdc(raw) {
  return ethers.formatUnits(raw, 6);
}

function findTopologyByTicket(ticketAddress) {
  const lower = ticketAddress.toLowerCase();
  return ARC_POOL_TOPOLOGY.find((item) => item.ticketAddress.toLowerCase() === lower) ?? null;
}

function slugify(asset, cadence, direction) {
  return `${asset.toLowerCase()}-${cadence.toLowerCase()}-${direction.toLowerCase()}`;
}

// One projection of onchain + derived state per listing. `state` is the
// six-value UI state the frontend renders directly; `onchainStatus` is the
// raw contract enum, kept alongside so nothing is lost in the projection.
function buildListingEntry({
  listingId,
  listing,
  topology,
  round,
  entry,
  currentOwner,
  approvedAddress,
  isBuyable,
  now,
}) {
  const onchainStatus = LISTING_STATUSES[Number(listing.status)] ?? null;
  const askUsdcRaw = listing.askUsdc.toString();
  const roundId = Number(listing.roundId);
  const roundStatus = round ? (CONTRACT_STATUSES[Number(round.status)] ?? null) : null;
  const observationEndAt = round ? toIso(round.observationEndAt) : null;
  const tradingCutoffAt = round && Number(round.observationEndAt) > TRADING_CUTOFF_SECONDS
    ? toIso(Number(round.observationEndAt) - TRADING_CUTOFF_SECONDS)
    : null;

  const isApproved = approvedAddress !== null
    && approvedAddress.toLowerCase() === config.EXTREMA_MARKETPLACE_ADDRESS.toLowerCase();
  const ownershipMatches = currentOwner !== null
    && currentOwner.toLowerCase() === listing.seller.toLowerCase();

  const windowOpen = tradingCutoffAt !== null && now < Date.parse(tradingCutoffAt)
    && (roundStatus === 'ENTRY_OPEN' || roundStatus === 'LOCKED');

  let state;
  let unbuyableReason = null;

  if (onchainStatus === 'SOLD') {
    state = 'SOLD';
  } else if (onchainStatus === 'CANCELLED') {
    state = 'CANCELLED';
  } else if (onchainStatus === 'INVALIDATED') {
    state = 'INVALIDATED';
  } else if (onchainStatus === 'ACTIVE') {
    if (isBuyable) {
      state = 'ACTIVE';
    } else if (!windowOpen) {
      state = 'EXPIRED';
    } else {
      state = 'ACTION_NEEDED';
      unbuyableReason = !ownershipMatches ? 'ownership_changed' : 'approval_revoked';
    }
  } else {
    // Defensive: an unrecognised status code should never silently masquerade
    // as a known one.
    state = null;
  }

  const predictionPriceCents = entry ? entry.predictionPriceCents.toString() : null;

  return {
    listingId: listingId.toString(),
    onchainStatus,
    state,
    unbuyableReason,
    isBuyable: Boolean(isBuyable),
    seller: ethers.getAddress(listing.seller),
    currentOwner: currentOwner !== null ? ethers.getAddress(currentOwner) : null,
    isApproved,
    askUsdcRaw,
    askUsdc: formatUsdc(askUsdcRaw),
    createdAt: toIso(listing.createdAt),
    asset: topology.asset,
    direction: topology.direction,
    cadence: topology.cadence,
    slug: slugify(topology.asset, topology.cadence, topology.direction),
    poolAddress: topology.poolAddress,
    ticketAddress: ethers.getAddress(listing.ticket),
    tokenId: listing.tokenId.toString(),
    roundId,
    roundStatus,
    observationEndAt,
    tradingCutoffAt,
    predictionPriceCents,
    predictionPrice: predictionPriceCents !== null
      ? (Number(predictionPriceCents) / 100).toFixed(2)
      : null,
  };
}

async function readMarketplaceListingsState() {
  const provider = getArcProvider();
  const marketplaceAddress = ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS);

  const [network, blockNumber, code] = await Promise.all([
    rpcRead(() => provider.getNetwork()),
    rpcRead(() => provider.getBlockNumber()),
    rpcRead(() => provider.getCode(marketplaceAddress)),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }
  if (code === '0x') {
    throw new Error('arc_marketplace_contract_not_found');
  }

  const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);
  const nextListingId = await rpcRead(() => marketplace.nextListingId());

  const chain = {
    id: Number(network.chainId),
    name: 'Arc Testnet',
    blockNumber,
    explorerUrl: 'https://testnet.arcscan.app',
  };
  const marketplaceSummary = {
    address: marketplaceAddress,
    listingCount: Math.max(0, Number(nextListingId) - 1),
  };

  // No listing has ever been created. This is the genuine, honest empty
  // state -- stated directly, not inferred from an empty array that could
  // just as easily mean "the read failed silently".
  if (nextListingId <= 1n) {
    return { chain, marketplace: marketplaceSummary, listings: [], degradedListings: [] };
  }

  const listingIds = [];
  for (let id = 1n; id < nextListingId; id += 1n) {
    listingIds.push(id);
  }

  const getListingResults = await readMulticall3InChunks(provider, listingIds.map((id) => ({
    target: marketplaceAddress,
    allowFailure: true,
    callData: MARKETPLACE_INTERFACE.encodeFunctionData('getListing', [id]),
  })));

  const degradedListings = [];
  const resolved = [];

  getListingResults.forEach((result, index) => {
    const listingId = listingIds[index];
    const decoded = decodeMulticallResult(MARKETPLACE_INTERFACE, 'getListing', result);
    if (!decoded) {
      degradedListings.push({ listingId: listingId.toString(), reason: 'listing_read_failed' });
      return;
    }

    const listing = decoded[0];
    const topology = findTopologyByTicket(listing.ticket);
    if (!topology) {
      degradedListings.push({ listingId: listingId.toString(), reason: 'unrecognised_ticket_contract' });
      return;
    }

    resolved.push({ listingId, listing, topology });
  });

  if (resolved.length === 0) {
    return { chain, marketplace: marketplaceSummary, listings: [], degradedListings };
  }

  // Second multicall phase: every enrichment read depends on the decoded
  // listings above, so it cannot be folded into the first batch.
  const enrichmentCalls = [];
  resolved.forEach(({ listingId, listing, topology }) => {
    enrichmentCalls.push(
      { target: topology.poolAddress, allowFailure: true, callData: POOL_INTERFACE.encodeFunctionData('getRound', [listing.roundId]) },
      { target: topology.poolAddress, allowFailure: true, callData: POOL_INTERFACE.encodeFunctionData('entries', [listing.tokenId]) },
      { target: topology.ticketAddress, allowFailure: true, callData: TICKET_INTERFACE.encodeFunctionData('ownerOf', [listing.tokenId]) },
      { target: topology.ticketAddress, allowFailure: true, callData: TICKET_INTERFACE.encodeFunctionData('getApproved', [listing.tokenId]) },
      { target: marketplaceAddress, allowFailure: true, callData: MARKETPLACE_INTERFACE.encodeFunctionData('isListingBuyable', [listingId]) },
    );
  });

  const enrichmentResults = await readMulticall3InChunks(provider, enrichmentCalls, 100);

  const now = Date.now();
  const listings = resolved.map(({ listingId, listing, topology }, index) => {
    const base = index * 5;
    const round = decodeMulticallResult(POOL_INTERFACE, 'getRound', enrichmentResults[base])?.[0] ?? null;
    const entry = decodeMulticallResult(POOL_INTERFACE, 'entries', enrichmentResults[base + 1]) ?? null;
    const ownerDecoded = decodeMulticallResult(TICKET_INTERFACE, 'ownerOf', enrichmentResults[base + 2]);
    const approvedDecoded = decodeMulticallResult(TICKET_INTERFACE, 'getApproved', enrichmentResults[base + 3]);
    const isBuyableDecoded = decodeMulticallResult(MARKETPLACE_INTERFACE, 'isListingBuyable', enrichmentResults[base + 4]);

    return buildListingEntry({
      listingId,
      listing,
      topology,
      round,
      entry,
      currentOwner: ownerDecoded ? ownerDecoded[0] : null,
      approvedAddress: approvedDecoded ? approvedDecoded[0] : null,
      isBuyable: isBuyableDecoded ? isBuyableDecoded[0] : false,
      now,
    });
  });

  listings.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return { chain, marketplace: marketplaceSummary, listings, degradedListings };
}

const MARKETPLACE_LISTINGS_CACHE_TTL_MS = 15_000;
let marketplaceListingsCache = null;
let marketplaceListingsCacheAt = 0;
let marketplaceListingsRefreshPromise = null;

async function refreshMarketplaceListingsCache() {
  if (marketplaceListingsRefreshPromise) return marketplaceListingsRefreshPromise;

  marketplaceListingsRefreshPromise = readMarketplaceListingsState()
    .then((state) => {
      marketplaceListingsCache = state;
      marketplaceListingsCacheAt = Date.now();
      if (state.degradedListings.length) {
        console.warn(
          '[marketplace-cache] published with degraded listings this cycle',
          JSON.stringify(state.degradedListings),
        );
      }
      return state;
    })
    .finally(() => {
      marketplaceListingsRefreshPromise = null;
    });

  return marketplaceListingsRefreshPromise;
}

async function getMarketplaceListingsState({ forceFresh = false } = {}) {
  const ageMs = Date.now() - marketplaceListingsCacheAt;

  if (!forceFresh && marketplaceListingsCache) {
    if (ageMs > MARKETPLACE_LISTINGS_CACHE_TTL_MS && !marketplaceListingsRefreshPromise) {
      refreshMarketplaceListingsCache().catch((error) => {
        console.error('[marketplace-cache] background refresh failed', error.message);
      });
    }
    return marketplaceListingsCache;
  }

  return refreshMarketplaceListingsCache();
}

// Single-listing direct read, independent of the cached full board -- used
// by the listing-detail endpoint so one stale/slow listing never has to wait
// on (or be limited by) the full range scan above.
async function readMarketplaceListing(listingId) {
  if (!Number.isInteger(listingId) || listingId <= 0) {
    throw new Error('marketplace_listing_request_invalid');
  }

  const provider = getArcProvider();
  const marketplaceAddress = ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS);
  const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);

  const network = await rpcRead(() => provider.getNetwork());
  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  let listing;
  try {
    listing = await rpcRead(() => marketplace.getListing(listingId));
  } catch {
    throw new Error('marketplace_listing_not_found');
  }

  const topology = findTopologyByTicket(listing.ticket);
  if (!topology) {
    throw new Error('marketplace_listing_unsupported_ticket');
  }

  const pool = new ethers.Contract(topology.poolAddress, POOL_ABI, provider);
  const ticket = new ethers.Contract(topology.ticketAddress, TICKET_ABI, provider);

  const [round, entry, currentOwner, approvedAddress, isBuyable, blockNumber] = await Promise.all([
    rpcRead(() => pool.getRound(listing.roundId)).catch(() => null),
    rpcRead(() => pool.entries(listing.tokenId)).catch(() => null),
    rpcRead(() => ticket.ownerOf(listing.tokenId)).catch(() => null),
    rpcRead(() => ticket.getApproved(listing.tokenId)).catch(() => null),
    rpcRead(() => marketplace.isListingBuyable(listingId)).catch(() => false),
    rpcRead(() => provider.getBlockNumber()),
  ]);

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      blockNumber,
      explorerUrl: 'https://testnet.arcscan.app',
    },
    listing: buildListingEntry({
      listingId: BigInt(listingId),
      listing,
      topology,
      round,
      entry,
      currentOwner,
      approvedAddress,
      isBuyable,
      now: Date.now(),
    }),
  };
}

// Live per-token approval check, independent of any listing -- used before a
// seller lists or relists a ticket, and before a price update, so the
// frontend can offer the exact per-token approve step only when it is
// actually needed rather than unconditionally.
async function readTicketApprovalState({ ticketAddress, tokenId }) {
  if (!ethers.isAddress(ticketAddress)) {
    throw new Error('marketplace_approval_request_invalid');
  }
  if (typeof tokenId !== 'string' || !/^[1-9][0-9]*$/.test(tokenId)) {
    throw new Error('marketplace_approval_request_invalid');
  }

  const topology = findTopologyByTicket(ticketAddress);
  if (!topology) {
    throw new Error('marketplace_approval_unsupported_ticket');
  }

  const provider = getArcProvider();
  const marketplaceAddress = ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS);
  const ticket = new ethers.Contract(topology.ticketAddress, TICKET_ABI, provider);

  let owner;
  try {
    owner = await rpcRead(() => ticket.ownerOf(tokenId));
  } catch {
    throw new Error('marketplace_ticket_not_found');
  }

  const approvedAddress = await rpcRead(() => ticket.getApproved(tokenId)).catch(() => null);
  const isApproved = approvedAddress !== null
    && approvedAddress.toLowerCase() === marketplaceAddress.toLowerCase();

  return {
    ticketAddress: topology.ticketAddress,
    tokenId,
    owner: ethers.getAddress(owner),
    marketplaceAddress,
    isApproved,
  };
}

// Live USDC allowance from a wallet to the marketplace contract -- used
// before a buyer confirms a purchase, so the frontend can offer the exact
// USDC approve step only when the current allowance is insufficient for the
// specific ask being bought.
async function readUsdcAllowance({ owner }) {
  if (!ethers.isAddress(owner)) {
    throw new Error('marketplace_allowance_request_invalid');
  }

  const provider = getArcProvider();
  const marketplaceAddress = ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS);
  const usdc = new ethers.Contract(ARC_TESTNET_USDC_ADDRESS, USDC_ALLOWANCE_ABI, provider);

  const allowanceRaw = await rpcRead(() => usdc.allowance(owner, marketplaceAddress));

  return {
    owner: ethers.getAddress(owner),
    marketplaceAddress,
    usdcAddress: ARC_TESTNET_USDC_ADDRESS,
    allowanceRaw: allowanceRaw.toString(),
  };
}

module.exports = {
  getMarketplaceListingsState,
  refreshMarketplaceListingsCache,
  readMarketplaceListing,
  readTicketApprovalState,
  readUsdcAllowance,
};
