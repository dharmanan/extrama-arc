'use strict';

// Deterministic Gateway lifecycle proof. It uses the real burn-intent
// cryptography and durable funding state machine with in-memory DB/Circle/
// forwarding adapters. It never contacts Gateway, Circle, Arc, or PostgreSQL;
// the forwarding client is reached only through a mock.

const assert = require('node:assert/strict');
const { ethers } = require('ethers');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

const {
  buildArcFundingBurnIntent,
  buildArcFundingTransferSpec,
} = require('../src/services/gatewayService');
const { createGatewayFundingService } = require('../src/services/gatewayFundingService');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CIRCLE_WALLET_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
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

const fakeDb = {
  async query(sql, params) {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('INSERT INTO gateway_funding_actions')) {
      const [id, userId, circleWalletId, walletAddress, requestId, sourceDomain, valueRaw, signRequestId, expiresAt] = params;
      const existing = [...rows.values()].find((row) => row.user_id === userId && row.request_id === requestId);
      if (existing) return out(null);
      rows.set(id, {
        id, user_id: userId, circle_wallet_id: circleWalletId, wallet_address: walletAddress,
        request_id: requestId, source_domain: sourceDomain, value_raw: valueRaw,
        circle_sign_request_id: signRequestId, state: 'PREPARING', expires_at: expiresAt,
        payload_hash: null, burn_intent_json: null, burn_intent_json_text: null, typed_data_json: null,
        circle_sign_challenge_id: null, signature: null, last_error: null,
        gateway_transfer_id: null, gateway_transaction_hash: null,
      });
      return out(null);
    }
    if (text.startsWith('SELECT * FROM gateway_funding_actions')) {
      const row = [...rows.values()].find((candidate) => {
        if (params.length === 2) return candidate.user_id === params[0] && candidate.request_id === params[1];
        return candidate.id === params[0] && candidate.user_id === params[1] &&
          candidate.circle_wallet_id === params[2] &&
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
    if (text.includes("payload_hash = $2")) {
      if (row.state === 'PREPARING') {
        row.payload_hash = params[1]; row.burn_intent_json = params[2]; row.burn_intent_json_text = params[3]; row.typed_data_json = params[4];
        row.max_fee_raw = params[5]; row.max_block_height = params[6]; row.estimate_fees_json = params[7];
        row.state = 'SIGN_CHALLENGE_CREATING'; row.last_error = null;
        return out(row);
      }
      return out(null);
    }
    if (text.includes('circle_sign_challenge_id = $2')) {
      if (row.state === 'SIGN_CHALLENGE_CREATING') {
        row.circle_sign_challenge_id = params[1]; row.state = 'SIGNATURE_PENDING'; row.last_error = null;
        return out(row);
      }
      return out(null);
    }
    if (text.includes("state = 'SIGNATURE_FAILED'")) {
      row.state = 'SIGNATURE_FAILED'; row.last_error = 'gateway_signature_challenge_failed';
      return out(null);
    }
    if (text.includes('SET signature = $2')) {
      if (row.state === 'SIGNATURE_PENDING') {
        row.signature = params[1]; row.state = 'READY_TO_BROADCAST'; row.last_error = null;
        return out(row);
      }
      return out(null);
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
const fakeCircle = {
  async createTypedDataChallenge(input) {
    challengeCreates += 1;
    assert.equal(input.walletId, CIRCLE_WALLET_ID);
    assert.equal(input.typedData.primaryType, 'BurnIntent');
    return { challengeId: 'gateway-sign-challenge-1' };
  },
  async getTypedDataChallenge({ challengeId }) {
    assert.equal(challengeId, 'gateway-sign-challenge-1');
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
  buildArcFundingTransferSpec,
  async estimateArcFunding(spec) {
    assert.equal(spec.sourceDomain, 6);
    assert.equal(spec.value, '1000000');
    return { maxFeeRaw: '10000', maxBlockHeight: '999999999', fees: { token: 'USDC' } };
  },
  buildArcFundingBurnIntent,
  recoverBurnIntentSigner(typedData, signature) {
    return ethers.verifyTypedData(typedData.domain, typedData.types, typedData.message, signature);
  },
  ARC_GATEWAY_DOMAIN: 26,
  async submitArcFunding({ burnIntent, signature, requestId }) {
    submitCalls += 1;
    assert.equal(burnIntent.spec.sourceDomain, 6);
    assert.equal(burnIntent.spec.value, '1000000');
    assert.equal(typeof signature, 'string');
    assert.equal(requestId.length, 36);
    return { transferId: '55555555-5555-4555-8555-555555555555' };
  },
  async readArcFundingTransferStatus(transferId) {
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

(async () => {
  const service = createGatewayFundingService({
    database: fakeDb,
    gateway: fakeGateway,
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });
  const started = await service.start({
    auth, userToken: 'circle_user_token_long_enough', requestId: REQUEST_ID, sourceDomain: 6, valueRaw: '1000000',
  });
  assert.equal(started.state, 'SIGNATURE_PENDING');
  assert.equal(started.challengeId, 'gateway-sign-challenge-1');
  assert.equal(started.broadcast, 'NOT_SUBMITTED');
  assert.equal(challengeCreates, 1);

  const replay = await service.start({
    auth, userToken: 'circle_user_token_long_enough', requestId: REQUEST_ID, sourceDomain: 6, valueRaw: '1000000',
  });
  assert.equal(replay.actionId, started.actionId);
  assert.equal(replay.payloadHash, started.payloadHash);
  assert.equal(challengeCreates, 1, 'same request never creates a second challenge');

  await rejectsCode(
    () => service.start({
      auth, userToken: 'circle_user_token_long_enough', requestId: REQUEST_ID, sourceDomain: 6, valueRaw: '1000001',
    }),
    'gateway_request_id_conflict',
  );

  const pending = await service.verifySignature({
    auth, actionId: started.actionId, userToken: 'circle_user_token_long_enough',
  });
  assert.equal(pending.pending, true);

  challengeStatus = 'COMPLETE';
  const row = rows.get(started.actionId);
  const signature = await wallet.signTypedData(
    row.typed_data_json.domain,
    row.typed_data_json.types,
    row.typed_data_json.message,
  );
  const ready = await service.verifySignature({
    auth, actionId: started.actionId, userToken: 'circle_user_token_long_enough', signature,
  });
  assert.equal(ready.state, 'READY_TO_BROADCAST');
  assert.equal(ready.readyToBroadcast, true);
  assert.equal(ready.broadcast, 'NOT_SUBMITTED');
  assert.equal(rows.get(started.actionId).signature, signature);

  const submitted = await service.submit({
    auth, actionId: started.actionId,
  });
  assert.equal(submitted.state, 'SUBMITTED');
  assert.equal(submitted.transferId, '55555555-5555-4555-8555-555555555555');
  assert.equal(submitCalls, 1);
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
    row.typed_data_json.domain, row.typed_data_json.types, row.typed_data_json.message,
  );
  const secondRequest = '44444444-4444-4444-8444-444444444444';
  const second = await service.start({
    auth, userToken: 'circle_user_token_long_enough', requestId: secondRequest, sourceDomain: 6, valueRaw: '1000000',
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
      auth, userToken: 'circle_user_token_long_enough', requestId, sourceDomain: 6, valueRaw: '1000000',
    });
    const actionRow = rows.get(startedAction.actionId);
    const actionSignature = await wallet.signTypedData(
      actionRow.typed_data_json.domain, actionRow.typed_data_json.types, actionRow.typed_data_json.message,
    );
    challengeStatus = 'COMPLETE';
    const actionReady = await service.verifySignature({
      auth, actionId: startedAction.actionId, userToken: 'circle_user_token_long_enough', signature: actionSignature,
    });
    assert.equal(actionReady.state, 'READY_TO_BROADCAST');
    return actionReady.actionId;
  }

  const sourceMismatchActionId = await readyAction('77777777-7777-4777-8777-777777777777');
  rows.get(sourceMismatchActionId).burn_intent_json = JSON.parse(JSON.stringify(rows.get(sourceMismatchActionId).burn_intent_json));
  rows.get(sourceMismatchActionId).burn_intent_json.spec.sourceDomain = 0;
  await rejectsCode(
    () => service.submit({ auth, actionId: sourceMismatchActionId }),
    'gateway_funding_payload_mismatch',
  );

  const amountMismatchActionId = await readyAction('88888888-8888-4888-8888-888888888888');
  rows.get(amountMismatchActionId).burn_intent_json = JSON.parse(JSON.stringify(rows.get(amountMismatchActionId).burn_intent_json));
  rows.get(amountMismatchActionId).burn_intent_json.spec.value = '999999';
  await rejectsCode(
    () => service.submit({ auth, actionId: amountMismatchActionId }),
    'gateway_funding_payload_mismatch',
  );

  const multiSourceGateway = {
    ...fakeGateway,
    async readUnifiedUsdcBalance() {
      return {
        balances: [
          { domain: 6, balanceRaw: '500000', transferable: true },
          { domain: 0, balanceRaw: '5000000', transferable: true },
        ],
      };
    },
  };
  const singleSourceService = createGatewayFundingService({
    database: fakeDb,
    gateway: multiSourceGateway,
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });
  await rejectsCode(
    () => singleSourceService.start({
      auth,
      userToken: 'circle_user_token_long_enough',
      requestId: '99999999-9999-4999-8999-999999999999',
      sourceDomain: 6,
      valueRaw: '1000000',
    }),
    'gateway_insufficient_usdc',
  );

  // A timeout/ambiguous POST is never retried. The operation is durable and
  // can only progress through the status endpoint.
  let ambiguousSubmitCalls = 0;
  const ambiguousGateway = {
    ...fakeGateway,
    async submitArcFunding() {
      ambiguousSubmitCalls += 1;
      throw new Error('gateway_transfer_submit_unknown');
    },
  };
  const ambiguousService = createGatewayFundingService({
    database: fakeDb, gateway: ambiguousGateway, circle: fakeCircle, runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });
  const ambiguousRequest = '66666666-6666-4666-8666-666666666666';
  const ambiguousStart = await ambiguousService.start({
    auth, userToken: 'circle_user_token_long_enough', requestId: ambiguousRequest, sourceDomain: 6, valueRaw: '1000000',
  });
  const ambiguousRow = rows.get(ambiguousStart.actionId);
  const ambiguousSignature = await wallet.signTypedData(
    ambiguousRow.typed_data_json.domain, ambiguousRow.typed_data_json.types, ambiguousRow.typed_data_json.message,
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

  console.log('GATEWAY_FUNDING=PASS');
  console.log('GATEWAY_FUNDING_SUBMIT_MOCK=PASS');
  console.log('GATEWAY_FUNDING_RECONCILIATION=PASS');
  assert.equal(liveNetworkCalls, 0);
  console.log('GATEWAY_LIVE_NETWORK_CALLS=0');
  console.log('LIVE_GATEWAY_BROADCAST=NOT_EXECUTED');
})().catch((error) => {
  console.error('GATEWAY_FUNDING=FAIL', error);
  process.exitCode = 1;
});
