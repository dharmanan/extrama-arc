'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const arcService = require('../services/arcService');
const gatewayService = require('../services/gatewayService');
const gatewayFundingService = require('../services/gatewayFundingService');
const gatewayDepositService = require('../services/gatewayDepositService');
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

// circleUserToken is required only for a CIRCLE_USER_WALLET session; an
// EXTERNAL_WALLET session signs locally and never sends one. The service
// enforces that requirement per session, not this schema.
const gatewayFundingStartSchema = z.object({
  requestId: z.string().uuid(),
  sourceDomain: z.number().int().nonnegative(),
  valueRaw: z.string().regex(/^[1-9][0-9]*$/),
  circleUserToken: z.string().min(16).max(8192).optional(),
});
const gatewayFundingVerifySchema = z.object({
  circleUserToken: z.string().min(16).max(8192).optional(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(),
});

const gatewayDepositStartSchema = z.object({
  requestId: z.string().uuid(),
  sourceDomain: z.number().int().nonnegative(),
  amountRaw: z.string().regex(/^[1-9][0-9]*$/),
  circleUserToken: z.string().min(16).max(8192).optional(),
});
const gatewayDepositVerifySchema = z.object({
  circleUserToken: z.string().min(16).max(8192).optional(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
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

// Gateway is available to both human execution modes. The depositor is
// always the authenticated session wallet, never a browser-supplied address.
router.get('/gateway-balance', async (req, res, next) => {
  try {
    const wallet = await resolveSessionWallet(req);
    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const gateway = await gatewayService.readUnifiedUsdcBalance(wallet.address);

    res.json({
      ...gateway,
      executionMode: req.auth.executionMode,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/gateway-funding/start', gatewayFundingStartLimiter, async (req, res, next) => {
  try {
    const { circleUserToken, ...input } = gatewayFundingStartSchema.parse(req.body);
    res.json(await gatewayFundingService.start({ auth: req.auth, userToken: circleUserToken, ...input }));
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
    const { circleUserToken, ...input } = gatewayFundingVerifySchema.parse(req.body);
    res.json(await gatewayFundingService.verifySignature({
      auth: req.auth,
      actionId: req.params.actionId,
      userToken: circleUserToken,
      ...input,
    }));
  } catch (error) { next(error); }
});

// Gateway SOURCE deposit (Base Sepolia approve + deposit into GatewayWallet),
// available to both human execution modes. Distinct from gateway-funding
// above: this is what gets USDC into the unified balance in the first place.
router.post('/gateway-deposit/start', gatewayFundingStartLimiter, async (req, res, next) => {
  try {
    const { circleUserToken, ...input } = gatewayDepositStartSchema.parse(req.body);
    res.json(await gatewayDepositService.start({ auth: req.auth, userToken: circleUserToken, ...input }));
  } catch (error) { next(error); }
});

router.get('/gateway-deposit/:actionId', async (req, res, next) => {
  try {
    res.json(await gatewayDepositService.status({ auth: req.auth, actionId: req.params.actionId }));
  } catch (error) { next(error); }
});

router.post('/gateway-deposit/:actionId/verify-approval', gatewayFundingVerifyLimiter, async (req, res, next) => {
  try {
    const { circleUserToken, ...input } = gatewayDepositVerifySchema.parse(req.body);
    res.json(await gatewayDepositService.verifyApproval({
      auth: req.auth, actionId: req.params.actionId, userToken: circleUserToken, ...input,
    }));
  } catch (error) { next(error); }
});

router.post('/gateway-deposit/:actionId/verify', gatewayFundingVerifyLimiter, async (req, res, next) => {
  try {
    const { circleUserToken, ...input } = gatewayDepositVerifySchema.parse(req.body);
    res.json(await gatewayDepositService.verifyDeposit({
      auth: req.auth, actionId: req.params.actionId, userToken: circleUserToken, ...input,
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
