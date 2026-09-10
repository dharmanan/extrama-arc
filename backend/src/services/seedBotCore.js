'use strict';

const { ethers } = require('ethers');
const { decimalToCentsHalfUp } = require('./binanceResolverService');

const MAIN_MANUAL_WALLET = '0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b';

// This is a public-address allow-list, not key material. The database remains
// authoritative for the encrypted wallet records; the allow-list prevents the
// manual wallet (and any future organic wallet) from entering seed planning.
const APPROVED_SEED_WALLETS = Object.freeze([
  '0x995f659CD0AEd5ac3ac9D238cCeC74AdD5347A97',
  '0x8b309436e4205462328e405F33564dA9DA6cCa38',
  '0x7ccafd323A53179863D1839ef97Ee39B6BBCb6e7',
  '0x4834374779CFEDC8d7BC82dCF64eF9c37397D37F',
  '0xC10d0a64F879b8aBC65bB706Db04428d80Ec2113',
  '0x71162d671d51D03Cc006be6Cbe0517Ca7f86461e',
  '0x112c289ABb742eE3758Db71DB7ADB97ebde48804',
  '0xCea4e9785600DEDEF39BE5bb71531C9De4c97C67',
  '0x146B9657A72faeadc803E258ebeded34Cc91593D',
]);

const DAILY_ASSETS = Object.freeze(['BTC', 'ETH', 'SOL', 'HYPE']);
const DAILY_DIRECTIONS = Object.freeze(['HIGH', 'LOW']);
const SOURCE_SYMBOLS = Object.freeze({
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  HYPE: 'HYPEUSDT',
});
const STAKE_AMOUNT_RAW = 1_000_000n;

function normalizeAddress(value, errorCode) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(errorCode);
  }
}

function addressKey(value) {
  return String(value).toLowerCase();
}

function normalizeApprovedWallets() {
  return APPROVED_SEED_WALLETS.map((address) => normalizeAddress(address, 'seed_wallet_address_invalid'));
}

function assertSeedWalletSet(rows) {
  if (!Array.isArray(rows) || rows.length !== APPROVED_SEED_WALLETS.length) {
    throw new Error('seed_wallet_count_mismatch');
  }

  const approved = new Set(normalizeApprovedWallets().map(addressKey));
  const seen = new Set();
  const wallets = [];

  for (const row of rows) {
    const wallet = normalizeAddress(
      typeof row === 'string' ? row : row?.wallet_address,
      'seed_wallet_address_invalid',
    );
    const key = addressKey(wallet);
    if (key === addressKey(MAIN_MANUAL_WALLET)) {
      throw new Error('seed_wallet_main_wallet_included');
    }
    if (!approved.has(key) || seen.has(key)) {
      throw new Error('seed_wallet_allowlist_mismatch');
    }
    seen.add(key);
    wallets.push(wallet);
  }

  if (seen.size !== approved.size) {
    throw new Error('seed_wallet_allowlist_mismatch');
  }

  const order = new Map(normalizeApprovedWallets().map((address, index) => [addressKey(address), index]));
  return wallets.sort((left, right) => order.get(addressKey(left)) - order.get(addressKey(right)));
}

/**
 * Read only the public wallet addresses needed by the planner. The encrypted
 * key column is used as a non-null guard but is never selected, decrypted, or
 * returned. No signer is constructed in this module.
 */
async function loadApprovedSeedWallets({ dbClient } = {}) {
  const database = dbClient || require('../db');
  if (!database || typeof database.query !== 'function') {
    throw new Error('seed_wallet_database_unavailable');
  }

  const approved = normalizeApprovedWallets();
  const { rows } = await database.query(
    `SELECT wallet_address
       FROM extrema_wallets
      WHERE LOWER(wallet_address) = ANY($1::text[])
        AND private_key_encrypted IS NOT NULL`,
    [approved.map(addressKey)],
  );

  return assertSeedWalletSet(rows);
}

