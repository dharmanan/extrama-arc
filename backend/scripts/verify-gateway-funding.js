'use strict';

// Deterministic Gateway transfer lifecycle proof. It uses the real burn-intent
// cryptography and durable transfer state machine with in-memory DB/Circle/
// forwarding adapters. It never contacts Gateway, Circle, Arc, or PostgreSQL;
// the forwarding client is reached only through a mock.
//
// The product contract proved here is destination-selected and
// source-allocated: start() takes a destinationDomain and an amount, and the
// source plan is derived server-side. Multi-source planning, destination
// generalization and same-chain withdrawal have their own proof in
// verify-gateway-transfer-plan.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

const {
  buildGatewayBurnIntent,
  buildGatewayTransferSpec,
  planSourceAllocation,
} = require('../src/services/gatewayService');
const { createGatewayFundingService } = require('../src/services/gatewayFundingService');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CIRCLE_WALLET_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const ARC_DOMAIN = 26;
const wallet = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const auth = {
  userId: USER_ID,
  circleWalletId: CIRCLE_WALLET_ID,
  walletAddress: wallet.address,
  executionMode: 'CIRCLE_USER_WALLET',
};

let liveNetworkCalls = 0;
global.fetch = async () => {
  liveNetworkCalls += 1;
  throw new Error('live network disabled in deterministic verifier');
};

const rows = new Map();
function copy(row) { return row ? JSON.parse(JSON.stringify(row)) : null; }
function out(row) { return { rows: row ? [copy(row)] : [], rowCount: row ? 1 : 0 }; }
// node-pg hands a JSONB column back as parsed JS, so the fake parses on write
// to keep the read shape identical to production.
function jsonb(value) { return value === null || value === undefined ? null : JSON.parse(value); }

const fakeDb = {
  async query(sql, params) {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('INSERT INTO gateway_funding_actions')) {
      const [
        id, userId, executionMode, circleWalletId, walletAddress,
        requestId, destinationDomain, valueRaw, signRequestId, expiresAt,
      ] = params;
      const existing = [...rows.values()].find((row) => row.user_id === userId && row.request_id === requestId);
      if (existing) return out(null);
      rows.set(id, {
        id, user_id: userId, execution_mode: executionMode,
        circle_wallet_id: circleWalletId, wallet_address: walletAddress,
        request_id: requestId, destination_domain: destinationDomain,
        source_domain: null, value_raw: valueRaw,
        circle_sign_request_id: signRequestId, state: 'PREPARING', expires_at: expiresAt,
        payload_hash: null, source_plan_json: null,
        burn_intents_json: null, burn_intents_json_text: null, typed_data_list_json: null,
        signatures_json: null, circle_sign_challenges_json: null,
        burn_intent_json: null, burn_intent_json_text: null, typed_data_json: null,
        circle_sign_challenge_id: null, signature: null, last_error: null,
        gateway_transfer_id: null, gateway_transaction_hash: null,
      });
      return out(null);
    }
    if (text.startsWith('SELECT * FROM gateway_funding_actions')) {
      const row = [...rows.values()].find((candidate) => {
        if (params.length === 2) return candidate.user_id === params[0] && candidate.request_id === params[1];
        return candidate.id === params[0] && candidate.user_id === params[1] &&
          candidate.execution_mode === params[2] &&
          candidate.wallet_address.toLowerCase() === params[3].toLowerCase();
      });
      return out(row || null);
    }
    const row = rows.get(params[0]);
    if (!row) return out(null);
    if (text.includes("state = 'EXPIRED'")) {
      if (row.state !== 'READY_TO_BROADCAST') row.state = 'EXPIRED';
      return out(row);
    }
    if (text.includes('payload_hash = $2')) {
      if (row.state !== 'PREPARING') return out(null);
      row.payload_hash = params[1];
      row.source_plan_json = jsonb(params[2]);
      row.burn_intents_json = jsonb(params[3]);
      row.burn_intents_json_text = params[4];
      row.typed_data_list_json = jsonb(params[5]);
      row.signatures_json = jsonb(params[6]);
      row.circle_sign_challenges_json = jsonb(params[7]);
      row.source_domain = params[8];
      row.burn_intent_json = jsonb(params[9]);
      row.burn_intent_json_text = params[10];
      row.typed_data_json = jsonb(params[11]);
      row.max_fee_raw = params[12];
      row.max_block_height = params[13];
      row.estimate_fees_json = jsonb(params[14]);
      row.state = params[15];
      row.last_error = null;
      return out(row);
    }
    if (text.includes('circle_sign_challenges_json = $2')) {
      if (!['SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING'].includes(row.state)) return out(null);
      row.circle_sign_challenges_json = jsonb(params[1]);
      if (params[2] && !row.circle_sign_challenge_id) row.circle_sign_challenge_id = params[2];
      row.state = 'SIGNATURE_PENDING';
      row.last_error = null;
      return out(row);
    }
    if (text.includes("state = 'SIGNATURE_FAILED'")) {
      row.state = 'SIGNATURE_FAILED'; row.last_error = 'gateway_signature_challenge_failed';
      return out(null);
    }
    if (text.includes('SET signatures_json = $2')) {
      if (row.state !== 'SIGNATURE_PENDING') return out(null);
      row.signatures_json = jsonb(params[1]);
      if (params[2] && !row.signature) row.signature = params[2];
      row.state = params[3];
      row.last_error = null;
      return out(row);
    }
    if (text.includes('gateway_transfer_id = COALESCE')) {
      row.state = params[1];
      if (params[2]) row.gateway_transfer_id = params[2];
      if (params[3]) row.gateway_transaction_hash = params[3];
      row.last_error = params[4];
      return out(row);
    }
    if (text.includes("state = 'SUBMITTING'")) {
      if (row.state === 'READY_TO_BROADCAST') {
        row.state = 'SUBMITTING'; row.last_error = null;
        return out(row);
      }
      return out(null);
    }
    if (text.includes('SET last_error = $2')) {
      row.last_error = params[1];
      return out(null);
    }
    throw new Error(`unhandled SQL: ${text}`);
  },
};

