'use strict';

// Local-only HTTP integration proof for the real actions router and auth
// middleware. It intentionally starts a test-only Express app instead of
// requiring src/server.js, whose production entrypoint listens immediately.
// All stateful or networked edges are replaced through require-cache before
// the router is loaded: no Postgres, Arc RPC, or Circle API can be reached.

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'verify-http-actions-e2e-only-secret-value';
process.env.CORS_ORIGINS = 'http://localhost:3000';

const express = require('express');
const { ZodError } = require('zod');
const { ethers } = require('ethers');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CIRCLE_WALLET_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const POOL = '0x5000000000000000000000000000000000000005';
const TICKET = '0x6000000000000000000000000000000000000006';
const SESSION_WALLET = '0x1000000000000000000000000000000000000001';
const ATTACKER_WALLET = '0x2000000000000000000000000000000000000002';
const DESTINATION = '0x3000000000000000000000000000000000000003';
const USER_TOKEN = 'circle-user-token-long-enough';
const PAYLOAD_HASH = 'http-e2e-payload-hash';
const TRANSFER_ACTION_ID = '55555555-5555-4555-8555-555555555555';
const TRANSFER_REQUEST_ID = '66666666-6666-4666-8666-666666666666';
const TRANSFER_PAYLOAD_HASH = 'http_e2e_transfer_payload_hash';

