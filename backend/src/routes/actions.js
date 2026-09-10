'use strict';

// Financial action routes for the two human execution modes:
//
//   EXTERNAL_WALLET     start then finish (a single use, session bound
//                       authorization that returns the exact transaction
//                       request) then the connected wallet signs then verify.
//   CIRCLE_USER_WALLET  start (returns a Circle hosted challenge) then the user
//                       approves inside Circle, then (for list and buy)
//                       approval/verify, then verify.
//
// SYSTEM_SEED_WALLET agents never reach these routes: requireAuth only admits
// EXTERNAL_WALLET and CIRCLE_USER_WALLET sessions, and each route explicitly
// dispatches on exactly those two modes.

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { ethers } = require('ethers');
const { z } = require('zod');

const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const arcService = require('../services/arcService');
const actionAuthorizationService = require('../services/actionAuthorizationService');
const ticketTransferExecutionService = require('../services/ticketTransferExecutionService');
const refundExecutionService = require('../services/refundExecutionService');
const claimExecutionService = require('../services/claimExecutionService');
const marketplaceService = require('../services/marketplaceService');
const marketplaceExecutionService = require('../services/marketplaceExecutionService');
const externalEntryExecutionService = require('../services/externalEntryExecutionService');
const circleEntryExecutionService = require('../services/circleEntryExecutionService');
const circleActionExecutionService = require('../services/circleActionExecutionService');
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
// Circle lifecycle actions poll their own verifiers while a hosted challenge
// is indexed. Approval and action verification keep independent quotas, the
// same split as ENTRY, so one phase can never starve the other.
const circleActionApprovalVerifyLimiter = createCircleVerifyLimiter();
const circleActionVerifyLimiter = createCircleVerifyLimiter();

