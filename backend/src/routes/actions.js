'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { ethers } = require('ethers');
const { z } = require('zod');

const { requireAuth } = require('../middleware/auth');
const arcService = require('../services/arcService');
const walletService = require('../services/walletService');
const passkeyService = require('../services/passkeyService');
const actionAuthorizationService = require('../services/actionAuthorizationService');
const entryExecutionService = require('../services/entryExecutionService');
const ticketTransferExecutionService = require('../services/ticketTransferExecutionService');
const refundExecutionService = require('../services/refundExecutionService');

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

module.exports = router;
