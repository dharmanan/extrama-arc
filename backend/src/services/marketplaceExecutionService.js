'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const arcService = require('./arcService');
const marketplaceService = require('./marketplaceService');

// Human execution modes only. Every marketplace transaction is signed by the
// user's own wallet: the connected wallet (EXTERNAL_OWNER) or the Circle
// user controlled wallet through a hosted Circle challenge. EXTREMA builds
// the exact calldata and verifies the mined result; it never signs.
const EXTERNAL_MODES = ['EXTERNAL_OWNER'];
const CIRCLE_MODES = ['CIRCLE_USER_WALLET'];
const EXECUTION_MODES = [...EXTERNAL_MODES, ...CIRCLE_MODES];

// One hour, matching the marketplace contract's immutable TRADING_CUTOFF.
// Duplicated deliberately, same reasoning as marketplaceService.js: this is
// a projection of onchain truth used for a fast pre-check, never the
// authority. The contract call itself is still the actual gate.
const TRADING_CUTOFF_SECONDS = 3600;

const MARKETPLACE_ABI = [
  'function list(address ticket,uint256 tokenId,uint256 askUsdc) returns (uint256 listingId)',
  'function updatePrice(uint256 listingId,uint256 newAskUsdc)',
  'function cancel(uint256 listingId)',
  'function buy(uint256 listingId,uint256 expectedAskUsdc)',
  'event Listed(uint256 indexed listingId,address indexed seller,address indexed ticket,uint256 tokenId,uint256 askUsdc,uint256 roundId)',
  'event ListingPriceUpdated(uint256 indexed listingId,uint256 askUsdc)',
  'event Cancelled(uint256 indexed listingId)',
  'event Sold(uint256 indexed listingId,address indexed seller,address indexed buyer,address ticket,uint256 tokenId,uint256 askUsdc)',
  'error ZeroAddress()',
  'error InvalidAskPrice()',
  'error UnsupportedTicket()',
  'error TicketNotFound()',
  'error NotTicketOwner()',
  'error ActiveListingExists()',
  'error ListingNotFound()',
  'error ListingNotActive()',
  'error NotListingSeller()',
  'error SellerNotOwner()',
  'error BuyerIsSeller()',
  'error RoundNotTradable()',
  'error TradingWindowClosed()',
  'error TokenNotApproved()',
  'error TokenTransferFailed()',
  'error NftTransferFailed()',
  'error Reentrancy()',
  'error PriceChanged()',
];

const TICKET_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function approve(address to,uint256 tokenId)',
];

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
];

const POOL_ABI = [
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
];

const MARKETPLACE_INTERFACE = new ethers.Interface(MARKETPLACE_ABI);
const TICKET_INTERFACE = new ethers.Interface(TICKET_ABI);
const USDC_INTERFACE = new ethers.Interface(USDC_ABI);

// Every contract revert this service can encounter, mapped to a stable
// application-level identifier. The raw Solidity error name is decoded only
// to look itself up in this table -- it never reaches a caller, a log
// message intended for the client, or the frontend. Anything not found here
// falls back to a single generic identifier rather than leaking the name.
const CONTRACT_ERROR_TO_APP_ERROR = {
  ZeroAddress: 'marketplace_invalid_request',
  InvalidAskPrice: 'marketplace_invalid_ask_price',
  UnsupportedTicket: 'marketplace_unsupported_ticket',
  TicketNotFound: 'marketplace_ticket_not_found',
  NotTicketOwner: 'marketplace_not_ticket_owner',
  ActiveListingExists: 'marketplace_already_listed',
  ListingNotFound: 'marketplace_listing_not_found',
  ListingNotActive: 'marketplace_listing_not_active',
  NotListingSeller: 'marketplace_not_listing_seller',
  SellerNotOwner: 'marketplace_seller_no_longer_owner',
  BuyerIsSeller: 'marketplace_buyer_is_seller',
  RoundNotTradable: 'marketplace_round_not_tradable',
  TradingWindowClosed: 'marketplace_trading_window_closed',
  TokenNotApproved: 'marketplace_token_not_approved',
  TokenTransferFailed: 'marketplace_usdc_transfer_failed',
  NftTransferFailed: 'marketplace_nft_transfer_failed',
  Reentrancy: 'marketplace_transaction_failed',
  PriceChanged: 'marketplace_price_changed',
};

