'use strict';

// Circle user controlled wallet execution for every post entry lifecycle
// action: ticket transfer, refund, reward claim, and the four marketplace
// actions. ENTRY keeps its own proven adapter (circleEntryExecutionService);
// both run through the same circleExecutionEngine, so challenge idempotency
// and transaction reconciliation have a single implementation.
//
// Each action type is described by an adapter that reuses the exact
// transaction builders and receipt verifiers of the connected wallet path,
// only allowing CIRCLE_USER_WALLET where those services explicitly accept it:
//
//   approval (optional)  prepare()  then { required, transactionRequest }
//                        verify()   then verified approval receipt + onchain state
//   buildAction()        fresh authoritative read, then the exact calldata
//   verifyAction()       sender / target / calldata / value / receipt /
//                        events / postconditions
//
// The Circle wallet signs every transaction itself through a hosted Circle
// challenge. EXTREMA never signs on behalf of a Circle user.

const { ethers } = require('ethers');
const actionAuthorizationService = require('./actionAuthorizationService');
const circleUserWalletService = require('./circleUserWalletService');
const engine = require('./circleExecutionEngine');
const ticketTransferExecutionService = require('./ticketTransferExecutionService');
const refundExecutionService = require('./refundExecutionService');
const claimExecutionService = require('./claimExecutionService');
const marketplaceExecutionService = require('./marketplaceExecutionService');

const INVALID = 'circle_action_authorization_invalid';

// Receipt lookups that only mean "not mined / not indexed yet". They keep the
// action pending so the client polls again; they never trigger a resend.
const PENDING_RECEIPT_ERRORS = new Set([
  'transfer_transaction_not_found',
  'refund_transaction_not_found',
  'claim_transaction_not_found',
  'marketplace_transaction_not_found',
  'marketplace_approval_transaction_not_found',
]);

function defaultAdapters() {
  return {
    TRANSFER_TICKET: {
      approval: null,
      buildAction: (payload) => ticketTransferExecutionService.buildCircleTransferTransactionRequest(payload),
      verifyAction: (payload, txHash) => ticketTransferExecutionService.verifyCircleTransferReceipt(payload, txHash),
    },
    REFUND_TICKET: {
      approval: null,
      buildAction: (payload) => refundExecutionService.buildCircleRefundTransactionRequest(payload),
      verifyAction: (payload, txHash) => refundExecutionService.verifyCircleRefundReceipt(payload, txHash),
    },
    CLAIM_REWARD: {
      approval: null,
      buildAction: (payload) => claimExecutionService.buildCircleClaimTransactionRequest(payload),
      verifyAction: (payload, txHash) => claimExecutionService.verifyCircleClaimReceipt(payload, txHash),
    },
    MARKETPLACE_LIST: {
      approval: {
        // Exactly one per token ERC721 approve(marketplace, tokenId), as the
        // connected wallet path requires. Never setApprovalForAll.
        contractAddress: (payload) => ethers.getAddress(payload.ticketAddress),
        prepare: (payload) => marketplaceExecutionService.prepareCircleListApproval(payload),
        verify: (payload, txHash) => marketplaceExecutionService.verifyCircleListApprovalReceipt(payload, txHash),
      },
      buildAction: (payload) => marketplaceExecutionService.buildCircleListTransactionRequest(payload),
      verifyAction: (payload, txHash) => marketplaceExecutionService.verifyCircleListReceipt(payload, txHash),
    },
    MARKETPLACE_UPDATE_PRICE: {
      approval: null,
      buildAction: (payload) => marketplaceExecutionService.buildCircleUpdatePriceTransactionRequest(payload),
      verifyAction: (payload, txHash) => marketplaceExecutionService.verifyCircleUpdatePriceReceipt(payload, txHash),
    },
    MARKETPLACE_CANCEL: {
      approval: null,
      buildAction: (payload) => marketplaceExecutionService.buildCircleCancelTransactionRequest(payload),
      verifyAction: (payload, txHash) => marketplaceExecutionService.verifyCircleCancelReceipt(payload, txHash),
    },
    MARKETPLACE_BUY: {
      approval: {
        // Exactly the expected ask, as the connected wallet path approves.
        contractAddress: () => ethers.getAddress(require('./arcService').ARC_TESTNET_USDC_ADDRESS),
        prepare: (payload) => marketplaceExecutionService.prepareCircleBuyApproval(payload),
        verify: (payload, txHash) => marketplaceExecutionService.verifyCircleBuyApprovalReceipt(payload, txHash),
      },
      buildAction: (payload) => marketplaceExecutionService.buildCircleBuyTransactionRequest(payload),
      verifyAction: (payload, txHash) => marketplaceExecutionService.verifyCircleBuyReceipt(payload, txHash),
    },
  };
}

