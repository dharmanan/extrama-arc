'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const arcService = require('../services/arcService');
const { createRoundResultCache } = require('../services/roundResultCache');
const {
  createArchiveSnapshotService,
  createPostgresArchiveSnapshotStore,
} = require('../services/archiveSnapshotService');
const db = require('../db');

const router = express.Router();

const entriesLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

router.get('/', async (req, res, next) => {
  try {
    const state = await arcService.getStandardRoundsState({ forceFresh: req.query.fresh === '1' });
    res.json(state);
  } catch (error) {
    next(error);
  }
});


// The archive is an expensive chain read that only changes when a round
// closes or a claim lands. Its last successful response is kept in memory and
// durably in PostgreSQL and served stale while revalidate: a request never
// waits for Arc while a snapshot exists, even right after a restart. Live
// round endpoints are deliberately not cached here.
const archiveSnapshots = createArchiveSnapshotService({
  readRoundArchive: (params) => arcService.readRoundArchive(params),
  store: createPostgresArchiveSnapshotStore(db),
});

router.get('/archive', async (req, res, next) => {
  try {
    const days = req.query.days === undefined ? 90 : Number(req.query.days);
    if (!Number.isInteger(days) || days <= 0 || days > 90) {
      return res.status(400).json({ error: 'archive_days_invalid' });
    }

    const archive = await archiveSnapshots.get(days);
    res.json(archive);
  } catch (error) {
    next(error);
  }
});


// Result pages are revisited and opened from the archive; a 15 second cache
// with shared in flight reads keeps that fast while claim state stays fresh.
const roundResultCache = createRoundResultCache({
  readRoundResult: (params) => arcService.readRoundResult(params),
});

router.get('/:slug/:roundId/result', async (req, res, next) => {
  try {
    const roundId = Number(req.params.roundId);
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ error: 'round_result_request_invalid' });
    }

    const result = await roundResultCache.read({
      slug: req.params.slug,
      roundId,
    });

    res.json(result);
  } catch (error) {
    if (
      error.message === 'round_result_not_found' ||
      error.message === 'round_result_not_supported'
    ) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

router.get('/:slug/:roundId/entries', entriesLimiter, async (req, res, next) => {
  try {
    if (!/^[1-9][0-9]*$/.test(req.params.roundId)) {
      return res.status(400).json({ error: 'round_entries_request_invalid' });
    }
    const roundId = Number(req.params.roundId);
    if (!Number.isSafeInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ error: 'round_entries_request_invalid' });
    }

    const result = await arcService.readRoundEntries({
      slug: req.params.slug,
      roundId,
    });

    res.json(result);
  } catch (error) {
    if (
      error.message === 'round_entries_not_found' ||
      error.message === 'round_entries_not_supported'
    ) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

router.get('/:slug/:roundId/verification', async (req, res, next) => {
  try {
    const roundId = Number(req.params.roundId);
    if (!Number.isInteger(roundId) || roundId <= 0) {
      return res.status(400).json({ error: 'round_verification_request_invalid' });
    }

    const result = await arcService.readRoundVerification({
      slug: req.params.slug,
      roundId,
    });

    res.json(result);
  } catch (error) {
    if (
      error.message === 'round_verification_not_found' ||
      error.message === 'round_verification_not_supported'
    ) {
      return res.status(404).json({ error: error.message });
    }
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
