'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const db = require('../db');
const { decrypt } = require('./cryptoService');
const arcService = require('./arcService');
const { resolveExtremaWindow } = require('./binanceResolverService');
const resolverSignerService = require('./resolverSignerService');

const ARC_CHAIN_ID = 5042002n;
const MIN_ENTRIES = 3;
const STATUS_ENTRY_OPEN = 0;
const STATUS_LOCKED = 1;
const STATUS_SETTLED = 2;
const STATUS_CANCELLED = 3;

// How far back to look for rounds still owed a lifecycle transition.
const ROUND_SCAN_DEPTH = 12n;

// The Arc public RPC intermittently answers eth_call with an empty result
// under sustained load, which ethers surfaces as CALL_EXCEPTION with no revert
// data. Reads are therefore retried; sends never are.
const READ_MAX_ATTEMPTS = 5;
const READ_BASE_DELAY_MS = 200;

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
  'function resolver() view returns (address)',
  'function cancelRound(uint256 roundId)',
  'function settleRound(uint256 roundId,uint64 resolvedPriceCents)',
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A genuine contract revert carries revert data. A view call that comes back
// with none is a transport failure, not a decision by the contract, so it is
// the one CALL_EXCEPTION shape that may safely be retried.
function isTransientReadError(error) {
  if (!error) return false;

  const message = String(error.shortMessage || error.message || '').toLowerCase();
  const infoMessage = String(error.info?.error?.message || '').toLowerCase();

  if (error.info?.error?.code === -32005) return true;
  if (message.includes('rate limit') || infoMessage.includes('rate limit')) return true;
  if (['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'UNKNOWN_ERROR'].includes(error.code)) {
    return true;
  }
  if (error.code === 'CALL_EXCEPTION' && (error.data === null || error.data === undefined)) {
    return true;
  }

  return false;
}

// Bounded exponential backoff for READ operations only. Never used for sends.
async function safeRead(operation, context = {}) {
  let lastError;

  for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientReadError(error) || attempt === READ_MAX_ATTEMPTS - 1) break;

      // Before spending more attempts on an empty CALL_EXCEPTION, confirm the
      // contract is actually there, so a genuinely missing pool is not masked
      // by retries. An unreadable getCode is inconclusive, so keep retrying.
      if (error.code === 'CALL_EXCEPTION' && context.provider && context.address) {
        const code = await context.provider
          .getCode(context.address)
          .catch(() => null);
        if (code === '0x') break;
      }

      await sleep(READ_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  throw lastError;
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
    safeRead(() => provider.getNetwork()),
    safeRead(() => provider.getBlock('latest')),
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
  const readFailures = [];

  for (const item of topology) {
    const pool = new ethers.Contract(item.poolAddress, POOL_ABI, provider);
    const context = { provider, address: item.poolAddress };

    // A pool that cannot be read completely is reported and skipped. It
    // contributes no due work, so nothing is written to it on incomplete
    // information, and the remaining pools are still evaluated.
    try {
      const nextRoundId = await safeRead(() => pool.nextRoundId(), context);
      if (nextRoundId <= 1n) continue;

      const oldest = oldestScannedRoundId(nextRoundId);
      for (let roundId = nextRoundId - 1n; roundId >= oldest; roundId -= 1n) {
        let round;
        try {
          round = await safeRead(() => pool.getRound(roundId), context);
        } catch (error) {
          readFailures.push({
            slug: slugOf(item),
            poolAddress: item.poolAddress,
            roundId: Number(roundId),
            operation: 'getRound',
            error: error.shortMessage || error.message,
          });
          continue;
        }

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
    } catch (error) {
      readFailures.push({
        slug: slugOf(item),
        poolAddress: item.poolAddress,
        roundId: null,
        operation: 'nextRoundId',
        error: error.shortMessage || error.message,
      });
    }
  }

  return { dueLock, dueCancel, dueSettle, readFailures };
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

  const readFailures = [];

  for (const topology of dailyPools) {
    const pool = new ethers.Contract(topology.poolAddress, POOL_ABI, provider);
    const context = { provider, address: topology.poolAddress };

    // Isolate per pool: an unreadable pool is skipped rather than aborting the
    // other seven. It is never written to, because it never reaches states[].
    try {
      const [owner, cadence, nextRoundId] = await Promise.all([
        safeRead(() => pool.owner(), context),
        safeRead(() => pool.CADENCE(), context),
        safeRead(() => pool.nextRoundId(), context),
      ]);

      if (Number(cadence) !== 0) {
        throw new Error(`daily_cadence_mismatch_${topology.poolAddress}`);
      }

      const normalizedOwner = ethers.getAddress(owner);
      owners.add(normalizedOwner);

      const latestRoundId = nextRoundId - 1n;
      const latestRound =
        latestRoundId >= 1n
          ? await safeRead(() => pool.getRound(latestRoundId), context)
          : null;

      states.push({
        topology,
        pool,
        owner: normalizedOwner,
        nextRoundId,
        latestRoundId,
        latestRound,
      });
    } catch (error) {
      readFailures.push({
        slug: slugOf(topology),
        poolAddress: topology.poolAddress,
        roundId: null,
        operation: 'daily_pool_state',
        error: error.shortMessage || error.message,
      });
    }
  }

  if (states.length === 0) {
    return { skipped: true, reason: 'daily_pool_state_unreadable', readFailures };
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
      roundCount: states.length,
      readFailures,
    };
  }

  const signer = await getPoolOwnerSigner(provider, ownerAddress);

  const results = [];

  for (const state of states) {
    // Re-read immediately before deciding to write so a prior partial run is safe.
    const context = { provider, address: state.topology.poolAddress };
    const nextRoundId = await safeRead(() => state.pool.nextRoundId(), context);
    const latestRoundId = nextRoundId - 1n;
    const latestRound =
      latestRoundId >= 1n
        ? await safeRead(() => state.pool.getRound(latestRoundId), context)
        : null;

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

    const created = await safeRead(() => state.pool.getRound(nextRoundId), context);
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
    readFailures,
  };
}

// Locking is permissionless on ExtremaPool, so this needs no privileged role.
// It reuses the already-provisioned owner wallet purely as a funded sender.
async function lockDueRoundsInternal(provider, now, dueLock) {
  if (dueLock.length === 0) {
    return { locked: [], failures: [], skipped: true, reason: 'no_rounds_due_lock' };
  }

  const ownerAddress = ethers.getAddress(
    await safeRead(() => dueLock[0].pool.owner(), {
      provider,
      address: dueLock[0].topology.poolAddress,
    }),
  );
  const signer = await getPoolOwnerSigner(provider, ownerAddress);

  const gasBalance = await safeRead(() => provider.getBalance(signer.address));
  if (gasBalance === 0n) {
    throw new Error('automation_signer_insufficient_gas');
  }

  const locked = [];
  const failures = [];

  for (const item of dueLock) {
    try {
      const context = { provider, address: item.topology.poolAddress };

      // Re-read immediately before the write so a concurrent lock is a no-op.
      const fresh = await safeRead(() => item.pool.getRound(item.roundId), context);
      if (Number(fresh.status) !== STATUS_ENTRY_OPEN || now < fresh.entryCloseAt) {
        continue;
      }

      // Single attempt. A send is never retried, because an uncertain
      // broadcast can only be resolved by re-reading state, which the next
      // scheduled run does.
      const tx = await item.pool.connect(signer).lockRound(item.roundId);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error('lock_transaction_failed');

      const after = await safeRead(() => item.pool.getRound(item.roundId), context);
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

// Canonical Binance historical evidence for one round. Any gap or validation
// failure in the source window raises resolver_data_incomplete, which must
// prevent settlement rather than settle on partial data.
async function buildSettlementEvidence(item) {
  const { topology, round } = item;
  const observationStartAt = new Date(Number(round.observationStartAt) * 1000).toISOString();
  const observationEndAt = new Date(Number(round.observationEndAt) * 1000).toISOString();

  let resolved;
  try {
    resolved = await resolveExtremaWindow({
      symbol: RESOLVER_SYMBOLS[topology.asset],
      cadence: topology.cadence,
      observationStartAt,
      observationEndAt,
    });
  } catch (error) {
    const reason = new Error('resolver_data_incomplete');
    reason.detail = error.message;
    throw reason;
  }

  const side = topology.direction === 'HIGH' ? resolved.high : resolved.low;
  if (!side || !/^[1-9][0-9]*$/.test(String(side.resolvedPriceCents))) {
    throw new Error('resolver_data_incomplete');
  }

  return {
    slug: slugOf(topology),
    poolAddress: topology.poolAddress,
    roundId: Number(item.roundId),
    symbol: RESOLVER_SYMBOLS[topology.asset],
    cadence: topology.cadence,
    direction: topology.direction,
    observationStartAt,
    observationEndAt,
    interval: resolved.interval,
    resolvedPriceCents: String(side.resolvedPriceCents),
    evidenceSha256: resolved.evidenceSha256,
  };
}

// A send is never repeated. If the broadcast outcome is uncertain, onchain
// state decides whether the transition already landed.
async function sendOnceWithReconciliation({ send, hasLanded, label }) {
  try {
    const tx = await send();
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`${label}_transaction_failed`);
    return { txHash: tx.hash, reconciled: false };
  } catch (error) {
    const landed = await hasLanded().catch(() => false);
    if (landed) return { txHash: null, reconciled: true };
    throw error;
  }
}

// Executes one resolver-authorized transition. Every call re-reads the live
// resolver role and the live round immediately before writing, so a stale scan
// can never cause a premature or duplicate transition.
async function executeResolverAction(provider, now, item, signer) {
  const context = { provider, address: item.topology.poolAddress };
  const slug = slugOf(item.topology);
  const roundId = Number(item.roundId);

  const onchainResolver = ethers.getAddress(
    await safeRead(() => item.pool.resolver(), context),
  );
  if (onchainResolver.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error('resolver_signer_mismatch');
  }

  const round = await safeRead(() => item.pool.getRound(item.roundId), context);
  const status = Number(round.status);
  const entryCount = Number(round.entryCount);

  // Another instance may have completed this already.
  if (status === STATUS_CANCELLED || status === STATUS_SETTLED) {
    return { slug, roundId, action: 'noop', reason: 'already_terminal' };
  }
  if (status !== STATUS_LOCKED || now < round.observationEndAt) {
    return { slug, roundId, action: 'noop', reason: 'not_eligible' };
  }

  const writable = item.pool.connect(signer);

  if (entryCount < MIN_ENTRIES) {
    const result = await sendOnceWithReconciliation({
      label: 'cancel',
      send: () => writable.cancelRound(item.roundId),
      hasLanded: async () => {
        const after = await safeRead(() => item.pool.getRound(item.roundId), context);
        return Number(after.status) === STATUS_CANCELLED;
      },
    });

    const after = await safeRead(() => item.pool.getRound(item.roundId), context);
    if (Number(after.status) !== STATUS_CANCELLED) {
      throw new Error('cancel_postcondition_failed');
    }

    return { slug, roundId, action: 'cancelled', entryCount, ...result };
  }

  // Settlement evidence is built before the write and must be complete.
  const evidence = await buildSettlementEvidence(item);
  const resolvedPriceCents = BigInt(evidence.resolvedPriceCents);

  const result = await sendOnceWithReconciliation({
    label: 'settle',
    send: () => writable.settleRound(item.roundId, resolvedPriceCents),
    hasLanded: async () => {
      const after = await safeRead(() => item.pool.getRound(item.roundId), context);
      return (
        Number(after.status) === STATUS_SETTLED &&
        after.resolvedPriceCents === resolvedPriceCents
      );
    },
  });

  const after = await safeRead(() => item.pool.getRound(item.roundId), context);
  if (
    Number(after.status) !== STATUS_SETTLED ||
    after.resolvedPriceCents !== resolvedPriceCents
  ) {
    throw new Error('settle_postcondition_failed');
  }

  return {
    slug,
    roundId,
    action: 'settled',
    entryCount,
    resolvedPriceCents: evidence.resolvedPriceCents,
    evidenceSha256: evidence.evidenceSha256,
    ...result,
  };
}

// Runs every eligible resolver action independently: one failing pool or one
// unavailable price feed must not block the others.
async function executeResolverActionsInternal(provider, now, dueCancel, dueSettle) {
  const due = [...dueCancel, ...dueSettle];

  if (due.length === 0) {
    return { executed: [], failures: [], skipped: true, reason: 'no_resolver_actions_due' };
  }

  if (!resolverSignerService.isResolverSigningConfigured()) {
    resolverSignerService.warnIfUnconfigured();
    return {
      executed: [],
      failures: [],
      skipped: true,
      reason: 'resolver_signing_not_configured',
      pending: await collectResolverActionsInternal(dueCancel, dueSettle),
    };
  }

  let signer;
  try {
    signer = resolverSignerService.getResolverSigner(provider);
  } catch (error) {
    return {
      executed: [],
      failures: [],
      skipped: true,
      reason: error.message,
    };
  }

  const executed = [];
  const failures = [];

  for (const item of due) {
    try {
      const outcome = await executeResolverAction(provider, now, item, signer);
      if (outcome.action !== 'noop') executed.push(outcome);
    } catch (error) {
      failures.push({
        slug: slugOf(item.topology),
        poolAddress: item.topology.poolAddress,
        roundId: Number(item.roundId),
        action: Number(item.round.entryCount) < MIN_ENTRIES ? 'cancelRound' : 'settleRound',
        reason: error.message,
        detail: error.detail,
      });
    }
  }

  return { executed, failures, skipped: false };
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
  const { dueLock, dueCancel, dueSettle, readFailures } = await scanLifecycle(provider, now);

  const lock = await lockDueRoundsInternal(provider, now, dueLock);

  // Locking may have just made rounds eligible for a resolver transition, but
  // those only become due once observation ends, so re-scanning here would not
  // change the outcome. Act on what the pre-lock scan already established.
  const resolver = await executeResolverActionsInternal(provider, now, dueCancel, dueSettle);

  if (resolver.executed.length > 0) {
    await arcService.refreshStandardRoundsCache();
  }

  return {
    chainTimestamp: Number(now),
    created,
    lock,
    resolver,
    readFailures,
  };
}

// Read-only dry run: what the lifecycle would do right now, without signing
// or sending anything. Used to verify preconditions before a live transaction.
async function previewLifecycle() {
  const provider = getAutomationProvider();
  const now = await readChainNow(provider);
  const { dueLock, dueCancel, dueSettle, readFailures } = await scanLifecycle(provider, now);

  return {
    chainTimestamp: Number(now),
    chainTimeIso: new Date(Number(now) * 1000).toISOString(),
    readFailures,
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
      if (result.readFailures?.length) {
        console.warn('[round-automation] pools skipped on unreadable state', JSON.stringify(result.readFailures));
      }

      for (const item of result.resolver?.executed || []) {
        if (item.action === 'cancelled') {
          console.log(
            '[round-automation] round cancelled',
            JSON.stringify({ slug: item.slug, roundId: item.roundId, txHash: item.txHash }),
          );
        } else if (item.action === 'settled') {
          console.log(
            '[round-automation] round settled',
            JSON.stringify({
              slug: item.slug,
              roundId: item.roundId,
              resolvedPriceCents: item.resolvedPriceCents,
              evidenceSha256: item.evidenceSha256,
              txHash: item.txHash,
            }),
          );
        }
      }

      for (const failure of result.resolver?.failures || []) {
        console.error('[round-automation] resolver action failed', JSON.stringify(failure));
      }

      // When signing is unavailable the work is still detected. Log it only
      // when the pending set changes rather than once a minute.
      if (result.resolver?.skipped && result.resolver.pending?.length) {
        const signature = resolverSignature(result.resolver.pending);
        if (signature !== lastResolverSignature) {
          lastResolverSignature = signature;
          console.warn(
            '[round-automation] resolver action skipped',
            JSON.stringify({ reason: result.resolver.reason, pending: result.resolver.pending }),
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
  executeResolverAction,
  previewLifecycle,
  runLifecycle,
  startRoundAutomation,
  stopRoundAutomation,
  CADENCE_RULES,
};
