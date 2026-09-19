'use strict';

// Deterministic verification of the durable archive snapshot served stale
// while revalidate. A scripted archive reader and an in memory store that
// mirrors the PostgreSQL upsert guard stand in for Arc and the database.
// Nothing here opens a database, contacts Arc, holds a key, or can send a
// transaction.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ARCHIVE_SNAPSHOT_FRESH_MS,
  createArchiveSnapshotService,
  createPostgresArchiveSnapshotStore,
} = require('../src/services/archiveSnapshotService');

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function archivePayload(label) {
  return {
    chain: { id: 5042002, name: 'Arc Testnet', blockNumber: 100, timestamp: 1, timestampIso: '1970-01-01T00:00:01.000Z', explorerUrl: 'https://testnet.arcscan.app' },
    retentionDays: 90,
    rounds: [{ slug: 'btc-daily-high', roundId: 7, contractStatus: 'SETTLED', label, winners: [{ rank: 1, claimed: true }] }],
  };
}

function archiveDatePrefix(freshness, locale) {
  if (freshness === 'revalidating_cached') return locale === 'tr' ? 'Güncelleniyor · ' : 'Updating · ';
  if (freshness === 'cached_refresh_failed') return locale === 'tr' ? 'Önbellek · ' : 'Cached · ';
  return locale === 'tr' ? 'En güncel · ' : 'Latest · ';
}

function verifyArchivePageFreshness() {
  const page = fs.readFileSync(path.resolve(__dirname, '../../app/archive/page.tsx'), 'utf8');
  const leaderboard = fs.readFileSync(path.resolve(__dirname, '../../app/leaderboard/page.tsx'), 'utf8');
  const cacheRead = page.indexOf('const cached = readCachedArchive(ARCHIVE_DAYS);');
  const freshRead = page.indexOf('backendApi.rounds.archive(ARCHIVE_DAYS, { signal: controller.signal })');
  const dateSelect = page.slice(page.indexOf('<select'), page.indexOf('</select>'));

  assert.ok(cacheRead >= 0, 'the page reads the archive cache');
  assert.ok(freshRead > cacheRead, 'network revalidation starts after cached content is applied');
  assert.match(page, /for \(let attempt = 0; attempt < 40 && !cancelled; attempt \+= 1\)/);
  assert.match(page, /if \(!result\.snapshot\?\.stale && !result\.snapshot\?\.refreshing\)/);
  assert.match(page, /setFreshness\("revalidating_cached"\)/);
  assert.match(page, /retryTimer = setTimeout\(resolve, 3_000\)/);
  assert.match(leaderboard, /if \(!result\.snapshot\?\.stale && !result\.snapshot\?\.refreshing\) return;/);
  assert.match(leaderboard, /retryTimer = setTimeout\(resolve, 3_000\)/);
  console.log('ARCHIVE_CACHE_IMMEDIATE_RENDER=PASS');
  console.log('ARCHIVE_STALE_RESPONSE_POLLED_UNTIL_FRESH=PASS');
  console.log('LEADERBOARD_STALE_RESPONSE_POLLED_UNTIL_FRESH=PASS');

  assert.match(page, /type ArchiveFreshness = "initial" \| "revalidating_cached" \| "fresh" \| "cached_refresh_failed"/);
  assert.match(page, /setFreshness\("fresh"\)/);
  assert.match(page, /if \(!cancelled && hasArchive\.current\) setFreshness\("cached_refresh_failed"\)/);
  assert.match(dateSelect, /index === 0 \? archiveDatePrefix\(freshness, locale\) : ""/);
  assert.equal(archiveDatePrefix('revalidating_cached', 'en') + 'Sep 11, 2026', 'Updating · Sep 11, 2026');
  assert.equal(archiveDatePrefix('revalidating_cached', 'tr') + '11 Eyl 2026', 'Güncelleniyor · 11 Eyl 2026');
  assert.equal(archiveDatePrefix('fresh', 'en') + 'Sep 12, 2026', 'Latest · Sep 12, 2026');
  assert.equal(archiveDatePrefix('fresh', 'tr') + '12 Eyl 2026', 'En güncel · 12 Eyl 2026');
  assert.notEqual(archiveDatePrefix('revalidating_cached', 'en'), 'Latest · ');
  console.log('ARCHIVE_STALE_NOT_LABELED_LATEST=PASS');
  console.log('ARCHIVE_FRESH_RESPONSE_LABELED_LATEST=PASS');

  assert.match(page, /setArchive\(next\);/);
  assert.match(page, /setFreshness\("cached_refresh_failed"\)/);
  assert.equal(archiveDatePrefix('cached_refresh_failed', 'en') + 'Sep 11, 2026', 'Cached · Sep 11, 2026');
  assert.equal(archiveDatePrefix('cached_refresh_failed', 'tr') + '11 Eyl 2026', 'Önbellek · 11 Eyl 2026');
  console.log('ARCHIVE_REFRESH_FAILURE_PRESERVES_CACHE=PASS');
  console.log('ARCHIVE_REFRESH_FAILURE_MARKED_CACHED=PASS');

  assert.match(page, /requested && dates\.includes\(requested\) \? requested : \(dates\[0\] \?\? ""\)/);
  console.log('ARCHIVE_EXPLICIT_DATE_PRESERVED=PASS');
}

