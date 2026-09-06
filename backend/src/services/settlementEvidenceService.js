'use strict';

const crypto = require('crypto');
const db = require('../db');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeAddress(address) {
  return String(address).toLowerCase();
}

function rowToRecord(row) {
  return {
    poolAddress: row.pool_address,
    roundId: Number(row.round_id),
    slug: row.slug,
    asset: row.asset,
    direction: row.direction,
    cadence: row.cadence,
    symbol: row.symbol,
    interval: row.interval,
    observationStartAt: row.observation_start_at.toISOString(),
    observationEndAt: row.observation_end_at.toISOString(),
    resolvedPriceCents: row.resolved_price_cents,
    evidenceSha256: row.evidence_sha256,
    sourceDataSha256: row.source_data_sha256,
    canonicalEvidenceJson: row.canonical_evidence_json,
    settlementTxHash: row.settlement_tx_hash,
    createdAt: row.created_at.toISOString(),
  };
}

// Recomputes SHA-256 directly from the persisted canonical evidence TEXT --
// never from a re-serialized JSONB value -- and requires it equals the
// persisted hash. This is the one place hash integrity is authoritatively
// checked for a loaded row; every caller (settle-path idempotency and the
// read-only verification endpoint) goes through this.
function assertHashIntegrity(record) {
  const recomputed = sha256Hex(record.canonicalEvidenceJson);
  if (recomputed !== record.evidenceSha256) {
    const error = new Error('settlement_evidence_hash_mismatch');
    error.detail = { expected: record.evidenceSha256, recomputed };
    throw error;
  }
}

// The standalone resolved_price_cents column is a redundant, fast-access
// copy of the same value already embedded in the hashed canonical JSON
// (evidence.high/low.resolvedPriceCents for the row's own direction). This
// independently confirms the two never disagree -- catching, for example,
// a hypothetical bug that wrote a different value into the column than
// what was actually hashed, which assertHashIntegrity alone cannot detect
// since it only checks the JSON text against its own hash.
function assertResolvedPriceConsistency(record) {
  let parsed;
  try {
    parsed = JSON.parse(record.canonicalEvidenceJson);
  } catch {
    const error = new Error('settlement_evidence_canonical_json_unparseable');
    throw error;
  }

  const side = record.direction === 'HIGH' ? parsed.high : parsed.low;
  const embeddedResolvedPriceCents = side && String(side.resolvedPriceCents);

  if (embeddedResolvedPriceCents !== record.resolvedPriceCents) {
    const error = new Error('settlement_evidence_resolved_price_inconsistent');
    error.detail = { column: record.resolvedPriceCents, embedded: embeddedResolvedPriceCents };
    throw error;
  }
}

function assertFieldsMatch(record, expected) {
  const mismatches = [];
  if (normalizeAddress(record.poolAddress) !== normalizeAddress(expected.poolAddress)) {
    mismatches.push('poolAddress');
  }
  if (record.roundId !== expected.roundId) mismatches.push('roundId');
  if (record.slug !== expected.slug) mismatches.push('slug');
  if (record.asset !== expected.asset) mismatches.push('asset');
  if (record.direction !== expected.direction) mismatches.push('direction');
  if (record.cadence !== expected.cadence) mismatches.push('cadence');
  if (record.symbol !== expected.symbol) mismatches.push('symbol');
  if (record.interval !== expected.interval) mismatches.push('interval');
  if (record.observationStartAt !== expected.observationStartAt) mismatches.push('observationStartAt');
  if (record.observationEndAt !== expected.observationEndAt) mismatches.push('observationEndAt');

  if (mismatches.length > 0) {
    const error = new Error('settlement_evidence_integrity_conflict');
    error.detail = { mismatches };
    throw error;
  }
}

