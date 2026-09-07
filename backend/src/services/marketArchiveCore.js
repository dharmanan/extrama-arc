'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAST_RETRY_WINDOW_MS = 10 * 60 * 1000;
const FAST_RETRY_MS = 60 * 1000;
const SLOW_RETRY_MS = 5 * 60 * 1000;

function asDate(value, label = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function marketDateToWindow(marketDate) {
  if (typeof marketDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(marketDate)) {
    throw new Error('market_date_invalid');
  }

  const [year, month, day] = marketDate.split('-').map(Number);
  const startMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const check = new Date(startMs);

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error('market_date_invalid');
  }

  return {
    marketDate,
    marketPeriodStartAt: new Date(startMs).toISOString(),
    marketPeriodEndAt: new Date(startMs + DAY_MS).toISOString(),
  };
}

function previousUtcDayWindow(now = new Date()) {
  const current = asDate(now, 'archive_now');
  const endMs = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    0, 0, 0, 0,
  );
  const start = new Date(endMs - DAY_MS);
  const marketDate = [
    start.getUTCFullYear(),
    String(start.getUTCMonth() + 1).padStart(2, '0'),
    String(start.getUTCDate()).padStart(2, '0'),
  ].join('-');

  return marketDateToWindow(marketDate);
}

function nextUtc0001(now = new Date()) {
  const current = asDate(now, 'scheduler_now');
  const next = new Date(Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
    0, 1, 0, 0,
  ));

  if (next.getTime() <= current.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next;
}

function retryDelayMs({ marketPeriodEndAt, now = new Date() }) {
  const endMs = asDate(marketPeriodEndAt, 'market_period_end').getTime();
  const nowMs = asDate(now, 'retry_now').getTime();
  const elapsedMs = Math.max(0, nowMs - endMs);
  return elapsedMs < FAST_RETRY_WINDOW_MS ? FAST_RETRY_MS : SLOW_RETRY_MS;
}

function decimalToScaledInteger(value, scaleDigits = 18) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) {
    throw new Error('market_outcome_decimal_invalid');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scaleDigits) throw new Error('market_outcome_precision_too_large');
  return (
    BigInt(whole) * 10n ** BigInt(scaleDigits) +
    BigInt(fraction.padEnd(scaleDigits, '0') || '0')
  );
}

function compareDecimalStrings(leftValue, rightValue) {
  const left = decimalToScaledInteger(leftValue);
  const right = decimalToScaledInteger(rightValue);
  return left === right ? 0 : left > right ? 1 : -1;
}

function aggregateDailyOutcomes({
  records,
  cadence,
  marketPeriodStartAt,
  marketPeriodEndAt,
}) {
  if (!['WEEKLY', 'QUARTERLY'].includes(cadence)) {
    throw new Error('derived_market_outcome_cadence_invalid');
  }
  if (!Array.isArray(records)) throw new Error('derived_market_outcome_records_invalid');

  const startMs = asDate(marketPeriodStartAt, 'market_period_start').getTime();
  const endMs = asDate(marketPeriodEndAt, 'market_period_end').getTime();
  const durationMs = endMs - startMs;
  const expectedDays = durationMs / DAY_MS;

  if (!Number.isInteger(expectedDays) || expectedDays <= 0) {
    throw new Error('derived_market_period_invalid');
  }
  if (cadence === 'WEEKLY' && expectedDays !== 7) {
    throw new Error('weekly_market_period_must_be_7_days');
  }
  if (cadence === 'QUARTERLY' && (expectedDays < 90 || expectedDays > 92)) {
    throw new Error('quarterly_market_period_invalid_day_count');
  }
  if (records.length !== expectedDays) {
    throw new Error(
      `derived_market_outcome_daily_archive_incomplete:expected_${expectedDays}:received_${records.length}`,
    );
  }

  for (let index = 0; index < records.length; index += 1) {
    const expectedStart = new Date(startMs + index * DAY_MS).toISOString();
    const expectedEnd = new Date(startMs + (index + 1) * DAY_MS).toISOString();
    const record = records[index];

    if (
      record.marketPeriodStartAt !== expectedStart ||
      record.marketPeriodEndAt !== expectedEnd
    ) {
      throw new Error('derived_market_outcome_daily_archive_gap');
    }
  }

  let high = records[0].high;
  let low = records[0].low;

  for (let index = 1; index < records.length; index += 1) {
    if (compareDecimalStrings(records[index].high.exact, high.exact) > 0) {
      high = records[index].high;
    }
    if (compareDecimalStrings(records[index].low.exact, low.exact) < 0) {
      low = records[index].low;
    }
  }

  const dailyEvidenceHashes = records.map((record) => ({
    marketPeriodStartAt: record.marketPeriodStartAt,
    marketPeriodEndAt: record.marketPeriodEndAt,
    evidenceSha256: record.evidenceSha256,
    sourceDataSha256: record.sourceDataSha256,
  }));

  return {
    expectedDays,
    high,
    low,
    candleCount: records.length,
    dailyEvidenceHashes,
  };
}

module.exports = {
  DAY_MS,
  FAST_RETRY_WINDOW_MS,
  FAST_RETRY_MS,
  SLOW_RETRY_MS,
  marketDateToWindow,
  previousUtcDayWindow,
  nextUtc0001,
  retryDelayMs,
  aggregateDailyOutcomes,
};
