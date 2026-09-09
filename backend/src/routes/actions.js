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
const externalEntryExecutionService = require('../services/externalEntryExecutionService');
const circleEntryExecutionService = require('../services/circleEntryExecutionService');
const {
  EXECUTION_MODES,
  assertExternalSessionAddress,
  assertCircleSession,
  isExternalActionMode,
} = require('../services/executionIdentityService');

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

const CIRCLE_VERIFY_LIMIT = 20;

// A `store` override exists only so tests can inject an isolated in-memory
// store per instance and prove independence; production never passes one,
// so each call keeps express-rate-limit's own default per-instance store.
function createCircleVerifyLimiter(store) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: CIRCLE_VERIFY_LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(store ? { store } : {}),
  });
}

const entryApprovalVerifyLimiter = createCircleVerifyLimiter();
const entryVerifyLimiter = createCircleVerifyLimiter();

const credentialSchema = z.object({}).passthrough();

const entryStartSchema = z.object({
  poolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  roundId: z.number().int().positive(),
  predictionPriceCents: z.number().int().positive().max(1_000_000_000_000),
  // Accepted only for a Circle session and used transiently to call Circle.
  // It is intentionally never persisted or returned.
  circleUserToken: z.string().min(16).optional(),
  circleRequestId: z.string().uuid().optional(),
});

