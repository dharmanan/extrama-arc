'use strict';

const { ethers } = require('ethers');
const {
  APPROVED_SEED_WALLETS,
  STAKE_AMOUNT_RAW,
  resolveCanonicalDailyPools,
  resolveDeterministicPredictionSlot,
} = require('./seedBotCore');

const ARC_CHAIN_ID = 5042002;
const EXECUTION_MODES = Object.freeze({ DRY_RUN: 'DRY_RUN', LIVE: 'LIVE' });

function addressKey(value) {
  return String(value || '').toLowerCase();
}

function parseBigInt(value) {
  try {
    return typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return BigInt(Math.floor(parsed / 1000));
  }
  return null;
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function normalizeChainId(value) {
  const parsed = parseBigInt(value);
  return parsed === null ? null : Number(parsed);
}

function canonicalPoolForEntry(entry, topology) {
  const poolAddress = normalizeAddress(entry?.poolAddress);
  if (!poolAddress) return { pool: null, reason: 'entry_pool_invalid' };

  const pool = topology.find(
    (item) => addressKey(item.poolAddress) === addressKey(poolAddress),
  );
  if (!pool || (entry.pool && entry.pool !== pool.slug)) {
    return { pool: null, reason: 'entry_pool_not_canonical' };
  }
  return { pool, reason: null };
}

function liveRoundStatus(liveState) {
  const raw = liveState?.roundStatus ?? liveState?.contractStatus ?? liveState?.status;
  if (Number(raw) === 0) return 'ENTRY_OPEN';
  if (Number(raw) === 1) return 'LOCKED';
  if (Number(raw) === 2) return 'SETTLED';
  if (Number(raw) === 3) return 'CANCELLED';
  return raw || null;
}

/**
 * Recheck all mutable chain conditions immediately before any future entry
 * executor is allowed to run. This is deliberately a pure classifier: it
 * never creates a signer and never sends a transaction.
 */
function evaluateLiveEntryEligibility({ entry, liveState, topology } = {}) {
  let canonicalTopology;
  try {
    canonicalTopology = resolveCanonicalDailyPools(topology);
  } catch {
    return { eligible: false, reason: 'entry_topology_unavailable' };
  }
  if (!entry || !liveState) return { eligible: false, reason: 'entry_live_state_unavailable' };

  const wallet = normalizeAddress(entry.wallet);
  if (!wallet || !new Set(APPROVED_SEED_WALLETS.map(addressKey)).has(addressKey(wallet))) {
    return { eligible: false, reason: 'entry_wallet_not_approved' };
  }

  const { pool, reason: poolReason } = canonicalPoolForEntry(entry, canonicalTopology);
  if (!pool) return { eligible: false, reason: poolReason };
  if (
    liveState.poolAddress &&
    addressKey(liveState.poolAddress) !== addressKey(pool.poolAddress)
  ) {
    return { eligible: false, reason: 'entry_pool_not_current' };
  }
  if (
    liveState.ticketAddress &&
    addressKey(liveState.ticketAddress) !== addressKey(pool.ticketAddress)
  ) {
    return { eligible: false, reason: 'entry_ticket_not_canonical' };
  }

  if (normalizeChainId(liveState.chainId) !== ARC_CHAIN_ID) {
    return { eligible: false, reason: 'entry_chain_id_mismatch' };
  }

  const expectedRoundId = parseBigInt(entry.roundId);
  const currentRoundId = parseBigInt(liveState.roundId);
  if (expectedRoundId === null || expectedRoundId <= 0n || currentRoundId !== expectedRoundId) {
    return { eligible: false, reason: 'entry_round_not_current' };
  }

  if (liveRoundStatus(liveState) !== 'ENTRY_OPEN') {
    return { eligible: false, reason: 'entry_round_not_open' };
  }

  const openAt = parseTimestamp(liveState.entryOpenAt ?? entry.entryOpenAt);
  const closeAt = parseTimestamp(liveState.entryCloseAt ?? entry.entryCloseAt);
  const chainTimestamp = parseTimestamp(liveState.chainTimestamp ?? liveState.timestamp);
  if (openAt === null || closeAt === null || chainTimestamp === null || openAt >= closeAt) {
    return { eligible: false, reason: 'entry_round_timing_unavailable' };
  }
  if (chainTimestamp < openAt) return { eligible: false, reason: 'entry_round_not_open' };
  if (chainTimestamp >= closeAt) return { eligible: false, reason: 'entry_round_closed' };

  if (Boolean(liveState.hasEntered)) {
    return { eligible: false, reason: 'entry_already_entered' };
  }

  const prediction = parseBigInt(entry.predictionPriceCents);
  if (prediction === null || prediction <= 0n) {
    return { eligible: false, reason: 'entry_prediction_invalid' };
  }

  if (Boolean(liveState.predictionTaken)) {
    let replacementPredictionPriceCents = null;
    const markPriceCents = liveState.markPriceCents ?? liveState.marketReferenceCents;
    const blockedPriceCents =
      liveState.takenPredictionCents || liveState.blockedPriceCents || [entry.predictionPriceCents];
    if (markPriceCents !== undefined && Array.isArray(blockedPriceCents)) {
      try {
        const marketPeriodStartAt = parseTimestamp(
          liveState.marketPeriodStartAt || entry.entryOpenAt,
        );
        replacementPredictionPriceCents = resolveDeterministicPredictionSlot({
          markPriceCents,
          wallet,
          seed: entry.plannerVersion || liveState.seed || 'extrema-seed-bot-v1',
          poolKey: `${pool.poolAddress}:${expectedRoundId.toString()}:${marketPeriodStartAt?.toString() || ''}`,
          blockedPriceCents,
        });
      } catch {
        replacementPredictionPriceCents = null;
      }
    }
    return {
      eligible: false,
      reason: 'entry_price_taken',
      replacementPredictionPriceCents,
    };
  }

  const usdcRaw = parseBigInt(liveState.usdcRaw ?? liveState.walletUsdcRaw);
  if (usdcRaw === null) return { eligible: false, reason: 'entry_funding_unavailable' };
  if (usdcRaw < STAKE_AMOUNT_RAW) return { eligible: false, reason: 'entry_insufficient_usdc' };

  const nativeRaw = parseBigInt(liveState.nativeRaw ?? liveState.nativeBalanceRaw);
  if (nativeRaw === null) return { eligible: false, reason: 'entry_funding_unavailable' };
  if (nativeRaw <= 0n) return { eligible: false, reason: 'entry_insufficient_gas' };

  return {
    eligible: true,
    reason: 'eligible',
    wallet,
    pool,
    roundId: entry.roundId,
    predictionPriceCents: prediction.toString(),
  };
}

/**
 * Resolve the backend user row without touching encrypted key material. The
 * existing entryExecutionService/walletService remains the authority for
 * decryption and signer integrity when a separately approved live integration
 * is eventually built.
 */
async function resolveSeedWalletUser({ wallet, dbClient } = {}) {
  const normalized = normalizeAddress(wallet);
  if (!normalized) throw new Error('entry_wallet_invalid');
  if (!new Set(APPROVED_SEED_WALLETS.map(addressKey)).has(addressKey(normalized))) {
    throw new Error('entry_wallet_not_approved');
  }

  const database = dbClient || require('../db');
  const { rows } = await database.query(
    `SELECT user_id, wallet_address
       FROM extrema_wallets
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [normalized],
  );
  if (!rows.length) throw new Error('entry_seed_wallet_not_found');
  if (addressKey(rows[0].wallet_address) !== addressKey(normalized)) {
    throw new Error('entry_wallet_integrity_mismatch');
  }
  return { userId: rows[0].user_id, walletAddress: normalized };
}

/**
 * Construct the isolated execution interface. LIVE is intentionally compiled
 * as unreachable in this phase: both modes are represented, but no branch can
 * invoke an executor or broadcast. A later integration must deliberately
 * replace this gate and inject the existing entry execution service.
 */
function createSeedBotExecutionService({ mode = EXECUTION_MODES.DRY_RUN } = {}) {
  const selectedMode = mode === EXECUTION_MODES.LIVE ? EXECUTION_MODES.LIVE : EXECUTION_MODES.DRY_RUN;

  async function executeDueEntry(entry, { liveState, topology } = {}) {
    if (liveState) {
      const eligibility = evaluateLiveEntryEligibility({ entry, liveState, topology });
      if (!eligibility.eligible) {
        return {
          mode: selectedMode,
          executed: false,
          skipped: true,
          reason: eligibility.reason,
          replacementPredictionPriceCents: eligibility.replacementPredictionPriceCents || null,
        };
      }
    }
    if (selectedMode === EXECUTION_MODES.DRY_RUN) {
      return {
        mode: EXECUTION_MODES.DRY_RUN,
        executed: false,
        skipped: true,
        reason: 'dry_run',
      };
    }

    // Safety gate: LIVE has no reachable executor in Phase 2. Keeping the
    // explicit result makes accidental scheduler wiring fail closed.
    return {
      mode: EXECUTION_MODES.LIVE,
      executed: false,
      skipped: true,
      reason: 'live_mode_disabled',
    };
  }

  return Object.freeze({
    mode: selectedMode,
    liveEnabled: false,
    executeDueEntry,
    evaluateLiveEntryEligibility,
    resolveSeedWalletUser,
  });
}

module.exports = {
  ARC_CHAIN_ID,
  EXECUTION_MODES,
  evaluateLiveEntryEligibility,
  resolveSeedWalletUser,
  createSeedBotExecutionService,
};
