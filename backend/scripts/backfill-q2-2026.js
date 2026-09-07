'use strict';

const db = require('../src/db');
const marketOutcomeService = require('../src/services/marketOutcomeService');
const {
  DAY_MS,
  marketDateToWindow,
} = require('../src/services/marketArchiveCore');

const START_DATE = '2026-04-01';
const END_DATE_EXCLUSIVE = '2026-07-01';
const ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const SYMBOLS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  HYPE: 'HYPEUSDT',
};
const EXPECTED_DAYS = 91;
const EXPECTED_DAILY_ROWS = EXPECTED_DAYS * ASSETS.length;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateList(startDate, endDateExclusive) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDateExclusive}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('backfill_date_range_invalid');
  }

  const dates = [];
  for (let cursor = start; cursor < end; cursor += DAY_MS) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

async function ensureOneDay(asset, marketDate) {
  const { marketPeriodStartAt, marketPeriodEndAt } = marketDateToWindow(marketDate);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await marketOutcomeService.ensureDailyMarketOutcome({
        asset,
        marketPeriodStartAt,
        marketPeriodEndAt,
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 500);
    }
  }

  throw new Error(
    `daily_backfill_failed:${asset}:${marketDate}:${lastError?.message || lastError}`,
  );
}

function fullWeeklyPeriodsWithin(startDate, endDateExclusive) {
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDateExclusive}T00:00:00.000Z`);
  const periods = [];

  let cursor = startMs;
  while (new Date(cursor).getUTCDay() !== 1) cursor += DAY_MS;

  for (; cursor + 7 * DAY_MS <= endMs; cursor += 7 * DAY_MS) {
    periods.push({
      start: new Date(cursor).toISOString(),
      end: new Date(cursor + 7 * DAY_MS).toISOString(),
    });
  }

  return periods;
}

async function readDaily(asset, marketDate) {
  const { marketPeriodStartAt, marketPeriodEndAt } = marketDateToWindow(marketDate);
  const record = await marketOutcomeService.getMarketOutcome({
    asset,
    cadence: 'DAILY',
    marketPeriodStartAt,
    marketPeriodEndAt,
  });
  if (!record) throw new Error(`daily_outcome_missing:${asset}:${marketDate}`);
  return record;
}

async function fetchQuarterDailyCandles(symbol) {
  const startMs = Date.parse(`${START_DATE}T00:00:00.000Z`);
  const endMs = Date.parse(`${END_DATE_EXCLUSIVE}T00:00:00.000Z`);
  const url =
    'https://fapi.binance.com/fapi/v1/markPriceKlines' +
    `?symbol=${encodeURIComponent(symbol)}` +
    '&interval=1d' +
    `&startTime=${startMs}` +
    `&endTime=${endMs - 1}` +
    `&limit=${EXPECTED_DAYS}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'EXTREMA-Q2-Verification/0.3',
    },
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `q2_batch_source_http_${response.status}:${symbol}:${text.slice(0, 180)}`,
    );
  }

  let candles;
  try {
    candles = JSON.parse(text);
  } catch {
    throw new Error(`q2_batch_source_json_invalid:${symbol}`);
  }

  if (!Array.isArray(candles) || candles.length !== EXPECTED_DAYS) {
    throw new Error(
      `q2_batch_source_count_mismatch:${symbol}:expected_${EXPECTED_DAYS}:received_${Array.isArray(candles) ? candles.length : 'invalid'}`,
    );
  }

  for (let index = 0; index < candles.length; index += 1) {
    const expectedOpen = startMs + index * DAY_MS;
    const expectedClose = expectedOpen + DAY_MS - 1;
    if (
      Number(candles[index][0]) !== expectedOpen ||
      Number(candles[index][6]) !== expectedClose
    ) {
      throw new Error(`q2_batch_source_time_mismatch:${symbol}:index_${index}`);
    }
  }

  return candles;
}

