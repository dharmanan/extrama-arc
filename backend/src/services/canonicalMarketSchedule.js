'use strict';

const SECONDS_PER_DAY = 86400n;

const CADENCE_RULES = Object.freeze({
  DAILY: { entryCutoffBeforeEndSeconds: 4n * 3600n },
  WEEKLY: { entryCutoffBeforeEndSeconds: 24n * 3600n },
  QUARTERLY: { entryCutoffBeforeEndSeconds: 24n * 3600n },
});

function utcSeconds(year, month, day, hour = 0) {
  return BigInt(Math.floor(Date.UTC(year, month, day, hour, 0, 0, 0) / 1000));
}

function quarterStartUtc(year, quarterIndex) {
  return utcSeconds(year, quarterIndex * 3, 1);
}

function mapMarketPeriodToContractFields({ marketPeriodStartAt, marketPeriodEndAt, entryCloseAt }) {
  return {
    entryOpenAt: marketPeriodStartAt,
    entryCloseAt,
    // Legacy deployed ABI names. These are contract time gates only.
    // They MUST NOT be used as the Binance pricing window.
    observationStartAt: entryCloseAt,
    observationEndAt: marketPeriodEndAt,
    marketPeriodStartAt,
    marketPeriodEndAt,
  };
}

function currentDailySchedule(chainTimestamp) {
  const now = new Date(Number(chainTimestamp) * 1000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const marketPeriodStartAt = utcSeconds(y, m, d);
  const marketPeriodEndAt = utcSeconds(y, m, d + 1);
  const entryCloseAt =
    marketPeriodEndAt - CADENCE_RULES.DAILY.entryCutoffBeforeEndSeconds;
  return mapMarketPeriodToContractFields({
    marketPeriodStartAt,
    marketPeriodEndAt,
    entryCloseAt,
  });
}

function currentWeeklySchedule(chainTimestamp) {
  const now = new Date(Number(chainTimestamp) * 1000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const weekday = now.getUTCDay(); // 0 Sun ... 6 Sat
  const daysSinceMonday = (weekday + 6) % 7;
  const marketPeriodStartAt = utcSeconds(y, m, d - daysSinceMonday);
  const marketPeriodEndAt = marketPeriodStartAt + 7n * SECONDS_PER_DAY;
  const entryCloseAt =
    marketPeriodEndAt - CADENCE_RULES.WEEKLY.entryCutoffBeforeEndSeconds;
  return mapMarketPeriodToContractFields({
    marketPeriodStartAt,
    marketPeriodEndAt,
    entryCloseAt,
  });
}

function currentQuarterlySchedule(chainTimestamp) {
  const now = new Date(Number(chainTimestamp) * 1000);
  const year = now.getUTCFullYear();
  const quarterIndex = Math.floor(now.getUTCMonth() / 3);
  const marketPeriodStartAt = quarterStartUtc(year, quarterIndex);
  const nextYear = quarterIndex === 3 ? year + 1 : year;
  const nextQuarterIndex = quarterIndex === 3 ? 0 : quarterIndex + 1;
  const marketPeriodEndAt = quarterStartUtc(nextYear, nextQuarterIndex);
  const entryCloseAt =
    marketPeriodEndAt - CADENCE_RULES.QUARTERLY.entryCutoffBeforeEndSeconds;
  return mapMarketPeriodToContractFields({
    marketPeriodStartAt,
    marketPeriodEndAt,
    entryCloseAt,
  });
}

function previousCompletedMarketPeriod(cadence, chainTimestamp) {
  const current =
    cadence === 'DAILY'
      ? currentDailySchedule(chainTimestamp)
      : cadence === 'WEEKLY'
        ? currentWeeklySchedule(chainTimestamp)
        : currentQuarterlySchedule(chainTimestamp);

  if (chainTimestamp >= current.marketPeriodEndAt) {
    return {
      marketPeriodStartAt: current.marketPeriodStartAt,
      marketPeriodEndAt: current.marketPeriodEndAt,
    };
  }

  if (cadence === 'DAILY') {
    return {
      marketPeriodStartAt: current.marketPeriodStartAt - SECONDS_PER_DAY,
      marketPeriodEndAt: current.marketPeriodStartAt,
    };
  }

  if (cadence === 'WEEKLY') {
    return {
      marketPeriodStartAt: current.marketPeriodStartAt - 7n * SECONDS_PER_DAY,
      marketPeriodEndAt: current.marketPeriodStartAt,
    };
  }

  const currentStart = new Date(Number(current.marketPeriodStartAt) * 1000);
  let year = currentStart.getUTCFullYear();
  let quarterIndex = Math.floor(currentStart.getUTCMonth() / 3) - 1;
  if (quarterIndex < 0) {
    quarterIndex = 3;
    year -= 1;
  }
  return {
    marketPeriodStartAt: quarterStartUtc(year, quarterIndex),
    marketPeriodEndAt: current.marketPeriodStartAt,
  };
}

function roundMatchesCanonicalSchedule(cadence, round, schedule) {
  return (
    isCanonicalV2Round(cadence, round) &&
    BigInt(round.entryOpenAt) === BigInt(schedule.entryOpenAt) &&
    BigInt(round.entryCloseAt) === BigInt(schedule.entryCloseAt) &&
    BigInt(round.observationStartAt) === BigInt(schedule.observationStartAt) &&
    BigInt(round.observationEndAt) === BigInt(schedule.observationEndAt)
  );
}

function canEnterCanonicalRound(cadence, round, chainTimestamp) {
  if (!isCanonicalV2Round(cadence, round)) return false;
  const now = BigInt(chainTimestamp);
  return (
    Number(round.status) === 0 &&
    now >= BigInt(round.entryOpenAt) &&
    now < BigInt(round.entryCloseAt)
  );
}

function isCanonicalV2Round(cadence, round) {
  if (!round) return false;
  const start = BigInt(round.entryOpenAt);
  const close = BigInt(round.entryCloseAt);
  const gateStart = BigInt(round.observationStartAt);
  const end = BigInt(round.observationEndAt);
  if (gateStart !== close) return false;

  const cutoff = CADENCE_RULES[cadence]?.entryCutoffBeforeEndSeconds;
  if (!cutoff || close !== end - cutoff) return false;

  if (cadence === 'DAILY') return end - start === SECONDS_PER_DAY;
  if (cadence === 'WEEKLY') return end - start === 7n * SECONDS_PER_DAY;

  const startDate = new Date(Number(start) * 1000);
  const endDate = new Date(Number(end) * 1000);
  return (
    startDate.getUTCDate() === 1 &&
    endDate.getUTCDate() === 1 &&
    startDate.getUTCHours() === 0 &&
    endDate.getUTCHours() === 0 &&
    [0, 3, 6, 9].includes(startDate.getUTCMonth()) &&
    [0, 3, 6, 9].includes(endDate.getUTCMonth())
  );
}

module.exports = {
  CADENCE_RULES,
  SECONDS_PER_DAY,
  currentDailySchedule,
  currentWeeklySchedule,
  currentQuarterlySchedule,
  previousCompletedMarketPeriod,
  isCanonicalV2Round,
  roundMatchesCanonicalSchedule,
  canEnterCanonicalRound,
};
