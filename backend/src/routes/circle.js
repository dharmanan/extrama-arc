'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');

const circleUserWalletService = require('../services/circleUserWalletService');

const router = express.Router();

const readinessLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

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

    console.error(
      '[circle] readiness check failed',
      JSON.stringify({ upstreamStatus }),
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

module.exports = router;
