'use strict';

const crypto = require('crypto');
const db = require('../db');
const {
  fetchDailyMarkPriceCandle,
  calculateExtrema,
} = require('./binanceResolverService');
const {
  DAY_MS,
  marketDateToWindow,
  previousUtcDayWindow,
  aggregateDailyOutcomes,
} = require('./marketArchiveCore');

const SYMBOLS = Object.freeze({
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  HYPE: 'HYPEUSDT',
});

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toIso(value) {
  if (typeof value === 'string') return new Date(value).toISOString();
  if (typeof value === 'bigint') return new Date(Number(value) * 1000).toISOString();
  if (typeof value === 'number') {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  throw new Error('market_period_timestamp_invalid');
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
      candleOpenTime: row.high_candle_open_at.getTime(),
      candleOpenIso: row.high_candle_open_at.toISOString(),
    },
    low: {
      exact: row.low_exact,
      resolvedPriceCents: String(row.low_price_cents),
      candleOpenTime: row.low_candle_open_at.getTime(),
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

function archiveRowToRecord(row) {
  const candlesJson = row.candles_json;
  const recomputed = sha256Hex(candlesJson);
  if (recomputed !== row.source_data_sha256) {
    throw new Error('daily_market_archive_hash_mismatch');
  }

  const candles = JSON.parse(candlesJson);
  const candleCount = Number(row.candle_count);

  if (!Array.isArray(candles) || candles.length !== candleCount) {
    throw new Error('daily_market_archive_candle_count_mismatch');
  }

  if (
    (row.interval === '1d' && candleCount !== 1) ||
    (row.interval === '1m' && candleCount !== 1440) ||
    !['1d', '1m'].includes(row.interval)
  ) {
    throw new Error('daily_market_archive_interval_invalid');
  }

  return {
    asset: row.asset,
    symbol: row.symbol,
    interval: row.interval,
    marketPeriodStartAt: row.market_period_start_at.toISOString(),
    marketPeriodEndAt: row.market_period_end_at.toISOString(),
    candleCount,
    candles,
    candlesJson,
    source: row.source,
    endpoint: row.endpoint,
    sourceDataSha256: row.source_data_sha256,
    fetchedAt: row.fetched_at.toISOString(),
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
    [asset, cadence, toIso(marketPeriodStartAt), toIso(marketPeriodEndAt)],
  );
  if (!result.rows.length) return null;
  const record = rowToRecord(result.rows[0]);
  assertIntegrity(record);
  return record;
}

async function getDailyMarketArchive({ asset, marketPeriodStartAt, marketPeriodEndAt }) {
  const result = await db.query(
    `SELECT * FROM daily_market_archives
      WHERE asset = $1
        AND market_period_start_at = $2
        AND market_period_end_at = $3
      LIMIT 1`,
    [asset, toIso(marketPeriodStartAt), toIso(marketPeriodEndAt)],
  );
  return result.rows.length ? archiveRowToRecord(result.rows[0]) : null;
}

async function persistDailyMarketArchive({
  asset,
  symbol,
  marketPeriodStartAt,
  marketPeriodEndAt,
  windowData,
}) {
  const candlesJson = JSON.stringify(windowData.candles);
  const sourceDataSha256 = sha256Hex(candlesJson);

  if (sourceDataSha256 !== windowData.sourceDataSha256) {
    throw new Error('daily_market_archive_source_hash_mismatch');
  }
  if (windowData.interval !== '1d' || windowData.candles.length !== 1) {
    throw new Error('daily_market_archive_expected_single_1d_candle');
  }

  const insert = await db.query(
    `INSERT INTO daily_market_archives (
       asset, symbol,
       market_period_start_at, market_period_end_at,
       interval, candle_count, candles_json,
       source, endpoint, source_data_sha256
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (asset, market_period_start_at, market_period_end_at)
     DO NOTHING
     RETURNING *`,
    [
      asset,
      symbol,
      toIso(marketPeriodStartAt),
      toIso(marketPeriodEndAt),
      windowData.interval,
      windowData.candles.length,
      candlesJson,
      windowData.source,
      windowData.endpoint,
      sourceDataSha256,
    ],
  );

  if (insert.rows.length) return archiveRowToRecord(insert.rows[0]);

  const existing = await getDailyMarketArchive({
    asset,
    marketPeriodStartAt,
    marketPeriodEndAt,
  });
  if (!existing) throw new Error('daily_market_archive_persist_failed');

  if (
    existing.interval !== windowData.interval ||
    existing.sourceDataSha256 !== sourceDataSha256
  ) {
    throw new Error('daily_market_archive_conflict');
  }

  return existing;
}

async function persistMarketOutcome({
  asset,
  cadence,
  symbol,
  interval,
  marketPeriodStartAt,
  marketPeriodEndAt,
  high,
  low,
  candleCount,
  source,
  endpoint,
  sourceDataSha256,
  canonicalEvidenceJson,
  evidenceSha256,
}) {
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
      interval,
      toIso(marketPeriodStartAt),
      toIso(marketPeriodEndAt),
      high.exact,
      high.resolvedPriceCents,
      high.candleOpenIso,
      low.exact,
      low.resolvedPriceCents,
      low.candleOpenIso,
      candleCount,
      source,
      endpoint,
      sourceDataSha256,
      evidenceSha256,
      canonicalEvidenceJson,
    ],
  );

  const record = insert.rows.length
    ? rowToRecord(insert.rows[0])
    : await getMarketOutcome({
        asset,
        cadence,
        marketPeriodStartAt,
        marketPeriodEndAt,
      });

  if (!record) throw new Error('market_outcome_persist_failed');
  assertIntegrity(record);

  if (
    record.evidenceSha256 !== evidenceSha256 ||
    record.sourceDataSha256 !== sourceDataSha256
  ) {
    throw new Error('market_outcome_conflict');
  }

  return { record, created: insert.rows.length > 0 };
}

