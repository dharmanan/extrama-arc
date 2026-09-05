'use strict';

const crypto = require('crypto');
const db = require('../db');

const ACTION_TTL_MS = 2 * 60 * 1000;
const AUTHORIZATION_TTL_MS = 90 * 1000;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalEntryPayload({
  walletAddress,
  poolAddress,
  roundId,
  predictionPriceCents,
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
  };
}

async function createEntryRequest(params) {
  const payload = canonicalEntryPayload(params);
  const serialized = JSON.stringify(payload);
  const payloadHash = sha256Hex(serialized);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ACTION_TTL_MS);

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

async function issueAuthorization(userId, actionId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const authorizationExpiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS);

  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET verified_at = NOW(),
            authorization_token_hash = $1,
            authorization_expires_at = $2
      WHERE id = $3
        AND user_id = $4
        AND challenge_consumed_at IS NOT NULL
        AND verified_at IS NULL
        AND expires_at > NOW()
        AND consumed_at IS NULL
      RETURNING payload_hash, payload_json, action_type`,
    [tokenHash, authorizationExpiresAt, actionId, userId],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');

  return {
    authorizationToken: token,
    authorizationExpiresAt,
    expiresInSeconds: Math.floor(AUTHORIZATION_TTL_MS / 1000),
    payloadHash: rows[0].payload_hash,
    payload: rows[0].payload_json,
    actionType: rows[0].action_type,
  };
}

async function consumeAuthorization({
  userId,
  authorizationToken,
  actionType,
  payloadHash,
}) {
  const tokenHash = sha256Hex(authorizationToken);

  const { rows } = await db.query(
    `UPDATE action_authorizations
        SET consumed_at = NOW()
      WHERE user_id = $1
        AND action_type = $2
        AND payload_hash = $3
        AND authorization_token_hash = $4
        AND verified_at IS NOT NULL
        AND authorization_expires_at > NOW()
        AND consumed_at IS NULL
      RETURNING id, payload_json, verified_at`,
    [userId, actionType, payloadHash, tokenHash],
  );

  if (!rows.length) throw new Error('action_authorization_invalid');

  return rows[0];
}

module.exports = {
  createEntryRequest,
  attachWebAuthnChallenge,
  consumeWebAuthnChallenge,
  issueAuthorization,
  consumeAuthorization,
};
