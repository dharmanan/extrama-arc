'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');

async function createSession(userId, ownerAddress) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + config.JWT_TTL_SECONDS * 1000);

  await db.query(
    `INSERT INTO auth_sessions (jti, user_id, owner_address, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [jti, userId, ownerAddress.toLowerCase(), expiresAt],
  );

  return jwt.sign(
    {
      sub: userId,
      ownerAddress: ownerAddress.toLowerCase(),
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

async function isSessionActive(jti) {
  const { rows } = await db.query(
    `SELECT 1
       FROM auth_sessions
      WHERE jti = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [jti],
  );
  return rows.length > 0;
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
  isSessionActive,
  revokeSession,
};
