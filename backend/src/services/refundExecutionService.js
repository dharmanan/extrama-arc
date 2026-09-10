'use strict';

const { ethers } = require('ethers');
const arcService = require('./arcService');

const REFUND_ABI = [
  'function refund(uint256 tokenId)',
  'function refunded(uint256 tokenId) view returns (bool)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'event RefundClaimed(uint256 indexed roundId, uint256 indexed ticketId, address indexed owner, uint256 amount)',
];

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const REFUND_INTERFACE = new ethers.Interface(REFUND_ABI);
const USDC_INTERFACE = new ethers.Interface(USDC_ABI);
// Human execution modes only: the current NFT owner's own wallet (connected,
// or Circle user controlled) signs refund(tokenId). EXTREMA never signs it.
const EXTERNAL_MODES = ['EXTERNAL_OWNER'];
const CIRCLE_MODES = ['CIRCLE_USER_WALLET'];
const EXECUTION_MODES = [...EXTERNAL_MODES, ...CIRCLE_MODES];
const REFUND_AMOUNT_RAW = 1_000_000n;

// Structural/identity validation only — no freshness check. This alone is
// safe to run against a payload that was legitimately authorized and
// consumed in the past (e.g. verifyExternalRefundReceipt, which runs after
// the on-chain transaction has already been mined and may be called well
// outside the original 2-minute authorization window).
function assertRefundPayloadShape(payload) {
  if (
    !payload ||
    payload.action !== 'REFUND_TICKET' ||
    payload.chainId !== 5042002 ||
    !ethers.isAddress(payload.poolAddress) ||
    !ethers.isAddress(payload.ticketAddress) ||
    !ethers.isAddress(payload.currentOwner) ||
    !ethers.isAddress(payload.walletAddress) ||
    !ethers.isAddress(payload.destination) ||
    payload.destination.toLowerCase() !== payload.currentOwner.toLowerCase() ||
    typeof payload.tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.tokenId) ||
    !Number.isInteger(payload.roundId) ||
    payload.roundId <= 0 ||
    payload.amountRaw !== '1000000' ||
    !EXECUTION_MODES.includes(payload.executionMode) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new Error('action_authorization_invalid');
  }
}

// Freshness validation — must hold while an authorization is being turned
// into an action (backend signing, or handing back an external tx request).
// Must NOT be applied when later verifying the on-chain result of an
// already-consumed authorization: the authorization's job was done the
// moment /refund/finish produced a signed tx or a tx request, and the
// subsequent on-chain confirmation can legitimately take longer than the
// original 2-minute window.
function assertRefundPayloadFresh(payload) {
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error('action_authorization_expired');
  }
}

async function reverifyRefundState(payload) {
  const state = await arcService.readRefundAuthorizationState({
    poolAddress: payload.poolAddress,
    ticketAddress: payload.ticketAddress,
    tokenId: payload.tokenId,
    roundId: payload.roundId,
  });

  if (state.roundStatus !== 'CANCELLED') {
    throw new Error('refund_round_not_cancelled');
  }
  if (state.isRefunded) {
    throw new Error('refund_already_refunded');
  }
  if (state.currentOwner.toLowerCase() !== payload.currentOwner.toLowerCase()) {
    throw new Error('refund_owner_mismatch');
  }
  if (state.amountRaw !== payload.amountRaw) {
    throw new Error('refund_amount_mismatch');
  }

  return state;
}