function resolveCanonicalDailyPools(topology) {
  let source = topology;
  if (!source) {
    // Lazy loading keeps the pure verifier independent from production env
    // configuration while the eventual runtime still uses the canonical Arc
    // topology exported by arcService.
    source = require('./arcService').ARC_POOL_TOPOLOGY;
  }

  if (!Array.isArray(source)) throw new Error('seed_pool_topology_unavailable');

  const daily = source
    .filter((item) => item?.cadence === 'DAILY')
    .map((item) => {
      const asset = String(item.asset || '').toUpperCase();
      const direction = String(item.direction || '').toUpperCase();
      if (!DAILY_ASSETS.includes(asset) || !DAILY_DIRECTIONS.includes(direction)) {
        throw new Error('seed_daily_pool_topology_invalid');
      }
      return {
        asset,
        direction,
        cadence: 'DAILY',
        slug: `${asset.toLowerCase()}-daily-${direction.toLowerCase()}`,
        poolAddress: normalizeAddress(item.poolAddress, 'seed_pool_address_invalid'),
        ticketAddress: normalizeAddress(item.ticketAddress, 'seed_ticket_address_invalid'),
      };
    });

  if (daily.length !== 8) throw new Error('seed_daily_pool_count_mismatch');

  const pairKeys = new Set();
  const poolKeys = new Set();
  const ticketKeys = new Set();
  for (const pool of daily) {
    const pairKey = `${pool.asset}:${pool.direction}`;
    if (pairKeys.has(pairKey)) throw new Error('seed_daily_pool_topology_duplicate');
    if (poolKeys.has(addressKey(pool.poolAddress))) throw new Error('seed_daily_pool_topology_duplicate');
    if (ticketKeys.has(addressKey(pool.ticketAddress))) throw new Error('seed_daily_pool_topology_duplicate');
    pairKeys.add(pairKey);
    poolKeys.add(addressKey(pool.poolAddress));
    ticketKeys.add(addressKey(pool.ticketAddress));
  }

  for (const asset of DAILY_ASSETS) {
    for (const direction of DAILY_DIRECTIONS) {
      if (!pairKeys.has(`${asset}:${direction}`)) {
        throw new Error('seed_daily_pool_topology_incomplete');
      }
    }
  }

  const order = new Map(
    DAILY_ASSETS.flatMap((asset) => DAILY_DIRECTIONS.map((direction, index) => [
      `${asset}:${direction}`,
      DAILY_ASSETS.indexOf(asset) * 2 + index,
    ])),
  );
  return daily.sort((left, right) => order.get(`${left.asset}:${left.direction}`) - order.get(`${right.asset}:${right.direction}`));
}


async function readLatestMarketReferences({ marketLayer, forceFresh = true } = {}) {
  const layer = marketLayer || require('./binanceResolverService');
  if (!layer || typeof layer.getLiveMarkPrices !== 'function') {
    throw new Error('seed_market_layer_unavailable');
  }

  const live = await layer.getLiveMarkPrices({ forceFresh });
  const references = {};

  for (const asset of DAILY_ASSETS) {
    const symbol = SOURCE_SYMBOLS[asset];
    const mark = live?.prices?.[symbol];

    if (
      !mark ||
      mark.unavailable ||
      mark.markPrice === undefined ||
      mark.markPrice === null
    ) {
      references[asset] = {
        available: false,
        reason: 'market_reference_unavailable',
      };
      continue;
    }

    try {
      const markPrice = String(mark.markPrice);
      const markPriceCents =
        decimalToCentsHalfUp(markPrice).toString();

      references[asset] = {
        available: true,
        symbol,
        markPrice,
        markPriceCents,
        source:
          mark.source ||
          live.source ||
          'EXTREMA live display price',
        sourceTimeIso: mark.sourceTimeIso || null,
        refreshedAtIso: live.refreshedAtIso || null,
        isSettlementSource:
          mark.isSettlementSource === true,
      };
    } catch {
      references[asset] = {
        available: false,
        reason: 'market_reference_invalid',
      };
    }
  }

  return references;
}

