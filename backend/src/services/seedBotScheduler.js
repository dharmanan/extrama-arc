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

/**
 * PostgreSQL-backed scheduler state for production. Completed work survives
 * deploys/restarts. An abandoned IN_FLIGHT claim can be reclaimed only after
 * the lease expires; the live executor must still perform a fresh onchain
 * hasEntered/price/round check before any transaction is possible.
 */
function createPostgresIdempotencyStore({
  dbClient,
  inFlightLeaseSeconds = 15 * 60,
} = {}) {
  const database = dbClient || require('../db');
  const leaseSeconds = Math.max(
    60,
    Number.isFinite(Number(inFlightLeaseSeconds))
      ? Math.floor(Number(inFlightLeaseSeconds))
      : 15 * 60,
  );

  return {
    async claim(key) {
      const { rows } = await database.query(
        `INSERT INTO seed_bot_dispatches (
           plan_key,
           status,
           claimed_at,
           completed_at,
           updated_at
         )
         VALUES ($1, 'IN_FLIGHT', NOW(), NULL, NOW())
         ON CONFLICT (plan_key) DO UPDATE
           SET status = 'IN_FLIGHT',
               claimed_at = NOW(),
               completed_at = NULL,
               updated_at = NOW()
         WHERE seed_bot_dispatches.status <> 'COMPLETED'
           AND (
             seed_bot_dispatches.claimed_at IS NULL
             OR seed_bot_dispatches.claimed_at
                < NOW() - ($2::double precision * INTERVAL '1 second')
           )
         RETURNING plan_key`,
        [String(key), leaseSeconds],
      );

      return rows.length === 1;
    },

    async complete(key) {
      await database.query(
        `UPDATE seed_bot_dispatches
            SET status = 'COMPLETED',
                completed_at = NOW(),
                updated_at = NOW()
          WHERE plan_key = $1`,
        [String(key)],
      );
    },

    async release(key) {
      await database.query(
        `DELETE FROM seed_bot_dispatches
          WHERE plan_key = $1
            AND status = 'IN_FLIGHT'`,
        [String(key)],
      );
    },

    // An executor exception may have happened after a transaction broadcast.
    // Keep the claim leased instead of making it immediately retryable.
    // After the lease expires, the production executor must reconcile fresh
    // onchain state before any further broadcast is possible.
    async defer(key) {
      await database.query(
        `UPDATE seed_bot_dispatches
            SET claimed_at = NOW(),
                updated_at = NOW()
          WHERE plan_key = $1
            AND status = 'IN_FLIGHT'`,
        [String(key)],
      );
    },

    async isCompleted(key) {
      const { rows } = await database.query(
        `SELECT status
           FROM seed_bot_dispatches
          WHERE plan_key = $1
          LIMIT 1`,
        [String(key)],
      );

      return rows[0]?.status === 'COMPLETED';
    },

    async getLastDispatchAt() {
      const { rows } = await database.query(
        `SELECT EXTRACT(EPOCH FROM last_dispatch_at)::bigint AS last_dispatch_at
           FROM seed_bot_scheduler_state
          WHERE singleton_id = 1`,
      );

      return parseBigInt(rows[0]?.last_dispatch_at);
    },

    async setLastDispatchAt(value) {
      const timestamp = parseTimestamp(value);
      if (timestamp === null) {
        throw new Error('seed_scheduler_dispatch_time_invalid');
      }

      await database.query(
        `INSERT INTO seed_bot_scheduler_state (
           singleton_id,
           last_dispatch_at,
           updated_at
         )
         VALUES (1, TO_TIMESTAMP($1::double precision), NOW())
         ON CONFLICT (singleton_id) DO UPDATE
           SET last_dispatch_at = EXCLUDED.last_dispatch_at,
               updated_at = NOW()`,
        [timestamp.toString()],
      );
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

      // The spacing gate begins as soon as work is dispatched. This also
      // protects against an executor error occurring after a broadcast.
      await store.setLastDispatchAt(nowAt);

      try {
        const result = await executor.executeDueEntry(entry, { now: nowAt.toString(), idempotencyKey: key });
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
        if (typeof store.defer === 'function') {
          await store.defer(key);
        } else {
          await store.release(key);
        }
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
  createPostgresIdempotencyStore,
  createSeedBotScheduler,
  planKey,
};