// Idempotent persist-or-load used on the settle path, immediately before
// settleRound is broadcast. First attempt inserts fresh evidence. If a row
// already exists for (poolAddress, roundId) -- a retry, another instance,
// a prior partial run -- the persisted row is loaded and validated against
// the freshly computed input instead of being overwritten. A validated
// persisted row's resolvedPriceCents is what must be used for settlement,
// never a newly re-fetched value, so a later source drift can never change
// what a round settles at once evidence has been prepared for it.
//
// Throws (never inserts, never returns a value to settle with) if:
// - a persisted row exists but its identity/window fields disagree with
//   the current input (settlement_evidence_integrity_conflict)
// - a persisted row's hash does not match its own stored canonical JSON
//   (settlement_evidence_hash_mismatch)
// - the freshly computed input's own hash does not match its own
//   canonical JSON (settlement_evidence_self_hash_mismatch) -- a defensive
//   check against a caller bug, checked before ever touching the DB
async function upsertOrValidateSettlementEvidence(input) {
  const selfRecomputed = sha256Hex(input.canonicalEvidenceJson);
  if (selfRecomputed !== input.evidenceSha256) {
    const error = new Error('settlement_evidence_self_hash_mismatch');
    error.detail = { expected: input.evidenceSha256, recomputed: selfRecomputed };
    throw error;
  }

  const insertResult = await db.query(
    `INSERT INTO settlement_evidence (
       pool_address, round_id, slug, asset, direction, cadence, symbol, interval,
       observation_start_at, observation_end_at, resolved_price_cents,
       evidence_sha256, source_data_sha256, canonical_evidence_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (pool_address, round_id) DO NOTHING
     RETURNING *`,
    [
      input.poolAddress,
      input.roundId,
      input.slug,
      input.asset,
      input.direction,
      input.cadence,
      input.symbol,
      input.interval,
      input.observationStartAt,
      input.observationEndAt,
      input.resolvedPriceCents,
      input.evidenceSha256,
      input.sourceDataSha256,
      input.canonicalEvidenceJson,
    ],
  );

  if (insertResult.rows.length > 0) {
    const record = rowToRecord(insertResult.rows[0]);
    assertHashIntegrity(record);
    assertResolvedPriceConsistency(record);
    return record;
  }

  // Conflict: evidence already existed. Load and validate it rather than
  // silently overwriting -- this is the idempotency guarantee.
  const existing = await db.query(
    `SELECT * FROM settlement_evidence WHERE pool_address = $1 AND round_id = $2`,
    [input.poolAddress, input.roundId],
  );
  if (existing.rows.length === 0) {
    // Lost a race between the failed insert and this read; safe to retry
    // the caller, but never assumed to be evidence loss.
    throw new Error('settlement_evidence_conflict_read_failed');
  }

  const record = rowToRecord(existing.rows[0]);
  assertHashIntegrity(record);
  assertResolvedPriceConsistency(record);
  assertFieldsMatch(record, input);
  return record;
}

// Read-only lookup for the verification endpoint. Returns null if no
// evidence has been persisted for this round. Throws
// settlement_evidence_hash_mismatch if the persisted row's own hash no
// longer matches its own canonical JSON (tamper/corruption detection) --
// callers must treat that as an integrity failure, never as VERIFIED.
async function getSettlementEvidence({ poolAddress, roundId }) {
  const result = await db.query(
    `SELECT * FROM settlement_evidence WHERE pool_address = $1 AND round_id = $2`,
    [poolAddress, roundId],
  );
  if (result.rows.length === 0) return null;

  const record = rowToRecord(result.rows[0]);
  assertHashIntegrity(record);
  assertResolvedPriceConsistency(record);
  return record;
}

// Best-effort, non-blocking. Evidence durability is already established
// before broadcast; the tx hash is purely supplementary and its own
// failure must never be treated as a settlement failure.
async function recordSettlementTxHash({ poolAddress, roundId, txHash }) {
  await db.query(
    `UPDATE settlement_evidence
        SET settlement_tx_hash = $3
      WHERE pool_address = $1 AND round_id = $2 AND settlement_tx_hash IS NULL`,
    [poolAddress, roundId, txHash],
  );
}

const REQUIRED_COLUMNS = Object.freeze([
  'pool_address',
  'round_id',
  'canonical_evidence_json',
  'evidence_sha256',
  'source_data_sha256',
  'resolved_price_cents',
  'settlement_tx_hash',
  'created_at',
]);

// Read-only readiness check. Confirms PostgreSQL actually has the
// settlement_evidence relation and its critical columns via
// information_schema/pg_catalog, before anything relies on it. Never
// creates or alters schema -- migrate.js remains solely responsible for
// that. Table and column presence are hard requirements and throw if
// missing; primary key shape is reported but does not throw on its own,
// matching this being explicitly a secondary ("ideally") check.
async function verifySettlementEvidenceStorage() {
  const tableResult = await db.query(
    `SELECT to_regclass('public.settlement_evidence') AS regclass`,
  );
  if (!tableResult.rows[0]?.regclass) {
    throw new Error('settlement_evidence_table_missing');
  }

  const columnResult = await db.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'settlement_evidence'`,
  );
  const presentColumns = new Set(columnResult.rows.map((row) => row.column_name));
  const missingColumns = REQUIRED_COLUMNS.filter((name) => !presentColumns.has(name));
  if (missingColumns.length > 0) {
    const error = new Error('settlement_evidence_columns_missing');
    error.detail = { missingColumns };
    throw error;
  }

  const primaryKeyResult = await db.query(
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'public.settlement_evidence'::regclass
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
  );
  const primaryKeyColumns = primaryKeyResult.rows.map((row) => row.column_name);
  const primaryKeyMatches =
    primaryKeyColumns.length === 2 &&
    primaryKeyColumns[0] === 'pool_address' &&
    primaryKeyColumns[1] === 'round_id';

  return {
    tableExists: true,
    missingColumns: [],
    primaryKeyColumns,
    primaryKeyMatches,
  };
}

module.exports = {
  upsertOrValidateSettlementEvidence,
  getSettlementEvidence,
  recordSettlementTxHash,
  verifySettlementEvidenceStorage,
};
