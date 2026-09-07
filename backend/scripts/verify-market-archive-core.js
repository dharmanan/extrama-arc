'use strict';

const assert = require('node:assert/strict');
const core = require('../src/services/marketArchiveCore');

function fakeDailyRecord(startMs, index, high, low) {
  const start = new Date(startMs + index * core.DAY_MS).toISOString();
  const end = new Date(startMs + (index + 1) * core.DAY_MS).toISOString();

  return {
    marketPeriodStartAt: start,
    marketPeriodEndAt: end,
    high: {
      exact: String(high),
      resolvedPriceCents: '0',
      candleOpenTime: Date.parse(start),
      candleOpenIso: start,
    },
    low: {
      exact: String(low),
      resolvedPriceCents: '0',
      candleOpenTime: Date.parse(start),
      candleOpenIso: start,
    },
    evidenceSha256: String(index).padStart(64, '0').slice(-64),
    sourceDataSha256: String(index + 100).padStart(64, '0').slice(-64),
  };
}

function main() {
  const day = core.marketDateToWindow('2026-09-05');
  assert.equal(day.marketPeriodStartAt, '2026-09-05T00:00:00.000Z');
  assert.equal(day.marketPeriodEndAt, '2026-09-06T00:00:00.000Z');

  const next = core.nextUtc0001(new Date('2026-09-07T00:00:30.000Z'));
  assert.equal(next.toISOString(), '2026-09-07T00:01:00.000Z');

  assert.equal(
    core.retryDelayMs({
      marketPeriodEndAt: '2026-09-07T00:00:00.000Z',
      now: new Date('2026-09-07T00:05:00.000Z'),
    }),
    60_000,
  );

  assert.equal(
    core.retryDelayMs({
      marketPeriodEndAt: '2026-09-07T00:00:00.000Z',
      now: new Date('2026-09-07T00:11:00.000Z'),
    }),
    300_000,
  );

  const weeklyStartMs = Date.parse('2026-08-31T00:00:00.000Z');
  const weekly = Array.from({ length: 7 }, (_, index) =>
    fakeDailyRecord(
      weeklyStartMs,
      index,
      (100 + index).toFixed(8),
      (50 - index).toFixed(8),
    ),
  );

  const weeklyAggregate = core.aggregateDailyOutcomes({
    records: weekly,
    cadence: 'WEEKLY',
    marketPeriodStartAt: '2026-08-31T00:00:00.000Z',
    marketPeriodEndAt: '2026-09-07T00:00:00.000Z',
  });

  assert.equal(weeklyAggregate.candleCount, 7);
  assert.equal(weeklyAggregate.high.exact, '106.00000000');
  assert.equal(weeklyAggregate.low.exact, '44.00000000');

  const brokenWeekly = weekly.map((record) => ({ ...record }));
  brokenWeekly[3] = {
    ...brokenWeekly[3],
    marketPeriodStartAt: '2026-09-04T00:01:00.000Z',
  };

  assert.throws(
    () =>
      core.aggregateDailyOutcomes({
        records: brokenWeekly,
        cadence: 'WEEKLY',
        marketPeriodStartAt: '2026-08-31T00:00:00.000Z',
        marketPeriodEndAt: '2026-09-07T00:00:00.000Z',
      }),
    /derived_market_outcome_daily_archive_gap/,
  );

  const quarterStartMs = Date.parse('2026-01-01T00:00:00.000Z');
  const quarter = Array.from({ length: 90 }, (_, index) =>
    fakeDailyRecord(
      quarterStartMs,
      index,
      (1000 + index).toFixed(8),
      (900 - index).toFixed(8),
    ),
  );

  const quarterAggregate = core.aggregateDailyOutcomes({
    records: quarter,
    cadence: 'QUARTERLY',
    marketPeriodStartAt: '2026-01-01T00:00:00.000Z',
    marketPeriodEndAt: '2026-04-01T00:00:00.000Z',
  });

  assert.equal(quarterAggregate.candleCount, 90);
  assert.equal(quarterAggregate.high.exact, '1089.00000000');
  assert.equal(quarterAggregate.low.exact, '811.00000000');

  console.log('MARKET_ARCHIVE_CORE_VERIFY=PASS');
}

main();
