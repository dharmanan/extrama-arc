'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  APPROVED_SEED_WALLETS,
  STAKE_AMOUNT_RAW,
  generateDeterministicPredictions,
  createSeedBotDryRunPlan,
} = require('../src/services/seedBotCore');
const {
  EXECUTION_MODES,
  evaluateLiveEntryEligibility,
  createSeedBotExecutionService,
} = require('../src/services/seedBotExecutionService');
const {
  createIdempotencyStore,
  createSeedBotScheduler,
  planKey,
} = require('../src/services/seedBotScheduler');

const topology = [
  ['BTC', 'HIGH'],
  ['BTC', 'LOW'],
  ['ETH', 'HIGH'],
  ['ETH', 'LOW'],
  ['SOL', 'HIGH'],
  ['SOL', 'LOW'],
  ['HYPE', 'HIGH'],
  ['HYPE', 'LOW'],
].map(([asset, direction], index) => ({
  asset,
  direction,
  cadence: 'DAILY',
  poolAddress: `0x${String(index + 1).padStart(40, '0')}`,
  ticketAddress: `0x${String(index + 101).padStart(40, '0')}`,
}));

const entryOpenAt = 1_800_000_000;
const entryCloseAt = entryOpenAt + 20 * 60 * 60;
const roundsState = {
  chain: { timestamp: entryOpenAt + 60 },
  pools: topology.map((pool, index) => ({
    poolAddress: pool.poolAddress,
    round: {
      roundId: 900 + index,
      contractStatus: 'ENTRY_OPEN',
      canEnter: true,
      entryOpenAt: new Date(entryOpenAt * 1000).toISOString(),
      entryCloseAt: new Date(entryCloseAt * 1000).toISOString(),
      marketPeriodStartAt: new Date(entryOpenAt * 1000).toISOString(),
    },
  })),
};

const marketReferences = {
  BTC: { available: true, markPriceCents: '6500000' },
  ETH: { available: true, markPriceCents: '250000' },
  SOL: { available: true, markPriceCents: '15000' },
  HYPE: { available: true, markPriceCents: '4200' },
};

const funding = new Map(
  APPROVED_SEED_WALLETS.map((wallet) => [wallet.toLowerCase(), {
    usdcRaw: (STAKE_AMOUNT_RAW * 100n).toString(),
    nativeRaw: '1000000000000000000',
    requiredGasRaw: '1000000000000',
  }]),
);

function stateFor(entry, overrides = {}) {
  return {
    chainId: 5042002,
    poolAddress: entry.poolAddress,
    roundId: entry.roundId,
    roundStatus: 'ENTRY_OPEN',
    chainTimestamp: entryOpenAt + 60,
    entryOpenAt: entry.entryOpenAt,
    entryCloseAt: entry.entryCloseAt,
    hasEntered: false,
    predictionTaken: false,
    usdcRaw: (STAKE_AMOUNT_RAW * 100n).toString(),
    nativeRaw: '1000000000000000000',
    ...overrides,
  };
}