function decodeRevertErrorName(error) {
  const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
  if (!data || typeof data !== 'string') return null;
  try {
    return MARKETPLACE_INTERFACE.parseError(data)?.name ?? null;
  } catch {
    return null;
  }
}

// Wraps a marketplace contract call attempt. A decoded, known revert becomes
// a clean application error; anything else propagates unchanged so it is
// never silently swallowed.
async function callMarketplace(operation) {
  try {
    return await operation();
  } catch (error) {
    const name = decodeRevertErrorName(error);
    const mapped = name && CONTRACT_ERROR_TO_APP_ERROR[name];
    if (mapped) throw new Error(mapped);
    throw error;
  }
}

function requireSuccessfulReceipt(receipt, errorName) {
  if (!receipt || receipt.status !== 1) throw new Error(errorName);
}

function findLogEvent(receipt, iface, { address, name, predicate }) {
  for (const log of receipt.logs) {
    if (address && log.address.toLowerCase() !== address.toLowerCase()) continue;

    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }

    if (parsed?.name === name && (!predicate || predicate(parsed))) {
      return parsed;
    }
  }

  return null;
}

function requireMarketplaceContract(payload) {
  const marketplaceAddress = ethers.getAddress(payload.contract);
  if (marketplaceAddress.toLowerCase() !== config.EXTREMA_MARKETPLACE_ADDRESS.toLowerCase()) {
    throw new Error('marketplace_contract_mismatch');
  }
  return marketplaceAddress;
}

async function resolveRoundForTicket(ticketAddress, tokenId, provider) {
  const topology = arcService.ARC_POOL_TOPOLOGY.find(
    (item) => item.ticketAddress.toLowerCase() === ticketAddress.toLowerCase(),
  );
  if (!topology) throw new Error('marketplace_unsupported_ticket');

  const pool = new ethers.Contract(topology.poolAddress, POOL_ABI, provider);

  let entry;
  try {
    entry = await pool.entries(tokenId);
  } catch {
    throw new Error('marketplace_ticket_not_found');
  }

  const roundId = Number(entry.roundId);
  if (!roundId) throw new Error('marketplace_ticket_not_found');

  const round = await pool.getRound(roundId);
  return { topology, pool, roundId, round };
}

function requireTradable(round) {
  const status = Number(round.status);
  if (status !== 0 && status !== 1) throw new Error('marketplace_round_not_tradable');

  const observationEndAt = Number(round.observationEndAt);
  if (observationEndAt <= TRADING_CUTOFF_SECONDS) throw new Error('marketplace_trading_window_closed');

  const cutoff = observationEndAt - TRADING_CUTOFF_SECONDS;
  if (Math.floor(Date.now() / 1000) >= cutoff) throw new Error('marketplace_trading_window_closed');
}

// Awaited at every call site before its caller returns a success result, so
// the shared board cache is already correct by the time the HTTP response
// goes out -- the very next listings read (this client's or any other tab's)
// can never observe the pre-action board. Never left to run in the
// background: that gap is exactly what let /tickets keep offering "List for
// sale" after a listing had already gone through.
async function refreshMarketplaceCaches(...addresses) {
  addresses.forEach((address) => {
    if (address) arcService.invalidateArcWalletStateCache(address);
  });
  try {
    await marketplaceService.refreshMarketplaceListingsCache();
  } catch (error) {
    console.error('[marketplace-cache] post-action refresh failed', error.message);
  }
}

// Direct, always fresh chain read, used immediately before ever building or
// sending a list() transaction -- the last check before spending gas. A
// second, independent layer from the /marketplace-list/start preflight:
// this one runs right at the moment of action, closing the race window
// where another client's list could have landed in between.
async function assertTicketNotAlreadyListed(ticketAddress, tokenId) {
  const active = await marketplaceService.readActiveListingForTicket({ ticketAddress, tokenId });
  if (active.activeListingId) throw new Error('marketplace_already_listed');
}

// =============================================================================
// Shared transaction helpers
// =============================================================================

const ERC721_TRANSFER_INTERFACE = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
]);

function assertMode(payload, allowedModes) {
  if (!allowedModes.includes(payload.executionMode)) {
    throw new Error('marketplace_execution_mode_mismatch');
  }
}

async function requireArcProvider() {
  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');
  return { provider, network };
}

function assertTxHash(txHash) {
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('marketplace_txhash_invalid');
  }
}

async function readMinedTransaction(provider, txHash, notFoundError, failedError) {
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error(notFoundError);
  requireSuccessfulReceipt(receipt, failedError);
  return { tx, receipt };
}

