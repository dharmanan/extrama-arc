'use strict';

const crypto = require('crypto');
const db = require('../db');

const ACTION_TTL_MS = 2 * 60 * 1000;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalEntryPayload({
  walletAddress,
  poolAddress,
  roundId,
  predictionPriceCents,
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
    destination: poolAddress,
    walletAddress,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

async function createEntryRequest(params) {
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);
  const payload = canonicalEntryPayload({
    ...params,
    nonce,
    expiresAt,
  });
  const payloadHash = sha256Hex(JSON.stringify(payload));

  await db.query(
    `INSERT INTO action_authorizations
      (id, user_id, action_type, payload_hash, payload_json, expires_at)
     VALUES ($1, $2, 'ENTRY', $3, $4, $5)`,
    [id, params.userId, payloadHash, payload, expiresAt],
  );

  return {
    id,
    payload,
    payloadHash,
    expiresAt,
    expiresInSeconds: Math.floor(ACTION_TTL_MS / 1000),
  };
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

async function consumeVerifiedAction(userId, actionId, expectedPayloadHash) {
  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET verified_at = NOW(),
            consumed_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND payload_hash = $3
        AND action_type = 'ENTRY'
        AND challenge_consumed_at IS NOT NULL
        AND verified_at IS NULL
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING id, action_type, payload_hash, payload_json, verified_at, consumed_at`,
    [actionId, userId, expectedPayloadHash],
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

module.exports = {
  createEntryRequest,
  attachWebAuthnChallenge,
  consumeWebAuthnChallenge,
  consumeVerifiedAction,
};
