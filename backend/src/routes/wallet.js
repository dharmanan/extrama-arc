'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const walletService = require('../services/walletService');
const arcService = require('../services/arcService');

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const wallet = await walletService.getWalletForUser(req.auth.userId);
    res.json({ wallet });
  } catch (error) {
    next(error);
  }
});

router.get('/chain-state', async (req, res, next) => {
  try {
    const wallet = await walletService.getWalletForUser(req.auth.userId);
    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const state = await arcService.readArcWalletState(wallet.address);
    res.json(state);
  } catch (error) {
    next(error);
  }
});

router.get('/tickets', async (req, res, next) => {
  try {
    const wallet = await walletService.getWalletForUser(req.auth.userId);
    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const startedAt = Date.now();
    const state = await arcService.getOwnedTicketsState(wallet.address);
    res.set('Server-Timing', `wallet-tickets;dur=${Date.now() - startedAt}`);
    res.json(state);
  } catch (error) {
    next(error);
  }
});

router.post('/create', async (req, res, next) => {
  try {
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