// The mined transaction must be exactly the one EXTREMA built: same sender,
// same target contract, no native value, and byte identical calldata.
function assertSignedCall(tx, { from, to, data }) {
  if (ethers.getAddress(tx.from).toLowerCase() !== from.toLowerCase()) {
    throw new Error('marketplace_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== to.toLowerCase()) {
    throw new Error('marketplace_target_mismatch');
  }
  if (tx.value !== 0n) throw new Error('marketplace_value_mismatch');
  if (String(tx.data).toLowerCase() !== data.toLowerCase()) {
    throw new Error('marketplace_calldata_mismatch');
  }
}

function transactionRequest(network, { from, to, data }) {
  return {
    chainId: Number(network.chainId),
    to,
    data,
    value: '0x0',
    from,
  };
}

// =============================================================================
// List
// =============================================================================

function assertListPayloadShape(payload) {
  if (
    !payload ||
    payload.action !== 'MARKETPLACE_LIST' ||
    payload.chainId !== 5042002 ||
    !ethers.isAddress(payload.contract) ||
    !ethers.isAddress(payload.ticketAddress) ||
    !ethers.isAddress(payload.walletAddress) ||
    typeof payload.tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.tokenId) ||
    typeof payload.askUsdcRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.askUsdcRaw) ||
    !EXECUTION_MODES.includes(payload.executionMode) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new Error('action_authorization_invalid');
  }
}

function assertListPayloadFresh(payload) {
  if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error('action_authorization_expired');
}

function listCalldata(ticketAddress, tokenId, askUsdc) {
  return MARKETPLACE_INTERFACE.encodeFunctionData('list', [ticketAddress, tokenId, askUsdc]);
}

function perTokenApprovalCalldata(marketplaceAddress, tokenId) {
  // Exactly one tokenId, never an operator wide approval.
  return TICKET_INTERFACE.encodeFunctionData('approve', [marketplaceAddress, tokenId]);
}

// Direct, always fresh chain reads taken immediately before any list related
// transaction is built -- the tradable window, a second independent
// not already listed check (closing the race with another client's listing
// after /marketplace-list/start), and current NFT ownership.
async function readListableTicket(payload) {
  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const ticketAddress = ethers.getAddress(payload.ticketAddress);
  const sellerAddress = ethers.getAddress(payload.walletAddress);

  const { round } = await resolveRoundForTicket(ticketAddress, payload.tokenId, provider);
  requireTradable(round);
  await assertTicketNotAlreadyListed(ticketAddress, payload.tokenId);

  const approval = await marketplaceService.readTicketApprovalState({
    ticketAddress,
    tokenId: payload.tokenId,
  });
  if (approval.owner.toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error('marketplace_not_ticket_owner');
  }
  return { provider, network, marketplaceAddress, ticketAddress, sellerAddress, approval };
}

async function buildListTransactionRequest(payload, allowedModes) {
  assertListPayloadShape(payload);
  assertListPayloadFresh(payload);
  assertMode(payload, allowedModes);

  const { network, marketplaceAddress, ticketAddress, sellerAddress, approval } =
    await readListableTicket(payload);
  // The per token approval must already be verified onchain before list() is
  // built: as its own connected wallet transaction, or as the Circle
  // approval phase.
  if (!approval.isApproved) throw new Error('marketplace_token_not_approved');

  return transactionRequest(network, {
    from: sellerAddress,
    to: marketplaceAddress,
    data: listCalldata(ticketAddress, BigInt(payload.tokenId), BigInt(payload.askUsdcRaw)),
  });
}

// Circle phase 1. When the exact per token approval already exists the list
// transaction is issued directly; otherwise the Circle wallet approves first.
async function prepareCircleListApproval(payload) {
  assertListPayloadShape(payload);
  assertListPayloadFresh(payload);
  assertMode(payload, CIRCLE_MODES);

  const { provider, network, marketplaceAddress, ticketAddress, sellerAddress, approval } =
    await readListableTicket(payload);
  if (await provider.getBalance(sellerAddress) === 0n) throw new Error('marketplace_insufficient_gas');
  if (approval.isApproved) return { required: false, transactionRequest: null };

  return {
    required: true,
    transactionRequest: transactionRequest(network, {
      from: sellerAddress,
      to: ticketAddress,
      data: perTokenApprovalCalldata(marketplaceAddress, BigInt(payload.tokenId)),
    }),
  };
}