function buildEvidence({
  source,
  endpoint,
  symbol,
  cadence,
  interval,
  marketPeriodStartAt,
  marketPeriodEndAt,
  candleCount,
  sourceDataSha256,
  high,
  low,
  dailyEvidenceHashes = null,
}) {
  const evidence = {
    source,
    endpoint,
    symbol,
    cadence,
    interval,
    marketPeriod: {
      startInclusive: toIso(marketPeriodStartAt),
      endExclusive: toIso(marketPeriodEndAt),
    },
    candleCount,
    sourceDataSha256,
    rounding: 'nearest cent, half up',
    high,
    low,
    ...(dailyEvidenceHashes ? { dailyEvidenceHashes } : {}),
  };
  const canonicalEvidenceJson = JSON.stringify(evidence);
  return {
    canonicalEvidenceJson,
    evidenceSha256: sha256Hex(canonicalEvidenceJson),
  };
}

async function ensureDailyMarketOutcome({
  asset,
  marketPeriodStartAt,
  marketPeriodEndAt,
  fetchImpl = globalThis.fetch,
}) {
  const symbol = SYMBOLS[asset];
  if (!symbol) throw new Error('market_outcome_asset_unsupported');

  const startIso = toIso(marketPeriodStartAt);
  const endIso = toIso(marketPeriodEndAt);

  const existing = await getMarketOutcome({
    asset,
    cadence: 'DAILY',
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
  });
  if (existing) return { record: existing, created: false, fetched: false };

  const durationMs = Date.parse(endIso) - Date.parse(startIso);
  if (durationMs !== DAY_MS) throw new Error('daily_market_period_must_be_24h');

  let archive = await getDailyMarketArchive({
    asset,
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
  });
  let fetched = false;

  if (!archive) {
    const windowData = await fetchDailyMarkPriceCandle({
      symbol,
      marketPeriodStartAt: startIso,
      marketPeriodEndAt: endIso,
      fetchImpl,
    });

    archive = await persistDailyMarketArchive({
      asset,
      symbol,
      marketPeriodStartAt: startIso,
      marketPeriodEndAt: endIso,
      windowData,
    });
    fetched = true;
  }

  const extrema = calculateExtrema({ candles: archive.candles });
  const { canonicalEvidenceJson, evidenceSha256 } = buildEvidence({
    source: archive.source,
    endpoint: archive.endpoint,
    symbol,
    cadence: 'DAILY',
    interval: archive.interval,
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
    candleCount: archive.candleCount,
    sourceDataSha256: archive.sourceDataSha256,
    high: extrema.high,
    low: extrema.low,
  });

  const result = await persistMarketOutcome({
    asset,
    cadence: 'DAILY',
    symbol,
    interval: archive.interval,
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
    high: extrema.high,
    low: extrema.low,
    candleCount: archive.candleCount,
    source: archive.source,
    endpoint: archive.endpoint,
    sourceDataSha256: archive.sourceDataSha256,
    canonicalEvidenceJson,
    evidenceSha256,
  });

  return { ...result, fetched };
}