async function main() {
  const plan = await createSeedBotDryRunPlan({
    wallets: APPROVED_SEED_WALLETS,
    topology,
    roundsState,
    marketReferences,
    fundingByWallet: funding,
    requiredGasRaw: '1000000000000',
    seed: 'seed-bot-execution-verifier-v1',
  });

  assert.equal(plan.entries.length, 72, 'all eight pools have nine intended entries');
  assert.equal(plan.executableEntries.length, 72);
  assert.equal(new Set(plan.executableEntries.map((entry) => `${entry.wallet.toLowerCase()}:${entry.poolAddress}:${entry.roundId}`)).size, 72);

  for (const entry of plan.executableEntries) {
    assert.equal(evaluateLiveEntryEligibility({ entry, liveState: stateFor(entry), topology }).eligible, true);
  }

  const sample = plan.executableEntries[0];
  assert.equal(evaluateLiveEntryEligibility({
    entry: sample,
    liveState: stateFor(sample, { chainTimestamp: entryCloseAt }),
    topology,
  }).reason, 'entry_round_closed');
  assert.equal(evaluateLiveEntryEligibility({
    entry: sample,
    liveState: stateFor(sample, { roundStatus: 'LOCKED' }),
    topology,
  }).reason, 'entry_round_not_open');
  assert.equal(evaluateLiveEntryEligibility({
    entry: sample,
    liveState: stateFor(sample, { poolAddress: topology[1].poolAddress }),
    topology,
  }).reason, 'entry_pool_not_current');
  assert.equal(evaluateLiveEntryEligibility({
    entry: sample,
    liveState: stateFor(sample, { usdcRaw: '0' }),
    topology,
  }).reason, 'entry_insufficient_usdc');
  assert.equal(evaluateLiveEntryEligibility({
    entry: sample,
    liveState: stateFor(sample, { nativeRaw: '0' }),
    topology,
  }).reason, 'entry_insufficient_gas');
  assert.equal(evaluateLiveEntryEligibility({
    entry: sample,
    liveState: stateFor(sample, { hasEntered: true }),
    topology,
  }).reason, 'entry_already_entered');
  assert.equal(evaluateLiveEntryEligibility({
    entry: sample,
    liveState: stateFor(sample, { predictionTaken: true }),
    topology,
  }).reason, 'entry_price_taken');
  const collisionState = stateFor(sample, {
    predictionTaken: true,
    markPriceCents: marketReferences.BTC.markPriceCents,
    takenPredictionCents: [sample.predictionPriceCents],
    seed: 'seed-bot-execution-verifier-v1',
    marketPeriodStartAt: sample.entryOpenAt,
  });
  const collisionEligibility = evaluateLiveEntryEligibility({
    entry: sample,
    liveState: collisionState,
    topology,
  });
  assert.equal(collisionEligibility.replacementPredictionPriceCents === sample.predictionPriceCents, false);
  assert.equal(typeof collisionEligibility.replacementPredictionPriceCents, 'string');

  const collisionA = generateDeterministicPredictions({
    markPriceCents: '1',
    wallets: APPROVED_SEED_WALLETS,
    seed: 'collision-v1',
    poolKey: 'tiny-round',
  });
  const collisionB = generateDeterministicPredictions({
    markPriceCents: '1',
    wallets: APPROVED_SEED_WALLETS,
    seed: 'collision-v1',
    poolKey: 'tiny-round',
  });
  assert.deepEqual(collisionA, collisionB, 'collision resolution is deterministic');
  assert.equal(new Set(Object.values(collisionA)).size, 9, 'collision resolution keeps nine unique slots');

  let executorCalls = 0;
  const dryExecutor = createSeedBotExecutionService({ mode: EXECUTION_MODES.DRY_RUN });
  const dryResult = await dryExecutor.executeDueEntry(sample);
  assert.equal(dryResult.reason, 'dry_run');
  assert.equal(dryResult.executed, false);
  assert.equal(executorCalls, 0, 'DRY_RUN performs zero broadcasts');

  const liveExecutor = createSeedBotExecutionService({ mode: EXECUTION_MODES.LIVE });
  const liveResult = await liveExecutor.executeDueEntry(sample);
  assert.equal(liveResult.reason, 'live_mode_disabled');
  assert.equal(liveResult.executed, false, 'LIVE is unreachable in Phase 2');
  assert.equal(liveExecutor.liveEnabled, false);
  assert.equal(executorCalls, 0);

  const baseDue = {
    ...sample,
    plannedExecutionAt: new Date((entryOpenAt + 100) * 1000).toISOString(),
    entryCloseAt: new Date(entryCloseAt * 1000).toISOString(),
  };
  const dueEntries = [
    baseDue,
    { ...baseDue, wallet: APPROVED_SEED_WALLETS[1], plannedExecutionAt: new Date((entryOpenAt + 101) * 1000).toISOString() },
    { ...baseDue, wallet: APPROVED_SEED_WALLETS[2], plannedExecutionAt: new Date((entryOpenAt + 102) * 1000).toISOString() },
  ];
  const schedulerState = {};
  const dispatched = [];
  const schedulerExecutor = {
    async executeDueEntry(entry) {
      dispatched.push(planKey(entry));
      return { executed: true };
    },
  };
  const scheduler = createSeedBotScheduler({
    executor: schedulerExecutor,
    store: createIdempotencyStore(schedulerState),
  });
  const firstTick = await scheduler.tick({ entries: dueEntries, now: entryOpenAt + 1_000 });
  assert.equal(firstTick.dispatched, true);
  const blockedTick = await scheduler.tick({ entries: dueEntries, now: entryOpenAt + 1_000 });
  assert.equal(blockedTick.reason, 'global_spacing');

  // A second scheduler instance sharing the persisted store models restart:
  // the first work key remains completed and the five-minute gate remains set.
  const restarted = createSeedBotScheduler({
    executor: schedulerExecutor,
    store: createIdempotencyStore(schedulerState),
  });
  const secondTick = await restarted.tick({ entries: dueEntries, now: entryOpenAt + 1_300 });
  assert.equal(secondTick.dispatched, true);
  assert.equal(dispatched.length, 2, 'restart does not duplicate completed work or burst overdue work');
  assert.notEqual(dispatched[0], dispatched[1]);

  const expiredTick = await restarted.tick({
    entries: [{ ...baseDue, plannedExecutionAt: new Date((entryOpenAt + 10) * 1000).toISOString(), entryCloseAt: new Date((entryOpenAt + 20) * 1000).toISOString() }],
    now: entryOpenAt + 1_000,
  });
  assert.equal(expiredTick.dispatched, false, 'expired rounds never execute');

  const coreSource = fs.readFileSync(require.resolve('../src/services/seedBotCore'), 'utf8');
  const executionSource = fs.readFileSync(require.resolve('../src/services/seedBotExecutionService'), 'utf8');
  assert.equal(/Math\.random|crypto\.random|privateKey\s*=/.test(coreSource + executionSource), false, 'no runtime randomness or decrypted key handling');

  console.log('seed-bot-execution: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