const CIRCLE_ACTION_TYPES = Object.freeze(Object.keys(defaultAdapters()));

function actionPort(actionType, authorization) {
  return {
    invalidError: INVALID,
    getAction: (userId, actionId, walletAddress, circleWalletId) =>
      authorization.getCircleAction(actionType, userId, actionId, walletAddress, circleWalletId),
    reserveChallenge: (userId, actionId, walletAddress, circleWalletId, phaseName) =>
      authorization.reserveCircleChallenge(actionType, userId, actionId, walletAddress, circleWalletId, phaseName),
    persistChallenge: (userId, actionId, walletAddress, circleWalletId, phaseName, challengeId) =>
      authorization.persistCircleChallenge(actionType, userId, actionId, walletAddress, circleWalletId, phaseName, challengeId),
    persistTransactionId: (userId, actionId, walletAddress, circleWalletId, phaseName, transactionId) =>
      authorization.persistCircleTransactionId(actionType, userId, actionId, walletAddress, circleWalletId, phaseName, transactionId),
    bindTransaction: (userId, actionId, walletAddress, circleWalletId, phaseName, transaction) =>
      authorization.bindCircleTransaction(actionType, userId, actionId, walletAddress, circleWalletId, phaseName, transaction),
    markApprovalVerified: (userId, actionId, walletAddress, circleWalletId) =>
      authorization.markCircleApprovalVerifiedForAction(actionType, userId, actionId, walletAddress, circleWalletId),
    markActionVerified: (userId, actionId, walletAddress, circleWalletId, txHash) =>
      authorization.markCircleActionVerified(actionType, userId, actionId, walletAddress, circleWalletId, txHash),
  };
}

function resolveContext(actionType, dependencies = {}) {
  const adapters = dependencies.adapters || defaultAdapters();
  const adapter = adapters[actionType];
  if (!adapter || !CIRCLE_ACTION_TYPES.includes(actionType)) throw new Error(INVALID);
  const port = dependencies.port ||
    actionPort(actionType, dependencies.actionAuthorizationService || actionAuthorizationService);
  const circle = dependencies.circleService || circleUserWalletService;
  return { adapter, port, circle };
}

function assertBoundPayload(action, actionType, auth) {
  const payload = action?.payload;
  if (
    !payload ||
    payload.action !== actionType ||
    payload.executionMode !== 'CIRCLE_USER_WALLET' ||
    payload.chainId !== 5042002 ||
    !ethers.isAddress(payload.walletAddress) ||
    payload.walletAddress.toLowerCase() !== auth.walletAddress.toLowerCase()
  ) {
    throw new Error(INVALID);
  }
  return payload;
}

async function verifyOrPending(verify, payload, txHash) {
  try {
    return { pending: false, result: await verify(payload, txHash) };
  } catch (error) {
    if (PENDING_RECEIPT_ERRORS.has(error?.message)) return { pending: true, result: null };
    throw error;
  }
}