function installModule(relativePath, exports) {
  const filename = require.resolve(relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function circleAuth() {
  return {
    userId: USER_ID,
    ownerAddress: SESSION_WALLET,
    executionMode: 'CIRCLE_USER_WALLET',
    walletAddress: SESSION_WALLET,
    circleWalletId: CIRCLE_WALLET_ID,
    jti: 'active-circle-session',
  };
}

const activeSessions = new Map([
  ['active-circle-session', circleAuth()],
  ['mismatched-session', { ...circleAuth(), walletAddress: ATTACKER_WALLET }],
]);

installModule('../src/services/sessionService', {
  verifyToken(token) {
    const payload = (jti) => ({
      sub: USER_ID,
      ownerAddress: SESSION_WALLET,
      executionMode: 'CIRCLE_USER_WALLET',
      walletAddress: SESSION_WALLET,
      circleWalletId: CIRCLE_WALLET_ID,
      jti,
    });
    if (token === 'valid-circle-session') return payload('active-circle-session');
    if (token === 'mismatched-active-session') return payload('mismatched-session');
    if (token === 'expired-session') return payload('expired-session');
    throw new Error('invalid_token');
  },
  async getActiveSession(jti) { return activeSessions.get(jti) || null; },
});

const action = {
  id: ACTION_ID,
  payloadHash: PAYLOAD_HASH,
  expiresInSeconds: 120,
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  payload: null,
};
let actionCreated = 0;
let createOrGetCalls = 0;
let financialChallenges = 0;
let approvalCalls = 0;
let entryCalls = 0;
// Circle ticket transfer: one action per request ID, one challenge per action.
const transferActions = new Map();
let transferChallenges = 0;
let transferVerifyCalls = 0;
let ticketOwner = SESSION_WALLET;

installModule('../src/services/actionAuthorizationService', {
  async createOrGetCircleEntryRequest(input) {
    createOrGetCalls += 1;
    assert.equal(input.userId, USER_ID);
    assert.equal(input.walletAddress, SESSION_WALLET, 'request input must not override session wallet');
    assert.equal(input.circleWalletId, CIRCLE_WALLET_ID, 'request input must not override Circle wallet');
    assert.equal(input.poolAddress, POOL);
    assert.equal(input.roundId, 7);
    assert.equal(input.predictionPriceCents, 123_456);
    assert.equal(input.requestId, REQUEST_ID);
    if (!action.payload) {
      actionCreated += 1;
      action.payload = {
        action: 'ENTRY',
        walletAddress: SESSION_WALLET,
        circleWalletId: CIRCLE_WALLET_ID,
        poolAddress: POOL,
        roundId: 7,
        predictionPriceCents: 123_456,
      };
    }
    return action;
  },
  async createOrGetCircleActionRequest(input) {
    assert.equal(input.actionType, 'TRANSFER_TICKET');
    assert.equal(input.userId, USER_ID);
    assert.equal(input.walletAddress, SESSION_WALLET, 'request input must not override session wallet');
    assert.equal(input.circleWalletId, CIRCLE_WALLET_ID, 'request input must not override Circle wallet');
    assert.equal(input.ticketAddress, TICKET);
    assert.equal(input.tokenId, '1');
    assert.equal(input.destinationAddress, DESTINATION);
    if (!transferActions.has(input.requestId)) {
      transferActions.set(input.requestId, {
        id: TRANSFER_ACTION_ID,
        payloadHash: TRANSFER_PAYLOAD_HASH,
        expiresInSeconds: 1800,
        payload: {
          action: 'TRANSFER_TICKET',
          chainId: 5042002,
          contract: TICKET,
          tokenId: '1',
          from: SESSION_WALLET,
          destination: DESTINATION,
          walletAddress: SESSION_WALLET,
          executionMode: 'CIRCLE_USER_WALLET',
        },
      });
    }
    return transferActions.get(input.requestId);
  },
  async consumeExternalAction() {
    throw new Error('a Circle session must never consume a connected wallet authorization');
  },
});

const TICKET_OWNER_INTERFACE = new ethers.Interface(['function ownerOf(uint256 tokenId) view returns (address)']);

installModule('../src/services/arcService', {
  async getStandardRoundsState() {
    return { pools: [{ poolAddress: POOL, ticketAddress: TICKET, round: { roundId: 7, canEnter: true } }] };
  },
  // Read only ownerOf for the transfer start preflight. No signer exists.
  getArcProvider() {
    return {
      async call(tx) {
        assert.equal(ethers.getAddress(tx.to), ethers.getAddress(TICKET));
        return TICKET_OWNER_INTERFACE.encodeFunctionResult('ownerOf', [ticketOwner]);
      },
    };
  },
});

installModule('../src/services/circleActionExecutionService', {
  async startCircleAction({ actionType, action: stored, auth, userToken }) {
    assert.equal(actionType, 'TRANSFER_TICKET');
    assert.equal(auth.walletAddress, SESSION_WALLET);
    assert.equal(auth.circleWalletId, CIRCLE_WALLET_ID);
    assert.equal(userToken, USER_TOKEN);
    assert.equal(stored.id, TRANSFER_ACTION_ID);
    if (transferChallenges === 0) transferChallenges += 1;
    return {
      actionId: TRANSFER_ACTION_ID,
      payloadHash: TRANSFER_PAYLOAD_HASH,
      executionMode: 'CIRCLE_USER_WALLET',
      step: 'ACTION_READY',
      challengeId: 'transfer-challenge-1',
    };
  },
  async verifyCircleAction({ actionType, auth, actionId, userToken }) {
    assert.equal(actionType, 'TRANSFER_TICKET');
    assert.equal(auth.walletAddress, SESSION_WALLET);
    assert.equal(actionId, TRANSFER_ACTION_ID);
    assert.equal(userToken, USER_TOKEN);
    transferVerifyCalls += 1;
    if (transferVerifyCalls === 1) return { pending: true, transactionObserved: false };
    return {
      pending: false,
      action: { payloadHash: TRANSFER_PAYLOAD_HASH },
      result: { executionMode: 'CIRCLE_USER_WALLET', ownerAfter: DESTINATION },
    };
  },
  async verifyCircleActionApproval() {
    throw new Error('a transfer has no approval phase');
  },
});

installModule('../src/services/circleEntryExecutionService', {
  async startCircleEntry({ action: stored, auth, userToken }) {
    assert.equal(auth.walletAddress, SESSION_WALLET);
    assert.equal(auth.circleWalletId, CIRCLE_WALLET_ID);
    assert.equal(userToken, USER_TOKEN);
    assert.equal(stored.id, ACTION_ID);
    if (financialChallenges === 0) financialChallenges += 1;
    return {
      actionId: ACTION_ID,
      payloadHash: PAYLOAD_HASH,
      step: 'APPROVAL_REQUIRED',
      challengeId: 'approval-challenge-1',
    };
  },
  async verifyCircleApproval({ auth, actionId, userToken }) {
    assert.equal(auth.walletAddress, SESSION_WALLET);
    assert.equal(actionId, ACTION_ID);
    assert.equal(userToken, USER_TOKEN);
    approvalCalls += 1;
    if (approvalCalls === 1) return { pending: true, transactionObserved: false };
    return { payloadHash: PAYLOAD_HASH, approvalTxHash: `0x${'a'.repeat(64)}`, challengeId: 'entry-challenge-1' };
  },
  async verifyCircleEntry({ auth, actionId, userToken }) {
    assert.equal(auth.walletAddress, SESSION_WALLET);
    assert.equal(actionId, ACTION_ID);
    assert.equal(userToken, USER_TOKEN);
    entryCalls += 1;
    if (entryCalls === 1) return { pending: true, transactionObserved: true };
    return {
      action,
      result: { poolAddress: POOL, roundId: 7, predictionPriceCents: 123_456 },
    };
  },
});

// Load production code only after all stateful boundaries above have been
// installed. No route handler is replaced.
const actionsRouter = require('../src/routes/actions');

function createTestApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/actions', actionsRouter);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: 'invalid_request',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    // The production safe error behaviour for the execution mode boundary
    // exercised below. All other unexpected errors remain generic to keep
    // the test server's surface safe as well.
    if (error?.message === 'wallet_execution_mode_mismatch') {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'internal_server_error' });
  });
  return app;
}