async function readObservedMarketReferences({
  marketLayer,
  roundsState,
  topology,
  now,
  forceFresh = true,
} = {}) {
  const layer =
    marketLayer ||
    require('./binanceResolverService');

  if (
    !layer ||
    typeof layer.getLiveMarkPrices !== 'function' ||
    typeof layer.fetchMarkPriceWindow !== 'function' ||
    typeof layer.calculateExtrema !== 'function'
  ) {
    throw new Error('seed_market_layer_unavailable');
  }

  const latest = await readLatestMarketReferences({
    marketLayer: layer,
    forceFresh,
  });

  const dailyPools =
    resolveCanonicalDailyPools(topology);

  const stateByPool =
    indexRoundStates(roundsState);

  const nowAt = parseTimestamp(
    now ?? roundsState?.chain?.timestamp,
    'seed_now_invalid',
  );

  const references = {};

  for (const asset of DAILY_ASSETS) {
    const liveReference =
      marketReferenceForAsset(latest, asset);

    if (
      !liveReference ||
      liveReference.isSettlementSource !== true
    ) {
      references[asset] = {
        available: false,
        reason: 'market_reference_unavailable',
      };
      continue;
    }

    const assetPools =
      dailyPools.filter(
        (pool) => pool.asset === asset,
      );

    const assetRounds =
      assetPools.map((pool) =>
        extractRoundState(
          stateByPool.get(
            addressKey(
              pool.poolAddress,
            ),
          ),
        ),
      );

    if (
      assetPools.length !== 2 ||
      assetRounds.length !== 2 ||
      assetRounds.some(
        (round) =>
          !round ||
          round.invalidTimes,
      )
    ) {
      references[asset] = {
        available: false,
        reason: 'market_period_unavailable',
      };
      continue;
    }

    const [round, pairedRound] =
      assetRounds;

    const pairMatches =
      round.entryOpenAt ===
        pairedRound.entryOpenAt &&
      round.entryCloseAt ===
        pairedRound.entryCloseAt &&
      round.marketPeriodStartAt ===
        pairedRound.marketPeriodStartAt &&
      round.marketPeriodEndAt ===
        pairedRound.marketPeriodEndAt;

    if (!pairMatches) {
      references[asset] = {
        available: false,
        reason: 'market_period_mismatch',
      };
      continue;
    }

    if (nowAt < round.marketPeriodStartAt) {
      references[asset] = {
        available: false,
        reason: 'market_period_not_started',
      };
      continue;
    }

    try {
      const markCents =
        liveReference.markPriceCents;

      let observedHighCents = markCents;
      let observedLowCents = markCents;

      const effectiveNow =
        nowAt < round.marketPeriodEndAt
          ? nowAt
          : round.marketPeriodEndAt;

      // Include the currently-open Binance 1m mark-price
      // candle as well as all completed candles. Binance exposes
      // the candle's high/low while it is still forming, so an
      // intraminute spike that already happened cannot be ignored.
      const observedWindowEnd =
        effectiveNow >= round.marketPeriodEndAt
          ? round.marketPeriodEndAt
          : (
              (effectiveNow + 59n) /
              60n
            ) * 60n;

      if (
        observedWindowEnd >
        round.marketPeriodStartAt
      ) {
        const window =
          await layer.fetchMarkPriceWindow({
            symbol: SOURCE_SYMBOLS[asset],
            cadence: 'DAILY',
            observationStartAt:
              new Date(
                Number(
                  round.marketPeriodStartAt,
                ) * 1000,
              ).toISOString(),
            observationEndAt:
              new Date(
                Number(
                  observedWindowEnd,
                ) * 1000,
              ).toISOString(),
          });

        const extrema =
          layer.calculateExtrema(window);

        observedHighCents = parseBigInt(
          extrema.high.resolvedPriceCents,
          'seed_observed_high_invalid',
        );

        observedLowCents = parseBigInt(
          extrema.low.resolvedPriceCents,
          'seed_observed_low_invalid',
        );

        // Also include the instantaneous mark. This protects the
        // exact execution instant even if the current kline payload
        // and premium-index read are a few milliseconds apart.
        if (nowAt < round.marketPeriodEndAt) {
          if (markCents > observedHighCents) {
            observedHighCents = markCents;
          }

          if (markCents < observedLowCents) {
            observedLowCents = markCents;
          }
        }
      }

      if (
        observedLowCents <= 0n ||
        observedHighCents < observedLowCents
      ) {
        throw new Error(
          'seed_observed_extrema_invalid',
        );
      }

      const totalSeconds =
        round.marketPeriodEndAt -
        round.marketPeriodStartAt;

      let elapsedSeconds =
        effectiveNow -
        round.marketPeriodStartAt;

      if (elapsedSeconds < 60n) {
        elapsedSeconds = 60n;
      }

      if (elapsedSeconds > totalSeconds) {
        elapsedSeconds = totalSeconds;
      }

      const remainingSeconds =
        round.marketPeriodEndAt >
        effectiveNow
          ? round.marketPeriodEndAt -
            effectiveNow
          : 0n;

      references[asset] = {
        ...liveReference,
        observedHighCents:
          observedHighCents.toString(),
        observedLowCents:
          observedLowCents.toString(),
        observedRangeCents:
          (
            observedHighCents -
            observedLowCents
          ).toString(),
        elapsedSeconds:
          elapsedSeconds.toString(),
        remainingSeconds:
          remainingSeconds.toString(),
        marketPeriodStartAt:
          new Date(
            Number(
              round.marketPeriodStartAt,
            ) * 1000,
          ).toISOString(),
        marketPeriodEndAt:
          new Date(
            Number(
              round.marketPeriodEndAt,
            ) * 1000,
          ).toISOString(),
      };
    } catch {
      references[asset] = {
        available: false,
        reason: 'market_history_unavailable',
      };
    }
  }

  return references;
}

function hashSeed(value) {
  let hash = 2166136261n;
  for (const character of String(value)) {
    hash ^= BigInt(character.codePointAt(0));
    hash = (hash * 16777619n) & 0xffffffffffffffffn;
  }
  return hash;
}

function deterministicModulo(seed, maxExclusive) {
  if (maxExclusive <= 0n) return 0n;
  return hashSeed(seed) % maxExclusive;
}

function parseBigInt(value, errorCode) {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(errorCode);
  }
}

function parseTimestamp(value, errorCode) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return BigInt(Math.floor(parsed / 1000));
  }
  throw new Error(errorCode);
}