let challengeStatus = 'PENDING';
let challengeCreates = 0;
let submitCalls = 0;
let statusCalls = 0;
let remoteStatus = 'pending';
let lastSubmittedRequests = null;
const fakeCircle = {
  async createTypedDataChallenge(input) {
    challengeCreates += 1;
    assert.equal(input.walletId, CIRCLE_WALLET_ID);
    assert.equal(input.typedData.primaryType, 'BurnIntent');
    return { challengeId: `gateway-sign-challenge-${challengeCreates}` };
  },
  async getTypedDataChallenge({ challengeId }) {
    assert.match(challengeId, /^gateway-sign-challenge-\d+$/);
    return { id: challengeId, type: 'SIGN_TYPEDDATA', status: challengeStatus };
  },
};

const fakeGateway = {
  async readUnifiedUsdcBalance(address) {
    assert.equal(address.toLowerCase(), wallet.address.toLowerCase());
    return {
      balances: [{ domain: 6, balanceRaw: '2500000', transferable: true }],
    };
  },
  buildGatewayTransferSpec,
  planSourceAllocation,
  async estimateGatewayTransfer(specs) {
    assert.ok(Array.isArray(specs));
    return {
      intents: specs.map(() => ({ maxFeeRaw: '10000', maxBlockHeight: '999999999' })),
      fees: { token: 'USDC' },
    };
  },
  buildGatewayBurnIntent,
  recoverBurnIntentSigner(typedData, signature) {
    return ethers.verifyTypedData(typedData.domain, typedData.types, typedData.message, signature);
  },
  ARC_GATEWAY_DOMAIN: ARC_DOMAIN,
  async submitGatewayTransfer({ requests, requestId }) {
    submitCalls += 1;
    lastSubmittedRequests = requests;
    assert.ok(Array.isArray(requests) && requests.length >= 1);
    for (const entry of requests) {
      assert.equal(entry.burnIntent.spec.destinationDomain, ARC_DOMAIN);
      assert.equal(typeof entry.signature, 'string');
    }
    assert.equal(requestId.length, 36);
    return { transferId: '55555555-5555-4555-8555-555555555555' };
  },
  async readGatewayTransferStatus(transferId) {
    statusCalls += 1;
    assert.equal(transferId, '55555555-5555-4555-8555-555555555555');
    return {
      status: remoteStatus,
      transactionHash: ['completed', 'confirmed', 'finalized'].includes(remoteStatus)
        ? `0x${'ab'.repeat(32)}` : null,
      forwardingFailure: null,
    };
  },
};

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error?.message === code);
}

