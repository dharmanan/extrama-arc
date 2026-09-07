'use strict';

const assert = require('assert/strict');
const {
  currentDailySchedule,
  currentWeeklySchedule,
  currentQuarterlySchedule,
  isCanonicalV2Round,
} = require('../src/services/canonicalMarketSchedule');

function ts(iso) {
  return BigInt(Math.floor(Date.parse(iso) / 1000));
}

function verifySchedule(name, schedule, expected) {
  assert.equal(schedule.marketPeriodStartAt, ts(expected.start), `${name}: market start`);
  assert.equal(schedule.marketPeriodEndAt, ts(expected.end), `${name}: market end`);
  assert.equal(schedule.entryCloseAt, ts(expected.close), `${name}: entry close`);
  assert.equal(schedule.observationStartAt, schedule.entryCloseAt, `${name}: legacy gate start`);
  assert.equal(schedule.observationEndAt, schedule.marketPeriodEndAt, `${name}: settlement gate end`);
  assert.equal(schedule.entryOpenAt, schedule.marketPeriodStartAt, `${name}: entry open`);
  assert.equal(isCanonicalV2Round(name, schedule), true, `${name}: v2 classifier`);
}

verifySchedule(
  'DAILY',
  currentDailySchedule(ts('2026-09-07T12:34:00.000Z')),
  {
    start: '2026-09-07T00:00:00.000Z',
    close: '2026-09-07T20:00:00.000Z',
    end: '2026-09-08T00:00:00.000Z',
  },
);

verifySchedule(
  'DAILY',
  currentDailySchedule(ts('2026-12-31T23:30:00.000Z')),
  {
    start: '2026-12-31T00:00:00.000Z',
    close: '2026-12-31T20:00:00.000Z',
    end: '2027-01-01T00:00:00.000Z',
  },
);

verifySchedule(
  'WEEKLY',
  currentWeeklySchedule(ts('2026-09-09T12:00:00.000Z')),
  {
    start: '2026-09-07T00:00:00.000Z',
    close: '2026-09-13T00:00:00.000Z',
    end: '2026-09-14T00:00:00.000Z',
  },
);

verifySchedule(
  'WEEKLY',
  currentWeeklySchedule(ts('2026-12-31T12:00:00.000Z')),
  {
    start: '2026-12-28T00:00:00.000Z',
    close: '2027-01-03T00:00:00.000Z',
    end: '2027-01-04T00:00:00.000Z',
  },
);

verifySchedule(
  'QUARTERLY',
  currentQuarterlySchedule(ts('2026-08-15T12:00:00.000Z')),
  {
    start: '2026-07-01T00:00:00.000Z',
    close: '2026-09-30T00:00:00.000Z',
    end: '2026-10-01T00:00:00.000Z',
  },
);

verifySchedule(
  'QUARTERLY',
  currentQuarterlySchedule(ts('2028-02-29T12:00:00.000Z')),
  {
    start: '2028-01-01T00:00:00.000Z',
    close: '2028-03-31T00:00:00.000Z',
    end: '2028-04-01T00:00:00.000Z',
  },
);

console.log('CANONICAL_MARKET_SCHEDULES=PASS');
