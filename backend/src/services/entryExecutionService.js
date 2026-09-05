'use strict';

const { ethers } = require('ethers');
const arcService = require('./arcService');
const walletService = require('./walletService');

const STAKE_AMOUNT = 1_000_000n;

const USDC_ENTRY_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
];

const POOL_ENTRY_ABI = [
  'function TICKET() view returns (address)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function hasEntered(uint256 roundId,address entrant) view returns (bool)',
  'function predictionTaken(uint256 roundId,uint64 predictionPriceCents) view returns (bool)',
  'function enterPrediction(uint256 roundId,uint64 predictionPriceCents) returns (uint256 ticketId)',
  'event PredictionEntered(uint256 indexed roundId,uint256 indexed ticketId,address indexed entrant,uint64 predictionPriceCents,uint64 entrySequence)',
];

const TICKET_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
];

function assertEntryPayload(payload) {
  if (
    !payload ||
    payload.action !== 'ENTRY' ||
    payload.chainId !== 5042002 ||
    payload.amountRaw !== '1000000' ||
    payload.destination?.toLowerCase() !== payload.contract?.toLowerCase() ||
    !ethers.isAddress(payload.contract) ||
    !ethers.isAddress(payload.walletAddress) ||
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

function requireSuccessfulReceipt(receipt, errorName) {
  if (!receipt || receipt.status !== 1) throw new Error(errorName);
}

async function executeEntry(userId, payload) {
  assertEntryPayload(payload);

  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const signer = await walletService.getSignerForUser(userId, provider);
  const walletAddress = ethers.getAddress(signer.address);
  const poolAddress = ethers.getAddress(payload.contract);

  if (walletAddress.toLowerCase() !== payload.walletAddress.toLowerCase()) {
    throw new Error('entry_wallet_mismatch');
  }

  const usdc = new ethers.Contract(
    arcService.ARC_TESTNET_USDC_ADDRESS,
    USDC_ENTRY_ABI,
    signer,
  );
  const pool = new ethers.Contract(poolAddress, POOL_ENTRY_ABI, signer);

  const latestBlock = await provider.getBlock('latest');
  if (!latestBlock) throw new Error('arc_latest_block_unavailable');

  const [
    roundBefore,
    hasEntered,
    priceTaken,
    walletUsdcBefore,
    poolUsdcBefore,
    nativeBalance,
    ticketAddressRaw,
  ] = await Promise.all([
    pool.getRound(payload.roundId),
    pool.hasEntered(payload.roundId, walletAddress),
    pool.predictionTaken(payload.roundId, payload.predictionPriceCents),
    usdc.balanceOf(walletAddress),
    usdc.balanceOf(poolAddress),
    provider.getBalance(walletAddress),
    pool.TICKET(),
  ]);

  const chainTimestamp = BigInt(latestBlock.timestamp);

  if (
    Number(roundBefore.status) !== 0 ||
    chainTimestamp < roundBefore.entryOpenAt ||
    chainTimestamp >= roundBefore.entryCloseAt
  ) {
    throw new Error('entry_round_not_available');
  }
  if (hasEntered) throw new Error('entry_already_entered');
  if (priceTaken) throw new Error('entry_price_taken');
  if (walletUsdcBefore < STAKE_AMOUNT) throw new Error('entry_insufficient_usdc');
  if (nativeBalance === 0n) throw new Error('entry_insufficient_gas');

  let approvalTxHash = null;
  const allowance = await usdc.allowance(walletAddress, poolAddress);

  if (allowance < STAKE_AMOUNT) {
    const approvalTx = await usdc.approve(poolAddress, STAKE_AMOUNT);
    approvalTxHash = approvalTx.hash;
    const approvalReceipt = await approvalTx.wait();
    requireSuccessfulReceipt(approvalReceipt, 'entry_approval_failed');
  }

  const entryTx = await pool.enterPrediction(
    payload.roundId,
    payload.predictionPriceCents,
  );
  const entryReceipt = await entryTx.wait();
  requireSuccessfulReceipt(entryReceipt, 'entry_transaction_failed');

  let ticketId = null;
  let entrySequence = null;

  for (const log of entryReceipt.logs) {
    try {
      const parsed = pool.interface.parseLog(log);
      if (parsed?.name === 'PredictionEntered') {
        ticketId = parsed.args.ticketId;
        entrySequence = parsed.args.entrySequence;
        break;
      }
    } catch {}
  }

  if (ticketId === null || entrySequence === null) {
    throw new Error('entry_event_missing');
  }

  const ticketAddress = ethers.getAddress(ticketAddressRaw);
  const ticket = new ethers.Contract(ticketAddress, TICKET_ABI, provider);

  const [roundAfter, walletUsdcAfter, poolUsdcAfter, ticketOwner] =
    await Promise.all([
      pool.getRound(payload.roundId),
      usdc.balanceOf(walletAddress),
      usdc.balanceOf(poolAddress),
      ticket.ownerOf(ticketId),
    ]);

  const walletSpentRaw = walletUsdcBefore - walletUsdcAfter;

  // Arc uses one underlying USDC balance for both the native gas token and the
  // 6-decimal ERC-20 interface. Approval and entry gas therefore also reduce
  // balanceOf(wallet). The wallet delta must be AT LEAST the 1 USDC stake,
  // while the pool/round accounting must increase by EXACTLY 1 USDC.
  if (
    roundAfter.entryCount !== roundBefore.entryCount + 1n ||
    roundAfter.totalStake !== roundBefore.totalStake + STAKE_AMOUNT ||
    roundAfter.escrowRemaining !== roundBefore.escrowRemaining + STAKE_AMOUNT ||
    poolUsdcAfter !== poolUsdcBefore + STAKE_AMOUNT ||
    walletUsdcAfter >= walletUsdcBefore ||
    walletSpentRaw < STAKE_AMOUNT ||
    ticketOwner.toLowerCase() !== walletAddress.toLowerCase()
  ) {
    throw new Error('entry_postcondition_failed');
  }

  arcService.refreshStandardRoundsCache().catch((error) => {
    console.error('[arc-round-cache] post-entry refresh failed', error.message);
  });

  return {
    chainId: Number(network.chainId),
    walletAddress,
    poolAddress,
    ticketAddress,
    roundId: payload.roundId,
    predictionPriceCents: payload.predictionPriceCents,
    stakeRaw: STAKE_AMOUNT.toString(),
    stakeUsdc: ethers.formatUnits(STAKE_AMOUNT, 6),
    approvalTxHash,
    entryTxHash: entryTx.hash,
    explorerUrl: `https://testnet.arcscan.app/tx/${entryTx.hash}`,
    ticketId: ticketId.toString(),
    entrySequence: entrySequence.toString(),
    ticketOwner: ethers.getAddress(ticketOwner),
    before: {
      walletUsdcRaw: walletUsdcBefore.toString(),
      walletUsdc: ethers.formatUnits(walletUsdcBefore, 6),
      poolUsdcRaw: poolUsdcBefore.toString(),
      poolUsdc: ethers.formatUnits(poolUsdcBefore, 6),
      entryCount: Number(roundBefore.entryCount),
      totalStakeRaw: roundBefore.totalStake.toString(),
      totalStakeUsdc: ethers.formatUnits(roundBefore.totalStake, 6),
    },
    walletSpent: {
      raw: walletSpentRaw.toString(),
      usdc: ethers.formatUnits(walletSpentRaw, 6),
      stakeRaw: STAKE_AMOUNT.toString(),
      stakeUsdc: ethers.formatUnits(STAKE_AMOUNT, 6),
      gasAndRoundingRaw: (walletSpentRaw - STAKE_AMOUNT).toString(),
      gasAndRoundingUsdc: ethers.formatUnits(walletSpentRaw - STAKE_AMOUNT, 6),
    },
    after: {
      walletUsdcRaw: walletUsdcAfter.toString(),
      walletUsdc: ethers.formatUnits(walletUsdcAfter, 6),
      poolUsdcRaw: poolUsdcAfter.toString(),
      poolUsdc: ethers.formatUnits(poolUsdcAfter, 6),
      entryCount: Number(roundAfter.entryCount),
      totalStakeRaw: roundAfter.totalStake.toString(),
      totalStakeUsdc: ethers.formatUnits(roundAfter.totalStake, 6),
      escrowRemainingRaw: roundAfter.escrowRemaining.toString(),
      escrowRemainingUsdc: ethers.formatUnits(roundAfter.escrowRemaining, 6),
    },
  };
}

module.exports = { executeEntry };
