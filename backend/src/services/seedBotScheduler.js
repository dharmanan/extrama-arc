'use strict';

const { participationKey } = require('./seedBotCore');

const DEFAULT_MIN_GLOBAL_SPACING_SECONDS = 5 * 60;

function parseBigInt(value) {
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return BigInt(Math.floor(parsed / 1000));
  }
  return null;
}

function planKey(entry) {
  return participationKey(entry.wallet, entry.poolAddress, entry.roundId);
}

/**
 * Small persistence adapter. A production integration can back the same
 * methods with a durable DB row; tests can share this object across scheduler
 * instances to model a process restart without changing the schema here.
 */
function createIdempotencyStore(state = {}) {
  const completed = state.completed instanceof Set ? state.completed : new Set(state.completed || []);
  const inFlight = state.inFlight instanceof Set ? state.inFlight : new Set(state.inFlight || []);
  let lastDispatchAt = parseBigInt(state.lastDispatchAt);
  // Keep the caller-owned state object updated so a fresh store created after
  // a process restart observes completed keys and the spacing gate.
  state.completed = completed;
  state.inFlight = inFlight;
  state.lastDispatchAt = lastDispatchAt?.toString() || null;

  return {
    async claim(key) {
      if (completed.has(key) || inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    async complete(key) {
      inFlight.delete(key);
      completed.add(key);
    },
    async release(key) {
      inFlight.delete(key);
    },
    async isCompleted(key) {
      return completed.has(key);
    },
    async getLastDispatchAt() {
      return lastDispatchAt;
    },
    async setLastDispatchAt(value) {
      lastDispatchAt = parseBigInt(value);
      state.lastDispatchAt = lastDispatchAt?.toString() || null;
    },
    snapshot() {
      return {
        completed: [...completed],
        inFlight: [...inFlight],
        lastDispatchAt: lastDispatchAt?.toString() || null,
      };
    },
  };
}

function normalizeNow(now, clock) {
  if (now !== undefined && now !== null) return parseTimestamp(now);
  const value = typeof clock === 'function' ? clock() : Math.floor(Date.now() / 1000);
  return parseTimestamp(value);
}

function dueTimestamp(entry) {
  return parseTimestamp(entry?.plannedExecutionAt);
}

function closeTimestamp(entry) {
  return parseTimestamp(entry?.entryCloseAt);
}

function stableDueEntries(entries, nowAt) {
  return entries
    .filter((entry) => entry?.eligible && !entry.alreadyEntered)
    .map((entry) => ({ entry, plannedAt: dueTimestamp(entry) }))
    .filter((item) => item.plannedAt !== null && item.plannedAt <= nowAt)
    .sort((left, right) => {
      if (left.plannedAt !== right.plannedAt) return left.plannedAt < right.plannedAt ? -1 : 1;
      return planKey(left.entry).localeCompare(planKey(right.entry));
    });
}

/**
 * One explicit tick, never a timer. It dispatches at most one due entry and
 * persists both idempotency and the last dispatch time so overdue work cannot
 * burst after a restart. No transaction policy is duplicated here; the
 * injected execution service owns the one-entry interface and live checks.
 */
function createSeedBotScheduler({
  executor,
  store = createIdempotencyStore(),
  minGlobalSpacingSeconds = DEFAULT_MIN_GLOBAL_SPACING_SECONDS,
  clock,
} = {}) {
  if (!executor || typeof executor.executeDueEntry !== 'function') {
    throw new Error('seed_scheduler_executor_required');
  }

  const spacing = Math.max(0, Number(minGlobalSpacingSeconds));

  async function tick({ entries = [], now } = {}) {
    const nowAt = normalizeNow(now, clock);
    if (nowAt === null) return { dispatched: false, reason: 'scheduler_time_invalid' };

    const lastDispatchAt = await store.getLastDispatchAt();
    if (lastDispatchAt !== null && nowAt < lastDispatchAt + BigInt(spacing)) {
      return {
        dispatched: false,
        reason: 'global_spacing',
        nextEligibleAt: (lastDispatchAt + BigInt(spacing)).toString(),
      };
    }

    const due = stableDueEntries(entries, nowAt);
    for (const item of due) {
      const entry = item.entry;
      const key = planKey(entry);
      if (await store.isCompleted(key)) continue;

      const closeAt = closeTimestamp(entry);
      if (closeAt !== null && nowAt >= closeAt) {
        await store.complete(key);
        continue;
      }

      if (!(await store.claim(key))) continue;

      try {
        const result = await executor.executeDueEntry(entry, { now: nowAt.toString(), idempotencyKey: key });
        await store.setLastDispatchAt(nowAt);
        // A completed onchain entry or an explicit idempotent/safety skip is
        // terminal for this planned work item. A future integration can return
        // retryable:true to release it without declaring completion.
        if (!result?.retryable) await store.complete(key);
        else await store.release(key);
        return {
          dispatched: true,
          idempotencyKey: key,
          entry,
          result,
          overdue: nowAt > item.plannedAt,
        };
      } catch (error) {
        await store.release(key);
        return {
          dispatched: true,
          idempotencyKey: key,
          entry,
          error: error instanceof Error ? error.message : String(error),
          overdue: nowAt > item.plannedAt,
        };
      }
    }

    return { dispatched: false, reason: 'no_due_entry' };
  }

  return Object.freeze({
    minGlobalSpacingSeconds: spacing,
    tick,
    planKey,
    store,
  });
}

module.exports = {
  DEFAULT_MIN_GLOBAL_SPACING_SECONDS,
  createIdempotencyStore,
  createSeedBotScheduler,
  planKey,
};