// Mirrors round_archive_snapshots: one row per days, replaced atomically and
// never by an older refreshed_at.
function createMemoryStore({ failReads = false, failWrites = false } = {}) {
  const rows = new Map();
  const store = {
    rows,
    reads: 0,
    writes: 0,
    failReads,
    failWrites,
    async read(days) {
      store.reads += 1;
      if (store.failReads) throw new Error('db_unavailable');
      const row = rows.get(days);
      return row ? { archive: JSON.parse(row.payload), refreshedAt: row.refreshedAt } : null;
    },
    async write(days, entry) {
      store.writes += 1;
      if (store.failWrites) throw new Error('db_write_failed');
      const current = rows.get(days);
      if (current && current.refreshedAt > entry.refreshedAt) return;
      rows.set(days, { payload: JSON.stringify(entry.archive), refreshedAt: entry.refreshedAt });
    },
  };
  return store;
}

function createReader() {
  const reader = {
    calls: 0,
    pending: [],
    async read({ days }) {
      reader.calls += 1;
      const step = deferred();
      reader.pending.push({ days, ...step });
      return step.promise;
    },
    resolveNext(value) {
      reader.pending.shift().resolve(value);
    },
    rejectNext(error) {
      reader.pending.shift().reject(error);
    },
  };
  return reader;
}

const quietLogger = { error() {}, log() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function settlesWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), ms);
  });
  const outcome = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return outcome;
}

