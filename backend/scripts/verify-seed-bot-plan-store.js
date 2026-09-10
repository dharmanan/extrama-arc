'use strict';

const assert = require('node:assert/strict');
const { createSeedBotPlanStore } = require('../src/services/seedBotPlanStore');

async function main() {
  const rows = new Map();

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

        if (rows.has(planKey)) {
          return { rowCount: 0, rows: [] };
        }

        rows.set(planKey, {
          plan_key: planKey,
          wallet_address: walletAddress,
          pool_address: poolAddress,
          pool_slug: poolSlug,
          round_id: roundId,
          planner_version: plannerVersion,
          prediction_price_cents: predictionPriceCents,
          planned_execution_at: plannedExecutionAt,
          entry_close_at: entryCloseAt,
        });

        return { rowCount: 1, rows: [] };
      }

      if (compact.startsWith('SELECT plan_key,')) {
        const now = new Date(params[0]).getTime();

        return {
          rows: [...rows.values()]
            .filter(
              row =>
                new Date(row.entry_close_at).getTime() > now
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
