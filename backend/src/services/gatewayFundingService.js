'use strict';

// Durable Gateway funding state machine. Preparation produces a valid Circle
// EOA signature over an Arc-only burn intent; an explicitly enabled server may
// then submit that exact intent once and reconcile the forwarding-service
// transfer by id. Broadcast is disabled by default and never controlled by the
// browser.

const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../db');
const config = require('../config');
const gatewayService = require('./gatewayService');
const circleUserWalletService = require('./circleUserWalletService');
const { EXECUTION_MODES, isHumanExecutionMode } = require('./executionIdentityService');

const FUNDING_TTL_MS = 30 * 60 * 1000;

function hashPayload(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// Both human execution modes can hold a Gateway funding action. Circle mode
// additionally requires the session's Circle wallet id, since that is the
// wallet a Circle hosted challenge signs with; external mode signs locally
// with the connected wallet and never carries a Circle wallet id at all.
function assertHumanGatewaySession(auth) {
  if (
    !auth || !isHumanExecutionMode(auth.executionMode) ||
    typeof auth.userId !== 'string' ||
    !ethers.isAddress(auth.walletAddress) ||
    (auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET && typeof auth.circleWalletId !== 'string')
  ) {
    throw new Error('gateway_wallet_session_required');
  }
}

function assertInput({ requestId, sourceDomain, valueRaw }) {
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new Error('gateway_request_id_invalid');
  }
  if (!Number.isInteger(sourceDomain) || sourceDomain < 0) {
    throw new Error('gateway_source_domain_invalid');
  }
  if (typeof valueRaw !== 'string' || !/^[1-9]\d*$/.test(valueRaw)) {
    throw new Error('gateway_value_invalid');
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
    valueRaw: row.value_raw,
    payloadHash: row.payload_hash || null,
    challengeId: row.circle_sign_challenge_id || null,
    // Not secret: it is the exact message a wallet needs to sign. An external
    // wallet session signs this directly with signTypedData; Circle sessions
    // ignore it and sign through the hosted challenge instead.
    typedData: row.typed_data_json || null,
    state: row.state,
    pending: options.pending === true,
    readyToBroadcast: row.state === 'READY_TO_BROADCAST',
    broadcast: row.state === 'COMPLETED'
      ? 'COMPLETED'
      : row.gateway_transfer_id ? 'SUBMITTED' : 'NOT_SUBMITTED',
    transferId: row.gateway_transfer_id || null,
    transactionHash: row.gateway_transaction_hash || null,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function createGatewayFundingService({
  database = db,
  gateway = gatewayService,
  circle = circleUserWalletService,
  runtimeConfig = config,
  now = () => Date.now(),
} = {}) {
  async function findByRequest(auth, requestId) {
    const result = await database.query(
      `SELECT * FROM gateway_funding_actions
        WHERE user_id = $1 AND request_id = $2
        LIMIT 1`,
      [auth.userId, requestId],
    );
    return result.rows[0] || null;
  }

  async function findById(auth, actionId) {
    const result = await database.query(
      `SELECT * FROM gateway_funding_actions
        WHERE id = $1 AND user_id = $2 AND execution_mode = $3
          AND lower(wallet_address) = lower($4)
        LIMIT 1`,
      [actionId, auth.userId, auth.executionMode, auth.walletAddress],
    );
    const row = result.rows[0] || null;
    if (!row) throw new Error('gateway_funding_not_found');
    return row;
  }

  async function markExpired(row) {
    if (
      !isExpired(row) ||
      !['PREPARING', 'SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING'].includes(row.state)
    ) return row;
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET state = 'EXPIRED', updated_at = NOW()
        WHERE id = $1 AND state <> 'READY_TO_BROADCAST'
        RETURNING *`,
      [row.id],
    );
    return result.rows[0] || row;
  }

  async function createOrGet(auth, input) {
    const actionId = crypto.randomUUID();
    const expiresAt = new Date(now() + FUNDING_TTL_MS);
    const isCircle = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET;
    await database.query(
      `INSERT INTO gateway_funding_actions
        (id, user_id, execution_mode, circle_wallet_id, wallet_address, request_id, source_domain,
         value_raw, circle_sign_request_id, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PREPARING', $10)
       ON CONFLICT (user_id, request_id) DO NOTHING`,
      [
        actionId, auth.userId, auth.executionMode,
        isCircle ? auth.circleWalletId : null, ethers.getAddress(auth.walletAddress),
        input.requestId, input.sourceDomain, input.valueRaw,
        isCircle ? crypto.randomUUID() : null, expiresAt,
      ],
    );
    return findByRequest(auth, input.requestId);
  }

  async function prepareIntent(auth, row) {
    const balance = await gateway.readUnifiedUsdcBalance(auth.walletAddress);
    const matches = balance.balances.filter((item) => item.domain === Number(row.source_domain));
    if (matches.length !== 1 || !matches[0].transferable) {
      throw new Error('gateway_source_balance_unavailable');
    }
    if (BigInt(matches[0].balanceRaw) < BigInt(row.value_raw)) {
      throw new Error('gateway_insufficient_usdc');
    }

    const spec = gateway.buildArcFundingTransferSpec({
      walletAddress: auth.walletAddress,
      sourceDomain: Number(row.source_domain),
      valueRaw: row.value_raw,
    });
    const estimate = await gateway.estimateArcFunding(spec);
    const built = gateway.buildArcFundingBurnIntent({
      walletAddress: auth.walletAddress,
      sourceDomain: Number(row.source_domain),
      valueRaw: row.value_raw,
      maxFeeRaw: estimate.maxFeeRaw,
      maxBlockHeight: estimate.maxBlockHeight,
      salt: spec.salt,
    });
    const payloadHash = hashPayload(built.burnIntent);
    // Circle signs through a hosted challenge, so preparation pauses at
    // SIGN_CHALLENGE_CREATING for that mode. An external wallet signs the
    // already-returned typedData directly with no server-side challenge, so
    // it goes straight to SIGNATURE_PENDING.
    const nextState = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET
      ? 'SIGN_CHALLENGE_CREATING'
      : 'SIGNATURE_PENDING';
    const result = await database.query(
      `UPDATE gateway_funding_actions
              SET payload_hash = $2, burn_intent_json = $3, burn_intent_json_text = $4,
              typed_data_json = $5, max_fee_raw = $6, max_block_height = $7, estimate_fees_json = $8,
              state = $9, last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'PREPARING'
        RETURNING *`,
      [
        row.id, payloadHash, built.burnIntent, JSON.stringify(built.burnIntent), built.typedData,
        estimate.maxFeeRaw, estimate.maxBlockHeight, estimate.fees, nextState,
      ],
    );
    return result.rows[0] || findById(auth, row.id);
  }

  async function createSignatureChallenge(auth, row, userToken) {
    if (row.state !== 'SIGN_CHALLENGE_CREATING') return row;
    // Never retry an ambiguous Circle mutation automatically. A response loss
    // leaves this durable state visible for manual support/reconciliation, and
    // no Gateway transfer can have occurred because no signature was submitted.
    let created;
    try {
      created = await circle.createTypedDataChallenge({
        userToken,
        walletId: auth.circleWalletId,
        typedData: row.typed_data_json,
        idempotencyKey: row.circle_sign_request_id,
        memo: 'Prepare USDC funding to Arc Testnet. No transfer is submitted yet.',
      });
    } catch (error) {
      await database.query(
        `UPDATE gateway_funding_actions
            SET last_error = $2, updated_at = NOW()
          WHERE id = $1 AND state = 'SIGN_CHALLENGE_CREATING'`,
        [row.id, error?.message?.startsWith('circle_') ? error.message : 'circle_service_unavailable'],
      );
      throw error;
    }
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET circle_sign_challenge_id = $2, state = 'SIGNATURE_PENDING',
              last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'SIGN_CHALLENGE_CREATING'
        RETURNING *`,
      [row.id, created.challengeId],
    );
    return result.rows[0] || findById(auth, row.id);
  }

  function assertPreparedPayload(auth, row) {
    const intent = row.burn_intent_json;
    const spec = intent?.spec;
    if (
      !intent || !spec ||
      Number(spec.sourceDomain) !== Number(row.source_domain) ||
      String(spec.value) !== String(row.value_raw) ||
      Number(spec.destinationDomain) !== (gateway.ARC_GATEWAY_DOMAIN ?? gatewayService.ARC_GATEWAY_DOMAIN) ||
      typeof spec.sourceDepositor !== 'string' ||
      spec.sourceDepositor.toLowerCase() !== ethers.zeroPadValue(ethers.getAddress(auth.walletAddress), 32).toLowerCase() ||
      typeof row.payload_hash !== 'string' ||
      hashPayload(row.burn_intent_json_text || intent) !== row.payload_hash
    ) {
      throw new Error('gateway_funding_payload_mismatch');
    }
    if (typeof row.signature !== 'string') throw new Error('gateway_signature_required');
  }

  async function updateState(row, state, extras = {}) {
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET state = $2, gateway_transfer_id = COALESCE($3, gateway_transfer_id),
              gateway_transaction_hash = COALESCE($4, gateway_transaction_hash),
              last_error = $5, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, state, extras.transferId || null, extras.transactionHash || null, extras.lastError || null],
    );
    return result.rows[0] || findById({
      userId: row.user_id,
      circleWalletId: row.circle_wallet_id,
      walletAddress: row.wallet_address,
      executionMode: row.execution_mode,
    }, row.id);
  }

  function isRemoteComplete(status) {
    return ['complete', 'completed', 'confirmed', 'finalized', 'success', 'succeeded', 'forwarded'].includes(status);
  }

  function isRemoteFailed(status) {
    return ['failed', 'failure', 'reverted', 'rejected', 'expired'].includes(status);
  }

  async function reconcileRemote(auth, row) {
    if (!row.gateway_transfer_id) {
      if (row.state === 'SUBMITTING') {
        return updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_submit_interrupted' });
      }
      return row;
    }
    let remote;
    try {
      remote = await gateway.readArcFundingTransferStatus(row.gateway_transfer_id);
    } catch (error) {
      if (error?.message === 'gateway_transfer_not_found') {
        return updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_transfer_not_found' });
      }
      return updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_status_unknown' });
    }
    if (isRemoteComplete(remote.status)) {
      return updateState(row, 'COMPLETED', { transactionHash: remote.transactionHash });
    }
    if (isRemoteFailed(remote.status)) {
      return updateState(row, 'FAILED', { lastError: remote.forwardingFailure || 'gateway_transfer_failed' });
    }
    return updateState(row, 'SUBMITTED');
  }

  async function submit({ auth, actionId }) {
    assertHumanGatewaySession(auth);
    if (!runtimeConfig.EXTREMA_ENABLE_GATEWAY_BROADCAST) {
      throw new Error('gateway_broadcast_disabled');
    }
    let row = await markExpired(await findById(auth, actionId));
    if (['SUBMITTED', 'COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(row.state)) {
      return publicAction(row, { pending: row.state === 'SUBMITTED' || row.state === 'RECONCILIATION_REQUIRED' });
    }
    if (row.state !== 'READY_TO_BROADCAST') {
      throw new Error('gateway_funding_not_ready');
    }
    assertPreparedPayload(auth, row);

    // The CAS is the financial idempotency gate. Once SUBMITTING is durable,
    // every retry returns the row for reconciliation and can never POST again.
    const reserved = await database.query(
      `UPDATE gateway_funding_actions
          SET state = 'SUBMITTING', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'READY_TO_BROADCAST'
        RETURNING *`,
      [row.id],
    );
    if (!reserved.rows[0]) {
      row = await findById(auth, actionId);
      return publicAction(row, { pending: true });
    }
    row = reserved.rows[0];

    try {
      const submitted = await gateway.submitArcFunding({
        burnIntent: row.burn_intent_json,
        signature: row.signature,
        requestId: row.request_id,
      });
      row = await updateState(row, 'SUBMITTED', { transferId: submitted.transferId });
      return publicAction(row, { pending: true });
    } catch (error) {
      if (error?.message === 'gateway_transfer_rejected') {
        row = await updateState(row, 'FAILED', { lastError: 'gateway_transfer_rejected' });
        return publicAction(row);
      }
      row = await updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_transfer_submit_unknown' });
      return publicAction(row, { pending: true });
    }
  }

  async function status({ auth, actionId }) {
    assertHumanGatewaySession(auth);
    let row = await markExpired(await findById(auth, actionId));
    if (['SUBMITTED', 'SUBMITTING', 'RECONCILIATION_REQUIRED'].includes(row.state)) {
      row = await reconcileRemote(auth, row);
    }
    return publicAction(row, {
      pending: ['SUBMITTED', 'SUBMITTING', 'RECONCILIATION_REQUIRED'].includes(row.state),
    });
  }

  async function start({ auth, userToken = null, requestId, sourceDomain, valueRaw }) {
    assertHumanGatewaySession(auth);
    assertInput({ requestId, sourceDomain, valueRaw });
    const isCircle = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET;
    if (isCircle && (typeof userToken !== 'string' || userToken.length < 16)) {
      throw new Error('circle_request_invalid');
    }

    let row = await createOrGet(auth, { requestId, sourceDomain, valueRaw });
    if (Number(row.source_domain) !== sourceDomain || row.value_raw !== valueRaw) {
      throw new Error('gateway_request_id_conflict');
    }
    row = await markExpired(row);
    if (row.state === 'EXPIRED') throw new Error('gateway_funding_expired');
    if (row.state === 'PREPARING') row = await prepareIntent(auth, row);
    if (isCircle) {
      if (row.state === 'SIGN_CHALLENGE_CREATING' && row.last_error) {
        throw new Error('gateway_signature_challenge_uncertain');
      }
      if (row.state === 'SIGN_CHALLENGE_CREATING') row = await createSignatureChallenge(auth, row, userToken);
    }
    return publicAction(row, { pending: row.state === 'SIGNATURE_PENDING' });
  }

  async function get({ auth, actionId }) {
    assertHumanGatewaySession(auth);
    const row = await markExpired(await findById(auth, actionId));
    return publicAction(row, { pending: row.state === 'SIGNATURE_PENDING' });
  }

  // One canonical tail for both modes: recover the EIP-712 signer locally,
  // require it to equal the authenticated session wallet, and only then
  // persist the signature and move to READY_TO_BROADCAST. Neither branch ever
  // trusts a browser-provided intent, source, or destination — both sign
  // exactly the server-pinned typedData already stored on the row.
  async function finalizeSignature(auth, row, signature) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new Error('gateway_signature_required');
    }
    const signer = gateway.recoverBurnIntentSigner(row.typed_data_json, signature);
    if (ethers.getAddress(signer).toLowerCase() !== ethers.getAddress(auth.walletAddress).toLowerCase()) {
      throw new Error('gateway_signature_wallet_mismatch');
    }
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET signature = $2, state = 'READY_TO_BROADCAST', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'SIGNATURE_PENDING'
        RETURNING *`,
      [row.id, signature],
    );
    return result.rows[0] || findById(auth, row.id);
  }

  async function verifySignature({ auth, actionId, userToken = null, signature = null }) {
    assertHumanGatewaySession(auth);
    let row = await markExpired(await findById(auth, actionId));
    if (row.state === 'EXPIRED') throw new Error('gateway_funding_expired');
    if (row.state === 'READY_TO_BROADCAST') return publicAction(row);

    if (auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      if (typeof userToken !== 'string' || userToken.length < 16) {
        throw new Error('circle_request_invalid');
      }
      if (row.state !== 'SIGNATURE_PENDING' || !row.circle_sign_challenge_id) {
        throw new Error('gateway_signature_challenge_unavailable');
      }

      const challenge = await circle.getTypedDataChallenge({
        userToken,
        challengeId: row.circle_sign_challenge_id,
      });
      if (!challenge || challenge.status === 'PENDING' || challenge.status === 'IN_PROGRESS') {
        return publicAction(row, { pending: true });
      }
      if (challenge.status !== 'COMPLETE') {
        await database.query(
          `UPDATE gateway_funding_actions
              SET state = 'SIGNATURE_FAILED', last_error = 'gateway_signature_challenge_failed', updated_at = NOW()
            WHERE id = $1`,
          [row.id],
        );
        throw new Error('gateway_signature_challenge_failed');
      }
    } else if (row.state !== 'SIGNATURE_PENDING') {
      // External wallets sign locally with no hosted challenge: the only
      // valid state to accept a signature in is SIGNATURE_PENDING.
      throw new Error('gateway_signature_challenge_unavailable');
    }

    row = await finalizeSignature(auth, row, signature);
    return publicAction(row);
  }

  return { start, get, verifySignature, submit, status };
}

const gatewayFundingService = createGatewayFundingService();

module.exports = {
  FUNDING_TTL_MS,
  createGatewayFundingService,
  ...gatewayFundingService,
};