async function verifyCircleListApprovalReceipt(payload, txHash) {
  assertListPayloadShape(payload);
  assertMode(payload, CIRCLE_MODES);
  assertTxHash(txHash);

  const { provider } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const ticketAddress = ethers.getAddress(payload.ticketAddress);
  const sellerAddress = ethers.getAddress(payload.walletAddress);

  const { tx } = await readMinedTransaction(
    provider, txHash, 'marketplace_approval_transaction_not_found', 'marketplace_approval_failed',
  );
  assertSignedCall(tx, {
    from: sellerAddress,
    to: ticketAddress,
    data: perTokenApprovalCalldata(marketplaceAddress, BigInt(payload.tokenId)),
  });

  const approval = await marketplaceService.readTicketApprovalState({
    ticketAddress,
    tokenId: payload.tokenId,
  });
  if (approval.owner.toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error('marketplace_not_ticket_owner');
  }
  if (!approval.isApproved) throw new Error('marketplace_approval_failed');
  return { approvalTxHash: txHash };
}

async function verifyListReceipt(payload, txHash, allowedModes) {
  assertListPayloadShape(payload);
  assertMode(payload, allowedModes);
  assertTxHash(txHash);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const ticketAddress = ethers.getAddress(payload.ticketAddress);
  const tokenId = BigInt(payload.tokenId);
  const askUsdc = BigInt(payload.askUsdcRaw);
  const sellerAddress = ethers.getAddress(payload.walletAddress);

  const { tx, receipt } = await readMinedTransaction(
    provider, txHash, 'marketplace_transaction_not_found', 'marketplace_transaction_failed',
  );
  assertSignedCall(tx, {
    from: sellerAddress,
    to: marketplaceAddress,
    data: listCalldata(ticketAddress, tokenId, askUsdc),
  });

  const listed = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Listed',
    predicate: (parsed) =>
      parsed.args.seller.toLowerCase() === sellerAddress.toLowerCase() &&
      parsed.args.ticket.toLowerCase() === ticketAddress.toLowerCase() &&
      parsed.args.tokenId === tokenId &&
      parsed.args.askUsdc === askUsdc,
  });
  if (!listed) throw new Error('marketplace_listed_event_missing');

  await refreshMarketplaceCaches(sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: payload.executionMode,
    marketplaceAddress,
    ticketAddress,
    tokenId: tokenId.toString(),
    seller: sellerAddress,
    askUsdcRaw: askUsdc.toString(),
    listingId: listed.args.listingId.toString(),
    listTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
  };
}

// =============================================================================
// Update price
// =============================================================================

function assertUpdatePricePayloadShape(payload) {
  if (
    !payload ||
    payload.action !== 'MARKETPLACE_UPDATE_PRICE' ||
    payload.chainId !== 5042002 ||
    !ethers.isAddress(payload.contract) ||
    !ethers.isAddress(payload.ticketAddress) ||
    !ethers.isAddress(payload.walletAddress) ||
    typeof payload.listingId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.listingId) ||
    typeof payload.tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.tokenId) ||
    typeof payload.newAskUsdcRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.newAskUsdcRaw) ||
    !EXECUTION_MODES.includes(payload.executionMode) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new Error('action_authorization_invalid');
  }
}

function assertUpdatePricePayloadFresh(payload) {
  if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error('action_authorization_expired');
}

async function reverifyOwnedActiveListing(payload, { requireApproved }) {
  const listingId = Number(payload.listingId);
  const { listing } = await marketplaceService.readMarketplaceListing(listingId);

  if (listing.onchainStatus !== 'ACTIVE') throw new Error('marketplace_listing_not_active');
  if (listing.seller.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_not_listing_seller');
  }
  if (!listing.currentOwner || listing.currentOwner.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_seller_no_longer_owner');
  }
  if (listing.state === 'EXPIRED') throw new Error('marketplace_trading_window_closed');
  if (requireApproved && !listing.isApproved) throw new Error('marketplace_token_not_approved');

  return listing;
}

async function buildUpdatePriceTransactionRequest(payload, allowedModes) {
  assertUpdatePricePayloadShape(payload);
  assertUpdatePricePayloadFresh(payload);
  assertMode(payload, allowedModes);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const listing = await reverifyOwnedActiveListing(payload, { requireApproved: true });
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const listingId = BigInt(payload.listingId);
  const newAskUsdc = BigInt(payload.newAskUsdcRaw);

  return transactionRequest(network, {
    from: ethers.getAddress(payload.walletAddress),
    to: marketplaceAddress,
    data: MARKETPLACE_INTERFACE.encodeFunctionData('updatePrice', [listingId, newAskUsdc]),
  });
}

