'use strict';

const { ethers } = require('ethers');
const arcService = require('./arcService');

const CLAIM_ABI = [
  'function claim(uint256 tokenId)',
  'function claimed(uint256 tokenId) view returns (bool)',
  'function claimableByTicket(uint256 tokenId) view returns (uint256)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'event RewardClaimed(uint256 indexed roundId, uint256 indexed ticketId, address indexed owner, uint256 amount)',
];

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const CLAIM_INTERFACE = new ethers.Interface(CLAIM_ABI);
const USDC_INTERFACE = new ethers.Interface(USDC_ABI);
// Human execution modes only: the current winning NFT owner's own wallet
// (connected, or Circle user controlled) signs claim(tokenId).
const EXTERNAL_MODES = ['EXTERNAL_OWNER'];
const CIRCLE_MODES = ['CIRCLE_USER_WALLET'];
const EXECUTION_MODES = [...EXTERNAL_MODES, ...CIRCLE_MODES];

function assertClaimPayloadShape(payload) {
  if (
    !payload ||
    payload.action !== 'CLAIM_REWARD' ||
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
    typeof payload.amountRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.amountRaw) ||
    !EXECUTION_MODES.includes(payload.executionMode) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new Error('action_authorization_invalid');
  }
}

function assertClaimPayloadFresh(payload) {
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error('action_authorization_expired');
  }
}

async function reverifyClaimState(payload) {
  const state = await arcService.readClaimAuthorizationState({
    poolAddress: payload.poolAddress,
    ticketAddress: payload.ticketAddress,
    tokenId: payload.tokenId,
    roundId: payload.roundId,
  });

  if (state.roundStatus !== 'SETTLED') {
    throw new Error('claim_round_not_settled');
  }
  if (state.isClaimed) {
    throw new Error('claim_already_claimed');
  }
  if (state.currentOwner.toLowerCase() !== payload.currentOwner.toLowerCase()) {
    throw new Error('claim_owner_mismatch');
  }
  if (state.claimableRaw !== payload.amountRaw) {
    throw new Error('claim_amount_mismatch');
  }
  if (BigInt(state.claimableRaw) <= 0n) {
    throw new Error('claim_nothing_to_claim');
  }

  return state;
}

