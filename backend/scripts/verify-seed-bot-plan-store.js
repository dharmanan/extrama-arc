'use strict';

const assert = require('node:assert/strict');
const { createSeedBotPlanStore } = require('../src/services/seedBotPlanStore');

async function main() {
  const rows = new Map();
  const dispatched = new Set();

  const fakeDb = {
    async query(sql, params = []) {
      const compact = sql.replace(/\s+/g, ' ').trim();

      if (compact.startsWith('INSERT INTO seed_bot_plans')) {
        const [
          planKey,
          walletAddress,
          poolAddress,
          poolSlug,
          roundId,
          plannerVersion,
          predictionPriceCents,
          plannedExecutionAt,
          entryCloseAt,
        ] = params;

        const nextRow = {
          plan_key: planKey,
          wallet_address: walletAddress,
          pool_address: poolAddress,
          pool_slug: poolSlug,
          round_id: roundId,
          planner_version: plannerVersion,
          prediction_price_cents: predictionPriceCents,
          planned_execution_at: plannedExecutionAt,
          entry_close_at: entryCloseAt,
        };

        const existing = rows.get(planKey);

        if (existing) {
          if (
            existing.planner_version !== plannerVersion &&
            !dispatched.has(planKey)
          ) {
            rows.set(planKey, nextRow);
            return { rowCount: 1, rows: [] };
          }

          return { rowCount: 0, rows: [] };
        }

        rows.set(planKey, nextRow);

        return { rowCount: 1, rows: [] };
      }

      if (compact.startsWith('SELECT plan_key,')) {
        const now =
          new Date(params[0]).getTime();

        const plannerVersion =
          params[1] ?? null;

        return {
          rows: [...rows.values()]
            .filter(
              row =>
                new Date(
                  row.entry_close_at,
                ).getTime() > now &&
                (
                  plannerVersion === null ||
                  row.planner_version === plannerVersion
                )
            )
            .sort((a, b) => {
              const timeDiff =
                new Date(a.planned_execution_at).getTime() -
                new Date(b.planned_execution_at).getTime();

              if (timeDiff !== 0) return timeDiff;
              return a.plan_key.localeCompare(b.plan_key);
            }),
        };
      }

      throw new Error(`unexpected_sql:${compact}`);
    },
  };

  const store = createSeedBotPlanStore({
    dbClient: fakeDb,
  });

  const original = {
    wallet: '0x995f659CD0AEd5ac3ac9D238cCeC74AdD5347A97',
    pool: 'eth-daily-low',
    poolAddress: '0x490A5CE02E3fd85d51095A69AAE9511552d91095',
    roundId: '8',
    plannerVersion: 'extrema-seed-bot-v1',
    predictionPriceCents: '245042',
    plannedExecutionAt: '2026-09-11T03:00:00.000Z',
    entryCloseAt: '2026-09-11T20:00:00.000Z',
    eligible: true,
  };

  const first = await store.persistEntries([original]);
  assert.equal(first.inserted, 1);
  assert.equal(rows.size, 1);

  const changedAfterRestart = {
    ...original,
    predictionPriceCents: '999999',
    plannedExecutionAt: '2026-09-11T10:00:00.000Z',
  };

  const second = await store.persistEntries([
    changedAfterRestart,
  ]);

  assert.equal(
    second.inserted,
    0,
    'existing round plan must remain immutable',
  );
  assert.equal(rows.size, 1);

  const open = await store.loadOpenEntries({
    now: '2026-09-11T02:00:00.000Z',
  });

  assert.equal(open.length, 1);
  assert.equal(
    open[0].predictionPriceCents,
    '245042',
    'original prediction survives replanning',
  );
  assert.equal(
    open[0].plannedExecutionAt,
    '2026-09-11T03:00:00.000Z',
    'original execution time survives replanning',
  );
  assert.equal(open[0].roundId, '8');
  assert.equal(open[0].eligible, true);
  assert.equal(open[0].alreadyEntered, false);

  const v3 = {
    ...original,
    plannerVersion:
      'extrema-seed-bot-v3',
    predictionPriceCents:
      '245099',
    plannedExecutionAt:
      '2026-09-11T04:00:00.000Z',
  };

  const superseded =
    await store.persistEntries([v3]);

  assert.equal(
    superseded.inserted,
    1,
    'new planner generation supersedes an undispatched plan',
  );

  assert.equal(
    rows.size,
    1,
    'planner generation change preserves the same plan key',
  );

  const current =
    await store.loadOpenEntries({
      now:
        '2026-09-11T02:00:00.000Z',
      plannerVersion:
        'extrema-seed-bot-v3',
    });

  assert.equal(
    current.length,
    1,
    'only the requested planner generation is loaded',
  );

  assert.equal(
    current[0].plannerVersion,
    'extrema-seed-bot-v3',
  );

  assert.equal(
    current[0].predictionPriceCents,
    '245099',
  );

  const durablePlanKey =
    [...rows.keys()][0];

  dispatched.add(durablePlanKey);

  const v4 = {
    ...v3,
    plannerVersion:
      'extrema-seed-bot-v4',
    predictionPriceCents:
      '999999',
  };

  const blockedAfterDispatch =
    await store.persistEntries([v4]);

  assert.equal(
    blockedAfterDispatch.inserted,
    0,
    'a dispatched plan cannot be superseded',
  );

  assert.equal(
    rows.get(durablePlanKey).planner_version,
    'extrema-seed-bot-v3',
  );

  assert.equal(
    rows.get(durablePlanKey).prediction_price_cents,
    '245099',
  );

  const closed = await store.loadOpenEntries({
    now: '2026-09-11T21:00:00.000Z',
  });

  assert.equal(
    closed.length,
    0,
    'expired plans are not returned',
  );

  console.log('seed-bot-plan-store: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
