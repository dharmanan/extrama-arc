'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const db = require('../db');
const arcService = require('./arcService');
const walletService = require('./walletService');
const { APPROVED_SEED_WALLETS } = require('./seedBotCore');
const {
  getArcReadProvider,
  getArcWriteProvider,
} = require('./arcRpcProviderService');

const ARC_CHAIN_ID = 5042002;
const CLAIM_DELAY_MS = 60 * 60 * 1000;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const LOCK_BUSY_DELAY_MS = 60 * 1000;
const SEED_AUTOMATION_LOCK_ID = '5042002072';

const CLAIM_INTERFACE = new ethers.Interface([
  'function claim(uint256 tokenId)',
]);

let running = false;
let timer = null;

function addressKey(value) {
  return String(value || '').toLowerCase();
}

function enabled() {
  return config.NODE_ENV === 'production' && Boolean(config.EXTREMA_ENABLE_SEED_BOTS);
}

function uncertainError(message) {
  const error = new Error(message);
  error.claimOutcomeUncertain = true;
  return error;
}

async function withSeedAutomationLock(work) {
  const client = await db.getClient();
  let locked = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [SEED_AUTOMATION_LOCK_ID],
    );
    locked = Boolean(result.rows?.[0]?.locked);
    if (!locked) return { locked: false, reason: 'seed_scheduler_lock_busy' };
    return await work(client);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [SEED_AUTOMATION_LOCK_ID]);
      } catch (error) {
        console.error('[seed-claim] advisory unlock failed', error.message);
      }
    }
    client.release();
  }
}

async function resolveSeedUser(client, wallet) {
  if (!APPROVED_SEED_WALLETS.some((item) => addressKey(item) === addressKey(wallet))) {
    throw new Error('seed_claim_wallet_not_approved');
  }

  const { rows } = await client.query(
    `SELECT user_id, wallet_address
       FROM extrema_wallets
      WHERE LOWER(wallet_address)=LOWER($1)
      LIMIT 1`,
    [wallet],
  );

  if (!rows.length) throw new Error('seed_claim_wallet_not_found');
  if (addressKey(rows[0].wallet_address) !== addressKey(wallet)) {
    throw new Error('seed_claim_wallet_integrity_mismatch');
  }

  return rows[0].user_id;
}

async function readAttempt(client, ticket) {
  const { rows } = await client.query(
    `SELECT *
       FROM seed_bot_claim_attempts
      WHERE LOWER(pool_address)=LOWER($1)
        AND token_id=$2
      LIMIT 1`,
    [ticket.poolAddress, String(ticket.tokenId)],
  );
  return rows[0] || null;
}

async function savePreparedAttempt(client, ticket, wallet, nonce, txHash) {
  await client.query(
    `INSERT INTO seed_bot_claim_attempts (
       pool_address, token_id, wallet_address, round_id, amount_raw,
       nonce, tx_hash, status, last_error, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PREPARED',NULL,NOW())
     ON CONFLICT (pool_address, token_id)
     DO UPDATE SET
       wallet_address=EXCLUDED.wallet_address,
       round_id=EXCLUDED.round_id,
       amount_raw=EXCLUDED.amount_raw,
       nonce=EXCLUDED.nonce,
       tx_hash=EXCLUDED.tx_hash,
       status='PREPARED',
       last_error=NULL,
       updated_at=NOW()`,
    [
      ticket.poolAddress,
      String(ticket.tokenId),
      wallet,
      Number(ticket.roundId),
      String(ticket.claimableRaw),
      nonce,
      txHash,
    ],
  );
}

async function updateAttempt(client, ticket, status, lastError = null) {
  await client.query(
    `UPDATE seed_bot_claim_attempts
        SET status=$3, last_error=$4, updated_at=NOW()
      WHERE LOWER(pool_address)=LOWER($1)
        AND token_id=$2`,
    [ticket.poolAddress, String(ticket.tokenId), status, lastError],
  );
}

async function readClaimState(ticket) {
  return arcService.readClaimAuthorizationState({
    poolAddress: ticket.poolAddress,
    ticketAddress: ticket.ticketAddress,
    tokenId: String(ticket.tokenId),
    roundId: Number(ticket.roundId),
  });
}

