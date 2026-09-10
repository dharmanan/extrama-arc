'use strict';

const {
  EXECUTION_MODES,
  createSeedBotExecutionService,
} = require('./seedBotExecutionService');

const {
  APPROVED_SEED_WALLETS,
  readObservedMarketReferences,
  generateDeterministicPredictions,
} = require('./seedBotCore');

function addressKey(value) {
  return String(value || '').toLowerCase();
}

function createSeedBotProductionExecutor({
  liveStateService,
  entryExecutionService,
  dbClient,
  topology = null,
  arcService = null,
  marketLayer = null,
  clock = () => Date.now(),
} = {}) {
  const resolvedArcService =
    arcService || require('./arcService');

  const resolvedMarketLayer =
    marketLayer ||
    require('./binanceResolverService');

  const resolvedLiveStateService =
    liveStateService ||
    require('./seedBotLiveStateService');

  const resolvedEntryExecutionService =
    entryExecutionService ||
    require('./entryExecutionService');

  const resolvedTopology =
    topology ||
    resolvedArcService.ARC_POOL_TOPOLOGY;

  if (
    !resolvedLiveStateService ||
    typeof resolvedLiveStateService.readFreshSeedEntryState !==
      'function'
  ) {
    throw new Error(
      'seed_live_state_service_required',
    );
  }

  if (
    !resolvedEntryExecutionService ||
    typeof resolvedEntryExecutionService.executeEntry !==
      'function'
  ) {
    throw new Error(
      'seed_entry_executor_required',
    );
  }

  if (
    !resolvedArcService ||
    typeof resolvedArcService.getStandardRoundsState !==
      'function'
  ) {
    throw new Error(
      'seed_round_state_service_required',
    );
  }

  const bridge =
    createSeedBotExecutionService({
      mode: EXECUTION_MODES.LIVE,
      dbClient,
      clock,
      liveEntryExecutor:
        resolvedEntryExecutionService.executeEntry.bind(
          resolvedEntryExecutionService,
        ),
    });

  async function refreshPrediction(entry) {
    if (
      entry?.plannerVersion !==
      'extrema-seed-bot-v3'
    ) {
      throw new Error(
        'seed_planner_version_unsupported',
      );
    }
    const pool =
      resolvedTopology.find(
        item =>
          item.cadence === 'DAILY' &&
          addressKey(item.poolAddress) ===
            addressKey(entry.poolAddress),
      );

    if (!pool) {
      throw new Error(
        'seed_execution_pool_not_canonical',
      );
    }

    const roundsState =
      await resolvedArcService.getStandardRoundsState({
        forceFresh: true,
      });

    const poolState =
      roundsState?.pools?.find(
        state =>
          addressKey(state.poolAddress) ===
          addressKey(pool.poolAddress),
      );

    const currentRoundId =
      poolState?.round?.roundId ??
      poolState?.roundId;

    if (
      String(currentRoundId) !==
      String(entry.roundId)
    ) {
      throw new Error(
        'seed_execution_round_not_current',
      );
    }

    const references =
      await readObservedMarketReferences({
        marketLayer:
          resolvedMarketLayer,
        roundsState,
        topology:
          resolvedTopology,
        now:
          roundsState?.chain?.timestamp,
        forceFresh: true,
      });

    const reference =
      references[pool.asset];

    if (
      !reference ||
      reference.available === false
    ) {
      throw new Error(
        `seed_execution_market_reference_unavailable:${pool.asset}`,
      );
    }

    const marketStartMs =
      Date.parse(
        reference.marketPeriodStartAt,
      );

    if (!Number.isFinite(marketStartMs)) {
      throw new Error(
        'seed_execution_market_start_invalid',
      );
    }

    const marketStartEpoch =
      Math.floor(
        marketStartMs / 1000,
      );

    const predictions =
      generateDeterministicPredictions({
        markPriceCents:
          reference.markPriceCents,
        observedHighCents:
          reference.observedHighCents,
        observedLowCents:
          reference.observedLowCents,
        elapsedSeconds:
          reference.elapsedSeconds,
        remainingSeconds:
          reference.remainingSeconds,
        direction:
          pool.direction,
        wallets:
          APPROVED_SEED_WALLETS,
        seed:
          entry.plannerVersion,
        poolKey:
          `${pool.poolAddress}:${entry.roundId}:${marketStartEpoch}`,
      });

    const predictionPriceCents =
      predictions[
        addressKey(entry.wallet)
      ];

    if (!predictionPriceCents) {
      throw new Error(
        'seed_execution_prediction_unavailable',
      );
    }

    return {
      ...entry,
      asset: pool.asset,
      direction: pool.direction,
      marketReferenceCents:
        String(
          reference.markPriceCents,
        ),
      observedHighCents:
        String(
          reference.observedHighCents,
        ),
      observedLowCents:
        String(
          reference.observedLowCents,
        ),
      observedRangeCents:
        String(
          reference.observedRangeCents,
        ),
      predictionPriceCents,
    };
  }

  async function executeDueEntry(
    entry,
    { idempotencyKey } = {},
  ) {
    // Persisted plans determine WHO enters WHICH pool and WHEN.
    // The financial prediction itself is refreshed immediately
    // before execution from the current observed market extrema.
    let candidate =
      await refreshPrediction(entry);

    const MAX_COLLISION_ATTEMPTS = 8;

    for (
      let attempt = 0;
      attempt <= MAX_COLLISION_ATTEMPTS;
      attempt += 1
    ) {
      const { liveState } =
        await resolvedLiveStateService
          .readFreshSeedEntryState(
            candidate,
          );

      const result =
        await bridge.executeDueEntry(
          candidate,
          {
            liveState,
            topology:
              resolvedTopology,
            idempotencyKey,
          },
        );

      if (
        result?.reason !==
          'entry_price_taken' ||
        !result
          ?.replacementPredictionPriceCents
      ) {
        return result;
      }

      if (
        attempt ===
        MAX_COLLISION_ATTEMPTS
      ) {
        return {
          mode: 'LIVE',
          executed: false,
          skipped: true,
          retryable: true,
          reason:
            'entry_price_collision_exhausted',
        };
      }

      candidate = {
        ...candidate,
        predictionPriceCents:
          result
            .replacementPredictionPriceCents,
      };
    }

    return {
      mode: 'LIVE',
      executed: false,
      skipped: true,
      retryable: true,
      reason:
        'entry_price_collision_exhausted',
    };
  }

  return Object.freeze({
    executeDueEntry,
    liveEnabled: bridge.liveEnabled,
  });
}

module.exports = {
  createSeedBotProductionExecutor,
};
