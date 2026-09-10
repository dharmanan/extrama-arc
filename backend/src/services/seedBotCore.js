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
    if (!mark || mark.unavailable || mark.markPrice === undefined || mark.markPrice === null) {
      references[asset] = { available: false, reason: 'market_reference_unavailable' };
      continue;
    }

    try {
      const markPrice = String(mark.markPrice);
      const markPriceCents = decimalToCentsHalfUp(markPrice).toString();
      references[asset] = {
        available: true,
        symbol,
        markPrice,
        markPriceCents,
        source: mark.source || live.source || 'EXTREMA live display price',
        sourceTimeIso: mark.sourceTimeIso || null,
        refreshedAtIso: live.refreshedAtIso || null,
      };
    } catch {
      references[asset] = { available: false, reason: 'market_reference_invalid' };
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
    roundId = normalizeRoundId(round.roundId ?? state.roundId);
  } catch {
    return null;
  }

  const status = round.contractStatus || (
    Number(round.status) === 0 ? 'ENTRY_OPEN' :
      Number(round.status) === 1 ? 'LOCKED' :
        Number(round.status) === 2 ? 'SETTLED' :
          Number(round.status) === 3 ? 'CANCELLED' : null
  );

  let entryOpenAt;
  let entryCloseAt;
  let marketPeriodStartAt;
  try {
    entryOpenAt = parseTimestamp(round.entryOpenAt, 'seed_round_time_invalid');
    entryCloseAt = parseTimestamp(round.entryCloseAt, 'seed_round_time_invalid');
    marketPeriodStartAt = round.marketPeriodStartAt === undefined || round.marketPeriodStartAt === null
      ? entryOpenAt
      : parseTimestamp(round.marketPeriodStartAt, 'seed_round_time_invalid');
  } catch {
    return { roundId, status, invalidTimes: true };
  }

  return {
    roundId,
    status,
    entryOpenAt,
    entryCloseAt,
    marketPeriodStartAt,
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

function marketReferenceForAsset(references, asset) {
  const value = references?.[asset] || references?.[SOURCE_SYMBOLS[asset]];
  if (!value || value.available === false) return null;
  try {
    const rawCents = typeof value === 'object' ? value.markPriceCents : value;
    const cents = parseBigInt(rawCents, 'seed_market_reference_invalid');
    if (cents <= 0n) return null;
    return {
      ...(typeof value === 'object' ? value : {}),
      available: true,
      markPriceCents: cents,
    };
  } catch {
    return null;
  }
}

function buildPredictionCents(markCents, wallets, seed, poolKey) {
  const used = new Set();
  const spreadUnit = markCents / 250n > 0n ? markCents / 250n : 1n;
  // Keep agent predictions visibly separated instead of merely unique.
  // This is approximately 0.2% of the market reference, with a one-cent
  // floor for tiny-price fixtures.
  const minimumGap =
    spreadUnit / 2n > 0n ? spreadUnit / 2n : 1n;
  const predictions = new Map();

  function isTooClose(candidate) {
    for (const existingText of used) {
      const existing = BigInt(existingText);
      const distance =
        candidate >= existing
          ? candidate - existing
          : existing - candidate;

      if (distance < minimumGap) return true;
    }

    return false;
  }

  wallets.forEach((wallet, index) => {
    const side = index % 2 === 0 ? -1n : 1n;
    const step = BigInt(Math.floor(index / 2) + 1);
    const jitter = deterministicModulo(
      `${seed}|prediction|${poolKey}|${wallet}`,
      spreadUnit + 1n,
    );
    const magnitude = spreadUnit * step + jitter;

    let candidate = side < 0n
      ? markCents - (
        magnitude > markCents - 1n
          ? markCents - 1n
          : magnitude
      )
      : markCents + magnitude;

    if (candidate <= 0n) {
      candidate = markCents + magnitude;
    }

    // Deterministically move farther from the mark until the candidate is
    // both positive and sufficiently separated from every prior seed slot.
    let attempts = 0;
    while (candidate <= 0n || isTooClose(candidate)) {
      attempts += 1;
      if (attempts > wallets.length * 32) return;

      const delta = minimumGap * BigInt(attempts);

      candidate = side < 0n
        ? markCents - magnitude - delta
        : markCents + magnitude + delta;

      if (candidate <= 0n) {
        candidate = markCents + magnitude + delta;
      }
    }

    used.add(candidate.toString());
    predictions.set(addressKey(wallet), candidate.toString());
  });

  return predictions;
}

function generateDeterministicPredictions({ markPriceCents, wallets, seed, poolKey }) {
  const normalizedWallets = assertSeedWalletSet(wallets);
  const markCents = parseBigInt(markPriceCents, 'seed_market_reference_invalid');
  if (markCents <= 0n) throw new Error('seed_market_reference_invalid');
  return Object.fromEntries(buildPredictionCents(markCents, normalizedWallets, String(seed), String(poolKey)));
}

/**
 * Select the next deterministic cent slot when an originally planned price
 * was taken after planning. The bounded scan is stable for the same mark,
 * wallet, pool/round key, seed and taken-slot set; it never calls a runtime
 * random source.
 */
function resolveDeterministicPredictionSlot({
  markPriceCents,
  wallet,
  seed,
  poolKey,
  blockedPriceCents = [],
} = {}) {
  const normalizedWallet = normalizeAddress(wallet, 'seed_wallet_address_invalid');
  if (!normalizeApprovedWallets().some((address) => addressKey(address) === addressKey(normalizedWallet))) {
    throw new Error('seed_wallet_allowlist_mismatch');
  }
  const predictions = generateDeterministicPredictions({
    markPriceCents,
    wallets: normalizeApprovedWallets(),
    seed,
    poolKey,
  });
  const initial = parseBigInt(predictions[addressKey(normalizedWallet)], 'seed_prediction_invalid');
  const mark = parseBigInt(markPriceCents, 'seed_market_reference_invalid');
  const blocked = new Set(blockedPriceCents.map((value) => String(value)));
  if (!blocked.has(initial.toString())) return initial.toString();

  const direction = initial < mark ? -1n : 1n;
  for (let attempt = 1; attempt <= 256; attempt += 1) {
    const delta = BigInt(attempt);
    let candidate = direction < 0n ? initial - delta : initial + delta;
    if (candidate <= 0n) candidate = mark + delta;
    if (!blocked.has(candidate.toString())) return candidate.toString();
  }

  throw new Error('seed_prediction_collision_unresolved');
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
  const nativeValue = funding.nativeRaw ?? funding.nativeBalanceRaw;
  const requiredGasValue = funding.requiredGasRaw ?? requiredGasRaw;
  if (usdcValue === undefined || nativeValue === undefined || requiredGasValue === undefined) {
    return { eligible: false, reason: 'funding_unavailable' };
  }

  let usdcRaw;
  let nativeRaw;
  let minimumGasRaw;
  try {
    usdcRaw = parseBigInt(usdcValue, 'funding_invalid');
    nativeRaw = parseBigInt(nativeValue, 'funding_invalid');
    minimumGasRaw = parseBigInt(requiredGasValue, 'funding_invalid');
  } catch {
    return { eligible: false, reason: 'funding_unavailable' };
  }

  if (usdcRaw < STAKE_AMOUNT_RAW) return { eligible: false, reason: 'insufficient_usdc' };
  if (nativeRaw < minimumGasRaw) return { eligible: false, reason: 'insufficient_gas' };
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
  const references = marketReferences || await readLatestMarketReferences({ marketLayer });
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
      ? buildPredictionCents(reference.markPriceCents, selectedWallets, seed, roundKey)
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
  generateDeterministicPredictions,
  resolveDeterministicPredictionSlot,
  participationKey,
  createSeedBotDryRunPlan,
};