// Connected wallet verification keeps exactly its existing shared limiter;
// only Circle polling uses the dedicated per phase limiters above.
function verifyLimiterFor(circleLimiter) {
  return (req, res, next) => (
    req.auth?.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET
      ? circleLimiter(req, res, next)
      : finishLimiter(req, res, next)
  );
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const positiveIntegerString = z.string().regex(/^[1-9][0-9]*$/);

// Accepted only for a Circle session and used transiently to call Circle.
// Neither value is ever persisted or returned.
const circleStartFields = {
  circleUserToken: z.string().min(16).optional(),
  circleRequestId: z.string().uuid().optional(),
};

const entryStartSchema = z.object({
  poolAddress: address,
  roundId: z.number().int().positive(),
  predictionPriceCents: z.number().int().positive().max(1_000_000_000_000),
  ...circleStartFields,
});

const ticketTransferStartSchema = z.object({
  ticketAddress: address,
  tokenId: positiveIntegerString,
  destinationAddress: address,
  ...circleStartFields,
});

const finishSchema = z.object({
  actionId: z.string().uuid(),
});

const txVerifySchema = z.object({
  actionId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const circleVerifySchema = z.object({
  actionId: z.string().uuid(),
  circleUserToken: z.string().min(16),
});

const ticketRoundStartSchema = z.object({
  poolAddress: address,
  ticketAddress: address,
  tokenId: positiveIntegerString,
  roundId: z.number().int().positive(),
  ...circleStartFields,
});

const marketplaceListStartSchema = z.object({
  ticketAddress: address,
  tokenId: positiveIntegerString,
  askUsdcRaw: positiveIntegerString,
  ...circleStartFields,
});

const marketplaceUpdatePriceStartSchema = z.object({
  listingId: positiveIntegerString,
  newAskUsdcRaw: positiveIntegerString,
  ...circleStartFields,
});

const marketplaceCancelStartSchema = z.object({
  listingId: positiveIntegerString,
  ...circleStartFields,
});

// The buyer's execution mode comes only from the authenticated session.
const marketplaceBuyStartSchema = z.object({
  listingId: positiveIntegerString,
  expectedAskUsdcRaw: positiveIntegerString,
  ...circleStartFields,
});

router.use(requireAuth);

// ---------------------------------------------------------------------------
// Session mode dispatch
// ---------------------------------------------------------------------------

function isCircleSession(req) {
  return req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET;
}

// The acting wallet is always the one bound to the authenticated session. A
// wallet address or Circle wallet ID supplied by the browser is never used.
function sessionWallet(req) {
  if (req.auth.executionMode === EXECUTION_MODES.EXTERNAL_WALLET) {
    return {
      mode: EXECUTION_MODES.EXTERNAL_WALLET,
      walletAddress: assertExternalSessionAddress(req.auth, req.auth.walletAddress),
      circleWalletId: null,
    };
  }
  if (req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
    const identity = assertCircleSession(req.auth, req.auth.walletAddress, req.auth.circleWalletId);
    return {
      mode: EXECUTION_MODES.CIRCLE_USER_WALLET,
      walletAddress: identity.walletAddress,
      circleWalletId: identity.circleWalletId,
    };
  }
  throw new Error('wallet_execution_mode_invalid');
}

function requireCircleStartCredentials(input, res) {
  if (!input.circleUserToken || !input.circleRequestId) {
    res.status(409).json({ error: 'circle_reauthentication_required' });
    return false;
  }
  return true;
}

// Connected wallet authorization: the action is bound to the session wallet
// and consumed exactly once at /finish. The connected wallet itself approves
// every transaction; no other credential is involved.
function externalActionAuthorization(req, action) {
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
    executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
  };
}

async function consumeExternalAuthorization(req, actionId, actionType) {
  if (req.auth.executionMode !== EXECUTION_MODES.EXTERNAL_WALLET) {
    throw new Error('wallet_execution_mode_mismatch');
  }
  const walletAddress = assertExternalSessionAddress(req.auth, req.auth.walletAddress);
  return actionAuthorizationService.consumeExternalAction(
    req.auth.userId,
    actionId,
    actionType,
    walletAddress,
  );
}

async function startCircleFinancialAction(req, res, input, actionType, wallet, params) {
  const action = await actionAuthorizationService.createOrGetCircleActionRequest({
    ...params,
    actionType,
    userId: req.auth.userId,
    walletAddress: wallet.walletAddress,
    circleWalletId: wallet.circleWalletId,
    requestId: input.circleRequestId,
  });
  const challenge = await circleActionExecutionService.startCircleAction({
    actionType,
    action,
    auth: req.auth,
    userToken: input.circleUserToken,
  });
  return res.json({
    actionId: action.id,
    action: action.payload,
    payloadHash: action.payloadHash,
    expiresInSeconds: action.expiresInSeconds,
    executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    ...challenge,
  });
}

async function verifyCircleFinancialAction(req, res, actionType) {
  const { actionId, circleUserToken } = circleVerifySchema.parse(req.body);
  assertCircleSession(req.auth, req.auth.walletAddress, req.auth.circleWalletId);
  const verified = await circleActionExecutionService.verifyCircleAction({
    actionType, auth: req.auth, actionId, userToken: circleUserToken,
  });
  if (verified.pending) {
    return res.status(202).json({ pending: true, actionId, transactionObserved: Boolean(verified.transactionObserved) });
  }
  return res.json({
    confirmed: true,
    actionId,
    payloadHash: verified.action.payloadHash,
    executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    result: verified.result,
  });
}

async function verifyCircleFinancialApproval(req, res, actionType) {
  const { actionId, circleUserToken } = circleVerifySchema.parse(req.body);
  assertCircleSession(req.auth, req.auth.walletAddress, req.auth.circleWalletId);
  const result = await circleActionExecutionService.verifyCircleActionApproval({
    actionType, auth: req.auth, actionId, userToken: circleUserToken,
  });
  if (result.pending) {
    return res.status(202).json({ pending: true, actionId, transactionObserved: Boolean(result.transactionObserved) });
  }
  return res.json({
    confirmed: true,
    actionId,
    payloadHash: result.payloadHash,
    executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    approvalTxHash: result.approvalTxHash,
    step: result.step,
    challengeId: result.challengeId,
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

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

    throw new Error('wallet_execution_mode_invalid');
  } catch (error) {
    next(error);
  }
});

router.post('/entry/approval/verify', entryApprovalVerifyLimiter, async (req, res, next) => {
  try {
    if (req.auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      const { actionId, circleUserToken } = circleVerifySchema.parse(req.body);
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
    const { actionId, txHash } = txVerifySchema.parse(req.body);
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
      const { actionId, circleUserToken } = circleVerifySchema.parse(req.body);
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
    const { actionId, txHash } = txVerifySchema.parse(req.body);
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

// ---------------------------------------------------------------------------
// Ticket transfer
// ---------------------------------------------------------------------------

router.post('/ticket-transfer/start', startLimiter, async (req, res, next) => {
  try {
    const input = ticketTransferStartSchema.parse(req.body);
    const wallet = sessionWallet(req);
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET && !requireCircleStartCredentials(input, res)) return;
    const ticketAddress = ethers.getAddress(input.ticketAddress);
    const destinationAddress = ethers.getAddress(input.destinationAddress);
    const { walletAddress } = wallet;

    if (destinationAddress.toLowerCase() === walletAddress.toLowerCase()) {
      return res.status(409).json({ error: 'transfer_destination_same' });
    }

    const rounds = await arcService.getStandardRoundsState({ forceFresh: true });
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

    const params = { ticketAddress, tokenId: input.tokenId, destinationAddress };
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return startCircleFinancialAction(req, res, input, 'TRANSFER_TICKET', wallet, params);
    }

    const action = await actionAuthorizationService.createTicketTransferRequest({
      ...params,
      userId: req.auth.userId,
      walletAddress,
      executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
    });
    res.json(externalActionAuthorization(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/ticket-transfer/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId } = finishSchema.parse(req.body);
    const action = await consumeExternalAuthorization(req, actionId, 'TRANSFER_TICKET');
    const transactionRequest = await ticketTransferExecutionService
      .buildExternalTransferTransactionRequest(action.payload);
    res.json({
      confirmed: true,
      actionId,
      payloadHash: action.payloadHash,
      executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
      transactionRequest,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/ticket-transfer/verify', verifyLimiterFor(circleActionVerifyLimiter), async (req, res, next) => {
  try {
    if (isCircleSession(req)) return await verifyCircleFinancialAction(req, res, 'TRANSFER_TICKET');
    const { actionId, txHash } = txVerifySchema.parse(req.body);
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

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

router.post('/refund/start', startLimiter, async (req, res, next) => {
  try {
    const input = ticketRoundStartSchema.parse(req.body);
    const wallet = sessionWallet(req);
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET && !requireCircleStartCredentials(input, res)) return;
    const poolAddress = ethers.getAddress(input.poolAddress);
    const ticketAddress = ethers.getAddress(input.ticketAddress);

    const state = await arcService.readRefundAuthorizationState({
      poolAddress,
      ticketAddress,
      tokenId: input.tokenId,
      roundId: input.roundId,
    });

    if (state.roundStatus !== 'CANCELLED') {
      return res.status(409).json({ error: 'refund_round_not_cancelled' });
    }
    if (state.isRefunded) {
      return res.status(409).json({ error: 'refund_already_refunded' });
    }
    // Only the current NFT owner, acting through its own session wallet, may
    // refund. The refund is paid to that same current owner.
    if (state.currentOwner.toLowerCase() !== wallet.walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'refund_not_ticket_owner' });
    }

    const params = {
      poolAddress: state.poolAddress,
      ticketAddress: state.ticketAddress,
      tokenId: state.tokenId,
      roundId: state.roundId,
      currentOwner: state.currentOwner,
    };
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return startCircleFinancialAction(req, res, input, 'REFUND_TICKET', wallet, params);
    }

    const action = await actionAuthorizationService.createRefundRequest({
      ...params,
      userId: req.auth.userId,
      walletAddress: wallet.walletAddress,
      executionMode: 'EXTERNAL_OWNER',
    });
    res.json(externalActionAuthorization(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/refund/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId } = finishSchema.parse(req.body);
    const action = await consumeExternalAuthorization(req, actionId, 'REFUND_TICKET');
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

router.post('/refund/verify', verifyLimiterFor(circleActionVerifyLimiter), async (req, res, next) => {
  try {
    if (isCircleSession(req)) return await verifyCircleFinancialAction(req, res, 'REFUND_TICKET');
    const { actionId, txHash } = txVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(
      req.auth.userId,
      actionId,
      'REFUND_TICKET',
    );
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'refund_execution_mode_mismatch' });
    }
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

router.post('/claim/start', startLimiter, async (req, res, next) => {
  try {
    const input = ticketRoundStartSchema.parse(req.body);
    const wallet = sessionWallet(req);
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET && !requireCircleStartCredentials(input, res)) return;
    const poolAddress = ethers.getAddress(input.poolAddress);
    const ticketAddress = ethers.getAddress(input.ticketAddress);

    const state = await arcService.readClaimAuthorizationState({
      poolAddress,
      ticketAddress,
      tokenId: input.tokenId,
      roundId: input.roundId,
    });

    if (state.roundStatus !== 'SETTLED') {
      return res.status(409).json({ error: 'claim_round_not_settled' });
    }
    if (state.isClaimed) {
      return res.status(409).json({ error: 'claim_already_claimed' });
    }
    if (BigInt(state.claimableRaw) <= 0n) {
      return res.status(409).json({ error: 'claim_nothing_to_claim' });
    }
    if (state.currentOwner.toLowerCase() !== wallet.walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'claim_not_ticket_owner' });
    }

    const params = {
      poolAddress: state.poolAddress,
      ticketAddress: state.ticketAddress,
      tokenId: state.tokenId,
      roundId: state.roundId,
      currentOwner: state.currentOwner,
      amountRaw: state.claimableRaw,
    };
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return startCircleFinancialAction(req, res, input, 'CLAIM_REWARD', wallet, params);
    }

    const action = await actionAuthorizationService.createClaimRequest({
      ...params,
      userId: req.auth.userId,
      walletAddress: wallet.walletAddress,
      executionMode: 'EXTERNAL_OWNER',
    });
    res.json(externalActionAuthorization(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/claim/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId } = finishSchema.parse(req.body);
    const action = await consumeExternalAuthorization(req, actionId, 'CLAIM_REWARD');
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

router.post('/claim/verify', verifyLimiterFor(circleActionVerifyLimiter), async (req, res, next) => {
  try {
    if (isCircleSession(req)) return await verifyCircleFinancialAction(req, res, 'CLAIM_REWARD');
    const { actionId, txHash } = txVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(
      req.auth.userId,
      actionId,
      'CLAIM_REWARD',
    );
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'claim_execution_mode_mismatch' });
    }
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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

// ---------------------------------------------------------------------------
// Marketplace list
// ---------------------------------------------------------------------------

router.post('/marketplace-list/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceListStartSchema.parse(req.body);
    const wallet = sessionWallet(req);
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET && !requireCircleStartCredentials(input, res)) return;
    const ticketAddress = ethers.getAddress(input.ticketAddress);

    const [approval, activeListing] = await Promise.all([
      marketplaceService.readTicketApprovalState({ ticketAddress, tokenId: input.tokenId }),
      // Direct, uncached chain read -- never the board cache -- so a ticket
      // that already has an active listing is rejected before any action
      // authorization or Circle challenge is created, not only at the final
      // list() revert.
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

    if (approval.owner.toLowerCase() !== wallet.walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'marketplace_not_ticket_owner' });
    }

    const params = {
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      ticketAddress,
      tokenId: input.tokenId,
      askUsdcRaw: input.askUsdcRaw,
    };
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      // The Circle flow runs the exact per token approval as its own verified
      // phase when it is missing, so it is not required up front here.
      return startCircleFinancialAction(req, res, input, 'MARKETPLACE_LIST', wallet, params);
    }

    // Step 1 (the exact per token approve) must already have happened as its
    // own connected wallet transaction before this request is made.
    if (!approval.isApproved) {
      return res.status(409).json({ error: 'marketplace_token_not_approved' });
    }

    const action = await actionAuthorizationService.createMarketplaceListRequest({
      ...params,
      userId: req.auth.userId,
      walletAddress: wallet.walletAddress,
      executionMode: 'EXTERNAL_OWNER',
    });
    res.json(externalActionAuthorization(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-list/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId } = finishSchema.parse(req.body);
    const action = await consumeExternalAuthorization(req, actionId, 'MARKETPLACE_LIST');
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

router.post('/marketplace-list/approval/verify', circleActionApprovalVerifyLimiter, async (req, res, next) => {
  try {
    await verifyCircleFinancialApproval(req, res, 'MARKETPLACE_LIST');
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-list/verify', verifyLimiterFor(circleActionVerifyLimiter), async (req, res, next) => {
  try {
    if (isCircleSession(req)) return await verifyCircleFinancialAction(req, res, 'MARKETPLACE_LIST');
    const { actionId, txHash } = txVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(req.auth.userId, actionId, 'MARKETPLACE_LIST');
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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

// ---------------------------------------------------------------------------
// Marketplace update price
// ---------------------------------------------------------------------------

router.post('/marketplace-update-price/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceUpdatePriceStartSchema.parse(req.body);
    const wallet = sessionWallet(req);
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET && !requireCircleStartCredentials(input, res)) return;
    const listingId = Number(input.listingId);

    const { listing } = await marketplaceService.readMarketplaceListing(listingId);

    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    if (listing.state === 'EXPIRED') {
      return res.status(409).json({ error: 'marketplace_trading_window_closed' });
    }
    if (listing.seller.toLowerCase() !== wallet.walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'marketplace_not_listing_seller' });
    }
    if (!listing.isApproved) {
      return res.status(409).json({ error: 'marketplace_token_not_approved' });
    }

    const params = {
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      listingId: input.listingId,
      ticketAddress: listing.ticketAddress,
      tokenId: listing.tokenId,
      newAskUsdcRaw: input.newAskUsdcRaw,
    };
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return startCircleFinancialAction(req, res, input, 'MARKETPLACE_UPDATE_PRICE', wallet, params);
    }

    const action = await actionAuthorizationService.createMarketplaceUpdatePriceRequest({
      ...params,
      userId: req.auth.userId,
      walletAddress: wallet.walletAddress,
      executionMode: 'EXTERNAL_OWNER',
    });
    res.json(externalActionAuthorization(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-update-price/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId } = finishSchema.parse(req.body);
    const action = await consumeExternalAuthorization(req, actionId, 'MARKETPLACE_UPDATE_PRICE');
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

router.post('/marketplace-update-price/verify', verifyLimiterFor(circleActionVerifyLimiter), async (req, res, next) => {
  try {
    if (isCircleSession(req)) return await verifyCircleFinancialAction(req, res, 'MARKETPLACE_UPDATE_PRICE');
    const { actionId, txHash } = txVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(
      req.auth.userId,
      actionId,
      'MARKETPLACE_UPDATE_PRICE',
    );
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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

// ---------------------------------------------------------------------------
// Marketplace cancel
// ---------------------------------------------------------------------------

router.post('/marketplace-cancel/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceCancelStartSchema.parse(req.body);
    const wallet = sessionWallet(req);
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET && !requireCircleStartCredentials(input, res)) return;
    const listingId = Number(input.listingId);

    const { listing } = await marketplaceService.readMarketplaceListing(listingId);

    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    if (listing.state === 'EXPIRED') {
      return res.status(409).json({ error: 'marketplace_trading_window_closed' });
    }
    if (listing.seller.toLowerCase() !== wallet.walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'marketplace_not_listing_seller' });
    }

    // Cancel never requires approval, matching the contract exactly.
    const params = {
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      listingId: input.listingId,
      ticketAddress: listing.ticketAddress,
      tokenId: listing.tokenId,
    };
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return startCircleFinancialAction(req, res, input, 'MARKETPLACE_CANCEL', wallet, params);
    }

    const action = await actionAuthorizationService.createMarketplaceCancelRequest({
      ...params,
      userId: req.auth.userId,
      walletAddress: wallet.walletAddress,
      executionMode: 'EXTERNAL_OWNER',
    });
    res.json(externalActionAuthorization(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-cancel/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId } = finishSchema.parse(req.body);
    const action = await consumeExternalAuthorization(req, actionId, 'MARKETPLACE_CANCEL');
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

router.post('/marketplace-cancel/verify', verifyLimiterFor(circleActionVerifyLimiter), async (req, res, next) => {
  try {
    if (isCircleSession(req)) return await verifyCircleFinancialAction(req, res, 'MARKETPLACE_CANCEL');
    const { actionId, txHash } = txVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(req.auth.userId, actionId, 'MARKETPLACE_CANCEL');
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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

// ---------------------------------------------------------------------------
// Marketplace buy
// ---------------------------------------------------------------------------

router.post('/marketplace-buy/start', startLimiter, async (req, res, next) => {
  try {
    const input = marketplaceBuyStartSchema.parse(req.body);
    const wallet = sessionWallet(req);
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET && !requireCircleStartCredentials(input, res)) return;
    const listingId = Number(input.listingId);

    const { listing } = await marketplaceService.readMarketplaceListing(listingId);

    if (listing.onchainStatus !== 'ACTIVE') {
      return res.status(409).json({ error: 'marketplace_listing_not_active' });
    }
    // Refetch-before-confirm lives on the client; this is the authoritative
    // server-side re-check of the same fact, immediately before creating a
    // session bound request for it.
    if (listing.askUsdcRaw !== input.expectedAskUsdcRaw) {
      return res.status(409).json({ error: 'marketplace_price_changed' });
    }
    if (!listing.isBuyable) {
      return res.status(409).json({
        error: listing.state === 'EXPIRED' ? 'marketplace_trading_window_closed' : 'marketplace_listing_not_buyable',
      });
    }
    if (listing.seller.toLowerCase() === wallet.walletAddress.toLowerCase()) {
      return res.status(409).json({ error: 'marketplace_buyer_is_seller' });
    }

    const params = {
      marketplaceAddress: ethers.getAddress(config.EXTREMA_MARKETPLACE_ADDRESS),
      listingId: input.listingId,
      ticketAddress: listing.ticketAddress,
      tokenId: listing.tokenId,
      sellerAddress: listing.seller,
      expectedAskUsdcRaw: input.expectedAskUsdcRaw,
    };
    if (wallet.mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
      return startCircleFinancialAction(req, res, input, 'MARKETPLACE_BUY', wallet, params);
    }

    const action = await actionAuthorizationService.createMarketplaceBuyRequest({
      ...params,
      userId: req.auth.userId,
      walletAddress: wallet.walletAddress,
      executionMode: 'EXTERNAL_OWNER',
    });
    res.json(externalActionAuthorization(req, action));
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-buy/finish', finishLimiter, async (req, res, next) => {
  try {
    const { actionId } = finishSchema.parse(req.body);
    const action = await consumeExternalAuthorization(req, actionId, 'MARKETPLACE_BUY');
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

router.post('/marketplace-buy/approval/verify', circleActionApprovalVerifyLimiter, async (req, res, next) => {
  try {
    await verifyCircleFinancialApproval(req, res, 'MARKETPLACE_BUY');
  } catch (error) {
    next(error);
  }
});

router.post('/marketplace-buy/verify', verifyLimiterFor(circleActionVerifyLimiter), async (req, res, next) => {
  try {
    if (isCircleSession(req)) return await verifyCircleFinancialAction(req, res, 'MARKETPLACE_BUY');
    const { actionId, txHash } = txVerifySchema.parse(req.body);
    const action = await actionAuthorizationService.getConsumedAction(req.auth.userId, actionId, 'MARKETPLACE_BUY');
    if (action.payload.executionMode !== 'EXTERNAL_OWNER') {
      return res.status(409).json({ error: 'marketplace_execution_mode_mismatch' });
    }
    assertExternalSessionAddress(req.auth, action.payload.walletAddress);
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

// Test only: lets the behavioral regression suite prove the Circle verify
// limiters are independent instances without exercising real HTTP. Never
// read by production code.
router.__circleVerifyLimitersForTests = {
  createCircleVerifyLimiter,
  entryApprovalVerifyLimiter,
  entryVerifyLimiter,
  circleActionApprovalVerifyLimiter,
  circleActionVerifyLimiter,
};
