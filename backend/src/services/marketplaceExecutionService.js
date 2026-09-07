'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const arcService = require('./arcService');
const marketplaceService = require('./marketplaceService');
const walletService = require('./walletService');

const EXECUTION_MODES = ['BACKEND_WALLET', 'EXTERNAL_OWNER'];

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

function refreshMarketplaceCaches(...addresses) {
  addresses.forEach((address) => {
    if (address) arcService.invalidateArcWalletStateCache(address);
  });
  marketplaceService.refreshMarketplaceListingsCache().catch((error) => {
    console.error('[marketplace-cache] post-action refresh failed', error.message);
  });
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

async function executeBackendList(userId, payload) {
  assertListPayloadShape(payload);
  assertListPayloadFresh(payload);
  if (payload.executionMode !== 'BACKEND_WALLET') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);

  const signer = await walletService.getSignerForUser(userId, provider);
  const signerAddress = ethers.getAddress(signer.address);
  if (signerAddress.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_wallet_mismatch');
  }

  const ticketAddress = ethers.getAddress(payload.ticketAddress);
  const tokenId = BigInt(payload.tokenId);
  const askUsdc = BigInt(payload.askUsdcRaw);

  const { round } = await resolveRoundForTicket(ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const ticket = new ethers.Contract(ticketAddress, TICKET_ABI, signer);

  let owner;
  try {
    owner = ethers.getAddress(await ticket.ownerOf(tokenId));
  } catch {
    throw new Error('marketplace_ticket_not_found');
  }
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error('marketplace_not_ticket_owner');
  }

  const nativeBalance = await provider.getBalance(signerAddress);
  if (nativeBalance === 0n) throw new Error('marketplace_insufficient_gas');

  // Step 1, bundled: this wallet is server-controlled, so the per-token
  // approve and the list call happen as one authorized action rather than
  // two separate user-facing steps.
  let approvalTxHash = null;
  const approvedAddress = await ticket.getApproved(tokenId).catch(() => null);
  if (!approvedAddress || approvedAddress.toLowerCase() !== marketplaceAddress.toLowerCase()) {
    const approvalTx = await ticket.approve(marketplaceAddress, tokenId);
    approvalTxHash = approvalTx.hash;
    const approvalReceipt = await approvalTx.wait();
    requireSuccessfulReceipt(approvalReceipt, 'marketplace_approval_failed');
  }

  // Step 2.
  const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, signer);
  const listTx = await callMarketplace(() => marketplace.list(ticketAddress, tokenId, askUsdc));
  const receipt = await listTx.wait();
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  const listed = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Listed',
    predicate: (parsed) =>
      parsed.args.seller.toLowerCase() === signerAddress.toLowerCase() &&
      parsed.args.ticket.toLowerCase() === ticketAddress.toLowerCase() &&
      parsed.args.tokenId === tokenId &&
      parsed.args.askUsdc === askUsdc,
  });
  if (!listed) throw new Error('marketplace_listed_event_missing');

  refreshMarketplaceCaches(signerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'BACKEND_WALLET',
    marketplaceAddress,
    ticketAddress,
    tokenId: tokenId.toString(),
    seller: signerAddress,
    askUsdcRaw: askUsdc.toString(),
    listingId: listed.args.listingId.toString(),
    approvalTxHash,
    listTxHash: listTx.hash,
    explorerUrl: `https://testnet.arcscan.app/tx/${listTx.hash}`,
  };
}