async function verifyUpdatePriceReceipt(payload, txHash, allowedModes) {
  assertUpdatePricePayloadShape(payload);
  assertMode(payload, allowedModes);
  assertTxHash(txHash);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const sellerAddress = ethers.getAddress(payload.walletAddress);
  const listingId = BigInt(payload.listingId);
  const newAskUsdc = BigInt(payload.newAskUsdcRaw);

  const { tx, receipt } = await readMinedTransaction(
    provider, txHash, 'marketplace_transaction_not_found', 'marketplace_transaction_failed',
  );
  assertSignedCall(tx, {
    from: sellerAddress,
    to: marketplaceAddress,
    data: MARKETPLACE_INTERFACE.encodeFunctionData('updatePrice', [listingId, newAskUsdc]),
  });

  const updated = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'ListingPriceUpdated',
    predicate: (parsed) => parsed.args.listingId === listingId && parsed.args.askUsdc === newAskUsdc,
  });
  if (!updated) throw new Error('marketplace_price_updated_event_missing');

  await refreshMarketplaceCaches(sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: payload.executionMode,
    marketplaceAddress,
    listingId: listingId.toString(),
    ticketAddress: ethers.getAddress(payload.ticketAddress),
    tokenId: payload.tokenId,
    newAskUsdcRaw: newAskUsdc.toString(),
    updateTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
  };
}

// =============================================================================
// Cancel
// =============================================================================

function assertCancelPayloadShape(payload) {
  if (
    !payload ||
    payload.action !== 'MARKETPLACE_CANCEL' ||
    payload.chainId !== 5042002 ||
    !ethers.isAddress(payload.contract) ||
    !ethers.isAddress(payload.ticketAddress) ||
    !ethers.isAddress(payload.walletAddress) ||
    typeof payload.listingId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.listingId) ||
    typeof payload.tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.tokenId) ||
    !EXECUTION_MODES.includes(payload.executionMode) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new Error('action_authorization_invalid');
  }
}

function assertCancelPayloadFresh(payload) {
  if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error('action_authorization_expired');
}

// Cancel never requires or checks per-token approval, matching the
// contract exactly: a listing can be withdrawn any time its round is still
// tradable, whether or not the marketplace still holds an active approval.
async function reverifyCancellableListing(payload) {
  const listingId = Number(payload.listingId);
  const { listing } = await marketplaceService.readMarketplaceListing(listingId);

  if (listing.onchainStatus !== 'ACTIVE') throw new Error('marketplace_listing_not_active');
  if (listing.seller.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_not_listing_seller');
  }

  return listing;
}

async function buildCancelTransactionRequest(payload, allowedModes) {
  assertCancelPayloadShape(payload);
  assertCancelPayloadFresh(payload);
  assertMode(payload, allowedModes);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const listing = await reverifyCancellableListing(payload);
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const listingId = BigInt(payload.listingId);
  return transactionRequest(network, {
    from: ethers.getAddress(payload.walletAddress),
    to: marketplaceAddress,
    data: MARKETPLACE_INTERFACE.encodeFunctionData('cancel', [listingId]),
  });
}

async function verifyCancelReceipt(payload, txHash, allowedModes) {
  assertCancelPayloadShape(payload);
  assertMode(payload, allowedModes);
  assertTxHash(txHash);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const sellerAddress = ethers.getAddress(payload.walletAddress);
  const listingId = BigInt(payload.listingId);

  const { tx, receipt } = await readMinedTransaction(
    provider, txHash, 'marketplace_transaction_not_found', 'marketplace_transaction_failed',
  );
  assertSignedCall(tx, {
    from: sellerAddress,
    to: marketplaceAddress,
    data: MARKETPLACE_INTERFACE.encodeFunctionData('cancel', [listingId]),
  });

  const cancelled = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Cancelled',
    predicate: (parsed) => parsed.args.listingId === listingId,
  });
  if (!cancelled) throw new Error('marketplace_cancelled_event_missing');

  await refreshMarketplaceCaches(sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: payload.executionMode,
    marketplaceAddress,
    listingId: listingId.toString(),
    ticketAddress: ethers.getAddress(payload.ticketAddress),
    tokenId: payload.tokenId,
    cancelTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
  };
}