function verifyPreparingSchemaLifecycle() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const createStart = schema.indexOf('CREATE TABLE IF NOT EXISTS gateway_funding_actions');
  const createEnd = schema.indexOf('\n);', createStart);
  const createTable = schema.slice(createStart, createEnd);
  assert.ok(createStart > -1 && createEnd > createStart);
  assert.match(createTable, /source_domain INTEGER,/, 'PREPARING must be insertable before source planning');
  assert.doesNotMatch(createTable, /source_domain INTEGER NOT NULL/);
  assert.match(schema, /DROP CONSTRAINT IF EXISTS gateway_funding_actions_plan_check/);
  assert.match(
    schema,
    /ADD CONSTRAINT gateway_funding_actions_plan_check CHECK \(\s*state = 'PREPARING' OR source_domain IS NOT NULL OR source_plan_json IS NOT NULL\s*\)/,
  );

  // This mirrors PostgreSQL CHECK semantics explicitly: the durable row may
  // begin empty, but every later state needs legacy source or complete plan.
  const accepts = (row) => row.state === 'PREPARING'
    || row.source_domain !== null
    || row.source_plan_json !== null;
  assert.equal(accepts({ state: 'PREPARING', source_domain: null, source_plan_json: null }), true);
  assert.equal(accepts({ state: 'SIGNATURE_PENDING', source_domain: null, source_plan_json: [] }), true);
  assert.equal(accepts({ state: 'READY_TO_BROADCAST', source_domain: null, source_plan_json: null }), false);
  assert.equal(accepts({ state: 'READY_TO_BROADCAST', source_domain: 6, source_plan_json: null }), true);
  console.log('GATEWAY_DB_PREPARING_ROW_VALID=PASS');
}

