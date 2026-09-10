'use strict';

const crypto = require('crypto');
const db = require('../db');

const ACTION_TTL_MS = 2 * 60 * 1000;
const EXTERNAL_ENTRY_TTL_MS = 10 * 60 * 1000;
const CIRCLE_ENTRY_TTL_MS = 30 * 60 * 1000;
// Every Circle financial action gets the same window as Circle ENTRY: a
// hosted challenge, its approval, and Circle indexing can take minutes.
const CIRCLE_ACTION_TTL_MS = CIRCLE_ENTRY_TTL_MS;

const ACTION_TYPES = Object.freeze([
  'ENTRY',
  'TRANSFER_TICKET',
  'REFUND_TICKET',
  'CLAIM_REWARD',
  'MARKETPLACE_LIST',
  'MARKETPLACE_UPDATE_PRICE',
  'MARKETPLACE_CANCEL',
  'MARKETPLACE_BUY',
]);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalEntryPayload({
  walletAddress,
  poolAddress,
  roundId,
  predictionPriceCents,
  executionMode,
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
  executionMode,
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
  // Connected wallet entries only. Circle entries use
  // createOrGetCircleEntryRequest(); agent entries never pass through HTTP
  // action authorization at all.
  if (params.executionMode !== 'EXTERNAL_WALLET') {
    throw new Error('action_authorization_invalid');
  }
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + EXTERNAL_ENTRY_TTL_MS);
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

// ---------------------------------------------------------------------------
// Circle user controlled wallet state machine, shared by every action type.
//
// A Circle action has at most two phases: an optional APPROVAL and the action
// itself. The physical circle_entry_* columns predate this generalisation:
// they now hold the action phase of EVERY action type, not only ENTRY.
// Renaming them would require a production schema migration for no
// behavioural gain, so they are mapped to generic names once, here.
// ---------------------------------------------------------------------------

const CIRCLE_APPROVAL_COLUMNS = Object.freeze({
  idempotency: 'circle_approval_idempotency_key',
  ref: 'circle_approval_ref_id',
  challenge: 'circle_approval_challenge_id',
  txId: 'circle_approval_transaction_id',
  txHash: 'circle_approval_tx_hash',
});

const CIRCLE_ACTION_COLUMNS = Object.freeze({
  idempotency: 'circle_entry_idempotency_key',
  ref: 'circle_entry_ref_id',
  challenge: 'circle_entry_challenge_id',
  txId: 'circle_entry_transaction_id',
  txHash: 'verified_tx_hash',
});

const CIRCLE_ACTION_RETURNING = `id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_state,
       circle_approval_challenge_id, circle_approval_idempotency_key, circle_approval_ref_id,
       circle_approval_transaction_id, circle_approval_tx_hash, circle_entry_challenge_id,
       circle_entry_idempotency_key, circle_entry_ref_id, circle_entry_transaction_id, verified_tx_hash`;

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
    circleActionChallengeId: row[CIRCLE_ACTION_COLUMNS.challenge],
    circleActionIdempotencyKey: row[CIRCLE_ACTION_COLUMNS.idempotency],
    circleActionRefId: row[CIRCLE_ACTION_COLUMNS.ref],
    circleActionTransactionId: row[CIRCLE_ACTION_COLUMNS.txId],
    verifiedTxHash: row.verified_tx_hash,
  };
}