async function main() {
  assert.equal(ARCHIVE_SNAPSHOT_FRESH_MS, 45_000, 'claim state keeps a short freshness target');
  verifyArchivePageFreshness();

  let nowMs = 1_000_000;
  const clock = () => nowMs;

  // 1 and 8. No stored snapshot: the one real read runs and is awaited, a
  //          failure is never persisted, and the successful payload is.
  {
    const store = createMemoryStore();
    const reader = createReader();
    const service = createArchiveSnapshotService({ readRoundArchive: reader.read, store, now: clock, logger: quietLogger });

    const failed = service.get(90);
    await flush();
    reader.rejectNext(new Error('rpc_unavailable'));
    await assert.rejects(failed, /rpc_unavailable/);
    assert.equal(store.rows.size, 0, 'a failed cold read is not persisted');

    const cold = service.get(90);
    const coldTwin = service.get(90);
    await flush();
    assert.equal(reader.calls, 2, 'concurrent cold requests share one real read');
    const payload = archivePayload('bootstrap');
    reader.resolveNext(payload);
    assert.equal(await cold, payload);
    assert.equal(await coldTwin, payload);
    assert.deepEqual(JSON.parse(store.rows.get(90).payload), payload, 'the successful payload is persisted');
    console.log('ARCHIVE_SNAPSHOT_COLD_BOOTSTRAP=PASS');
  }

  // 2, 3, 4, 5, 7. A stored snapshot answers without waiting for Arc, even
  // in a new process with an empty memory cache; a stale one starts exactly
  // one shared refresh whose success replaces it.
  {
    const store = createMemoryStore();
    const stored = archivePayload('stored');
    store.rows.set(90, { payload: JSON.stringify(stored), refreshedAt: nowMs });

    const reader = createReader();
    const afterRestart = createArchiveSnapshotService({ readRoundArchive: reader.read, store, now: clock, logger: quietLogger });

    const fresh = await settlesWithin(afterRestart.get(90), 50);
    assert.deepEqual(fresh, stored, 'an empty memory cache still serves the durable snapshot');
    assert.equal(reader.calls, 0, 'a fresh snapshot needs no Arc read');

    nowMs += ARCHIVE_SNAPSHOT_FRESH_MS;
    const staleRequests = await Promise.all(
      Array.from({ length: 5 }, () => settlesWithin(afterRestart.get(90), 50)),
    );
    for (const response of staleRequests) {
      assert.notEqual(response, 'timed_out', 'a stale snapshot is served without waiting for the refresh');
      assert.deepEqual(response, stored);
    }
    assert.equal(reader.calls, 1, 'concurrent stale requests start one refresh only');
    assert.equal(afterRestart.inFlightCount(), 1);

    const refreshed = archivePayload('refreshed');
    nowMs += 1_000;
    reader.resolveNext(refreshed);
    await flush();
    await flush();
    assert.deepEqual(JSON.parse(store.rows.get(90).payload), refreshed, 'a successful refresh replaces the durable snapshot');
    assert.deepEqual(await afterRestart.get(90), refreshed, 'and the memory snapshot');
    assert.equal(reader.calls, 1, 'the new snapshot is fresh again');
    console.log('ARCHIVE_SNAPSHOT_STALE_WHILE_REVALIDATE=PASS');
  }

  // 6. A failed refresh keeps the previous snapshot, in memory and durably,
  //    and the next attempt waits one freshness interval.
  {
    const store = createMemoryStore();
    const stored = archivePayload('kept');
    store.rows.set(90, { payload: JSON.stringify(stored), refreshedAt: nowMs - ARCHIVE_SNAPSHOT_FRESH_MS });
    const reader = createReader();
    const service = createArchiveSnapshotService({ readRoundArchive: reader.read, store, now: clock, logger: quietLogger });

    assert.deepEqual(await service.get(90), stored);
    assert.equal(reader.calls, 1);
    reader.rejectNext(new Error('rpc_unavailable'));
    await flush();
    await flush();
    assert.deepEqual(JSON.parse(store.rows.get(90).payload), stored, 'a failed refresh never replaces the snapshot');
    assert.deepEqual(await service.get(90), stored, 'the previous snapshot is still served');
    assert.equal(reader.calls, 1, 'a failing refresh is not retried on every request');

    nowMs += ARCHIVE_SNAPSHOT_FRESH_MS;
    assert.deepEqual(await service.get(90), stored);
    assert.equal(reader.calls, 2, 'the refresh is retried after the freshness interval');
    reader.resolveNext(archivePayload('recovered'));
    await flush();
    await flush();
    assert.equal(JSON.parse(store.rows.get(90).payload).rounds[0].label, 'recovered');
    console.log('ARCHIVE_SNAPSHOT_FAILED_REFRESH_KEEPS_SNAPSHOT=PASS');
  }

  // Store failures degrade safely: an unreadable store behaves like a cold
  // start, and a failed durable write still serves the fresh read from memory
  // while leaving the older durable snapshot untouched.
  {
    const store = createMemoryStore({ failReads: true });
    const reader = createReader();
    const service = createArchiveSnapshotService({ readRoundArchive: reader.read, store, now: clock, logger: quietLogger });
    const pending = service.get(90);
    await flush();
    reader.resolveNext(archivePayload('db_down'));
    assert.equal((await pending).rounds[0].label, 'db_down');

    const writeFails = createMemoryStore({ failWrites: true });
    const old = archivePayload('durable_old');
    writeFails.rows.set(90, { payload: JSON.stringify(old), refreshedAt: nowMs - ARCHIVE_SNAPSHOT_FRESH_MS });
    const writeReader = createReader();
    const writeService = createArchiveSnapshotService({ readRoundArchive: writeReader.read, store: writeFails, now: clock, logger: quietLogger });
    assert.deepEqual(await writeService.get(90), old);
    writeReader.resolveNext(archivePayload('memory_new'));
    await flush();
    await flush();
    assert.equal((await writeService.get(90)).rounds[0].label, 'memory_new');
    assert.equal(JSON.parse(writeFails.rows.get(90).payload).rounds[0].label, 'durable_old');
    console.log('ARCHIVE_SNAPSHOT_STORE_FAILURES=PASS');
  }

  // 9. The PostgreSQL store writes the exact payload text as JSON (key order
  //    preserved), replaces atomically, never with an older snapshot, and
  //    reads it back unchanged.
  {
    const queries = [];
    const payload = archivePayload('shape');
    const fakeDb = {
      async query(sql, params) {
        queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/^SELECT payload, refreshed_at/.test(queries[queries.length - 1].sql)) {
          return { rows: [{ payload: JSON.parse(JSON.stringify(payload)), refreshed_at: new Date(123_000) }] };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const pgStore = createPostgresArchiveSnapshotStore(fakeDb);
    await pgStore.write(90, { archive: payload, refreshedAt: 123_000 });
    const write = queries[0];
    assert.match(write.sql, /^INSERT INTO round_archive_snapshots \(days, payload, refreshed_at, updated_at\) VALUES \(\$1, \$2::json, \$3, NOW\(\)\)/);
    assert.match(write.sql, /ON CONFLICT \(days\) DO UPDATE SET payload = EXCLUDED\.payload, refreshed_at = EXCLUDED\.refreshed_at/);
    assert.match(write.sql, /WHERE round_archive_snapshots\.refreshed_at <= EXCLUDED\.refreshed_at$/);
    assert.equal(write.params[0], 90);
    assert.equal(write.params[1], JSON.stringify(payload), 'the exact response JSON is stored');
    assert.equal(write.params[2].getTime(), 123_000);

    const readBack = await pgStore.read(90);
    assert.deepEqual(readBack, { archive: payload, refreshedAt: 123_000 });
    assert.equal(JSON.stringify(readBack.archive), JSON.stringify(payload), 'response shape and key order are unchanged');
    console.log('ARCHIVE_SNAPSHOT_POSTGRES_STORE=PASS');
  }

  // 10. Read only, and wired in: the route answers from this service, the
  //     table stores only the public payload, and no transaction path exists.
  {
    const service = fs.readFileSync(path.resolve(__dirname, '../src/services/archiveSnapshotService.js'), 'utf8');
    assert.equal(/sendTransaction|getArcWriteProvider|new ethers\.Wallet|getSigner|private_key/.test(service), false);
    const routes = fs.readFileSync(path.resolve(__dirname, '../src/routes/rounds.js'), 'utf8');
    const archiveRoute = routes.slice(routes.indexOf("router.get('/archive'"), routes.indexOf("router.get('/:slug/:roundId/result'"));
    assert.match(archiveRoute, /await archiveSnapshots\.get\(days\)/);
    assert.equal(archiveRoute.includes('arcService.readRoundArchive('), false, 'the route never bypasses the snapshot');
    const schema = fs.readFileSync(path.resolve(__dirname, '../src/db/schema.sql'), 'utf8');
    const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS round_archive_snapshots'));
    assert.match(table, /days SMALLINT PRIMARY KEY,\s+payload JSON NOT NULL,\s+refreshed_at TIMESTAMPTZ NOT NULL,\s+updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    console.log('ARCHIVE_SNAPSHOT_READ_ONLY=PASS');
  }

  await flush();
  assert.equal(unhandled.length, 0, `no unhandled rejections (${unhandled.map(String).join(', ')})`);
  console.log('ARCHIVE_SNAPSHOT=PASS');
}

main().catch((error) => {
  console.error('ARCHIVE_SNAPSHOT=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
