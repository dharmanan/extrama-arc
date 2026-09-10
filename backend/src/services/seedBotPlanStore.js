'use strict';

const { planKey } = require('./seedBotScheduler');

function requireText(value, error) {
  const text = String(value || '').trim();
  if (!text) throw new Error(error);
  return text;
}

function requirePositiveIntegerString(value, error) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(error);
  return text;
}

function requireDate(value, error) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(error);
  return date;
}

function createSeedBotPlanStore({ dbClient } = {}) {
  const database = dbClient || require('../db');

  async function persistEntries(entries = []) {
    let inserted = 0;

    for (const entry of entries) {
      if (!entry?.eligible) continue;

      const key = planKey(entry);
      const wallet = requireText(entry.wallet, 'seed_plan_wallet_invalid');
      const poolAddress = requireText(entry.poolAddress, 'seed_plan_pool_invalid');
      const poolSlug = requireText(entry.pool, 'seed_plan_slug_invalid');
      const roundId = requirePositiveIntegerString(
        entry.roundId,
        'seed_plan_round_invalid',
      );
      const plannerVersion = requireText(
        entry.plannerVersion,
        'seed_plan_version_invalid',
      );
      const prediction = requirePositiveIntegerString(
        entry.predictionPriceCents,
        'seed_plan_prediction_invalid',
      );
      const plannedAt = requireDate(
        entry.plannedExecutionAt,
        'seed_plan_execution_time_invalid',
      );
      const closeAt = requireDate(
        entry.entryCloseAt,
        'seed_plan_close_time_invalid',
      );

      if (plannedAt >= closeAt) {
        throw new Error('seed_plan_window_invalid');
      }

      const { rowCount } = await database.query(
        `INSERT INTO seed_bot_plans (
           plan_key,
           wallet_address,
           pool_address,
           pool_slug,
           round_id,
           planner_version,
           prediction_price_cents,
           planned_execution_at,
           entry_close_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (plan_key) DO UPDATE
           SET pool_slug = EXCLUDED.pool_slug,
               planner_version = EXCLUDED.planner_version,
               prediction_price_cents = EXCLUDED.prediction_price_cents,
               planned_execution_at = EXCLUDED.planned_execution_at,
               entry_close_at = EXCLUDED.entry_close_at
         WHERE seed_bot_plans.planner_version <> EXCLUDED.planner_version
           AND NOT EXISTS (
             SELECT 1
               FROM seed_bot_dispatches
              WHERE seed_bot_dispatches.plan_key = seed_bot_plans.plan_key
           )`,
        [
          key,
          wallet,
          poolAddress,
          poolSlug,
          roundId,
          plannerVersion,
          prediction,
          plannedAt.toISOString(),
          closeAt.toISOString(),
        ],
      );

      inserted += Number(rowCount || 0);
    }

    return { inserted };
  }

  async function loadOpenEntries({
    now = new Date(),
    plannerVersion = null,
  } = {}) {
    const at =
      requireDate(
        now,
        'seed_plan_now_invalid',
      );

    const requestedPlannerVersion =
      plannerVersion === null ||
      plannerVersion === undefined
        ? null
        : requireText(
            plannerVersion,
            'seed_plan_version_invalid',
          );

    const { rows } = await database.query(
      `SELECT
         plan_key,
         wallet_address,
         pool_address,
         pool_slug,
         round_id,
         planner_version,
         prediction_price_cents,
         planned_execution_at,
         entry_close_at
       FROM seed_bot_plans
       WHERE entry_close_at > $1
         AND (
           $2::text IS NULL
           OR planner_version = $2
         )
       ORDER BY planned_execution_at ASC, plan_key ASC`,
      [
        at.toISOString(),
        requestedPlannerVersion,
      ],
    );

    return rows.map((row) => ({
      wallet: row.wallet_address,
      pool: row.pool_slug,
      poolAddress: row.pool_address,
      roundId: String(row.round_id),
      plannerVersion: row.planner_version,
      predictionPriceCents: String(row.prediction_price_cents),
      plannedExecutionAt: new Date(row.planned_execution_at).toISOString(),
      entryCloseAt: new Date(row.entry_close_at).toISOString(),
      eligible: true,
      alreadyEntered: false,
    }));
  }

  return Object.freeze({
    persistEntries,
    loadOpenEntries,
  });
}

module.exports = {
  createSeedBotPlanStore,
};
