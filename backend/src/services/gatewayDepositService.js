'use strict';

// Durable Gateway SOURCE deposit state machine: USDC.approve(GatewayWallet,
// amount) then GatewayWallet.deposit(token, amount) on a source chain, for
// both human execution modes. This is deliberately separate from
// gatewayFundingService: that module spends an ALREADY existing unified
// balance to Arc via a signed burn intent; this module is what gets USDC into
// that unified balance in the first place.
//
// Source chains are config driven: one state machine, four configurations.
// Every deposit source network declared in gatewayNetworks (Base Sepolia,
// OP Sepolia, Arbitrum Sepolia and Ethereum Sepolia) runs these exact phases,
// and none of the logic below branches on which chain it is funding from. An
// unlisted or non source domain fails closed with
// gateway_deposit_source_unsupported.
//
// Financial safety: every phase transition that follows a Circle challenge or
// an external transaction hash is a durable, idempotent step. A lost response
// is reconciled read-only (RECONCILIATION_REQUIRED) and never causes a second
// approval, a second deposit, or a second Circle challenge to be created.

const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../db');
const gatewayService = require('./gatewayService');
const gatewayNetworks = require('./gatewayNetworks');
const gatewaySourceChainService = require('./gatewaySourceChainService');
const circleUserWalletService = require('./circleUserWalletService');
const circleExecutionEngine = require('./circleExecutionEngine');
const { EXECUTION_MODES, isHumanExecutionMode } = require('./executionIdentityService');

const DEPOSIT_TTL_MS = 30 * 60 * 1000;

// The real source chain configurations, derived from the one canonical network
// table. A test injects its own `sourceChains` map into
// createGatewayDepositService so no deterministic verification ever reaches a
// real RPC endpoint.
const SOURCE_CHAINS = gatewaySourceChainService.sourceChainExecutionMap();

function assertHumanSession(auth) {
  if (
    !auth || !isHumanExecutionMode(auth.executionMode) ||
    typeof auth.userId !== 'string' || !ethers.isAddress(auth.walletAddress)
  ) {
    throw new Error('gateway_wallet_session_required');
  }
}

const RECOVERY_DISPOSITIONS = Object.freeze({
  CLEAR: 'CLEAR',
  RESUME: 'RESUME',
  RECONCILE: 'RECONCILE',
});

const ACTIVE_RESUMABLE_STATES = new Set([
  'STARTED',
  'BASELINE_READ',
  'APPROVAL_REQUIRED',
  'APPROVAL_CHALLENGE',
  'APPROVAL_PENDING',
  'APPROVAL_VERIFIED',
  'DEPOSIT_REQUIRED',
  'DEPOSIT_CHALLENGE',
  'DEPOSIT_PENDING',
  'DEPOSIT_VERIFIED',
]);

const RECONCILIATION_STATES = new Set([
  'RECONCILING',
  'RECONCILIATION_REQUIRED',
]);

const SUBMITTED_FINANCIAL_STATES = new Set([
  'APPROVAL_PENDING',
  'APPROVAL_VERIFIED',
  'DEPOSIT_PENDING',
  'DEPOSIT_VERIFIED',
  'RECONCILING',
  'RECONCILIATION_REQUIRED',
]);

function hasDurableValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// This is the sole authority for recovery-release safety. A persisted Circle
// challenge is treated as uncertain rather than clean: the browser may have
// shown it to the user before a response was lost, and only the durable row
// can say whether Circle subsequently observed a transaction. Idempotency and
// ref identifiers alone are not financial submission evidence.
function hasSubmittedFinancialEvidence(row) {
  return SUBMITTED_FINANCIAL_STATES.has(row.state) || [
    row.approval_tx_hash,
    row.deposit_tx_hash,
    row.approval_circle_challenge_id,
    row.deposit_circle_challenge_id,
    row.approval_circle_transaction_id,
    row.deposit_circle_transaction_id,
  ].some(hasDurableValue);
}

function recoveryDispositionFor(row) {
  if (!row || typeof row.state !== 'string') return RECOVERY_DISPOSITIONS.RECONCILE;
  if (row.state === 'COMPLETED') return RECOVERY_DISPOSITIONS.CLEAR;
  if (ACTIVE_RESUMABLE_STATES.has(row.state)) return RECOVERY_DISPOSITIONS.RESUME;
  if (RECONCILIATION_STATES.has(row.state)) return RECOVERY_DISPOSITIONS.RECONCILE;
  if (row.state === 'FAILED' || row.state === 'EXPIRED') {
    return hasSubmittedFinancialEvidence(row)
      ? RECOVERY_DISPOSITIONS.RECONCILE
      : RECOVERY_DISPOSITIONS.CLEAR;
  }
  // A new state is not evidence of a clean terminal outcome. Keep the action
  // closed until its semantics are explicitly classified.
  return RECOVERY_DISPOSITIONS.RECONCILE;
}

