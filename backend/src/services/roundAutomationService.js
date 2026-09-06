'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const db = require('../db');
const { decrypt } = require('./cryptoService');
const arcService = require('./arcService');
const { resolveExtremaWindow } = require('./binanceResolverService');

const ARC_CHAIN_ID = 5042002n;
const MIN_ENTRIES = 3;
const STATUS_ENTRY_OPEN = 0;
const STATUS_LOCKED = 1;

// How far back to look for rounds still owed a lifecycle transition.
const ROUND_SCAN_DEPTH = 12n;

const RESOLVER_SYMBOLS = Object.freeze({
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  HYPE: 'HYPEUSDT',
});

// Canonical observation offsets, mirroring the validation already enforced by
// backend/src/scripts/create-next-round.js so both paths agree.
const CADENCE_RULES = Object.freeze({
  DAILY: { leadSeconds: 4n * 3600n, durationSeconds: 24n * 3600n },
  WEEKLY: { leadSeconds: 24n * 3600n, durationSeconds: 7n * 24n * 3600n },
  QUARTERLY: { leadSeconds: 24n * 3600n, durationSeconds: null },
});
const AUTOMATION_LOCK_ID = '504200220260906';

const POOL_ABI = [
  'function owner() view returns (address)',
  'function CADENCE() view returns (uint8)',
  'function nextRoundId() view returns (uint256)',
  'function createRound(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt) returns (uint256)',
  'function lockRound(uint256 roundId)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
];

let runPromise = null;
let timer = null;