async function buildExternalListTransactionRequest(payload) {
  assertListPayloadShape(payload);
  assertListPayloadFresh(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const ticketAddress = ethers.getAddress(payload.ticketAddress);
  const tokenId = BigInt(payload.tokenId);
  const askUsdc = BigInt(payload.askUsdcRaw);
  const sellerAddress = ethers.getAddress(payload.walletAddress);

  const { round } = await resolveRoundForTicket(ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const approval = await marketplaceService.readTicketApprovalState({
    ticketAddress,
    tokenId: payload.tokenId,
  });
  if (approval.owner.toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error('marketplace_not_ticket_owner');
  }
  // Step 1 already happened as its own wallet-signed transaction before this
  // request was made; this only re-confirms it actually landed.
  if (!approval.isApproved) throw new Error('marketplace_token_not_approved');

  const data = MARKETPLACE_INTERFACE.encodeFunctionData('list', [ticketAddress, tokenId, askUsdc]);

  return {
    chainId: Number(network.chainId),
    to: marketplaceAddress,
    data,
    value: '0x0',
    from: sellerAddress,
  };
}

async function verifyExternalListReceipt(payload, txHash) {
  assertListPayloadShape(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('marketplace_txhash_invalid');
  }

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const ticketAddress = ethers.getAddress(payload.ticketAddress);
  const tokenId = BigInt(payload.tokenId);
  const askUsdc = BigInt(payload.askUsdcRaw);
  const sellerAddress = ethers.getAddress(payload.walletAddress);

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error('marketplace_transaction_not_found');
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  if (ethers.getAddress(tx.from).toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error('marketplace_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== marketplaceAddress.toLowerCase()) {
    throw new Error('marketplace_target_mismatch');
  }

  const expectedData = MARKETPLACE_INTERFACE.encodeFunctionData('list', [ticketAddress, tokenId, askUsdc]);
  if (String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error('marketplace_calldata_mismatch');
  }

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

  refreshMarketplaceCaches(sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'EXTERNAL_OWNER',
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

async function executeBackendUpdatePrice(userId, payload) {
  assertUpdatePricePayloadShape(payload);
  assertUpdatePricePayloadFresh(payload);
  if (payload.executionMode !== 'BACKEND_WALLET') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);

  const signer = await walletService.getSignerForUser(userId, provider);
  const signerAddress = ethers.getAddress(signer.address);
  if (signerAddress.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_wallet_mismatch');
  }

  // Approval is not required to hold here -- it is required after this
  // read, and re-established automatically below for BACKEND_WALLET, same
  // as list().
  const listing = await reverifyOwnedActiveListing(payload, { requireApproved: false });

  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const listingId = BigInt(payload.listingId);
  const newAskUsdc = BigInt(payload.newAskUsdcRaw);
  const ticketAddress = ethers.getAddress(listing.ticketAddress);
  const tokenId = BigInt(payload.tokenId);

  let approvalTxHash = null;
  if (!listing.isApproved) {
    const ticket = new ethers.Contract(ticketAddress, TICKET_ABI, signer);
    const approvalTx = await ticket.approve(marketplaceAddress, tokenId);
    approvalTxHash = approvalTx.hash;
    const approvalReceipt = await approvalTx.wait();
    requireSuccessfulReceipt(approvalReceipt, 'marketplace_approval_failed');
  }

  const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, signer);
  const tx = await callMarketplace(() => marketplace.updatePrice(listingId, newAskUsdc));
  const receipt = await tx.wait();
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  const updated = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'ListingPriceUpdated',
    predicate: (parsed) => parsed.args.listingId === listingId && parsed.args.askUsdc === newAskUsdc,
  });
  if (!updated) throw new Error('marketplace_price_updated_event_missing');

  refreshMarketplaceCaches(signerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'BACKEND_WALLET',
    marketplaceAddress,
    listingId: listingId.toString(),
    ticketAddress,
    tokenId: tokenId.toString(),
    newAskUsdcRaw: newAskUsdc.toString(),
    approvalTxHash,
    updateTxHash: tx.hash,
    explorerUrl: `https://testnet.arcscan.app/tx/${tx.hash}`,
  };
}

async function buildExternalUpdatePriceTransactionRequest(payload) {
  assertUpdatePricePayloadShape(payload);
  assertUpdatePricePayloadFresh(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const listing = await reverifyOwnedActiveListing(payload, { requireApproved: true });
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const listingId = BigInt(payload.listingId);
  const newAskUsdc = BigInt(payload.newAskUsdcRaw);
  const data = MARKETPLACE_INTERFACE.encodeFunctionData('updatePrice', [listingId, newAskUsdc]);

  return {
    chainId: Number(network.chainId),
    to: marketplaceAddress,
    data,
    value: '0x0',
    from: ethers.getAddress(payload.walletAddress),
  };
}

async function verifyExternalUpdatePriceReceipt(payload, txHash) {
  assertUpdatePricePayloadShape(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('marketplace_txhash_invalid');
  }

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const sellerAddress = ethers.getAddress(payload.walletAddress);
  const listingId = BigInt(payload.listingId);
  const newAskUsdc = BigInt(payload.newAskUsdcRaw);

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error('marketplace_transaction_not_found');
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  if (ethers.getAddress(tx.from).toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error('marketplace_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== marketplaceAddress.toLowerCase()) {
    throw new Error('marketplace_target_mismatch');
  }

  const expectedData = MARKETPLACE_INTERFACE.encodeFunctionData('updatePrice', [listingId, newAskUsdc]);
  if (String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error('marketplace_calldata_mismatch');
  }

  const updated = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'ListingPriceUpdated',
    predicate: (parsed) => parsed.args.listingId === listingId && parsed.args.askUsdc === newAskUsdc,
  });
  if (!updated) throw new Error('marketplace_price_updated_event_missing');

  refreshMarketplaceCaches(sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'EXTERNAL_OWNER',
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

async function executeBackendCancel(userId, payload) {
  assertCancelPayloadShape(payload);
  assertCancelPayloadFresh(payload);
  if (payload.executionMode !== 'BACKEND_WALLET') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);

  const signer = await walletService.getSignerForUser(userId, provider);
  const signerAddress = ethers.getAddress(signer.address);
  if (signerAddress.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_wallet_mismatch');
  }

  const listing = await reverifyCancellableListing(payload);
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const listingId = BigInt(payload.listingId);
  const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, signer);
  const tx = await callMarketplace(() => marketplace.cancel(listingId));
  const receipt = await tx.wait();
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  const cancelled = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Cancelled',
    predicate: (parsed) => parsed.args.listingId === listingId,
  });
  if (!cancelled) throw new Error('marketplace_cancelled_event_missing');

  refreshMarketplaceCaches(signerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'BACKEND_WALLET',
    marketplaceAddress,
    listingId: listingId.toString(),
    ticketAddress: ethers.getAddress(listing.ticketAddress),
    tokenId: payload.tokenId,
    cancelTxHash: tx.hash,
    explorerUrl: `https://testnet.arcscan.app/tx/${tx.hash}`,
  };
}