function normalizeRoundId(value) {
  const parsed = parseBigInt(value, 'seed_round_id_invalid');
  if (parsed <= 0n) throw new Error('seed_round_id_invalid');
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}

function roundIdKey(value) {
  return String(value);
}


function extractRoundState(state) {
  const round = state?.round || state;
  if (!round) return null;

  let roundId;
  try {
    roundId = normalizeRoundId(
      round.roundId ?? state.roundId,
    );
  } catch {
    return null;
  }

  const status =
    round.contractStatus ||
    (
      Number(round.status) === 0
        ? 'ENTRY_OPEN'
        : Number(round.status) === 1
          ? 'LOCKED'
          : Number(round.status) === 2
            ? 'SETTLED'
            : Number(round.status) === 3
              ? 'CANCELLED'
              : null
    );

  let entryOpenAt;
  let entryCloseAt;
  let marketPeriodStartAt;
  let marketPeriodEndAt;

  try {
    entryOpenAt = parseTimestamp(
      round.entryOpenAt,
      'seed_round_time_invalid',
    );

    entryCloseAt = parseTimestamp(
      round.entryCloseAt,
      'seed_round_time_invalid',
    );

    marketPeriodStartAt =
      round.marketPeriodStartAt === undefined ||
      round.marketPeriodStartAt === null
        ? entryOpenAt
        : parseTimestamp(
            round.marketPeriodStartAt,
            'seed_round_time_invalid',
          );

    const explicitMarketEnd =
      round.marketPeriodEndAt ??
      round.observationEndAt;

    // seedBotCore only operates on DAILY pools. Canonical
    // DAILY market periods are exactly one UTC day.
    marketPeriodEndAt =
      explicitMarketEnd === undefined ||
      explicitMarketEnd === null
        ? marketPeriodStartAt + 24n * 60n * 60n
        : parseTimestamp(
            explicitMarketEnd,
            'seed_round_time_invalid',
          );

    if (
      marketPeriodEndAt <=
      marketPeriodStartAt
    ) {
      throw new Error();
    }
  } catch {
    return {
      roundId,
      status,
      invalidTimes: true,
    };
  }

  return {
    roundId,
    status,
    entryOpenAt,
    entryCloseAt,
    marketPeriodStartAt,
    marketPeriodEndAt,
    canEnter: round.canEnter,
  };
}

function indexRoundStates(roundsState) {
  const states = Array.isArray(roundsState) ? roundsState : roundsState?.pools;
  if (!Array.isArray(states)) throw new Error('seed_round_state_required');

  const byPool = new Map();
  for (const state of states) {
    if (!state?.poolAddress) continue;
    byPool.set(addressKey(state.poolAddress), state);
  }
  return byPool;
}


function marketReferenceForAsset(
  references,
  asset,
) {
  const value =
    references?.[asset] ||
    references?.[SOURCE_SYMBOLS[asset]] ||
    null;

  if (!value || value.available === false) {
    return null;
  }

  try {
    const rawCents =
      typeof value === 'object'
        ? value.markPriceCents
        : value;

    const markPriceCents = parseBigInt(
      rawCents,
      'seed_market_reference_invalid',
    );

    if (markPriceCents <= 0n) {
      return null;
    }

    const observedHighCents = parseBigInt(
      value?.observedHighCents ??
        markPriceCents,
      'seed_observed_high_invalid',
    );

    const observedLowCents = parseBigInt(
      value?.observedLowCents ??
        markPriceCents,
      'seed_observed_low_invalid',
    );

    if (
      observedLowCents <= 0n ||
      observedHighCents < observedLowCents
    ) {
      return null;
    }

    const elapsedSeconds = parseBigInt(
      value?.elapsedSeconds ?? 60n,
      'seed_elapsed_time_invalid',
    );

    const remainingSeconds = parseBigInt(
      value?.remainingSeconds ?? 0n,
      'seed_remaining_time_invalid',
    );

    return {
      ...(typeof value === 'object'
        ? value
        : {}),
      available: true,
      markPriceCents,
      observedHighCents,
      observedLowCents,
      observedRangeCents:
        observedHighCents -
        observedLowCents,
      elapsedSeconds:
        elapsedSeconds > 0n
          ? elapsedSeconds
          : 60n,
      remainingSeconds,
    };
  } catch {
    return null;
  }
}

const SEED_RISK_PROFILE_BPS =
  Object.freeze([
    1000n,
    1750n,
    2500n,
    3500n,
    4500n,
    5750n,
    7250n,
    9000n,
    11000n,
  ]);

function integerSqrt(value) {
  if (value < 0n) {
    throw new Error(
      'seed_sqrt_negative',
    );
  }

  if (value < 2n) return value;

  let left = value;
  let right =
    (left + value / left) / 2n;

  while (right < left) {
    left = right;
    right =
      (left + value / left) / 2n;
  }

  return left;
}

