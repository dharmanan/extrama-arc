'use strict';

const { ethers } = require('ethers');
const actionAuthorizationService = require('./actionAuthorizationService');
const circleUserWalletService = require('./circleUserWalletService');
const executionService = require('./externalEntryExecutionService');

function safeChallenge(action, phaseName) {
  const isApproval = phaseName === 'APPROVAL';
  const challengeId = isApproval
    ? action.circleApprovalChallengeId
    : action.circleEntryChallengeId;
  if (!challengeId) return null;
  return {
    actionId: action.id,
    payloadHash: action.payloadHash,
    executionMode: 'CIRCLE_USER_WALLET',
    step: isApproval ? 'APPROVAL_REQUIRED' : 'ENTRY_READY',
    challengeId,
  };
}

const CIRCLE_TERMINAL_FAILURE_STATES = new Set(['FAILED', 'DENIED', 'CANCELLED']);
const CIRCLE_TERMINAL_CHALLENGE_STATES = new Set(['FAILED', 'EXPIRED']);

function isArcReceiptPending(error) {
  return error?.message === 'entry_approval_transaction_not_found' ||
    error?.message === 'entry_transaction_not_found';
}

async function assertCircleTokenSession({ auth, userToken }, dependencies = {}) {
  if (typeof userToken !== 'string' || userToken.length < 16) {
    throw new Error('circle_authentication_invalid');
  }
  const listArcEoa = dependencies.listArcEoa || circleUserWalletService.listArcEoa;
  const wallet = await listArcEoa(userToken);
  if (!wallet || wallet.id !== auth.circleWalletId ||
    !ethers.isAddress(wallet.address) ||
    wallet.address.toLowerCase() !== auth.walletAddress.toLowerCase()) {
    throw new Error('circle_wallet_session_mismatch');
  }
  return wallet;
}

async function issueChallenge({ action, auth, userToken, phaseName, transactionRequest }, dependencies = {}) {
  const existing = safeChallenge(action, phaseName);
  if (existing) return existing;
  const authorization = dependencies.actionAuthorizationService || actionAuthorizationService;
  const circle = dependencies.circleService || circleUserWalletService;
  const reserved = await authorization.reserveCircleEntryChallenge(
    auth.userId, action.id, auth.walletAddress, auth.circleWalletId, phaseName,
  );
  const reservedExisting = safeChallenge(reserved, phaseName);
  if (reservedExisting) return reservedExisting;
  const isApproval = phaseName === 'APPROVAL';
  const result = await circle.createContractExecutionChallenge({
    userToken,
    walletId: auth.circleWalletId,
    contractAddress: transactionRequest.to,
    callData: transactionRequest.data,
    idempotencyKey: isApproval
      ? reserved.circleApprovalIdempotencyKey
      : reserved.circleEntryIdempotencyKey,
    refId: isApproval ? reserved.circleApprovalRefId : reserved.circleEntryRefId,
  });
  const challengeId = await authorization.persistCircleEntryChallenge(
    auth.userId, action.id, auth.walletAddress, auth.circleWalletId, phaseName, result.challengeId,
  );
  return {
    actionId: action.id,
    payloadHash: action.payloadHash,
    executionMode: 'CIRCLE_USER_WALLET',
    step: isApproval ? 'APPROVAL_REQUIRED' : 'ENTRY_READY',
    challengeId,
  };
}

async function startCircleEntry({ action, auth, userToken }, dependencies = {}) {
  await assertCircleTokenSession({ auth, userToken }, dependencies);
  const authorization = dependencies.actionAuthorizationService || actionAuthorizationService;
  const stored = await authorization.getCircleEntryAction(
    auth.userId, action.id, auth.walletAddress, auth.circleWalletId,
  );
  if (stored.circleState === 'APPROVAL_CHALLENGE') {
    const existing = safeChallenge(stored, 'APPROVAL');
    if (existing) return existing;
  }
  if (stored.circleState === 'ENTRY_CHALLENGE') {
    const existing = safeChallenge(stored, 'ENTRY');
    if (existing) return existing;
  }
  if (stored.circleState && !['APPROVAL_VERIFIED', 'APPROVAL_CHALLENGE', 'ENTRY_CHALLENGE'].includes(stored.circleState)) {
    throw new Error('circle_entry_authorization_invalid');
  }
  const prepare = dependencies.prepareCircleEntry || executionService.prepareCircleEntry;
  const prepared = await prepare(stored.payload);
  if (stored.circleState === 'APPROVAL_CHALLENGE' && prepared.step !== 'APPROVAL_REQUIRED') {
    throw new Error('circle_entry_authorization_invalid');
  }
  if (stored.circleState === 'ENTRY_CHALLENGE' && prepared.step !== 'ENTRY_READY') {
    throw new Error('circle_entry_authorization_invalid');
  }
  return issueChallenge({
    action: stored,
    auth,
    userToken,
    phaseName: prepared.step === 'APPROVAL_REQUIRED' ? 'APPROVAL' : 'ENTRY',
    transactionRequest: prepared.transactionRequest,
  }, dependencies);
}

