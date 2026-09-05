'use strict';

const { ethers } = require('ethers');
const { resolveExtremaWindow } = require('../src/services/binanceResolverService');

const ARC_CHAIN_ID = 5042002n;
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.network';

const POOL_ADDRESS = '0x7c2e9C3221534F24ecA83949D4f7249c95C35c33';
const TICKET_ADDRESS = '0xd20a69DB0A957D6f285b6Af67fed653d65cD7E5d';
const EXPECTED_RESOLVER = '0x1EDC4594195fFb134315c3258DE974563Ed9762A';
const ROUND_ID = 1n;

const EXPECTED_ENTRIES = [
  {
    ticketId: 1n,
    owner: '0xF12745dB3433AB8d1720E05aA63fadeED82f848E',
    predictionPriceCents: 230001n,
    entrySequence: 1n,
  },
  {
    ticketId: 2n,
    owner: '0x0EE26A497f8c17728dD75aB6f9c0813ab16EaA11',
    predictionPriceCents: 240001n,
    entrySequence: 2n,
  },
  {
    ticketId: 3n,
    owner: '0x3CE8C3c41660E97e3050aE32dE534B24abf8dddf',
    predictionPriceCents: 250001n,
    entrySequence: 3n,
  },
];

const POOL_ABI = [
  'function resolver() view returns (address)',
  'function ASSET() view returns (uint8)',
  'function DIRECTION() view returns (uint8)',
  'function CADENCE() view returns (uint8)',
  'function USDC() view returns (address)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function entries(uint256 ticketId) view returns (uint256,uint256,address,uint64,uint64)',
  'function settleRound(uint256 roundId,uint64 resolvedPriceCents)',
];

const TICKET_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
];

const STATUS = ['ENTRY_OPEN', 'LOCKED', 'SETTLED', 'CANCELLED'];