function projectedExtensionBudget(reference) {
  const mark =
    reference.markPriceCents;

  const observedRange =
    reference.observedRangeCents;

  // A flat first few minutes still need a small usable
  // volatility floor. 0.10% of current mark is deliberately
  // modest and only applies when observed range is smaller.
  const rangeFloor =
    mark / 1000n > 0n
      ? mark / 1000n
      : 1n;

  const baseRange =
    observedRange > rangeFloor
      ? observedRange
      : rangeFloor;

  const elapsed =
    reference.elapsedSeconds > 0n
      ? reference.elapsedSeconds
      : 60n;

  const remaining =
    reference.remainingSeconds;

  // sqrt(remaining / elapsed), represented in basis points.
  // Clamp extreme early/late values so a tiny sample cannot
  // create absurd predictions.
  let timeScaleBps =
    remaining > 0n
      ? integerSqrt(
          (
            remaining *
            100_000_000n
          ) /
            elapsed,
        )
      : 2500n;

  if (timeScaleBps < 2500n) {
    timeScaleBps = 2500n;
  }

  if (timeScaleBps > 25000n) {
    timeScaleBps = 25000n;
  }

  let budget =
    (
      baseRange *
      timeScaleBps
    ) /
    10_000n;

  const minimumBudget =
    mark / 2000n > 0n
      ? mark / 2000n
      : 1n;

  if (budget < minimumBudget) {
    budget = minimumBudget;
  }

  return budget;
}

function buildPredictionCents({
  reference,
  direction,
  wallets,
  seed,
  poolKey,
}) {
  if (
    direction !== 'HIGH' &&
    direction !== 'LOW'
  ) {
    throw new Error(
      'seed_direction_invalid',
    );
  }

  const used = new Set();
  const predictions = new Map();

  const budget =
    projectedExtensionBudget(reference);

  const anchor =
    direction === 'HIGH'
      ? reference.observedHighCents
      : reference.observedLowCents;

  const markGap =
    reference.markPriceCents /
      10_000n >
    0n
      ? reference.markPriceCents /
        10_000n
      : 1n;

  const budgetGap =
    budget / 20n > 0n
      ? budget / 20n
      : 1n;

  const minimumGap =
    markGap > budgetGap
      ? markGap
      : budgetGap;

  function isTooClose(candidate) {
    for (const existingText of used) {
      const existing =
        BigInt(existingText);

      const distance =
        candidate >= existing
          ? candidate - existing
          : existing - candidate;

      if (distance < minimumGap) {
        return true;
      }
    }

    return false;
  }

  wallets.forEach((wallet, index) => {
    const profileBps =
      SEED_RISK_PROFILE_BPS[index];

    // Small deterministic variation prevents every round from
    // using identical profile percentages while preserving
    // stable replay for the same round and wallet.
    const jitterBps =
      deterministicModulo(
        `${seed}|risk|${poolKey}|${wallet}`,
        501n,
      ) - 250n;

    let effectiveProfileBps =
      profileBps + jitterBps;

    if (effectiveProfileBps < 1n) {
      effectiveProfileBps = 1n;
    }

    let extension =
      (
        budget *
        effectiveProfileBps
      ) /
      10_000n;

    const profileFloor =
      minimumGap *
      BigInt(index + 1);

    if (extension < profileFloor) {
      extension = profileFloor;
    }

    let candidate;

    if (direction === 'HIGH') {
      candidate = anchor + extension;
    } else {
      candidate =
        extension < anchor
          ? anchor - extension
          : 1n;
    }

    let attempts = 0;

    while (
      candidate <= 0n ||
      isTooClose(candidate)
    ) {
      attempts += 1;

      if (
        attempts >
        wallets.length * 32
      ) {
        throw new Error(
          'seed_prediction_generation_failed',
        );
      }

      const delta =
        minimumGap *
        BigInt(attempts);

      if (direction === 'HIGH') {
        candidate =
          anchor +
          extension +
          delta;
      } else {
        candidate =
          anchor >
          extension + delta
            ? anchor -
              extension -
              delta
            : 1n;
      }
    }

    // Hard economic invariants. A prediction may extend an
    // already-observed extreme, never contradict it.
    if (
      direction === 'HIGH' &&
      candidate <
        reference.observedHighCents
    ) {
      throw new Error(
        'seed_high_prediction_below_observed_high',
      );
    }

    if (
      direction === 'LOW' &&
      candidate >
        reference.observedLowCents
    ) {
      throw new Error(
        'seed_low_prediction_above_observed_low',
      );
    }

    used.add(candidate.toString());

    predictions.set(
      addressKey(wallet),
      candidate.toString(),
    );
  });

  return predictions;
}

