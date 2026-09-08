'use strict';

const { ethers } = require('ethers');
const arcService = require('./arcService');
const { isCanonicalV2Round } = require('./canonicalMarketSchedule');

const STAKE_AMOUNT = 1_000_000n;
const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
];
const POOL_ABI = [
  'function TICKET() view returns (address)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function hasEntered(uint256 roundId,address entrant) view returns (bool)',
  'function predictionTaken(uint256 roundId,uint64 predictionPriceCents) view returns (bool)',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
  'function enterPrediction(uint256 roundId,uint64 predictionPriceCents) returns (uint256 ticketId)',
  'event PredictionEntered(uint256 indexed roundId,uint256 indexed ticketId,address indexed entrant,uint64 predictionPriceCents,uint64 entrySequence)',
];
const TICKET_ABI = ['function ownerOf(uint256 tokenId) view returns (address)'];
const USDC_INTERFACE = new ethers.Interface(USDC_ABI);
const POOL_INTERFACE = new ethers.Interface(POOL_ABI);

function assertPayload(payload) {
  if (
    !payload ||
    payload.action !== 'ENTRY' ||
    payload.executionMode !== 'EXTERNAL_WALLET' ||
    payload.chainId !== Number(arcService.ARC_TESTNET_CHAIN_ID) ||
    payload.amountRaw !== STAKE_AMOUNT.toString() ||
    !ethers.isAddress(payload.contract) ||
    !ethers.isAddress(payload.destination) ||
    !ethers.isAddress(payload.walletAddress) ||
    payload.contract.toLowerCase() !== payload.destination.toLowerCase() ||
    !Number.isInteger(payload.roundId) ||
    payload.roundId <= 0 ||
    !Number.isInteger(payload.predictionPriceCents) ||
    payload.predictionPriceCents <= 0 ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Date.parse(payload.expiresAt) <= Date.now()
  ) {
    throw new Error('action_authorization_invalid');
  }
}

function canonicalTopology(poolAddress) {
  const topology = arcService.ARC_POOL_TOPOLOGY.find(
    (item) => item.poolAddress.toLowerCase() === poolAddress.toLowerCase(),
  );
  if (!topology) throw new Error('entry_round_not_available');
  return topology;
}

async function readLiveState(payload) {
  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }
  const walletAddress = ethers.getAddress(payload.walletAddress);
  const poolAddress = ethers.getAddress(payload.contract);
  const usdcAddress = ethers.getAddress(arcService.ARC_TESTNET_USDC_ADDRESS);
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, provider);
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('arc_latest_block_unavailable');

  const [round, hasEntered, predictionTaken, balance, allowance, nativeBalance, ticketAddress] =
    await Promise.all([
      pool.getRound(payload.roundId),
      pool.hasEntered(payload.roundId, walletAddress),
      pool.predictionTaken(payload.roundId, payload.predictionPriceCents),
      usdc.balanceOf(walletAddress),
      usdc.allowance(walletAddress, poolAddress),
      provider.getBalance(walletAddress),
      pool.TICKET(),
    ]);

  return {
    provider,
    network,
    walletAddress,
    poolAddress,
    usdcAddress,
    ticketAddress: ethers.getAddress(ticketAddress),
    pool,
    round,
    chainTimestamp: BigInt(block.timestamp),
    hasEntered,
    predictionTaken,
    balance,
    allowance,
    nativeBalance,
  };
}

function assertEntryAvailable(payload, state) {
  const topology = canonicalTopology(state.poolAddress);
  if (
    !isCanonicalV2Round(topology.cadence, state.round) ||
    Number(state.round.status) !== 0 ||
    state.chainTimestamp < state.round.entryOpenAt ||
    state.chainTimestamp >= state.round.entryCloseAt
  ) throw new Error('entry_round_not_available');
  if (state.hasEntered) throw new Error('entry_already_entered');
  if (state.predictionTaken) throw new Error('entry_price_taken');
  if (state.balance < STAKE_AMOUNT) throw new Error('entry_insufficient_usdc');
  if (state.nativeBalance === 0n) throw new Error('entry_insufficient_gas');
  if (payload.walletAddress.toLowerCase() !== state.walletAddress.toLowerCase()) {
    throw new Error('entry_wallet_mismatch');
  }
}

function transactionRequest({ from, to, data }) {
  return {
    chainId: Number(arcService.ARC_TESTNET_CHAIN_ID),
    from: ethers.getAddress(from),
    to: ethers.getAddress(to),
    data,
    value: '0x0',
  };
}

async function prepareExternalEntry(payload, dependencies = {}) {
  assertPayload(payload);
  const state = await (dependencies.readLiveState || readLiveState)(payload);
  assertEntryAvailable(payload, state);

  if (state.allowance < STAKE_AMOUNT) {
    return {
      step: 'APPROVAL_REQUIRED',
      transactionRequest: transactionRequest({
        from: state.walletAddress,
        to: state.usdcAddress,
        data: USDC_INTERFACE.encodeFunctionData('approve', [state.poolAddress, STAKE_AMOUNT]),
      }),
    };
  }

  return {
    step: 'ENTRY_READY',
    transactionRequest: transactionRequest({
      from: state.walletAddress,
      to: state.poolAddress,
      data: POOL_INTERFACE.encodeFunctionData('enterPrediction', [
        payload.roundId,
        payload.predictionPriceCents,
      ]),
    }),
  };
}

async function readTransaction(
  provider,
  txHash,
  notFoundError,
  failureError = 'entry_transaction_failed',
) {
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error(notFoundError);
  if (receipt.status !== 1) throw new Error(failureError);
  return { tx, receipt };
}

