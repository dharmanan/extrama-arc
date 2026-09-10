'use strict';

// Shared Circle user controlled wallet execution engine.
//
// Every Circle financial action (ENTRY and the seven post entry lifecycle
// actions) runs through exactly these primitives, so challenge issuance and
// transaction reconciliation have one implementation:
//
//   issuePhaseChallenge      reserve durable idempotency state, then create at
//                            most one Circle contract execution challenge per
//                            phase. A saved challenge is always returned
//                            instead of creating a second one.
//   resolvePhaseTransaction  locate the Circle transaction for a phase (via the
//                            persisted transaction ID, the challenge
//                            correlation ID, or the phase refId) and bind its
//                            tx hash exactly once. It never creates anything.
//
// A phase is either APPROVAL (an ERC20 or ERC721 approve that must be mined
// and verified before the action) or the action itself. For historical
// compatibility the action phase of ENTRY is named ENTRY; every other action
// type uses ACTION. The storage port supplied by the caller decides which
// action_authorizations rows and state labels back each phase.

const { ethers } = require('ethers');
const circleUserWalletService = require('./circleUserWalletService');

const CIRCLE_TERMINAL_FAILURE_STATES = new Set(['FAILED', 'DENIED', 'CANCELLED']);
const CIRCLE_TERMINAL_CHALLENGE_STATES = new Set(['FAILED', 'EXPIRED']);
const ARC_TESTNET_CHAIN_ID = 5042002;

const PHASE_READY_STEP = Object.freeze({
  APPROVAL: 'APPROVAL_REQUIRED',
  ENTRY: 'ENTRY_READY',
  ACTION: 'ACTION_READY',
});

function phaseRecord(action, phaseName) {
  if (phaseName === 'APPROVAL') {
    return {
      challengeId: action?.circleApprovalChallengeId || null,
      idempotencyKey: action?.circleApprovalIdempotencyKey || null,
      refId: action?.circleApprovalRefId || null,
      transactionId: action?.circleApprovalTransactionId || null,
    };
  }
  return {
    challengeId: action?.circleActionChallengeId || null,
    idempotencyKey: action?.circleActionIdempotencyKey || null,
    refId: action?.circleActionRefId || null,
    transactionId: action?.circleActionTransactionId || null,
  };
}

async function assertCircleTokenSession({ auth, userToken }, dependencies = {}) {
  if (typeof userToken !== 'string' || userToken.length < 16) {
    throw new Error('circle_authentication_invalid');
  }
  const listArcEoa = dependencies.listArcEoa || circleUserWalletService.listArcEoa;
  const wallet = await listArcEoa(userToken);
  // The Circle authenticated wallet listing is the authority. The session
  // wallet and Circle wallet ID must both match it exactly, so a Circle user
  // token belonging to a different user can never drive this session.
  if (!wallet || wallet.id !== auth.circleWalletId ||
    !ethers.isAddress(wallet.address) ||
    wallet.address.toLowerCase() !== auth.walletAddress.toLowerCase()) {
    throw new Error('circle_wallet_session_mismatch');
  }
  return wallet;
}

function existingChallenge(action, phaseName) {
  const { challengeId } = phaseRecord(action, phaseName);
  if (!challengeId) return null;
  return {
    actionId: action.id,
    payloadHash: action.payloadHash,
    executionMode: 'CIRCLE_USER_WALLET',
    step: PHASE_READY_STEP[phaseName],
    challengeId,
  };
}

function assertChallengeRequest(transactionRequest, auth, invalidError) {
  if (
    !transactionRequest ||
    !ethers.isAddress(transactionRequest.to) ||
    typeof transactionRequest.data !== 'string' ||
    // Circle contract execution never carries native value here.
    (transactionRequest.value !== undefined && transactionRequest.value !== '0x0') ||
    (transactionRequest.chainId !== undefined && transactionRequest.chainId !== ARC_TESTNET_CHAIN_ID) ||
    (transactionRequest.from !== undefined &&
      (!ethers.isAddress(transactionRequest.from) ||
        transactionRequest.from.toLowerCase() !== auth.walletAddress.toLowerCase()))
  ) {
    throw new Error(invalidError);
  }
}

