'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const db = require('../db');
const { decrypt } = require('./cryptoService');
const arcService = require('./arcService');

const ARC_CHAIN_ID = 5042002n;
const AUTOMATION_LOCK_ID = '504200220260906';

const POOL_ABI = [
  'function owner() view returns (address)',
  'function CADENCE() view returns (uint8)',
  'function nextRoundId() view returns (uint256)',
  'function createRound(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt) returns (uint256)',
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

async function ensureCurrentDailyRoundsInternal() {
  const provider = new ethers.JsonRpcProvider(
    config.ARC_TESTNET_RPC_URL,
    { chainId: Number(ARC_CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );

  const [network, latestBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock('latest'),
  ]);

  if (network.chainId !== ARC_CHAIN_ID) throw new Error('arc_chain_id_mismatch');
  if (!latestBlock) throw new Error('arc_latest_block_unavailable');

  const now = BigInt(latestBlock.timestamp);
  const schedule = currentDailySchedule(now);

  // Daily prediction window is 00:00–20:00 UTC.
  if (now < schedule.entryOpenAt || now >= schedule.entryCloseAt) {
    return {
      skipped: true,
      reason: 'outside_daily_prediction_window',
      chainTimestamp: Number(now),
    };
  }

  // Fail with a named error if the topology export ever regresses again,
  // instead of a bare "cannot read properties of undefined" every 60s.
  if (!Array.isArray(arcService.ARC_POOL_TOPOLOGY)) {
    throw new Error('arc_pool_topology_unavailable');
  }

  const dailyPools = arcService.ARC_POOL_TOPOLOGY.filter(
    (item) => item.cadence === 'DAILY',
  );
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

  const { rows } = await db.query(
    `SELECT wallet_address, private_key_encrypted
       FROM extrema_wallets
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [ownerAddress],
  );
  if (!rows.length) throw new Error('pool_owner_wallet_not_found_in_backend');

  const privateKey = decrypt(rows[0].private_key_encrypted);
  const signer = new ethers.Wallet(privateKey, provider);
  if (signer.address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error('pool_owner_signer_mismatch');
  }

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

async function ensureCurrentDailyRounds() {
  if (runPromise) return runPromise;

  runPromise = withAutomationLock(ensureCurrentDailyRoundsInternal)
    .finally(() => {
      runPromise = null;
    });

  return runPromise;
}

function runAndLog() {
  ensureCurrentDailyRounds()
    .then((result) => {
      if (!result?.skipped) {
        console.log('[round-automation] daily rounds ensured', JSON.stringify(result));
      }
    })
    .catch((error) => {
      console.error('[round-automation] daily round ensure failed', error.message);
    });
}

function startRoundAutomation() {
  if (config.NODE_ENV !== 'production') {
    console.log('[round-automation] disabled outside production');
    return;
  }
  if (timer) return;

  // Run once at boot, then keep the active Daily window self-healing.
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
  startRoundAutomation,
  stopRoundAutomation,
};
