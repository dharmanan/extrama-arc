'use strict';

const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');

const db = require('../db');
const sessionService = require('../services/sessionService');
const circleUserWalletService = require('../services/circleUserWalletService');
const gatewayNetworks = require('../services/gatewayNetworks');
const { encrypt, decrypt } = require('../services/cryptoService');
const { requireAuth } = require('../middleware/auth');
const { EXECUTION_MODES } = require('../services/executionIdentityService');

const router = express.Router();
const deviceLimiter = rateLimit({ windowMs: 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });

const emailOtpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const deviceId = String(req.body?.deviceId || '');
    return `${email}:${deviceId}`;
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'circle_email_otp_cooldown' });
  },
});

const walletLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const readinessLimiter = rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false });

const idempotencyKey = z.string().uuid();
const deviceId = z.string().min(1).max(512);
const userToken = z.string().min(1).max(8192);
const socialSchema = z.object({ deviceId, idempotencyKey });
const emailSchema = z.object({ deviceId, email: z.string().email().max(254), idempotencyKey });
const userTokenSchema = z.object({ userToken });
const circleSessionSchema = userTokenSchema.extend({
  refreshToken: z.string().min(16).max(8192).optional(),
  deviceId: z.string().min(1).max(512).optional(),
});
const refreshSessionSchema = z.object({ deviceId: z.string().min(1).max(512) });
const initializeSchema = userTokenSchema.extend({ idempotencyKey });

async function findOrCreateCircleUser(walletAddress) {
  const normalized = walletAddress.toLowerCase();
  const existing = await db.query(
    'SELECT id, owner_address FROM users WHERE owner_address = $1 LIMIT 1',
    [normalized],
  );
  if (existing.rows.length) return existing.rows[0];
  const { rows } = await db.query(
    `INSERT INTO users (id, owner_address)
       VALUES ($1, $2)
       ON CONFLICT (owner_address) DO UPDATE SET owner_address = EXCLUDED.owner_address
       RETURNING id, owner_address`,
    [crypto.randomUUID(), normalized],
  );
  return rows[0];
}

router.get('/readiness', readinessLimiter, async (req, res) => {
  if (!circleUserWalletService.isConfigured()) {
    return res.status(503).json({
      ok: false,
      provider: 'circle',
      mode: 'USER_CONTROLLED',
      configured: false,
      reachable: false,
    });
  }

  try {
    await circleUserWalletService.verifyReadiness();

    return res.json({
      ok: true,
      provider: 'circle',
      mode: 'USER_CONTROLLED',
      configured: true,
      reachable: true,
    });
  } catch (error) {
    const upstreamStatus =
      error?.response?.status ??
      error?.status ??
      null;

    const circleCode =
      circleUserWalletService.circleErrorCode?.(error) ??
      null;

    console.error(
      '[circle] readiness check failed',
      JSON.stringify({ upstreamStatus, circleCode }),
    );

    return res.status(503).json({
      ok: false,
      provider: 'circle',
      mode: 'USER_CONTROLLED',
      configured: true,
      reachable: false,
    });
  }
});

router.post('/device-token/social', deviceLimiter, async (req, res, next) => {
  try {
    res.json(await circleUserWalletService.createSocialDeviceToken(socialSchema.parse(req.body)));
  } catch (error) { next(error); }
});

router.post('/device-token/email', emailOtpLimiter, deviceLimiter, async (req, res, next) => {
  try {
    res.json(await circleUserWalletService.createEmailDeviceToken(emailSchema.parse(req.body)));
  } catch (error) { next(error); }
});

router.post('/wallet/initialize', walletLimiter, async (req, res, next) => {
  try {
    res.json(await circleUserWalletService.initializeArcEoa(initializeSchema.parse(req.body)));
  } catch (error) { next(error); }
});

router.post('/wallet', walletLimiter, async (req, res, next) => {
  try {
    const wallet = await circleUserWalletService.listArcEoa(userTokenSchema.parse(req.body).userToken);
    if (!wallet) return res.status(404).json({ error: 'circle_arc_eoa_not_found' });
    res.json({ wallet });
  } catch (error) { next(error); }
});

const sourcePrepareSchema = userTokenSchema.extend({ idempotencyKey });

// A Gateway funding source is addressed by its DOMAIN, never by a blockchain
// name the browser makes up: the domain is mapped to a canonical network here,
// and only a network the product offers as a deposit source resolves at all.
function resolveSourceDomain(value) {
  const domain = Number(value);
  if (!Number.isInteger(domain)) return null;
  return gatewayNetworks.depositSourceForDomain(domain);
}