async function request(baseUrl, pathname, body, token = 'valid-circle-session') {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function assertSafeInvalidRequest(response, field) {
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid_request');
  assert.ok(Array.isArray(response.body.details));
  assert.ok(response.body.details.some((issue) => issue.path === field));
  assert.equal(JSON.stringify(response.body).includes('ZodError'), false);
  assert.equal(JSON.stringify(response.body).includes('stack'), false);
}

async function main() {
  const server = http.createServer(createTestApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const startBody = {
    poolAddress: POOL,
    roundId: 7,
    predictionPriceCents: 123_456,
    circleUserToken: USER_TOKEN,
    circleRequestId: REQUEST_ID,
    walletAddress: ATTACKER_WALLET,
    circleWalletId: '99999999-9999-4999-8999-999999999999',
  };

  try {
    const noAuth = await request(baseUrl, '/api/actions/entry/start', startBody, null);
    assert.deepEqual(noAuth, { status: 401, body: { error: 'authentication_required' } });

    const invalid = await request(baseUrl, '/api/actions/entry/start', startBody, 'mismatched-active-session');
    assert.deepEqual(invalid, { status: 401, body: { error: 'invalid_session' } });
    const expired = await request(baseUrl, '/api/actions/entry/start', startBody, 'expired-session');
    assert.deepEqual(expired, { status: 401, body: { error: 'session_expired' } });

    const started = await request(baseUrl, '/api/actions/entry/start', startBody);
    assert.equal(started.status, 200);
    assert.equal(started.body.actionId, ACTION_ID);
    assert.equal(started.body.payloadHash, PAYLOAD_HASH);
    assert.equal(started.body.step, 'APPROVAL_REQUIRED');
    assert.equal(started.body.challengeId, 'approval-challenge-1');
    assert.equal(actionCreated, 1);
    assert.equal(financialChallenges, 1);

    const approvalPending = await request(baseUrl, '/api/actions/entry/approval/verify', { actionId: ACTION_ID, circleUserToken: USER_TOKEN });
    assert.deepEqual(approvalPending, { status: 202, body: { pending: true, actionId: ACTION_ID, transactionObserved: false } });
    const approvalConfirmed = await request(baseUrl, '/api/actions/entry/approval/verify', { actionId: ACTION_ID, circleUserToken: USER_TOKEN });
    assert.equal(approvalConfirmed.status, 200);
    assert.equal(approvalConfirmed.body.confirmed, true);
    assert.equal(approvalConfirmed.body.step, 'ENTRY_READY');
    assert.equal(approvalConfirmed.body.actionId, ACTION_ID);
    assert.equal(approvalConfirmed.body.payloadHash, PAYLOAD_HASH);
    assert.equal(approvalConfirmed.body.challengeId, 'entry-challenge-1');

    const entryPending = await request(baseUrl, '/api/actions/entry/verify', { actionId: ACTION_ID, circleUserToken: USER_TOKEN });
    assert.deepEqual(entryPending, { status: 202, body: { pending: true, actionId: ACTION_ID, transactionObserved: true } });
    const entryConfirmed = await request(baseUrl, '/api/actions/entry/verify', { actionId: ACTION_ID, circleUserToken: USER_TOKEN });
    assert.equal(entryConfirmed.status, 200);
    assert.equal(entryConfirmed.body.confirmed, true);
    assert.equal(entryConfirmed.body.actionId, ACTION_ID);
    assert.equal(entryConfirmed.body.payloadHash, PAYLOAD_HASH);
    assert.deepEqual(entryConfirmed.body.result, { poolAddress: POOL, roundId: 7, predictionPriceCents: 123_456 });

    const replay = await request(baseUrl, '/api/actions/entry/start', startBody);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.actionId, ACTION_ID);
    assert.equal(replay.body.payloadHash, PAYLOAD_HASH);
    assert.equal(actionCreated, 1, 'replay must not create a second action');
    assert.equal(financialChallenges, 1, 'replay must not create a second financial challenge');
    assert.equal(createOrGetCalls, 2);

    // Circle ticket transfer through the real router: session bound wallet,
    // Circle credentials required, idempotent replay, pending then verified.
    const transferBody = {
      ticketAddress: TICKET,
      tokenId: '1',
      destinationAddress: DESTINATION,
      circleUserToken: USER_TOKEN,
      circleRequestId: TRANSFER_REQUEST_ID,
      walletAddress: ATTACKER_WALLET,
      circleWalletId: '99999999-9999-4999-8999-999999999999',
    };
    const transferNoCredentials = await request(baseUrl, '/api/actions/ticket-transfer/start', {
      ticketAddress: TICKET, tokenId: '1', destinationAddress: DESTINATION,
    });
    assert.deepEqual(transferNoCredentials, { status: 409, body: { error: 'circle_reauthentication_required' } });
    const transferMismatched = await request(baseUrl, '/api/actions/ticket-transfer/start', transferBody, 'mismatched-active-session');
    assert.deepEqual(transferMismatched, { status: 401, body: { error: 'invalid_session' } });

    ticketOwner = ATTACKER_WALLET;
    const transferNotOwner = await request(baseUrl, '/api/actions/ticket-transfer/start', transferBody);
    assert.deepEqual(transferNotOwner, { status: 409, body: { error: 'transfer_not_ticket_owner' } });
    assert.equal(transferActions.size, 0, 'no action exists for a ticket the session does not own');
    ticketOwner = SESSION_WALLET;

    const transferStarted = await request(baseUrl, '/api/actions/ticket-transfer/start', transferBody);
    assert.equal(transferStarted.status, 200);
    assert.equal(transferStarted.body.actionId, TRANSFER_ACTION_ID);
    assert.equal(transferStarted.body.executionMode, 'CIRCLE_USER_WALLET');
    assert.equal(transferStarted.body.step, 'ACTION_READY');
    assert.equal(transferStarted.body.challengeId, 'transfer-challenge-1');
    assert.equal(transferStarted.body.action.walletAddress, SESSION_WALLET, 'the bound payload names the session wallet');
    assert.equal(transferStarted.body.action.destination, DESTINATION);

    const transferReplay = await request(baseUrl, '/api/actions/ticket-transfer/start', transferBody);
    assert.equal(transferReplay.body.actionId, TRANSFER_ACTION_ID);
    assert.equal(transferReplay.body.challengeId, 'transfer-challenge-1');
    assert.equal(transferActions.size, 1, 'replay must not create a second transfer action');
    assert.equal(transferChallenges, 1, 'replay must not create a second transfer challenge');

    const transferFinish = await request(baseUrl, '/api/actions/ticket-transfer/finish', { actionId: TRANSFER_ACTION_ID });
    assert.deepEqual(transferFinish, { status: 400, body: { error: 'wallet_execution_mode_mismatch' } },
      'the connected wallet finish step is refused to a Circle session');

    assertSafeInvalidRequest(
      await request(baseUrl, '/api/actions/ticket-transfer/verify', { actionId: TRANSFER_ACTION_ID, txHash: `0x${'b'.repeat(64)}` }),
      'circleUserToken',
    );
    const transferPending = await request(baseUrl, '/api/actions/ticket-transfer/verify', { actionId: TRANSFER_ACTION_ID, circleUserToken: USER_TOKEN });
    assert.deepEqual(transferPending, { status: 202, body: { pending: true, actionId: TRANSFER_ACTION_ID, transactionObserved: false } });
    const transferConfirmed = await request(baseUrl, '/api/actions/ticket-transfer/verify', { actionId: TRANSFER_ACTION_ID, circleUserToken: USER_TOKEN });
    assert.equal(transferConfirmed.status, 200);
    assert.equal(transferConfirmed.body.confirmed, true);
    assert.equal(transferConfirmed.body.executionMode, 'CIRCLE_USER_WALLET');
    assert.equal(transferConfirmed.body.payloadHash, TRANSFER_PAYLOAD_HASH);
    assert.equal(transferConfirmed.body.result.ownerAfter, DESTINATION);

    assertSafeInvalidRequest(await request(baseUrl, '/api/actions/entry/start', { ...startBody, roundId: '7' }), 'roundId');
    assertSafeInvalidRequest(await request(baseUrl, '/api/actions/entry/start', { ...startBody, poolAddress: 'not-an-address' }), 'poolAddress');
    assertSafeInvalidRequest(await request(baseUrl, '/api/actions/entry/start', { ...startBody, circleRequestId: 'not-a-uuid' }), 'circleRequestId');

    // The first two approval calls above plus these 18 fill only the approval
    // limiter. A subsequent entry verification must still pass its separate
    // quota; detailed limiter arithmetic remains in verify-circle-entry-behavior.
    for (let index = 0; index < 18; index += 1) {
      const response = await request(baseUrl, '/api/actions/entry/approval/verify', { actionId: ACTION_ID, circleUserToken: USER_TOKEN });
      assert.equal(response.status, 200);
    }
    const independentVerify = await request(baseUrl, '/api/actions/entry/verify', { actionId: ACTION_ID, circleUserToken: USER_TOKEN });
    assert.notEqual(independentVerify.status, 429, 'approval verifier quota must not consume entry verifier quota');

    console.log('HTTP_ACTIONS_E2E=PASS');
    console.log('HTTP_SCENARIOS=auth,session,circle_start,approval,entry,replay,circle_transfer,validation,rate_limit');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

main().catch((error) => {
  console.error('HTTP_ACTIONS_E2E=FAIL');
  console.error(error.stack || error);
  process.exitCode = 1;
});
