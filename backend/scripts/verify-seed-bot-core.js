'use strict';

const assert = require('node:assert/strict');
const {
  APPROVED_SEED_WALLETS,
  MAIN_MANUAL_WALLET,
  STAKE_AMOUNT_RAW,
  loadApprovedSeedWallets,
  resolveCanonicalDailyPools,
  readObservedMarketReferences,
  participationKey,
  createSeedBotDryRunPlan,
} = require('../src/services/seedBotCore');

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
  poolAddress: `0x${String(index + 1).padStart(40, '0')}`,
  ticketAddress: `0x${String(index + 101).padStart(40, '0')}`,
}));

const entryOpenAt = 1_800_000_000;
const entryCloseAt = entryOpenAt + 20 * 60 * 60;
const roundsState = {
  chain: { timestamp: entryOpenAt + 60 },
  pools: topology.map((pool, index) => ({
    poolAddress: pool.poolAddress,
    round: {
      roundId: 900 + index,
      contractStatus: 'ENTRY_OPEN',
      canEnter: true,
      entryOpenAt: new Date(entryOpenAt * 1000).toISOString(),
      entryCloseAt: new Date(entryCloseAt * 1000).toISOString(),
      marketPeriodStartAt: new Date(entryOpenAt * 1000).toISOString(),
    },
  })),
};

const marketReferences = {
  BTC: {
    available: true,
    markPriceCents: '6500000',
    observedHighCents: '6600000',
    observedLowCents: '6400000',
    elapsedSeconds: '36000',
    remainingSeconds: '36000',
  },
  ETH: {
    available: true,
    markPriceCents: '250000',
    observedHighCents: '255000',
    observedLowCents: '245000',
    elapsedSeconds: '36000',
    remainingSeconds: '36000',
  },
  SOL: {
    available: true,
    markPriceCents: '15000',
    observedHighCents: '15300',
    observedLowCents: '14700',
    elapsedSeconds: '36000',
    remainingSeconds: '36000',
  },
  HYPE: {
    available: true,
    markPriceCents: '4200',
    observedHighCents: '4300',
    observedLowCents: '4100',
    elapsedSeconds: '36000',
    remainingSeconds: '36000',
  },
};

const healthyFunding = new Map(
  APPROVED_SEED_WALLETS.map((wallet) => [wallet.toLowerCase(), {
    usdcRaw: (STAKE_AMOUNT_RAW * 100n).toString(),
    nativeRaw: '1000000000000000000',
    requiredGasRaw: '1000000000000',
  }]),
);

