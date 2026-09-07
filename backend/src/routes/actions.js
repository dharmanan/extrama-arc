'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { ethers } = require('ethers');
const { z } = require('zod');

const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const arcService = require('../services/arcService');
const walletService = require('../services/walletService');
const passkeyService = require('../services/passkeyService');
const actionAuthorizationService = require('../services/actionAuthorizationService');
const entryExecutionService = require('../services/entryExecutionService');
const ticketTransferExecutionService = require('../services/ticketTransferExecutionService');
const refundExecutionService = require('../services/refundExecutionService');
const claimExecutionService = require('../services/claimExecutionService');
const marketplaceService = require('../services/marketplaceService');
const marketplaceExecutionService = require('../services/marketplaceExecutionService');

const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const finishLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

const credentialSchema = z.object({}).passthrough();

const entryStartSchema = z.object({
  poolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  roundId: z.number().int().positive(),
  predictionPriceCents: z.number().int().positive().max(1_000_000_000_000),
});

const ticketTransferStartSchema = z.object({
  ticketAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenId: z.string().regex(/^[1-9][0-9]*$/),
  destinationAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const finishSchema = z.object({
  actionId: z.string().uuid(),
  credential: credentialSchema,
});

const refundStartSchema = z.object({
  poolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  ticketAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenId: z.string().regex(/^[1-9][0-9]*$/),
  roundId: z.number().int().positive(),
});

const refundVerifySchema = z.object({
  actionId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const claimStartSchema = z.object({
  poolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  ticketAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenId: z.string().regex(/^[1-9][0-9]*$/),
  roundId: z.number().int().positive(),
});

const claimVerifySchema = z.object({
  actionId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const marketplaceListStartSchema = z.object({
  ticketAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenId: z.string().regex(/^[1-9][0-9]*$/),
  askUsdcRaw: z.string().regex(/^[1-9][0-9]*$/),
});

const marketplaceUpdatePriceStartSchema = z.object({
  listingId: z.string().regex(/^[1-9][0-9]*$/),
  newAskUsdcRaw: z.string().regex(/^[1-9][0-9]*$/),
});

const marketplaceCancelStartSchema = z.object({
  listingId: z.string().regex(/^[1-9][0-9]*$/),
});

const marketplaceBuyStartSchema = z.object({
  listingId: z.string().regex(/^[1-9][0-9]*$/),
  expectedAskUsdcRaw: z.string().regex(/^[1-9][0-9]*$/),
  executionMode: z.enum(['BACKEND_WALLET', 'EXTERNAL_OWNER']),
});

const marketplaceVerifySchema = z.object({
  actionId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

router.use(requireAuth);

async function startPasskeyStepUp(req, action) {
  const { options, context } = await passkeyService.startStepUpAuthentication(
    req.auth.userId,
    req.get('x-extrema-origin') || req.get('origin'),
  );

  await actionAuthorizationService.attachWebAuthnChallenge(
    req.auth.userId,
    action.id,
    options.challenge,
    context,
  );

  return {
    actionId: action.id,
    action: action.payload,
    payloadHash: action.payloadHash,
    expiresInSeconds: action.expiresInSeconds,
    publicKey: options,
  };
}

router.post('/entry/start', startLimiter, async (req, res, next) => {
  try {
    const input = entryStartSchema.parse(req.body);
    const poolAddress = ethers.getAddress(input.poolAddress);

    const [wallet, rounds] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      arcService.getStandardRoundsState({ forceFresh: true }),
    ]);

    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const pool = rounds.pools.find(
      (item) => item.poolAddress.toLowerCase() === poolAddress.toLowerCase(),
    );

    if (!pool || pool.round.roundId !== input.roundId || !pool.round.canEnter) {
      return res.status(409).json({ error: 'entry_round_not_available' });
    }

    const action = await actionAuthorizationService.createEntryRequest({
      userId: req.auth.userId,
      walletAddress: ethers.getAddress(wallet.address),
      poolAddress,
      roundId: input.roundId,
      predictionPriceCents: input.predictionPriceCents,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/entry/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(
      req.auth.userId,
      actionId,
    );

    await passkeyService.finishStepUpAuthentication(
      req.auth.userId,
      credential,
      saved,
    );

    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'ENTRY',
    );

    const result = await entryExecutionService.executeEntry(
      req.auth.userId,
      action.payload,
    );

    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/ticket-transfer/start', startLimiter, async (req, res, next) => {
  try {
    const input = ticketTransferStartSchema.parse(req.body);
    const ticketAddress = ethers.getAddress(input.ticketAddress);
    const destinationAddress = ethers.getAddress(input.destinationAddress);

    const [wallet, rounds] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      arcService.getStandardRoundsState({ forceFresh: true }),
    ]);

    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    const walletAddress = ethers.getAddress(wallet.address);
    if (destinationAddress.toLowerCase() === walletAddress.toLowerCase()) {
      return res.status(409).json({ error: 'transfer_destination_same' });
    }

    const supportedCollection = rounds.pools.some(
      (item) => item.ticketAddress.toLowerCase() === ticketAddress.toLowerCase(),
    );
    if (!supportedCollection) {
      return res.status(409).json({ error: 'transfer_ticket_not_supported' });
    }

    const ticket = new ethers.Contract(
      ticketAddress,
      ['function ownerOf(uint256 tokenId) view returns (address)'],
      arcService.getArcProvider(),
    );

    let currentOwner;
    try {
      currentOwner = ethers.getAddress(await ticket.ownerOf(BigInt(input.tokenId)));
    } catch {
      return res.status(404).json({ error: 'transfer_ticket_not_found' });
    }

    if (currentOwner.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(409).json({ error: 'transfer_not_ticket_owner' });
    }

    const action = await actionAuthorizationService.createTicketTransferRequest({
      userId: req.auth.userId,
      walletAddress,
      ticketAddress,
      tokenId: input.tokenId,
      destinationAddress,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/ticket-transfer/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(
      req.auth.userId,
      actionId,
    );

    await passkeyService.finishStepUpAuthentication(
      req.auth.userId,
      credential,
      saved,
    );

    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'TRANSFER_TICKET',
    );

    const result = await ticketTransferExecutionService.executeTicketTransfer(
      req.auth.userId,
      action.payload,
    );

    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/refund/start', startLimiter, async (req, res, next) => {
  try {
    const input = refundStartSchema.parse(req.body);
    const poolAddress = ethers.getAddress(input.poolAddress);
    const ticketAddress = ethers.getAddress(input.ticketAddress);

    const [wallet, state] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      arcService.readRefundAuthorizationState({
        poolAddress,
        ticketAddress,
        tokenId: input.tokenId,
        roundId: input.roundId,
      }),
    ]);

    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    if (state.roundStatus !== 'CANCELLED') {
      return res.status(409).json({ error: 'refund_round_not_cancelled' });
    }
    if (state.isRefunded) {
      return res.status(409).json({ error: 'refund_already_refunded' });
    }

    const backendWalletAddress = ethers.getAddress(wallet.address);
    const ownerAddress = req.auth.ownerAddress && ethers.isAddress(req.auth.ownerAddress)
      ? ethers.getAddress(req.auth.ownerAddress)
      : null;

    let executionMode;
    let refundWalletAddress;

    if (state.currentOwner.toLowerCase() === backendWalletAddress.toLowerCase()) {
      executionMode = 'BACKEND_WALLET';
      refundWalletAddress = backendWalletAddress;
    } else if (ownerAddress && state.currentOwner.toLowerCase() === ownerAddress.toLowerCase()) {
      executionMode = 'EXTERNAL_OWNER';
      refundWalletAddress = ownerAddress;
    } else {
      return res.status(403).json({ error: 'refund_not_ticket_owner' });
    }

    const action = await actionAuthorizationService.createRefundRequest({
      userId: req.auth.userId,
      walletAddress: refundWalletAddress,
      poolAddress: state.poolAddress,
      ticketAddress: state.ticketAddress,
      tokenId: state.tokenId,
      roundId: state.roundId,
      currentOwner: state.currentOwner,
      executionMode,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/refund/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(
      req.auth.userId,
      actionId,
    );

    await passkeyService.finishStepUpAuthentication(
      req.auth.userId,
      credential,
      saved,
    );

    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'REFUND_TICKET',
    );

    if (action.payload.executionMode === 'BACKEND_WALLET') {
      const result = await refundExecutionService.executeBackendRefund(
        req.auth.userId,
        action.payload,
      );

      return res.json({
        confirmed: true,
        actionId,
        payloadHash: action.payloadHash,
        executionMode: 'BACKEND_WALLET',
        result,
      });
    }

    const transactionRequest = await refundExecutionService.buildExternalRefundTransactionRequest(
      action.payload,
    );

    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      transactionRequest,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/refund/verify', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, txHash } = refundVerifySchema.parse(req.body);

    const action = await actionAuthorizationService.getConsumedAction(
      req.auth.userId,
      actionId,
      'REFUND_TICKET',
    );

    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'refund_execution_mode_mismatch' });
    }

    const result = await refundExecutionService.verifyExternalRefundReceipt(
      action.payload,
      txHash,
    );

    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      result,
    });
  } catch (error) {
    next(error);
  }
});


router.post('/claim/start', startLimiter, async (req, res, next) => {
  try {
    const input = claimStartSchema.parse(req.body);
    const poolAddress = ethers.getAddress(input.poolAddress);
    const ticketAddress = ethers.getAddress(input.ticketAddress);

    const [wallet, state] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      arcService.readClaimAuthorizationState({
        poolAddress,
        ticketAddress,
        tokenId: input.tokenId,
        roundId: input.roundId,
      }),
    ]);

    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    if (state.roundStatus !== 'SETTLED') {
      return res.status(409).json({ error: 'claim_round_not_settled' });
    }
    if (state.isClaimed) {
      return res.status(409).json({ error: 'claim_already_claimed' });
    }
    if (BigInt(state.claimableRaw) <= 0n) {
      return res.status(409).json({ error: 'claim_nothing_to_claim' });
    }

    const backendWalletAddress = ethers.getAddress(wallet.address);
    const ownerAddress = req.auth.ownerAddress && ethers.isAddress(req.auth.ownerAddress)
      ? ethers.getAddress(req.auth.ownerAddress)
      : null;

    let executionMode;
    let claimWalletAddress;

    if (state.currentOwner.toLowerCase() === backendWalletAddress.toLowerCase()) {
      executionMode = 'BACKEND_WALLET';
      claimWalletAddress = backendWalletAddress;
    } else if (ownerAddress && state.currentOwner.toLowerCase() === ownerAddress.toLowerCase()) {
      executionMode = 'EXTERNAL_OWNER';
      claimWalletAddress = ownerAddress;
    } else {
      return res.status(403).json({ error: 'claim_not_ticket_owner' });
    }

    const action = await actionAuthorizationService.createClaimRequest({
      userId: req.auth.userId,
      walletAddress: claimWalletAddress,
      poolAddress: state.poolAddress,
      ticketAddress: state.ticketAddress,
      tokenId: state.tokenId,
      roundId: state.roundId,
      currentOwner: state.currentOwner,
      amountRaw: state.claimableRaw,
      executionMode,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/claim/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(
      req.auth.userId,
      actionId,
    );

    await passkeyService.finishStepUpAuthentication(
      req.auth.userId,
      credential,
      saved,
    );

    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'CLAIM_REWARD',
    );

    if (action.payload.executionMode === 'BACKEND_WALLET') {
      const result = await claimExecutionService.executeBackendClaim(
        req.auth.userId,
        action.payload,
      );

      return res.json({
        confirmed: true,
        actionId,
        payloadHash: action.payloadHash,
        executionMode: 'BACKEND_WALLET',
        result,
      });
    }

    const transactionRequest = await claimExecutionService.buildExternalClaimTransactionRequest(
      action.payload,
    );

    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      transactionRequest,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/claim/verify', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, txHash } = claimVerifySchema.parse(req.body);

    const action = await actionAuthorizationService.getConsumedAction(
      req.auth.userId,
      actionId,
      'CLAIM_REWARD',
    );

    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'claim_execution_mode_mismatch' });
    }

    const result = await claimExecutionService.verifyExternalClaimReceipt(
      action.payload,
      txHash,
    );

    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      result,
    });
  } catch (error) {
    next(error);
  }
});

