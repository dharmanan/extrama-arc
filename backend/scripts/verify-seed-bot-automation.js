'use strict';

const assert = require('node:assert/strict');
const {
  createIdempotencyStore,
  createSeedBotScheduler,
} = require('../src/services/seedBotScheduler');
const {
  createSeedBotAutomationService,
} = require('../src/services/seedBotAutomationService');

async function main() {
  const walletA =
    '0x995f659CD0AEd5ac3ac9D238cCeC74AdD5347A97';
  const walletB =
    '0x8b309436e4205462328e405F33564dA9DA6cCa38';

  const poolAddress =
    '0x0000000000000000000000000000000000000001';
  const ticketAddress =
    '0x0000000000000000000000000000000000000002';

  const topology = [{
    asset: 'BTC',
    direction: 'HIGH',
    cadence: 'DAILY',
    poolAddress,
    ticketAddress,
  }];

  const baseMs = Date.parse('2030-01-01T10:00:00.000Z');
  let nowMs = baseMs;

  const fakeClient = {
    locked: true,
    released: 0,
    lockCalls: 0,
    unlockCalls: 0,

    async query(sql) {
      const compact = sql.replace(/\s+/g, ' ').trim();

      if (compact.startsWith('SELECT pg_try_advisory_lock')) {
        this.lockCalls += 1;
        return {
          rows: [{ locked: this.locked }],
        };
      }

      if (compact.startsWith('SELECT pg_advisory_unlock')) {
        this.unlockCalls += 1;
        return {
          rows: [{ pg_advisory_unlock: true }],
        };
      }

      throw new Error(`unexpected_sql:${compact}`);
    },

    release() {
      this.released += 1;
    },
  };

  const fakeDb = {
    async getClient() {
      return fakeClient;
    },
  };

  let storedPlans = [];
  let plannerCalls = 0;
  let walletLoadCalls = 0;
  let freshRoundReads = 0;
  let executorCalls = 0;

  const planStoreFactory = () => ({
    async loadOpenEntries({
      now,
      plannerVersion = null,
    }) {
      const timestamp =
        new Date(now).getTime();

      return storedPlans.filter(
        entry =>
          new Date(
            entry.entryCloseAt,
          ).getTime() > timestamp &&
          (
            plannerVersion === null ||
            entry.plannerVersion === plannerVersion
          ),
      );
    },

    async persistEntries(entries) {
      let inserted = 0;

      for (const entry of entries) {
        const exists = storedPlans.some(
          existing =>
            existing.wallet.toLowerCase() ===
              entry.wallet.toLowerCase() &&
            existing.poolAddress.toLowerCase() ===
              entry.poolAddress.toLowerCase() &&
            String(existing.roundId) === String(entry.roundId),
        );

        if (!exists) {
          storedPlans.push({ ...entry });
          inserted += 1;
        }
      }

      return { inserted };
    },
  });

  const planner = async () => {
    plannerCalls += 1;

    return {
      executableEntries: [
        {
          wallet: walletA,
          pool: 'btc-daily-high',
          poolAddress,
          roundId: '8',
          plannerVersion: 'extrema-seed-bot-v3',
          predictionPriceCents: '6500000',
          plannedExecutionAt:
            '2030-01-01T09:00:00.000Z',
          entryOpenAt:
            '2030-01-01T00:00:00.000Z',
          entryCloseAt:
            '2030-01-01T20:00:00.000Z',
          eligible: true,
          alreadyEntered: false,
        },
        {
          wallet: walletB,
          pool: 'btc-daily-high',
          poolAddress,
          roundId: '8',
          plannerVersion: 'extrema-seed-bot-v3',
          predictionPriceCents: '6600000',
          plannedExecutionAt:
            '2030-01-01T09:01:00.000Z',
          entryOpenAt:
            '2030-01-01T00:00:00.000Z',
          entryCloseAt:
            '2030-01-01T20:00:00.000Z',
          eligible: true,
          alreadyEntered: false,
        },
      ],
    };
  };

  const arc = {
    ARC_POOL_TOPOLOGY: topology,

    async getStandardRoundsState({ forceFresh }) {
      freshRoundReads += 1;
      assert.equal(forceFresh, true);

      return {
        chain: {
          timestamp: Math.floor(nowMs / 1000),
        },
        pools: [],
      };
    },
  };

  const sharedSchedulerState = {};

  const service = createSeedBotAutomationService({
    db: fakeDb,
    arcService: arc,
    topology,
    enabled: true,
    clock: () => nowMs,

    planner,

    loadWallets: async () => {
      walletLoadCalls += 1;
      return [walletA, walletB];
    },

    planStoreFactory,

    idempotencyStoreFactory: () =>
      createIdempotencyStore(sharedSchedulerState),

    executorFactory: () => ({
      async executeDueEntry(entry) {
        executorCalls += 1;

        return {
          executed: true,
          reason: 'executed',
          wallet: entry.wallet,
        };
      },
    }),

    schedulerFactory: createSeedBotScheduler,

    logger: {
      log() {},
      error() {},
    },
  });

  // First tick creates the immutable plan and dispatches only one due entry.
  const first = await service.runTick();

  assert.equal(first.locked, true);
  assert.equal(first.planned, 2);
  assert.equal(first.openPlans, 2);
  assert.equal(first.dispatched, true);
  assert.equal(executorCalls, 1);
  assert.equal(plannerCalls, 1);
  assert.equal(walletLoadCalls, 1);
  assert.equal(freshRoundReads, 1);
  assert.equal(storedPlans.length, 2);

  // One minute later the second overdue entry must still be blocked by the
  // durable five-minute global spacing rule.
  nowMs += 60 * 1000;

  const second = await service.runTick();

  assert.equal(second.dispatched, false);
  assert.equal(second.reason, 'global_spacing');
  assert.equal(executorCalls, 1);
  assert.equal(
    plannerCalls,
    1,
    'existing open plan must not be regenerated',
  );
  assert.equal(
    freshRoundReads,
    1,
    'existing open plan must not refetch round state for planning',
  );

  // At five minutes the second entry may dispatch.
  nowMs = baseMs + 5 * 60 * 1000;

  const third = await service.runTick();

  assert.equal(third.dispatched, true);
  assert.equal(executorCalls, 2);
  assert.equal(plannerCalls, 1);

  // Advisory lock contention must fail closed before planner/executor work.
  fakeClient.locked = false;

  const lockedOut = await service.runTick();

  assert.equal(lockedOut.locked, false);
  assert.equal(lockedOut.reason, 'scheduler_lock_busy');
  assert.equal(executorCalls, 2);
  assert.equal(plannerCalls, 1);

  fakeClient.locked = true;

  assert.equal(fakeClient.lockCalls, 4);
  assert.equal(fakeClient.unlockCalls, 3);
  assert.equal(fakeClient.released, 4);

  // Disabled startup must schedule absolutely nothing.
  const disabledTimers = [];

  const disabled = createSeedBotAutomationService({
    enabled: false,
    setTimeoutFn(fn, delay) {
      disabledTimers.push({ fn, delay });
      return disabledTimers.length;
    },
    clearTimeoutFn() {},
    logger: {
      log() {},
      error() {},
    },
  });

  assert.equal(disabled.start(), false);
  assert.equal(disabled.isRunning(), false);
  assert.equal(disabledTimers.length, 0);

  // Enabled startup uses recursive setTimeout. Execute the captured first
  // callback manually and verify that only then the next tick is scheduled.
  const loopTimers = [];
  const cleared = [];

  const loopClient = {
    async query(sql) {
      const compact = sql.replace(/\s+/g, ' ').trim();

      if (compact.startsWith('SELECT pg_try_advisory_lock')) {
        return { rows: [{ locked: false }] };
      }

      throw new Error(`unexpected_loop_sql:${compact}`);
    },
    release() {},
  };

  const loopService = createSeedBotAutomationService({
    db: {
      async getClient() {
        return loopClient;
      },
    },
    enabled: true,
    initialDelayMs: 15000,
    tickIntervalMs: 60000,
    setTimeoutFn(fn, delay) {
      const timer = {
        id: loopTimers.length + 1,
        fn,
        delay,
      };
      loopTimers.push(timer);
      return timer.id;
    },
    clearTimeoutFn(id) {
      cleared.push(id);
    },
    logger: {
      log() {},
      error() {},
    },
  });

  assert.equal(loopService.start(), true);
  assert.equal(loopService.isRunning(), true);
  assert.equal(loopTimers.length, 1);
  assert.equal(loopTimers[0].delay, 15000);

  await loopTimers[0].fn();

  assert.equal(
    loopTimers.length,
    2,
    'next timer is created only after the previous tick finishes',
  );
  assert.equal(loopTimers[1].delay, 60000);

  loopService.stop();

  assert.equal(loopService.isRunning(), false);
  assert.deepEqual(cleared, [2]);

  const fs = require('node:fs');
  const serverSource = fs.readFileSync(
    require.resolve('../src/server'),
    'utf8',
  );

  assert.match(
    serverSource,
    /createSeedBotAutomationService/,
    'server creates seed automation service',
  );
  assert.match(
    serverSource,
    /seedBotAutomationService\.start\(\)/,
    'server starts seed automation through its fail-closed gate',
  );
  assert.match(
    serverSource,
    /seedBotAutomationService\.stop\(\)/,
    'server stops seed automation before database shutdown',
  );

  console.log('seed-bot-automation: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
