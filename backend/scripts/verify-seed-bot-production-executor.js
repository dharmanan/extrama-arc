'use strict';

const assert = require('node:assert/strict');
const {
  APPROVED_SEED_WALLETS,
} = require('../src/services/seedBotCore');
const {
  createSeedBotProductionExecutor,
} = require('../src/services/seedBotProductionExecutor');

async function main() {
  const wallet = APPROVED_SEED_WALLETS[0];
  const poolAddress =
    '0x0000000000000000000000000000000000000001';
  const ticketAddress =
    '0x0000000000000000000000000000000000000002';

  const topology = [
    ['BTC', 'HIGH'],
    ['BTC', 'LOW'],
    ['ETH', 'HIGH'],
    ['ETH', 'LOW'],
    ['SOL', 'HIGH'],
    ['SOL', 'LOW'],
    ['HYPE', 'HIGH'],
    ['HYPE', 'LOW'],
  ].map(([asset, direction], index) => ({
    asset,
    direction,
    cadence: 'DAILY',
    poolAddress:
      index === 0
        ? poolAddress
        : `0x${String(index + 10).padStart(40, '0')}`,
    ticketAddress:
      index === 0
        ? ticketAddress
        : `0x${String(index + 110).padStart(40, '0')}`,
  }));

  const entry = {
    wallet,
    pool: 'btc-daily-high',
    poolAddress,
    roundId: '8',
    predictionPriceCents: '6500000',
    plannedExecutionAt: '2026-09-11T03:00:00.000Z',
    entryOpenAt: '2026-09-11T00:00:00.000Z',
    entryCloseAt: '2026-09-11T20:00:00.000Z',
    plannerVersion: 'extrema-seed-bot-v1',
    eligible: true,
    alreadyEntered: false,
  };

  let liveReads = 0;
  let broadcasts = 0;
  let captured = null;

  const executor = createSeedBotProductionExecutor({
    topology,
    clock: () => Date.parse('2026-09-11T03:00:00.000Z'),
    dbClient: {
      async query() {
        return {
          rows: [{
            user_id: 'seed-user-1',
            wallet_address: wallet,
          }],
        };
      },
    },
    liveStateService: {
      async readFreshSeedEntryState(received) {
        liveReads += 1;
        assert.equal(received, entry);

        return {
          topology: {
            asset: 'BTC',
            direction: 'HIGH',
            cadence: 'DAILY',
            slug: 'btc-daily-high',
            poolAddress,
            ticketAddress,
          },
          liveState: {
            chainId: 5042002,
            chainTimestamp:
              Math.floor(
                Date.parse('2026-09-11T03:00:00.000Z') / 1000,
              ),
            poolAddress,
            ticketAddress,
            roundId: 8,
            roundStatus: 0,
            entryOpenAt:
              Math.floor(
                Date.parse('2026-09-11T00:00:00.000Z') / 1000,
              ),
            entryCloseAt:
              Math.floor(
                Date.parse('2026-09-11T20:00:00.000Z') / 1000,
              ),
            hasEntered: false,
            predictionTaken: false,
            usdcRaw: '100000000',
            nativeRaw: '1000000000000000000',
          },
        };
      },
    },
    entryExecutionService: {
      async executeEntry(userId, payload) {
        broadcasts += 1;
        captured = { userId, payload };

        return {
          entryTxHash: `0x${'1'.repeat(64)}`,
          walletAddress: payload.walletAddress,
          poolAddress: payload.contract,
          roundId: payload.roundId,
          predictionPriceCents:
            payload.predictionPriceCents,
        };
      },
    },
  });

  assert.equal(executor.liveEnabled, true);

  const result = await executor.executeDueEntry(entry, {
    idempotencyKey: 'seed:test:round8',
  });

  assert.equal(liveReads, 1);
  assert.equal(broadcasts, 1);
  assert.equal(result.executed, true);
  assert.equal(result.reason, 'executed');

  assert.equal(captured.userId, 'seed-user-1');
  assert.equal(captured.payload.action, 'ENTRY');
  assert.equal(
    captured.payload.executionMode,
    'SYSTEM_SEED_WALLET',
  );
  assert.equal(captured.payload.amountRaw, '1000000');
  assert.equal(captured.payload.roundId, 8);
  assert.equal(
    captured.payload.predictionPriceCents,
    6500000,
  );
  assert.match(
    captured.payload.nonce,
    /^seed:seed:test:round8$/,
  );

  console.log('seed-bot-production-executor: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