(async () => {
  verifyPreparingSchemaLifecycle();
  const service = createGatewayFundingService({
    database: fakeDb,
    gateway: fakeGateway,
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });
  const started = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: REQUEST_ID,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  assert.equal(started.state, 'SIGNATURE_PENDING');
  assert.equal(started.challengeId, 'gateway-sign-challenge-1');
  assert.equal(started.broadcast, 'NOT_SUBMITTED');
  assert.equal(challengeCreates, 1);
  // The browser never chose a source. The server resolved exactly one.
  assert.deepEqual(started.sourcePlan, [{ sourceDomain: 6, valueRaw: '1000000' }]);
  assert.equal(started.intentCount, 1);
  assert.equal(started.destinationDomain, ARC_DOMAIN);
  assert.equal(started.destinationLabel, 'Arc Testnet');
  assert.equal(started.signatureIndex, 0);

  const replay = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: REQUEST_ID,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  assert.equal(replay.actionId, started.actionId);
  assert.equal(replay.payloadHash, started.payloadHash);
  assert.deepEqual(replay.sourcePlan, started.sourcePlan, 'plan replay is identical');
  assert.equal(challengeCreates, 1, 'same request never creates a second challenge');

  await rejectsCode(
    () => service.start({
      auth,
      userToken: 'circle_user_token_long_enough',
      requestId: REQUEST_ID,
      destinationDomain: ARC_DOMAIN,
      valueRaw: '1000001',
    }),
    'gateway_request_id_conflict',
  );
  // A replayed request id may not silently change the destination either.
  await rejectsCode(
    () => service.start({
      auth,
      userToken: 'circle_user_token_long_enough',
      requestId: REQUEST_ID,
      destinationDomain: 6,
      valueRaw: '1000000',
    }),
    'gateway_request_id_conflict',
  );

  // An unsupported destination never reaches preparation.
  await rejectsCode(
    () => service.start({
      auth,
      userToken: 'circle_user_token_long_enough',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      destinationDomain: 7,
      valueRaw: '1000000',
    }),
    'gateway_destination_domain_unsupported',
  );

  const pending = await service.verifySignature({
    auth, actionId: started.actionId, userToken: 'circle_user_token_long_enough',
  });
  assert.equal(pending.pending, true);

  challengeStatus = 'COMPLETE';
  const row = rows.get(started.actionId);
  const typedData = row.typed_data_list_json[0];
  const signature = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  const ready = await service.verifySignature({
    auth, actionId: started.actionId, userToken: 'circle_user_token_long_enough', signature,
  });
  assert.equal(ready.state, 'READY_TO_BROADCAST');
  assert.equal(ready.readyToBroadcast, true);
  assert.equal(ready.broadcast, 'NOT_SUBMITTED');
  assert.equal(ready.signatureIndex, -1);
  assert.deepEqual(rows.get(started.actionId).signatures_json, [signature]);

  const submitted = await service.submit({ auth, actionId: started.actionId });
  assert.equal(submitted.state, 'SUBMITTED');
  assert.equal(submitted.transferId, '55555555-5555-4555-8555-555555555555');
  assert.equal(submitCalls, 1);
  // The submitted object is exactly the persisted, signed object.
  assert.equal(lastSubmittedRequests.length, 1);
  assert.deepEqual(lastSubmittedRequests[0].burnIntent, rows.get(started.actionId).burn_intents_json[0]);
  assert.equal(lastSubmittedRequests[0].signature, signature);

  const replaySubmit = await service.submit({ auth, actionId: started.actionId });
  assert.equal(replaySubmit.state, 'SUBMITTED');
  assert.equal(submitCalls, 1, 'replay cannot submit a second transfer');
  const pendingStatus = await service.status({ auth, actionId: started.actionId });
  assert.equal(pendingStatus.state, 'SUBMITTED');
  assert.equal(statusCalls, 1);
  remoteStatus = 'confirmed';
  const completed = await service.status({ auth, actionId: started.actionId });
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.broadcast, 'COMPLETED');
  assert.equal(completed.transactionHash, `0x${'ab'.repeat(32)}`);

  const other = new ethers.Wallet(`0x${'22'.repeat(32)}`);
  const badSignature = await other.signTypedData(
    typedData.domain, typedData.types, typedData.message,
  );
  const secondRequest = '44444444-4444-4444-8444-444444444444';
  const second = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: secondRequest,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  challengeStatus = 'COMPLETE';
  await rejectsCode(
    () => service.verifySignature({
      auth, actionId: second.actionId, userToken: 'circle_user_token_long_enough', signature: badSignature,
    }),
    'gateway_signature_wallet_mismatch',
  );

  async function readyAction(requestId) {
    const startedAction = await service.start({
      auth,
      userToken: 'circle_user_token_long_enough',
      requestId,
      destinationDomain: ARC_DOMAIN,
      valueRaw: '1000000',
    });
    const actionRow = rows.get(startedAction.actionId);
    const actionTypedData = actionRow.typed_data_list_json[0];
    const actionSignature = await wallet.signTypedData(
      actionTypedData.domain, actionTypedData.types, actionTypedData.message,
    );
    challengeStatus = 'COMPLETE';
    const actionReady = await service.verifySignature({
      auth, actionId: startedAction.actionId, userToken: 'circle_user_token_long_enough', signature: actionSignature,
    });
    assert.equal(actionReady.state, 'READY_TO_BROADCAST');
    return actionReady.actionId;
  }

  // Tampering with any bound field of a prepared payload fails closed before
  // submission, whichever field it is.
  const mutations = [
    ['77777777-7777-4777-8777-777777777777', (intent) => { intent.spec.sourceDomain = 0; }],
    ['88888888-8888-4888-8888-888888888888', (intent) => { intent.spec.value = '999999'; }],
    ['aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa', (intent) => { intent.spec.destinationDomain = 6; }],
    ['aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa', (intent) => {
      intent.spec.destinationRecipient = ethers.zeroPadValue(other.address, 32);
    }],
    ['aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaaa', (intent) => {
      intent.spec.destinationToken = ethers.zeroPadValue(other.address, 32);
    }],
  ];
  for (const [requestId, mutate] of mutations) {
    const actionId = await readyAction(requestId);
    const target = rows.get(actionId);
    target.burn_intents_json = JSON.parse(JSON.stringify(target.burn_intents_json));
    mutate(target.burn_intents_json[0]);
    target.burn_intent_json = target.burn_intents_json[0];
    target.burn_intent_json_text = JSON.stringify(target.burn_intents_json[0]);
    await rejectsCode(
      () => service.submit({ auth, actionId }),
      'gateway_funding_payload_mismatch',
    );
  }

  // Total unified balance below the requested value fails closed, even though
  // the balance is spread across two domains.
  const thinGateway = {
    ...fakeGateway,
    async readUnifiedUsdcBalance() {
      return {
        balances: [
          { domain: 6, balanceRaw: '500000', transferable: true },
          { domain: 0, balanceRaw: '400000', transferable: true },
        ],
      };
    },
  };
  const thinService = createGatewayFundingService({
    database: fakeDb,
    gateway: thinGateway,
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });
  await rejectsCode(
    () => thinService.start({
      auth,
      userToken: 'circle_user_token_long_enough',
      requestId: '99999999-9999-4999-8999-999999999999',
      destinationDomain: ARC_DOMAIN,
      valueRaw: '1000000',
    }),
    'gateway_insufficient_usdc',
  );

  // A timeout/ambiguous POST is never retried. The operation is durable and
  // can only progress through the status endpoint.
  let ambiguousSubmitCalls = 0;
  const ambiguousGateway = {
    ...fakeGateway,
    async submitGatewayTransfer() {
      ambiguousSubmitCalls += 1;
      throw new Error('gateway_transfer_submit_unknown');
    },
  };
  const ambiguousService = createGatewayFundingService({
    database: fakeDb, gateway: ambiguousGateway, circle: fakeCircle, runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });
  const ambiguousRequest = '66666666-6666-4666-8666-666666666666';
  const ambiguousStart = await ambiguousService.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: ambiguousRequest,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  const ambiguousRow = rows.get(ambiguousStart.actionId);
  const ambiguousTypedData = ambiguousRow.typed_data_list_json[0];
  const ambiguousSignature = await wallet.signTypedData(
    ambiguousTypedData.domain, ambiguousTypedData.types, ambiguousTypedData.message,
  );
  challengeStatus = 'COMPLETE';
  await ambiguousService.verifySignature({
    auth, actionId: ambiguousStart.actionId, userToken: 'circle_user_token_long_enough', signature: ambiguousSignature,
  });
  const unknown = await ambiguousService.submit({ auth, actionId: ambiguousStart.actionId });
  assert.equal(unknown.state, 'RECONCILIATION_REQUIRED');
  assert.equal(ambiguousSubmitCalls, 1);
  const unknownReplay = await ambiguousService.submit({ auth, actionId: ambiguousStart.actionId });
  assert.equal(unknownReplay.state, 'RECONCILIATION_REQUIRED');
  assert.equal(ambiguousSubmitCalls, 1);
  const recovered = await ambiguousService.status({ auth, actionId: ambiguousStart.actionId });
  assert.equal(recovered.state, 'RECONCILIATION_REQUIRED');

  // Explicit server gate remains closed by default, independent of browser
  // retries or refreshes.
  const gatedService = createGatewayFundingService({ database: fakeDb, gateway: fakeGateway, circle: fakeCircle });
  await rejectsCode(
    () => gatedService.submit({ auth, actionId: started.actionId }),
    'gateway_broadcast_disabled',
  );

  // -------------------------------------------------------------------
  // Historical compatibility: a row written by the Arc-only, single-source
  // implementation has no destination_domain, no source_plan_json and no
  // array columns at all. It must still read as an Arc transfer from its one
  // source domain, and still reconcile.
  // -------------------------------------------------------------------
  const legacyActionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const legacySpec = buildGatewayTransferSpec({
    walletAddress: wallet.address, sourceDomain: 6, destinationDomain: ARC_DOMAIN, valueRaw: '2000000',
  });
  const legacyBuilt = buildGatewayBurnIntent({
    walletAddress: wallet.address,
    sourceDomain: 6,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '2000000',
    maxFeeRaw: '10000',
    maxBlockHeight: '999999999',
    salt: legacySpec.salt,
  });
  const legacySignature = await wallet.signTypedData(
    legacyBuilt.typedData.domain, legacyBuilt.typedData.types, legacyBuilt.typedData.message,
  );
  const crypto = require('crypto');
  rows.set(legacyActionId, {
    id: legacyActionId,
    user_id: USER_ID,
    execution_mode: 'CIRCLE_USER_WALLET',
    circle_wallet_id: CIRCLE_WALLET_ID,
    wallet_address: wallet.address,
    request_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    // Exactly as the old schema wrote it.
    destination_domain: null,
    source_domain: 6,
    value_raw: '2000000',
    source_plan_json: null,
    burn_intents_json: null,
    burn_intents_json_text: null,
    typed_data_list_json: null,
    signatures_json: null,
    circle_sign_challenges_json: null,
    burn_intent_json: legacyBuilt.burnIntent,
    burn_intent_json_text: JSON.stringify(legacyBuilt.burnIntent),
    typed_data_json: legacyBuilt.typedData,
    payload_hash: crypto.createHash('sha256')
      .update(JSON.stringify(legacyBuilt.burnIntent)).digest('hex'),
    signature: legacySignature,
    circle_sign_challenge_id: 'gateway-sign-challenge-legacy',
    circle_sign_request_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    state: 'READY_TO_BROADCAST',
    last_error: null,
    gateway_transfer_id: null,
    gateway_transaction_hash: null,
    expires_at: new Date(Date.now() + 60_000),
  });

  const legacyRead = await service.get({ auth, actionId: legacyActionId });
  assert.equal(legacyRead.destinationDomain, ARC_DOMAIN, 'a historical row still reads as an Arc transfer');
  assert.deepEqual(legacyRead.sourcePlan, [{ sourceDomain: 6, valueRaw: '2000000' }]);
  assert.equal(legacyRead.intentCount, 1);
  assert.equal(legacyRead.signatureIndex, -1, 'its single stored signature still counts as complete');
  const legacySubmitted = await service.submit({ auth, actionId: legacyActionId });
  assert.equal(legacySubmitted.state, 'SUBMITTED', 'historical proof is still submittable and reconcilable');
  assert.equal(lastSubmittedRequests.length, 1);
  assert.equal(lastSubmittedRequests[0].signature, legacySignature);

  // -------------------------------------------------------------------
  // EXTERNAL_WALLET: one canonical state machine, no Circle challenge at
  // all. The server returns typed data directly; the connected wallet signs
  // it locally, and the backend recovers/compares the signer exactly the
  // same way it does for Circle.
  // -------------------------------------------------------------------
  const externalWallet = new ethers.Wallet(`0x${'33'.repeat(32)}`);
  const externalAuth = {
    userId: '77777777-7777-4777-8777-777777777777',
    walletAddress: externalWallet.address,
    executionMode: 'EXTERNAL_WALLET',
  };
  const externalGateway = {
    ...fakeGateway,
    async readUnifiedUsdcBalance(address) {
      assert.equal(address.toLowerCase(), externalWallet.address.toLowerCase());
      return { balances: [{ domain: 6, balanceRaw: '2500000', transferable: true }] };
    },
  };
  const externalService = createGatewayFundingService({
    database: fakeDb, gateway: externalGateway, circle: fakeCircle,
  });
  const challengeCreatesBeforeExternal = challengeCreates;

  const externalStarted = await externalService.start({
    auth: externalAuth,
    requestId: '88888888-8888-4888-8888-888888888889',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  assert.equal(externalStarted.state, 'SIGNATURE_PENDING');
  assert.equal(externalStarted.challengeId, null, 'external mode never creates a Circle challenge');
  assert.equal(externalStarted.executionMode, 'EXTERNAL_WALLET');
  assert.equal(externalStarted.typedDataList.length, 1);
  assert.equal(externalStarted.typedDataList[0].primaryType, 'BurnIntent');
  assert.equal(challengeCreates, challengeCreatesBeforeExternal, 'external mode must never call Circle at all');

  const externalTypedData = externalStarted.typedDataList[0];

  // A signature from the wrong signer is rejected.
  const wrongSigner = new ethers.Wallet(`0x${'44'.repeat(32)}`);
  const wrongSignature = await wrongSigner.signTypedData(
    externalTypedData.domain, externalTypedData.types, externalTypedData.message,
  );
  await rejectsCode(
    () => externalService.verifySignature({
      auth: externalAuth, actionId: externalStarted.actionId, signature: wrongSignature,
    }),
    'gateway_signature_wallet_mismatch',
  );

  // A signature over a modified intent (correct signer, different message)
  // recovers to a different address for the STORED intent and is rejected
  // the same way: the browser can never redirect what actually gets signed.
  const tamperedMessage = {
    ...externalTypedData.message,
    spec: { ...externalTypedData.message.spec, value: '2000000' },
  };
  const tamperedSignature = await externalWallet.signTypedData(
    externalTypedData.domain, externalTypedData.types, tamperedMessage,
  );
  await rejectsCode(
    () => externalService.verifySignature({
      auth: externalAuth, actionId: externalStarted.actionId, signature: tamperedSignature,
    }),
    'gateway_signature_wallet_mismatch',
  );

  // The correct signer, over the exact stored intent, reaches READY_TO_BROADCAST.
  const externalSignature = await externalWallet.signTypedData(
    externalTypedData.domain, externalTypedData.types, externalTypedData.message,
  );
  const externalReady = await externalService.verifySignature({
    auth: externalAuth, actionId: externalStarted.actionId, signature: externalSignature,
  });
  assert.equal(externalReady.state, 'READY_TO_BROADCAST');
  assert.equal(externalReady.readyToBroadcast, true);
  assert.equal(externalReady.broadcast, 'NOT_SUBMITTED');
  assert.equal(challengeCreates, challengeCreatesBeforeExternal, 'reaching READY_TO_BROADCAST must still never call Circle');

  console.log('GATEWAY_FUNDING=PASS');
  console.log('GATEWAY_FUNDING_SUBMIT_MOCK=PASS');
  console.log('GATEWAY_FUNDING_RECONCILIATION=PASS');
  console.log('GATEWAY_FUNDING_EXTERNAL_WALLET=PASS');
  console.log('GATEWAY_FUNDING_LEGACY_ROW_COMPATIBLE=PASS');
  assert.equal(liveNetworkCalls, 0);
  console.log('GATEWAY_LIVE_NETWORK_CALLS=0');
  console.log('LIVE_GATEWAY_BROADCAST=NOT_EXECUTED');
})().catch((error) => {
  console.error('GATEWAY_FUNDING=FAIL', error);
  process.exitCode = 1;
});
