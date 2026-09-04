'use strict';

const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { ethers } = require('ethers');
const { z } = require('zod');

const db = require('../db');
const passkeyService = require('../services/passkeyService');
const sessionService = require('../services/sessionService');
const { requireAuth } = require('../middleware/auth');

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

const registerStartSchema = walletSchema.extend({
  challengeId: z.string().uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

const credentialSchema = z.object({}).passthrough();

function registrationMessage(ownerAddress, challengeId) {
  return [
    'EXTREMA passkey registration',
    `Owner: ${ownerAddress.toLowerCase()}`,
    `Nonce: ${challengeId}`,
    'Sign this message to prove wallet ownership before registering a passkey.',
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

async function consumeOwnerChallenge(challengeId) {
  const { rows } = await db.query(
    `DELETE FROM auth_challenges
      WHERE id = $1
        AND purpose = 'owner_register'
        AND expires_at > NOW()
      RETURNING id`,
    [challengeId],
  );
  return rows.length > 0;
}

router.post('/register/challenge', startLimiter, async (req, res, next) => {
  try {
    const { ownerAddress } = walletSchema.parse(req.body);
    const challengeId = crypto.randomUUID();

    await db.query(
      `INSERT INTO auth_challenges
        (id, user_id, challenge, purpose, expires_at)
       VALUES ($1, NULL, $2, 'owner_register', NOW() + INTERVAL '5 minutes')`,
      [challengeId, challengeId],
    );

    res.json({
      challengeId,
      message: registrationMessage(ownerAddress, challengeId),
      expiresInSeconds: 300,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/register/start', startLimiter, async (req, res, next) => {
  try {
    const { ownerAddress, challengeId, signature } = registerStartSchema.parse(req.body);
    const normalized = ownerAddress.toLowerCase();

    let recovered;
    try {
      recovered = ethers.verifyMessage(
        registrationMessage(normalized, challengeId),
        signature,
      ).toLowerCase();
    } catch {
      return res.status(401).json({ error: 'invalid_wallet_signature' });
    }

    if (recovered !== normalized) {
      return res.status(401).json({ error: 'invalid_wallet_signature' });
    }

    const consumed = await consumeOwnerChallenge(challengeId);
    if (!consumed) {
      return res.status(400).json({ error: 'wallet_challenge_expired' });
    }

    const user = await findOrCreateUser(normalized);
    const options = await passkeyService.startRegistration(
      user.id,
      normalized,
      req.get('x-extrema-origin') || req.get('origin'),
    );

    res.json(options);
  } catch (error) {
    next(error);
  }
});

router.post('/register/finish', finishLimiter, async (req, res, next) => {
  try {
    const schema = walletSchema.extend({
      credential: credentialSchema,
      deviceName: z.string().max(100).optional(),
    });
    const { ownerAddress, credential, deviceName } = schema.parse(req.body);
    const normalized = ownerAddress.toLowerCase();

    const { rows } = await db.query(
      'SELECT id FROM users WHERE owner_address = $1 LIMIT 1',
      [normalized],
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_found' });

    await passkeyService.finishRegistration(rows[0].id, credential, deviceName);
    const token = await sessionService.createSession(rows[0].id, normalized);

    res.json({
      token,
      ownerAddress: normalized,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/login/start', startLimiter, async (req, res, next) => {
  try {
    const { ownerAddress } = walletSchema.parse(req.body);
    const normalized = ownerAddress.toLowerCase();

    const { rows } = await db.query(
      'SELECT id FROM users WHERE owner_address = $1 LIMIT 1',
      [normalized],
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_registered' });

    const options = await passkeyService.startAuthentication(
      rows[0].id,
      req.get('x-extrema-origin') || req.get('origin'),
    );
    res.json(options);
  } catch (error) {
    next(error);
  }
});

router.post('/login/finish', finishLimiter, async (req, res, next) => {
  try {
    const schema = walletSchema.extend({
      credential: credentialSchema,
    });
    const { ownerAddress, credential } = schema.parse(req.body);
    const normalized = ownerAddress.toLowerCase();

    const { rows } = await db.query(
      'SELECT id FROM users WHERE owner_address = $1 LIMIT 1',
      [normalized],
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_registered' });

    await passkeyService.finishAuthentication(rows[0].id, credential);
    const token = await sessionService.createSession(rows[0].id, normalized);

    res.json({
      token,
      ownerAddress: normalized,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/session', requireAuth, async (req, res) => {
  res.json({
    authenticated: true,
    ownerAddress: req.auth.ownerAddress,
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