async function buildExternalCancelTransactionRequest(payload) {
  assertCancelPayloadShape(payload);
  assertCancelPayloadFresh(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const listing = await reverifyCancellableListing(payload);
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const listingId = BigInt(payload.listingId);
  const data = MARKETPLACE_INTERFACE.encodeFunctionData('cancel', [listingId]);

  return {
    chainId: Number(network.chainId),
    to: marketplaceAddress,
    data,
    value: '0x0',
    from: ethers.getAddress(payload.walletAddress),
  };
}

async function verifyExternalCancelReceipt(payload, txHash) {
  assertCancelPayloadShape(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('marketplace_txhash_invalid');
  }

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const sellerAddress = ethers.getAddress(payload.walletAddress);
  const listingId = BigInt(payload.listingId);

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error('marketplace_transaction_not_found');
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  if (ethers.getAddress(tx.from).toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error('marketplace_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== marketplaceAddress.toLowerCase()) {
    throw new Error('marketplace_target_mismatch');
  }

  const expectedData = MARKETPLACE_INTERFACE.encodeFunctionData('cancel', [listingId]);
  if (String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error('marketplace_calldata_mismatch');
  }

  const cancelled = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Cancelled',
    predicate: (parsed) => parsed.args.listingId === listingId,
  });
  if (!cancelled) throw new Error('marketplace_cancelled_event_missing');

  refreshMarketplaceCaches(sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'EXTERNAL_OWNER',
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
// attempted. The contract's own PriceChanged revert (surfaced through
// callMarketplace's error mapping) remains the final backstop for the
// unavoidable, tiny window between this check and the transaction landing.
async function reverifyBuyableListing(payload) {
  const listingId = Number(payload.listingId);
  const { listing } = await marketplaceService.readMarketplaceListing(listingId);

  if (listing.onchainStatus !== 'ACTIVE') throw new Error('marketplace_listing_not_active');
  if (listing.seller.toLowerCase() === payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_buyer_is_seller');
  }
  if (listing.askUsdcRaw !== payload.expectedAskUsdcRaw) throw new Error('marketplace_price_changed');
  if (!listing.isBuyable) {
    throw new Error(
      listing.state === 'EXPIRED' ? 'marketplace_trading_window_closed' : 'marketplace_listing_not_buyable',
    );
  }

  return listing;
}

async function executeBackendBuy(userId, payload) {
  assertBuyPayloadShape(payload);
  assertBuyPayloadFresh(payload);
  if (payload.executionMode !== 'BACKEND_WALLET') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);

  const signer = await walletService.getSignerForUser(userId, provider);
  const buyerAddress = ethers.getAddress(signer.address);
  if (buyerAddress.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('marketplace_wallet_mismatch');
  }

  const listing = await reverifyBuyableListing(payload);
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const listingId = BigInt(payload.listingId);
  const expectedAskUsdc = BigInt(payload.expectedAskUsdcRaw);
  const sellerAddress = ethers.getAddress(listing.seller);
  const ticketAddress = ethers.getAddress(listing.ticketAddress);
  const tokenId = BigInt(payload.tokenId);

  const usdc = new ethers.Contract(arcService.ARC_TESTNET_USDC_ADDRESS, USDC_ABI, signer);

  const [buyerUsdcBalance, nativeBalance] = await Promise.all([
    usdc.balanceOf(buyerAddress),
    provider.getBalance(buyerAddress),
  ]);
  if (buyerUsdcBalance < expectedAskUsdc) throw new Error('marketplace_insufficient_usdc');
  if (nativeBalance === 0n) throw new Error('marketplace_insufficient_gas');

  let approvalTxHash = null;
  const allowance = await usdc.allowance(buyerAddress, marketplaceAddress);
  if (allowance < expectedAskUsdc) {
    const approvalTx = await usdc.approve(marketplaceAddress, expectedAskUsdc);
    approvalTxHash = approvalTx.hash;
    const approvalReceipt = await approvalTx.wait();
    requireSuccessfulReceipt(approvalReceipt, 'marketplace_approval_failed');
  }

  const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, signer);
  const tx = await callMarketplace(() => marketplace.buy(listingId, expectedAskUsdc));
  const receipt = await tx.wait();
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  const sold = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Sold',
    predicate: (parsed) =>
      parsed.args.listingId === listingId &&
      parsed.args.buyer.toLowerCase() === buyerAddress.toLowerCase() &&
      parsed.args.askUsdc === expectedAskUsdc,
  });
  if (!sold) throw new Error('marketplace_sold_event_missing');

  refreshMarketplaceCaches(buyerAddress, sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'BACKEND_WALLET',
    marketplaceAddress,
    listingId: listingId.toString(),
    ticketAddress,
    tokenId: tokenId.toString(),
    seller: sellerAddress,
    buyer: buyerAddress,
    askUsdcRaw: expectedAskUsdc.toString(),
    approvalTxHash,
    buyTxHash: tx.hash,
    explorerUrl: `https://testnet.arcscan.app/tx/${tx.hash}`,
  };
}