async function deriveMarketOutcomeFromDaily({
  asset,
  cadence,
  marketPeriodStartAt,
  marketPeriodEndAt,
}) {
  if (!['WEEKLY', 'QUARTERLY'].includes(cadence)) {
    throw new Error('derived_market_outcome_cadence_invalid');
  }

  const symbol = SYMBOLS[asset];
  if (!symbol) throw new Error('market_outcome_asset_unsupported');

  const startIso = toIso(marketPeriodStartAt);
  const endIso = toIso(marketPeriodEndAt);

  const existing = await getMarketOutcome({
    asset,
    cadence,
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
  });
  if (existing) return { record: existing, created: false };

  const rows = await db.query(
    `SELECT * FROM market_outcomes
      WHERE asset = $1
        AND cadence = 'DAILY'
        AND market_period_start_at >= $2
        AND market_period_end_at <= $3
      ORDER BY market_period_start_at ASC`,
    [asset, startIso, endIso],
  );

  const daily = rows.rows.map((row) => {
    const record = rowToRecord(row);
    assertIntegrity(record);
    return record;
  });

  const aggregate = aggregateDailyOutcomes({
    records: daily,
    cadence,
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
  });

  const sourceDataSha256 = sha256Hex(JSON.stringify(aggregate.dailyEvidenceHashes));
  const source = 'EXTREMA derived from archived Binance daily mark-price candles';
  const endpoint = 'internal:daily-market-archive';

  const { canonicalEvidenceJson, evidenceSha256 } = buildEvidence({
    source,
    endpoint,
    symbol,
    cadence,
    interval: '1d',
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
    candleCount: aggregate.candleCount,
    sourceDataSha256,
    high: aggregate.high,
    low: aggregate.low,
    dailyEvidenceHashes: aggregate.dailyEvidenceHashes,
  });

  return persistMarketOutcome({
    asset,
    cadence,
    symbol,
    interval: '1d',
    marketPeriodStartAt: startIso,
    marketPeriodEndAt: endIso,
    high: aggregate.high,
    low: aggregate.low,
    candleCount: aggregate.candleCount,
    source,
    endpoint,
    sourceDataSha256,
    canonicalEvidenceJson,
    evidenceSha256,
  });
}

async function ensureMarketOutcome({
  asset,
  cadence,
  marketPeriodStartAt,
  marketPeriodEndAt,
  fetchImpl = globalThis.fetch,
}) {
  if (cadence === 'DAILY') {
    return ensureDailyMarketOutcome({
      asset,
      marketPeriodStartAt,
      marketPeriodEndAt,
      fetchImpl,
    });
  }

  return deriveMarketOutcomeFromDaily({
    asset,
    cadence,
    marketPeriodStartAt,
    marketPeriodEndAt,
  });
}