async function readPostconditions(state, ticketId, payload) {
  const ticket = new ethers.Contract(state.ticketAddress, TICKET_ABI, state.provider);
  const [entry, ticketOwner, roundAfter, hasEntered, predictionTaken] = await Promise.all([
    state.pool.entries(ticketId),
    ticket.ownerOf(ticketId),
    state.pool.getRound(payload.roundId),
    state.pool.hasEntered(payload.roundId, state.walletAddress),
    state.pool.predictionTaken(payload.roundId, payload.predictionPriceCents),
  ]);
  return { entry, ticketOwner, roundAfter, hasEntered, predictionTaken };
}

function assertTransaction(tx, request) {
  if (ethers.getAddress(tx.from).toLowerCase() !== request.from.toLowerCase()) {
    throw new Error('entry_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== request.to.toLowerCase()) {
    throw new Error('entry_target_mismatch');
  }
  if (tx.value !== 0n) throw new Error('entry_value_mismatch');
  if (String(tx.data).toLowerCase() !== request.data.toLowerCase()) {
    throw new Error('entry_calldata_mismatch');
  }
}

async function verifyExternalApprovalReceipt(payload, txHash, dependencies = {}) {
  assertPayload(payload);
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('entry_txhash_invalid');
  }
  const state = await (dependencies.readLiveState || readLiveState)(payload);
  assertEntryAvailable(payload, state);
  const request = transactionRequest({
    from: state.walletAddress,
    to: state.usdcAddress,
    data: USDC_INTERFACE.encodeFunctionData('approve', [state.poolAddress, STAKE_AMOUNT]),
  });
  const { tx } = await (dependencies.readTransaction || readTransaction)(
    state.provider,
    txHash,
    'entry_approval_transaction_not_found',
    'entry_approval_failed',
  );
  assertTransaction(tx, request);

  const refreshed = await (dependencies.readLiveState || readLiveState)(payload);
  assertEntryAvailable(payload, refreshed);
  if (refreshed.allowance < STAKE_AMOUNT) throw new Error('entry_approval_failed');
  return {
    approvalTxHash: txHash,
    step: 'ENTRY_READY',
    transactionRequest: transactionRequest({
      from: refreshed.walletAddress,
      to: refreshed.poolAddress,
      data: POOL_INTERFACE.encodeFunctionData('enterPrediction', [
        payload.roundId,
        payload.predictionPriceCents,
      ]),
    }),
  };
}

async function verifyExternalEntryReceipt(payload, txHash, dependencies = {}) {
  assertPayload(payload);
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('entry_txhash_invalid');
  }
  const state = await (dependencies.readLiveState || readLiveState)(payload);
  const request = transactionRequest({
    from: state.walletAddress,
    to: state.poolAddress,
    data: POOL_INTERFACE.encodeFunctionData('enterPrediction', [
      payload.roundId,
      payload.predictionPriceCents,
    ]),
  });
  const { tx, receipt } = await (dependencies.readTransaction || readTransaction)(
    state.provider,
    txHash,
    'entry_transaction_not_found',
  );
  assertTransaction(tx, request);

  let entered = null;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== state.poolAddress.toLowerCase()) continue;
    try {
      const parsed = POOL_INTERFACE.parseLog(log);
      if (
        parsed?.name === 'PredictionEntered' &&
        Number(parsed.args.roundId) === payload.roundId &&
        parsed.args.entrant.toLowerCase() === state.walletAddress.toLowerCase() &&
        Number(parsed.args.predictionPriceCents) === payload.predictionPriceCents
      ) {
        entered = parsed.args;
        break;
      }
    } catch {}
  }
  if (!entered) throw new Error('entry_event_missing');

  const ticketId = entered.ticketId;
  const { entry, ticketOwner, roundAfter, hasEntered, predictionTaken } =
    await (dependencies.readPostconditions || readPostconditions)(state, ticketId, payload);

  if (
    entry.ticketId !== ticketId ||
    Number(entry.roundId) !== payload.roundId ||
    entry.originalEntrant.toLowerCase() !== state.walletAddress.toLowerCase() ||
    Number(entry.predictionPriceCents) !== payload.predictionPriceCents ||
    entry.entrySequence !== entered.entrySequence ||
    ethers.getAddress(ticketOwner).toLowerCase() !== state.walletAddress.toLowerCase() ||
    !hasEntered ||
    !predictionTaken
  ) throw new Error('entry_postcondition_failed');

  arcService.invalidateArcWalletStateCache(state.walletAddress);
  arcService.refreshStandardRoundsCache().catch(() => {});

  return {
    chainId: Number(state.network.chainId),
    executionMode: 'EXTERNAL_WALLET',
    walletAddress: state.walletAddress,
    poolAddress: state.poolAddress,
    ticketAddress: state.ticketAddress,
    roundId: payload.roundId,
    predictionPriceCents: payload.predictionPriceCents,
    stakeRaw: STAKE_AMOUNT.toString(),
    stakeUsdc: ethers.formatUnits(STAKE_AMOUNT, 6),
    approvalTxHash: null,
    entryTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
    ticketId: ticketId.toString(),
    entrySequence: entered.entrySequence.toString(),
    ticketOwner: ethers.getAddress(ticketOwner),
    after: {
      entryCount: Number(roundAfter.entryCount),
      totalStakeRaw: roundAfter.totalStake.toString(),
      totalStakeUsdc: ethers.formatUnits(roundAfter.totalStake, 6),
      escrowRemainingRaw: roundAfter.escrowRemaining.toString(),
      escrowRemainingUsdc: ethers.formatUnits(roundAfter.escrowRemaining, 6),
    },
  };
}

module.exports = {
  STAKE_AMOUNT,
  assertPayload,
  assertTransaction,
  prepareExternalEntry,
  verifyExternalApprovalReceipt,
  verifyExternalEntryReceipt,
};
