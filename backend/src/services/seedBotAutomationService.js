'use strict';

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 15 * 1000;
const DEFAULT_PLAN_REFRESH_MS = 15 * 60 * 1000;
const ADVISORY_LOCK_ID = '5042002072';
const PLANNER_VERSION = 'extrema-seed-bot-v3';

function normalizeNowMs(clock) {
  const raw = typeof clock === 'function' ? clock() : Date.now();

  if (raw instanceof Date) {
    const value = raw.getTime();
    if (Number.isFinite(value)) return value;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('seed_automation_clock_invalid');
  }

  return value;
}

function createSeedBotAutomationService({
  db = null,
  arcService = null,
  planner = null,
  loadWallets = null,
  planStoreFactory = null,
  schedulerFactory = null,
  idempotencyStoreFactory = null,
  executorFactory = null,
  topology = null,
  enabled = null,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  planRefreshMs = DEFAULT_PLAN_REFRESH_MS,
  clock = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  let running = false;
  let timer = null;
  let lastPlanAttemptAtMs = null;

  function resolveDatabase() {
    return db || require('../db');
  }

  function resolveArcService() {
    return arcService || require('./arcService');
  }

  function resolvePlanner() {
    return planner || require('./seedBotCore').createSeedBotDryRunPlan;
  }

  function resolveLoadWallets() {
    return loadWallets || require('./seedBotCore').loadApprovedSeedWallets;
  }

  function resolvePlanStoreFactory() {
    return planStoreFactory ||
      require('./seedBotPlanStore').createSeedBotPlanStore;
  }

  function resolveSchedulerFactory() {
    return schedulerFactory ||
      require('./seedBotScheduler').createSeedBotScheduler;
  }

  function resolveIdempotencyStoreFactory() {
    return idempotencyStoreFactory ||
      require('./seedBotScheduler').createPostgresIdempotencyStore;
  }

  function resolveExecutorFactory() {
    return executorFactory ||
      require('./seedBotProductionExecutor').createSeedBotProductionExecutor;
  }

  function resolveTopology(arc) {
    return topology || arc.ARC_POOL_TOPOLOGY;
  }

  function automationEnabled() {
    if (enabled !== null && enabled !== undefined) {
      return Boolean(enabled);
    }

    return Boolean(
      require('../config').EXTREMA_ENABLE_SEED_BOTS,
    );
  }

  async function withSchedulerLock(operation) {
    const database = resolveDatabase();

    if (!database || typeof database.getClient !== 'function') {
      throw new Error('seed_automation_database_unavailable');
    }

    const client = await database.getClient();
    let locked = false;

    try {
      const result = await client.query(
        `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
        [ADVISORY_LOCK_ID],
      );

      locked = Boolean(result.rows?.[0]?.locked);

      if (!locked) {
        return {
          locked: false,
          reason: 'scheduler_lock_busy',
        };
      }

      return await operation(client);
    } finally {
      if (locked) {
        try {
          await client.query(
            `SELECT pg_advisory_unlock($1::bigint)`,
            [ADVISORY_LOCK_ID],
          );
        } catch (error) {
          logger.error(
            '[seed-bot] advisory unlock failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      client.release();
    }
  }

  async function runTick() {
    return withSchedulerLock(async (client) => {
      const nowMs = normalizeNowMs(clock);
      const now = new Date(nowMs);

      const arc = resolveArcService();
      const canonicalTopology = resolveTopology(arc);
      const createPlanStore = resolvePlanStoreFactory();

      const planStore = createPlanStore({
        dbClient: client,
      });

      let entries = await planStore.loadOpenEntries({
        now,
        plannerVersion: PLANNER_VERSION,
      });

      let insertedPlans = 0;

      // Planning is retried on its own interval even while open plans exist,
      // so a pass that planned only some pools is completed later. Existing
      // same version plans are never rewritten: persistEntries inserts only
      // missing wallet, pool and round plans.
      const planRefreshDue =
        lastPlanAttemptAtMs === null ||
        nowMs - lastPlanAttemptAtMs >= planRefreshMs;

      if (planRefreshDue) {
        lastPlanAttemptAtMs = nowMs;

        const roundsState =
          await arc.getStandardRoundsState({
            forceFresh: true,
          });

        const wallets =
          await resolveLoadWallets()({
            dbClient: client,
          });

        // Planning uses nominal funding only. Actual USDC and native balance
        // are re-read from Arc immediately before every potential broadcast.
        const plan = await resolvePlanner()({
          wallets,
          dbClient: client,
          topology: canonicalTopology,
          roundsState,
          fundingByWallet: () => ({
            usdcRaw: '100000000',
            nativeUsdcRaw: '1000000000000000000',
            requiredGasRaw: '1',
          }),
          requiredGasRaw: '1',
          seed: PLANNER_VERSION,
          now: roundsState?.chain?.timestamp,
        });

        const persisted =
          await planStore.persistEntries(
            plan.executableEntries,
          );

        insertedPlans = persisted.inserted;

        entries = await planStore.loadOpenEntries({
          now,
          plannerVersion: PLANNER_VERSION,
        });
      }

      if (entries.length === 0) {
        return {
          locked: true,
          planned: insertedPlans,
          openPlans: 0,
          dispatched: false,
          reason: planRefreshDue
            ? 'no_open_seed_plan'
            : 'plan_refresh_cooldown',
        };
      }

      const createStore =
        resolveIdempotencyStoreFactory();

      const createExecutor =
        resolveExecutorFactory();

      const createScheduler =
        resolveSchedulerFactory();

      const store = createStore({
        dbClient: client,
      });

      const executor = createExecutor({
        dbClient: client,
        topology: canonicalTopology,
      });

      const scheduler = createScheduler({
        executor,
        store,
      });

      const result = await scheduler.tick({
        entries,
        now: Math.floor(nowMs / 1000),
      });

      return {
        locked: true,
        planned: insertedPlans,
        openPlans: entries.length,
        ...result,
      };
    });
  }

  async function loop() {
    if (!running) return;

    try {
      const result = await runTick();

      if (result?.dispatched) {
        logger.log(
          '[seed-bot] dispatch',
          JSON.stringify({
            key: result.idempotencyKey || null,
            pool: result.entry?.pool || null,
            wallet: result.entry?.wallet || null,
            executed: result.result?.executed || false,
            reason:
              result.result?.reason ||
              result.error ||
              null,
          }),
        );
      }
    } catch (error) {
      logger.error(
        '[seed-bot] tick failed',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (running) {
        timer = setTimeoutFn(loop, tickIntervalMs);
      }
    }
  }

  function start() {
    if (running) return false;

    if (!automationEnabled()) {
      logger.log('[seed-bot] automation disabled');
      return false;
    }

    running = true;
    timer = setTimeoutFn(loop, initialDelayMs);

    logger.log(
      `[seed-bot] automation enabled; tick=${tickIntervalMs}ms`,
    );

    return true;
  }

  function stop() {
    running = false;

    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  return Object.freeze({
    runTick,
    start,
    stop,
    isRunning: () => running,
  });
}

module.exports = {
  ADVISORY_LOCK_ID,
  PLANNER_VERSION,
  createSeedBotAutomationService,
};