function toIso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}_mismatch:expected_${expected}:actual_${actual}`);
  }
}

function assertAddress(actual, expected, label) {
  if (ethers.getAddress(actual) !== ethers.getAddress(expected)) {
    throw new Error(
      `${label}_mismatch:expected_${ethers.getAddress(expected)}:actual_${ethers.getAddress(actual)}`,
    );
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(
    RPC_URL,
    { chainId: Number(ARC_CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );

  const network = await provider.getNetwork();
  if (network.chainId !== ARC_CHAIN_ID) {
    throw new Error(`wrong_chain_${network.chainId.toString()}`);
  }

  const latestBlock = await provider.getBlock('latest');
  if (!latestBlock) throw new Error('latest_block_unavailable');

  const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);
  const ticket = new ethers.Contract(TICKET_ADDRESS, TICKET_ABI, provider);

  const [resolver, asset, direction, cadence, usdcAddress, round] = await Promise.all([
    pool.resolver(),
    pool.ASSET(),
    pool.DIRECTION(),
    pool.CADENCE(),
    pool.USDC(),
    pool.getRound(ROUND_ID),
  ]);

  assertAddress(resolver, EXPECTED_RESOLVER, 'resolver');
  assertEqual(Number(asset), 1, 'asset_eth');
  assertEqual(Number(direction), 0, 'direction_high');
  assertEqual(Number(cadence), 1, 'cadence_weekly');

  const status = STATUS[Number(round.status)];
  if (!status) throw new Error('round_status_invalid');

  if (Number(round.entryCount) < 3) throw new Error('minimum_entries_not_met');
  assertEqual(round.entryCount.toString(), '3', 'entry_count');
  assertEqual(round.totalStake.toString(), '3000000', 'total_stake');
  assertEqual(round.escrowRemaining.toString(), '3000000', 'escrow_remaining');

  for (const expected of EXPECTED_ENTRIES) {
    const [entry, currentOwner] = await Promise.all([
      pool.entries(expected.ticketId),
      ticket.ownerOf(expected.ticketId),
    ]);

    assertEqual(entry[0].toString(), expected.ticketId.toString(), `ticket_${expected.ticketId}_id`);
    assertEqual(entry[1].toString(), ROUND_ID.toString(), `ticket_${expected.ticketId}_round`);
    assertAddress(entry[2], expected.owner, `ticket_${expected.ticketId}_original_entrant`);
    assertEqual(
      entry[3].toString(),
      expected.predictionPriceCents.toString(),
      `ticket_${expected.ticketId}_prediction`,
    );
    assertEqual(
      entry[4].toString(),
      expected.entrySequence.toString(),
      `ticket_${expected.ticketId}_sequence`,
    );
    assertAddress(currentOwner, expected.owner, `ticket_${expected.ticketId}_current_owner`);
  }

  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, provider);
  const poolUsdcBalance = await usdc.balanceOf(POOL_ADDRESS);
  if (poolUsdcBalance < round.escrowRemaining) {
    throw new Error('pool_usdc_below_reserved_escrow');
  }

  const chainTimestamp = BigInt(latestBlock.timestamp);
  let phase;

  if (status === 'ENTRY_OPEN') {
    phase = chainTimestamp < round.entryCloseAt ? 'WAITING_FOR_ENTRY_CLOSE' : 'LOCK_READY';
  } else if (status === 'LOCKED') {
    phase = chainTimestamp < round.observationEndAt
      ? 'WAITING_FOR_OBSERVATION_END'
      : 'SETTLEMENT_READY';
  } else if (status === 'SETTLED') {
    phase = 'ALREADY_SETTLED';
  } else {
    phase = 'INVALID_CANCELLED_STATE';
  }

  const base = {
    broadcast: false,
    chainId: Number(network.chainId),
    blockNumber: latestBlock.number,
    chainTimestamp: Number(chainTimestamp),
    chainTimestampIso: toIso(chainTimestamp),
    poolAddress: ethers.getAddress(POOL_ADDRESS),
    ticketAddress: ethers.getAddress(TICKET_ADDRESS),
    resolver: ethers.getAddress(resolver),
    roundId: Number(ROUND_ID),
    status,
    phase,
    entryCount: Number(round.entryCount),
    totalStakeRaw: round.totalStake.toString(),
    escrowRemainingRaw: round.escrowRemaining.toString(),
    poolUsdcBalanceRaw: poolUsdcBalance.toString(),
    entryCloseAt: toIso(round.entryCloseAt),
    observationStartAt: toIso(round.observationStartAt),
    observationEndAt: toIso(round.observationEndAt),
    entries: EXPECTED_ENTRIES.map((item) => ({
      ticketId: item.ticketId.toString(),
      owner: item.owner,
      predictionPriceCents: item.predictionPriceCents.toString(),
      entrySequence: item.entrySequence.toString(),
    })),
  };

  if (phase !== 'SETTLEMENT_READY') {
    console.log(JSON.stringify(base, null, 2));
    if (phase === 'INVALID_CANCELLED_STATE') {
      throw new Error('three_entry_round_unexpectedly_cancelled');
    }
    console.log('LIVE_SETTLEMENT_PREP=PASS');
    console.log(`NEXT_PHASE=${phase}`);
    return;
  }

  const evidence = await resolveExtremaWindow({
    symbol: 'ETHUSDT',
    cadence: 'WEEKLY',
    observationStartAt: toIso(round.observationStartAt),
    observationEndAt: toIso(round.observationEndAt),
  });

  const resolvedPriceCents = evidence.high.resolvedPriceCents;
  const iface = new ethers.Interface(POOL_ABI);
  const calldata = iface.encodeFunctionData('settleRound', [
    ROUND_ID,
    BigInt(resolvedPriceCents),
  ]);

  console.log(JSON.stringify({
    ...base,
    resolverEvidence: {
      source: evidence.source,
      symbol: evidence.symbol,
      cadence: evidence.cadence,
      interval: evidence.interval,
      candleCount: evidence.candleCount,
      sourceDataSha256: evidence.sourceDataSha256,
      evidenceSha256: evidence.evidenceSha256,
      exactHigh: evidence.high.exact,
      resolvedPriceCents,
      highCandleOpenIso: evidence.high.candleOpenIso,
    },
    settlementTransaction: {
      broadcast: false,
      from: ethers.getAddress(EXPECTED_RESOLVER),
      to: ethers.getAddress(POOL_ADDRESS),
      value: '0',
      data: calldata,
      function: `settleRound(1, ${resolvedPriceCents})`,
    },
  }, null, 2));

  console.log('LIVE_SETTLEMENT_PREP=PASS');
  console.log('NEXT_PHASE=SETTLEMENT_READY');
  console.log('NO_TRANSACTION_BROADCAST=PASS');
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
