'use strict';

const assert = require('node:assert/strict');
const {
  currentDailySchedule,
  currentWeeklySchedule,
  currentQuarterlySchedule,
  isCanonicalV2Round,
  roundMatchesCanonicalSchedule,
  canEnterCanonicalRound,
} = require('../src/services/canonicalMarketSchedule');

function ts(iso) {
  return BigInt(Math.floor(Date.parse(iso) / 1000));
}

function asRound(schedule, overrides = {}) {
  return {
    entryOpenAt: schedule.entryOpenAt,
    entryCloseAt: schedule.entryCloseAt,
    observationStartAt: schedule.observationStartAt,
    observationEndAt: schedule.observationEndAt,
    status: 0,
    entryCount: 0,
    ...overrides,
  };
}

const daily = currentDailySchedule(ts('2026-09-07T12:00:00.000Z'));
const dailyRound = asRound(daily);

assert.equal(isCanonicalV2Round('DAILY', dailyRound), true);
assert.equal(roundMatchesCanonicalSchedule('DAILY', dailyRound, daily), true);
assert.equal(
  canEnterCanonicalRound('DAILY', dailyRound, ts('2026-09-07T12:00:00.000Z')),
  true,
);

// Old V1 shape: same entry window, but pricing/settlement gate ends a day late.
const legacyDaily = asRound(daily, {
  observationStartAt: ts('2026-09-08T00:00:00.000Z'),
  observationEndAt: ts('2026-09-09T00:00:00.000Z'),
});
assert.equal(isCanonicalV2Round('DAILY', legacyDaily), false);
assert.equal(roundMatchesCanonicalSchedule('DAILY', legacyDaily, daily), false);
assert.equal(
  canEnterCanonicalRound('DAILY', legacyDaily, ts('2026-09-07T12:00:00.000Z')),
  false,
);

// A malformed round with the right close/end but the wrong open must not be
// mistaken for the current canonical period.
const wrongOpen = asRound(daily, {
  entryOpenAt: daily.entryOpenAt - 3600n,
});
assert.equal(isCanonicalV2Round('DAILY', wrongOpen), false);
assert.equal(roundMatchesCanonicalSchedule('DAILY', wrongOpen, daily), false);

// Closed or locked V2 rounds are never entry-eligible.
assert.equal(
  canEnterCanonicalRound('DAILY', asRound(daily, { status: 1 }), ts('2026-09-07T12:00:00.000Z')),
  false,
);
assert.equal(
  canEnterCanonicalRound('DAILY', dailyRound, daily.entryCloseAt),
  false,
);

for (const [cadence, schedule] of [
  ['WEEKLY', currentWeeklySchedule(ts('2026-09-09T12:00:00.000Z'))],
  ['QUARTERLY', currentQuarterlySchedule(ts('2026-08-15T12:00:00.000Z'))],
]) {
  const round = asRound(schedule);
  assert.equal(isCanonicalV2Round(cadence, round), true);
  assert.equal(roundMatchesCanonicalSchedule(cadence, round, schedule), true);
  assert.equal(canEnterCanonicalRound(cadence, round, schedule.entryOpenAt), true);
}

console.log('V2_MIGRATION_GUARDS=PASS');
