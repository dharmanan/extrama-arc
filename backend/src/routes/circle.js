'use strict';

const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');

const db = require('../db');
const sessionService = require('../services/sessionService');
const circleUserWalletService = require('../services/circleUserWalletService');
const { EXECUTION_MODES } = require('../services/executionIdentityService');

const router = express.Router();
const deviceLimiter = rateLimit({ windowMs: 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false });
const walletLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const readinessLimiter = rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false });

const idempotencyKey = z.string().uuid();
const deviceId = z.string().min(1).max(512);
const userToken = z.string().min(1).max(8192);
const socialSchema = z.object({ deviceId, idempotencyKey });
const emailSchema = z.object({ deviceId, email: z.string().email().max(254), idempotencyKey });
const userTokenSchema = z.object({ userToken });
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

router.post('/device-token/email', deviceLimiter, async (req, res, next) => {
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

router.post('/session', walletLimiter, async (req, res, next) => {
  try {
    const token = userTokenSchema.parse(req.body).userToken;
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
    res.json({
      token: extremaToken,
      ownerAddress: wallet.address,
      walletAddress: wallet.address,
      circleWalletId: wallet.id,
      executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    });
  } catch (error) { next(error); }
});

module.exports = router;