// =============================================================================
// Buy
// =============================================================================

function assertBuyPayloadShape(payload) {
  if (
    !payload ||
    payload.action !== 'MARKETPLACE_BUY' ||
    payload.chainId !== 5042002 ||
    !ethers.isAddress(payload.contract) ||
    !ethers.isAddress(payload.ticketAddress) ||
    !ethers.isAddress(payload.walletAddress) ||
    !ethers.isAddress(payload.sellerAddress) ||
    typeof payload.listingId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.listingId) ||
    typeof payload.tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.tokenId) ||
    typeof payload.expectedAskUsdcRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.expectedAskUsdcRaw) ||
    !EXECUTION_MODES.includes(payload.executionMode) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new Error('action_authorization_invalid');
  }
}

function assertBuyPayloadFresh(payload) {
  if (Date.parse(payload.expiresAt) <= Date.now()) throw new Error('action_authorization_expired');
}

// The proactive price check here is the primary, reliable guarantee: it
// runs on a fresh read immediately before acting, so a stale ask is caught
// and reported as marketplace_price_changed before any transaction is even
// built. The contract's own PriceChanged revert remains the final backstop
// for the unavoidable, tiny window between this check and the transaction
// landing. Nothing here ever retries on a price change.
async function reverifyBuyableListing(payload) {
  const listingId = Number(payload.listingId);
  const { listing } = await marketplaceService.readMarketplaceListing(listingId);

  if (listing.onchainStatus !== 'ACTIVE') throw new Error('marketplace_listing_not_active');
  if (listing.seller.toLowerCase() === payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_buyer_is_seller');
  }
  if (listing.askUsdcRaw !== payload.expectedAskUsdcRaw) throw new Error('marketplace_price_changed');
  if (listing.seller.toLowerCase() !== payload.sellerAddress.toLowerCase()) {
    throw new Error('marketplace_listing_not_buyable');
  }
  if (!listing.isBuyable) {
    throw new Error(
      listing.state === 'EXPIRED' ? 'marketplace_trading_window_closed' : 'marketplace_listing_not_buyable',
    );
  }

  return listing;
}

function buyCalldata(listingId, expectedAskUsdc) {
  return MARKETPLACE_INTERFACE.encodeFunctionData('buy', [listingId, expectedAskUsdc]);
}

function exactAskApprovalCalldata(marketplaceAddress, expectedAskUsdc) {
  return USDC_INTERFACE.encodeFunctionData('approve', [marketplaceAddress, expectedAskUsdc]);
}

async function assertBuyerFunds(provider, buyerAddress, expectedAskUsdc) {
  const usdc = new ethers.Contract(arcService.ARC_TESTNET_USDC_ADDRESS, USDC_ABI, provider);
  const [usdcBalance, nativeBalance] = await Promise.all([
    usdc.balanceOf(buyerAddress),
    provider.getBalance(buyerAddress),
  ]);
  if (usdcBalance < expectedAskUsdc) throw new Error('marketplace_insufficient_usdc');
  if (nativeBalance === 0n) throw new Error('marketplace_insufficient_gas');
}

async function buildBuyTransactionRequest(payload, allowedModes) {
  assertBuyPayloadShape(payload);
  assertBuyPayloadFresh(payload);
  assertMode(payload, allowedModes);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const buyerAddress = ethers.getAddress(payload.walletAddress);

  const listing = await reverifyBuyableListing(payload);
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const expectedAskUsdc = BigInt(payload.expectedAskUsdcRaw);
  const allowance = await marketplaceService.readUsdcAllowance({ owner: buyerAddress });
  if (BigInt(allowance.allowanceRaw) < expectedAskUsdc) {
    // The exact USDC approval must already be verified onchain: as its own
    // connected wallet transaction, or as the Circle approval phase.
    throw new Error('marketplace_usdc_allowance_insufficient');
  }

  return {
    provider,
    request: transactionRequest(network, {
      from: buyerAddress,
      to: marketplaceAddress,
      data: buyCalldata(BigInt(payload.listingId), expectedAskUsdc),
    }),
  };
}