async function ingestUtcDayByDate(marketDate, { fetchImpl = globalThis.fetch } = {}) {
  const {
    marketPeriodStartAt,
    marketPeriodEndAt,
  } = marketDateToWindow(marketDate);

  const daily = [];
  const failures = [];

  for (const asset of Object.keys(SYMBOLS)) {
    try {
      const result = await ensureDailyMarketOutcome({
        asset,
        marketPeriodStartAt,
        marketPeriodEndAt,
        fetchImpl,
      });

      daily.push({
        asset,
        fetched: result.fetched,
        created: result.created,
        interval: result.record.interval,
        candleCount: result.record.candleCount,
        high: result.record.high.exact,
        low: result.record.low.exact,
        evidenceSha256: result.record.evidenceSha256,
      });
    } catch (error) {
      failures.push({
        asset,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const weekly = [];
  const quarterly = [];
  const derivedFailures = [];
  const dayEnd = new Date(marketPeriodEndAt);

  if (failures.length === 0 && dayEnd.getUTCDay() === 1) {
    const weeklyStart = new Date(dayEnd.getTime() - 7 * DAY_MS).toISOString();

    for (const asset of Object.keys(SYMBOLS)) {
      try {
        const result = await deriveMarketOutcomeFromDaily({
          asset,
          cadence: 'WEEKLY',
          marketPeriodStartAt: weeklyStart,
          marketPeriodEndAt,
        });
        weekly.push({
          asset,
          created: result.created,
          evidenceSha256: result.record.evidenceSha256,
        });
      } catch (error) {
        derivedFailures.push({
          asset,
          cadence: 'WEEKLY',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (
    failures.length === 0 &&
    dayEnd.getUTCDate() === 1 &&
    [0, 3, 6, 9].includes(dayEnd.getUTCMonth())
  ) {
    const quarterStart = new Date(
      Date.UTC(dayEnd.getUTCFullYear(), dayEnd.getUTCMonth() - 3, 1, 0, 0, 0, 0),
    ).toISOString();

    for (const asset of Object.keys(SYMBOLS)) {
      try {
        const result = await deriveMarketOutcomeFromDaily({
          asset,
          cadence: 'QUARTERLY',
          marketPeriodStartAt: quarterStart,
          marketPeriodEndAt,
        });
        quarterly.push({
          asset,
          created: result.created,
          evidenceSha256: result.record.evidenceSha256,
        });
      } catch (error) {
        derivedFailures.push({
          asset,
          cadence: 'QUARTERLY',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const sourceComplete = failures.length === 0;
  const derivationsComplete = derivedFailures.length === 0;

  return {
    marketDate,
    marketPeriodStartAt,
    marketPeriodEndAt,
    daily,
    failures,
    weekly,
    quarterly,
    derivedFailures,
    sourceComplete,
    derivationsComplete,
    // Backwards-compatible alias used by the archive retry path.
    // "complete" means the four DAILY Binance source records are complete.
    complete: sourceComplete,
  };
}

async function ingestPreviousUtcDay(now = new Date(), options = {}) {
  const window = previousUtcDayWindow(now);
  return ingestUtcDayByDate(window.marketDate, options);
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
    `SELECT
       to_regclass('public.market_outcomes') AS outcomes,
       to_regclass('public.daily_market_archives') AS archives`,
  );

  if (!result.rows[0]?.outcomes) throw new Error('market_outcomes_table_missing');
  if (!result.rows[0]?.archives) throw new Error('daily_market_archives_table_missing');

  return { marketOutcomes: true, dailyMarketArchives: true };
}

module.exports = {
  SYMBOLS,
  ensureDailyMarketOutcome,
  deriveMarketOutcomeFromDaily,
  ensureMarketOutcome,
  ingestUtcDayByDate,
  ingestPreviousUtcDay,
  getDailyMarketArchive,
  getMarketOutcome,
  listMarketOutcomes,
  verifyMarketOutcomeStorage,
};