function generateDeterministicPredictions({
  markPriceCents,
  observedHighCents,
  observedLowCents,
  elapsedSeconds = '60',
  remainingSeconds = '0',
  direction,
  wallets,
  seed,
  poolKey,
}) {
  const normalizedWallets =
    assertSeedWalletSet(wallets);

  const reference =
    marketReferenceForAsset(
      {
        TEST: {
          available: true,
          markPriceCents,
          observedHighCents:
            observedHighCents ??
            markPriceCents,
          observedLowCents:
            observedLowCents ??
            markPriceCents,
          elapsedSeconds,
          remainingSeconds,
        },
      },
      'TEST',
    );

  if (!reference) {
    throw new Error(
      'seed_market_reference_invalid',
    );
  }

  return Object.fromEntries(
    buildPredictionCents({
      reference,
      direction,
      wallets: normalizedWallets,
      seed: String(seed),
      poolKey: String(poolKey),
    }),
  );
}

/**
 * Select the next deterministic cent slot when an originally planned price
 * was taken after planning. The bounded scan is stable for the same mark,
 * wallet, pool/round key, seed and taken-slot set; it never calls a runtime
 * random source.
 */

function resolveDeterministicPredictionSlot({
  predictionPriceCents,
  markPriceCents,
  direction,
  wallet,
  seed,
  poolKey,
  blockedPriceCents = [],
} = {}) {
  const normalizedWallet =
    normalizeAddress(
      wallet,
      'seed_wallet_address_invalid',
    );

  if (
    !normalizeApprovedWallets().some(
      (address) =>
        addressKey(address) ===
        addressKey(normalizedWallet),
    )
  ) {
    throw new Error(
      'seed_wallet_allowlist_mismatch',
    );
  }

  const initial = parseBigInt(
    predictionPriceCents ??
      markPriceCents,
    'seed_prediction_invalid',
  );

  if (initial <= 0n) {
    throw new Error(
      'seed_prediction_invalid',
    );
  }

  let resolvedDirection = direction;

  if (
    resolvedDirection !== 'HIGH' &&
    resolvedDirection !== 'LOW'
  ) {
    const mark =
      markPriceCents === undefined
        ? null
        : parseBigInt(
            markPriceCents,
            'seed_market_reference_invalid',
          );

    resolvedDirection =
      mark !== null &&
      initial < mark
        ? 'LOW'
        : 'HIGH';
  }

  const blocked = new Set(
    blockedPriceCents.map(String),
  );

  if (!blocked.has(initial.toString())) {
    return initial.toString();
  }

  // Collision replacement always moves farther outward.
  // It therefore cannot violate a valid HIGH/LOW bound
  // established by the planner.
  for (
    let attempt = 1;
    attempt <= 256;
    attempt += 1
  ) {
    let candidate;

    if (resolvedDirection === 'HIGH') {
      candidate =
        initial +
        BigInt(attempt);
    } else {
      candidate =
        initial -
        BigInt(attempt);

      if (candidate <= 0n) {
        break;
      }
    }

    if (
      !blocked.has(candidate.toString())
    ) {
      return candidate.toString();
    }
  }

  // Keep otherwise-unused deterministic inputs explicit:
  // collision scanning itself needs no randomness.
  void seed;
  void poolKey;

  throw new Error(
    'seed_prediction_collision_unresolved',
  );
}

function participationKey(wallet, poolAddress, roundId) {
  return `${addressKey(wallet)}:${addressKey(poolAddress)}:${roundIdKey(roundId)}`;
}

async function readExistingParticipation({ existingParticipation, hasEntered, wallet, pool, roundId }) {
  if (typeof hasEntered === 'function') {
    return Boolean(await hasEntered({ wallet, pool, roundId }));
  }
  if (existingParticipation instanceof Set) {
    return existingParticipation.has(participationKey(wallet, pool.poolAddress, roundId));
  }
  if (Array.isArray(existingParticipation)) {
    return existingParticipation.includes(participationKey(wallet, pool.poolAddress, roundId));
  }
  return false;
}

