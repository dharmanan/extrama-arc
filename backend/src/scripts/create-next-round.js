'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const config = require('../config');
const { decrypt } = require('../services/cryptoService');

const ARC_CHAIN_ID = 5042002n;

const POOL_ABI = [
  'function owner() view returns (address)',
  'function CADENCE() view returns (uint8)',
  'function nextRoundId() view returns (uint256)',
  'function createRound(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt) returns (uint256)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
];

function requireAddress(name, value) {
  if (!ethers.isAddress(value || '')) {
    throw new Error(`${name}_invalid`);
  }
  return ethers.getAddress(value);
}

function requireUint(name, value) {
  if (!/^[0-9]+$/.test(String(value || ''))) {
    throw new Error(`${name}_invalid`);
  }
  return BigInt(value);
}

function validateCadence(cadence, entryCloseAt, observationStartAt, observationEndAt) {
  if (cadence === 0) {
    if (observationStartAt !== entryCloseAt + 4n * 60n * 60n) {
      throw new Error('daily_lead_invalid');
    }
    if (observationEndAt !== observationStartAt + 24n * 60n * 60n) {
      throw new Error('daily_duration_invalid');
    }
    return;
  }

  if (cadence === 1) {
    if (observationStartAt !== entryCloseAt + 24n * 60n * 60n) {
      throw new Error('weekly_lead_invalid');
    }
    if (observationEndAt !== observationStartAt + 7n * 24n * 60n * 60n) {
      throw new Error('weekly_duration_invalid');
    }
    return;
  }

  if (cadence === 2) {
    if (observationStartAt !== entryCloseAt + 24n * 60n * 60n) {
      throw new Error('quarterly_lead_invalid');
    }
    const duration = observationEndAt - observationStartAt;
    if (
      duration < 89n * 24n * 60n * 60n ||
      duration > 92n * 24n * 60n * 60n
    ) {
      throw new Error('quarterly_duration_invalid');
    }
    return;
  }

  throw new Error('cadence_invalid');
}

async function main() {
  if (process.env.CONFIRM_CREATE_NEXT_ROUND !== 'YES') {
    throw new Error('set_CONFIRM_CREATE_NEXT_ROUND=YES_to_broadcast');
  }

  const poolAddress = requireAddress('POOL_ADDRESS', process.env.POOL_ADDRESS);
  const entryCloseAt = requireUint('ENTRY_CLOSE_AT', process.env.ENTRY_CLOSE_AT);
  const observationStartAt = requireUint(
    'OBSERVATION_START_AT',
    process.env.OBSERVATION_START_AT,
  );
  const observationEndAt = requireUint(
    'OBSERVATION_END_AT',
    process.env.OBSERVATION_END_AT,
  );

  const provider = new ethers.JsonRpcProvider(
    config.ARC_TESTNET_RPC_URL,
    { chainId: Number(ARC_CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );

  const network = await provider.getNetwork();
  if (network.chainId !== ARC_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const latest = await provider.getBlock('latest');
  if (!latest) throw new Error('latest_block_unavailable');

  const now = BigInt(latest.timestamp);
  if (now >= entryCloseAt) throw new Error('entry_close_not_in_future');
  if (!(entryCloseAt <= observationStartAt && observationStartAt < observationEndAt)) {
    throw new Error('round_timestamps_invalid');
  }

  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [owner, cadenceRaw, nextRoundId] = await Promise.all([
    pool.owner(),
    pool.CADENCE(),
    pool.nextRoundId(),
  ]);

  const cadence = Number(cadenceRaw);
  validateCadence(cadence, entryCloseAt, observationStartAt, observationEndAt);

  if (nextRoundId !== 2n) {
    throw new Error(`unexpected_next_round_id_${nextRoundId.toString()}`);
  }

  const ownerAddress = ethers.getAddress(owner);
  const { rows } = await db.query(
    `SELECT wallet_address, private_key_encrypted
       FROM extrema_wallets
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [ownerAddress],
  );

  if (!rows.length) {
    throw new Error('pool_owner_wallet_not_found_in_backend');
  }

  const privateKey = decrypt(rows[0].private_key_encrypted);
  const signer = new ethers.Wallet(privateKey, provider);

  if (signer.address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error('pool_owner_signer_mismatch');
  }

  const entryOpenAt = now;
  const writablePool = pool.connect(signer);

  console.log(JSON.stringify({
    broadcast: true,
    chainId: Number(network.chainId),
    poolAddress,
    owner: ownerAddress,
    roundId: Number(nextRoundId),
    cadence,
    entryOpenAt: entryOpenAt.toString(),
    entryCloseAt: entryCloseAt.toString(),
    observationStartAt: observationStartAt.toString(),
    observationEndAt: observationEndAt.toString(),
  }, null, 2));

  const tx = await writablePool.createRound(
    entryOpenAt,
    entryCloseAt,
    observationStartAt,
    observationEndAt,
  );
  const receipt = await tx.wait();

  if (!receipt || receipt.status !== 1) {
    throw new Error('create_round_transaction_failed');
  }

  const createdRoundId = nextRoundId;
  const round = await pool.getRound(createdRoundId);

  if (
    round.entryOpenAt !== entryOpenAt ||
    round.entryCloseAt !== entryCloseAt ||
    round.observationStartAt !== observationStartAt ||
    round.observationEndAt !== observationEndAt ||
    Number(round.status) !== 0 ||
    Number(round.entryCount) !== 0
  ) {
    throw new Error('create_round_postcondition_failed');
  }

  console.log(`CREATE_NEXT_ROUND=PASS`);
  console.log(`ROUND_ID=${createdRoundId.toString()}`);
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
