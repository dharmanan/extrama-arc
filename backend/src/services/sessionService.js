'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
// SYSTEM_SEED_WALLET agents sign through the encrypted seed wallet signer and
// never hold an HTTP session; createSessionIdentity() rejects that mode.
const {
  EXECUTION_MODES,
  createSessionIdentity,
} = require('./executionIdentityService');

async function createSession(userId, ownerAddress, options = {}) {
  // Every human session names its execution mode explicitly: EXTERNAL_WALLET
  // or CIRCLE_USER_WALLET. There is no default, so a session can never
  // silently fall back to a legacy mode.
  const identity = createSessionIdentity({
    executionMode: options.executionMode,
    ownerAddress,
    walletAddress: options.walletAddress ?? null,
  });
  const circleWalletId = options.circleWalletId ?? null;

  if (identity.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
    if (
      typeof circleWalletId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(circleWalletId)
    ) {
      throw new Error('circle_wallet_id_required');
    }
  } else if (circleWalletId !== null) {
    throw new Error('circle_wallet_id_forbidden');
  }

  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.JWT_TTL_SECONDS * 1000);

  await db.query(
    `INSERT INTO auth_sessions
      (jti, user_id, owner_address, execution_mode, wallet_address, circle_wallet_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      jti,
      userId,
      identity.ownerAddress,
      identity.executionMode,
      identity.walletAddress,
      circleWalletId,
      expiresAt,
    ],
  );

  return jwt.sign(
    {
      sub: userId,
      ownerAddress: identity.ownerAddress,
      executionMode: identity.executionMode,
      walletAddress: identity.walletAddress,
      circleWalletId: circleWalletId,
      jti,
    },
    config.JWT_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: config.JWT_TTL_SECONDS,
      issuer: 'extrema',
      audience: 'extrema-web',
    },
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: 'extrema',
    audience: 'extrema-web',
  });
}

async function getActiveSession(jti) {
  const { rows } = await db.query(
    `SELECT user_id, owner_address, execution_mode, wallet_address, circle_wallet_id
       FROM auth_sessions
      WHERE jti = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [jti],
  );
  if (!rows.length) return null;
  return {
    userId: rows[0].user_id,
    ownerAddress: rows[0].owner_address,
    executionMode: rows[0].execution_mode,
    walletAddress: rows[0].wallet_address,
    circleWalletId: rows[0].circle_wallet_id,
  };
}

async function isSessionActive(jti) {
  return Boolean(await getActiveSession(jti));
}

async function revokeSession(jti) {
  await db.query(
    'UPDATE auth_sessions SET revoked_at = NOW() WHERE jti = $1 AND revoked_at IS NULL',
    [jti],
  );
}

module.exports = {
  createSession,
  verifyToken,
  getActiveSession,
  isSessionActive,
  revokeSession,
};