function requireSuccessfulReceipt(receipt) {
  if (!receipt || receipt.status !== 1) {
    throw new Error('refund_transaction_failed');
  }
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

function findRefundTransferEvent(receipt, { usdcAddress, from, to }) {
  return findLogEvent(receipt, USDC_INTERFACE, {
    address: usdcAddress,
    name: 'Transfer',
    predicate: (parsed) =>
      parsed.args.from.toLowerCase() === from.toLowerCase() &&
      parsed.args.to.toLowerCase() === to.toLowerCase() &&
      parsed.args.value === REFUND_AMOUNT_RAW,
  });
}

function findRefundClaimedEvent(receipt, { poolAddress, roundId, tokenId, owner }) {
  return findLogEvent(receipt, REFUND_INTERFACE, {
    address: poolAddress,
    name: 'RefundClaimed',
    predicate: (parsed) =>
      Number(parsed.args.roundId) === roundId &&
      parsed.args.ticketId === tokenId &&
      parsed.args.owner.toLowerCase() === owner.toLowerCase() &&
      parsed.args.amount === REFUND_AMOUNT_RAW,
  });
}

async function readPoolAccounting(poolAddress, usdcAddress, roundId, provider, overrides = {}) {
  const pool = new ethers.Contract(poolAddress, REFUND_ABI, provider);
  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, provider);
  const [round, poolUsdcBalance] = await Promise.all([
    pool.getRound(roundId, overrides),
    usdc.balanceOf(poolAddress, overrides),
  ]);

  return {
    escrowRemaining: round.escrowRemaining,
    poolUsdcBalance,
  };
}

// Best effort diagnostic evidence ONLY, never a hard gate. On every
// user signed path (connected wallet or Circle) the backend does not control when the wallet actually
// sends the transaction, so there is no reliable server-captured "before"
// snapshot to diff against. Reading the pool's accounting at
// receipt.blockNumber - 1 vs receipt.blockNumber is BLOCK-scoped, not
// transaction-scoped: if another transaction touching this same pool/round
// (e.g. a different ticket's refund) lands in the same block, the observed
// delta will not isolate this transaction's effect. It is reported purely
// as supplementary evidence — the sender/target/calldata/value/receipt/
// event/refunded-flag checks are the actual hard guarantees for this path.
// Some RPC endpoints (especially non-archive nodes) also cannot serve
// historical state at an arbitrary past block at all, so this must degrade
// to "unavailable" rather than fabricate a delta when that read fails.
async function tryReadPoolAccountingDelta(poolAddress, usdcAddress, roundId, provider, receipt) {
  try {
    const beforeTag = receipt.blockNumber - 1;
    const afterTag = receipt.blockNumber;
    const [before, after] = await Promise.all([
      readPoolAccounting(poolAddress, usdcAddress, roundId, provider, { blockTag: beforeTag }),
      readPoolAccounting(poolAddress, usdcAddress, roundId, provider, { blockTag: afterTag }),
    ]);

    return {
      available: true,
      poolUsdcBefore: before.poolUsdcBalance.toString(),
      poolUsdcAfter: after.poolUsdcBalance.toString(),
      escrowRemainingBefore: before.escrowRemaining.toString(),
      escrowRemainingAfter: after.escrowRemaining.toString(),
      poolUsdcDeltaExact: before.poolUsdcBalance - after.poolUsdcBalance === REFUND_AMOUNT_RAW,
      escrowDeltaExact: before.escrowRemaining - after.escrowRemaining === REFUND_AMOUNT_RAW,
    };
  } catch (error) {
    return {
      available: false,
      reason: 'historical_block_state_unavailable',
      detail: error?.shortMessage || error?.message || String(error),
    };
  }
}

function assertRefundMode(payload, allowedModes) {
  if (!allowedModes.includes(payload.executionMode)) {
    throw new Error('refund_execution_mode_mismatch');
  }
}

async function buildRefundTransactionRequest(payload, allowedModes) {
  assertRefundPayloadShape(payload);
  assertRefundPayloadFresh(payload);
  assertRefundMode(payload, allowedModes);

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  await reverifyRefundState(payload);

  const poolAddress = ethers.getAddress(payload.poolAddress);
  const tokenId = BigInt(payload.tokenId);
  const data = REFUND_INTERFACE.encodeFunctionData('refund', [tokenId]);

  return {
    chainId: Number(network.chainId),
    to: poolAddress,
    data,
    value: '0x0',
    from: ethers.getAddress(payload.currentOwner),
  };
}