function assertFreshClaimable(state, ticket, wallet) {
  if (state.roundStatus !== 'SETTLED') throw new Error('seed_claim_round_not_settled');
  if (state.isClaimed) throw new Error('seed_claim_already_claimed');
  if (addressKey(state.currentOwner) !== addressKey(wallet)) {
    throw new Error('seed_claim_owner_mismatch');
  }
  if (String(state.claimableRaw) !== String(ticket.claimableRaw)) {
    throw new Error('seed_claim_amount_changed');
  }
  if (BigInt(state.claimableRaw) <= 0n) throw new Error('seed_claim_nothing_to_claim');
}

async function reconcileAttempt(client, ticket, attempt, readProvider) {
  const state = await readClaimState(ticket);
  if (state.isClaimed && state.claimableRaw === '0') {
    await updateAttempt(client, ticket, 'CONFIRMED');
    return { confirmed: true, reason: 'already_claimed_onchain' };
  }

  if (!attempt?.tx_hash) {
    throw uncertainError('seed_claim_prepared_hash_missing');
  }

  const receipt = await readProvider.getTransactionReceipt(attempt.tx_hash);
  if (!receipt) {
    throw uncertainError(`seed_claim_receipt_unknown:${attempt.tx_hash}`);
  }

  if (Number(receipt.status) !== 1) {
    await updateAttempt(client, ticket, 'FAILED', 'receipt_status_failed');
    return { confirmed: false, retryable: true, reason: 'known_failed_receipt' };
  }

  const after = await readClaimState(ticket);
  if (!after.isClaimed || after.claimableRaw !== '0') {
    throw uncertainError(`seed_claim_receipt_postcondition_unknown:${attempt.tx_hash}`);
  }

  await updateAttempt(client, ticket, 'CONFIRMED');
  return { confirmed: true, reason: 'receipt_reconciled' };
}

async function executeClaim(client, wallet, ticket) {
  const readProvider = getArcReadProvider();
  const writeProvider = getArcWriteProvider();

  const existing = await readAttempt(client, ticket);
  if (existing?.status === 'CONFIRMED') {
    return { executed: false, reason: 'already_confirmed' };
  }
  if (existing?.status === 'PREPARED' || existing?.status === 'UNCERTAIN') {
    const reconciled = await reconcileAttempt(client, ticket, existing, readProvider);
    if (reconciled.confirmed) {
      return { executed: false, reason: reconciled.reason, txHash: existing.tx_hash };
    }
  }

  const state = await readClaimState(ticket);
  if (state.isClaimed && state.claimableRaw === '0') {
    if (existing) await updateAttempt(client, ticket, 'CONFIRMED');
    return { executed: false, reason: 'already_claimed_onchain' };
  }
  assertFreshClaimable(state, ticket, wallet);

  const userId = await resolveSeedUser(client, wallet);
  const signer = await walletService.getSignerForUser(userId, writeProvider);
  if (addressKey(signer.address) !== addressKey(wallet)) {
    throw new Error('seed_claim_signer_mismatch');
  }

  const [latest, pending] = await Promise.all([
    readProvider.getTransactionCount(wallet, 'latest'),
    readProvider.getTransactionCount(wallet, 'pending'),
  ]);
  if (latest !== pending) throw new Error('seed_claim_pending_nonce');

  const data = CLAIM_INTERFACE.encodeFunctionData('claim', [BigInt(ticket.tokenId)]);
  const [estimatedGas, fee] = await Promise.all([
    readProvider.estimateGas({
      from: wallet,
      to: ticket.poolAddress,
      data,
      value: 0n,
    }),
    readProvider.getFeeData(),
  ]);

  if (fee.maxFeePerGas === null || fee.maxPriorityFeePerGas === null) {
    throw new Error('seed_claim_fee_data_unavailable');
  }

  const signedTx = await signer.signTransaction({
    type: 2,
    chainId: ARC_CHAIN_ID,
    nonce: pending,
    to: ticket.poolAddress,
    value: 0n,
    data,
    gasLimit: (estimatedGas * 125n) / 100n + 10000n,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
  });
  const txHash = ethers.keccak256(signedTx);

  await savePreparedAttempt(client, ticket, wallet, pending, txHash);

  console.log(
    '[seed-claim] prepared',
    JSON.stringify({
      wallet,
      slug: ticket.slug,
      roundId: ticket.roundId,
      tokenId: ticket.tokenId,
      amountRaw: ticket.claimableRaw,
      nonce: pending,
      txHash,
    }),
  );

  try {
    await writeProvider.broadcastTransaction(signedTx);
  } catch (error) {
    try {
      const reconciled = await reconcileAttempt(
        client,
        ticket,
        { tx_hash: txHash },
        readProvider,
      );
      if (reconciled.confirmed) {
        return { executed: true, reason: 'broadcast_reconciled', txHash };
      }
    } catch {}
    await updateAttempt(client, ticket, 'UNCERTAIN', error.message);
    throw uncertainError(`seed_claim_broadcast_uncertain:${txHash}`);
  }

  let receipt;
  try {
    receipt = await readProvider.waitForTransaction(txHash, 1, 120000);
  } catch (error) {
    await updateAttempt(client, ticket, 'UNCERTAIN', error.message);
    throw uncertainError(`seed_claim_receipt_uncertain:${txHash}`);
  }

  if (!receipt || Number(receipt.status) !== 1) {
    await updateAttempt(client, ticket, 'FAILED', 'receipt_status_failed');
    throw new Error(`seed_claim_transaction_failed:${txHash}`);
  }

  const after = await readClaimState(ticket);
  if (!after.isClaimed || after.claimableRaw !== '0') {
    await updateAttempt(client, ticket, 'UNCERTAIN', 'postcondition_failed');
    throw uncertainError(`seed_claim_postcondition_uncertain:${txHash}`);
  }

  await updateAttempt(client, ticket, 'CONFIRMED');
  arcService.invalidateArcWalletStateCache(wallet);

  console.log(
    '[seed-claim] confirmed',
    JSON.stringify({
      wallet,
      slug: ticket.slug,
      roundId: ticket.roundId,
      tokenId: ticket.tokenId,
      amountRaw: ticket.claimableRaw,
      txHash,
      blockNumber: receipt.blockNumber,
    }),
  );

  return { executed: true, reason: 'claim_confirmed', txHash };
}

