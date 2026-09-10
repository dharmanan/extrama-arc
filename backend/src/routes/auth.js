'use strict';

const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { ethers } = require('ethers');
const { z } = require('zod');

const db = require('../db');
const sessionService = require('../services/sessionService');
const { requireAuth } = require('../middleware/auth');
const { EXECUTION_MODES } = require('../services/executionIdentityService');

const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const finishLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const walletSchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const walletLoginFinishSchema = walletSchema.extend({
  challengeId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

function walletLoginMessage(ownerAddress, challengeId) {
  return [
    'Sign in to EXTREMA',
    `Wallet: ${ownerAddress.toLowerCase()}`,
    `Nonce: ${challengeId}`,
    'This signature authenticates your session only and does not authorize a transaction.',
  ].join('\n');
}

async function findOrCreateUser(ownerAddress) {
  const normalized = ownerAddress.toLowerCase();
  const existing = await db.query(
    'SELECT id, owner_address FROM users WHERE owner_address = $1 LIMIT 1',
    [normalized],
  );

  if (existing.rows.length) return existing.rows[0];

  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO users (id, owner_address)
     VALUES ($1, $2)
     ON CONFLICT (owner_address) DO UPDATE
       SET owner_address = EXCLUDED.owner_address
     RETURNING id, owner_address`,
    [id, normalized],
  );

  return rows[0];
}

router.post('/wallet-login/challenge', startLimiter, async (req, res, next) => {
  try {
    const { ownerAddress } = walletSchema.parse(req.body);
    const normalized = ownerAddress.toLowerCase();
    const challengeId = crypto.randomUUID();
    const message = walletLoginMessage(normalized, challengeId);

    await db.query(
      `INSERT INTO auth_challenges
        (id, user_id, challenge, purpose, expires_at)
       VALUES ($1, NULL, $2, 'wallet_login', NOW() + INTERVAL '5 minutes')`,
      [challengeId, message],
    );

    res.json({ challengeId, message, expiresInSeconds: 300 });
  } catch (error) {
    next(error);
  }
});

router.post('/wallet-login/finish', finishLimiter, async (req, res, next) => {
  try {
    const { ownerAddress, challengeId, signature } = walletLoginFinishSchema.parse(req.body);
    const normalized = ownerAddress.toLowerCase();
    const expectedMessage = walletLoginMessage(normalized, challengeId);
    const { rows } = await db.query(
      `SELECT challenge
         FROM auth_challenges
        WHERE id = $1
          AND purpose = 'wallet_login'
          AND challenge = $2
          AND expires_at > NOW()
        LIMIT 1`,
      [challengeId, expectedMessage],
    );

    if (!rows.length) {
      return res.status(400).json({ error: 'wallet_challenge_expired' });
    }

    let recovered;
    try {
      recovered = ethers.verifyMessage(rows[0].challenge, signature).toLowerCase();
    } catch {
      return res.status(401).json({ error: 'invalid_wallet_signature' });
    }
    if (recovered !== normalized) {
      return res.status(401).json({ error: 'invalid_wallet_signature' });
    }

    const consumed = await db.query(
      `DELETE FROM auth_challenges
        WHERE id = $1
          AND purpose = 'wallet_login'
          AND challenge = $2
          AND expires_at > NOW()
        RETURNING id`,
      [challengeId, expectedMessage],
    );
    if (!consumed.rows.length) {
      return res.status(400).json({ error: 'wallet_challenge_expired' });
    }

    const user = await findOrCreateUser(normalized);
    const token = await sessionService.createSession(user.id, normalized, {
      executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
      walletAddress: normalized,
    });

    res.json({
      token,
      ownerAddress: normalized,
      walletAddress: normalized,
      executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/session', requireAuth, async (req, res) => {
  res.json({
    authenticated: true,
    ownerAddress: req.auth.ownerAddress,
    walletAddress: req.auth.walletAddress,
    executionMode: req.auth.executionMode,
  });
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await sessionService.revokeSession(req.auth.jti);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
