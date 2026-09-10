'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const arcService = require('../services/arcService');
const gatewayService = require('../services/gatewayService');
const gatewayFundingService = require('../services/gatewayFundingService');
const { EXECUTION_MODES } = require('../services/executionIdentityService');

const router = express.Router();

const gatewayFundingStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
const gatewayFundingVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const gatewayFundingStartSchema = z.object({
  requestId: z.string().uuid(),
  sourceDomain: z.number().int().nonnegative(),
  valueRaw: z.string().regex(/^[1-9][0-9]*$/),
  circleUserToken: z.string().min(16).max(8192),
});
const gatewayFundingVerifySchema = z.object({
  circleUserToken: z.string().min(16).max(8192),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(),
});

router.use(requireAuth);

// The session wallet is the user's own product wallet: the connected EVM
// wallet, or the Circle user controlled Arc EOA. EXTREMA never creates or
// holds a wallet for a human user.
async function resolveSessionWallet(req) {
  if (
    req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET ||
    req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET
  ) {
    return {
      id: req.auth.circleWalletId || null,
      address: req.auth.walletAddress,
      createdAt: null,
      executionMode: req.auth.executionMode,
    };
  }
  return null;
}

router.get('/', async (req, res, next) => {
  try {
    const wallet = await resolveSessionWallet(req);
    res.json({ wallet, executionMode: req.auth.executionMode });
  } catch (error) {
    next(error);
  }
});

router.get('/chain-state', async (req, res, next) => {
  try {
    const wallet = await resolveSessionWallet(req);
    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const state = await arcService.getArcWalletState(wallet.address);
    res.json(state);
  } catch (error) {
    next(error);
  }
});

router.get('/gateway-balance', async (req, res, next) => {
  try {
    if (req.auth.executionMode !== EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return res.status(409).json({ error: 'gateway_circle_wallet_required' });
    }

    const wallet = await resolveSessionWallet(req);
    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const gateway = await gatewayService.readUnifiedUsdcBalance(wallet.address);

    res.json({
      ...gateway,
      executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/gateway-funding/start', gatewayFundingStartLimiter, async (req, res, next) => {
  try {
    const input = gatewayFundingStartSchema.parse(req.body);
    res.json(await gatewayFundingService.start({ auth: req.auth, ...input }));
  } catch (error) { next(error); }
});

router.get('/gateway-funding/:actionId', async (req, res, next) => {
  try {
    res.json(await gatewayFundingService.status({ auth: req.auth, actionId: req.params.actionId }));
  } catch (error) { next(error); }
});

// Exists for an explicitly enabled server deployment only. The default config
// rejects it before any Gateway network call, and the durable CAS in the
// service prevents retries from posting a second financial operation.
router.post('/gateway-funding/:actionId/submit', gatewayFundingStartLimiter, async (req, res, next) => {
  try {
    res.json(await gatewayFundingService.submit({ auth: req.auth, actionId: req.params.actionId }));
  } catch (error) { next(error); }
});

router.post('/gateway-funding/:actionId/verify', gatewayFundingVerifyLimiter, async (req, res, next) => {
  try {
    const input = gatewayFundingVerifySchema.parse(req.body);
    res.json(await gatewayFundingService.verifySignature({
      auth: req.auth,
      actionId: req.params.actionId,
      ...input,
    }));
  } catch (error) { next(error); }
});

router.get('/tickets', async (req, res, next) => {
  try {
    const wallet = await resolveSessionWallet(req);
    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const startedAt = Date.now();
    const tickets = await arcService.readOwnedTickets(wallet.address);

    res.set('Server-Timing', `wallet-tickets;dur=${Date.now() - startedAt}`);
    res.json({
      wallet: tickets,
      executionMode: req.auth.executionMode,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