async function fundingForWallet({ fundingByWallet, wallet, requiredGasRaw }) {
  let funding = fundingByWallet;
  if (typeof fundingByWallet === 'function') funding = fundingByWallet(wallet);
  if (funding && typeof funding.then === 'function') funding = await funding;
  if (funding instanceof Map) funding = funding.get(addressKey(wallet)) || funding.get(wallet);
  if (!funding || typeof funding !== 'object') return { eligible: false, reason: 'funding_unavailable' };

  const usdcValue = funding.usdcRaw ?? funding.usdcBalanceRaw;
  // Seed planning receives both technical interfaces for one economic USDC
  // balance. They are checked independently (stake through ERC-20, fee
  // availability through native units); they must never be summed.
  const nativeUsdcValue =
    funding.nativeUsdcRaw ?? funding.nativeRaw ?? funding.nativeBalanceRaw;
  const requiredGasValue = funding.requiredGasRaw ?? requiredGasRaw;
  if (
    usdcValue === undefined ||
    nativeUsdcValue === undefined ||
    requiredGasValue === undefined
  ) {
    return { eligible: false, reason: 'funding_unavailable' };
  }

  let usdcRaw;
  let nativeUsdcRaw;
  let minimumGasRaw;
  try {
    usdcRaw = parseBigInt(usdcValue, 'funding_invalid');
    nativeUsdcRaw = parseBigInt(nativeUsdcValue, 'funding_invalid');
    minimumGasRaw = parseBigInt(requiredGasValue, 'funding_invalid');
  } catch {
    return { eligible: false, reason: 'funding_unavailable' };
  }

  if (usdcRaw < STAKE_AMOUNT_RAW) return { eligible: false, reason: 'insufficient_usdc' };
  if (nativeUsdcRaw < minimumGasRaw) return { eligible: false, reason: 'insufficient_gas' };
  return { eligible: true, reason: 'eligible' };
}

