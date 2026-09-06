'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const config = require('../config');
const { decrypt } = require('../services/cryptoService');
const { ARC_POOL_TOPOLOGY } = require('../services/arcService');

const ARC_CHAIN_ID = 5042002n;

const POOL_ABI = [
  'function owner() view returns (address)',
  'function CADENCE() view returns (uint8)',
  'function nextRoundId() view returns (uint256)',
  'function createRound(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt) returns (uint256)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
];

function utcDaySchedule(nowSeconds) {
  const now = new Date(Number(nowSeconds) * 1000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  const entryOpenAt = BigInt(Math.floor(Date.UTC(y, m, d, 0, 0, 0) / 1000));
  const entryCloseAt = BigInt(Math.floor(Date.UTC(y, m, d, 20, 0, 0) / 1000));
  const observationStartAt = BigInt(Math.floor(Date.UTC(y, m, d + 1, 0, 0, 0) / 1000));
  const observationEndAt = BigInt(Math.floor(Date.UTC(y, m, d + 2, 0, 0, 0) / 1000));

  return { entryOpenAt, entryCloseAt, observationStartAt, observationEndAt };
}

async function main() {
  if (process.env.CONFIRM_CREATE_DAILY_ROUNDS !== 'YES') {
    throw new Error('set_CONFIRM_CREATE_DAILY_ROUNDS=YES_to_broadcast');
  }

  const provider = new ethers.JsonRpcProvider(
    config.ARC_TESTNET_RPC_URL,
    { chainId: Number(ARC_CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );

  const [network, latest] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock('latest'),
  ]);

  if (network.chainId !== ARC_CHAIN_ID) throw new Error('arc_chain_id_mismatch');
  if (!latest) throw new Error('latest_block_unavailable');

  const now = BigInt(latest.timestamp);
  const schedule = utcDaySchedule(now);

  if (now < schedule.entryOpenAt || now >= schedule.entryCloseAt) {
    throw new Error('daily_prediction_window_not_open');
  }

  const dailyPools = ARC_POOL_TOPOLOGY.filter((item) => item.cadence === 'DAILY');
  if (dailyPools.length !== 8) throw new Error('daily_pool_count_mismatch');

  const poolStates = [];
  const owners = new Set();

  for (const topology of dailyPools) {
    const pool = new ethers.Contract(topology.poolAddress, POOL_ABI, provider);
    const [owner, cadence, nextRoundId] = await Promise.all([
      pool.owner(),
      pool.CADENCE(),
      pool.nextRoundId(),
    ]);

    if (Number(cadence) !== 0) throw new Error(`daily_cadence_mismatch_${topology.poolAddress}`);
    owners.add(ethers.getAddress(owner));

    const latestRoundId = nextRoundId - 1n;
    const latestRound = latestRoundId >= 1n ? await pool.getRound(latestRoundId) : null;

    poolStates.push({
      topology,
      pool,
      owner: ethers.getAddress(owner),
      nextRoundId,
      latestRoundId,
      latestRound,
    });
  }

  if (owners.size !== 1) throw new Error('daily_pool_owner_mismatch');
  const [ownerAddress] = [...owners];

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

  console.log(JSON.stringify({
    chainId: Number(network.chainId),
    chainTimestamp: Number(now),
    chainTimestampIso: new Date(Number(now) * 1000).toISOString(),
    entryOpenAt: new Date(Number(schedule.entryOpenAt) * 1000).toISOString(),
    entryCloseAt: new Date(Number(schedule.entryCloseAt) * 1000).toISOString(),
    observationStartAt: new Date(Number(schedule.observationStartAt) * 1000).toISOString(),
    observationEndAt: new Date(Number(schedule.observationEndAt) * 1000).toISOString(),
    poolCount: dailyPools.length,
  }, null, 2));

  const results = [];

  for (const state of poolStates) {
    const { topology, pool, latestRoundId, latestRound } = state;

    if (
      latestRound &&
      latestRound.entryOpenAt === schedule.entryOpenAt &&
      latestRound.entryCloseAt === schedule.entryCloseAt &&
      latestRound.observationStartAt === schedule.observationStartAt &&
      latestRound.observationEndAt === schedule.observationEndAt
    ) {
      results.push({
        slug: `${topology.asset.toLowerCase()}-daily-${topology.direction.toLowerCase()}`,
        poolAddress: topology.poolAddress,
        roundId: Number(latestRoundId),
        status: 'already-created',
      });
      continue;
    }

    const writable = pool.connect(signer);
    const roundId = state.nextRoundId;
    const tx = await writable.createRound(
      schedule.entryOpenAt,
      schedule.entryCloseAt,
      schedule.observationStartAt,
      schedule.observationEndAt,
    );
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`create_daily_round_failed_${topology.poolAddress}`);
    }

    const round = await pool.getRound(roundId);
    if (
      round.entryOpenAt !== schedule.entryOpenAt ||
      round.entryCloseAt !== schedule.entryCloseAt ||
      round.observationStartAt !== schedule.observationStartAt ||
      round.observationEndAt !== schedule.observationEndAt ||
      Number(round.status) !== 0
    ) {
      throw new Error(`create_daily_round_postcondition_failed_${topology.poolAddress}`);
    }

    results.push({
      slug: `${topology.asset.toLowerCase()}-daily-${topology.direction.toLowerCase()}`,
      poolAddress: topology.poolAddress,
      roundId: Number(roundId),
      status: 'created',
      txHash: tx.hash,
      explorer: `https://testnet.arcscan.app/tx/${tx.hash}`,
    });
  }

  console.log(JSON.stringify({ results }, null, 2));
  console.log('CREATE_DAILY_ROUNDS=PASS');
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close().catch(() => {});
  });