async function createOrGetCircleEntryRequest(params) {
  const requestId = params.requestId;
  if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) throw new Error('circle_request_id_invalid');
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CIRCLE_ENTRY_TTL_MS);
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
     RETURNING ${CIRCLE_ACTION_RETURNING}`,
    [id, params.userId, payloadHash, payload, expiresAt, params.circleWalletId, requestId],
  );
  const action = actionRow(rows[0]);
  if (!sameCircleEntryIntent(action.payload, params) || action.circleWalletId !== params.circleWalletId) {
    throw new Error('circle_request_id_conflict');
  }
  return action;
}

const CIRCLE_PAYLOAD_BUILDERS = Object.freeze({
  TRANSFER_TICKET: (params) => canonicalTicketTransferPayload(params),
  REFUND_TICKET: (params) => canonicalRefundPayload(params),
  CLAIM_REWARD: (params) => canonicalClaimPayload(params),
  MARKETPLACE_LIST: (params) => canonicalMarketplaceListPayload(params),
  MARKETPLACE_UPDATE_PRICE: (params) => canonicalMarketplaceUpdatePricePayload(params),
  MARKETPLACE_CANCEL: (params) => canonicalMarketplaceCancelPayload(params),
  MARKETPLACE_BUY: (params) => canonicalMarketplaceBuyPayload(params),
});

// JSONB does not preserve key order, so intent comparison uses a key sorted
// serialization of everything except the per request nonce and expiry.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function circleIntentKey(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const intent = { ...payload };
  delete intent.nonce;
  delete intent.expiresAt;
  return stableStringify(intent);
}

// One Circle request ID always names exactly one financial intent. Replaying
// the same request ID returns the original action (and so its original
// challenge); reusing it for any different intent is refused.
async function createOrGetCircleActionRequest(params) {
  const { actionType, requestId } = params;
  const build = CIRCLE_PAYLOAD_BUILDERS[actionType];
  if (!build) throw new Error('circle_action_authorization_invalid');
  if (!/^[0-9a-f-]{36}$/i.test(requestId || '')) throw new Error('circle_request_id_invalid');
  if (typeof params.circleWalletId !== 'string' || !params.circleWalletId) {
    throw new Error('circle_wallet_session_mismatch');
  }
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CIRCLE_ACTION_TTL_MS);
  const payload = build({
    ...params,
    executionMode: 'CIRCLE_USER_WALLET',
    nonce,
    expiresAt,
  });
  const payloadHash = sha256Hex(JSON.stringify(payload));
  const { rows } = await db.query(
    `INSERT INTO action_authorizations
       (id, user_id, action_type, payload_hash, payload_json, expires_at, circle_wallet_id, circle_request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, action_type, circle_request_id)
       WHERE circle_request_id IS NOT NULL
     DO UPDATE SET id = action_authorizations.id
     RETURNING ${CIRCLE_ACTION_RETURNING}`,
    [id, params.userId, actionType, payloadHash, payload, expiresAt, params.circleWalletId, requestId],
  );
  const action = actionRow(rows[0]);
  if (
    action.actionType !== actionType ||
    circleIntentKey(action.payload) !== circleIntentKey(payload) ||
    action.circleWalletId !== params.circleWalletId
  ) {
    throw new Error('circle_request_id_conflict');
  }
  return action;
}

const CIRCLE_PHASES = Object.freeze({
  APPROVAL: {
    reservationStates: [null, 'APPROVAL_CHALLENGE'],
    state: 'APPROVAL_CHALLENGE',
    submittedState: 'APPROVAL_SUBMITTED',
    bindStates: ['APPROVAL_CHALLENGE', 'APPROVAL_SUBMITTED'],
    columns: CIRCLE_APPROVAL_COLUMNS,
  },
  // ENTRY keeps its original state labels so ENTRY rows written before this
  // generalisation reconcile unchanged.
  ENTRY: {
    reservationStates: [null, 'APPROVAL_VERIFIED', 'ENTRY_CHALLENGE'],
    state: 'ENTRY_CHALLENGE',
    submittedState: 'ENTRY_SUBMITTED',
    bindStates: ['ENTRY_CHALLENGE', 'ENTRY_SUBMITTED'],
    columns: CIRCLE_ACTION_COLUMNS,
  },
  ACTION: {
    reservationStates: [null, 'APPROVAL_VERIFIED', 'ACTION_CHALLENGE'],
    state: 'ACTION_CHALLENGE',
    submittedState: 'ACTION_SUBMITTED',
    bindStates: ['ACTION_CHALLENGE', 'ACTION_SUBMITTED'],
    columns: CIRCLE_ACTION_COLUMNS,
  },
});

// The phases each action type may use. An approval phase exists only where
// the contract needs a prior approve: the USDC stake for ENTRY, the exact
// USDC ask for MARKETPLACE_BUY, and the per token NFT approval for
// MARKETPLACE_LIST.
const CIRCLE_ACTION_PHASES = Object.freeze({
  ENTRY: ['APPROVAL', 'ENTRY'],
  TRANSFER_TICKET: ['ACTION'],
  REFUND_TICKET: ['ACTION'],
  CLAIM_REWARD: ['ACTION'],
  MARKETPLACE_LIST: ['APPROVAL', 'ACTION'],
  MARKETPLACE_UPDATE_PRICE: ['ACTION'],
  MARKETPLACE_CANCEL: ['ACTION'],
  MARKETPLACE_BUY: ['APPROVAL', 'ACTION'],
});

const ADVANCED_APPROVAL_STATES = Object.freeze([
  'APPROVAL_VERIFIED',
  'ENTRY_CHALLENGE',
  'ENTRY_SUBMITTED',
  'ACTION_CHALLENGE',
  'ACTION_SUBMITTED',
  'VERIFIED',
]);

function circleInvalidError(actionType) {
  return actionType === 'ENTRY'
    ? 'circle_entry_authorization_invalid'
    : 'circle_action_authorization_invalid';
}

function circleActionPhaseName(actionType) {
  return actionType === 'ENTRY' ? 'ENTRY' : 'ACTION';
}

function circlePhaseFor(actionType, phaseName) {
  const allowed = CIRCLE_ACTION_PHASES[actionType];
  if (!allowed || !allowed.includes(phaseName)) throw new Error(circleInvalidError(actionType));
  return CIRCLE_PHASES[phaseName];
}

function assertCircleActionType(actionType) {
  if (!Object.prototype.hasOwnProperty.call(CIRCLE_ACTION_PHASES, actionType)) {
    throw new Error('circle_action_authorization_invalid');
  }
}

function hasSameBoundCircleTransaction(action, phaseName, transaction) {
  const isApproval = phaseName === 'APPROVAL';
  const transactionId = isApproval ? action?.circleApprovalTransactionId : action?.circleActionTransactionId;
  const txHash = isApproval ? action?.circleApprovalTxHash : action?.verifiedTxHash;
  return Boolean(
    CIRCLE_PHASES[phaseName] && transactionId && txHash &&
    transactionId === transaction.id &&
    txHash.toLowerCase() === transaction.txHash.toLowerCase(),
  );
}

function isTerminalOrAdvancedApprovalState(state) {
  return ADVANCED_APPROVAL_STATES.includes(state);
}

async function getCircleAction(actionType, userId, actionId, walletAddress, circleWalletId) {
  assertCircleActionType(actionType);
  const { rows } = await db.query(
    `SELECT ${CIRCLE_ACTION_RETURNING}
       FROM action_authorizations
      WHERE id = $1 AND user_id = $2 AND action_type = $5
        AND payload_json->>'executionMode' = 'CIRCLE_USER_WALLET'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND circle_wallet_id = $4
      LIMIT 1`,
    [actionId, userId, walletAddress, circleWalletId, actionType],
  );
  if (!rows.length) throw new Error(circleInvalidError(actionType));
  return actionRow(rows[0]);
}

async function reserveCircleChallenge(actionType, userId, actionId, walletAddress, circleWalletId, phaseName) {
  const phase = circlePhaseFor(actionType, phaseName);
  const { columns } = phase;
  const idempotencyKey = crypto.randomUUID();
  const refId = `${actionId}:${phaseName.toLowerCase()}`;
  const stateCondition = phase.reservationStates.includes(null)
    ? '(circle_state IS NULL OR circle_state = ANY($5::varchar[]))'
    : 'circle_state = ANY($5::varchar[])';
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET circle_state = $6,
            ${columns.idempotency} = COALESCE(${columns.idempotency}, $7),
            ${columns.ref} = COALESCE(${columns.ref}, $8)
      WHERE id = $1 AND user_id = $2 AND action_type = $9
        AND payload_json->>'executionMode' = 'CIRCLE_USER_WALLET'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND circle_wallet_id = $4
        AND ${stateCondition}
        AND expires_at > NOW()
      RETURNING ${CIRCLE_ACTION_RETURNING}`,
    [
      actionId, userId, walletAddress, circleWalletId,
      phase.reservationStates.filter(Boolean), phase.state, idempotencyKey, refId, actionType,
    ],
  );
  if (!rows.length) throw new Error(circleInvalidError(actionType));
  return actionRow(rows[0]);
}