async function startCircleAction({ actionType, action, auth, userToken }, dependencies = {}) {
  const { adapter, port, circle } = resolveContext(actionType, dependencies);
  await engine.assertCircleTokenSession({ auth, userToken }, dependencies);
  const stored = await port.getAction(auth.userId, action.id, auth.walletAddress, auth.circleWalletId);
  const payload = assertBoundPayload(stored, actionType, auth);

  if (stored.circleState === 'APPROVAL_CHALLENGE') {
    const existing = engine.existingChallenge(stored, 'APPROVAL');
    if (existing) return existing;
  }
  if (stored.circleState === 'ACTION_CHALLENGE') {
    const existing = engine.existingChallenge(stored, 'ACTION');
    if (existing) return existing;
  }
  // A submitted or verified action is reconciled through verify, never
  // restarted: a second challenge for the same intent is never created.
  if (stored.circleState && !['APPROVAL_VERIFIED', 'APPROVAL_CHALLENGE', 'ACTION_CHALLENGE'].includes(stored.circleState)) {
    throw new Error(INVALID);
  }

  let phaseName = 'ACTION';
  let transactionRequest;
  if (adapter.approval && stored.circleState !== 'APPROVAL_VERIFIED' && stored.circleState !== 'ACTION_CHALLENGE') {
    const approval = await adapter.approval.prepare(payload);
    if (approval.required) {
      phaseName = 'APPROVAL';
      transactionRequest = approval.transactionRequest;
    }
  }
  if (stored.circleState === 'APPROVAL_CHALLENGE' && phaseName !== 'APPROVAL') {
    // The reserved approval was never issued and approval is no longer
    // needed. Refuse rather than silently changing this action's phase.
    throw new Error(INVALID);
  }
  if (!adapter.approval && stored.circleState === 'APPROVAL_VERIFIED') throw new Error(INVALID);
  if (phaseName === 'ACTION') {
    transactionRequest = await adapter.buildAction(payload);
  }

  return engine.issuePhaseChallenge({
    action: stored, auth, userToken, phaseName, transactionRequest, port, circle,
  });
}

async function verifyCircleActionApproval({ actionType, auth, actionId, userToken }, dependencies = {}) {
  const { adapter, port, circle } = resolveContext(actionType, dependencies);
  if (!adapter.approval) throw new Error(INVALID);
  const resolved = await engine.resolvePhaseTransaction({
    auth, actionId, userToken, phaseName: 'APPROVAL',
    contractAddressFor: (stored) => adapter.approval.contractAddress(stored.payload),
    port, circle, dependencies,
  });
  if (resolved.pending) return { pending: true, transactionObserved: resolved.transactionObserved };
  const payload = assertBoundPayload(resolved.action, actionType, auth);
  const verified = await verifyOrPending(adapter.approval.verify, payload, resolved.transaction.txHash);
  if (verified.pending) return { pending: true, transactionObserved: true };

  await port.markApprovalVerified(auth.userId, actionId, auth.walletAddress, auth.circleWalletId);
  const action = await port.getAction(auth.userId, actionId, auth.walletAddress, auth.circleWalletId);
  if (new Date(action.expiresAt).getTime() <= Date.now()) {
    throw new Error('circle_action_expired_after_approval');
  }
  // The action transaction is built from a fresh authoritative read taken
  // only after the approval is verified onchain. For a purchase that read
  // checks again the listing is still active, buyable, and at the exact ask.
  const existing = engine.existingChallenge(action, 'ACTION');
  const transactionRequest = existing ? null : await adapter.buildAction(payload);
  const challenge = existing || await engine.issuePhaseChallenge({
    action, auth, userToken, phaseName: 'ACTION', transactionRequest, port, circle,
  });
  return { pending: false, approvalTxHash: resolved.transaction.txHash, ...challenge };
}

async function verifyCircleAction({ actionType, auth, actionId, userToken }, dependencies = {}) {
  const { adapter, port, circle } = resolveContext(actionType, dependencies);
  const resolved = await engine.resolvePhaseTransaction({
    auth, actionId, userToken, phaseName: 'ACTION',
    contractAddressFor: (stored) => ethers.getAddress(stored.payload.contract),
    port, circle, dependencies,
  });
  if (resolved.pending) return { pending: true, transactionObserved: resolved.transactionObserved };
  const payload = assertBoundPayload(resolved.action, actionType, auth);
  const verified = await verifyOrPending(adapter.verifyAction, payload, resolved.transaction.txHash);
  if (verified.pending) return { pending: true, transactionObserved: true };
  await port.markActionVerified(
    auth.userId, actionId, auth.walletAddress, auth.circleWalletId, resolved.transaction.txHash,
  );
  return { pending: false, action: resolved.action, result: verified.result };
}

module.exports = {
  CIRCLE_ACTION_TYPES,
  PENDING_RECEIPT_ERRORS,
  actionPort,
  startCircleAction,
  verifyCircleActionApproval,
  verifyCircleAction,
};