async function verifyDailyAgainstIndependentBatch(dates) {
  let compared = 0;

  for (const asset of ASSETS) {
    const candles = await fetchQuarterDailyCandles(SYMBOLS[asset]);

    for (let index = 0; index < dates.length; index += 1) {
      const record = await readDaily(asset, dates[index]);
      const candle = candles[index];

      if (record.interval !== '1d' || record.candleCount !== 1) {
        throw new Error(
          `daily_storage_shape_invalid:${asset}:${dates[index]}:${record.interval}:${record.candleCount}`,
        );
      }

      if (record.high.exact !== candle[2] || record.low.exact !== candle[3]) {
        throw new Error(
          `daily_value_mismatch:${asset}:${dates[index]}:db_high_${record.high.exact}:source_high_${candle[2]}:db_low_${record.low.exact}:source_low_${candle[3]}`,
        );
      }

      compared += 1;
    }
  }

  return compared;
}

async function verifyDatabaseCounts() {
  const startIso = `${START_DATE}T00:00:00.000Z`;
  const endIso = `${END_DATE_EXCLUSIVE}T00:00:00.000Z`;

  const daily = await db.query(
    `SELECT
       COUNT(*)::int AS count,
       COUNT(*) FILTER (WHERE interval = '1d' AND candle_count = 1)::int AS canonical_count
     FROM market_outcomes
     WHERE cadence = 'DAILY'
       AND market_period_start_at >= $1
       AND market_period_end_at <= $2`,
    [startIso, endIso],
  );

  const archives = await db.query(
    `SELECT
       COUNT(*)::int AS count,
       COUNT(*) FILTER (WHERE interval = '1d' AND candle_count = 1)::int AS canonical_count
     FROM daily_market_archives
     WHERE market_period_start_at >= $1
       AND market_period_end_at <= $2`,
    [startIso, endIso],
  );

  const duplicateDaily = await db.query(
    `SELECT asset, market_period_start_at, market_period_end_at, COUNT(*)::int AS count
     FROM market_outcomes
     WHERE cadence = 'DAILY'
       AND market_period_start_at >= $1
       AND market_period_end_at <= $2
     GROUP BY asset, market_period_start_at, market_period_end_at
     HAVING COUNT(*) > 1`,
    [startIso, endIso],
  );

  return {
    outcomes: daily.rows[0],
    archives: archives.rows[0],
    duplicateDaily: duplicateDaily.rows,
  };
}

async function deriveContainedWeeks() {
  const periods = fullWeeklyPeriodsWithin(START_DATE, END_DATE_EXCLUSIVE);
  const results = [];

  for (const period of periods) {
    for (const asset of ASSETS) {
      const result = await marketOutcomeService.deriveMarketOutcomeFromDaily({
        asset,
        cadence: 'WEEKLY',
        marketPeriodStartAt: period.start,
        marketPeriodEndAt: period.end,
      });

      results.push({
        asset,
        start: period.start,
        end: period.end,
        created: result.created,
        high: result.record.high.exact,
        low: result.record.low.exact,
      });
    }
  }

  return { periods, results };
}

async function deriveQuarter() {
  const results = [];

  for (const asset of ASSETS) {
    const result = await marketOutcomeService.deriveMarketOutcomeFromDaily({
      asset,
      cadence: 'QUARTERLY',
      marketPeriodStartAt: `${START_DATE}T00:00:00.000Z`,
      marketPeriodEndAt: `${END_DATE_EXCLUSIVE}T00:00:00.000Z`,
    });

    results.push({
      asset,
      created: result.created,
      high: result.record.high.exact,
      highPriceCents: result.record.high.resolvedPriceCents,
      low: result.record.low.exact,
      lowPriceCents: result.record.low.resolvedPriceCents,
      evidenceSha256: result.record.evidenceSha256,
    });
  }

  return results;
}

async function secondPassMustNotFetch(dates) {
  let fetched = 0;

  for (const marketDate of dates) {
    for (const asset of ASSETS) {
      const result = await ensureOneDay(asset, marketDate);
      if (result.fetched) fetched += 1;
    }
  }

  if (fetched !== 0) {
    throw new Error(`q2_idempotency_failed:unexpected_refetches_${fetched}`);
  }

  return fetched;
}