async function resolveCircleTransaction({ auth, actionId, userToken, phaseName }, dependencies = {}) {
  const authorization = dependencies.actionAuthorizationService || actionAuthorizationService;
  const circle = dependencies.circleService || circleUserWalletService;
  await assertCircleTokenSession({ auth, userToken }, dependencies);
  let action = await authorization.getCircleEntryAction(
    auth.userId, actionId, auth.walletAddress, auth.circleWalletId,
  );
  const isApproval = phaseName === 'APPROVAL';
  const refId = isApproval ? action.circleApprovalRefId : action.circleEntryRefId;
  const contractAddress = isApproval
    ? ethers.getAddress(require('./arcService').ARC_TESTNET_USDC_ADDRESS)
    : action.payload.contract;
  if (!refId) throw new Error('circle_entry_authorization_invalid');
  let transactionId = isApproval
    ? action.circleApprovalTransactionId
    : action.circleEntryTransactionId;
  const challengeId = isApproval
    ? action.circleApprovalChallengeId
    : action.circleEntryChallengeId;

  let transaction;

  if (!transactionId && challengeId) {
    const challenge = await circle.getContractExecutionChallenge({
      userToken,
      challengeId,
    });

    if (
      challenge &&
      CIRCLE_TERMINAL_CHALLENGE_STATES.has(challenge.status)
    ) {
      throw new Error('circle_transaction_failed');
    }

    if (challenge?.transactionId) {
      action = await authorization.persistCircleEntryTransactionId(
        auth.userId,
        actionId,
        auth.walletAddress,
        auth.circleWalletId,
        phaseName,
        challenge.transactionId,
      );
      transactionId = challenge.transactionId;
    }
  }

  if (transactionId) {
    transaction = await circle.getContractExecutionTransaction({
      userToken,
      id: transactionId,
      walletId: auth.circleWalletId,
      refId,
      contractAddress,
    });
  } else {
    transaction = await circle.findContractExecutionTransaction({
      userToken,
      walletId: auth.circleWalletId,
      refId,
      contractAddress,
    });

    if (transaction?.id) {
      action = await authorization.persistCircleEntryTransactionId(
        auth.userId,
        actionId,
        auth.walletAddress,
        auth.circleWalletId,
        phaseName,
        transaction.id,
      );
    }
  }
  if (!transaction) return { pending: true, transactionObserved: false, action };
  if (CIRCLE_TERMINAL_FAILURE_STATES.has(transaction.state)) {
    throw new Error('circle_transaction_failed');
  }
  if (!transaction.txHash) return { pending: true, transactionObserved: true, action };
  const bound = await authorization.bindCircleEntryTransaction(
    auth.userId, actionId, auth.walletAddress, auth.circleWalletId, phaseName, transaction,
  );
  return { pending: false, transactionObserved: true, action: bound, transaction };
}

async function verifyCircleApproval({ auth, actionId, userToken }, dependencies = {}) {
  const resolved = await resolveCircleTransaction({ auth, actionId, userToken, phaseName: 'APPROVAL' }, dependencies);
  if (resolved.pending) return { pending: true, transactionObserved: resolved.transactionObserved };
  const verify = dependencies.verifyCircleApprovalReceipt || executionService.verifyCircleApprovalReceipt;
  let result;
  try {
    result = await verify(resolved.action.payload, resolved.transaction.txHash);
  } catch (error) {
    if (isArcReceiptPending(error)) return { pending: true, transactionObserved: true };
    throw error;
  }
  const authorization = dependencies.actionAuthorizationService || actionAuthorizationService;
  await authorization.markCircleApprovalVerified(auth.userId, actionId, auth.walletAddress, auth.circleWalletId);
  const action = await authorization.getCircleEntryAction(auth.userId, actionId, auth.walletAddress, auth.circleWalletId);
  if (new Date(action.expiresAt).getTime() <= Date.now()) {
    throw new Error('circle_entry_action_expired_after_approval');
  }
  const challenge = await issueChallenge({
    action,
    auth,
    userToken,
    phaseName: 'ENTRY',
    transactionRequest: result.transactionRequest,
  }, dependencies);
  return { pending: false, approvalTxHash: resolved.transaction.txHash, ...challenge };
}

async function verifyCircleEntry({ auth, actionId, userToken }, dependencies = {}) {
  const resolved = await resolveCircleTransaction({ auth, actionId, userToken, phaseName: 'ENTRY' }, dependencies);
  if (resolved.pending) return { pending: true, transactionObserved: resolved.transactionObserved };
  const verify = dependencies.verifyCircleEntryReceipt || executionService.verifyCircleEntryReceipt;
  let result;
  try {
    result = await verify(resolved.action.payload, resolved.transaction.txHash);
  } catch (error) {
    if (isArcReceiptPending(error)) return { pending: true, transactionObserved: true };
    throw error;
  }
  const authorization = dependencies.actionAuthorizationService || actionAuthorizationService;
  await authorization.markCircleEntryReceiptVerified(
    auth.userId, actionId, auth.walletAddress, auth.circleWalletId, resolved.transaction.txHash,
  );
  return { pending: false, action: resolved.action, result };
}

module.exports = {
  assertCircleTokenSession,
  CIRCLE_TERMINAL_FAILURE_STATES,
  isArcReceiptPending,
  issueChallenge,
  startCircleEntry,
  resolveCircleTransaction,
  verifyCircleApproval,
  verifyCircleEntry,
};
