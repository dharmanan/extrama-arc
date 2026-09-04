'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const walletService = require('../services/walletService');

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