// Circle phase 1. Fresh listing read first (active, buyable, exact ask, buyer
// is not seller), then funds, then the allowance decision. A sufficient
// existing allowance skips straight to the purchase.
async function prepareCircleBuyApproval(payload) {
  assertBuyPayloadShape(payload);
  assertBuyPayloadFresh(payload);
  assertMode(payload, CIRCLE_MODES);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const buyerAddress = ethers.getAddress(payload.walletAddress);

  const listing = await reverifyBuyableListing(payload);
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const expectedAskUsdc = BigInt(payload.expectedAskUsdcRaw);
  await assertBuyerFunds(provider, buyerAddress, expectedAskUsdc);

  const allowance = await marketplaceService.readUsdcAllowance({ owner: buyerAddress });
  if (BigInt(allowance.allowanceRaw) >= expectedAskUsdc) {
    return { required: false, transactionRequest: null };
  }
  return {
    required: true,
    transactionRequest: transactionRequest(network, {
      from: buyerAddress,
      to: ethers.getAddress(arcService.ARC_TESTNET_USDC_ADDRESS),
      data: exactAskApprovalCalldata(marketplaceAddress, expectedAskUsdc),
    }),
  };
}

async function verifyCircleBuyApprovalReceipt(payload, txHash) {
  assertBuyPayloadShape(payload);
  assertMode(payload, CIRCLE_MODES);
  assertTxHash(txHash);

  const { provider } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const buyerAddress = ethers.getAddress(payload.walletAddress);
  const expectedAskUsdc = BigInt(payload.expectedAskUsdcRaw);

  const { tx } = await readMinedTransaction(
    provider, txHash, 'marketplace_approval_transaction_not_found', 'marketplace_approval_failed',
  );
  assertSignedCall(tx, {
    from: buyerAddress,
    to: ethers.getAddress(arcService.ARC_TESTNET_USDC_ADDRESS),
    data: exactAskApprovalCalldata(marketplaceAddress, expectedAskUsdc),
  });

  const allowance = await marketplaceService.readUsdcAllowance({ owner: buyerAddress });
  if (BigInt(allowance.allowanceRaw) < expectedAskUsdc) throw new Error('marketplace_approval_failed');
  return { approvalTxHash: txHash };
}

async function verifyBuyReceipt(payload, txHash, allowedModes) {
  assertBuyPayloadShape(payload);
  assertMode(payload, allowedModes);
  assertTxHash(txHash);

  const { provider, network } = await requireArcProvider();
  const marketplaceAddress = requireMarketplaceContract(payload);
  const buyerAddress = ethers.getAddress(payload.walletAddress);
  const sellerAddress = ethers.getAddress(payload.sellerAddress);
  const ticketAddress = ethers.getAddress(payload.ticketAddress);
  const tokenId = BigInt(payload.tokenId);
  const listingId = BigInt(payload.listingId);
  const expectedAskUsdc = BigInt(payload.expectedAskUsdcRaw);

  const { tx, receipt } = await readMinedTransaction(
    provider, txHash, 'marketplace_transaction_not_found', 'marketplace_transaction_failed',
  );
  assertSignedCall(tx, {
    from: buyerAddress,
    to: marketplaceAddress,
    data: buyCalldata(listingId, expectedAskUsdc),
  });

  const sold = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Sold',
    predicate: (parsed) =>
      parsed.args.listingId === listingId &&
      parsed.args.seller.toLowerCase() === sellerAddress.toLowerCase() &&
      parsed.args.buyer.toLowerCase() === buyerAddress.toLowerCase() &&
      parsed.args.ticket.toLowerCase() === ticketAddress.toLowerCase() &&
      parsed.args.tokenId === tokenId &&
      parsed.args.askUsdc === expectedAskUsdc,
  });
  if (!sold) throw new Error('marketplace_sold_event_missing');

  // Settlement, receipt scoped: the exact ask moved from buyer to seller in
  // USDC, and the ticket moved from seller to buyer, in this same transaction.
  const usdcSettled = findLogEvent(receipt, USDC_INTERFACE, {
    address: arcService.ARC_TESTNET_USDC_ADDRESS,
    name: 'Transfer',
    predicate: (parsed) =>
      parsed.args.from.toLowerCase() === buyerAddress.toLowerCase() &&
      parsed.args.to.toLowerCase() === sellerAddress.toLowerCase() &&
      parsed.args.value === expectedAskUsdc,
  });
  if (!usdcSettled) throw new Error('marketplace_usdc_settlement_missing');

  const ticketMoved = findLogEvent(receipt, ERC721_TRANSFER_INTERFACE, {
    address: ticketAddress,
    name: 'Transfer',
    predicate: (parsed) =>
      parsed.args.from.toLowerCase() === sellerAddress.toLowerCase() &&
      parsed.args.to.toLowerCase() === buyerAddress.toLowerCase() &&
      parsed.args.tokenId === tokenId,
  });
  if (!ticketMoved) throw new Error('marketplace_ticket_transfer_missing');

  await refreshMarketplaceCaches(buyerAddress, sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: payload.executionMode,
    marketplaceAddress,
    listingId: listingId.toString(),
    ticketAddress,
    tokenId: payload.tokenId,
    seller: sellerAddress,
    buyer: buyerAddress,
    askUsdcRaw: expectedAskUsdc.toString(),
    buyTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
  };
}