async function buildExternalBuyTransactionRequest(payload) {
  assertBuyPayloadShape(payload);
  assertBuyPayloadFresh(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const buyerAddress = ethers.getAddress(payload.walletAddress);

  const listing = await reverifyBuyableListing(payload);
  const { round } = await resolveRoundForTicket(listing.ticketAddress, payload.tokenId, provider);
  requireTradable(round);

  const expectedAskUsdc = BigInt(payload.expectedAskUsdcRaw);
  const allowance = await marketplaceService.readUsdcAllowance({ owner: buyerAddress });
  if (BigInt(allowance.allowanceRaw) < expectedAskUsdc) {
    // Step 1 (the exact USDC approve) must already have happened as its own
    // wallet-signed transaction before this request was made.
    throw new Error('marketplace_usdc_allowance_insufficient');
  }

  const listingId = BigInt(payload.listingId);
  const data = MARKETPLACE_INTERFACE.encodeFunctionData('buy', [listingId, expectedAskUsdc]);

  return {
    chainId: Number(network.chainId),
    to: marketplaceAddress,
    data,
    value: '0x0',
    from: buyerAddress,
  };
}

async function verifyExternalBuyReceipt(payload, txHash) {
  assertBuyPayloadShape(payload);
  if (payload.executionMode !== 'EXTERNAL_OWNER') throw new Error('marketplace_execution_mode_mismatch');
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('marketplace_txhash_invalid');
  }

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');

  const marketplaceAddress = requireMarketplaceContract(payload);
  const buyerAddress = ethers.getAddress(payload.walletAddress);
  const sellerAddress = ethers.getAddress(payload.sellerAddress);
  const listingId = BigInt(payload.listingId);
  const expectedAskUsdc = BigInt(payload.expectedAskUsdcRaw);

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error('marketplace_transaction_not_found');
  requireSuccessfulReceipt(receipt, 'marketplace_transaction_failed');

  if (ethers.getAddress(tx.from).toLowerCase() !== buyerAddress.toLowerCase()) {
    throw new Error('marketplace_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== marketplaceAddress.toLowerCase()) {
    throw new Error('marketplace_target_mismatch');
  }

  const expectedData = MARKETPLACE_INTERFACE.encodeFunctionData('buy', [listingId, expectedAskUsdc]);
  if (String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error('marketplace_calldata_mismatch');
  }

  const sold = findLogEvent(receipt, MARKETPLACE_INTERFACE, {
    address: marketplaceAddress,
    name: 'Sold',
    predicate: (parsed) =>
      parsed.args.listingId === listingId &&
      parsed.args.buyer.toLowerCase() === buyerAddress.toLowerCase() &&
      parsed.args.askUsdc === expectedAskUsdc,
  });
  if (!sold) throw new Error('marketplace_sold_event_missing');

  refreshMarketplaceCaches(buyerAddress, sellerAddress);

  return {
    chainId: Number(network.chainId),
    executionMode: 'EXTERNAL_OWNER',
    marketplaceAddress,
    listingId: listingId.toString(),
    ticketAddress: ethers.getAddress(payload.ticketAddress),
    tokenId: payload.tokenId,
    seller: sellerAddress,
    buyer: buyerAddress,
    askUsdcRaw: expectedAskUsdc.toString(),
    buyTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
  };
}

module.exports = {
  resolveRoundForTicket,
  requireTradable,
  executeBackendList,
  buildExternalListTransactionRequest,
  verifyExternalListReceipt,
  executeBackendUpdatePrice,
  buildExternalUpdatePriceTransactionRequest,
  verifyExternalUpdatePriceReceipt,
  executeBackendCancel,
  buildExternalCancelTransactionRequest,
  verifyExternalCancelReceipt,
  executeBackendBuy,
  buildExternalBuyTransactionRequest,
  verifyExternalBuyReceipt,
};