function resolveOwnerAddress(req) {
  return req.auth.ownerAddress && ethers.isAddress(req.auth.ownerAddress)
    ? ethers.getAddress(req.auth.ownerAddress)
    : null;
}

router.post('/marketplace-list/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceListStartSchema.parse(req.body);
    const ticketAddress = ethers.getAddress(input.ticketAddress);

    const [wallet, approval, activeListing] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      marketplaceService.readTicketApprovalState({ ticketAddress, tokenId: input.tokenId }),
      // Direct, uncached chain read -- never the board cache -- so a ticket
      // that already has an active listing is rejected before any action
      // authorization or WebAuthn challenge is created, not only at the
      // final list() revert.
      marketplaceService.readActiveListingForTicket({ ticketAddress, tokenId: input.tokenId }),
    ]);

    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    if (activeListing.activeListingId) {
      return res.status(409).json({ error: 'marketplace_already_listed' });
    }

    const provider = arcService.getArcProvider();
    const { round } = await marketplaceExecutionService.resolveRoundForTicket(
      ticketAddress,
      input.tokenId,
      provider,
    );
    try {
      marketplaceExecutionService.requireTradable(round);
    } catch (error) {
      return res.status(409).json({ error: error.message });
    }

    const backendWalletAddress = ethers.getAddress(wallet.address);
    const ownerAddress = resolveOwnerAddress(req);

    let executionMode;
    let sellerWalletAddress;

    if (approval.owner.toLowerCase() === backendWalletAddress.toLowerCase()) {
      executionMode = 'BACKEND_WALLET';
      sellerWalletAddress = backendWalletAddress;
    } else if (ownerAddress && approval.owner.toLowerCase() === ownerAddress.toLowerCase()) {
      executionMode = 'EXTERNAL_OWNER';
      sellerWalletAddress = ownerAddress;
      // Step 1 (the exact per-token approve) must already have happened as
      // its own wallet-signed transaction before this request is made.
      if (!approval.isApproved) {
        return res.status(409).json({ error: 'marketplace_token_not_approved' });
      }
    } else {
      return res.status(403).json({ error: 'marketplace_not_ticket_owner' });
    }

    const action = await actionAuthorizationService.createMarketplaceListRequest({
      userId: req.auth.userId,
      walletAddress: sellerWalletAddress,
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      ticketAddress,
      tokenId: input.tokenId,
      askUsdcRaw: input.askUsdcRaw,
      executionMode,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-list/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(req.auth.userId, actionId);
    await passkeyService.finishStepUpAuthentication(req.auth.userId, credential, saved);
    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'MARKETPLACE_LIST',
    );

    if (action.payload.executionMode === 'BACKEND_WALLET') {
      const result = await marketplaceExecutionService.executeBackendList(req.auth.userId, action.payload);
      return res.json({
        confirmed: true,
        actionId,
        payloadHash: action.payloadHash,
        executionMode: 'BACKEND_WALLET',
        result,
      });
    }

    const transactionRequest = await marketplaceExecutionService.buildExternalListTransactionRequest(
      action.payload,
    );
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      transactionRequest,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-list/verify', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, txHash } = marketplaceVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(req.auth.userId, actionId, 'MARKETPLACE_LIST');
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    const result = await marketplaceExecutionService.verifyExternalListReceipt(action.payload, txHash);
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-update-price/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceUpdatePriceStartSchema.parse(req.body);
    const listingId = Number(input.listingId);

    const [wallet, { listing }] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      marketplaceService.readMarketplaceListing(listingId),
    ]);

    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }
    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    if (listing.state === 'EXPIRED') {
      return res.status(409).json({ error: 'marketplace_trading_window_closed' });
    }

    const backendWalletAddress = ethers.getAddress(wallet.address);
    const ownerAddress = resolveOwnerAddress(req);

    let executionMode;
    let sellerWalletAddress;

    const sellerIsBackend = listing.seller.toLowerCase() === backendWalletAddress.toLowerCase();
    const sellerIsOwner = ownerAddress && listing.seller.toLowerCase() === ownerAddress.toLowerCase();

    if (sellerIsBackend) {
      executionMode = 'BACKEND_WALLET';
      sellerWalletAddress = backendWalletAddress;
    } else if (sellerIsOwner) {
      executionMode = 'EXTERNAL_OWNER';
      sellerWalletAddress = ownerAddress;
      if (!listing.isApproved) {
        return res.status(409).json({ error: 'marketplace_token_not_approved' });
      }
    } else {
      return res.status(403).json({ error: 'marketplace_not_listing_seller' });
    }

    const action = await actionAuthorizationService.createMarketplaceUpdatePriceRequest({
      userId: req.auth.userId,
      walletAddress: sellerWalletAddress,
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      listingId: input.listingId,
      ticketAddress: listing.ticketAddress,
      tokenId: listing.tokenId,
      newAskUsdcRaw: input.newAskUsdcRaw,
      executionMode,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-update-price/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(req.auth.userId, actionId);
    await passkeyService.finishStepUpAuthentication(req.auth.userId, credential, saved);
    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'MARKETPLACE_UPDATE_PRICE',
    );

    if (action.payload.executionMode === 'BACKEND_WALLET') {
      const result = await marketplaceExecutionService.executeBackendUpdatePrice(req.auth.userId, action.payload);
      return res.json({
        confirmed: true,
        actionId,
        payloadHash: action.payloadHash,
        executionMode: 'BACKEND_WALLET',
        result,
      });
    }

    const transactionRequest = await marketplaceExecutionService.buildExternalUpdatePriceTransactionRequest(
      action.payload,
    );
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      transactionRequest,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-update-price/verify', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, txHash } = marketplaceVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(
      req.auth.userId,
      actionId,
      'MARKETPLACE_UPDATE_PRICE',
    );
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    const result = await marketplaceExecutionService.verifyExternalUpdatePriceReceipt(action.payload, txHash);
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-cancel/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceCancelStartSchema.parse(req.body);
    const listingId = Number(input.listingId);

    const [wallet, { listing }] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      marketplaceService.readMarketplaceListing(listingId),
    ]);

    if (!wallet?.address) {
      return res.status(404).json({ error: 'wallet_not_found' });
    }
    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    if (listing.state === 'EXPIRED') {
      return res.status(409).json({ error: 'marketplace_trading_window_closed' });
    }

    const backendWalletAddress = ethers.getAddress(wallet.address);
    const ownerAddress = resolveOwnerAddress(req);

    let executionMode;
    let sellerWalletAddress;

    if (listing.seller.toLowerCase() === backendWalletAddress.toLowerCase()) {
      executionMode = 'BACKEND_WALLET';
      sellerWalletAddress = backendWalletAddress;
    } else if (ownerAddress && listing.seller.toLowerCase() === ownerAddress.toLowerCase()) {
      executionMode = 'EXTERNAL_OWNER';
      sellerWalletAddress = ownerAddress;
    } else {
      return res.status(403).json({ error: 'marketplace_not_listing_seller' });
    }

    // Cancel never requires approval, matching the contract exactly.
    const action = await actionAuthorizationService.createMarketplaceCancelRequest({
      userId: req.auth.userId,
      walletAddress: sellerWalletAddress,
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      listingId: input.listingId,
      ticketAddress: listing.ticketAddress,
      tokenId: listing.tokenId,
      executionMode,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-cancel/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(req.auth.userId, actionId);
    await passkeyService.finishStepUpAuthentication(req.auth.userId, credential, saved);
    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'MARKETPLACE_CANCEL',
    );

    if (action.payload.executionMode === 'BACKEND_WALLET') {
      const result = await marketplaceExecutionService.executeBackendCancel(req.auth.userId, action.payload);
      return res.json({
        confirmed: true,
        actionId,
        payloadHash: action.payloadHash,
        executionMode: 'BACKEND_WALLET',
        result,
      });
    }

    const transactionRequest = await marketplaceExecutionService.buildExternalCancelTransactionRequest(
      action.payload,
    );
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      transactionRequest,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-cancel/verify', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, txHash } = marketplaceVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(req.auth.userId, actionId, 'MARKETPLACE_CANCEL');
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    const result = await marketplaceExecutionService.verifyExternalCancelReceipt(action.payload, txHash);
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-buy/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceBuyStartSchema.parse(req.body);
    const listingId = Number(input.listingId);

    const [wallet, { listing }] = await Promise.all([
      walletService.getWalletForUser(req.auth.userId),
      marketplaceService.readMarketplaceListing(listingId),
    ]);

    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    // Refetch-before-confirm lives on the client; this is the authoritative
    // server-side re-check of the same fact, immediately before creating a
    // passkey-authorized request for it.
    if (listing.askUsdcRaw !== input.expectedAskUsdcRaw) {
      return res.status(409).json({ error: 'marketplace_price_changed' });
    }
    if (!listing.isBuyable) {
      return res.status(409).json({
        error: listing.state === 'EXPIRED' ? 'marketplace_trading_window_closed' : 'marketplace_listing_not_buyable',
      });
    }

    // Buying has no pre-existing asset to infer a wallet from -- the buyer
    // explicitly chooses which of their two wallets to pay from.
    let buyerWalletAddress;
    if (input.executionMode === 'BACKEND_WALLET') {
      if (!wallet?.address) return res.status(404).json({ error: 'wallet_not_found' });
      buyerWalletAddress = ethers.getAddress(wallet.address);
    } else {
      const ownerAddress = resolveOwnerAddress(req);
      if (!ownerAddress) {
        return res.status(409).json({ error: 'marketplace_owner_wallet_not_connected' });
      }
      buyerWalletAddress = ownerAddress;
    }

    if (listing.seller.toLowerCase() === buyerWalletAddress.toLowerCase()) {
      return res.status(409).json({ error: 'marketplace_buyer_is_seller' });
    }

    const action = await actionAuthorizationService.createMarketplaceBuyRequest({
      userId: req.auth.userId,
      walletAddress: buyerWalletAddress,
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      listingId: input.listingId,
      ticketAddress: listing.ticketAddress,
      tokenId: listing.tokenId,
      sellerAddress: listing.seller,
      expectedAskUsdcRaw: input.expectedAskUsdcRaw,
      executionMode: input.executionMode,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-buy/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const saved = await actionAuthorizationService.consumeWebAuthnChallenge(req.auth.userId, actionId);
    await passkeyService.finishStepUpAuthentication(req.auth.userId, credential, saved);
    const action = await actionAuthorizationService.consumeVerifiedAction(
      req.auth.userId,
      actionId,
      saved.payloadHash,
      'MARKETPLACE_BUY',
    );

    if (action.payload.executionMode === 'BACKEND_WALLET') {
      const result = await marketplaceExecutionService.executeBackendBuy(req.auth.userId, action.payload);
      return res.json({
        confirmed: true,
        actionId,
        payloadHash: action.payloadHash,
        executionMode: 'BACKEND_WALLET',
        result,
      });
    }

    const transactionRequest = await marketplaceExecutionService.buildExternalBuyTransactionRequest(action.payload);
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      transactionRequest,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-buy/verify', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, txHash } = marketplaceVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(req.auth.userId, actionId, 'MARKETPLACE_BUY');
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    const result = await marketplaceExecutionService.verifyExternalBuyReceipt(action.payload, txHash);
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: 'EXTERNAL_OWNER',
      result,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
