'use strict';

const assert = require('node:assert/strict');
const {
  APPROVED_SEED_WALLETS,
  MAIN_MANUAL_WALLET,
  STAKE_AMOUNT_RAW,
  loadApprovedSeedWallets,
  resolveCanonicalDailyPools,
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
  BTC: { available: true, markPriceCents: '6500000' },
  ETH: { available: true, markPriceCents: '250000' },
  SOL: { available: true, markPriceCents: '15000' },
  HYPE: { available: true, markPriceCents: '4200' },
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
    const mark = BigInt(marketReferences[pool.asset].markPriceCents);
    assert.equal(predictions.some((value) => value < mark), true);
    assert.equal(predictions.some((value) => value > mark), true);
    const predictionSpread = predictions.reduce((minMax, value) => ({
      min: value < minMax.min ? value : minMax.min,
      max: value > minMax.max ? value : minMax.max,
    }), { min: predictions[0], max: predictions[0] });
    assert.equal(predictionSpread.max - predictionSpread.min > mark / 100n, true, 'predictions are broadly distributed');
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
