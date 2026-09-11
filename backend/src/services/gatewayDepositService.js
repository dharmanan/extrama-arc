'use strict';

// Durable Gateway SOURCE deposit state machine: USDC.approve(GatewayWallet,
// amount) then GatewayWallet.deposit(token, amount) on a source chain, for
// both human execution modes. This is deliberately separate from
// gatewayFundingService: that module spends an ALREADY existing unified
// balance to Arc via a signed burn intent; this module is what gets USDC into
// that unified balance in the first place.
//
// Source chains are config driven. Only Base Sepolia (Gateway domain 6) is
// enabled today; adding ETH Sepolia / Arbitrum Sepolia / OP Sepolia later is a
// new SOURCE_CHAINS entry, not a state machine redesign. An unlisted or
// disabled domain fails closed with gateway_deposit_source_unsupported.
//
// Financial safety: every phase transition that follows a Circle challenge or
// an external transaction hash is a durable, idempotent step. A lost response
// is reconciled read-only (RECONCILIATION_REQUIRED) and never causes a second
// approval, a second deposit, or a second Circle challenge to be created.

const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../db');
const gatewayService = require('./gatewayService');
const baseSepoliaService = require('./baseSepoliaService');
const circleUserWalletService = require('./circleUserWalletService');
const circleExecutionEngine = require('./circleExecutionEngine');
const { EXECUTION_MODES, isHumanExecutionMode } = require('./executionIdentityService');

const DEPOSIT_TTL_MS = 30 * 60 * 1000;

// The default, real source chain configuration. A test may inject its own
// `sourceChains` map into createGatewayDepositService so no deterministic
// verification ever reaches a real RPC endpoint.
const SOURCE_CHAINS = new Map([
  [baseSepoliaService.BASE_SEPOLIA_GATEWAY_DOMAIN, {
    chainId: baseSepoliaService.BASE_SEPOLIA_CHAIN_ID,
    circleBlockchain: circleUserWalletService.BASE_SEPOLIA,
    usdcAddress: baseSepoliaService.baseSepoliaUsdcAddress(),
    readChainState: baseSepoliaService.readBaseUsdcState,
    buildApprove: baseSepoliaService.buildApproveTransactionRequest,
    buildDeposit: baseSepoliaService.buildDepositTransactionRequest,
    assertTransaction: baseSepoliaService.assertTransaction,
    readTransaction: baseSepoliaService.readTransaction,
  }],
]);

function assertHumanSession(auth) {
  if (
    !auth || !isHumanExecutionMode(auth.executionMode) ||
    typeof auth.userId !== 'string' || !ethers.isAddress(auth.walletAddress)
  ) {
    throw new Error('gateway_wallet_session_required');
  }
}

function isExpired(row) {
  return new Date(row.expires_at).getTime() <= Date.now();
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
    if (isExpired(row) && !['COMPLETED', 'FAILED'].includes(row.state)) {
      const result = await database.query(
        `UPDATE gateway_deposit_actions
            SET state = 'EXPIRED', updated_at = NOW()
          WHERE id = $1 AND state NOT IN ('COMPLETED', 'FAILED')
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
    // Fail closed on a missing or ambiguous Base wallet, or one that resolves
    // to a different address than the Arc session (circleUserWalletService
    // enforces both). The browser never nominates the wallet id or address.
    const baseWallet = await circle.listBaseSepoliaEoa(userToken);
    if (!baseWallet) throw new Error('gateway_deposit_base_wallet_required');
    if (baseWallet.address.toLowerCase() !== auth.walletAddress.toLowerCase()) {
      throw new Error('gateway_deposit_base_wallet_mismatch');
    }
    const result = await database.query(
      `UPDATE gateway_deposit_actions
          SET source_circle_wallet_id = $2, updated_at = NOW()
        WHERE id = $1 AND source_circle_wallet_id IS NULL
        RETURNING *`,
      [row.id, baseWallet.id],
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
    if (!walletId) throw new Error('gateway_deposit_base_wallet_required');
    const source = sourceConfigFor(Number(row.source_domain));
    const contractAddress = phaseName === 'APPROVAL'
      ? source.usdcAddress
      : gatewayService.GATEWAY_WALLET_CONTRACT;

    const resolved = await engine.resolvePhaseTransaction({
      auth, actionId: row.id, userToken, phaseName, dependencies,
      contractAddressFor: () => contractAddress,
      port: depositPort(), circle, walletId,
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

  async function reconcile(row) {
    if (row.state !== 'RECONCILING') return row;
    let balance;
    try {
      balance = await gateway.readUnifiedUsdcBalance(row.wallet_address);
    } catch {
      return row;
    }
    const match = balance.balances.find((item) => item.domain === Number(row.source_domain));
    const currentRaw = match ? BigInt(match.balanceRaw) : 0n;
    const targetRaw = BigInt(row.baseline_domain_balance_raw || '0') + BigInt(row.amount_raw);
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

    let row = await createOrGet(auth, { requestId, sourceDomain, amountRaw });
    if (Number(row.source_domain) !== sourceDomain || row.amount_raw !== amountRaw) {
      throw new Error('gateway_deposit_request_id_conflict');
    }
    row = await markExpired(row);
    if (row.state === 'EXPIRED') throw new Error('gateway_deposit_expired');
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
    if (row.state === 'EXPIRED') throw new Error('gateway_deposit_expired');

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
    if (row.state === 'EXPIRED') throw new Error('gateway_deposit_expired');

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

  return { start, verifyApproval, verifyDeposit, status };
}

const gatewayDepositService = createGatewayDepositService();

module.exports = {
  DEPOSIT_TTL_MS,
  SOURCE_CHAINS,
  createGatewayDepositService,
  ...gatewayDepositService,
};
