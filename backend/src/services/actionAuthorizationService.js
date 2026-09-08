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
    `SELECT id, action_type, payload_hash, payload_json, consumed_at
       FROM action_authorizations
      WHERE id = $1
        AND user_id = $2
        AND action_type = $3
        AND consumed_at IS NOT NULL
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

async function markExternalApprovalVerified(userId, actionId, walletAddress) {
  const { rowCount } = await db.query(
    `UPDATE action_authorizations
        SET verified_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND action_type = 'ENTRY'
        AND LOWER(payload_json->>'walletAddress') = LOWER($3)
        AND payload_json->>'executionMode' = 'EXTERNAL_WALLET'
        AND consumed_at IS NULL
        AND expires_at > NOW()`,
    [actionId, userId, walletAddress],
  );
  if (rowCount !== 1) throw new Error('action_authorization_invalid');
}

async function consumeExternalAction(userId, actionId, expectedActionType, walletAddress) {
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET consumed_at = NOW()
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
  markExternalApprovalVerified,
  consumeExternalAction,
};
