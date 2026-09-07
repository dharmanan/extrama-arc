'use strict';

const db = require('../src/db');
const {
  runDailyMarketArchiveJob,
  scheduleOneShotMarketArchiveTest,
} = require('../src/services/roundAutomationService');
const { marketDateToWindow } = require('../src/services/marketArchiveCore');

async function main() {
  const marketDate = process.argv[2];
  const delaySeconds = Number(process.argv[3] || '60');

  marketDateToWindow(marketDate);

  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 600) {
    throw new Error('delay_seconds_must_be_between_1_and_600');
  }

  console.log(
    'MARKET_ARCHIVE_SCHEDULED_SMOKE',
    JSON.stringify({
      marketDate,
      delaySeconds,
      scheduledFor: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    }),
  );

  const first = await scheduleOneShotMarketArchiveTest({
    marketDate,
    delayMs: delaySeconds * 1000,
  });

  if (first?.skipped) {
    throw new Error(`first_run_skipped:${first.reason}`);
  }
  if (!first.complete) {
    throw new Error(
      `first_run_incomplete:${JSON.stringify({
        failures: first.failures,
        derivedFailures: first.derivedFailures,
      })}`,
    );
  }
  if (first.daily.length !== 4) {
    throw new Error(`first_run_expected_4_assets_received_${first.daily.length}`);
  }

  const firstFetched = first.daily.filter((item) => item.fetched).length;
  if (firstFetched !== 4) {
    throw new Error(
      `smoke_target_not_clean:expected_4_fresh_fetches_received_${firstFetched}:choose_another_completed_utc_day`,
    );
  }

  for (const item of first.daily) {
    if (item.interval !== '1d' || item.candleCount !== 1) {
      throw new Error(
        `first_run_daily_shape_invalid:${item.asset}:${item.interval}:${item.candleCount}`,
      );
    }
  }

  console.log(
    'MARKET_ARCHIVE_FIRST_RUN=PASS',
    JSON.stringify(first),
  );

  const second = await runDailyMarketArchiveJob({
    marketDate,
    trigger: 'smoke-idempotency',
  });

  if (second?.skipped) {
    throw new Error(`second_run_skipped:${second.reason}`);
  }
  if (!second.complete || second.daily.length !== 4) {
    throw new Error('second_run_incomplete');
  }

  const secondFetched = second.daily.filter((item) => item.fetched).length;
  if (secondFetched !== 0) {
    throw new Error(
      `idempotency_failed:expected_0_refetches_received_${secondFetched}`,
    );
  }

  console.log(
    'MARKET_ARCHIVE_SECOND_RUN_NO_REFETCH=PASS',
    JSON.stringify(second),
  );
  console.log('MARKET_ARCHIVE_SCHEDULER_SMOKE=PASS');
}

main()
  .catch((error) => {
    console.error('MARKET_ARCHIVE_SCHEDULER_SMOKE=FAIL', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close().catch(() => {});
  });
