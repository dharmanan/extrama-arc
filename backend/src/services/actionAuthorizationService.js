'use strict';

const crypto = require('crypto');
const db = require('../db');

const ACTION_TTL_MS = 2 * 60 * 1000;
const EXTERNAL_ENTRY_TTL_MS = 10 * 60 * 1000;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalEntryPayload({
  walletAddress,
  poolAddress,
  roundId,
  predictionPriceCents,
  executionMode = 'BACKEND_WALLET',
  nonce,
  expiresAt,
}) {
  return {
    action: 'ENTRY',
    chainId: 5042002,
    contract: poolAddress,
    roundId,
    amountRaw: '1000000',
    predictionPriceCents,
    executionMode,
    destination: poolAddress,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

function canonicalTicketTransferPayload({
  walletAddress,
  ticketAddress,
  tokenId,
  destinationAddress,
  executionMode = 'BACKEND_WALLET',
  nonce,
  expiresAt,
}) {
  return {
    action: 'TRANSFER_TICKET',
    chainId: 5042002,
    contract: ticketAddress,
    tokenId,
    from: walletAddress,
    destination: destinationAddress,
    walletAddress,
    executionMode,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

function canonicalRefundPayload({
  walletAddress,
  poolAddress,
  ticketAddress,
  tokenId,
  roundId,
  currentOwner,
  executionMode,
  nonce,
  expiresAt,
}) {
  return {
    action: 'REFUND_TICKET',
    chainId: 5042002,
    contract: poolAddress,
    poolAddress,
    ticketAddress,
    tokenId,
    roundId,
    amountRaw: '1000000',
    currentOwner,
    destination: currentOwner,
    executionMode,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}


function canonicalClaimPayload({
  walletAddress,
  poolAddress,
  ticketAddress,
  tokenId,
  roundId,
  currentOwner,
  amountRaw,
  executionMode,
  nonce,
  expiresAt,
}) {
  return {
    action: 'CLAIM_REWARD',
    chainId: 5042002,
    contract: poolAddress,
    poolAddress,
    ticketAddress,
    tokenId,
    roundId,
    amountRaw,
    currentOwner,
    destination: currentOwner,
    executionMode,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

function canonicalMarketplaceListPayload({
  walletAddress,
  marketplaceAddress,
  ticketAddress,
  tokenId,
  askUsdcRaw,
  executionMode,
  nonce,
  expiresAt,
}) {
  return {
    action: 'MARKETPLACE_LIST',
    chainId: 5042002,
    contract: marketplaceAddress,
    ticketAddress,
    tokenId,
    askUsdcRaw,
    executionMode,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

function canonicalMarketplaceUpdatePricePayload({
  walletAddress,
  marketplaceAddress,
  listingId,
  ticketAddress,
  tokenId,
  newAskUsdcRaw,
  executionMode,
  nonce,
  expiresAt,
}) {
  return {
    action: 'MARKETPLACE_UPDATE_PRICE',
    chainId: 5042002,
    contract: marketplaceAddress,
    listingId,
    ticketAddress,
    tokenId,
    newAskUsdcRaw,
    executionMode,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

function canonicalMarketplaceCancelPayload({
  walletAddress,
  marketplaceAddress,
  listingId,
  ticketAddress,
  tokenId,
  executionMode,
  nonce,
  expiresAt,
}) {
  return {
    action: 'MARKETPLACE_CANCEL',
    chainId: 5042002,
    contract: marketplaceAddress,
    listingId,
    ticketAddress,
    tokenId,
    executionMode,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

function canonicalMarketplaceBuyPayload({
  walletAddress,
  marketplaceAddress,
  listingId,
  ticketAddress,
  tokenId,
  sellerAddress,
  expectedAskUsdcRaw,
  executionMode,
  nonce,
  expiresAt,
}) {
  return {
    action: 'MARKETPLACE_BUY',
    chainId: 5042002,
    contract: marketplaceAddress,
    listingId,
    ticketAddress,
    tokenId,
    sellerAddress,
    expectedAskUsdcRaw,
    executionMode,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

async function insertActionRequest(params, actionType, payload) {
  const payloadHash = sha256Hex(JSON.stringify(payload));

  await db.query(
    `INSERT INTO action_authorizations
      (id, user_id, action_type, payload_hash, payload_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [params.id, params.userId, actionType, payloadHash, payload, params.expiresAt],
  );

  return {
    id: params.id,
    payload,
    payloadHash,
    expiresAt: params.expiresAt,
    expiresInSeconds: Math.max(
      0,
      Math.floor((params.expiresAt.getTime() - Date.now()) / 1000),
    ),
  };
}

async function createEntryRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(
    Date.now() + (
      params.executionMode === 'EXTERNAL_WALLET'
        ? EXTERNAL_ENTRY_TTL_MS
        : ACTION_TTL_MS
    ),
  );
  const payload = canonicalEntryPayload({
    ...params,
    nonce,
    expiresAt,
  });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'ENTRY',
    payload,
  );
}

function sameCircleEntryIntent(payload, params) {
  return payload?.action === 'ENTRY' &&
    payload.executionMode === 'CIRCLE_USER_WALLET' &&
    payload.contract?.toLowerCase() === params.poolAddress.toLowerCase() &&
    payload.walletAddress?.toLowerCase() === params.walletAddress.toLowerCase() &&
    payload.roundId === params.roundId &&
    payload.predictionPriceCents === params.predictionPriceCents;
}

function actionRow(row) {
  return {
    id: row.id,
    actionType: row.action_type,
    payloadHash: row.payload_hash,
    payload: row.payload_json,
    expiresAt: row.expires_at,
    expiresInSeconds: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
    circleWalletId: row.circle_wallet_id,
    circleState: row.circle_state,
    circleApprovalChallengeId: row.circle_approval_challenge_id,
    circleApprovalIdempotencyKey: row.circle_approval_idempotency_key,
    circleApprovalRefId: row.circle_approval_ref_id,
    circleApprovalTransactionId: row.circle_approval_transaction_id,
    circleApprovalTxHash: row.circle_approval_tx_hash,
    circleEntryChallengeId: row.circle_entry_challenge_id,
    circleEntryIdempotencyKey: row.circle_entry_idempotency_key,
    circleEntryRefId: row.circle_entry_ref_id,
    circleEntryTransactionId: row.circle_entry_transaction_id,
    verifiedTxHash: row.verified_tx_hash,
  };
}

async function createOrGetCircleEntryRequest(params) {
  const requestId = params.requestId;
  if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) throw new Error('circle_request_id_invalid');
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + EXTERNAL_ENTRY_TTL_MS);
  const payload = canonicalEntryPayload({
    ...params,
    executionMode: 'CIRCLE_USER_WALLET',
    nonce,
    expiresAt,
  });
  const payloadHash = sha256Hex(JSON.stringify(payload));
  const { rows } = await db.query(
    `INSERT INTO action_authorizations
       (id, user_id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_request_id)
     VALUES ($1, $2, 'ENTRY', $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, action_type, circle_request_id)
       WHERE circle_request_id IS NOT NULL
     DO UPDATE SET id = action_authorizations.id
     RETURNING id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_state,
       circle_approval_challenge_id, circle_approval_idempotency_key, circle_approval_ref_id,
       circle_approval_transaction_id, circle_approval_tx_hash, circle_entry_challenge_id,
       circle_entry_idempotency_key, circle_entry_ref_id, circle_entry_transaction_id, verified_tx_hash`,
    [id, params.userId, payloadHash, payload, expiresAt, params.circleWalletId, requestId],
  );
  const action = actionRow(rows[0]);
  if (!sameCircleEntryIntent(action.payload, params) || action.circleWalletId !== params.circleWalletId) {
    throw new Error('circle_request_id_conflict');
  }
  return action;
}

async function getCircleEntryAction(userId, actionId, walletAddress, circleWalletId) {
  const { rows } = await db.query(
    `SELECT id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_state,
       circle_approval_challenge_id, circle_approval_idempotency_key, circle_approval_ref_id,
       circle_approval_transaction_id, circle_approval_tx_hash, circle_entry_challenge_id,
       circle_entry_idempotency_key, circle_entry_ref_id, circle_entry_transaction_id, verified_tx_hash
       FROM action_authorizations
      WHERE id = $1 AND user_id = $2 AND action_type = 'ENTRY'
        AND payload_json->>'executionMode' = 'CIRCLE_USER_WALLET'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND circle_wallet_id = $4
      LIMIT 1`,
    [actionId, userId, walletAddress, circleWalletId],
  );
  if (!rows.length) throw new Error('circle_entry_authorization_invalid');
  return actionRow(rows[0]);
}

const CIRCLE_PHASES = Object.freeze({
  APPROVAL: {
    reservationStates: [null, 'APPROVAL_CHALLENGE'], state: 'APPROVAL_CHALLENGE',
    bindStates: ['APPROVAL_CHALLENGE', 'APPROVAL_SUBMITTED'],
    idempotency: 'circle_approval_idempotency_key', ref: 'circle_approval_ref_id',
    challenge: 'circle_approval_challenge_id', txId: 'circle_approval_transaction_id', txHash: 'circle_approval_tx_hash',
  },
  ENTRY: {
    reservationStates: ['APPROVAL_VERIFIED', 'ENTRY_CHALLENGE'], state: 'ENTRY_CHALLENGE',
    bindStates: ['ENTRY_CHALLENGE', 'ENTRY_SUBMITTED'],
    idempotency: 'circle_entry_idempotency_key', ref: 'circle_entry_ref_id',
    challenge: 'circle_entry_challenge_id', txId: 'circle_entry_transaction_id', txHash: 'verified_tx_hash',
  },
});

function hasSameBoundCircleTransaction(action, phaseName, transaction) {
  const phase = CIRCLE_PHASES[phaseName];
  return Boolean(
    phase && action?.[phaseName === 'APPROVAL' ? 'circleApprovalTransactionId' : 'circleEntryTransactionId'] &&
    action?.[phaseName === 'APPROVAL' ? 'circleApprovalTxHash' : 'verifiedTxHash'] &&
    action[phaseName === 'APPROVAL' ? 'circleApprovalTransactionId' : 'circleEntryTransactionId'] === transaction.id &&
    action[phaseName === 'APPROVAL' ? 'circleApprovalTxHash' : 'verifiedTxHash'].toLowerCase() === transaction.txHash.toLowerCase()
  );
}

function isTerminalOrAdvancedApprovalState(state) {
  return ['APPROVAL_VERIFIED', 'ENTRY_CHALLENGE', 'ENTRY_SUBMITTED', 'VERIFIED'].includes(state);
}

async function reserveCircleEntryChallenge(userId, actionId, walletAddress, circleWalletId, phaseName) {
  const phase = CIRCLE_PHASES[phaseName];
  if (!phase) throw new Error('circle_entry_authorization_invalid');
  const idempotencyKey = crypto.randomUUID();
  const refId = `${actionId}:${phaseName.toLowerCase()}`;
  const stateCondition = phase.reservationStates.includes(null)
    ? '(circle_state IS NULL OR circle_state = ANY($5::varchar[]))'
    : 'circle_state = ANY($5::varchar[])';
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET circle_state = $6,
            ${phase.idempotency} = COALESCE(${phase.idempotency}, $7),
            ${phase.ref} = COALESCE(${phase.ref}, $8)
      WHERE id = $1 AND user_id = $2 AND action_type = 'ENTRY'
        AND payload_json->>'executionMode' = 'CIRCLE_USER_WALLET'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND circle_wallet_id = $4
        AND ${stateCondition}
        AND expires_at > NOW()
      RETURNING id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_state,
       circle_approval_challenge_id, circle_approval_idempotency_key, circle_approval_ref_id,
       circle_approval_transaction_id, circle_approval_tx_hash, circle_entry_challenge_id,
       circle_entry_idempotency_key, circle_entry_ref_id, circle_entry_transaction_id, verified_tx_hash`,
    [
      actionId, userId, walletAddress, circleWalletId,
      phase.reservationStates.filter(Boolean), phase.state, idempotencyKey, refId,
    ],
  );
  if (!rows.length) throw new Error('circle_entry_authorization_invalid');
  return actionRow(rows[0]);
}

async function persistCircleEntryChallenge(userId, actionId, walletAddress, circleWalletId, phaseName, challengeId) {
  const phase = CIRCLE_PHASES[phaseName];
  if (!phase || typeof challengeId !== 'string' || !challengeId) throw new Error('circle_entry_authorization_invalid');
  const { rows } = await db.query(
    `UPDATE action_authorizations SET ${phase.challenge} = COALESCE(${phase.challenge}, $5)
      WHERE id = $1 AND user_id = $2 AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state = $6 AND (${phase.challenge} IS NULL OR ${phase.challenge} = $5)
      RETURNING ${phase.challenge} AS challenge_id`,
    [actionId, userId, walletAddress, circleWalletId, challengeId, phase.state],
  );
  if (!rows.length) throw new Error('circle_entry_authorization_invalid');
  return rows[0].challenge_id;
}

async function persistCircleEntryTransactionId(
  userId, actionId, walletAddress, circleWalletId, phaseName, transactionId,
) {
  const phase = CIRCLE_PHASES[phaseName];
  if (!phase || typeof transactionId !== 'string' || !transactionId) {
    throw new Error('circle_entry_authorization_invalid');
  }
  const reusableStates = phaseName === 'APPROVAL'
    ? [...phase.bindStates, 'APPROVAL_VERIFIED', 'ENTRY_CHALLENGE', 'ENTRY_SUBMITTED', 'VERIFIED']
    : [...phase.bindStates, 'VERIFIED'];
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET ${phase.txId} = COALESCE(${phase.txId}, $5)
      WHERE id = $1 AND user_id = $2 AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state = ANY($6::varchar[])
        AND (${phase.txId} IS NULL OR ${phase.txId} = $5)
      RETURNING id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_state,
       circle_approval_challenge_id, circle_approval_idempotency_key, circle_approval_ref_id,
       circle_approval_transaction_id, circle_approval_tx_hash, circle_entry_challenge_id,
       circle_entry_idempotency_key, circle_entry_ref_id, circle_entry_transaction_id, verified_tx_hash`,
    [actionId, userId, walletAddress, circleWalletId, transactionId, reusableStates],
  );
  if (rows.length) return actionRow(rows[0]);
  const action = await getCircleEntryAction(userId, actionId, walletAddress, circleWalletId);
  const storedId = phaseName === 'APPROVAL'
    ? action.circleApprovalTransactionId
    : action.circleEntryTransactionId;
  if (storedId !== transactionId) throw new Error('circle_entry_authorization_invalid');
  return action;
}

async function bindCircleEntryTransaction(userId, actionId, walletAddress, circleWalletId, phaseName, transaction) {
  const phase = CIRCLE_PHASES[phaseName];
  if (!phase || !transaction?.id || !transaction?.txHash) throw new Error('circle_transaction_pending');
  const submittedState = phaseName === 'APPROVAL' ? 'APPROVAL_SUBMITTED' : 'ENTRY_SUBMITTED';
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET circle_state = $7, ${phase.txId} = COALESCE(${phase.txId}, $5), ${phase.txHash} = COALESCE(${phase.txHash}, $6)
      WHERE id = $1 AND user_id = $2 AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state = ANY($8::varchar[])
        AND (${phase.txId} IS NULL OR ${phase.txId} = $5)
        AND (${phase.txHash} IS NULL OR LOWER(${phase.txHash}) = LOWER($6))
      RETURNING id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_state,
       circle_approval_challenge_id, circle_approval_idempotency_key, circle_approval_ref_id,
       circle_approval_transaction_id, circle_approval_tx_hash, circle_entry_challenge_id,
       circle_entry_idempotency_key, circle_entry_ref_id, circle_entry_transaction_id, verified_tx_hash`,
    [
      actionId, userId, walletAddress, circleWalletId, transaction.id, transaction.txHash,
      submittedState, phase.bindStates,
    ],
  );
  if (rows.length) return actionRow(rows[0]);

  const existing = await getCircleEntryAction(userId, actionId, walletAddress, circleWalletId);
  const allowed = phaseName === 'APPROVAL'
    ? isTerminalOrAdvancedApprovalState(existing.circleState)
    : existing.circleState === 'VERIFIED';
  if (!allowed || !hasSameBoundCircleTransaction(existing, phaseName, transaction)) {
    throw new Error('circle_entry_authorization_invalid');
  }
  return existing;
}

async function markCircleApprovalVerified(userId, actionId, walletAddress, circleWalletId) {
  const { rowCount } = await db.query(
    `UPDATE action_authorizations SET circle_state = 'APPROVAL_VERIFIED', verified_at = NOW()
      WHERE id = $1 AND user_id = $2 AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state IN ('APPROVAL_SUBMITTED', 'APPROVAL_VERIFIED')`,
    [actionId, userId, walletAddress, circleWalletId],
  );
  if (rowCount === 1) return;
  const action = await getCircleEntryAction(userId, actionId, walletAddress, circleWalletId);
  if (!isTerminalOrAdvancedApprovalState(action.circleState) ||
    !action.circleApprovalTransactionId || !action.circleApprovalTxHash) {
    throw new Error('circle_entry_authorization_invalid');
  }
}

async function markCircleEntryReceiptVerified(userId, actionId, walletAddress, circleWalletId, txHash) {
  const { rowCount } = await db.query(
    `UPDATE action_authorizations SET circle_state = 'VERIFIED', verified_at = NOW()
      WHERE id = $1 AND user_id = $2 AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state IN ('ENTRY_SUBMITTED', 'VERIFIED')
        AND LOWER(verified_tx_hash) = LOWER($5)`,
    [actionId, userId, walletAddress, circleWalletId, txHash],
  );
  if (rowCount === 1) return;
  const action = await getCircleEntryAction(userId, actionId, walletAddress, circleWalletId);
  if (action.circleState !== 'VERIFIED' || !action.verifiedTxHash ||
    action.verifiedTxHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new Error('circle_entry_authorization_invalid');
  }
}

async function createTicketTransferRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalTicketTransferPayload({
    ...params,
    nonce,
    expiresAt,
  });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'TRANSFER_TICKET',
    payload,
  );
}

async function createRefundRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalRefundPayload({
    ...params,
    nonce,
    expiresAt,
  });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'REFUND_TICKET',
    payload,
  );
}


async function createClaimRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalClaimPayload({
    ...params,
    nonce,
    expiresAt,
  });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'CLAIM_REWARD',
    payload,
  );
}

async function createMarketplaceListRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalMarketplaceListPayload({ ...params, nonce, expiresAt });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'MARKETPLACE_LIST',
    payload,
  );
}

async function createMarketplaceUpdatePriceRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalMarketplaceUpdatePricePayload({ ...params, nonce, expiresAt });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'MARKETPLACE_UPDATE_PRICE',
    payload,
  );
}

async function createMarketplaceCancelRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalMarketplaceCancelPayload({ ...params, nonce, expiresAt });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'MARKETPLACE_CANCEL',
    payload,
  );
}

async function createMarketplaceBuyRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalMarketplaceBuyPayload({ ...params, nonce, expiresAt });

  return insertActionRequest(
    { id, userId: params.userId, expiresAt },
    'MARKETPLACE_BUY',
    payload,
  );
}

async function attachWebAuthnChallenge(userId, actionId, challenge, context) {
  const { rowCount } = await db.query(
    `UPDATE action_authorizations
        SET challenge = $1,
            rp_id = $2,
            origin = $3
      WHERE id = $4
        AND user_id = $5
        AND expires_at > NOW()
        AND verified_at IS NULL
        AND consumed_at IS NULL`,
    [challenge, context.rpID, context.origin, actionId, userId],
  );

  if (rowCount !== 1) throw new Error('action_challenge_expired');
}

async function consumeWebAuthnChallenge(userId, actionId) {
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET challenge_consumed_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND expires_at > NOW()
        AND challenge IS NOT NULL
        AND challenge_consumed_at IS NULL
        AND verified_at IS NULL
        AND consumed_at IS NULL
      RETURNING challenge, rp_id, origin, payload_hash, payload_json, action_type`,
    [actionId, userId],
  );

  if (!rows.length) throw new Error('action_challenge_expired');

  return {
    challenge: rows[0].challenge,
    rpID: rows[0].rp_id,
    origin: rows[0].origin,
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    actionType: rows[0].action_type,
  };
}

async function consumeVerifiedAction(
  userId,
  actionId,
  expectedPayloadHash,
  expectedActionType,
) {
  if (!['ENTRY', 'TRANSFER_TICKET', 'REFUND_TICKET', 'CLAIM_REWARD', 'MARKETPLACE_LIST', 'MARKETPLACE_UPDATE_PRICE', 'MARKETPLACE_CANCEL', 'MARKETPLACE_BUY'].includes(expectedActionType)) {
    throw new Error('action_authorization_invalid');
  }

  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET verified_at = NOW(),
            consumed_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND payload_hash = $3
        AND action_type = $4
        AND challenge_consumed_at IS NOT NULL
        AND verified_at IS NULL
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING id, action_type, payload_hash, payload_json, verified_at, consumed_at`,
    [actionId, userId, expectedPayloadHash, expectedActionType],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');

  return {
    id: rows[0].id,
    actionType: rows[0].action_type,
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    verifiedAt: rows[0].verified_at,
    consumedAt: rows[0].consumed_at,
  };
}

async function getConsumedAction(userId, actionId, expectedActionType) {
  if (!['ENTRY', 'TRANSFER_TICKET', 'REFUND_TICKET', 'CLAIM_REWARD', 'MARKETPLACE_LIST', 'MARKETPLACE_UPDATE_PRICE', 'MARKETPLACE_CANCEL', 'MARKETPLACE_BUY'].includes(expectedActionType)) {
    throw new Error('action_authorization_invalid');
  }

  const { rows } = await db.query(
    `SELECT id, action_type, payload_hash, payload_json, consumed_at,
            external_state, authorization_expires_at, verified_tx_hash
       FROM action_authorizations
      WHERE id = $1
        AND user_id = $2
        AND action_type = $3
        AND consumed_at IS NOT NULL
        AND (
          payload_json->>'executionMode' NOT IN ('EXTERNAL_WALLET', 'EXTERNAL_OWNER')
          OR authorization_expires_at IS NULL
          OR authorization_expires_at > NOW()
        )
      LIMIT 1`,
    [actionId, userId, expectedActionType],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');

  return {
    id: rows[0].id,
    actionType: rows[0].action_type,
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    consumedAt: rows[0].consumed_at,
    externalState: rows[0].external_state,
    authorizationExpiresAt: rows[0].authorization_expires_at,
    verifiedTxHash: rows[0].verified_tx_hash,
  };
}

async function getPendingExternalAction(userId, actionId, expectedActionType, walletAddress) {
  const { rows } = await db.query(
    `SELECT id, action_type, payload_hash, payload_json, verified_at, expires_at
       FROM action_authorizations
      WHERE id = $1
        AND user_id = $2
        AND action_type = $3
        AND LOWER(payload_json->>'walletAddress') = LOWER($4)
        AND payload_json->>'executionMode' IN ('EXTERNAL_WALLET', 'EXTERNAL_OWNER')
        AND consumed_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [actionId, userId, expectedActionType, walletAddress],
  );
  if (!rows.length) throw new Error('action_authorization_invalid');
  return {
    id: rows[0].id,
    actionType: rows[0].action_type,
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    verifiedAt: rows[0].verified_at,
    expiresAt: rows[0].expires_at,
  };
}

async function initializeExternalEntryState(userId, actionId, walletAddress, state) {
  if (!['APPROVAL_REQUIRED', 'ENTRY_READY'].includes(state)) {
    throw new Error('action_authorization_invalid');
  }

  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET external_state = $4,
            authorization_expires_at = CASE
              WHEN $4 = 'ENTRY_READY' THEN NOW() + INTERVAL '10 minutes'
              ELSE authorization_expires_at
            END
      WHERE id = $1
        AND user_id = $2
        AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND payload_json->>'executionMode' = 'EXTERNAL_WALLET'
        AND external_state IS NULL
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING external_state, authorization_expires_at`,
    [actionId, userId, walletAddress, state],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');
  return {
    externalState: rows[0].external_state,
    authorizationExpiresAt: rows[0].authorization_expires_at,
  };
}

async function getPendingExternalEntryAction(userId, actionId, walletAddress, expectedState) {
  if (expectedState !== 'APPROVAL_REQUIRED') {
    throw new Error('action_authorization_invalid');
  }

  const { rows } = await db.query(
    `SELECT id, action_type, payload_hash, payload_json, external_state, expires_at
       FROM action_authorizations
      WHERE id = $1
        AND user_id = $2
        AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND payload_json->>'executionMode' = 'EXTERNAL_WALLET'
        AND external_state = $4
        AND consumed_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [actionId, userId, walletAddress, expectedState],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');
  return {
    id: rows[0].id,
    actionType: rows[0].action_type,
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    externalState: rows[0].external_state,
    expiresAt: rows[0].expires_at,
  };
}

async function completeExternalEntryApproval(userId, actionId, walletAddress) {
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET external_state = 'ENTRY_READY',
            verified_at = NOW(),
            authorization_expires_at = NOW() + INTERVAL '10 minutes'
      WHERE id = $1
        AND user_id = $2
        AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND payload_json->>'executionMode' = 'EXTERNAL_WALLET'
        AND external_state = 'APPROVAL_REQUIRED'
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING payload_hash, payload_json, external_state, verified_at, authorization_expires_at`,
    [actionId, userId, walletAddress],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');
  return {
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    externalState: rows[0].external_state,
    verifiedAt: rows[0].verified_at,
    authorizationExpiresAt: rows[0].authorization_expires_at,
  };
}

async function bindExternalEntryTransaction(userId, actionId, walletAddress, txHash) {
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET external_state = 'ENTRY_SUBMITTED',
            verified_tx_hash = $4,
            consumed_at = NOW(),
            authorization_expires_at = NOW() + INTERVAL '10 minutes'
      WHERE id = $1
        AND user_id = $2
        AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND payload_json->>'executionMode' = 'EXTERNAL_WALLET'
        AND external_state = 'ENTRY_READY'
        AND consumed_at IS NULL
        AND COALESCE(authorization_expires_at, expires_at) > NOW()
      RETURNING id, payload_hash, payload_json, external_state, verified_tx_hash, consumed_at, authorization_expires_at`,
    [actionId, userId, walletAddress, txHash],
  );

  if (rows.length) {
    return {
      id: rows[0].id,
      payloadHash: rows[0].payload_hash,
      payload: rows[0].payload_json,
      externalState: rows[0].external_state,
      verifiedTxHash: rows[0].verified_tx_hash,
      consumedAt: rows[0].consumed_at,
      authorizationExpiresAt: rows[0].authorization_expires_at,
    };
  }

  const existing = await getConsumedAction(userId, actionId, 'ENTRY');
  if (
    !['ENTRY_SUBMITTED', 'VERIFIED'].includes(existing.externalState) ||
    !existing.verifiedTxHash ||
    existing.verifiedTxHash.toLowerCase() !== txHash.toLowerCase() ||
    existing.payload.walletAddress.toLowerCase() !== walletAddress.toLowerCase()
  ) {
    throw new Error('action_authorization_invalid');
  }
  return existing;
}

async function markExternalEntryReceiptVerified(userId, actionId, walletAddress, txHash) {
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET external_state = 'VERIFIED',
            verified_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND payload_json->>'executionMode' = 'EXTERNAL_WALLET'
        AND external_state IN ('ENTRY_SUBMITTED', 'VERIFIED')
        AND LOWER(verified_tx_hash) = LOWER($4)
        AND consumed_at IS NOT NULL
        AND authorization_expires_at > NOW()
      RETURNING external_state, verified_at, verified_tx_hash`,
    [actionId, userId, walletAddress, txHash],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');
  return {
    externalState: rows[0].external_state,
    verifiedAt: rows[0].verified_at,
    verifiedTxHash: rows[0].verified_tx_hash,
  };
}

async function consumeExternalAction(userId, actionId, expectedActionType, walletAddress) {
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET consumed_at = NOW(),
            authorization_expires_at = NOW() + INTERVAL '10 minutes'
      WHERE id = $1
        AND user_id = $2
        AND action_type = $3
        AND LOWER(payload_json->>'walletAddress') = LOWER($4)
        AND payload_json->>'executionMode' IN ('EXTERNAL_WALLET', 'EXTERNAL_OWNER')
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING id, action_type, payload_hash, payload_json, consumed_at`,
    [actionId, userId, expectedActionType, walletAddress],
  );
  if (!rows.length) throw new Error('action_authorization_invalid');
  return {
    id: rows[0].id,
    actionType: rows[0].action_type,
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    consumedAt: rows[0].consumed_at,
  };
}

module.exports = {
  createEntryRequest,
  createOrGetCircleEntryRequest,
  createTicketTransferRequest,
  createRefundRequest,
  createClaimRequest,
  createMarketplaceListRequest,
  createMarketplaceUpdatePriceRequest,
  createMarketplaceCancelRequest,
  createMarketplaceBuyRequest,
  attachWebAuthnChallenge,
  consumeWebAuthnChallenge,
  consumeVerifiedAction,
  getConsumedAction,
  getPendingExternalAction,
  initializeExternalEntryState,
  getPendingExternalEntryAction,
  completeExternalEntryApproval,
  bindExternalEntryTransaction,
  markExternalEntryReceiptVerified,
  consumeExternalAction,
  getCircleEntryAction,
  reserveCircleEntryChallenge,
  persistCircleEntryChallenge,
  persistCircleEntryTransactionId,
  bindCircleEntryTransaction,
  markCircleApprovalVerified,
  markCircleEntryReceiptVerified,
  CIRCLE_PHASES,
  hasSameBoundCircleTransaction,
};