async function issuePhaseChallenge({
  action, auth, userToken, phaseName, transactionRequest, port, circle,
}) {
  if (!PHASE_READY_STEP[phaseName]) throw new Error(port.invalidError);
  const existing = existingChallenge(action, phaseName);
  if (existing) return existing;
  assertChallengeRequest(transactionRequest, auth, port.invalidError);
  const reserved = await port.reserveChallenge(
    auth.userId, action.id, auth.walletAddress, auth.circleWalletId, phaseName,
  );
  const reservedExisting = existingChallenge(reserved, phaseName);
  if (reservedExisting) return reservedExisting;
  const record = phaseRecord(reserved, phaseName);
  const result = await circle.createContractExecutionChallenge({
    userToken,
    walletId: auth.circleWalletId,
    contractAddress: transactionRequest.to,
    callData: transactionRequest.data,
    idempotencyKey: record.idempotencyKey,
    refId: record.refId,
  });
  const challengeId = await port.persistChallenge(
    auth.userId, action.id, auth.walletAddress, auth.circleWalletId, phaseName, result.challengeId,
  );
  return {
    actionId: action.id,
    payloadHash: action.payloadHash,
    executionMode: 'CIRCLE_USER_WALLET',
    step: PHASE_READY_STEP[phaseName],
    challengeId,
  };
}

async function resolvePhaseTransaction({
  auth, actionId, userToken, phaseName, contractAddressFor, port, circle, dependencies = {},
}) {
  await assertCircleTokenSession({ auth, userToken }, dependencies);
  let action = await port.getAction(auth.userId, actionId, auth.walletAddress, auth.circleWalletId);
  const record = phaseRecord(action, phaseName);
  if (!record.refId) throw new Error(port.invalidError);
  const contractAddress = contractAddressFor(action);
  let transactionId = record.transactionId;
  let transaction;

  if (!transactionId && record.challengeId) {
    const challenge = await circle.getContractExecutionChallenge({
      userToken,
      challengeId: record.challengeId,
    });

    if (challenge && CIRCLE_TERMINAL_CHALLENGE_STATES.has(challenge.status)) {
      throw new Error('circle_transaction_failed');
    }

    if (challenge?.transactionId) {
      action = await port.persistTransactionId(
        auth.userId, actionId, auth.walletAddress, auth.circleWalletId, phaseName, challenge.transactionId,
      );
      transactionId = challenge.transactionId;
    }
  }

  if (transactionId) {
    transaction = await circle.getContractExecutionTransaction({
      userToken,
      id: transactionId,
      walletId: auth.circleWalletId,
      refId: record.refId,
      contractAddress,
    });
  } else {
    transaction = await circle.findContractExecutionTransaction({
      userToken,
      walletId: auth.circleWalletId,
      refId: record.refId,
      contractAddress,
    });

    if (transaction?.id) {
      action = await port.persistTransactionId(
        auth.userId, actionId, auth.walletAddress, auth.circleWalletId, phaseName, transaction.id,
      );
    }
  }
  if (!transaction) return { pending: true, transactionObserved: false, action };
  if (CIRCLE_TERMINAL_FAILURE_STATES.has(transaction.state)) {
    throw new Error('circle_transaction_failed');
  }
  if (!transaction.txHash) return { pending: true, transactionObserved: true, action };
  const bound = await port.bindTransaction(
    auth.userId, actionId, auth.walletAddress, auth.circleWalletId, phaseName, transaction,
  );
  return { pending: false, transactionObserved: true, action: bound, transaction };
}

module.exports = {
  CIRCLE_TERMINAL_FAILURE_STATES,
  CIRCLE_TERMINAL_CHALLENGE_STATES,
  PHASE_READY_STEP,
  phaseRecord,
  assertCircleTokenSession,
  existingChallenge,
  issuePhaseChallenge,
  resolvePhaseTransaction,
};