function currentDailySchedule(chainTimestamp) {
  const now = new Date(Number(chainTimestamp) * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  return {
    entryOpenAt: BigInt(Math.floor(Date.UTC(year, month, day, 0, 0, 0) / 1000)),
    entryCloseAt: BigInt(Math.floor(Date.UTC(year, month, day, 20, 0, 0) / 1000)),
    observationStartAt: BigInt(Math.floor(Date.UTC(year, month, day + 1, 0, 0, 0) / 1000)),
    observationEndAt: BigInt(Math.floor(Date.UTC(year, month, day + 2, 0, 0, 0) / 1000)),
  };
}

function sameSchedule(round, schedule) {
  return (
    round &&
    round.entryOpenAt === schedule.entryOpenAt &&
    round.entryCloseAt === schedule.entryCloseAt &&
    round.observationStartAt === schedule.observationStartAt &&
    round.observationEndAt === schedule.observationEndAt
  );
}

async function withAutomationLock(work) {
  const client = await db.getClient();
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [AUTOMATION_LOCK_ID],
    );
    if (!result.rows[0]?.locked) {
      return { skipped: true, reason: 'automation_lock_busy' };
    }

    try {
      return await work();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [AUTOMATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

function getAutomationProvider() {
  return new ethers.JsonRpcProvider(
    config.ARC_TESTNET_RPC_URL,
    { chainId: Number(ARC_CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );
}

async function readChainNow(provider) {
  const [network, latestBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock('latest'),
  ]);
  if (network.chainId !== ARC_CHAIN_ID) throw new Error('arc_chain_id_mismatch');
  if (!latestBlock) throw new Error('arc_latest_block_unavailable');
  return BigInt(latestBlock.timestamp);
}

function requireTopology() {
  // Fail with a named error if the topology export ever regresses again,
  // instead of a bare "cannot read properties of undefined" every 60s.
  if (!Array.isArray(arcService.ARC_POOL_TOPOLOGY)) {
    throw new Error('arc_pool_topology_unavailable');
  }
  return arcService.ARC_POOL_TOPOLOGY;
}

// The only signer this service uses. It is the already-provisioned pool owner
// wallet, looked up exactly the way the pre-existing round scripts do. No new
// key material and no new signer assumption is introduced here.
async function getPoolOwnerSigner(provider, ownerAddress) {
  const { rows } = await db.query(
    `SELECT wallet_address, private_key_encrypted
       FROM extrema_wallets
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [ownerAddress],
  );
  if (!rows.length) throw new Error('pool_owner_wallet_not_found_in_backend');

  const signer = new ethers.Wallet(decrypt(rows[0].private_key_encrypted), provider);
  if (signer.address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error('pool_owner_signer_mismatch');
  }
  return signer;
}

function slugOf(topology) {
  return `${topology.asset.toLowerCase()}-${topology.cadence.toLowerCase()}-${topology.direction.toLowerCase()}`;
}

function oldestScannedRoundId(nextRoundId) {
  const floor = nextRoundId - ROUND_SCAN_DEPTH;
  return floor > 1n ? floor : 1n;
}

// Walks the recent rounds of every pool and classifies what each one is owed.
// Read only: this decides nothing and writes nothing.
async function scanLifecycle(provider, now) {
  const topology = requireTopology();
  const dueLock = [];
  const dueCancel = [];
  const dueSettle = [];

  for (const item of topology) {
    const pool = new ethers.Contract(item.poolAddress, POOL_ABI, provider);
    const nextRoundId = await pool.nextRoundId();
    if (nextRoundId <= 1n) continue;

    const oldest = oldestScannedRoundId(nextRoundId);
    for (let roundId = nextRoundId - 1n; roundId >= oldest; roundId -= 1n) {
      const round = await pool.getRound(roundId);
      const status = Number(round.status);

      if (status === STATUS_ENTRY_OPEN && now >= round.entryCloseAt) {
        dueLock.push({ topology: item, pool, roundId, round });
        continue;
      }

      if (status === STATUS_LOCKED && now >= round.observationEndAt) {
        const bucket = Number(round.entryCount) < MIN_ENTRIES ? dueCancel : dueSettle;
        bucket.push({ topology: item, pool, roundId, round });
      }
    }
  }

  return { dueLock, dueCancel, dueSettle };
}

async function ensureCurrentDailyRoundsInternal() {
  const provider = getAutomationProvider();
  const now = await readChainNow(provider);
  const schedule = currentDailySchedule(now);

  // Daily prediction window is 00:00–20:00 UTC.
  if (now < schedule.entryOpenAt || now >= schedule.entryCloseAt) {
    return {
      skipped: true,
      reason: 'outside_daily_prediction_window',
      chainTimestamp: Number(now),
    };
  }

  const dailyPools = requireTopology().filter((item) => item.cadence === 'DAILY');
  if (dailyPools.length !== 8) throw new Error('daily_pool_count_mismatch');

  const owners = new Set();
  const states = [];

  for (const topology of dailyPools) {
    const pool = new ethers.Contract(topology.poolAddress, POOL_ABI, provider);
    const [owner, cadence, nextRoundId] = await Promise.all([
      pool.owner(),
      pool.CADENCE(),
      pool.nextRoundId(),
    ]);

    if (Number(cadence) !== 0) {
      throw new Error(`daily_cadence_mismatch_${topology.poolAddress}`);
    }

    const normalizedOwner = ethers.getAddress(owner);
    owners.add(normalizedOwner);

    const latestRoundId = nextRoundId - 1n;
    const latestRound =
      latestRoundId >= 1n ? await pool.getRound(latestRoundId) : null;

    states.push({
      topology,
      pool,
      owner: normalizedOwner,
      nextRoundId,
      latestRoundId,
      latestRound,
    });
  }

  if (owners.size !== 1) throw new Error('daily_pool_owner_mismatch');
  const [ownerAddress] = Array.from(owners);

  const missing = states.filter(
    (state) => !sameSchedule(state.latestRound, schedule),
  );

  if (missing.length === 0) {
    return {
      skipped: true,
      reason: 'daily_rounds_already_current',
      roundCount: 8,
    };
  }

  const signer = await getPoolOwnerSigner(provider, ownerAddress);

  const results = [];

  for (const state of states) {
    // Re-read immediately before deciding to write so a prior partial run is safe.
    const nextRoundId = await state.pool.nextRoundId();
    const latestRoundId = nextRoundId - 1n;
    const latestRound =
      latestRoundId >= 1n ? await state.pool.getRound(latestRoundId) : null;

    if (sameSchedule(latestRound, schedule)) {
      results.push({
        slug: `${state.topology.asset.toLowerCase()}-daily-${state.topology.direction.toLowerCase()}`,
        roundId: Number(latestRoundId),
        status: 'already-current',
      });
      continue;
    }

    if (
      latestRound &&
      latestRound.entryCloseAt > schedule.entryCloseAt
    ) {
      throw new Error(
        `daily_round_schedule_ahead_${state.topology.poolAddress}`,
      );
    }

    const writable = state.pool.connect(signer);
    const tx = await writable.createRound(
      schedule.entryOpenAt,
      schedule.entryCloseAt,
      schedule.observationStartAt,
      schedule.observationEndAt,
    );
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error(`daily_round_create_failed_${state.topology.poolAddress}`);
    }

    const created = await state.pool.getRound(nextRoundId);
    if (!sameSchedule(created, schedule) || Number(created.status) !== 0) {
      throw new Error(
        `daily_round_create_postcondition_failed_${state.topology.poolAddress}`,
      );
    }

    results.push({
      slug: `${state.topology.asset.toLowerCase()}-daily-${state.topology.direction.toLowerCase()}`,
      roundId: Number(nextRoundId),
      status: 'created',
      txHash: tx.hash,
    });
  }

  await arcService.refreshStandardRoundsCache();

  return {
    skipped: false,
    entryOpenAt: new Date(Number(schedule.entryOpenAt) * 1000).toISOString(),
    entryCloseAt: new Date(Number(schedule.entryCloseAt) * 1000).toISOString(),
    results,
  };
}

// Locking is permissionless on ExtremaPool, so this needs no privileged role.
// It reuses the already-provisioned owner wallet purely as a funded sender.
async function lockDueRoundsInternal(provider, now, dueLock) {
  if (dueLock.length === 0) {
    return { locked: [], failures: [], skipped: true, reason: 'no_rounds_due_lock' };
  }

  const ownerAddress = ethers.getAddress(await dueLock[0].pool.owner());
  const signer = await getPoolOwnerSigner(provider, ownerAddress);

  if ((await provider.getBalance(signer.address)) === 0n) {
    throw new Error('automation_signer_insufficient_gas');
  }

  const locked = [];
  const failures = [];

  for (const item of dueLock) {
    try {
      // Re-read immediately before the write so a concurrent lock is a no-op.
      const fresh = await item.pool.getRound(item.roundId);
      if (Number(fresh.status) !== STATUS_ENTRY_OPEN || now < fresh.entryCloseAt) {
        continue;
      }

      const tx = await item.pool.connect(signer).lockRound(item.roundId);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error('lock_transaction_failed');

      const after = await item.pool.getRound(item.roundId);
      if (Number(after.status) !== STATUS_LOCKED) throw new Error('lock_postcondition_failed');

      locked.push({
        slug: slugOf(item.topology),
        roundId: Number(item.roundId),
        txHash: tx.hash,
      });
    } catch (error) {
      // One bad pool must not stop the rest of the lifecycle.
      failures.push({
        slug: slugOf(item.topology),
        roundId: Number(item.roundId),
        error: error.message,
      });
    }
  }

  return { locked, failures, skipped: false };
}

// cancelRound and settleRound are onlyResolver. The resolver key is held in an
// operator keystore and is deliberately not available to this backend, so this
// reports what is due, with the settlement price already resolved from the
// canonical Binance path, instead of signing anything.
async function collectResolverActionsInternal(dueCancel, dueSettle) {
  const pending = [];

  for (const item of dueCancel) {
    pending.push({
      action: 'cancelRound',
      slug: slugOf(item.topology),
      roundId: Number(item.roundId),
      entryCount: Number(item.round.entryCount),
      reason: 'entry_count_below_minimum',
    });
  }

  for (const item of dueSettle) {
    const entry = {
      action: 'settleRound',
      slug: slugOf(item.topology),
      roundId: Number(item.roundId),
      entryCount: Number(item.round.entryCount),
    };

    try {
      const evidence = await resolveExtremaWindow({
        symbol: RESOLVER_SYMBOLS[item.topology.asset],
        cadence: item.topology.cadence,
        observationStartAt: new Date(Number(item.round.observationStartAt) * 1000).toISOString(),
        observationEndAt: new Date(Number(item.round.observationEndAt) * 1000).toISOString(),
      });

      const side = item.topology.direction === 'HIGH' ? evidence.high : evidence.low;
      entry.resolvedPriceCents = side.resolvedPriceCents;
      entry.evidenceSha256 = evidence.evidenceSha256;
    } catch (error) {
      entry.resolverError = error.message;
    }

    pending.push(entry);
  }

  return pending;
}

function resolverSignature(pending) {
  return pending
    .map((item) => `${item.action}:${item.slug}#${item.roundId}:${item.resolvedPriceCents || ''}`)
    .sort()
    .join('|');
}

async function runLifecycleInternal() {
  const created = await ensureCurrentDailyRoundsInternal();

  const provider = getAutomationProvider();
  const now = await readChainNow(provider);
  const { dueLock, dueCancel, dueSettle } = await scanLifecycle(provider, now);

  const lock = await lockDueRoundsInternal(provider, now, dueLock);

  // Locking may have just made rounds eligible for a resolver transition, but
  // those only become due once observation ends, so re-scanning here would not
  // change the outcome. Report what the pre-lock scan already established.
  const pendingResolverActions = await collectResolverActionsInternal(dueCancel, dueSettle);

  return {
    chainTimestamp: Number(now),
    created,
    lock,
    pendingResolverActions,
  };
}

// Read-only dry run: what the lifecycle would do right now, without signing
// or sending anything. Used to verify preconditions before a live transaction.
async function previewLifecycle() {
  const provider = getAutomationProvider();
  const now = await readChainNow(provider);
  const { dueLock, dueCancel, dueSettle } = await scanLifecycle(provider, now);

  return {
    chainTimestamp: Number(now),
    chainTimeIso: new Date(Number(now) * 1000).toISOString(),
    dueLock: dueLock.map((item) => ({
      slug: slugOf(item.topology),
      roundId: Number(item.roundId),
      entryCloseAt: new Date(Number(item.round.entryCloseAt) * 1000).toISOString(),
    })),
    pendingResolverActions: await collectResolverActionsInternal(dueCancel, dueSettle),
  };
}

async function runLifecycle() {
  if (runPromise) return runPromise;

  runPromise = withAutomationLock(runLifecycleInternal).finally(() => {
    runPromise = null;
  });

  return runPromise;
}

async function ensureCurrentDailyRounds() {
  if (runPromise) return runPromise;

  runPromise = withAutomationLock(ensureCurrentDailyRoundsInternal)
    .finally(() => {
      runPromise = null;
    });

  return runPromise;
}

let lastResolverSignature = '';

function runAndLog() {
  runLifecycle()
    .then((result) => {
      if (result?.skipped) return;

      if (result.created && !result.created.skipped) {
        console.log('[round-automation] daily rounds ensured', JSON.stringify(result.created));
      }

      if (result.lock?.locked?.length) {
        console.log('[round-automation] rounds locked', JSON.stringify(result.lock.locked));
      }
      if (result.lock?.failures?.length) {
        console.error('[round-automation] lock failures', JSON.stringify(result.lock.failures));
      }

      // Resolver work needs an operator key this process does not hold, so log
      // it only when the pending set changes rather than once a minute.
      const pending = result.pendingResolverActions || [];
      const signature = resolverSignature(pending);
      if (signature !== lastResolverSignature) {
        lastResolverSignature = signature;
        if (pending.length) {
          console.warn(
            '[round-automation] resolver action required (not signed by backend)',
            JSON.stringify(pending),
          );
        }
      }
    })
    .catch((error) => {
      console.error('[round-automation] lifecycle run failed', error.message);
    });
}

function startRoundAutomation() {
  if (config.NODE_ENV !== 'production') {
    console.log('[round-automation] disabled outside production');
    return;
  }
  if (timer) return;

  // Run once at boot, then keep the active lifecycle self-healing.
  runAndLog();
  timer = setInterval(runAndLog, 60_000);
  timer.unref?.();
  console.log('[round-automation] daily scheduler active');
}

function stopRoundAutomation() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  currentDailySchedule,
  ensureCurrentDailyRounds,
  previewLifecycle,
  runLifecycle,
  startRoundAutomation,
  stopRoundAutomation,
  CADENCE_RULES,
};
