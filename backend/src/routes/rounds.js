'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const arcService = require('../services/arcService');
const { createRoundResultCache } = require('../services/roundResultCache');

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
// closes or a claim lands, so it alone gets a short in memory cache keyed by
// `days`. Concurrent identical requests share one in flight read, a failed
// read is never cached, and the first request after the TTL refreshes it.
// Live round endpoints are deliberately not cached here.
const ARCHIVE_CACHE_TTL_MS = 45 * 1000;
const archiveCache = new Map();
const archiveInFlight = new Map();

function readRoundArchiveCached(days) {
  const cached = archiveCache.get(days);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.archive);

  const pending = archiveInFlight.get(days);
  if (pending) return pending;

  const read = arcService.readRoundArchive({ days })
    .then((archive) => {
      archiveCache.set(days, { archive, expiresAt: Date.now() + ARCHIVE_CACHE_TTL_MS });
      return archive;
    })
    .finally(() => {
      archiveInFlight.delete(days);
    });
  archiveInFlight.set(days, read);
  return read;
}

router.get('/archive', async (req, res, next) => {
  try {
    const days = req.query.days === undefined ? 90 : Number(req.query.days);
    if (!Number.isInteger(days) || days <= 0 || days > 90) {
      return res.status(400).json({ error: 'archive_days_invalid' });
    }

    const archive = await readRoundArchiveCached(days);
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