async function main() {
  const dates = dateList(START_DATE, END_DATE_EXCLUSIVE);

  if (dates.length !== EXPECTED_DAYS) {
    throw new Error(
      `q2_day_count_invalid:expected_${EXPECTED_DAYS}:received_${dates.length}`,
    );
  }

  console.log(
    'Q2_BACKFILL_START',
    JSON.stringify({
      startDate: START_DATE,
      endDateExclusive: END_DATE_EXCLUSIVE,
      days: dates.length,
      assets: ASSETS,
      expectedDailyAssetRows: EXPECTED_DAILY_ROWS,
    }),
  );

  let fetched = 0;
  let existing = 0;

  for (let dayIndex = 0; dayIndex < dates.length; dayIndex += 1) {
    const marketDate = dates[dayIndex];

    for (const asset of ASSETS) {
      const result = await ensureOneDay(asset, marketDate);
      if (result.fetched) fetched += 1;
      else existing += 1;

      if (result.record.interval !== '1d' || result.record.candleCount !== 1) {
        throw new Error(
          `q2_daily_shape_invalid:${asset}:${marketDate}:${result.record.interval}:${result.record.candleCount}`,
        );
      }
    }

    if ((dayIndex + 1) % 10 === 0 || dayIndex === dates.length - 1) {
      console.log(
        'Q2_BACKFILL_PROGRESS',
        JSON.stringify({
          completedDays: dayIndex + 1,
          totalDays: dates.length,
          fetched,
          existing,
        }),
      );
    }
  }

  const counts = await verifyDatabaseCounts();

  if (
    counts.outcomes.count !== EXPECTED_DAILY_ROWS ||
    counts.outcomes.canonical_count !== EXPECTED_DAILY_ROWS ||
    counts.archives.count !== EXPECTED_DAILY_ROWS ||
    counts.archives.canonical_count !== EXPECTED_DAILY_ROWS ||
    counts.duplicateDaily.length !== 0
  ) {
    throw new Error(`q2_storage_count_invalid:${JSON.stringify(counts)}`);
  }

  console.log(
    'Q2_DAILY_STORAGE=PASS',
    JSON.stringify(counts),
  );

  const compared = await verifyDailyAgainstIndependentBatch(dates);
  if (compared !== EXPECTED_DAILY_ROWS) {
    throw new Error(
      `q2_independent_comparison_count_invalid:expected_${EXPECTED_DAILY_ROWS}:received_${compared}`,
    );
  }

  console.log(
    'Q2_DAILY_BINANCE_CROSSCHECK=PASS',
    JSON.stringify({ compared }),
  );

  const weekly = await deriveContainedWeeks();

  if (weekly.periods.length !== 12 || weekly.results.length !== 48) {
    throw new Error(
      `q2_weekly_derivation_count_invalid:periods_${weekly.periods.length}:rows_${weekly.results.length}`,
    );
  }

  console.log(
    'Q2_WEEKLY_DERIVATION=PASS',
    JSON.stringify({
      fullWeeksInsideQuarter: weekly.periods.length,
      derivedAssetRows: weekly.results.length,
    }),
  );

  const quarter = await deriveQuarter();

  if (quarter.length !== 4) {
    throw new Error(`q2_quarter_derivation_count_invalid:${quarter.length}`);
  }

  console.log(
    'Q2_QUARTERLY_DERIVATION=PASS',
    JSON.stringify(quarter),
  );

  await secondPassMustNotFetch(dates);

  console.log(
    'Q2_SECOND_PASS_NO_BINANCE_REFETCH=PASS',
    JSON.stringify({ checkedDailyAssetRows: EXPECTED_DAILY_ROWS }),
  );

  console.log(
    'Q2_2026_HISTORICAL_REPLAY=PASS',
    JSON.stringify({
      days: EXPECTED_DAYS,
      dailyAssetRows: EXPECTED_DAILY_ROWS,
      independentDailyComparisons: compared,
      weeklyPeriods: weekly.periods.length,
      weeklyAssetRows: weekly.results.length,
      quarterlyAssetRows: quarter.length,
      firstPassFetched: fetched,
      firstPassExisting: existing,
    }),
  );
}

main()
  .catch((error) => {
    console.error('Q2_2026_HISTORICAL_REPLAY=FAIL', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close().catch(() => {});
  });
