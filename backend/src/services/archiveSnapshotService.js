'use strict';

// Last successful round archive, served stale while revalidate.
//
// The 90 day archive is a long Arc read (minutes when RPC is degraded). The
// last successful response is kept in memory and durably in PostgreSQL, so a
// request is answered at once from known historical data, even right after a
// deploy or restart, while at most one background read refreshes it:
//
//   known snapshot      returned immediately; when older than the freshness
//                       target, one background refresh starts
//   no snapshot at all  the one real read runs (cold bootstrap) and its
//                       success is stored
//
// Concurrent refreshes share one in flight read. A failed read is never
// stored and never replaces the previous snapshot; it only delays the next
// attempt by the freshness target so a failing RPC is not hammered. Claim
// state lives in this payload, which is why the freshness target is short.

const ARCHIVE_SNAPSHOT_FRESH_MS = 45 * 1000;

function createPostgresArchiveSnapshotStore(db) {
  return Object.freeze({
    async read(days) {
      const { rows } = await db.query(
        `SELECT payload, refreshed_at
           FROM round_archive_snapshots
          WHERE days = $1`,
        [days],
      );
      if (!rows.length) return null;
      const refreshedAt = new Date(rows[0].refreshed_at).getTime();
      if (!rows[0].payload || !Number.isFinite(refreshedAt)) return null;
      return { archive: rows[0].payload, refreshedAt };
    },

    // Atomic replace, and never with an older snapshot than the stored one.
    async write(days, { archive, refreshedAt }) {
      await db.query(
        `INSERT INTO round_archive_snapshots (days, payload, refreshed_at, updated_at)
         VALUES ($1, $2::json, $3, NOW())
         ON CONFLICT (days) DO UPDATE
           SET payload = EXCLUDED.payload,
               refreshed_at = EXCLUDED.refreshed_at,
               updated_at = NOW()
         WHERE round_archive_snapshots.refreshed_at <= EXCLUDED.refreshed_at`,
        [days, JSON.stringify(archive), new Date(refreshedAt)],
      );
    },
  });
}

function createArchiveSnapshotService({
  readRoundArchive,
  store,
  freshMs = ARCHIVE_SNAPSHOT_FRESH_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (typeof readRoundArchive !== 'function') throw new Error('archive_reader_required');
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new Error('archive_snapshot_store_required');
  }

  const memory = new Map();
  const inFlight = new Map();
  const lastAttemptAt = new Map();

  function remember(days, entry) {
    const current = memory.get(days);
    if (!current || current.refreshedAt <= entry.refreshedAt) memory.set(days, entry);
    return memory.get(days);
  }

  async function knownSnapshot(days) {
    const cached = memory.get(days);
    if (cached) return cached;
    try {
      const stored = await store.read(days);
      return stored ? remember(days, stored) : null;
    } catch (error) {
      // An unreadable store only means no durable snapshot for this request.
      logger.error('[archive-snapshot] durable read failed', error.message);
      return null;
    }
  }

  function refresh(days) {
    const pending = inFlight.get(days);
    if (pending) return pending;

    lastAttemptAt.set(days, now());
    const read = Promise.resolve()
      .then(() => readRoundArchive({ days }))
      .then(async (archive) => {
        const entry = remember(days, { archive, refreshedAt: now() });
        try {
          await store.write(days, entry);
        } catch (error) {
          // The fresh archive is still served from memory; the durable copy
          // simply stays at its previous successful version.
          logger.error('[archive-snapshot] durable write failed', error.message);
        }
        return entry;
      })
      .finally(() => {
        inFlight.delete(days);
      });

    inFlight.set(days, read);
    return read;
  }

  function refreshInBackground(days) {
    refresh(days).catch((error) => {
      logger.error('[archive-snapshot] background refresh failed', error.message);
    });
  }

  function withMeta(days, entry) {
    return {
      archive: entry.archive,
      snapshot: {
        refreshedAtIso: new Date(entry.refreshedAt).toISOString(),
        stale: now() - entry.refreshedAt >= freshMs,
        refreshing: inFlight.has(days),
      },
    };
  }

  async function getWithMeta(days) {
    const known = await knownSnapshot(days);

    if (known) {
      const stale = now() - known.refreshedAt >= freshMs;
      const attempted = lastAttemptAt.get(days);
      const attemptDue = attempted === undefined || now() - attempted >= freshMs;
      if (stale && attemptDue) refreshInBackground(days);
      return withMeta(days, known);
    }

    // Cold bootstrap: nothing known yet, so the one real read is awaited.
    const entry = await refresh(days);
    return withMeta(days, entry);
  }

  async function get(days) {
    return (await getWithMeta(days)).archive;
  }

  // Used by a client that already has a stale snapshot on screen and is
  // explicitly waiting for the authoritative replacement. A concurrent
  // background refresh is shared rather than duplicated.
  async function getFreshWithMeta(days) {
    const known = await knownSnapshot(days);
    if (known && now() - known.refreshedAt < freshMs) {
      return withMeta(days, known);
    }
    const entry = await refresh(days);
    return withMeta(days, entry);
  }

  // A lifecycle event that lands while an older refresh is already reading
  // the chain must get one post-event pass. Otherwise the in-flight read may
  // have observed the pre-settlement state and become the new "fresh" cache.
  async function refreshAfterCurrent(days) {
    const pending = inFlight.get(days);
    if (pending) {
      try {
        await pending;
      } catch {
        // The post-event refresh below is still required.
      }
    }
    return refresh(days);
  }

  return Object.freeze({
    get,
    getWithMeta,
    getFreshWithMeta,
    refresh,
    refreshAfterCurrent,
    inFlightCount: () => inFlight.size,
  });
}

module.exports = {
  ARCHIVE_SNAPSHOT_FRESH_MS,
  createArchiveSnapshotService,
  createPostgresArchiveSnapshotStore,
};
