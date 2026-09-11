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
  generateDeterministicPredictions,
  resolveDeterministicPredictionSlot,
} = require('../src/services/seedBotCore');

function compareBigInt(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Shared v3 prediction safety invariants for one pool's nine predictions:
// positive, strictly beyond the already observed extreme, unique, and spread
// out with no two predictions closer than the algorithm's own minimum gap
// floor (0.01% of the current mark, at least one cent).
function assertPoolPredictionSafety(label, predictionCents, { direction, markPriceCents, observedHighCents, observedLowCents }) {
  const values = predictionCents.map((value) => BigInt(value));
  assert.equal(values.length, 9, `${label}: nine predictions`);
  assert.equal(new Set(values.map(String)).size, 9, `${label}: all nine prices are unique`);

  const observedHigh = BigInt(observedHighCents);
  const observedLow = BigInt(observedLowCents);
  for (const value of values) {
    assert.equal(value > 0n, true, `${label}: prediction must be positive`);
    if (direction === 'HIGH') {
      assert.equal(value > observedHigh, true, `${label}: HIGH ${value} must be strictly above observed high ${observedHigh}`);
    } else {
      assert.equal(value < observedLow, true, `${label}: LOW ${value} must be strictly below observed low ${observedLow}`);
    }
  }

  const mark = BigInt(markPriceCents);
  const gapFloor = mark / 10_000n > 0n ? mark / 10_000n : 1n;
  const sorted = [...values].sort(compareBigInt);
  for (let index = 1; index < sorted.length; index += 1) {
    assert.equal(
      sorted[index] - sorted[index - 1] >= gapFloor,
      true,
      `${label}: adjacent predictions must not cluster (gap ${sorted[index] - sorted[index - 1]} < ${gapFloor})`,
    );
  }
  assert.equal(sorted[sorted.length - 1] - sorted[0] >= gapFloor * 8n, true, `${label}: risk profiles must spread out`);
  return sorted;
}

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

  // =========================================================================
  // v3 prediction safety. Verification only; the algorithm is unchanged.
  // =========================================================================

  // 1. All 8 DAILY pools x 9 approved seed wallets = 72 predictions when
  //    every market reference is available.
  const approvedKeys = APPROVED_SEED_WALLETS.map((wallet) => wallet.toLowerCase()).sort();
  const fullPredictions = full.executableEntries.filter((entry) => entry.predictionPriceCents !== null);
  assert.equal(fullPredictions.length, 72, '72 predictions with all market references available');
  for (const pool of dailyPools) {
    const poolEntries = fullPredictions.filter((entry) => entry.poolAddress.toLowerCase() === pool.poolAddress.toLowerCase());
    assert.deepEqual(
      poolEntries.map((entry) => entry.wallet.toLowerCase()).sort(),
      approvedKeys,
      `${pool.asset} ${pool.direction}: every approved seed wallet predicts exactly once`,
    );
    // 2, 3, 4 and 6 for every live shaped pool.
    const reference = marketReferences[pool.asset];
    assertPoolPredictionSafety(`plan ${pool.asset} ${pool.direction}`, poolEntries.map((entry) => entry.predictionPriceCents), {
      direction: pool.direction,
      ...reference,
    });
  }

  // 5. Same inputs produce exactly the same predictions.
  const fullReplay = await createSeedBotDryRunPlan({ ...options, existingParticipation: new Set() });
  assert.deepEqual(
    fullReplay.executableEntries.map((entry) => entry.predictionPriceCents),
    full.executableEntries.map((entry) => entry.predictionPriceCents),
    'same inputs replay the same 72 predictions',
  );

  const V3_SEED = 'extrema-seed-bot-v3';
  const POOL_KEY = '0x0000000000000000000000000000000000000001:8:1800000000';
  const predict = (reference, direction, overrides = {}) => generateDeterministicPredictions({
    ...reference,
    direction,
    wallets: APPROVED_SEED_WALLETS,
    seed: V3_SEED,
    poolKey: POOL_KEY,
    ...overrides,
  });

  // 6. Different risk profiles spread across the projected extension rather
  //    than clustering: on a normal BTC day the nine predictions cover at
  //    least half of the observed range, never two within 0.01% of mark.
  const normalBtc = {
    markPriceCents: '6500000',
    observedHighCents: '6600000',
    observedLowCents: '6400000',
    elapsedSeconds: '36000',
    remainingSeconds: '36000',
  };
  for (const direction of ['HIGH', 'LOW']) {
    const sorted = assertPoolPredictionSafety(`normal BTC ${direction}`, Object.values(predict(normalBtc, direction)), {
      direction,
      ...normalBtc,
    });
    assert.equal(sorted[8] - sorted[0] >= 100_000n, true, `normal BTC ${direction}: spread covers at least half the observed range`);
  }

  // 7. The time projection clamp is preserved: sqrt(remaining / elapsed) is
  //    held to [0.25x, 2.5x]. Ratios past either bound produce predictions
  //    identical to the bound itself, and the two bounds differ.
  const atRatio = (elapsedSeconds, remainingSeconds) => ({ ...normalBtc, elapsedSeconds, remainingSeconds });
  for (const direction of ['HIGH', 'LOW']) {
    const upperBound = predict(atRatio('3600', '22500'), direction); // ratio 6.25, scale exactly 2.5x
    assert.deepEqual(predict(atRatio('60', '72000'), direction), upperBound, `${direction}: scale above 2.5x is clamped to 2.5x`);
    assert.deepEqual(predict(atRatio('1', '1000000000'), direction), upperBound, `${direction}: extreme early ratio is clamped to 2.5x`);

    const lowerBound = predict(atRatio('36000', '2250'), direction); // ratio 0.0625, scale exactly 0.25x
    assert.deepEqual(predict(atRatio('72000', '60'), direction), lowerBound, `${direction}: scale below 0.25x is clamped to 0.25x`);
    assert.deepEqual(predict(atRatio('60', '0'), direction), lowerBound, `${direction}: no remaining time uses the 0.25x floor`);

    const middle = predict(atRatio('36000', '36000'), direction); // scale 1.0x
    const outermost = (predictions) => {
      const values = Object.values(predictions).map((value) => BigInt(value)).sort(compareBigInt);
      return direction === 'HIGH' ? values[8] : values[0];
    };
    const distance = (predictions) => {
      const edge = outermost(predictions);
      return direction === 'HIGH' ? edge - BigInt(normalBtc.observedHighCents) : BigInt(normalBtc.observedLowCents) - edge;
    };
    assert.equal(distance(lowerBound) < distance(middle), true, `${direction}: 0.25x projects less than 1.0x`);
    assert.equal(distance(middle) < distance(upperBound), true, `${direction}: 1.0x projects less than 2.5x`);
  }

  // 8. Pathological fixtures keep positive prices and the observed extreme
  //    invariants in both directions.
  const pathological = {
    'nearly flat first hour': {
      markPriceCents: '6500000', observedHighCents: '6500100', observedLowCents: '6499900',
      elapsedSeconds: '3600', remainingSeconds: '68400',
    },
    'unusually volatile first hour': {
      markPriceCents: '6500000', observedHighCents: '6800000', observedLowCents: '6200000',
      elapsedSeconds: '3600', remainingSeconds: '68400',
    },
    'very early round': {
      markPriceCents: '6500000', observedHighCents: '6501000', observedLowCents: '6499000',
      elapsedSeconds: '60', remainingSeconds: '71940',
    },
    'late round': {
      markPriceCents: '6500000', observedHighCents: '6575000', observedLowCents: '6425000',
      elapsedSeconds: '71000', remainingSeconds: '60',
    },
    'low priced asset': {
      markPriceCents: '125', observedHighCents: '127', observedLowCents: '123',
      elapsedSeconds: '36000', remainingSeconds: '36000',
    },
  };
  for (const [name, reference] of Object.entries(pathological)) {
    for (const direction of ['HIGH', 'LOW']) {
      const predictions = predict(reference, direction);
      assert.deepEqual(Object.keys(predictions).sort(), approvedKeys, `${name} ${direction}: one prediction per approved wallet`);
      assertPoolPredictionSafety(`${name} ${direction}`, Object.values(predictions), { direction, ...reference });
      assert.deepEqual(predict(reference, direction), predictions, `${name} ${direction}: deterministic replay`);
    }
  }

  // 10. A taken prediction slot only ever moves outward: HIGH to a higher
  //     price, LOW to a lower price, and never onto another taken slot.
  const slot = (predictionPriceCents, direction, blockedPriceCents) => resolveDeterministicPredictionSlot({
    predictionPriceCents,
    markPriceCents: '6500000',
    direction,
    wallet: APPROVED_SEED_WALLETS[0],
    seed: V3_SEED,
    poolKey: POOL_KEY,
    blockedPriceCents,
  });
  assert.equal(slot('6700000', 'HIGH', []), '6700000', 'an untaken slot is kept as is');
  assert.equal(slot('6300000', 'LOW', ['6300001']), '6300000', 'an unrelated taken slot changes nothing');
  assert.equal(slot('6700000', 'HIGH', ['6700000', '6700001']), '6700002');
  assert.equal(slot('6300000', 'LOW', ['6300000', '6299999']), '6299998');
  for (const blockedCount of [1, 2, 5, 17]) {
    const highBlocked = Array.from({ length: blockedCount }, (_, index) => String(6_700_000n + BigInt(index)));
    const lowBlocked = Array.from({ length: blockedCount }, (_, index) => String(6_300_000n - BigInt(index)));
    // Slots on the inward side are taken too; they must never be chosen.
    highBlocked.push('6699999');
    lowBlocked.push('6300001');
    const highSlot = BigInt(slot('6700000', 'HIGH', highBlocked));
    const lowSlot = BigInt(slot('6300000', 'LOW', lowBlocked));
    assert.equal(highSlot > 6_700_000n, true, 'HIGH collision moves higher');
    assert.equal(lowSlot < 6_300_000n, true, 'LOW collision moves lower');
    assert.equal(highBlocked.includes(String(highSlot)), false);
    assert.equal(lowBlocked.includes(String(lowSlot)), false);
  }

  assert.equal(/Math\.random|random\s*\(/.test(require('node:fs').readFileSync(require.resolve('../src/services/seedBotCore'), 'utf8')), false, 'no runtime randomness');
  console.log('seed-bot-core: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