const ticketTransferStartSchema = z.object({
  ticketAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenId: z.string().regex(/^[1-9][0-9]*$/),
  destinationAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

const finishSchema = z.object({
  actionId: z.string().uuid(),
  credential: credentialSchema.optional(),
});

const entryVerifySchema = z.object({
  actionId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const circleEntryVerifySchema = z.object({
  actionId: z.string().uuid(),
  circleUserToken: z.string().min(16),
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
  if (req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
    throw new Error('circle_wallet_not_configured');
  }
  if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
    if (!isExternalActionMode(action.payload.executionMode)) {
      throw new Error('wallet_execution_mode_mismatch');
    }
    return {
      actionId: action.id,
      action: action.payload,
      payloadHash: action.payloadHash,
      expiresInSeconds: action.expiresInSeconds,
      authorization: 'EXTERNAL_WALLET_SESSION',
      publicKey: null,
    };
  }

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

async function consumeActionAuthorization(req, actionId, credential, actionType) {
  if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
    const walletAddress = assertExternalSessionAddress(req.auth, req.auth.walletAddress);
    return actionAuthorizationService.consumeExternalAction(
      req.auth.userId,
      actionId,
      actionType,
      walletAddress,
    );
  }

  if (!credential) throw new Error('passkey_authentication_failed');
  const saved = await actionAuthorizationService.consumeWebAuthnChallenge(
    req.auth.userId,
    actionId,
  );
  await passkeyService.finishStepUpAuthentication(req.auth.userId, credential, saved);
  return actionAuthorizationService.consumeVerifiedAction(
    req.auth.userId,
    actionId,
    saved.payloadHash,
    actionType,
  );
}

router.post('/entry/start', startLimiter, async (req, res, next) => {
  try {
    const input = entryStartSchema.parse(req.body);
    const poolAddress = ethers.getAddress(input.poolAddress);

    const rounds = await arcService.getStandardRoundsState({ forceFresh: true });

    const pool = rounds.pools.find(
      (item) => item.poolAddress.toLowerCase() === poolAddress.toLowerCase(),
    );

    if (!pool || pool.round.roundId !== input.roundId || !pool.round.canEnter) {
      return res.status(409).json({ error: 'entry_round_not_available' });
    }

    if (req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      const { walletAddress, circleWalletId } = assertCircleSession(
        req.auth, req.auth.walletAddress, req.auth.circleWalletId,
      );
      if (!input.circleUserToken || !input.circleRequestId) {
        return res.status(409).json({ error: 'circle_reauthentication_required' });
      }
      const action = await actionAuthorizationService.createOrGetCircleEntryRequest({
        userId: req.auth.userId,
        walletAddress,
        circleWalletId,
        poolAddress,
        roundId: input.roundId,
        predictionPriceCents: input.predictionPriceCents,
        requestId: input.circleRequestId,
      });
      const challenge = await circleEntryExecutionService.startCircleEntry({
        action,
        auth: req.auth,
        userToken: input.circleUserToken,
      });
      return res.json({
        actionId: action.id,
        payloadHash: action.payloadHash,
        expiresInSeconds: action.expiresInSeconds,
        executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
        ...challenge,
      });
    }

    if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
      const walletAddress = assertExternalSessionAddress(req.auth, req.auth.walletAddress);
      const action = await actionAuthorizationService.createEntryRequest({
        userId: req.auth.userId,
        walletAddress,
        poolAddress,
        roundId: input.roundId,
        predictionPriceCents: input.predictionPriceCents,
        executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
      });
      const prepared = await externalEntryExecutionService.prepareExternalEntry(action.payload);
      await actionAuthorizationService.initializeExternalEntryState(
        req.auth.userId,
        action.id,
        walletAddress,
        prepared.step,
      );
      return res.json({
        actionId: action.id,
        action: action.payload,
        payloadHash: action.payloadHash,
        expiresInSeconds: action.expiresInSeconds,
        authorization: 'EXTERNAL_WALLET_SESSION',
        executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
        ...prepared,
      });
    }

    const wallet = await walletService.getWalletForUser(req.auth.userId);
    if (!wallet?.address) return res.status(404).json({ error: 'wallet_not_found' });
    const action = await actionAuthorizationService.createEntryRequest({
      userId: req.auth.userId,
      walletAddress: ethers.getAddress(wallet.address),
      poolAddress,
      roundId: input.roundId,
      predictionPriceCents: input.predictionPriceCents,
      executionMode: EXECUTION_MODES.BACKEND_WALLET,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/entry/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    if (req.auth.executionMode !== EXECUTION_MODES.BACKEND_WALLET) {
      return res.status(409).json({ error: 'entry_execution_mode_mismatch' });
    }
    const action = await consumeActionAuthorization(req, actionId, credential, 'ENTRY');

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

router.post('/entry/approval/verify', entryApprovalVerifyLimiter, async (req, res, next) => {
  try {
    if (req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      const { actionId, circleUserToken } = circleEntryVerifySchema.parse(req.body);
      assertCircleSession(req.auth, req.auth.walletAddress, req.auth.circleWalletId);
      const result = await circleEntryExecutionService.verifyCircleApproval({
        auth: req.auth, actionId, userToken: circleUserToken,
      });
      if (result.pending) return res.status(202).json({ pending: true, actionId, transactionObserved: Boolean(result.transactionObserved) });
      return res.json({
        confirmed: true,
        actionId,
        payloadHash: result.payloadHash,
        executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
        approvalTxHash: result.approvalTxHash,
        step: 'ENTRY_READY',
        challengeId: result.challengeId,
      });
    }
    const { actionId, txHash } = entryVerifySchema.parse(req.body);
    const walletAddress = assertExternalSessionAddress(req.auth, req.auth.walletAddress);
    const action = await actionAuthorizationService.getPendingExternalEntryAction(
      req.auth.userId,
      actionId,
      walletAddress,
      'APPROVAL_REQUIRED',
    );
    const result = await externalEntryExecutionService.verifyExternalApprovalReceipt(
      action.payload,
      txHash,
    );
    await actionAuthorizationService.completeExternalEntryApproval(
      req.auth.userId,
      actionId,
      walletAddress,
    );
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/entry/verify', entryVerifyLimiter, async (req, res, next) => {
  try {
    if (req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      const { actionId, circleUserToken } = circleEntryVerifySchema.parse(req.body);
      assertCircleSession(req.auth, req.auth.walletAddress, req.auth.circleWalletId);
      const verified = await circleEntryExecutionService.verifyCircleEntry({
        auth: req.auth, actionId, userToken: circleUserToken,
      });
      if (verified.pending) return res.status(202).json({ pending: true, actionId, transactionObserved: Boolean(verified.transactionObserved) });
      return res.json({
        confirmed: true,
        actionId,
        payloadHash: verified.action.payloadHash,
        executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
        result: verified.result,
      });
    }
    const { actionId, txHash } = entryVerifySchema.parse(req.body);
    const walletAddress = assertExternalSessionAddress(req.auth, req.auth.walletAddress);
    const action = await actionAuthorizationService.bindExternalEntryTransaction(
      req.auth.userId,
      actionId,
      walletAddress,
      txHash,
    );
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
    const result = await externalEntryExecutionService.verifyExternalEntryReceipt(
      action.payload,
      txHash,
    );
    await actionAuthorizationService.markExternalEntryReceiptVerified(
      req.auth.userId,
      actionId,
      walletAddress,
      txHash,
    );
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
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
      req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
        ? walletService.getWalletForUser(req.auth.userId)
        : null,
      arcService.getStandardRoundsState({ forceFresh: true }),
    ]);
    if (req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      throw new Error('circle_wallet_not_configured');
    }
    const executionMode = req.auth.executionMode;
    const walletAddress = executionMode === EXECUTION_MODES.EXTERNAL_WALLET
      ? assertExternalSessionAddress(req.auth, req.auth.walletAddress)
      : wallet?.address ? ethers.getAddress(wallet.address) : null;
    if (!walletAddress) return res.status(404).json({ error: 'wallet_not_found' });
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
      executionMode,
    });

    res.json(await startPasskeyStepUp(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/ticket-transfer/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, credential } = finishSchema.parse(req.body);
    const action = await consumeActionAuthorization(
      req,
      actionId,
      credential,
      'TRANSFER_TICKET',
    );

    if (isExternalActionMode(action.payload.executionMode)) {
      const transactionRequest = await ticketTransferExecutionService
        .buildExternalTransferTransactionRequest(action.payload);
      return res.json({
        confirmed: true,
        actionId,
        payloadHash: action.payloadHash,
        executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
        transactionRequest,
      });
    }

    const result = await ticketTransferExecutionService.executeTicketTransfer(
      req.auth.userId,
      action.payload,
    );

    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: EXECUTION_MODES.BACKEND_WALLET,
      result,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/ticket-transfer/verify', finishLimiter, async (req, res, next) => {
  try {
    const { actionId, txHash } = entryVerifySchema.parse(req.body);
    const walletAddress = assertExternalSessionAddress(req.auth, req.auth.walletAddress);
    const action = await actionAuthorizationService.getConsumedAction(
      req.auth.userId,
      actionId,
      'TRANSFER_TICKET',
    );
    if (!isExternalActionMode(action.payload.executionMode)) {
      return res.status(409).json({ error: 'transfer_execution_mode_mismatch' });
    }
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
    const result = await ticketTransferExecutionService.verifyExternalTransferReceipt(
      action.payload,
      txHash,
    );
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
      walletAddress,
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
      req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
        ? walletService.getWalletForUser(req.auth.userId)
        : null,
      arcService.readRefundAuthorizationState({
        poolAddress,
        ticketAddress,
        tokenId: input.tokenId,
        roundId: input.roundId,
      }),
    ]);

    if (state.roundStatus !== 'CANCELLED') {
      return res.status(409).json({ error: 'refund_round_not_cancelled' });
    }
    if (state.isRefunded) {
      return res.status(409).json({ error: 'refund_already_refunded' });
    }

    const backendWalletAddress = wallet?.address ? ethers.getAddress(wallet.address) : null;
    const ownerAddress = req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET
      ? assertExternalSessionAddress(req.auth, req.auth.walletAddress)
      : req.auth.ownerAddress && ethers.isAddress(req.auth.ownerAddress)
        ? ethers.getAddress(req.auth.ownerAddress)
        : null;

    let executionMode;
    let refundWalletAddress;

    if (backendWalletAddress && state.currentOwner.toLowerCase() === backendWalletAddress.toLowerCase()) {
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
    const action = await consumeActionAuthorization(
      req,
      actionId,
      credential,
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
    if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
      assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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
      req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
        ? walletService.getWalletForUser(req.auth.userId)
        : null,
      arcService.readClaimAuthorizationState({
        poolAddress,
        ticketAddress,
        tokenId: input.tokenId,
        roundId: input.roundId,
      }),
    ]);

    if (state.roundStatus !== 'SETTLED') {
      return res.status(409).json({ error: 'claim_round_not_settled' });
    }
    if (state.isClaimed) {
      return res.status(409).json({ error: 'claim_already_claimed' });
    }
    if (BigInt(state.claimableRaw) <= 0n) {
      return res.status(409).json({ error: 'claim_nothing_to_claim' });
    }

    const backendWalletAddress = wallet?.address ? ethers.getAddress(wallet.address) : null;
    const ownerAddress = req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET
      ? assertExternalSessionAddress(req.auth, req.auth.walletAddress)
      : req.auth.ownerAddress && ethers.isAddress(req.auth.ownerAddress)
        ? ethers.getAddress(req.auth.ownerAddress)
        : null;

    let executionMode;
    let claimWalletAddress;

    if (backendWalletAddress && state.currentOwner.toLowerCase() === backendWalletAddress.toLowerCase()) {
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
    const action = await consumeActionAuthorization(
      req,
      actionId,
      credential,
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
    if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
      assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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
  if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
    return assertExternalSessionAddress(req.auth, req.auth.walletAddress);
  }
  return req.auth.ownerAddress && ethers.isAddress(req.auth.ownerAddress)
    ? ethers.getAddress(req.auth.ownerAddress)
    : null;
}

router.post('/marketplace-list/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceListStartSchema.parse(req.body);
    const ticketAddress = ethers.getAddress(input.ticketAddress);

    const [wallet, approval, activeListing] = await Promise.all([
      req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
        ? walletService.getWalletForUser(req.auth.userId)
        : null,
      marketplaceService.readTicketApprovalState({ ticketAddress, tokenId: input.tokenId }),
      // Direct, uncached chain read -- never the board cache -- so a ticket
      // that already has an active listing is rejected before any action
      // authorization or WebAuthn challenge is created, not only at the
      // final list() revert.
      marketplaceService.readActiveListingForTicket({ ticketAddress, tokenId: input.tokenId }),
    ]);

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

    const backendWalletAddress = wallet?.address ? ethers.getAddress(wallet.address) : null;
    const ownerAddress = resolveOwnerAddress(req);

    let executionMode;
    let sellerWalletAddress;

    if (backendWalletAddress && approval.owner.toLowerCase() === backendWalletAddress.toLowerCase()) {
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
    const action = await consumeActionAuthorization(
      req,
      actionId,
      credential,
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
    if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
      assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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
      req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
        ? walletService.getWalletForUser(req.auth.userId)
        : null,
      marketplaceService.readMarketplaceListing(listingId),
    ]);

    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    if (listing.state === 'EXPIRED') {
      return res.status(409).json({ error: 'marketplace_trading_window_closed' });
    }

    const backendWalletAddress = wallet?.address ? ethers.getAddress(wallet.address) : null;
    const ownerAddress = resolveOwnerAddress(req);

    let executionMode;
    let sellerWalletAddress;

    const sellerIsBackend = Boolean(
      backendWalletAddress && listing.seller.toLowerCase() === backendWalletAddress.toLowerCase(),
    );
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
    const action = await consumeActionAuthorization(
      req,
      actionId,
      credential,
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
    if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
      assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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
      req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
        ? walletService.getWalletForUser(req.auth.userId)
        : null,
      marketplaceService.readMarketplaceListing(listingId),
    ]);

    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    if (listing.state === 'EXPIRED') {
      return res.status(409).json({ error: 'marketplace_trading_window_closed' });
    }

    const backendWalletAddress = wallet?.address ? ethers.getAddress(wallet.address) : null;
    const ownerAddress = resolveOwnerAddress(req);

    let executionMode;
    let sellerWalletAddress;

    if (backendWalletAddress && listing.seller.toLowerCase() === backendWalletAddress.toLowerCase()) {
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
    const action = await consumeActionAuthorization(
      req,
      actionId,
      credential,
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
    if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
      assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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
      req.auth.executionMode === EXECUTION_MODES.BACKEND_WALLET
        ? walletService.getWalletForUser(req.auth.userId)
        : null,
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

    if (
      req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET &&
      input.executionMode !== 'EXTERNAL_OWNER'
    ) {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
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
    const action = await consumeActionAuthorization(
      req,
      actionId,
      credential,
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
    if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
      assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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

// Test-only: lets the behavioral regression suite prove the two Circle
// verify limiters are independent instances without exercising real HTTP.
// Never read by production code.
router.__circleVerifyLimitersForTests = {
  createCircleVerifyLimiter,
  entryApprovalVerifyLimiter,
  entryVerifyLimiter,
};
