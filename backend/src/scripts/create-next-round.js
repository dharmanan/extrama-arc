'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const config = require('../config');
const { decrypt } = require('../services/cryptoService');
const {
  currentDailySchedule,
  currentWeeklySchedule,
  currentQuarterlySchedule,
} = require('../services/canonicalMarketSchedule');

const ARC_CHAIN_ID = 5042002n;

const POOL_ABI = [
  'function owner() view returns (address)',
  'function CADENCE() view returns (uint8)',
  'function nextRoundId() view returns (uint256)',
  'function createRound(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt) returns (uint256)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
];

function requireAddress(name, value) {
  if (!ethers.isAddress(value || '')) throw new Error(`${name}_invalid`);
  return ethers.getAddress(value);
}

function scheduleForCadence(cadence, now) {
  if (cadence === 0) return currentDailySchedule(now);
  if (cadence === 1) return currentWeeklySchedule(now);
  if (cadence === 2) return currentQuarterlySchedule(now);
  throw new Error('cadence_invalid');
}

async function main() {
  if (!config.EXTREMA_ENABLE_ROUND_CREATION) {
    throw new Error('round_creation_disabled');
  }
  if (process.env.CONFIRM_CREATE_NEXT_ROUND !== 'YES') {
    throw new Error('set_CONFIRM_CREATE_NEXT_ROUND=YES_to_broadcast');
  }

  const poolAddress = requireAddress('POOL_ADDRESS', process.env.POOL_ADDRESS);
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
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [owner, cadenceRaw, nextRoundId] = await Promise.all([
    pool.owner(),
    pool.CADENCE(),
    pool.nextRoundId(),
  ]);
  const cadence = Number(cadenceRaw);
  const schedule = scheduleForCadence(cadence, now);

  if (now < schedule.entryOpenAt || now >= schedule.entryCloseAt) {
    throw new Error('canonical_prediction_window_not_open');
  }

  const ownerAddress = ethers.getAddress(owner);
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

  console.log(JSON.stringify({
    broadcast: true,
    chainId: Number(network.chainId),
    poolAddress,
    owner: ownerAddress,
    roundId: Number(nextRoundId),
    cadence,
    marketPeriodStartAt: new Date(Number(schedule.marketPeriodStartAt) * 1000).toISOString(),
    marketPeriodEndAt: new Date(Number(schedule.marketPeriodEndAt) * 1000).toISOString(),
    entryOpenAt: new Date(Number(schedule.entryOpenAt) * 1000).toISOString(),
    entryCloseAt: new Date(Number(schedule.entryCloseAt) * 1000).toISOString(),
    settlementEligibleAt: new Date(Number(schedule.observationEndAt) * 1000).toISOString(),
  }, null, 2));

  const writablePool = pool.connect(signer);
  const tx = await writablePool.createRound(
    schedule.entryOpenAt,
    schedule.entryCloseAt,
    schedule.observationStartAt,
    schedule.observationEndAt,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error('create_round_transaction_failed');

  const round = await pool.getRound(nextRoundId);
  if (
    round.entryOpenAt !== schedule.entryOpenAt ||
    round.entryCloseAt !== schedule.entryCloseAt ||
    round.observationStartAt !== schedule.observationStartAt ||
    round.observationEndAt !== schedule.observationEndAt ||
    Number(round.status) !== 0 ||
    Number(round.entryCount) !== 0
  ) {
    throw new Error('create_round_postcondition_failed');
  }

  console.log('CREATE_NEXT_ROUND=PASS');
  console.log(`ROUND_ID=${nextRoundId.toString()}`);
  console.log(`TX_HASH=${tx.hash}`);
  console.log(`EXPLORER=https://testnet.arcscan.app/tx/${tx.hash}`);
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close().catch(() => {});
  });
