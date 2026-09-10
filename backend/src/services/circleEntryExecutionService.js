'use strict';

// Circle user controlled wallet ENTRY adapter. ENTRY is the first Circle
// action proven live on Arc Testnet; it keeps its original API and state
// labels (APPROVAL_* then ENTRY_*) while sharing challenge issuance and
// transaction reconciliation with every other Circle action through
// circleExecutionEngine.

const { ethers } = require('ethers');
const actionAuthorizationService = require('./actionAuthorizationService');
const circleUserWalletService = require('./circleUserWalletService');
const executionService = require('./externalEntryExecutionService');
const engine = require('./circleExecutionEngine');

const { CIRCLE_TERMINAL_FAILURE_STATES, assertCircleTokenSession } = engine;
const ENTRY_INVALID = 'circle_entry_authorization_invalid';

function isArcReceiptPending(error) {
  return error?.message === 'entry_approval_transaction_not_found' ||
    error?.message === 'entry_transaction_not_found';
}

// Adapts the ENTRY named authorization functions (and any injected test
// double that implements them) to the engine's storage port.
function entryPort(authorization) {
  return {
    invalidError: ENTRY_INVALID,
    getAction: (...args) => authorization.getCircleEntryAction(...args),
    reserveChallenge: (...args) => authorization.reserveCircleEntryChallenge(...args),
    persistChallenge: (...args) => authorization.persistCircleEntryChallenge(...args),
    persistTransactionId: (...args) => authorization.persistCircleEntryTransactionId(...args),
    bindTransaction: (...args) => authorization.bindCircleEntryTransaction(...args),
    markApprovalVerified: (...args) => authorization.markCircleApprovalVerified(...args),
    markActionVerified: (...args) => authorization.markCircleEntryReceiptVerified(...args),
  };
}

function entryContext(dependencies = {}) {
  return {
    port: entryPort(dependencies.actionAuthorizationService || actionAuthorizationService),
    circle: dependencies.circleService || circleUserWalletService,
  };
}

async function issueChallenge({ action, auth, userToken, phaseName, transactionRequest }, dependencies = {}) {
  const { port, circle } = entryContext(dependencies);
  return engine.issuePhaseChallenge({
    action, auth, userToken, phaseName, transactionRequest, port, circle,
  });
}

async function startCircleEntry({ action, auth, userToken }, dependencies = {}) {
  await assertCircleTokenSession({ auth, userToken }, dependencies);
  const { port } = entryContext(dependencies);
  const stored = await port.getAction(auth.userId, action.id, auth.walletAddress, auth.circleWalletId);
  if (stored.circleState === 'APPROVAL_CHALLENGE') {
    const existing = engine.existingChallenge(stored, 'APPROVAL');
    if (existing) return existing;
  }
  if (stored.circleState === 'ENTRY_CHALLENGE') {
    const existing = engine.existingChallenge(stored, 'ENTRY');
    if (existing) return existing;
  }
  if (stored.circleState && !['APPROVAL_VERIFIED', 'APPROVAL_CHALLENGE', 'ENTRY_CHALLENGE'].includes(stored.circleState)) {
    throw new Error(ENTRY_INVALID);
  }
  const prepare = dependencies.prepareCircleEntry || executionService.prepareCircleEntry;
  const prepared = await prepare(stored.payload);
  if (stored.circleState === 'APPROVAL_CHALLENGE' && prepared.step !== 'APPROVAL_REQUIRED') {
    throw new Error(ENTRY_INVALID);
  }
  if (stored.circleState === 'ENTRY_CHALLENGE' && prepared.step !== 'ENTRY_READY') {
    throw new Error(ENTRY_INVALID);
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
  const { port, circle } = entryContext(dependencies);
  return engine.resolvePhaseTransaction({
    auth,
    actionId,
    userToken,
    phaseName,
    contractAddressFor: (action) => (
      phaseName === 'APPROVAL'
        ? ethers.getAddress(require('./arcService').ARC_TESTNET_USDC_ADDRESS)
        : action.payload.contract
    ),
    port,
    circle,
    dependencies,
  });
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
  const { port } = entryContext(dependencies);
  await port.markApprovalVerified(auth.userId, actionId, auth.walletAddress, auth.circleWalletId);
  const action = await port.getAction(auth.userId, actionId, auth.walletAddress, auth.circleWalletId);
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
  const { port } = entryContext(dependencies);
  await port.markActionVerified(
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
