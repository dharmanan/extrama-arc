'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const arcService = require('../services/arcService');
const gatewayService = require('../services/gatewayService');
const { EXECUTION_MODES } = require('../services/executionIdentityService');

const router = express.Router();

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