async function persistCircleChallenge(actionType, userId, actionId, walletAddress, circleWalletId, phaseName, challengeId) {
  const phase = circlePhaseFor(actionType, phaseName);
  if (typeof challengeId !== 'string' || !challengeId) throw new Error(circleInvalidError(actionType));
  const { columns } = phase;
  const { rows } = await db.query(
    `UPDATE action_authorizations SET ${columns.challenge} = COALESCE(${columns.challenge}, $5)
      WHERE id = $1 AND user_id = $2 AND action_type = $7
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state = $6 AND (${columns.challenge} IS NULL OR ${columns.challenge} = $5)
      RETURNING ${columns.challenge} AS challenge_id`,
    [actionId, userId, walletAddress, circleWalletId, challengeId, phase.state, actionType],
  );
  if (!rows.length) throw new Error(circleInvalidError(actionType));
  return rows[0].challenge_id;
}

async function persistCircleTransactionId(
  actionType, userId, actionId, walletAddress, circleWalletId, phaseName, transactionId,
) {
  const phase = circlePhaseFor(actionType, phaseName);
  if (typeof transactionId !== 'string' || !transactionId) {
    throw new Error(circleInvalidError(actionType));
  }
  const { columns } = phase;
  const reusableStates = phaseName === 'APPROVAL'
    ? [...phase.bindStates, ...ADVANCED_APPROVAL_STATES]
    : [...phase.bindStates, 'VERIFIED'];
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET ${columns.txId} = COALESCE(${columns.txId}, $5)
      WHERE id = $1 AND user_id = $2 AND action_type = $7
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state = ANY($6::varchar[])
        AND (${columns.txId} IS NULL OR ${columns.txId} = $5)
      RETURNING ${CIRCLE_ACTION_RETURNING}`,
    [actionId, userId, walletAddress, circleWalletId, transactionId, reusableStates, actionType],
  );
  if (rows.length) return actionRow(rows[0]);
  const action = await getCircleAction(actionType, userId, actionId, walletAddress, circleWalletId);
  const storedId = phaseName === 'APPROVAL'
    ? action.circleApprovalTransactionId
    : action.circleActionTransactionId;
  if (storedId !== transactionId) throw new Error(circleInvalidError(actionType));
  return action;
}

async function bindCircleTransaction(actionType, userId, actionId, walletAddress, circleWalletId, phaseName, transaction) {
  const phase = circlePhaseFor(actionType, phaseName);
  if (!transaction?.id || !transaction?.txHash) throw new Error('circle_transaction_pending');
  const { columns } = phase;
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET circle_state = $7, ${columns.txId} = COALESCE(${columns.txId}, $5), ${columns.txHash} = COALESCE(${columns.txHash}, $6)
      WHERE id = $1 AND user_id = $2 AND action_type = $9
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state = ANY($8::varchar[])
        AND (${columns.txId} IS NULL OR ${columns.txId} = $5)
        AND (${columns.txHash} IS NULL OR LOWER(${columns.txHash}) = LOWER($6))
      RETURNING ${CIRCLE_ACTION_RETURNING}`,
    [
      actionId, userId, walletAddress, circleWalletId, transaction.id, transaction.txHash,
      phase.submittedState, phase.bindStates, actionType,
    ],
  );
  if (rows.length) return actionRow(rows[0]);

  // Already past this phase: only the exact same Circle transaction and tx
  // hash may be observed again. A different transaction is never bound.
  const existing = await getCircleAction(actionType, userId, actionId, walletAddress, circleWalletId);
  const allowed = phaseName === 'APPROVAL'
    ? isTerminalOrAdvancedApprovalState(existing.circleState)
    : existing.circleState === 'VERIFIED';
  if (!allowed || !hasSameBoundCircleTransaction(existing, phaseName, transaction)) {
    throw new Error(circleInvalidError(actionType));
  }
  return existing;
}