async function verifyRefundReceipt(payload, txHash, allowedModes) {
  // Freshness is intentionally NOT checked here: the authorization was
  // already turned into exactly one transaction request (connected wallet
  // /refund/finish, or one bound Circle challenge) inside its window. This
  // step only verifies the resulting onchain transaction, which can
  // legitimately be confirmed well after the original expiresAt.
  assertRefundPayloadShape(payload);
  assertRefundMode(payload, allowedModes);
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('refund_txhash_invalid');
  }

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const poolAddress = ethers.getAddress(payload.poolAddress);
  const currentOwner = ethers.getAddress(payload.currentOwner);
  const tokenId = BigInt(payload.tokenId);

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);

  if (!tx || !receipt) {
    throw new Error('refund_transaction_not_found');
  }
  requireSuccessfulReceipt(receipt);

  if (ethers.getAddress(tx.from).toLowerCase() !== currentOwner.toLowerCase()) {
    throw new Error('refund_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== poolAddress.toLowerCase()) {
    throw new Error('refund_target_mismatch');
  }
  if (tx.value !== 0n) {
    throw new Error('refund_value_mismatch');
  }

  const expectedData = REFUND_INTERFACE.encodeFunctionData('refund', [tokenId]);
  if (String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error('refund_calldata_mismatch');
  }

  const state = await arcService.readRefundAuthorizationState({
    poolAddress: payload.poolAddress,
    ticketAddress: payload.ticketAddress,
    tokenId: payload.tokenId,
    roundId: payload.roundId,
  });

  if (!state.isRefunded) {
    throw new Error('refund_postcondition_failed');
  }

  const transferEvent = findRefundTransferEvent(receipt, {
    usdcAddress: state.usdcAddress,
    from: poolAddress,
    to: currentOwner,
  });
  if (!transferEvent) {
    throw new Error('refund_transfer_event_missing');
  }

  const refundClaimedEvent = findRefundClaimedEvent(receipt, {
    poolAddress,
    roundId: payload.roundId,
    tokenId,
    owner: currentOwner,
  });
  if (!refundClaimedEvent) {
    throw new Error('refund_claimed_event_missing');
  }

  // Block-scoped best-effort accounting evidence ONLY — never a hard gate.
  // Another transaction touching this pool/round in the same block could
  // change this delta without this refund being wrong, so it is reported
  // as supplementary diagnostic evidence, not asserted. The checks above
  // (sender, target, calldata, value, receipt, Transfer event, RefundClaimed
  // event, refunded flag) are the actual hard guarantees for this path.
  const accounting = await tryReadPoolAccountingDelta(
    poolAddress,
    state.usdcAddress,
    payload.roundId,
    provider,
    receipt,
  );

  arcService.invalidateArcWalletStateCache(currentOwner);

  return {
    chainId: Number(network.chainId),
    executionMode: payload.executionMode,
    poolAddress,
    ticketAddress: ethers.getAddress(payload.ticketAddress),
    tokenId: tokenId.toString(),
    roundId: payload.roundId,
    currentOwner,
    amountRaw: REFUND_AMOUNT_RAW.toString(),
    refundTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
    accounting,
  };
}

async function buildExternalRefundTransactionRequest(payload) {
  return buildRefundTransactionRequest(payload, EXTERNAL_MODES);
}

async function verifyExternalRefundReceipt(payload, txHash) {
  return verifyRefundReceipt(payload, txHash, EXTERNAL_MODES);
}

async function buildCircleRefundTransactionRequest(payload) {
  return buildRefundTransactionRequest(payload, CIRCLE_MODES);
}

async function verifyCircleRefundReceipt(payload, txHash) {
  return verifyRefundReceipt(payload, txHash, CIRCLE_MODES);
}

module.exports = {
  buildExternalRefundTransactionRequest,
  verifyExternalRefundReceipt,
  buildCircleRefundTransactionRequest,
  verifyCircleRefundReceipt,
};