// =============================================================================
// Mode bound entry points
// =============================================================================

async function buildExternalListTransactionRequest(payload) {
  return buildListTransactionRequest(payload, EXTERNAL_MODES);
}
async function verifyExternalListReceipt(payload, txHash) {
  return verifyListReceipt(payload, txHash, EXTERNAL_MODES);
}
async function buildCircleListTransactionRequest(payload) {
  return buildListTransactionRequest(payload, CIRCLE_MODES);
}
async function verifyCircleListReceipt(payload, txHash) {
  return verifyListReceipt(payload, txHash, CIRCLE_MODES);
}

async function buildExternalUpdatePriceTransactionRequest(payload) {
  return buildUpdatePriceTransactionRequest(payload, EXTERNAL_MODES);
}
async function verifyExternalUpdatePriceReceipt(payload, txHash) {
  return verifyUpdatePriceReceipt(payload, txHash, EXTERNAL_MODES);
}
async function buildCircleUpdatePriceTransactionRequest(payload) {
  return buildUpdatePriceTransactionRequest(payload, CIRCLE_MODES);
}
async function verifyCircleUpdatePriceReceipt(payload, txHash) {
  return verifyUpdatePriceReceipt(payload, txHash, CIRCLE_MODES);
}

async function buildExternalCancelTransactionRequest(payload) {
  return buildCancelTransactionRequest(payload, EXTERNAL_MODES);
}
async function verifyExternalCancelReceipt(payload, txHash) {
  return verifyCancelReceipt(payload, txHash, EXTERNAL_MODES);
}
async function buildCircleCancelTransactionRequest(payload) {
  return buildCancelTransactionRequest(payload, CIRCLE_MODES);
}
async function verifyCircleCancelReceipt(payload, txHash) {
  return verifyCancelReceipt(payload, txHash, CIRCLE_MODES);
}

async function buildExternalBuyTransactionRequest(payload) {
  const { request } = await buildBuyTransactionRequest(payload, EXTERNAL_MODES);
  return request;
}
async function verifyExternalBuyReceipt(payload, txHash) {
  return verifyBuyReceipt(payload, txHash, EXTERNAL_MODES);
}
async function buildCircleBuyTransactionRequest(payload) {
  // After the approval phase the listing and funds are read fresh again, so a
  // purchase is never built from stale price, ownership, or balance data.
  const { provider, request } = await buildBuyTransactionRequest(payload, CIRCLE_MODES);
  await assertBuyerFunds(provider, request.from, BigInt(payload.expectedAskUsdcRaw));
  return request;
}
async function verifyCircleBuyReceipt(payload, txHash) {
  return verifyBuyReceipt(payload, txHash, CIRCLE_MODES);
}

module.exports = {
  resolveRoundForTicket,
  requireTradable,
  callMarketplace,
  buildExternalListTransactionRequest,
  verifyExternalListReceipt,
  prepareCircleListApproval,
  verifyCircleListApprovalReceipt,
  buildCircleListTransactionRequest,
  verifyCircleListReceipt,
  buildExternalUpdatePriceTransactionRequest,
  verifyExternalUpdatePriceReceipt,
  buildCircleUpdatePriceTransactionRequest,
  verifyCircleUpdatePriceReceipt,
  buildExternalCancelTransactionRequest,
  verifyExternalCancelReceipt,
  buildCircleCancelTransactionRequest,
  verifyCircleCancelReceipt,
  buildExternalBuyTransactionRequest,
  verifyExternalBuyReceipt,
  prepareCircleBuyApproval,
  verifyCircleBuyApprovalReceipt,
  buildCircleBuyTransactionRequest,
  verifyCircleBuyReceipt,
};
