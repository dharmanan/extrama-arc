'use strict';

const express = require('express');
const arcService = require('../services/arcService');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const state = await arcService.getStandardRoundsState({ forceFresh: req.query.fresh === '1' });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const state = await arcService.getStandardRoundsState({ forceFresh: req.query.fresh === '1' });
    const pool = state.pools.find((item) => item.slug === req.params.slug);

    if (!pool) {
      return res.status(404).json({ error: 'round_not_found' });
    }

    res.json({
      chain: state.chain,
      factory: state.factory,
      pool,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