async function runClaimSweep(client) {
  let discovered = 0;
  let confirmed = 0;

  for (const wallet of APPROVED_SEED_WALLETS) {
    const state = await arcService.readOwnedTickets(wallet);
    const claimable = (state.tickets || []).filter(
      (ticket) =>
        ticket.cadence === 'DAILY' &&
        ticket.roundStatus === 'SETTLED' &&
        ticket.isClaimed === false &&
        BigInt(ticket.claimableRaw || '0') > 0n &&
        addressKey(ticket.owner) === addressKey(wallet),
    );

    discovered += claimable.length;

    for (const ticket of claimable) {
      const result = await executeClaim(client, wallet, ticket);
      if (result.executed || result.reason === 'already_claimed_onchain' || result.reason === 'receipt_reconciled') {
        confirmed += 1;
      }
    }
  }

  return { discovered, confirmed };
}

async function deferJob(jobKey, delayMs, errorMessage = null) {
  await db.query(
    `UPDATE seed_bot_claim_jobs
        SET due_at=NOW() + ($2::bigint * INTERVAL '1 millisecond'),
            last_error=$3,
            updated_at=NOW()
      WHERE job_key=$1
        AND status='PENDING'`,
    [jobKey, delayMs, errorMessage],
  );
}

async function hasBlockedClaimState(database = db) {
  const { rows } = await database.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM seed_bot_claim_jobs WHERE status='BLOCKED'
       ) OR EXISTS (
         SELECT 1 FROM seed_bot_claim_attempts WHERE status='UNCERTAIN'
       ) AS blocked`,
  );
  return Boolean(rows[0]?.blocked);
}

async function runDueJob() {
  if (!running || !enabled()) return;
  if (await hasBlockedClaimState()) {
    console.error('[seed-claim] automation blocked by unresolved claim state');
    return;
  }

  const lockResult = await withSeedAutomationLock(async (client) => {
    const { rows } = await client.query(
      `SELECT job_key, observation_end_at, due_at
         FROM seed_bot_claim_jobs
        WHERE status='PENDING'
          AND due_at <= NOW()
        ORDER BY due_at ASC
        LIMIT 1`,
    );

    const job = rows[0];
    if (!job) return { locked: true, ran: false };

    try {
      const sweep = await runClaimSweep(client);
      await client.query(
        `UPDATE seed_bot_claim_jobs
            SET status='DONE',
                completed_at=NOW(),
                last_error=NULL,
                updated_at=NOW()
          WHERE job_key=$1`,
        [job.job_key],
      );

      console.log(
        '[seed-claim] daily sweep complete',
        JSON.stringify({
          jobKey: job.job_key,
          observationEndAt: job.observation_end_at,
          discovered: sweep.discovered,
          confirmed: sweep.confirmed,
        }),
      );

      return { locked: true, ran: true, completed: true };
    } catch (error) {
      if (error.claimOutcomeUncertain) {
        await client.query(
          `UPDATE seed_bot_claim_jobs
              SET status='BLOCKED',
                  last_error=$2,
                  updated_at=NOW()
            WHERE job_key=$1`,
          [job.job_key, error.message],
        );
        console.error(
          '[seed-claim] daily sweep blocked; no automatic resend',
          JSON.stringify({ jobKey: job.job_key, reason: error.message }),
        );
        return { locked: true, ran: true, blocked: true };
      }

      await client.query(
        `UPDATE seed_bot_claim_jobs
            SET due_at=NOW() + ($2::bigint * INTERVAL '1 millisecond'),
                last_error=$3,
                updated_at=NOW()
          WHERE job_key=$1
            AND status='PENDING'`,
        [job.job_key, RETRY_DELAY_MS, error.message],
      );
      console.error(
        '[seed-claim] daily sweep deferred after safe failure',
        JSON.stringify({ jobKey: job.job_key, reason: error.message }),
      );
      return { locked: true, ran: true, deferred: true };
    }
  });

  if (lockResult?.locked === false) {
    const { rows } = await db.query(
      `SELECT job_key
         FROM seed_bot_claim_jobs
        WHERE status='PENDING'
          AND due_at <= NOW()
        ORDER BY due_at ASC
        LIMIT 1`,
    );
    if (rows[0]) {
      await deferJob(rows[0].job_key, LOCK_BUSY_DELAY_MS, 'seed_scheduler_lock_busy');
    }
  }
}

async function scheduleNextPendingJob() {
  if (!running || !enabled()) return;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  if (await hasBlockedClaimState()) {
    console.error('[seed-claim] scheduler paused by unresolved claim state');
    return;
  }

  const { rows } = await db.query(
    `SELECT job_key, due_at
       FROM seed_bot_claim_jobs
      WHERE status='PENDING'
      ORDER BY due_at ASC
      LIMIT 1`,
  );

  if (!rows[0]) return;

  const dueAtMs = new Date(rows[0].due_at).getTime();
  const delayMs = Math.max(0, dueAtMs - Date.now());

  timer = setTimeout(async () => {
    timer = null;
    try {
      await runDueJob();
    } catch (error) {
      console.error('[seed-claim] scheduled job failed', error.message);
    } finally {
      scheduleNextPendingJob().catch((error) => {
        console.error('[seed-claim] reschedule failed', error.message);
      });
    }
  }, delayMs);
  timer.unref?.();

  console.log(
    '[seed-claim] next daily sweep scheduled',
    JSON.stringify({ jobKey: rows[0].job_key, at: new Date(dueAtMs).toISOString() }),
  );
}

async function scheduleDailySettlements({ settlements, settledAtMs = Date.now() } = {}) {
  if (!enabled() || !Array.isArray(settlements) || settlements.length === 0) return;

  const groups = new Map();
  for (const item of settlements) {
    if (item?.action !== 'settled' || item?.cadence !== 'DAILY' || !item?.observationEndAt) continue;
    const observationEndAt = new Date(item.observationEndAt);
    if (Number.isNaN(observationEndAt.getTime())) continue;
    groups.set(observationEndAt.toISOString(), observationEndAt);
  }

  const dueAt = new Date(settledAtMs + CLAIM_DELAY_MS);

  for (const observationEndAt of groups.values()) {
    const jobKey = `daily:${observationEndAt.getTime()}`;
    await db.query(
      `INSERT INTO seed_bot_claim_jobs (
         job_key, observation_end_at, due_at, status, updated_at
       )
       VALUES ($1,$2,$3,'PENDING',NOW())
       ON CONFLICT (job_key)
       DO UPDATE SET
         due_at=CASE
           WHEN seed_bot_claim_jobs.status IN ('DONE','BLOCKED')
             THEN seed_bot_claim_jobs.due_at
           ELSE GREATEST(seed_bot_claim_jobs.due_at, EXCLUDED.due_at)
         END,
         status=CASE
           WHEN seed_bot_claim_jobs.status IN ('DONE','BLOCKED')
             THEN seed_bot_claim_jobs.status
           ELSE 'PENDING'
         END,
         completed_at=CASE
           WHEN seed_bot_claim_jobs.status IN ('DONE','BLOCKED')
             THEN seed_bot_claim_jobs.completed_at
           ELSE NULL
         END,
         last_error=CASE
           WHEN seed_bot_claim_jobs.status IN ('DONE','BLOCKED')
             THEN seed_bot_claim_jobs.last_error
           ELSE NULL
         END,
         updated_at=NOW()`,
      [jobKey, observationEndAt.toISOString(), dueAt.toISOString()],
    );
  }

  await scheduleNextPendingJob();
}

async function bootstrapCatchUp() {
  if (!enabled()) return;

  const pending = await db.query(
    `SELECT 1
       FROM seed_bot_claim_jobs
      WHERE status='PENDING'
      LIMIT 1`,
  );
  if (pending.rows.length) return;

  const claimable = [];
  for (const wallet of APPROVED_SEED_WALLETS) {
    const state = await arcService.readOwnedTickets(wallet);
    for (const ticket of state.tickets || []) {
      if (
        ticket.cadence === 'DAILY' &&
        ticket.roundStatus === 'SETTLED' &&
        ticket.isClaimed === false &&
        BigInt(ticket.claimableRaw || '0') > 0n
      ) {
        claimable.push(ticket);
      }
    }
  }

  if (!claimable.length) return;

  const jobs = new Map();
  for (const ticket of claimable) {
    const { rows } = await db.query(
      `SELECT observation_end_at, created_at
         FROM settlement_evidence
        WHERE LOWER(pool_address)=LOWER($1)
          AND round_id=$2
        LIMIT 1`,
      [ticket.poolAddress, ticket.roundId],
    );
    if (!rows[0]) {
      console.warn(
        '[seed-claim] catch-up skipped claim without settlement evidence',
        JSON.stringify({ poolAddress: ticket.poolAddress, roundId: ticket.roundId, tokenId: ticket.tokenId }),
      );
      continue;
    }

    const observationEndAt = new Date(rows[0].observation_end_at);
    const dueAt = new Date(new Date(rows[0].created_at).getTime() + CLAIM_DELAY_MS);
    const key = observationEndAt.toISOString();
    const previous = jobs.get(key);
    if (!previous || dueAt > previous.dueAt) {
      jobs.set(key, { observationEndAt, dueAt });
    }
  }

  for (const { observationEndAt, dueAt } of jobs.values()) {
    const jobKey = `daily:${observationEndAt.getTime()}`;
    await db.query(
      `INSERT INTO seed_bot_claim_jobs (
         job_key, observation_end_at, due_at, status, updated_at
       )
       VALUES ($1,$2,$3,'PENDING',NOW())
       ON CONFLICT (job_key) DO NOTHING`,
      [jobKey, observationEndAt.toISOString(), dueAt.toISOString()],
    );
  }
}

async function start() {
  if (running) return false;
  if (!enabled()) {
    console.log('[seed-claim] automation disabled');
    return false;
  }

  running = true;

  try {
    await bootstrapCatchUp();
    await scheduleNextPendingJob();
    console.log('[seed-claim] daily settlement +1h automation active');
  } catch (error) {
    running = false;
    throw error;
  }

  return true;
}

function stop() {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = {
  CLAIM_DELAY_MS,
  SEED_AUTOMATION_LOCK_ID,
  scheduleDailySettlements,
  start,
  stop,
};