// Every route below requires an already-authenticated EXTREMA session: the
// comparison target is always the session's own canonical Arc address, never
// a browser-supplied one, and a source-chain Circle wallet id never replaces
// the session's Arc Circle wallet id.
router.post('/wallet/source/:domain', walletLimiter, requireAuth, async (req, res, next) => {
  try {
    if (req.auth.executionMode !== EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return res.status(409).json({ error: 'circle_wallet_session_required' });
    }
    const network = resolveSourceDomain(req.params.domain);
    if (!network) return res.status(400).json({ error: 'gateway_deposit_source_unsupported' });
    const token = userTokenSchema.parse(req.body).userToken;
    const wallet = await circleUserWalletService.listEoaForBlockchain(
      token, network.circleBlockchain,
    );
    circleUserWalletService.assertCircleSourceWalletMatchesAddress(
      wallet, req.auth.walletAddress,
    );
    res.json({ wallet, domain: network.domain, arcAddress: req.auth.walletAddress });
  } catch (error) { next(error); }
});

// Preparation creates the companion wallet and nothing else. It never
// approves, deposits or transfers.
router.post('/wallet/source/:domain/prepare', walletLimiter, requireAuth, async (req, res, next) => {
  try {
    if (req.auth.executionMode !== EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return res.status(409).json({ error: 'circle_wallet_session_required' });
    }
    const network = resolveSourceDomain(req.params.domain);
    if (!network) return res.status(400).json({ error: 'gateway_deposit_source_unsupported' });
    const input = sourcePrepareSchema.parse(req.body);
    const result = await circleUserWalletService.prepareEoaForBlockchain({
      userToken: input.userToken,
      idempotencyKey: input.idempotencyKey,
      blockchain: network.circleBlockchain,
      arcAddress: req.auth.walletAddress,
    });
    res.json({ ...result, domain: network.domain });
  } catch (error) { next(error); }
});

router.post('/session', walletLimiter, async (req, res, next) => {
  try {
    const input = circleSessionSchema.parse(req.body);
    const token = input.userToken;
    // The address and Circle wallet ID are both derived from Circle's
    // authenticated listing; a browser can never nominate either field.
    const wallet = await circleUserWalletService.listArcEoa(token);
    if (!wallet) return res.status(404).json({ error: 'circle_arc_eoa_not_found' });
    const user = await findOrCreateCircleUser(wallet.address);
    const extremaToken = await sessionService.createSession(user.id, wallet.address, {
      executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
      walletAddress: wallet.address,
      circleWalletId: wallet.id,
    });
    if (input.refreshToken && input.deviceId) {
      await db.query(
        `INSERT INTO circle_refresh_credentials
          (user_id, circle_wallet_id, user_token_encrypted, refresh_token_encrypted)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, circle_wallet_id) DO UPDATE
           SET user_token_encrypted = EXCLUDED.user_token_encrypted,
               refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
               updated_at = NOW()`,
        [user.id, wallet.id, encrypt(token), encrypt(input.refreshToken)],
      );
    }
    res.json({
      token: extremaToken,
      ownerAddress: wallet.address,
      walletAddress: wallet.address,
      circleWalletId: wallet.id,
      executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    });
  } catch (error) { next(error); }
});

router.post('/session/refresh', walletLimiter, requireAuth, async (req, res, next) => {
  try {
    if (req.auth.executionMode !== EXECUTION_MODES.CIRCLE_USER_WALLET || !req.auth.circleWalletId) {
      return res.status(409).json({ error: 'circle_wallet_session_required' });
    }
    const { deviceId } = refreshSessionSchema.parse(req.body);
    const stored = await db.query(
      `SELECT user_token_encrypted, refresh_token_encrypted
         FROM circle_refresh_credentials
        WHERE user_id = $1 AND circle_wallet_id = $2
        LIMIT 1`,
      [req.auth.userId, req.auth.circleWalletId],
    );
    if (!stored.rows.length) return res.status(401).json({ error: 'circle_reauthentication_required' });

    const rotated = await circleUserWalletService.refreshUserToken({
      userToken: decrypt(stored.rows[0].user_token_encrypted),
      refreshToken: decrypt(stored.rows[0].refresh_token_encrypted),
      deviceId,
    });
    const wallet = await circleUserWalletService.listArcEoa(rotated.userToken);
    if (!wallet || wallet.id !== req.auth.circleWalletId || wallet.address.toLowerCase() !== req.auth.walletAddress.toLowerCase()) {
      throw new Error('circle_session_identity_mismatch');
    }
    await db.query(
      `UPDATE circle_refresh_credentials
          SET user_token_encrypted = $3, refresh_token_encrypted = $4, updated_at = NOW()
        WHERE user_id = $1 AND circle_wallet_id = $2`,
      [req.auth.userId, req.auth.circleWalletId, encrypt(rotated.userToken), encrypt(rotated.refreshToken)],
    );
    res.json({
      userToken: rotated.userToken,
      encryptionKey: rotated.encryptionKey,
      ownerAddress: req.auth.ownerAddress,
      walletAddress: wallet.address,
      circleWalletId: wallet.id,
      executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    });
  } catch (error) { next(error); }
});

module.exports = router;