const ACTIVITY_PHASES = Object.freeze({
  APPROVAL_PREPARING: 'APPROVAL_PREPARING',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_SUBMITTED: 'APPROVAL_SUBMITTED',
  DEPOSIT_PREPARING: 'DEPOSIT_PREPARING',
  DEPOSIT_CONFIRMATION_REQUIRED: 'DEPOSIT_CONFIRMATION_REQUIRED',
  DEPOSIT_SUBMITTED: 'DEPOSIT_SUBMITTED',
  GATEWAY_FINALITY: 'GATEWAY_FINALITY',
  COMPLETED: 'COMPLETED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

function activityStatusFor(row) {
  const disposition = recoveryDispositionFor(row);
  if (disposition === RECOVERY_DISPOSITIONS.RECONCILE && ['FAILED', 'EXPIRED'].includes(row.state)) {
    return { stage: 'REVIEW', phase: ACTIVITY_PHASES.NEEDS_REVIEW, actionRequired: true };
  }

  switch (row.state) {
    case 'STARTED':
    case 'BASELINE_READ':
      return { stage: 'APPROVAL', phase: ACTIVITY_PHASES.APPROVAL_PREPARING, actionRequired: false };
    case 'APPROVAL_REQUIRED':
      return { stage: 'APPROVAL', phase: ACTIVITY_PHASES.APPROVAL_REQUIRED, actionRequired: true };
    case 'APPROVAL_CHALLENGE':
      return { stage: 'APPROVAL', phase: ACTIVITY_PHASES.APPROVAL_REQUIRED, actionRequired: true };
    case 'APPROVAL_PENDING':
      return { stage: 'APPROVAL', phase: ACTIVITY_PHASES.APPROVAL_SUBMITTED, actionRequired: false };
    case 'APPROVAL_VERIFIED':
    case 'DEPOSIT_REQUIRED':
      return { stage: 'DEPOSIT', phase: ACTIVITY_PHASES.DEPOSIT_PREPARING, actionRequired: false };
    case 'DEPOSIT_CHALLENGE':
      return { stage: 'DEPOSIT', phase: ACTIVITY_PHASES.DEPOSIT_CONFIRMATION_REQUIRED, actionRequired: true };
    case 'DEPOSIT_PENDING':
    case 'DEPOSIT_VERIFIED':
      return { stage: 'DEPOSIT', phase: ACTIVITY_PHASES.DEPOSIT_SUBMITTED, actionRequired: false };
    case 'RECONCILING':
      return { stage: 'FINALITY', phase: ACTIVITY_PHASES.GATEWAY_FINALITY, actionRequired: false };
    case 'COMPLETED':
      return { stage: 'COMPLETED', phase: ACTIVITY_PHASES.COMPLETED, actionRequired: false };
    case 'RECONCILIATION_REQUIRED':
      return { stage: 'REVIEW', phase: ACTIVITY_PHASES.NEEDS_REVIEW, actionRequired: true };
    case 'FAILED':
      return { stage: 'FAILED', phase: ACTIVITY_PHASES.FAILED, actionRequired: true };
    case 'EXPIRED':
      return { stage: 'EXPIRED', phase: ACTIVITY_PHASES.EXPIRED, actionRequired: true };
    default:
      return { stage: 'REVIEW', phase: ACTIVITY_PHASES.NEEDS_REVIEW, actionRequired: true };
  }
}

function activityItemFor(row) {
  const source = gatewayNetworks.depositSourceForDomain(Number(row.source_domain));
  const status = activityStatusFor(row);
  const disposition = recoveryDispositionFor(row);
  return {
    actionId: row.id,
    sourceDomain: Number(row.source_domain),
    sourceChainId: Number(row.source_chain_id),
    sourceLabel: source ? source.label : 'Unknown source network',
    amountRaw: row.amount_raw,
    state: row.state,
    recoveryDisposition: disposition,
    approvalTxHash: row.approval_tx_hash || null,
    depositTxHash: row.deposit_tx_hash || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at || row.created_at).toISOString(),
    stage: status.stage,
    phase: status.phase,
    actionRequired: status.actionRequired || disposition === RECOVERY_DISPOSITIONS.RECONCILE,
    interactive: disposition === RECOVERY_DISPOSITIONS.RESUME,
    terminal: disposition === RECOVERY_DISPOSITIONS.CLEAR,
  };
}

function publicAction(row, options = {}) {
  return {
    actionId: row.id,
    requestId: row.request_id,
    executionMode: row.execution_mode,
    sourceDomain: Number(row.source_domain),
    sourceChainId: Number(row.source_chain_id),
    amountRaw: row.amount_raw,
    state: row.state,
    // The browser must use this backend-derived disposition instead of trying
    // to infer financial certainty from a terminal state name or tab storage.
    recoveryDisposition: recoveryDispositionFor(row),
    approvalTxHash: row.approval_tx_hash || null,
    approvalChallengeId: row.approval_circle_challenge_id || null,
    depositTxHash: row.deposit_tx_hash || null,
    depositChallengeId: row.deposit_circle_challenge_id || null,
    pending: options.pending === true,
    // Distinguishes "Circle already observed a transaction for this
    // challenge, keep polling" from "the challenge has not been executed
    // yet" so the browser never re-shows an already-approved hosted widget.
    transactionObserved: options.transactionObserved === true,
    transactionRequest: options.transactionRequest || null,
    lastError: row.last_error || null,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

// Adapts one gateway_deposit_actions row into the shape
// circleExecutionEngine's phaseRecord()/existingChallenge() expect: the
// APPROVAL phase reads circleApproval*, the ACTION phase (used here for the
// deposit) reads circleAction*.
function toEnginePhaseShape(row) {
  return {
    id: row.id,
    payloadHash: null,
    circleApprovalChallengeId: row.approval_circle_challenge_id,
    circleApprovalIdempotencyKey: row.approval_circle_idempotency_key,
    circleApprovalRefId: row.approval_circle_ref_id,
    circleApprovalTransactionId: row.approval_circle_transaction_id,
    circleActionChallengeId: row.deposit_circle_challenge_id,
    circleActionIdempotencyKey: row.deposit_circle_idempotency_key,
    circleActionRefId: row.deposit_circle_ref_id,
    circleActionTransactionId: row.deposit_circle_transaction_id,
  };
}

function createGatewayDepositService({
  database = db,
  gateway = gatewayService,
  circle = circleUserWalletService,
  engine = circleExecutionEngine,
  sourceChains = SOURCE_CHAINS,
  now = () => Date.now(),
} = {}) {
  function isExpired(row) {
    return new Date(row.expires_at).getTime() <= now();
  }

  function sourceConfigFor(sourceDomain) {
    const entry = sourceChains.get(sourceDomain);
    if (!entry) throw new Error('gateway_deposit_source_unsupported');
    return entry;
  }

  function assertInput({ requestId, sourceDomain, amountRaw }) {
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      throw new Error('gateway_request_id_invalid');
    }
    sourceConfigFor(sourceDomain);
    if (typeof amountRaw !== 'string' || !/^[1-9]\d*$/.test(amountRaw)) {
      throw new Error('gateway_value_invalid');
    }
  }

  async function fetchRow(actionId, userId, walletAddress) {
    const result = await database.query(
      `SELECT * FROM gateway_deposit_actions
        WHERE id = $1 AND user_id = $2 AND lower(wallet_address) = lower($3)
        LIMIT 1`,
      [actionId, userId, walletAddress],
    );
    const row = result.rows[0];
    if (!row) throw new Error('gateway_deposit_action_not_found');
    return row;
  }

  function depositPort() {
    return {
      invalidError: 'gateway_deposit_action_invalid',
      async getAction(userId, actionId, walletAddress) {
        return toEnginePhaseShape(await fetchRow(actionId, userId, walletAddress));
      },
      async reserveChallenge(userId, actionId, walletAddress, _circleWalletId, phaseName) {
        const prefix = phaseName === 'APPROVAL' ? 'approval' : 'deposit';
        await database.query(
          `UPDATE gateway_deposit_actions
              SET ${prefix}_circle_idempotency_key = COALESCE(${prefix}_circle_idempotency_key, $4),
                  ${prefix}_circle_ref_id = COALESCE(${prefix}_circle_ref_id, $5),
                  updated_at = NOW()
            WHERE id = $1 AND user_id = $2 AND lower(wallet_address) = lower($3)`,
          [actionId, userId, walletAddress, crypto.randomUUID(), crypto.randomUUID()],
        );
        return toEnginePhaseShape(await fetchRow(actionId, userId, walletAddress));
      },
      async persistChallenge(userId, actionId, walletAddress, _circleWalletId, phaseName, challengeId) {
        const prefix = phaseName === 'APPROVAL' ? 'approval' : 'deposit';
        const state = phaseName === 'APPROVAL' ? 'APPROVAL_CHALLENGE' : 'DEPOSIT_CHALLENGE';
        await database.query(
          `UPDATE gateway_deposit_actions
              SET ${prefix}_circle_challenge_id = $4, state = $5, last_error = NULL, updated_at = NOW()
            WHERE id = $1 AND user_id = $2 AND lower(wallet_address) = lower($3)`,
          [actionId, userId, walletAddress, challengeId, state],
        );
        return challengeId;
      },
      async persistTransactionId(userId, actionId, walletAddress, _circleWalletId, phaseName, transactionId) {
        const prefix = phaseName === 'APPROVAL' ? 'approval' : 'deposit';
        await database.query(
          `UPDATE gateway_deposit_actions
              SET ${prefix}_circle_transaction_id = $4, updated_at = NOW()
            WHERE id = $1 AND user_id = $2 AND lower(wallet_address) = lower($3)`,
          [actionId, userId, walletAddress, transactionId],
        );
        return toEnginePhaseShape(await fetchRow(actionId, userId, walletAddress));
      },
      async bindTransaction(userId, actionId, walletAddress, _circleWalletId, phaseName, transaction) {
        const prefix = phaseName === 'APPROVAL' ? 'approval' : 'deposit';
        await database.query(
          `UPDATE gateway_deposit_actions
              SET ${prefix}_tx_hash = $4, ${prefix}_circle_transaction_id = $5, updated_at = NOW()
            WHERE id = $1 AND user_id = $2 AND lower(wallet_address) = lower($3)`,
          [actionId, userId, walletAddress, transaction.txHash, transaction.id],
        );
        return toEnginePhaseShape(await fetchRow(actionId, userId, walletAddress));
      },
    };
  }

  async function findByRequest(auth, requestId) {
    const result = await database.query(
      `SELECT * FROM gateway_deposit_actions WHERE user_id = $1 AND request_id = $2 LIMIT 1`,
      [auth.userId, requestId],
    );
    return result.rows[0] || null;
  }

  // A lost browser recovery (sessionStorage cleared, new tab, split-brain
  // Circle auth) must never be the only thing standing between a genuinely
  // uncertain durable action and a second, concurrent one for the SAME
  // source domain: the browser has no memory of the first, but the backend
  // still does, and it is the only durable authority here. Scoped to
  // (user, wallet, execution mode, source domain) only: an unresolved OP
  // action must never block a distinct, intentionally selected Arbitrum
  // deposit, and a COMPLETED or evidence-free FAILED/EXPIRED row is CLEAR,
  // so funding the same source again afterward is never blocked.
  async function findUnresolvedForSource(auth, sourceDomain) {
    const result = await database.query(
      `SELECT * FROM gateway_deposit_actions
        WHERE user_id = $1 AND execution_mode = $2 AND lower(wallet_address) = lower($3)
          AND source_domain = $4
        ORDER BY created_at DESC`,
      [auth.userId, auth.executionMode, auth.walletAddress, sourceDomain],
    );
    return result.rows.find((row) => recoveryDispositionFor(row) !== RECOVERY_DISPOSITIONS.CLEAR) || null;
  }

  async function findById(auth, actionId) {
    const result = await database.query(
      `SELECT * FROM gateway_deposit_actions
        WHERE id = $1 AND user_id = $2 AND execution_mode = $3 AND lower(wallet_address) = lower($4)
        LIMIT 1`,
      [actionId, auth.userId, auth.executionMode, auth.walletAddress],
    );
    const row = result.rows[0];
    if (!row) throw new Error('gateway_deposit_action_not_found');
    return row;
  }

  async function markExpired(row) {
    // The TTL retires only actions with no durable/potential financial
    // submission evidence. A Circle challenge, transaction id or tx hash may
    // describe an already-approved operation even when its final receipt is
    // not available yet; those rows remain available for same-action,
    // read-only reconciliation. In particular, RECONCILIATION_REQUIRED never
    // becomes a clean EXPIRED outcome merely because time elapsed.
    if (
      isExpired(row) &&
      !['COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(row.state) &&
      !hasSubmittedFinancialEvidence(row)
    ) {
      const result = await database.query(
        `UPDATE gateway_deposit_actions
            SET state = 'EXPIRED', updated_at = NOW()
          WHERE id = $1
            AND state NOT IN (
              'COMPLETED', 'FAILED', 'APPROVAL_PENDING', 'APPROVAL_VERIFIED',
              'DEPOSIT_PENDING', 'DEPOSIT_VERIFIED', 'RECONCILING',
              'RECONCILIATION_REQUIRED'
            )
            AND approval_tx_hash IS NULL
            AND deposit_tx_hash IS NULL
            AND approval_circle_challenge_id IS NULL
            AND deposit_circle_challenge_id IS NULL
            AND approval_circle_transaction_id IS NULL
            AND deposit_circle_transaction_id IS NULL
          RETURNING *`,
        [row.id],
      );
      return result.rows[0] || row;
    }
    return row;
  }

  async function createOrGet(auth, input) {
    const actionId = crypto.randomUUID();
    const expiresAt = new Date(now() + DEPOSIT_TTL_MS);
    const source = sourceConfigFor(input.sourceDomain);
    await database.query(
      `INSERT INTO gateway_deposit_actions
        (id, user_id, request_id, execution_mode, wallet_address, source_domain,
         source_chain_id, amount_raw, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'STARTED', $9)
       ON CONFLICT (user_id, request_id) DO NOTHING`,
      [
        actionId, auth.userId, input.requestId, auth.executionMode,
        ethers.getAddress(auth.walletAddress), input.sourceDomain,
        source.chainId, input.amountRaw, expiresAt,
      ],
    );
    return findByRequest(auth, input.requestId);
  }

  async function readBaseline(row) {
    const balance = await gateway.readUnifiedUsdcBalance(row.wallet_address);
    const match = balance.balances.find((item) => item.domain === Number(row.source_domain));
    const baselineRaw = match ? match.balanceRaw : '0';
    const result = await database.query(
      `UPDATE gateway_deposit_actions
          SET baseline_domain_balance_raw = $2, state = 'BASELINE_READ', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'STARTED'
        RETURNING *`,
      [row.id, baselineRaw],
    );
    return result.rows[0] || row;
  }

  function stepFor(row) {
    if (['APPROVAL_REQUIRED', 'APPROVAL_CHALLENGE'].includes(row.state)) return 'APPROVAL_REQUIRED';
    if (['DEPOSIT_REQUIRED', 'DEPOSIT_CHALLENGE'].includes(row.state)) return 'DEPOSIT_REQUIRED';
    return row.state;
  }

  // --- External wallet branch --------------------------------------------

  async function prepareExternalPhase(row) {
    const source = sourceConfigFor(Number(row.source_domain));
    if (row.deposit_tx_hash) return { row, step: stepFor(row), transactionRequest: null };

    if (!row.approval_tx_hash) {
      const chainState = await source.readChainState(row.wallet_address);
      if (BigInt(chainState.balanceRaw) < BigInt(row.amount_raw)) {
        throw new Error('gateway_deposit_insufficient_usdc');
      }
      if (BigInt(chainState.allowanceRaw) >= BigInt(row.amount_raw)) {
        const result = await database.query(
          `UPDATE gateway_deposit_actions
              SET state = 'DEPOSIT_REQUIRED', last_error = NULL, updated_at = NOW()
            WHERE id = $1 AND state IN ('BASELINE_READ', 'APPROVAL_REQUIRED')
            RETURNING *`,
          [row.id],
        );
        const next = result.rows[0] || row;
        return {
          row: next,
          step: 'DEPOSIT_REQUIRED',
          transactionRequest: source.buildDeposit({ from: row.wallet_address, amountRaw: row.amount_raw }),
        };
      }
      const result = await database.query(
        `UPDATE gateway_deposit_actions
            SET state = 'APPROVAL_REQUIRED', last_error = NULL, updated_at = NOW()
          WHERE id = $1 AND state IN ('BASELINE_READ', 'APPROVAL_REQUIRED')
          RETURNING *`,
        [row.id],
      );
      const next = result.rows[0] || row;
      return {
        row: next,
        step: 'APPROVAL_REQUIRED',
        transactionRequest: source.buildApprove({ from: row.wallet_address, amountRaw: row.amount_raw }),
      };
    }

    return {
      row,
      step: 'DEPOSIT_REQUIRED',
      transactionRequest: source.buildDeposit({ from: row.wallet_address, amountRaw: row.amount_raw }),
    };
  }

  async function verifyExternalApproval(row, txHash) {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error('gateway_deposit_txhash_invalid');
    }
    if (row.approval_tx_hash) {
      if (row.approval_tx_hash.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error('gateway_deposit_approval_already_bound');
      }
      return row;
    }
    const source = sourceConfigFor(Number(row.source_domain));
    const request = source.buildApprove({ from: row.wallet_address, amountRaw: row.amount_raw });
    const { tx } = await source.readTransaction(
      txHash, 'gateway_deposit_approval_transaction_not_found', 'gateway_deposit_approval_failed',
    );
    source.assertTransaction(tx, request);

    const refreshed = await source.readChainState(row.wallet_address);
    if (BigInt(refreshed.allowanceRaw) < BigInt(row.amount_raw)) {
      throw new Error('gateway_deposit_approval_failed');
    }
    const result = await database.query(
      `UPDATE gateway_deposit_actions
          SET approval_tx_hash = $2, state = 'DEPOSIT_REQUIRED', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state IN ('APPROVAL_REQUIRED', 'BASELINE_READ')
        RETURNING *`,
      [row.id, txHash],
    );
    return result.rows[0] || fetchRow(row.id, row.user_id, row.wallet_address);
  }

  async function verifyExternalDeposit(row, txHash) {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error('gateway_deposit_txhash_invalid');
    }
    if (row.deposit_tx_hash) {
      if (row.deposit_tx_hash.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error('gateway_deposit_already_bound');
      }
      return row;
    }
    const source = sourceConfigFor(Number(row.source_domain));
    const request = source.buildDeposit({ from: row.wallet_address, amountRaw: row.amount_raw });
    const { tx } = await source.readTransaction(
      txHash, 'gateway_deposit_transaction_not_found', 'gateway_deposit_failed',
    );
    source.assertTransaction(tx, request);

    const result = await database.query(
      `UPDATE gateway_deposit_actions
          SET deposit_tx_hash = $2, state = 'RECONCILING', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'DEPOSIT_REQUIRED'
        RETURNING *`,
      [row.id, txHash],
    );
    return result.rows[0] || fetchRow(row.id, row.user_id, row.wallet_address);
  }

  // --- Circle branch -------------------------------------------------------

  async function resolveCircleSourceWallet(auth, row, userToken) {
    if (row.source_circle_wallet_id) return row;
    // Fail closed on a missing or ambiguous companion wallet for THIS source
    // chain, or one that resolves to a different address than the Arc session
    // (circleUserWalletService enforces both). The browser never nominates the
    // wallet id, the blockchain or the address: the blockchain comes from the
    // canonical source config for the row's own domain.
    const source = sourceConfigFor(Number(row.source_domain));
    const sourceWallet = await circle.listEoaForBlockchain(userToken, source.circleBlockchain);
    if (!sourceWallet) throw new Error('gateway_deposit_source_wallet_required');
    if (sourceWallet.address.toLowerCase() !== auth.walletAddress.toLowerCase()) {
      throw new Error('gateway_deposit_source_wallet_mismatch');
    }
    const result = await database.query(
      `UPDATE gateway_deposit_actions
          SET source_circle_wallet_id = $2, updated_at = NOW()
        WHERE id = $1 AND source_circle_wallet_id IS NULL
        RETURNING *`,
      [row.id, sourceWallet.id],
    );
    return result.rows[0] || fetchRow(row.id, row.user_id, row.wallet_address);
  }

  async function prepareCirclePhase(auth, row, userToken) {
    const source = sourceConfigFor(Number(row.source_domain));
    row = await resolveCircleSourceWallet(auth, row, userToken);
    const walletId = row.source_circle_wallet_id;
    const expectedChainId = Number(row.source_chain_id);
    const enginePhase = toEnginePhaseShape(row);
    const port = depositPort();

    if (!row.deposit_tx_hash && !row.approval_tx_hash) {
      const chainState = await source.readChainState(row.wallet_address);
      if (BigInt(chainState.balanceRaw) < BigInt(row.amount_raw)) {
        throw new Error('gateway_deposit_insufficient_usdc');
      }
      if (BigInt(chainState.allowanceRaw) < BigInt(row.amount_raw)) {
        const transactionRequest = source.buildApprove({ from: row.wallet_address, amountRaw: row.amount_raw });
        const challenge = await engine.issuePhaseChallenge({
          action: enginePhase, auth, userToken, phaseName: 'APPROVAL', transactionRequest,
          port, circle, walletId, expectedChainId,
        });
        return { row: await fetchRow(row.id, row.user_id, row.wallet_address), challenge, step: 'APPROVAL_REQUIRED' };
      }
      // Allowance already sufficient: mark approval satisfied without a
      // Circle challenge and fall through to the deposit phase below.
      const skipped = await database.query(
        `UPDATE gateway_deposit_actions SET state = 'DEPOSIT_REQUIRED', updated_at = NOW()
          WHERE id = $1 AND state IN ('BASELINE_READ', 'STARTED') RETURNING *`,
        [row.id],
      );
      row = skipped.rows[0] || row;
    }

    const transactionRequest = source.buildDeposit({ from: row.wallet_address, amountRaw: row.amount_raw });
    const challenge = await engine.issuePhaseChallenge({
      action: toEnginePhaseShape(row), auth, userToken, phaseName: 'ACTION', transactionRequest,
      port, circle, walletId, expectedChainId,
    });
    return { row: await fetchRow(row.id, row.user_id, row.wallet_address), challenge, step: 'DEPOSIT_REQUIRED' };
  }

  async function resolveCirclePhase(auth, row, userToken, phaseName, dependencies = {}) {
    const walletId = row.source_circle_wallet_id;
    if (!walletId) throw new Error('gateway_deposit_source_wallet_required');
    const source = sourceConfigFor(Number(row.source_domain));
    const contractAddress = phaseName === 'APPROVAL'
      ? source.usdcAddress
      : source.gatewayWallet;

    const resolved = await engine.resolvePhaseTransaction({
      auth, actionId: row.id, userToken, phaseName, dependencies,
      contractAddressFor: () => contractAddress,
      port: depositPort(), circle, walletId,
      // The Circle transaction being reconciled lives on the SOURCE chain
      // (Base Sepolia here), never Arc. Without this, the shared engine's
      // ARC-TESTNET default compares a real Base Sepolia transaction as if
      // it were an Arc one and rejects it as circle_transaction_mismatch
      // even though the approval genuinely landed onchain.
      blockchain: source.circleBlockchain,
    });
    if (resolved.pending) {
      return {
        pending: true,
        transactionObserved: resolved.transactionObserved,
        row: await fetchRow(row.id, row.user_id, row.wallet_address),
      };
    }

    if (phaseName === 'APPROVAL') {
      const refreshed = await source.readChainState(row.wallet_address);
      if (BigInt(refreshed.allowanceRaw) < BigInt(row.amount_raw)) {
        throw new Error('gateway_deposit_approval_failed');
      }
      const result = await database.query(
        `UPDATE gateway_deposit_actions
            SET state = 'DEPOSIT_REQUIRED', last_error = NULL, updated_at = NOW()
          WHERE id = $1 AND state = 'APPROVAL_CHALLENGE'
          RETURNING *`,
        [row.id],
      );
      return { pending: false, row: result.rows[0] || await fetchRow(row.id, row.user_id, row.wallet_address) };
    }

    const result = await database.query(
      `UPDATE gateway_deposit_actions
          SET state = 'RECONCILING', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'DEPOSIT_CHALLENGE'
        RETURNING *`,
      [row.id],
    );
    return { pending: false, row: result.rows[0] || await fetchRow(row.id, row.user_id, row.wallet_address) };
  }

  // --- Shared reconciliation -------------------------------------------

  async function reconcile(row, balanceSnapshot = null) {
    if (row.state !== 'RECONCILING') return row;
    let balance = balanceSnapshot;
    if (!balance) {
      try {
        balance = await gateway.readUnifiedUsdcBalance(row.wallet_address);
      } catch {
        return row;
      }
    }
    const match = Array.isArray(balance?.balances)
      ? balance.balances.find((item) => item.domain === Number(row.source_domain))
      : null;
    let currentRaw;
    let targetRaw;
    try {
      currentRaw = match ? BigInt(match.balanceRaw) : 0n;
      targetRaw = BigInt(row.baseline_domain_balance_raw || '0') + BigInt(row.amount_raw);
    } catch {
      return row;
    }
    if (currentRaw < targetRaw) return row;
    const result = await database.query(
      `UPDATE gateway_deposit_actions
          SET state = 'COMPLETED', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'RECONCILING'
        RETURNING *`,
      [row.id],
    );
    return result.rows[0] || row;
  }

  // --- Public entry points -----------------------------------------------

  async function start({ auth, userToken = null, requestId, sourceDomain, amountRaw }) {
    assertHumanSession(auth);
    assertInput({ requestId, sourceDomain, amountRaw });
    const isCircle = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET;
    if (isCircle && (typeof userToken !== 'string' || userToken.length < 16)) {
      throw new Error('circle_request_invalid');
    }

    // Only a genuinely NEW request id can create a second concurrent action.
    // The normal resume path (same request id already has a row) is
    // untouched: this guard runs only when this request id has never been
    // seen before, so a lost browser recovery can never bypass it merely by
    // minting a fresh request id for the same source.
    if (!(await findByRequest(auth, requestId))) {
      const unresolved = await findUnresolvedForSource(auth, sourceDomain);
      if (unresolved) throw new Error('gateway_deposit_source_review_required');
    }

    let row = await createOrGet(auth, { requestId, sourceDomain, amountRaw });
    if (Number(row.source_domain) !== sourceDomain || row.amount_raw !== amountRaw) {
      throw new Error('gateway_deposit_request_id_conflict');
    }
    row = await markExpired(row);
    if (row.state === 'EXPIRED') return publicAction(row);
    if (row.state === 'STARTED') row = await readBaseline(row);
    if (['COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED', 'RECONCILING'].includes(row.state)) {
      return publicAction(row, { pending: row.state === 'RECONCILING' });
    }

    if (isCircle) {
      const { row: next } = await prepareCirclePhase(auth, row, userToken);
      return publicAction(next, { pending: true });
    }
    const { row: next, transactionRequest } = await prepareExternalPhase(row);
    return publicAction(next, { transactionRequest });
  }

  async function verifyApproval({ auth, actionId, userToken = null, txHash = null }, dependencies = {}) {
    assertHumanSession(auth);
    let row = await markExpired(await findById(auth, actionId));
    if (row.state === 'EXPIRED') return publicAction(row);

    if (auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      if (typeof userToken !== 'string' || userToken.length < 16) throw new Error('circle_request_invalid');
      const resolved = await resolveCirclePhase(auth, row, userToken, 'APPROVAL', dependencies);
      if (resolved.pending) {
        return publicAction(resolved.row, { pending: true, transactionObserved: resolved.transactionObserved });
      }
      row = resolved.row;
      const { row: next } = await prepareCirclePhase(auth, row, userToken);
      return publicAction(next, { pending: true });
    }

    row = await verifyExternalApproval(row, txHash);
    const { row: next, transactionRequest } = await prepareExternalPhase(row);
    return publicAction(next, { transactionRequest });
  }

  async function verifyDeposit({ auth, actionId, userToken = null, txHash = null }, dependencies = {}) {
    assertHumanSession(auth);
    let row = await markExpired(await findById(auth, actionId));
    if (row.state === 'EXPIRED') return publicAction(row);

    if (auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      if (typeof userToken !== 'string' || userToken.length < 16) throw new Error('circle_request_invalid');
      const resolved = await resolveCirclePhase(auth, row, userToken, 'ACTION', dependencies);
      if (resolved.pending) {
        return publicAction(resolved.row, { pending: true, transactionObserved: resolved.transactionObserved });
      }
      row = await reconcile(resolved.row);
      return publicAction(row, { pending: row.state === 'RECONCILING' });
    }

    row = await verifyExternalDeposit(row, txHash);
    row = await reconcile(row);
    return publicAction(row, { pending: row.state === 'RECONCILING' });
  }

  async function status({ auth, actionId }) {
    assertHumanSession(auth);
    let row = await markExpired(await findById(auth, actionId));
    if (row.state === 'RECONCILING') row = await reconcile(row);
    return publicAction(row, { pending: row.state === 'RECONCILING' });
  }

  async function activity({ auth }) {
    assertHumanSession(auth);
    const result = await database.query(
      `/* gateway_deposit_activity */
       WITH scoped AS (
         SELECT *
         FROM gateway_deposit_actions
         WHERE user_id = $1 AND execution_mode = $2 AND lower(wallet_address) = lower($3)
       ), classified AS (
         SELECT scoped.*,
           CASE
             WHEN state = 'COMPLETED'
               OR (
                 state IN ('FAILED', 'EXPIRED')
                 AND NULLIF(BTRIM(approval_tx_hash), '') IS NULL
                 AND NULLIF(BTRIM(deposit_tx_hash), '') IS NULL
                 AND NULLIF(BTRIM(approval_circle_challenge_id), '') IS NULL
                 AND NULLIF(BTRIM(deposit_circle_challenge_id), '') IS NULL
                 AND approval_circle_transaction_id IS NULL
                 AND deposit_circle_transaction_id IS NULL
               )
             THEN TRUE ELSE FALSE
           END AS clear_terminal
         FROM scoped
       ), ranked AS (
         SELECT classified.*,
           ROW_NUMBER() OVER (PARTITION BY clear_terminal ORDER BY created_at DESC) AS clear_rank
         FROM classified
       )
       SELECT * FROM ranked
       WHERE clear_terminal = FALSE OR clear_rank <= 10
       ORDER BY created_at DESC`,
      [auth.userId, auth.executionMode, auth.walletAddress],
    );

    let rows = result.rows;
    const reconcilingRows = rows.filter((row) => row.state === 'RECONCILING');
    let readState = 'ready';
    if (reconcilingRows.length) {
      try {
        const balance = await gateway.readUnifiedUsdcBalance(auth.walletAddress);
        rows = await Promise.all(rows.map((row) => reconcile(row, balance)));
      } catch {
        readState = 'delayed';
      }
    }

    const mappedActivities = rows.map(activityItemFor);
    const activities = [
      ...mappedActivities.filter((item) => !item.terminal),
      ...mappedActivities.filter((item) => item.terminal)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return {
      activities,
      readState,
      hasBackgroundActivity: activities.some((item) => !item.terminal && !item.interactive),
    };
  }

  return { start, verifyApproval, verifyDeposit, status, activity };
}

const gatewayDepositService = createGatewayDepositService();

module.exports = {
  DEPOSIT_TTL_MS,
  RECOVERY_DISPOSITIONS,
  ACTIVE_RESUMABLE_STATES,
  ACTIVITY_PHASES,
  SOURCE_CHAINS,
  hasSubmittedFinancialEvidence,
  activityStatusFor,
  activityItemFor,
  recoveryDispositionFor,
  createGatewayDepositService,
  ...gatewayDepositService,
};