function assignDeterministicExecutionTimes(candidates, metadata, seed) {
  const groups = new Map();
  for (const candidate of candidates) {
    const window = metadata.get(candidate);
    if (!window) continue;
    const key = `${window.openAt.toString()}:${window.closeAt.toString()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }

  for (const group of groups.values()) {
    // Hash ordering is the deterministic pool+wallet-specific offset. The
    // evenly spaced slots then guarantee a broad distribution and avoid a
    // wallet or pool repeatedly landing on the same minute across a round.
    group.sort((left, right) => {
      const leftMeta = metadata.get(left);
      const rightMeta = metadata.get(right);
      const leftHash = hashSeed(`${seed}|timing|${leftMeta.planKey}`);
      const rightHash = hashSeed(`${seed}|timing|${rightMeta.planKey}`);
      if (leftHash === rightHash) return leftMeta.planKey.localeCompare(rightMeta.planKey);
      return leftHash < rightHash ? -1 : 1;
    });

    const { openAt, closeAt } = metadata.get(group[0]);
    const earliest = openAt + 1n;
    const latest = closeAt - 1n;
    if (earliest > latest) continue;

    const span = latest - earliest + 1n;
    const count = BigInt(group.length);
    const evenlySpacedGap = span / (count + 1n);
    // Five minutes is the target minimum when the entry window has enough
    // capacity. For narrower test windows, the largest feasible positive gap
    // is used instead of collapsing all entries into one timestamp.
    const targetGap = evenlySpacedGap >= 300n ? 300n : (evenlySpacedGap > 0n ? evenlySpacedGap : 1n);
    const capacityGap = span / (count + 1n);
    const gap = capacityGap >= targetGap ? targetGap : 1n;
    const used = new Set();
    let previousPlanned = null;

    group.forEach((candidate, index) => {
      const ideal = earliest + (span * BigInt(index + 1)) / (count + 1n);
      let planned = ideal;
      if (previousPlanned !== null && planned - previousPlanned < gap) {
        planned = previousPlanned + gap;
      }
      if (planned > latest) planned = latest;
      if (previousPlanned !== null && planned <= previousPlanned) return;
      while (used.has(planned.toString()) && planned < latest) planned += 1n;
      if (used.has(planned.toString())) return;
      used.add(planned.toString());
      candidate.plannedExecutionAt = new Date(Number(planned) * 1000).toISOString();
      previousPlanned = planned;
    });
  }
}

/**
 * Produce a deterministic, transaction-free dry-run plan. This function only
 * reads injected state/callbacks; it has no signer, transaction, scheduler, or
 * broadcast path by design.
 */
async function createSeedBotDryRunPlan({
  wallets,
  dbClient,
  topology,
  roundsState,
  marketReferences,
  marketLayer,
  existingParticipation,
  hasEntered,
  fundingByWallet,
  requiredGasRaw,
  seed = 'extrema-seed-bot-v1',
  now,
  onchainSend,
} = {}) {
  const selectedWallets = wallets ? assertSeedWalletSet(wallets) : await loadApprovedSeedWallets({ dbClient });
  const dailyPools = resolveCanonicalDailyPools(topology);
  const stateByPool = indexRoundStates(roundsState);

  let nowAt = null;
  if (now !== undefined && now !== null) {
    try {
      nowAt = parseTimestamp(now, 'seed_now_invalid');
    } catch {
      nowAt = null;
    }
  } else if (roundsState?.chain?.timestamp !== undefined) {
    try {
      nowAt = parseTimestamp(roundsState.chain.timestamp, 'seed_now_invalid');
    } catch {
      nowAt = null;
    }
  }

  const references =
    marketReferences ||
    await readObservedMarketReferences({
      marketLayer,
      roundsState,
      topology,
      now: nowAt,
    });

  const entries = [];
  const metadata = new Map();
  const insufficientWallets = new Map();

  for (const pool of dailyPools) {
    const state = stateByPool.get(addressKey(pool.poolAddress));
    const round = extractRoundState(state);
    const reference = marketReferenceForAsset(references, pool.asset);
    const roundKey = round
      ? `${pool.poolAddress}:${roundIdKey(round.roundId)}:${round.marketPeriodStartAt.toString()}`
      : `${pool.poolAddress}:none`;
    const predictions = round && reference
      ? buildPredictionCents({
          reference,
          direction: pool.direction,
          wallets: selectedWallets,
          seed,
          poolKey: roundKey,
        })
      : new Map();
    for (const wallet of selectedWallets) {
      const alreadyEntered = round
        ? await readExistingParticipation({ existingParticipation, hasEntered, wallet, pool, roundId: round.roundId })
        : false;
      const predictionPriceCents = predictions.get(addressKey(wallet)) || null;
      let plannedAt = null;
      let eligible = false;
      let reason = 'round_not_open';

      if (!round) {
        reason = 'round_not_open';
      } else if (round.invalidTimes || round.status !== 'ENTRY_OPEN' || round.canEnter === false) {
        reason = 'round_not_open';
      } else if (round.canEnter === undefined && nowAt !== null && (nowAt < round.entryOpenAt || nowAt >= round.entryCloseAt)) {
        reason = 'round_not_open';
      } else if (!reference) {
        reason = 'market_reference_unavailable';
      } else if (!predictionPriceCents) {
        reason = 'prediction_generation_failed';
      } else if (alreadyEntered) {
        reason = 'already_entered';
      } else {
        const funding = await fundingForWallet({ fundingByWallet, wallet, requiredGasRaw });
        if (!funding.eligible) {
          reason = funding.reason;
          if (!insufficientWallets.has(addressKey(wallet))) {
            insufficientWallets.set(addressKey(wallet), funding.reason);
          }
        } else {
          eligible = true;
          reason = 'eligible';
        }
      }

      const entry = {
        wallet,
        plannerVersion: String(seed),
        pool: pool.slug,
        poolAddress: pool.poolAddress,
        roundId: round?.roundId ?? null,
        entryOpenAt: round ? new Date(Number(round.entryOpenAt) * 1000).toISOString() : null,
        entryCloseAt: round ? new Date(Number(round.entryCloseAt) * 1000).toISOString() : null,
        asset: pool.asset,
        direction: pool.direction,
        marketReferenceCents:
          reference?.markPriceCents?.toString() ?? null,
        observedHighCents:
          reference?.observedHighCents?.toString() ?? null,
        observedLowCents:
          reference?.observedLowCents?.toString() ?? null,
        observedRangeCents:
          reference?.observedRangeCents?.toString() ?? null,
        predictionPriceCents,
        plannedExecutionAt: plannedAt,
        alreadyEntered,
        eligible,
        reason,
      };
      entries.push(entry);
      if (eligible && round) {
        metadata.set(entry, {
          openAt: round.entryOpenAt,
          closeAt: round.entryCloseAt,
          planKey: `${roundKey}:${wallet}`,
        });
      }
    }
  }

  assignDeterministicExecutionTimes(
    entries.filter((entry) => entry.eligible),
    metadata,
    String(seed),
  );

  for (const entry of entries) {
    if (entry.eligible && !entry.plannedExecutionAt) {
      entry.eligible = false;
      entry.reason = 'entry_window_invalid';
    }
    delete entry.plannedExecutionEpoch;
  }

  // Deliberately ignored: accepting this option makes accidental executor
  // wiring observable in tests without creating an execution path here.
  void onchainSend;

  return {
    mode: 'DRY_RUN',
    executorEnabled: false,
    broadcast: false,
    stakeRaw: STAKE_AMOUNT_RAW.toString(),
    seed: String(seed),
    wallets: selectedWallets,
    pools: dailyPools,
    entries,
    executableEntries: entries.filter((entry) => entry.eligible),
    insufficientWallets: [...insufficientWallets.entries()].map(([wallet, reason]) => ({ wallet, reason })),
    counts: {
      wallets: selectedWallets.length,
      pools: dailyPools.length,
      planned: entries.length,
      eligible: entries.filter((entry) => entry.eligible).length,
    },
  };
}

module.exports = {
  MAIN_MANUAL_WALLET,
  APPROVED_SEED_WALLETS,
  DAILY_ASSETS,
  DAILY_DIRECTIONS,
  SOURCE_SYMBOLS,
  STAKE_AMOUNT_RAW,
  loadApprovedSeedWallets,
  resolveCanonicalDailyPools,
  readLatestMarketReferences,
  readObservedMarketReferences,
  generateDeterministicPredictions,
  resolveDeterministicPredictionSlot,
  participationKey,
  createSeedBotDryRunPlan,
};