async function markCircleApprovalVerifiedForAction(actionType, userId, actionId, walletAddress, circleWalletId) {
  circlePhaseFor(actionType, 'APPROVAL');
  const { rowCount } = await db.query(
    `UPDATE action_authorizations SET circle_state = 'APPROVAL_VERIFIED', verified_at = NOW()
      WHERE id = $1 AND user_id = $2 AND action_type = $5
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state IN ('APPROVAL_SUBMITTED', 'APPROVAL_VERIFIED')`,
    [actionId, userId, walletAddress, circleWalletId, actionType],
  );
  if (rowCount === 1) return;
  const action = await getCircleAction(actionType, userId, actionId, walletAddress, circleWalletId);
  if (!isTerminalOrAdvancedApprovalState(action.circleState) ||
    !action.circleApprovalTransactionId || !action.circleApprovalTxHash) {
    throw new Error(circleInvalidError(actionType));
  }
}

async function markCircleActionVerified(actionType, userId, actionId, walletAddress, circleWalletId, txHash) {
  const phase = circlePhaseFor(actionType, circleActionPhaseName(actionType));
  const { rowCount } = await db.query(
    `UPDATE action_authorizations SET circle_state = 'VERIFIED', verified_at = NOW()
      WHERE id = $1 AND user_id = $2 AND action_type = $6
        AND LOWER(payload_json->>'walletAddress') = LOWER($3) AND circle_wallet_id = $4
        AND circle_state = ANY($7::varchar[])
        AND LOWER(verified_tx_hash) = LOWER($5)`,
    [actionId, userId, walletAddress, circleWalletId, txHash, actionType, [phase.submittedState, 'VERIFIED']],
  );
  if (rowCount === 1) return;
  const action = await getCircleAction(actionType, userId, actionId, walletAddress, circleWalletId);
  if (action.circleState !== 'VERIFIED' || !action.verifiedTxHash ||
    action.verifiedTxHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new Error(circleInvalidError(actionType));
  }
}

