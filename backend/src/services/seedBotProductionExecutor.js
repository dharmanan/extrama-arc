'use strict';

const {
  EXECUTION_MODES,
  createSeedBotExecutionService,
} = require('./seedBotExecutionService');

function createSeedBotProductionExecutor({
  liveStateService,
  entryExecutionService,
  dbClient,
  topology = null,
  clock = () => Date.now(),
} = {}) {
  const resolvedLiveStateService =
    liveStateService || require('./seedBotLiveStateService');

  const resolvedEntryExecutionService =
    entryExecutionService || require('./entryExecutionService');

  const resolvedTopology =
    topology || require('./arcService').ARC_POOL_TOPOLOGY;

  if (
    !resolvedLiveStateService ||
    typeof resolvedLiveStateService.readFreshSeedEntryState !== 'function'
  ) {
    throw new Error('seed_live_state_service_required');
  }

  if (
    !resolvedEntryExecutionService ||
    typeof resolvedEntryExecutionService.executeEntry !== 'function'
  ) {
    throw new Error('seed_entry_executor_required');
  }

  const bridge = createSeedBotExecutionService({
    mode: EXECUTION_MODES.LIVE,
    dbClient,
    clock,
    liveEntryExecutor:
      resolvedEntryExecutionService.executeEntry.bind(
        resolvedEntryExecutionService,
      ),
  });

  async function executeDueEntry(
    entry,
    { idempotencyKey } = {},
  ) {
    const { liveState } =
      await resolvedLiveStateService.readFreshSeedEntryState(entry);

    return bridge.executeDueEntry(entry, {
      liveState,
      topology: resolvedTopology,
      idempotencyKey,
    });
  }

  return Object.freeze({
    executeDueEntry,
    liveEnabled: bridge.liveEnabled,
  });
}

module.exports = {
  createSeedBotProductionExecutor,
};
