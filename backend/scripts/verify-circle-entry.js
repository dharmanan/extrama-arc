'use strict';

const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify-only-session-secret-not-for-runtime';

const { ethers } = require('ethers');
const arcService = require('../src/services/arcService');
const { currentDailySchedule } = require('../src/services/canonicalMarketSchedule');
const execution = require('../src/services/externalEntryExecutionService');
const { createCircleUserWalletService } = require('../src/services/circleUserWalletService');
const circleEntry = require('../src/services/circleEntryExecutionService');

const WALLET = '0x1000000000000000000000000000000000000001';
const POOL = arcService.ARC_POOL_TOPOLOGY[0].poolAddress;
const USDC = arcService.ARC_TESTNET_USDC_ADDRESS;
const ACTION_ID = '11111111-1111-4111-8111-111111111111';
const CIRCLE_WALLET_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function payload() {
  return {
    action: 'ENTRY', chainId: 5042002, contract: POOL, destination: POOL,
    roundId: 1, amountRaw: '1000000', predictionPriceCents: 12345,
    executionMode: 'CIRCLE_USER_WALLET', walletAddress: WALLET,
    nonce: 'this-is-a-long-enough-nonce', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function liveState(allowance) {
  const schedule = currentDailySchedule(BigInt(Math.floor(Date.now() / 1000)));
  const chainTimestamp = schedule.entryOpenAt + 1n;
  return {
    provider: {}, network: { chainId: 5042002n }, walletAddress: WALLET,
    poolAddress: POOL, usdcAddress: USDC, ticketAddress: POOL,
    pool: {}, round: { ...schedule, status: 0 },
    chainTimestamp, hasEntered: false,
    predictionTaken: false, balance: 1_000_000n, allowance, nativeBalance: 1n,
  };
}

function entryAction(overrides = {}) {
  return {
    id: ACTION_ID,
    payloadHash: 'payload-hash',
    payload: payload(),
    circleState: null,
    circleApprovalChallengeId: null,
    circleApprovalIdempotencyKey: null,
    circleApprovalRefId: null,
    circleApprovalTransactionId: null,
    circleApprovalTxHash: null,
    circleEntryChallengeId: null,
    circleEntryIdempotencyKey: null,
    circleEntryRefId: null,
    circleEntryTransactionId: null,
    verifiedTxHash: null,
    ...overrides,
  };
}

function createMemoryAuthorization(initial) {
  let state = entryAction(initial);
  const keyByPhase = {
    APPROVAL: '66666666-6666-4666-8666-666666666666',
    ENTRY: '77777777-7777-4777-8777-777777777777',
  };
  const checkIdentity = (userId, actionId, walletAddress, circleWalletId) => {
    if (userId !== USER_ID || actionId !== ACTION_ID ||
      walletAddress.toLowerCase() !== WALLET.toLowerCase() || circleWalletId !== CIRCLE_WALLET_ID) {
      throw new Error('circle_entry_authorization_invalid');
    }
  };
  const phaseFields = (phase) => phase === 'APPROVAL'
    ? ['circleApprovalIdempotencyKey', 'circleApprovalRefId', 'circleApprovalChallengeId', 'circleApprovalTransactionId', 'circleApprovalTxHash']
    : ['circleEntryIdempotencyKey', 'circleEntryRefId', 'circleEntryChallengeId', 'circleEntryTransactionId', 'verifiedTxHash'];
  return {
    get state() { return state; },
    async getCircleEntryAction(...args) { checkIdentity(...args); return state; },
    async reserveCircleEntryChallenge(userId, actionId, walletAddress, circleWalletId, phase) {
      checkIdentity(userId, actionId, walletAddress, circleWalletId);
      const allowed = phase === 'APPROVAL'
        ? [null, 'APPROVAL_CHALLENGE']
        : [null, 'APPROVAL_VERIFIED', 'ENTRY_CHALLENGE'];
      if (!allowed.includes(state.circleState)) throw new Error('circle_entry_authorization_invalid');
      const [idempotency, ref] = phaseFields(phase);
      state = {
        ...state,
        circleState: phase === 'APPROVAL' ? 'APPROVAL_CHALLENGE' : 'ENTRY_CHALLENGE',
        [idempotency]: state[idempotency] || keyByPhase[phase],
        [ref]: state[ref] || `${ACTION_ID}:${phase.toLowerCase()}`,
      };
      return state;
    },
    async persistCircleEntryChallenge(userId, actionId, walletAddress, circleWalletId, phase, challengeId) {
      checkIdentity(userId, actionId, walletAddress, circleWalletId);
      const [, , challenge] = phaseFields(phase);
      if (state[challenge] && state[challenge] !== challengeId) throw new Error('circle_entry_authorization_invalid');
      state = { ...state, [challenge]: challengeId };
      return challengeId;
    },
    async persistCircleEntryTransactionId(userId, actionId, walletAddress, circleWalletId, phase, transactionId) {
      checkIdentity(userId, actionId, walletAddress, circleWalletId);
      const [, , , transactionIdField] = phaseFields(phase);
      if (state[transactionIdField] && state[transactionIdField] !== transactionId) {
        throw new Error('circle_entry_authorization_invalid');
      }
      state = { ...state, [transactionIdField]: transactionId };
      return state;
    },
    async bindCircleEntryTransaction(userId, actionId, walletAddress, circleWalletId, phase, transaction) {
      checkIdentity(userId, actionId, walletAddress, circleWalletId);
      const [, , , transactionId, txHash] = phaseFields(phase);
      const finalOrAdvanced = phase === 'APPROVAL'
        ? ['APPROVAL_VERIFIED', 'ENTRY_CHALLENGE', 'ENTRY_SUBMITTED', 'VERIFIED']
        : ['VERIFIED'];
      if (finalOrAdvanced.includes(state.circleState)) {
        if (state[transactionId] !== transaction.id || state[txHash]?.toLowerCase() !== transaction.txHash.toLowerCase()) {
          throw new Error('circle_entry_authorization_invalid');
        }
        return state;
      }
      const expected = phase === 'APPROVAL'
        ? ['APPROVAL_CHALLENGE', 'APPROVAL_SUBMITTED']
        : ['ENTRY_CHALLENGE', 'ENTRY_SUBMITTED'];
      if (!expected.includes(state.circleState) ||
        (state[transactionId] && state[transactionId] !== transaction.id) ||
        (state[txHash] && state[txHash].toLowerCase() !== transaction.txHash.toLowerCase())) {
        throw new Error('circle_entry_authorization_invalid');
      }
      state = {
        ...state,
        circleState: phase === 'APPROVAL' ? 'APPROVAL_SUBMITTED' : 'ENTRY_SUBMITTED',
        [transactionId]: transaction.id,
        [txHash]: transaction.txHash,
      };
      return state;
    },
    async markCircleApprovalVerified(userId, actionId, walletAddress, circleWalletId) {
      checkIdentity(userId, actionId, walletAddress, circleWalletId);
      if (state.circleState === 'APPROVAL_SUBMITTED') state = { ...state, circleState: 'APPROVAL_VERIFIED' };
      else if (!['APPROVAL_VERIFIED', 'ENTRY_CHALLENGE', 'ENTRY_SUBMITTED', 'VERIFIED'].includes(state.circleState)) {
        throw new Error('circle_entry_authorization_invalid');
      }
    },
    async markCircleEntryReceiptVerified(userId, actionId, walletAddress, circleWalletId, txHash) {
      checkIdentity(userId, actionId, walletAddress, circleWalletId);
      if (state.verifiedTxHash?.toLowerCase() !== txHash.toLowerCase() ||
        !['ENTRY_SUBMITTED', 'VERIFIED'].includes(state.circleState)) {
        throw new Error('circle_entry_authorization_invalid');
      }
      state = { ...state, circleState: 'VERIFIED' };
    },
  };
}

function circleDependencies(authorization, transaction, transactionRequest = readyRequest) {
  const created = [];
  return {
    created,
    listArcEoa: async () => ({ id: CIRCLE_WALLET_ID, address: WALLET }),
    actionAuthorizationService: authorization,
    circleService: {
      async createContractExecutionChallenge(input) {
        created.push(input);
        return { challengeId: `challenge-${created.length}` };
      },
      async findContractExecutionTransaction() { return transaction; },
      async getContractExecutionTransaction(input) {
        if (transaction?.id !== input.id) throw new Error('circle_transaction_mismatch');
        return transaction;
      },
    },
    prepareCircleEntry: async () => ({ step: 'ENTRY_READY', transactionRequest }),
    verifyCircleApprovalReceipt: async () => ({ transactionRequest }),
    verifyCircleEntryReceipt: async () => ({ entryTxHash: transaction?.txHash || 'none', roundId: 1 }),
  };
}

let readyRequest;

async function main() {
  const approval = await execution.prepareCircleEntry(payload(), {
    readLiveState: async () => liveState(0n),
  });
  assert.equal(approval.step, 'APPROVAL_REQUIRED');
  assert.equal(approval.transactionRequest.to, ethers.getAddress(USDC));
  assert.match(approval.transactionRequest.data, /^0x095ea7b3/i);

  const ready = await execution.prepareCircleEntry(payload(), {
    readLiveState: async () => liveState(1_000_000n),
  });
  assert.equal(ready.step, 'ENTRY_READY');
  assert.equal(ready.transactionRequest.to, ethers.getAddress(POOL));
  assert.match(ready.transactionRequest.data, /^0x/i);
  readyRequest = ready.transactionRequest;
  assert.throws(() => execution.assertCirclePayload({ ...payload(), executionMode: 'EXTERNAL_WALLET' }), /action_authorization_invalid/);
  assert.throws(() => execution.assertTransaction({
    from: '0x2000000000000000000000000000000000000002', to: ready.transactionRequest.to,
    value: 0n, data: ready.transactionRequest.data,
  }, ready.transactionRequest), /entry_sender_mismatch/);
  assert.throws(() => execution.assertTransaction({
    from: WALLET, to: '0x2000000000000000000000000000000000000002', value: 0n, data: ready.transactionRequest.data,
  }, ready.transactionRequest), /entry_target_mismatch/);
  assert.throws(() => execution.assertTransaction({
    from: WALLET, to: ready.transactionRequest.to, value: 1n, data: ready.transactionRequest.data,
  }, ready.transactionRequest), /entry_value_mismatch/);
  assert.throws(() => execution.assertTransaction({
    from: WALLET, to: ready.transactionRequest.to, value: 0n, data: '0x00',
  }, ready.transactionRequest), /entry_calldata_mismatch/);

  const calls = [];
  const transactionListCalls = [];
  const circle = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: {
      async createUserTransactionContractExecutionChallenge(input) {
        calls.push(input);
        return { data: { challengeId: 'circle-challenge-1' } };
      },
      async listTransactions(input) {
        transactionListCalls.push(input);
        return { data: { transactions: [{
          id: '44444444-4444-4444-8444-444444444444', walletId: CIRCLE_WALLET_ID,
          blockchain: 'ARC-TESTNET', refId: `${ACTION_ID}:entry`, contractAddress: POOL,
          txHash: `0x${'a'.repeat(64)}`, state: 'CONFIRMED',
        }] }, headers: { 'x-next-page-after': 'must-not-be-followed' } };
      },
      async getTransaction(input) {
        return { data: { transaction: {
          id: input.id, walletId: CIRCLE_WALLET_ID, blockchain: 'ARC-TESTNET',
          refId: `${ACTION_ID}:entry`, contractAddress: POOL, txHash: `0x${'a'.repeat(64)}`, state: 'SENT',
        } } };
      },
    },
  });
  const challenge = await circle.createContractExecutionChallenge({
    userToken: 'circle-user-token-long-enough', walletId: CIRCLE_WALLET_ID,
    contractAddress: POOL, callData: ready.transactionRequest.data,
    idempotencyKey: '55555555-5555-4555-8555-555555555555', refId: `${ACTION_ID}:entry`,
  });
  assert.equal(challenge.challengeId, 'circle-challenge-1');
  assert.deepEqual(calls[0].fee, { type: 'level', config: { feeLevel: 'MEDIUM' } });
  assert.equal(calls[0].blockchain, undefined, 'walletId and blockchain must not be sent together');
  assert.equal(calls[0].walletId, CIRCLE_WALLET_ID);
  assert.equal(calls[0].contractAddress, ethers.getAddress(POOL));
  const transaction = await circle.findContractExecutionTransaction({
    userToken: 'circle-user-token-long-enough', walletId: CIRCLE_WALLET_ID,
    refId: `${ACTION_ID}:entry`, contractAddress: POOL,
  });
  assert.equal(transaction?.txHash, `0x${'a'.repeat(64)}`);
  assert.equal(transactionListCalls.length, 1);
  assert.equal(transactionListCalls[0].blockchain, undefined);
  assert.deepEqual(transactionListCalls[0].walletIds, [CIRCLE_WALLET_ID]);
  assert.equal(transactionListCalls[0].operation, undefined);
  assert.equal(transactionListCalls[0].order, 'DESC');
  assert.equal(transactionListCalls[0].pageAfter, undefined);
  assert.equal(await circle.findContractExecutionTransaction({
    userToken: 'circle-user-token-long-enough', walletId: CIRCLE_WALLET_ID,
    refId: 'other', contractAddress: POOL,
  }), null);
  assert.equal(
    transactionListCalls.length,
    2,
    'each transaction lookup must perform exactly one Circle list request',
  );
  const fetched = await circle.getContractExecutionTransaction({
    userToken: 'circle-user-token-long-enough', id: '44444444-4444-4444-8444-444444444444',
    walletId: CIRCLE_WALLET_ID, refId: `${ACTION_ID}:entry`, contractAddress: POOL,
  });
  assert.equal(fetched?.id, '44444444-4444-4444-8444-444444444444');
  await assert.rejects(
    () => createCircleUserWalletService({
      apiKey: 'verify-key',
      client: { async createUserTransactionContractExecutionChallenge() { throw { response: { status: 429 } }; } },
    }).createContractExecutionChallenge({
      userToken: 'circle-user-token-long-enough', walletId: CIRCLE_WALLET_ID,
      contractAddress: POOL, callData: ready.transactionRequest.data,
      idempotencyKey: '55555555-5555-4555-8555-555555555555', refId: `${ACTION_ID}:entry`,
    }),
    /circle_rate_limited/,
  );

  const auth = { userId: USER_ID, executionMode: 'CIRCLE_USER_WALLET', walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID };
  await circleEntry.assertCircleTokenSession({ auth, userToken: 'circle-user-token-long-enough' }, {
    listArcEoa: async () => ({ id: CIRCLE_WALLET_ID, address: WALLET }),
  });
  await assert.rejects(
    () => circleEntry.assertCircleTokenSession({ auth, userToken: 'circle-user-token-long-enough' }, {
      listArcEoa: async () => ({ id: CIRCLE_WALLET_ID, address: '0x2000000000000000000000000000000000000002' }),
    }),
    /circle_wallet_session_mismatch/,
  );
  await assert.rejects(
    () => circleEntry.assertCircleTokenSession({ auth, userToken: '' }, { listArcEoa: async () => null }),
    /circle_authentication_invalid/,
  );

  const issued = [];
  const action = {
    id: ACTION_ID, payloadHash: 'payload-hash', payload: payload(), circleApprovalChallengeId: null,
    circleApprovalIdempotencyKey: null, circleApprovalRefId: null, circleEntryChallengeId: null,
    circleEntryIdempotencyKey: null, circleEntryRefId: null,
  };
  const challengeResult = await circleEntry.issueChallenge({
    action, auth, userToken: 'circle-user-token-long-enough', phaseName: 'ENTRY', transactionRequest: ready.transactionRequest,
  }, {
    actionAuthorizationService: {
      async reserveCircleEntryChallenge() {
        return { ...action, circleEntryIdempotencyKey: '66666666-6666-4666-8666-666666666666', circleEntryRefId: `${ACTION_ID}:entry` };
      },
      async persistCircleEntryChallenge(...args) { issued.push(args); return 'circle-challenge-2'; },
    },
    circleService: circle,
  });
  assert.equal(challengeResult.challengeId, 'circle-challenge-2');
  assert.equal(issued.length, 1);
  assert.equal(calls[1].refId, `${ACTION_ID}:entry`);
  const replay = await circleEntry.issueChallenge({
    action: { ...action, circleEntryChallengeId: 'circle-challenge-2' }, auth,
    userToken: 'circle-user-token-long-enough', phaseName: 'ENTRY', transactionRequest: ready.transactionRequest,
  }, { actionAuthorizationService: {}, circleService: circle });
  assert.equal(replay.challengeId, 'circle-challenge-2', 'a saved challenge must never create a second Circle request');
  assert.equal(calls.length, 2);

  // A fresh Circle action may already have sufficient onchain allowance.
  // In that case it must be able to go directly from no Circle state to
  // an ENTRY challenge without requiring another approval.
  const directEntryAuthorization = createMemoryAuthorization(entryAction());
  const directEntryDependencies = circleDependencies(directEntryAuthorization, null);
  const directEntryStarted = await circleEntry.startCircleEntry({
    action: directEntryAuthorization.state,
    auth,
    userToken: 'circle-user-token-long-enough',
  }, directEntryDependencies);
  assert.equal(directEntryStarted.step, 'ENTRY_READY');
  assert.equal(directEntryStarted.challengeId, 'challenge-1');
  assert.equal(directEntryAuthorization.state.circleState, 'ENTRY_CHALLENGE');
  assert.equal(directEntryDependencies.created.length, 1);

  // A process can die after the durable reservation but before challenge ID
  // persistence. Both phases must retry the exact same Circle request.
  for (const [phase, initial] of [
    ['APPROVAL', entryAction()],
    ['ENTRY', entryAction({ circleState: 'APPROVAL_VERIFIED' })],
  ]) {
    const authorization = createMemoryAuthorization(initial);
    const crashDependencies = circleDependencies(authorization, null);
    crashDependencies.actionAuthorizationService = new Proxy(authorization, {
      get(target, property, receiver) {
        if (property === 'persistCircleEntryChallenge') {
          return async () => { throw new Error('simulated_crash_after_reserve'); };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await assert.rejects(
      () => circleEntry.issueChallenge({
        action: authorization.state, auth, userToken: 'circle-user-token-long-enough', phaseName: phase,
        transactionRequest: ready.transactionRequest,
      }, crashDependencies),
      /simulated_crash_after_reserve/,
    );
    const reserved = authorization.state;
    const key = phase === 'APPROVAL' ? reserved.circleApprovalIdempotencyKey : reserved.circleEntryIdempotencyKey;
    const ref = phase === 'APPROVAL' ? reserved.circleApprovalRefId : reserved.circleEntryRefId;
    const recoveryDependencies = circleDependencies(authorization, null);
    const recovered = await circleEntry.issueChallenge({
      action: reserved, auth, userToken: 'circle-user-token-long-enough', phaseName: phase,
      transactionRequest: ready.transactionRequest,
    }, recoveryDependencies);
    assert.equal(recovered.challengeId, 'challenge-1');
    assert.equal(crashDependencies.created[0].idempotencyKey, key);
    assert.equal(crashDependencies.created[0].refId, ref);
    assert.equal(recoveryDependencies.created[0].idempotencyKey, key);
    assert.equal(recoveryDependencies.created[0].refId, ref);
    assert.equal(authorization.state.circleState, phase === 'APPROVAL' ? 'APPROVAL_CHALLENGE' : 'ENTRY_CHALLENGE');
  }

  const approvalTransaction = {
    id: '88888888-8888-4888-8888-888888888888', txHash: `0x${'b'.repeat(64)}`, state: 'SENT',
  };
  const approvalAuthorization = createMemoryAuthorization(entryAction({
    circleState: 'APPROVAL_CHALLENGE', circleApprovalChallengeId: 'approval-challenge',
    circleApprovalIdempotencyKey: '66666666-6666-4666-8666-666666666666', circleApprovalRefId: `${ACTION_ID}:approval`,
  }));
  const approvalDependencies = circleDependencies(approvalAuthorization, approvalTransaction);
  const approvalVerified = await circleEntry.verifyCircleApproval({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough',
  }, approvalDependencies);
  const approvalDuplicate = await circleEntry.verifyCircleApproval({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough',
  }, approvalDependencies);
  assert.equal(approvalVerified.challengeId, approvalDuplicate.challengeId, 'duplicate approval returns the same entry challenge');
  assert.equal(approvalAuthorization.state.circleState, 'ENTRY_CHALLENGE');
  assert.equal(approvalDependencies.created.length, 1, 'duplicate approval must not create another entry challenge');

  const entryTransaction = {
    id: '99999999-9999-4999-8999-999999999999', txHash: `0x${'c'.repeat(64)}`, state: 'SENT',
  };
  const entryAuthorization = createMemoryAuthorization(entryAction({
    circleState: 'ENTRY_CHALLENGE', circleEntryChallengeId: 'entry-challenge',
    circleEntryIdempotencyKey: '77777777-7777-4777-8777-777777777777', circleEntryRefId: `${ACTION_ID}:entry`,
  }));
  const entryDependencies = circleDependencies(entryAuthorization, entryTransaction);
  const firstEntry = await circleEntry.verifyCircleEntry({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough',
  }, entryDependencies);
  const duplicateEntry = await circleEntry.verifyCircleEntry({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough',
  }, entryDependencies);
  assert.equal(entryAuthorization.state.circleState, 'VERIFIED');
  assert.deepEqual(duplicateEntry.result, firstEntry.result, 'duplicate entry stays VERIFIED with the same result');
  for (const replacement of [
    { ...entryTransaction, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { ...entryTransaction, txHash: `0x${'d'.repeat(64)}` },
  ]) {
    entryDependencies.circleService.getContractExecutionTransaction = async () => replacement;
    await assert.rejects(
      () => circleEntry.verifyCircleEntry({ auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough' }, entryDependencies),
      /circle_entry_authorization_invalid/,
    );
    assert.equal(entryAuthorization.state.circleState, 'VERIFIED');
  }
  await assert.rejects(
    () => circleEntry.verifyCircleEntry({
      auth: { ...auth, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      actionId: ACTION_ID,
      userToken: 'circle-user-token-long-enough',
    }, entryDependencies),
    /circle_entry_authorization_invalid/,
  );

  for (const state of ['FAILED', 'DENIED', 'CANCELLED']) {
    const terminalDependencies = circleDependencies(
      createMemoryAuthorization(entryAction({ circleState: 'ENTRY_CHALLENGE', circleEntryRefId: `${ACTION_ID}:entry` })),
      { id: entryTransaction.id, state },
    );
    await assert.rejects(
      () => circleEntry.resolveCircleTransaction({ auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough', phaseName: 'ENTRY' }, terminalDependencies),
      /circle_transaction_failed/,
    );
  }
  const pendingDependencies = circleDependencies(
    createMemoryAuthorization(entryAction({ circleState: 'ENTRY_CHALLENGE', circleEntryRefId: `${ACTION_ID}:entry` })),
    { id: entryTransaction.id, state: 'SENT' },
  );
  assert.equal((await circleEntry.resolveCircleTransaction({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough', phaseName: 'ENTRY',
  }, pendingDependencies)).pending, true);

  let discoveryCalls = 0;
  let lookupCalls = 0;
  const discoveredId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const discoveredAuthorization = createMemoryAuthorization(entryAction({
    circleState: 'ENTRY_CHALLENGE', circleEntryRefId: `${ACTION_ID}:entry`,
  }));
  const discoveredDependencies = {
    ...circleDependencies(discoveredAuthorization, null),
    circleService: {
      async findContractExecutionTransaction() {
        discoveryCalls += 1;
        return { id: discoveredId, state: 'SENT' };
      },
      async getContractExecutionTransaction(input) {
        lookupCalls += 1;
        assert.equal(input.id, discoveredId);
        return { id: discoveredId, txHash: entryTransaction.txHash, state: 'SENT' };
      },
    },
  };
  assert.equal((await circleEntry.resolveCircleTransaction({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough', phaseName: 'ENTRY',
  }, discoveredDependencies)).pending, true);
  assert.equal(discoveredAuthorization.state.circleEntryTransactionId, discoveredId);
  const gainedHash = await circleEntry.resolveCircleTransaction({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough', phaseName: 'ENTRY',
  }, discoveredDependencies);
  assert.equal(gainedHash.pending, false);
  assert.equal(discoveryCalls, 1, 'transaction history is scanned only until an ID is persisted');
  assert.equal(lookupCalls, 1, 'persisted Circle transaction IDs use getTransaction on later polls');

  const terminalLookupAuthorization = createMemoryAuthorization(entryAction({
    circleState: 'ENTRY_CHALLENGE', circleEntryRefId: `${ACTION_ID}:entry`, circleEntryTransactionId: discoveredId,
  }));
  const terminalLookupDependencies = {
    ...circleDependencies(terminalLookupAuthorization, null),
    circleService: {
      async findContractExecutionTransaction() { throw new Error('list_must_not_run_after_transaction_id'); },
      async getContractExecutionTransaction() { return { id: discoveredId, state: 'DENIED' }; },
    },
  };
  await assert.rejects(
    () => circleEntry.resolveCircleTransaction({
      auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough', phaseName: 'ENTRY',
    }, terminalLookupDependencies),
    /circle_transaction_failed/,
  );

  const receiptPendingAuthorization = createMemoryAuthorization(entryAction({
    circleState: 'ENTRY_CHALLENGE', circleEntryRefId: `${ACTION_ID}:entry`,
  }));
  const receiptPendingDependencies = circleDependencies(receiptPendingAuthorization, entryTransaction);
  receiptPendingDependencies.verifyCircleEntryReceipt = async () => { throw new Error('entry_transaction_not_found'); };
  assert.equal((await circleEntry.verifyCircleEntry({
    auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough',
  }, receiptPendingDependencies)).pending, true, 'a mined-hash lookup gap remains retryable');

  const approvalTxHash = `0x${'e'.repeat(64)}`;
  const lateApprovalAuthorization = createMemoryAuthorization(entryAction({
    circleState: 'APPROVAL_CHALLENGE',
    circleApprovalChallengeId: 'late-approval-challenge',
    circleApprovalRefId: `${ACTION_ID}:approval`,
    circleApprovalIdempotencyKey: '66666666-6666-4666-8666-666666666666',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  const lateApprovalDependencies = circleDependencies(lateApprovalAuthorization, {
    id: approvalTransaction.id, txHash: approvalTxHash, state: 'CONFIRMED',
  });
  await assert.rejects(
    () => circleEntry.verifyCircleApproval({
      auth, actionId: ACTION_ID, userToken: 'circle-user-token-long-enough',
    }, lateApprovalDependencies),
    /circle_entry_action_expired_after_approval/,
  );
  assert.equal(lateApprovalAuthorization.state.circleState, 'APPROVAL_VERIFIED');
  assert.equal(lateApprovalDependencies.created.length, 0, 'expired late approval must not create an entry challenge');

  const expired = { ...payload(), expiresAt: new Date(Date.now() - 60_000).toISOString() };
  let approvalRead = 0;
  const lateApproval = await execution.verifyCircleApprovalReceipt(expired, approvalTxHash, {
    readLiveState: async () => liveState(approvalRead++ === 0 ? 0n : 1_000_000n),
    readTransaction: async () => ({
      tx: {
        from: approval.transactionRequest.from, to: approval.transactionRequest.to,
        value: 0n, data: approval.transactionRequest.data,
      },
    }),
  });
  assert.equal(lateApproval.step, 'ENTRY_READY');
  await assert.rejects(
    () => execution.verifyExternalApprovalReceipt({ ...expired, executionMode: 'EXTERNAL_WALLET' }, approvalTxHash, {
      readLiveState: async () => liveState(0n), readTransaction: async () => ({ tx: {} }),
    }),
    /action_authorization_expired/,
  );

  const frontendSource = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../../app/lib/circle-entry.ts'), 'utf8',
  );
  assert.ok(frontendSource.indexOf('await sdk.getDeviceId()') < frontendSource.indexOf('sdk.setAuthentication(auth)'));
  assert.match(frontendSource, /readCircleEntryRecovery\(\)/);
  assert.match(frontendSource, /circle_pending_action_for_different_intent/);
  assert.match(frontendSource, /clearCircleEntryRecovery\(\)/);
  assert.match(frontendSource, /circle_entry_action_expired_after_approval/);
  assert.match(frontendSource, /transactionObserved/);
  assert.match(frontendSource, /const EXTREMA_SESSION_ERRORS = new Set/);
  assert.match(frontendSource, /withFreshExtremaCircleSession/);
  assert.match(frontendSource, /backendApi\.circle\s*\.session\(userToken\)/);

  // Both the one-shot probe (APPROVAL_CHALLENGE / ENTRY_CHALLENGE) and the
  // polling loop (APPROVAL_PENDING / ENTRY_PENDING) must call through the
  // exact same session-refresh-wrapped helper -- never the raw backendApi
  // function directly, and never a second, duplicated wrapper.
  const APPROVAL_ONCE_CALL_SITE = /verifyCircleApprovalOnce\(\s*recovery\.actionId,\s*userToken,?\s*\)/g;
  const ENTRY_ONCE_CALL_SITE = /verifyCircleEntryOnce\(\s*recovery\.actionId,\s*userToken,?\s*\)/g;
  assert.equal(
    (frontendSource.match(APPROVAL_ONCE_CALL_SITE) || []).length,
    2,
    'verifyCircleApprovalOnce must be called from exactly two places: the APPROVAL_CHALLENGE probe and the APPROVAL_PENDING poll',
  );
  assert.equal(
    (frontendSource.match(ENTRY_ONCE_CALL_SITE) || []).length,
    2,
    'verifyCircleEntryOnce must be called from exactly two places: the ENTRY_CHALLENGE probe and the ENTRY_PENDING poll',
  );

  const approvalProbeIndex = frontendSource.search(APPROVAL_ONCE_CALL_SITE);
  const entryProbeIndex = frontendSource.search(ENTRY_ONCE_CALL_SITE);
  const executeHostedChallengeIndices = [
    ...frontendSource.matchAll(/executeHostedChallenge\(recovery\.challengeId\)/g),
  ].map((match) => match.index);
  assert.equal(
    executeHostedChallengeIndices.length,
    2,
    'the hosted challenge must execute exactly once per phase: once for APPROVAL_CHALLENGE, once for ENTRY_CHALLENGE',
  );
  assert.ok(
    approvalProbeIndex >= 0 && approvalProbeIndex < executeHostedChallengeIndices[0],
    'the APPROVAL_CHALLENGE probe must happen before that phase executes the hosted challenge',
  );
  assert.ok(
    entryProbeIndex >= 0 && entryProbeIndex < executeHostedChallengeIndices[1],
    'the ENTRY_CHALLENGE probe must happen before that phase executes the hosted challenge',
  );

  const authorizationSource = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../src/services/actionAuthorizationService.js'),
    'utf8',
  );
  assert.match(
    authorizationSource,
    /const CIRCLE_ENTRY_TTL_MS = 30 \* 60 \* 1000;/,
  );
  assert.match(
    authorizationSource,
    /Date\.now\(\) \+ CIRCLE_ENTRY_TTL_MS/,
  );

  const pollIntervalMatch = frontendSource.match(
    /const CIRCLE_VERIFY_POLL_INTERVAL_MS = (\d+);/,
  );
  const pollAttemptsMatch = frontendSource.match(
    /const CIRCLE_VERIFY_MAX_ATTEMPTS = (\d+);/,
  );

  assert.ok(pollIntervalMatch, 'Circle poll interval constant is required');
  assert.ok(pollAttemptsMatch, 'Circle poll attempt constant is required');

  const pollIntervalMs = Number(pollIntervalMatch[1]);
  const pollAttempts = Number(pollAttemptsMatch[1]);

  assert.ok(
    Math.ceil(60_000 / pollIntervalMs) + 1 < 20,
    'Circle polling plus its preflight probe must stay below 20 requests/minute',
  );

  assert.ok(
    pollIntervalMs * pollAttempts >= 120_000,
    'Circle verification must tolerate at least two minutes of indexing/finality delay',
  );

  assert.equal(
    (frontendSource.match(/backendApi\.actions\.verifyCircleEntryApproval/g) || []).length,
    1,
    'all approval verification must flow through the session-refresh helper',
  );

  assert.equal(
    (frontendSource.match(/backendApi\.actions\.verifyCircleEntry\(/g) || []).length,
    1,
    'all entry verification must flow through the session-refresh helper',
  );

  assert.match(frontendSource, /result\?\.status === "FAILED"/);
  assert.match(frontendSource, /result\?\.status === "EXPIRED"/);

  const actionsSource = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../src/routes/actions.js'),
    'utf8',
  );

  assert.match(actionsSource, /const CIRCLE_VERIFY_LIMIT = 20;/);
  assert.match(
    actionsSource,
    /router\.post\('\/entry\/approval\/verify', entryApprovalVerifyLimiter,/,
  );
  assert.match(
    actionsSource,
    /router\.post\('\/entry\/verify', entryVerifyLimiter,/,
  );

  console.log('CIRCLE_ENTRY_FOUNDATION=PASS');
}

main().catch((error) => {
  console.error('CIRCLE_ENTRY_FOUNDATION=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
