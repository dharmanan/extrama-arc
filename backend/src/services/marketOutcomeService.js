'use strict';

const crypto = require('crypto');
const db = require('../db');
const { resolveExtremaWindow } = require('./binanceResolverService');

const SYMBOLS = Object.freeze({
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  HYPE: 'HYPEUSDT',
});

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toIso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function rowToRecord(row) {
  return {
    asset: row.asset,
    cadence: row.cadence,
    symbol: row.symbol,
    interval: row.interval,
    marketPeriodStartAt: row.market_period_start_at.toISOString(),
    marketPeriodEndAt: row.market_period_end_at.toISOString(),
    high: {
      exact: row.high_exact,
      resolvedPriceCents: String(row.high_price_cents),
      candleOpenIso: row.high_candle_open_at.toISOString(),
    },
    low: {
      exact: row.low_exact,
      resolvedPriceCents: String(row.low_price_cents),
      candleOpenIso: row.low_candle_open_at.toISOString(),
    },
    candleCount: Number(row.candle_count),
    source: row.source,
    endpoint: row.endpoint,
    sourceDataSha256: row.source_data_sha256,
    evidenceSha256: row.evidence_sha256,
    canonicalEvidenceJson: row.canonical_evidence_json,
    computedAt: row.computed_at.toISOString(),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
  };
}

function assertIntegrity(record) {
  const recomputed = sha256Hex(record.canonicalEvidenceJson);
  if (recomputed !== record.evidenceSha256) {
    const error = new Error('market_outcome_evidence_hash_mismatch');
    error.detail = { expected: record.evidenceSha256, recomputed };
    throw error;
  }
}

async function getMarketOutcome({ asset, cadence, marketPeriodStartAt, marketPeriodEndAt }) {
  const result = await db.query(
    `SELECT * FROM market_outcomes
      WHERE asset = $1
        AND cadence = $2
        AND market_period_start_at = $3
        AND market_period_end_at = $4
      LIMIT 1`,
    [asset, cadence, marketPeriodStartAt, marketPeriodEndAt],
  );
  if (!result.rows.length) return null;
  const record = rowToRecord(result.rows[0]);
  assertIntegrity(record);
  return record;
}

async function ensureMarketOutcome({
  asset,
  cadence,
  marketPeriodStartAt,
  marketPeriodEndAt,
}) {
  const symbol = SYMBOLS[asset];
  if (!symbol) throw new Error('market_outcome_asset_unsupported');

  const startIso = typeof marketPeriodStartAt === 'string'
    ? marketPeriodStartAt
    : toIso(marketPeriodStartAt);
  const endIso = typeof marketPeriodEndAt === 'string'
    ? marketPeriodEndAt
    : toIso(marketPeriodEndAt);

  const existing = await getMarketOutcome({
    asset,
    cadence,
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
  });
  if (existing) return { record: existing, created: false };

  const resolved = await resolveExtremaWindow({
    symbol,
    cadence,
    // Legacy resolver parameter names only. These values are the canonical
    // market period, not contract observation fields.
    observationStartAt: startIso,
    observationEndAt: endIso,
  });

  const insert = await db.query(
    `INSERT INTO market_outcomes (
       asset, cadence, symbol, interval,
       market_period_start_at, market_period_end_at,
       high_exact, high_price_cents, high_candle_open_at,
       low_exact, low_price_cents, low_candle_open_at,
       candle_count, source, endpoint,
       source_data_sha256, evidence_sha256, canonical_evidence_json,
       published_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW()
     )
     ON CONFLICT (asset, cadence, market_period_start_at, market_period_end_at)
     DO NOTHING
     RETURNING *`,
    [
      asset,
      cadence,
      symbol,
      resolved.interval,
      startIso,
      endIso,
      resolved.high.exact,
      resolved.high.resolvedPriceCents,
      resolved.high.candleOpenIso,
      resolved.low.exact,
      resolved.low.resolvedPriceCents,
      resolved.low.candleOpenIso,
      resolved.candleCount,
      resolved.source,
      resolved.endpoint,
      resolved.sourceDataSha256,
      resolved.evidenceSha256,
      resolved.canonicalEvidenceJson,
    ],
  );

  const record = insert.rows.length
    ? rowToRecord(insert.rows[0])
    : await getMarketOutcome({
        asset,
        cadence,
        marketPeriodStartAt: startIso,
        marketPeriodEndAt: endIso,
      });

  if (!record) throw new Error('market_outcome_persist_failed');
  assertIntegrity(record);

  if (
    record.high.resolvedPriceCents !== resolved.high.resolvedPriceCents ||
    record.low.resolvedPriceCents !== resolved.low.resolvedPriceCents ||
    record.evidenceSha256 !== resolved.evidenceSha256
  ) {
    throw new Error('market_outcome_integrity_conflict');
  }

  return { record, created: insert.rows.length > 0 };
}

async function listMarketOutcomes({ since, cadence = null } = {}) {
  const params = [];
  const where = [];
  if (since) {
    params.push(since);
    where.push(`market_period_end_at >= $${params.length}`);
  }
  if (cadence) {
    params.push(cadence);
    where.push(`cadence = $${params.length}`);
  }
  const result = await db.query(
    `SELECT * FROM market_outcomes
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY market_period_end_at DESC, cadence, asset`,
    params,
  );
  return result.rows.map((row) => {
    const record = rowToRecord(row);
    assertIntegrity(record);
    return record;
  });
}

async function verifyMarketOutcomeStorage() {
  const result = await db.query(
    `SELECT to_regclass('public.market_outcomes') AS regclass`,
  );
  if (!result.rows[0]?.regclass) throw new Error('market_outcomes_table_missing');
  return { tableExists: true };
}

module.exports = {
  SYMBOLS,
  ensureMarketOutcome,
  getMarketOutcome,
  listMarketOutcomes,
  verifyMarketOutcomeStorage,
};