async function main() {
  const dbRows = APPROVED_SEED_WALLETS.map((wallet) => ({ wallet_address: wallet }));
  const dbClient = {
    async query(sql, params) {
      assert.match(sql, /extrema_wallets/);
      assert.ok(Array.isArray(params?.[0]));
      return { rows: dbRows };
    },
  };

  const wallets = await loadApprovedSeedWallets({ dbClient });
  assert.equal(wallets.length, 9, 'exactly nine approved seed wallets');
  assert.equal(wallets.some((wallet) => wallet.toLowerCase() === MAIN_MANUAL_WALLET.toLowerCase()), false);

  const dailyPools = resolveCanonicalDailyPools(topology);
  assert.equal(dailyPools.length, 8, 'exactly eight canonical daily pools');

  const observedFixtures = {
    BTCUSDT: { mark: '65000', high: '6600000', low: '6400000' },
    ETHUSDT: { mark: '2500', high: '255000', low: '245000' },
    SOLUSDT: { mark: '150', high: '15300', low: '14700' },
    HYPEUSDT: { mark: '42', high: '4300', low: '4100' },
  };

  const observedRead = await readObservedMarketReferences({
    topology,
    roundsState,
    now: entryOpenAt + 60,
    marketLayer: {
      async getLiveMarkPrices() {
        return {
          source: 'Binance verifier fixture',
          refreshedAtIso: new Date(entryOpenAt * 1000).toISOString(),
          prices: Object.fromEntries(
            Object.entries(observedFixtures).map(([symbol, value]) => [
              symbol,
              {
                symbol,
                markPrice: value.mark,
                source: 'Binance USDⓈ-M Futures Mark Price',
                sourceTimeIso: new Date(entryOpenAt * 1000).toISOString(),
                isSettlementSource: true,
              },
            ]),
          ),
        };
      },

      async fetchMarkPriceWindow({ symbol }) {
        return { symbol };
      },

      calculateExtrema(window) {
        const value = observedFixtures[window.symbol];
        return {
          high: { resolvedPriceCents: value.high },
          low: { resolvedPriceCents: value.low },
        };
      },
    },
  });

  for (const [asset, expected] of Object.entries({
    BTC: { high: '6600000', low: '6400000' },
    ETH: { high: '255000', low: '245000' },
    SOL: { high: '15300', low: '14700' },
    HYPE: { high: '4300', low: '4100' },
  })) {
    assert.equal(observedRead[asset].available, true);
    assert.equal(observedRead[asset].observedHighCents, expected.high);
    assert.equal(observedRead[asset].observedLowCents, expected.low);
  }

  // Seed predictions may use only an explicitly confirmed settlement
  // source. CoinGecko display fallback and an unlabeled source both fail
  // closed before any historical-window read is attempted.
  for (const sourceCase of [
    {
      name: 'coingecko-fallback',
      includeFlag: true,
      settlementFlag: false,
      source: 'CoinGecko aggregated spot price',
    },
    {
      name: 'unlabeled-source',
      includeFlag: false,
      settlementFlag: undefined,
      source: 'unlabeled verifier fixture',
    },
  ]) {
    let windowReads = 0;

    const rejected =
      await readObservedMarketReferences({
        topology,
        roundsState,
        now: entryOpenAt + 60,
        marketLayer: {
          async getLiveMarkPrices() {
            return {
              source: sourceCase.source,
              refreshedAtIso:
                new Date(
                  entryOpenAt * 1000,
                ).toISOString(),
              prices: Object.fromEntries(
                Object.entries(
                  observedFixtures,
                ).map(
                  ([symbol, value]) => {
                    const mark = {
                      symbol,
                      markPrice: value.mark,
                      source:
                        sourceCase.source,
                      sourceTimeIso:
                        new Date(
                          entryOpenAt *
                            1000,
                        ).toISOString(),
                    };

                    if (
                      sourceCase.includeFlag
                    ) {
                      mark.isSettlementSource =
                        sourceCase.settlementFlag;
                    }

                    return [
                      symbol,
                      mark,
                    ];
                  },
                ),
              ),
            };
          },

          async fetchMarkPriceWindow() {
            windowReads += 1;

            throw new Error(
              'non_settlement_source_must_not_read_window',
            );
          },

          calculateExtrema() {
            throw new Error(
              'non_settlement_source_must_not_calculate_extrema',
            );
          },
        },
      });

    for (const asset of [
      'BTC',
      'ETH',
      'SOL',
      'HYPE',
    ]) {
      assert.equal(
        rejected[asset].available,
        false,
        `${sourceCase.name} must be rejected for ${asset}`,
      );

      assert.equal(
        rejected[asset].reason,
        'market_reference_unavailable',
      );
    }

    assert.equal(
      windowReads,
      0,
      `${sourceCase.name} must fail before Binance window reads`,
    );
  }

  const driftedRoundsState =
    structuredClone(roundsState);

  driftedRoundsState.pools[1].round.marketPeriodStartAt =
    new Date(
      (entryOpenAt + 60) * 1000,
    ).toISOString();

  const pairMismatchRead =
    await readObservedMarketReferences({
      topology,
      roundsState:
        driftedRoundsState,
      now:
        entryOpenAt + 120,
      marketLayer: {
        async getLiveMarkPrices() {
          return {
            source:
              'Binance verifier fixture',
            refreshedAtIso:
              new Date(
                entryOpenAt * 1000,
              ).toISOString(),
            prices:
              Object.fromEntries(
                Object.entries(
                  observedFixtures,
                ).map(
                  ([symbol, value]) => [
                    symbol,
                    {
                      symbol,
                      markPrice:
                        value.mark,
                      source:
                        'Binance USDⓈ-M Futures Mark Price',
                      sourceTimeIso:
                        new Date(
                          entryOpenAt *
                            1000,
                        ).toISOString(),
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
        }) {
          return { symbol };
        },

        calculateExtrema(window) {
          const value =
            observedFixtures[
              window.symbol
            ];

          return {
            high: {
              resolvedPriceCents:
                value.high,
            },
            low: {
              resolvedPriceCents:
                value.low,
            },
          };
        },
      },
    });

  assert.equal(
    pairMismatchRead.BTC.available,
    false,
    'BTC HIGH/LOW window drift must fail closed',
  );

  assert.equal(
    pairMismatchRead.BTC.reason,
    'market_period_mismatch',
  );

  for (const asset of [
    'ETH',
    'SOL',
    'HYPE',
  ]) {
    assert.equal(
      pairMismatchRead[asset].available,
      true,
      `${asset} must remain available when only BTC pair drifts`,
    );
  }

  const existing = new Set([
    participationKey(wallets[0], dailyPools[0].poolAddress, 900),
  ]);
  let sendCalls = 0;
  const options = {
    wallets,
    topology,
    roundsState,
    marketReferences,
    existingParticipation: existing,
    fundingByWallet: healthyFunding,
    seed: 'seed-bot-verifier-v1',
    onchainSend: () => { sendCalls += 1; throw new Error('send_must_not_be_called'); },
  };

  const first = await createSeedBotDryRunPlan(options);
  const second = await createSeedBotDryRunPlan(options);

  assert.equal(first.wallets.length, 9);
  assert.equal(first.pools.length, 8);
  assert.equal(first.entries.length, 72, 'maximum 72 planned entries');
  assert.equal(first.counts.eligible, 71, 'one existing participation is skipped');
  assert.equal(first.executorEnabled, false);
  assert.equal(first.broadcast, false);
  assert.equal(sendCalls, 0, 'no onchain send occurs');
  assert.deepEqual(first.entries, second.entries, 'same inputs replay byte-equivalently');

  const perPool = new Map();
  const perWalletPool = new Set();
  for (const entry of first.entries) {
    assert.equal(entry.wallet.toLowerCase() === MAIN_MANUAL_WALLET.toLowerCase(), false);
    if (entry.alreadyEntered) {
      assert.equal(entry.reason, 'already_entered');
      assert.equal(entry.eligible, false);
      continue;
    }
    assert.equal(entry.eligible, true);
    assert.equal(entry.reason, 'eligible');
    assert.equal(entry.predictionPriceCents !== null, true);
    const poolKey = `${entry.poolAddress}:${entry.roundId}`;
    if (!perPool.has(poolKey)) perPool.set(poolKey, []);
    perPool.get(poolKey).push(entry);
    const walletPoolKey = `${entry.wallet.toLowerCase()}:${poolKey}`;
    assert.equal(perWalletPool.has(walletPoolKey), false, 'wallet enters each pool at most once');
    perWalletPool.add(walletPoolKey);

    const planned = Date.parse(entry.plannedExecutionAt) / 1000;
    assert.equal(planned > entryOpenAt, true);
    assert.equal(planned < entryCloseAt, true);
  }

  for (const [poolKey, poolEntries] of perPool.entries()) {
    assert.equal(poolEntries.length, poolKey.startsWith(`${dailyPools[0].poolAddress}:`) ? 8 : 9, 'eligible pool has expected entries');
    const predictionSet = new Set(poolEntries.map((entry) => entry.predictionPriceCents));
    assert.equal(predictionSet.size, poolEntries.length, 'prediction cents are unique per round');
    const sortedTimes = poolEntries.map((entry) => Date.parse(entry.plannedExecutionAt) / 1000).sort((a, b) => a - b);
    assert.equal(sortedTimes[sortedTimes.length - 1] > sortedTimes[0], true, 'pool entries span the window');
  }

  // With all nine wallets eligible, every pool has exactly nine entries and
  // the global schedule remains deterministic and broadly spaced.
  const full = await createSeedBotDryRunPlan({ ...options, existingParticipation: new Set() });
  assert.equal(full.entries.length, 72);
  assert.equal(full.executableEntries.length, 72);
  assert.equal(new Set(full.executableEntries.map((entry) => `${entry.wallet.toLowerCase()}:${entry.poolAddress}:${entry.roundId}`)).size, 72);
  const fullTimes = full.executableEntries.map((entry) => Date.parse(entry.plannedExecutionAt) / 1000).sort((a, b) => a - b);
  assert.equal(fullTimes[fullTimes.length - 1] > fullTimes[0], true);
  for (let index = 1; index < fullTimes.length; index += 1) {
    assert.equal(fullTimes[index] - fullTimes[index - 1] >= 300, true, 'five-minute global spacing');
  }
  for (const pool of dailyPools) {
    const poolEntries = full.executableEntries.filter((entry) => entry.poolAddress.toLowerCase() === pool.poolAddress.toLowerCase());
    assert.equal(poolEntries.length, 9, 'nine entries per eligible pool');
    const predictions = poolEntries.map((entry) => BigInt(entry.predictionPriceCents));
    assert.equal(new Set(predictions.map(String)).size, 9);

    const reference = marketReferences[pool.asset];
    const observedHigh = BigInt(reference.observedHighCents);
    const observedLow = BigInt(reference.observedLowCents);

    for (const entry of poolEntries) {
      assert.equal(
        entry.observedHighCents,
        reference.observedHighCents,
      );
      assert.equal(
        entry.observedLowCents,
        reference.observedLowCents,
      );

      const prediction = BigInt(entry.predictionPriceCents);

      if (pool.direction === 'HIGH') {
        assert.equal(
          prediction > observedHigh,
          true,
          `${pool.asset} HIGH prediction must extend observed high`,
        );
      } else {
        assert.equal(
          prediction < observedLow,
          true,
          `${pool.asset} LOW prediction must extend observed low`,
        );
      }
    }

    const sortedPredictions =
      [...predictions].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0
      );

    for (let index = 1; index < sortedPredictions.length; index += 1) {
      assert.equal(
        sortedPredictions[index] > sortedPredictions[index - 1],
        true,
        `${pool.asset} ${pool.direction} predictions remain unique`,
      );
    }
  }

  const unfunded = await createSeedBotDryRunPlan({
    ...options,
    existingParticipation: new Set(),
    fundingByWallet: new Map(APPROVED_SEED_WALLETS.map((wallet) => [wallet.toLowerCase(), {
      usdcRaw: '0',
      nativeRaw: '1000000000000000000',
      requiredGasRaw: '1000000000000',
    }])),
  });
  assert.equal(unfunded.executableEntries.length, 0, 'funding failure has no executable entries');
  assert.equal(unfunded.entries.every((entry) => entry.reason === 'insufficient_usdc'), true);

  assert.equal(/Math\.random|random\s*\(/.test(require('node:fs').readFileSync(require.resolve('../src/services/seedBotCore'), 'utf8')), false, 'no runtime randomness');
  console.log('seed-bot-core: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