// ENTRY named entry points. Circle ENTRY is live and proven, and its service
// and tests address the state machine through these names.
function getCircleEntryAction(userId, actionId, walletAddress, circleWalletId) {
  return getCircleAction('ENTRY', userId, actionId, walletAddress, circleWalletId);
}

function reserveCircleEntryChallenge(userId, actionId, walletAddress, circleWalletId, phaseName) {
  return reserveCircleChallenge('ENTRY', userId, actionId, walletAddress, circleWalletId, phaseName);
}

function persistCircleEntryChallenge(userId, actionId, walletAddress, circleWalletId, phaseName, challengeId) {
  return persistCircleChallenge('ENTRY', userId, actionId, walletAddress, circleWalletId, phaseName, challengeId);
}

function persistCircleEntryTransactionId(userId, actionId, walletAddress, circleWalletId, phaseName, transactionId) {
  return persistCircleTransactionId('ENTRY', userId, actionId, walletAddress, circleWalletId, phaseName, transactionId);
}

function bindCircleEntryTransaction(userId, actionId, walletAddress, circleWalletId, phaseName, transaction) {
  return bindCircleTransaction('ENTRY', userId, actionId, walletAddress, circleWalletId, phaseName, transaction);
}

function markCircleApprovalVerified(userId, actionId, walletAddress, circleWalletId) {
  return markCircleApprovalVerifiedForAction('ENTRY', userId, actionId, walletAddress, circleWalletId);
}

function markCircleEntryReceiptVerified(userId, actionId, walletAddress, circleWalletId, txHash) {
  return markCircleActionVerified('ENTRY', userId, actionId, walletAddress, circleWalletId, txHash);
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

async function getConsumedAction(userId, actionId, expectedActionType) {
  if (!ACTION_TYPES.includes(expectedActionType)) {
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
        SET external_state = $4::varchar,
            authorization_expires_at = CASE
              WHEN $4::varchar = 'ENTRY_READY'::varchar THEN NOW() + INTERVAL '10 minutes'
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
  createOrGetCircleActionRequest,
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
  getCircleAction,
  reserveCircleChallenge,
  persistCircleChallenge,
  persistCircleTransactionId,
  bindCircleTransaction,
  markCircleApprovalVerifiedForAction,
  markCircleActionVerified,
  circleIntentKey,
  ACTION_TYPES,
  CIRCLE_PHASES,
  CIRCLE_ACTION_PHASES,
  CIRCLE_ACTION_COLUMNS,
  hasSameBoundCircleTransaction,
};
