'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const walletService = require('../services/walletService');
const arcService = require('../services/arcService');
const { EXECUTION_MODES } = require('../services/executionIdentityService');

const router = express.Router();

router.use(requireAuth);

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
  const wallet = await walletService.getWalletForUser(req.auth.userId);
  return wallet ? { ...wallet, executionMode: EXECUTION_MODES.BACKEND_WALLET } : null;
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

router.get('/tickets', async (req, res, next) => {
  try {
    const wallet = await resolveSessionWallet(req);
    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const ownerAddress = req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
      ? req.auth.ownerAddress || null
      : null;
    const sameAddress = Boolean(
      ownerAddress && ownerAddress.toLowerCase() === wallet.address.toLowerCase(),
    );

    const startedAt = Date.now();
    const [backendWallet, ownerWallet] = await Promise.all([
      arcService.readOwnedTickets(wallet.address),
      ownerAddress && !sameAddress ? arcService.readOwnedTickets(ownerAddress) : null,
    ]);

    res.set('Server-Timing', `wallet-tickets;dur=${Date.now() - startedAt}`);
    res.json({
      backendWallet,
      ownerWallet,
      executionMode: req.auth.executionMode,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/create', async (req, res, next) => {
  try {
    if (req.auth.executionMode !== EXECUTION_MODES.BACKEND_WALLET) {
      return res.status(409).json({ error: 'wallet_execution_mode_mismatch' });
    }
    const result = await walletService.createWalletForUser(req.auth.userId);

    res.status(result.created ? 201 : 200).json({
      created: result.created,
      wallet: result.wallet,
      privateKey: result.privateKey,
      privateKeyDisclosure: result.created ? 'one_time_only' : null,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
