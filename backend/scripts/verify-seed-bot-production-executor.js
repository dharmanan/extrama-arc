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
    slug:
      `${asset.toLowerCase()}-daily-${direction.toLowerCase()}`,
    poolAddress:
      `0x${String(index + 1).padStart(40, '0')}`,
    ticketAddress:
      `0x${String(index + 101).padStart(40, '0')}`,
  }));

  const btcHigh = topology[0];

  const entry = {
    wallet,
    pool: btcHigh.slug,
    poolAddress: btcHigh.poolAddress,
    roundId: '8',

    // Deliberately stale persisted value.
    predictionPriceCents: '6500000',

    plannedExecutionAt:
      '2026-09-11T03:00:00.000Z',
    entryOpenAt:
      '2026-09-11T00:00:00.000Z',
    entryCloseAt:
      '2026-09-11T20:00:00.000Z',

    plannerVersion:
      'extrema-seed-bot-v3',

    eligible: true,
    alreadyEntered: false,
  };

  const marketStart =
    Date.parse(
      '2026-09-11T00:00:00.000Z',
    ) / 1000;

  const marketEnd =
    Date.parse(
      '2026-09-12T00:00:00.000Z',
    ) / 1000;

  const executionTime =
    Date.parse(
      '2026-09-11T03:00:00.000Z',
    ) / 1000;

  const roundsState = {
    chain: {
      timestamp: executionTime,
    },

    pools: topology.map((pool, index) => ({
      poolAddress: pool.poolAddress,

      round: {
        roundId: 8 + index,
        contractStatus:
          'ENTRY_OPEN',
        canEnter: true,

        entryOpenAt:
          new Date(
            marketStart * 1000,
          ).toISOString(),

        entryCloseAt:
          new Date(
            (
              marketStart +
              20 * 60 * 60
            ) * 1000,
          ).toISOString(),

        marketPeriodStartAt:
          new Date(
            marketStart * 1000,
          ).toISOString(),

        marketPeriodEndAt:
          new Date(
            marketEnd * 1000,
          ).toISOString(),
      },
    })),
  };

  // Production executor requires the current pool
  // to still be the same round.
  roundsState.pools[0].round.roundId = 8;

  const fixtures = {
    BTCUSDT: {
      mark: '65000',
      high: '6700000',
      low: '6300000',
    },

    ETHUSDT: {
      mark: '2500',
      high: '260000',
      low: '240000',
    },

    SOLUSDT: {
      mark: '150',
      high: '15500',
      low: '14500',
    },

    HYPEUSDT: {
      mark: '42',
      high: '4400',
      low: '4000',
    },
  };

  let liveReads = 0;
  let broadcasts = 0;
  let capturedCandidate = null;
  let capturedPayload = null;

  const executor =
    createSeedBotProductionExecutor({
      topology,

      clock: () =>
        executionTime * 1000,

      arcService: {
        ARC_POOL_TOPOLOGY:
          topology,

        async getStandardRoundsState({
          forceFresh,
        }) {
          assert.equal(
            forceFresh,
            true,
          );

          return roundsState;
        },
      },

      marketLayer: {
        async getLiveMarkPrices({
          forceFresh,
        }) {
          assert.equal(
            forceFresh,
            true,
          );

          return {
            source:
              'Binance verifier fixture',

            prices:
              Object.fromEntries(
                Object.entries(fixtures)
                  .map(
                    ([symbol, value]) => [
                      symbol,
                      {
                        symbol,
                        markPrice:
                          value.mark,
                        source:
                          'Binance USDⓈ-M Futures Mark Price',
                        isSettlementSource:
                          true,
                      },
                    ],
                  ),
              ),
          };
        },

        async fetchMarkPriceWindow({
          symbol,
          cadence,
        }) {
          assert.equal(
            cadence,
            'DAILY',
          );

          return { symbol };
        },

        calculateExtrema(window) {
          const fixture =
            fixtures[window.symbol];

          return {
            high: {
              resolvedPriceCents:
                fixture.high,
            },

            low: {
              resolvedPriceCents:
                fixture.low,
            },
          };
        },
      },

      dbClient: {
        async query() {
          return {
            rows: [{
              user_id:
                'seed-user-1',
              wallet_address:
                wallet,
            }],
          };
        },
      },

      liveStateService: {
        async readFreshSeedEntryState(
          candidate,
        ) {
          liveReads += 1;
          capturedCandidate = candidate;

          assert.equal(
            candidate.poolAddress
              .toLowerCase(),
            btcHigh.poolAddress
              .toLowerCase(),
          );

          assert.equal(
            String(
              candidate.roundId,
            ),
            '8',
          );

          // The stale DB prediction must have
          // been replaced before this read.
          assert.notEqual(
            candidate
              .predictionPriceCents,
            entry
              .predictionPriceCents,
          );

          assert.equal(
            BigInt(
              candidate
                .predictionPriceCents,
            ) > 6700000n,
            true,
            'fresh HIGH prediction must extend current observed high',
          );

          return {
            liveState: {
              chainId: 5042002,
              chainTimestamp:
                executionTime,

              poolAddress:
                btcHigh.poolAddress,

              ticketAddress:
                btcHigh.ticketAddress,

              roundId: 8,
              roundStatus: 0,

              entryOpenAt:
                marketStart,

              entryCloseAt:
                marketStart +
                20 * 60 * 60,

              hasEntered: false,
              predictionTaken: false,

              usdcRaw:
                '100000000',

              nativeRaw:
                '1000000000000000000',
            },
          };
        },
      },

      entryExecutionService: {
        async executeEntry(
          userId,
          payload,
        ) {
          broadcasts += 1;

          capturedPayload = {
            userId,
            payload,
          };

          return {
            entryTxHash:
              `0x${'1'.repeat(64)}`,

            walletAddress:
              payload.walletAddress,

            poolAddress:
              payload.contract,

            roundId:
              payload.roundId,

            predictionPriceCents:
              payload.predictionPriceCents,
          };
        },
      },
    });

  assert.equal(
    executor.liveEnabled,
    true,
  );

  const result =
    await executor.executeDueEntry(
      entry,
      {
        idempotencyKey:
          'seed:test:round8',
      },
    );

  assert.equal(
    liveReads,
    1,
    'fresh market prediction receives one live chain read',
  );

  assert.equal(
    broadcasts,
    1,
    'only one financial entry executes',
  );

  assert.equal(
    result.executed,
    true,
  );

  assert.equal(
    result.reason,
    'executed',
  );

  assert.equal(
    capturedPayload.userId,
    'seed-user-1',
  );

  assert.equal(
    capturedPayload.payload
      .executionMode,
    'SYSTEM_SEED_WALLET',
  );

  assert.equal(
    capturedPayload.payload
      .amountRaw,
    '1000000',
  );

  assert.equal(
    capturedPayload.payload
      .roundId,
    8,
  );

  assert.equal(
    String(
      capturedPayload.payload
        .predictionPriceCents,
    ),
    capturedCandidate
      .predictionPriceCents,
    'executed price is exactly the fresh checked price',
  );

  assert.equal(
    BigInt(
      capturedPayload.payload
        .predictionPriceCents,
    ) > 6700000n,
    true,
  );

  assert.match(
    capturedPayload.payload.nonce,
    /^seed:seed:test:round8$/,
  );

  const liveReadsBeforeStale =
    liveReads;

  const broadcastsBeforeStale =
    broadcasts;

  await assert.rejects(
    () =>
      executor.executeDueEntry(
        {
          ...entry,
          plannerVersion:
            'extrema-seed-bot-v2',
        },
        {
          idempotencyKey:
            'seed:test:stale-version',
        },
      ),
    /seed_planner_version_unsupported/,
  );

  assert.equal(
    liveReads,
    liveReadsBeforeStale,
    'stale planner version must fail before live reads',
  );

  assert.equal(
    broadcasts,
    broadcastsBeforeStale,
    'stale planner version must never broadcast',
  );

  console.log(
    'seed-bot-production-executor: PASS',
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