function requireSuccessfulReceipt(receipt) {
  if (!receipt || receipt.status !== 1) {
    throw new Error('claim_transaction_failed');
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

function findClaimTransferEvent(receipt, { usdcAddress, from, to, amount }) {
  return findLogEvent(receipt, USDC_INTERFACE, {
    address: usdcAddress,
    name: 'Transfer',
    predicate: (parsed) =>
      parsed.args.from.toLowerCase() === from.toLowerCase() &&
      parsed.args.to.toLowerCase() === to.toLowerCase() &&
      parsed.args.value === amount,
  });
}

function findRewardClaimedEvent(receipt, { poolAddress, roundId, tokenId, owner, amount }) {
  return findLogEvent(receipt, CLAIM_INTERFACE, {
    address: poolAddress,
    name: 'RewardClaimed',
    predicate: (parsed) =>
      Number(parsed.args.roundId) === roundId &&
      parsed.args.ticketId === tokenId &&
      parsed.args.owner.toLowerCase() === owner.toLowerCase() &&
      parsed.args.amount === amount,
  });
}

async function readPoolAccounting(poolAddress, usdcAddress, roundId, provider, overrides = {}) {
  const pool = new ethers.Contract(poolAddress, CLAIM_ABI, provider);
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

async function tryReadPoolAccountingDelta(
  poolAddress,
  usdcAddress,
  roundId,
  amount,
  provider,
  receipt,
) {
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
      poolUsdcDeltaExact: before.poolUsdcBalance - after.poolUsdcBalance === amount,
      escrowDeltaExact: before.escrowRemaining - after.escrowRemaining === amount,
    };
  } catch (error) {
    return {
      available: false,
      reason: 'historical_block_state_unavailable',
      detail: error?.shortMessage || error?.message || String(error),
    };
  }
}

function assertClaimMode(payload, allowedModes) {
  if (!allowedModes.includes(payload.executionMode)) {
    throw new Error('claim_execution_mode_mismatch');
  }
}

async function buildClaimTransactionRequest(payload, allowedModes) {
  assertClaimPayloadShape(payload);
  assertClaimPayloadFresh(payload);
  assertClaimMode(payload, allowedModes);

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  await reverifyClaimState(payload);

  const poolAddress = ethers.getAddress(payload.poolAddress);
  const tokenId = BigInt(payload.tokenId);
  const data = CLAIM_INTERFACE.encodeFunctionData('claim', [tokenId]);

  return {
    chainId: Number(network.chainId),
    to: poolAddress,
    data,
    value: '0x0',
    from: ethers.getAddress(payload.currentOwner),
  };
}

async function verifyClaimReceipt(payload, txHash, allowedModes) {
  // No freshness check: this verifies a transaction that was already built
  // from a fresh authorization, and may be mined after that window closed.
  assertClaimPayloadShape(payload);
  assertClaimMode(payload, allowedModes);
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('claim_txhash_invalid');
  }

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const poolAddress = ethers.getAddress(payload.poolAddress);
  const currentOwner = ethers.getAddress(payload.currentOwner);
  const tokenId = BigInt(payload.tokenId);
  const amount = BigInt(payload.amountRaw);

  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);

  if (!tx || !receipt) {
    throw new Error('claim_transaction_not_found');
  }
  requireSuccessfulReceipt(receipt);

  if (ethers.getAddress(tx.from).toLowerCase() !== currentOwner.toLowerCase()) {
    throw new Error('claim_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== poolAddress.toLowerCase()) {
    throw new Error('claim_target_mismatch');
  }
  if (tx.value !== 0n) {
    throw new Error('claim_value_mismatch');
  }

  const expectedData = CLAIM_INTERFACE.encodeFunctionData('claim', [tokenId]);
  if (String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error('claim_calldata_mismatch');
  }

  const state = await arcService.readClaimAuthorizationState({
    poolAddress: payload.poolAddress,
    ticketAddress: payload.ticketAddress,
    tokenId: payload.tokenId,
    roundId: payload.roundId,
  });

  if (!state.isClaimed || state.claimableRaw !== '0') {
    throw new Error('claim_postcondition_failed');
  }

  const transferEvent = findClaimTransferEvent(receipt, {
    usdcAddress: state.usdcAddress,
    from: poolAddress,
    to: currentOwner,
    amount,
  });
  if (!transferEvent) {
    throw new Error('claim_transfer_event_missing');
  }

  const rewardClaimedEvent = findRewardClaimedEvent(receipt, {
    poolAddress,
    roundId: payload.roundId,
    tokenId,
    owner: currentOwner,
    amount,
  });
  if (!rewardClaimedEvent) {
    throw new Error('claim_reward_event_missing');
  }

  const accounting = await tryReadPoolAccountingDelta(
    poolAddress,
    state.usdcAddress,
    payload.roundId,
    amount,
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
    amountRaw: amount.toString(),
    claimTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
    accounting,
  };
}

async function buildExternalClaimTransactionRequest(payload) {
  return buildClaimTransactionRequest(payload, EXTERNAL_MODES);
}

async function verifyExternalClaimReceipt(payload, txHash) {
  return verifyClaimReceipt(payload, txHash, EXTERNAL_MODES);
}

async function buildCircleClaimTransactionRequest(payload) {
  return buildClaimTransactionRequest(payload, CIRCLE_MODES);
}

async function verifyCircleClaimReceipt(payload, txHash) {
  return verifyClaimReceipt(payload, txHash, CIRCLE_MODES);
}

module.exports = {
  buildExternalClaimTransactionRequest,
  verifyExternalClaimReceipt,
  buildCircleClaimTransactionRequest,
  verifyCircleClaimReceipt,
};
