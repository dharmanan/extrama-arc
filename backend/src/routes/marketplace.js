'use strict';

const express = require('express');
const marketplaceService = require('../services/marketplaceService');

const router = express.Router();

router.get('/listings', async (req, res, next) => {
  try {
    const state = await marketplaceService.getMarketplaceListingsState({
      forceFresh: req.query.fresh === '1',
    });
    res.json(state);
  } catch (error) {
    next(error);
  }
});

router.get('/listings/:listingId', async (req, res, next) => {
  try {
    if (!/^[1-9][0-9]*$/.test(req.params.listingId)) {
      return res.status(400).json({ error: 'marketplace_listing_request_invalid' });
    }
    const listingId = Number(req.params.listingId);
    if (!Number.isSafeInteger(listingId)) {
      return res.status(400).json({ error: 'marketplace_listing_request_invalid' });
    }

    const result = await marketplaceService.readMarketplaceListing(listingId);
    res.json(result);
  } catch (error) {
    if (
      error.message === 'marketplace_listing_not_found' ||
      error.message === 'marketplace_listing_unsupported_ticket'
    ) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

router.get('/tickets/:ticketAddress/:tokenId/approval', async (req, res, next) => {
  try {
    const result = await marketplaceService.readTicketApprovalState({
      ticketAddress: req.params.ticketAddress,
      tokenId: req.params.tokenId,
    });
    res.json(result);
  } catch (error) {
    if (
      error.message === 'marketplace_approval_request_invalid' ||
      error.message === 'marketplace_approval_unsupported_ticket'
    ) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message === 'marketplace_ticket_not_found') {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

router.get('/usdc-allowance/:ownerAddress', async (req, res, next) => {
  try {
    const result = await marketplaceService.readUsdcAllowance({
      owner: req.params.ownerAddress,
    });
    res.json(result);
  } catch (error) {
    if (error.message === 'marketplace_allowance_request_invalid') {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

module.exports = router;
