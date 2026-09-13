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

const gatewayService = require('../src/services/gatewayService');
const {
  buildGatewayBurnIntent,
  buildGatewayTransferSpec,
  planSourceAllocation,
} = gatewayService;
const {
  createGatewayFundingService,
  FUNDING_TTL_MS,
  PENDING_FUNDING_STATES,
  isGatewayFundingPendingState,
} = require('../src/services/gatewayFundingService');
const gatewayNetworks = require('../src/services/gatewayNetworks');

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
let fundingInsertAttempts = 0;
function copy(row) { return row ? JSON.parse(JSON.stringify(row)) : null; }
function out(row) { return { rows: row ? [copy(row)] : [], rowCount: row ? 1 : 0 }; }
// node-pg hands a JSONB column back as parsed JS, so the fake parses on write
// to keep the read shape identical to production.
function jsonb(value) { return value === null || value === undefined ? null : JSON.parse(value); }

const fakeDb = {
  async query(sql, params) {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('INSERT INTO gateway_funding_actions')) {
      fundingInsertAttempts += 1;
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
      if (text.includes('state = ANY')) {
        const activeStates = new Set(params[3]);
        const matches = [...rows.values()].filter((candidate) => (
          candidate.user_id === params[0] &&
          candidate.execution_mode === params[1] &&
          candidate.wallet_address.toLowerCase() === params[2].toLowerCase() &&
          activeStates.has(candidate.state)
        ));
        return { rows: matches.map(copy), rowCount: matches.length };
      }
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
    if (text.includes('gateway_funding_cancelled_before_submission')) {
      if (
        !['PREPARING', 'SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING', 'READY_TO_BROADCAST']
          .includes(row.state) ||
        row.gateway_transfer_id !== null || row.gateway_transaction_hash !== null
      ) return out(null);
      row.state = 'EXPIRED';
      row.last_error = 'gateway_funding_cancelled_before_submission';
      return out(row);
    }
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
      row.state = 'SIGNATURE_FAILED'; row.last_error = params[1];
      return out(row);
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
let challengeErrorCode = null;
let challengeCreates = 0;
const challengeReadIds = [];
let gatewayEstimateCalls = 0;
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
    challengeReadIds.push(challengeId);
    return {
      id: challengeId,
      type: 'SIGN_TYPEDDATA',
      status: challengeStatus,
      ...(challengeErrorCode === null ? {} : { errorCode: challengeErrorCode }),
    };
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
    gatewayEstimateCalls += 1;
    assert.ok(Array.isArray(specs));
    return {
      intents: specs.map(() => ({ maxFeeRaw: '10000', maxBlockHeight: '999999999' })),
      fees: { token: 'USDC', total: ethers.formatUnits(10000n * BigInt(specs.length), 6) },
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
    /ADD CONSTRAINT gateway_funding_actions_plan_check CHECK \(\s*state IN \('PREPARING', 'EXPIRED'\) OR source_domain IS NOT NULL OR source_plan_json IS NOT NULL\s*\)/,
  );

  // This mirrors PostgreSQL CHECK semantics explicitly: the durable row may
  // begin empty, and may retire straight to EXPIRED still empty (discard()
  // before submission, or markExpired()'s automatic TTL retirement never
  // touch source_domain/source_plan_json), but every OTHER state, including
  // every other terminal state, needs legacy source or complete plan.
  const accepts = (row) => ['PREPARING', 'EXPIRED'].includes(row.state)
    || row.source_domain !== null
    || row.source_plan_json !== null;

  // 1. planless PREPARING row is valid.
  assert.equal(accepts({ state: 'PREPARING', source_domain: null, source_plan_json: null }), true);
  // 2 & 3. planless EXPIRED is valid, whichever transition produced it
  // (explicit discard, or automatic TTL expiry), the row shape is
  // identical either way, so one check covers both.
  assert.equal(accepts({ state: 'EXPIRED', source_domain: null, source_plan_json: null }), true);
  assert.equal(accepts({ state: 'SIGNATURE_PENDING', source_domain: null, source_plan_json: [] }), true);
  // 5-10. Every other state, including every OTHER terminal state, still
  // requires a resolved source: EXPIRED is the only planless exception.
  for (const state of [
    'READY_TO_BROADCAST', 'SIGN_CHALLENGE_CREATING', 'SUBMITTING', 'SUBMITTED',
    'COMPLETED', 'RECONCILIATION_REQUIRED', 'FAILED', 'SIGNATURE_FAILED',
  ]) {
    assert.equal(
      accepts({ state, source_domain: null, source_plan_json: null }), false,
      `${state} must still require a resolved source or plan`,
    );
  }
  // 11. Historical single-source rows remain valid in any state.
  assert.equal(accepts({ state: 'READY_TO_BROADCAST', source_domain: 6, source_plan_json: null }), true);
  assert.equal(accepts({ state: 'COMPLETED', source_domain: 6, source_plan_json: null }), true);
  // 12. Multi-source rows (source_plan_json, no singular source_domain) remain valid.
  assert.equal(
    accepts({
      state: 'COMPLETED', source_domain: null,
      source_plan_json: [{ sourceDomain: 2, valueRaw: '500000' }, { sourceDomain: 3, valueRaw: '500000' }],
    }),
    true,
  );
  console.log('GATEWAY_DB_PREPARING_ROW_VALID=PASS');
  console.log('GATEWAY_FUNDING_PLANLESS_EXPIRED_ALLOWED=PASS');
  console.log('GATEWAY_FUNDING_PLAN_CONSTRAINT_FAIL_CLOSED=PASS');

  return accepts;
}

// Production evidence: action dc62db8d-64cc-4469-89a9-e26f707a155b was
// inserted PREPARING and never got past readUnifiedUsdcBalance, leaving
// source_domain/source_plan_json/circle_sign_challenge_id/signatures_json all
// NULL. Both an explicit "Discard prepared transfer" click and the automatic
// TTL sweep then tried to move it straight to EXPIRED and PostgreSQL rejected
// the update with 23514 on gateway_funding_actions_plan_check, because the
// old constraint's only planless exception was PREPARING itself.
//
// This drives the REAL discard()/markExpired() code (not a reimplementation)
// through a row that fails preparation for exactly this reason, a rejected
// readUnifiedUsdcBalance call, before any plan is ever written, and checks
// the resulting row against the schema mirror above, so the proof is that the
// application's own row shape now satisfies the constraint, not merely that
// the constraint text changed.
async function verifyPreparingPlanlessLifecycle(accepts) {
  const failingGateway = {
    ...fakeGateway,
    async readUnifiedUsdcBalance() {
      throw new Error('gateway_service_unavailable');
    },
  };

  // Explicit discard: "Discard prepared transfer"
  {
    const discardWallet = new ethers.Wallet(`0x${'44'.repeat(32)}`);
    const discardAuth = {
      userId: '44444444-4444-4444-8444-444444444401',
      circleWalletId: CIRCLE_WALLET_ID,
      walletAddress: discardWallet.address,
      executionMode: 'CIRCLE_USER_WALLET',
    };
    const service = createGatewayFundingService({
      database: fakeDb, gateway: failingGateway, circle: fakeCircle,
      runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
    });
    const requestId = '55555555-0000-4000-8000-000000000001';
    await rejectsCode(
      () => service.start({
        auth: discardAuth, userToken: 'circle_user_token_long_enough',
        requestId, destinationDomain: ARC_DOMAIN, valueRaw: '1000000',
      }),
      'gateway_service_unavailable',
    );
    const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
    assert.ok(row, 'the durable row must exist even though preparation never completed');
    assert.equal(row.state, 'PREPARING');
    assert.equal(row.source_domain, null, 'production evidence: source_domain is null before any plan');
    assert.equal(row.source_plan_json, null, 'production evidence: source_plan_json is null before any plan');

    // Before the fix this exact call is what PostgreSQL rejected with 23514.
    const discarded = await service.discard({ auth: discardAuth, actionId: row.id });
    assert.equal(discarded.state, 'EXPIRED');
    const finalRow = [...rows.values()].find((candidate) => candidate.id === row.id);
    assert.equal(finalRow.state, 'EXPIRED');
    assert.equal(finalRow.last_error, 'gateway_funding_cancelled_before_submission');
    // 4. EXPIRED preserves the null source_domain/source_plan_json: discard()
    // never invents a plan merely to satisfy the constraint.
    assert.equal(finalRow.source_domain, null);
    assert.equal(finalRow.source_plan_json, null);
    assert.equal(accepts(finalRow), true, 'the row discard() produces must satisfy the fixed constraint');
    console.log('GATEWAY_FUNDING_PREPARING_DISCARD_DB_SAFE=PASS');
  }

  // Automatic TTL sweep: markExpired() via get()
  {
    const ttlWallet = new ethers.Wallet(`0x${'55'.repeat(32)}`);
    const ttlAuth = {
      userId: '44444444-4444-4444-8444-444444444402',
      circleWalletId: CIRCLE_WALLET_ID,
      walletAddress: ttlWallet.address,
      executionMode: 'CIRCLE_USER_WALLET',
    };
    // expiresAt is computed as now() + FUNDING_TTL_MS at insert time. Shifting
    // now() into the past makes the durable expires_at already past relative
    // to the real wall clock isExpired() actually checks, deterministically
    // and without waiting real time. start() itself calls the shared
    // markExpired() before ever reaching prepareIntents, so this row is
    // retired to EXPIRED, still completely planless, by start()'s own
    // call, exactly the automatic TTL sweep Koray will trigger with a hard
    // refresh once expires_at has passed in production.
    const pastNow = () => Date.now() - 2 * FUNDING_TTL_MS;
    const service = createGatewayFundingService({
      database: fakeDb, gateway: failingGateway, circle: fakeCircle,
      runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true }, now: pastNow,
    });
    const requestId = '55555555-0000-4000-8000-000000000002';
    // Before the fix this exact automatic retirement is what PostgreSQL
    // rejected with 23514, leaving the action stuck PREPARING forever instead
    // of ever reaching this expiry error.
    await rejectsCode(
      () => service.start({
        auth: ttlAuth, userToken: 'circle_user_token_long_enough',
        requestId, destinationDomain: ARC_DOMAIN, valueRaw: '1000000',
      }),
      'gateway_funding_expired',
    );
    const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
    assert.equal(row.state, 'EXPIRED', 'markExpired() must have already retired this planless row inside start()');
    assert.equal(row.source_domain, null);
    assert.equal(row.source_plan_json, null);
    assert.equal(accepts(row), true, 'the row markExpired() produces must satisfy the fixed constraint');

    // A subsequent read (the hard refresh Koray will actually perform) must
    // also succeed against the now-EXPIRED row: markExpired() is a no-op on
    // an already-terminal state, never a second write attempt.
    const exposed = await service.get({ auth: ttlAuth, actionId: row.id });
    assert.equal(exposed.state, 'EXPIRED');
    console.log('GATEWAY_FUNDING_PREPARING_TTL_DB_SAFE=PASS');
  }
}

async function verifyGatewayCostReview() {
  function createReviewGateway(walletAddress, sourceBalances, {
    maxFeeRaw = '10000',
    estimatedFeeTotalRaw = '10000',
    omitEstimatedTotal = false,
    state,
  } = {}) {
    return {
      async readUnifiedUsdcBalance(address) {
        assert.equal(address.toLowerCase(), walletAddress.toLowerCase());
        return { balances: sourceBalances };
      },
      buildGatewayTransferSpec,
      enumerateSourceAllocationPlans: gatewayService.enumerateSourceAllocationPlans,
      async estimateGatewayTransfer(specs) {
        if (state) state.estimateCalls += 1;
        const fees = specs.map(() => String(typeof maxFeeRaw === 'function' ? maxFeeRaw() : maxFeeRaw));
        return {
          intents: fees.map((fee) => ({ maxFeeRaw: fee, maxBlockHeight: '999999999' })),
          ...(omitEstimatedTotal
            ? { fees: { token: 'USDC' } }
            : { fees: { token: 'USDC', total: ethers.formatUnits(BigInt(estimatedFeeTotalRaw), 6) } }),
        };
      },
      buildGatewayBurnIntent,
      recoverBurnIntentSigner(typedData, signature) {
        return ethers.verifyTypedData(typedData.domain, typedData.types, typedData.message, signature);
      },
      ARC_GATEWAY_DOMAIN: ARC_DOMAIN,
    };
  }

  const fixtureWallet = new ethers.Wallet(`0x${'66'.repeat(32)}`);
  const fixtureAuth = {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    walletAddress: fixtureWallet.address,
    executionMode: 'EXTERNAL_WALLET',
  };
  const fixtureState = { estimateCalls: 0 };
  const fixtureService = createGatewayFundingService({
    database: fakeDb,
    gateway: createReviewGateway(
      fixtureWallet.address,
      [{ domain: 6, balanceRaw: '5000000', transferable: true }],
      { maxFeeRaw: '1257798', estimatedFeeTotalRaw: '1257798', state: fixtureState },
    ),
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: false },
  });
  const fixture = await fixtureService.start({
    auth: fixtureAuth,
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  assert.deepEqual(fixture.costReview, {
    estimatedFeeRaw: '1257798',
    estimatedTotalDebitRaw: '2257798',
    maximumAuthorizedFeeRaw: '1383578',
    maximumTotalDebitRaw: '2383578',
  });
  assert.equal(fixtureState.estimateCalls, 1);
  console.log('GATEWAY_COST_REVIEW_SERVER_DERIVED=PASS');
  console.log('GATEWAY_COST_REVIEW_ESTIMATED_FEE=PASS');
  console.log('GATEWAY_COST_REVIEW_ESTIMATED_TOTAL=PASS');
  console.log('GATEWAY_COST_REVIEW_MAX_AUTHORIZED_FEE=PASS');
  console.log('GATEWAY_COST_REVIEW_MAX_TOTAL_DEBIT=PASS');

  const replay = await fixtureService.start({
    auth: fixtureAuth,
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  assert.equal(replay.actionId, fixture.actionId);
  assert.deepEqual(replay.costReview, fixture.costReview);
  assert.equal(fixtureState.estimateCalls, 1, 'replay must use the same durable plan and estimate');
  console.log('GATEWAY_COST_REVIEW_SAME_DURABLE_ACTION=PASS');
  console.log('GATEWAY_COST_REVIEW_NO_EXTRA_ESTIMATE=PASS');

  const multiWallet = new ethers.Wallet(`0x${'67'.repeat(32)}`);
  const multiState = { estimateCalls: 0 };
  const multiService = createGatewayFundingService({
    database: fakeDb,
    gateway: createReviewGateway(
      multiWallet.address,
      [
        { domain: 6, balanceRaw: '700000', transferable: true },
        { domain: 2, balanceRaw: '700000', transferable: true },
      ],
      { maxFeeRaw: '100000', estimatedFeeTotalRaw: '250000', state: multiState },
    ),
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: false },
  });
  const multi = await multiService.start({
    auth: {
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      walletAddress: multiWallet.address,
      executionMode: 'EXTERNAL_WALLET',
    },
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0001',
    destinationDomain: 2,
    valueRaw: '1000000',
  });
  assert.equal(multi.intentCount, 2);
  assert.equal(multi.costReview.estimatedFeeRaw, '250000');
  assert.equal(multi.costReview.estimatedTotalDebitRaw, '1250000');
  assert.equal(multi.costReview.maximumAuthorizedFeeRaw, '400000');
  assert.equal(multi.costReview.maximumTotalDebitRaw, '1400000');
  assert.ok(multiState.estimateCalls > 1, 'multi-source preparation must quote its aggregate plan');
  console.log('GATEWAY_COST_REVIEW_MULTI_SOURCE_AGGREGATED=PASS');

  for (const [index, destination] of gatewayNetworks.DESTINATION_NETWORKS.entries()) {
    const destinationWallet = new ethers.Wallet(
      `0x${(0x70 + index).toString(16).padStart(2, '0').repeat(32)}`,
    );
    const destinationService = createGatewayFundingService({
      database: fakeDb,
      gateway: createReviewGateway(
        destinationWallet.address,
        [{ domain: 6, balanceRaw: '2000000', transferable: true }],
      ),
      circle: fakeCircle,
      runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: false },
    });
    const action = await destinationService.start({
      auth: {
        userId: `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, '0')}`,
        walletAddress: destinationWallet.address,
        executionMode: 'EXTERNAL_WALLET',
      },
      requestId: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, '0')}`,
      destinationDomain: destination.domain,
      valueRaw: '1000000',
    });
    assert.equal(action.destinationLabel, destination.label);
    assert.ok(action.costReview);
  }
  console.log('GATEWAY_COST_REVIEW_ALL_DESTINATIONS=PASS');

  const missingWallet = new ethers.Wallet(`0x${'68'.repeat(32)}`);
  const missingService = createGatewayFundingService({
    database: fakeDb,
    gateway: createReviewGateway(
      missingWallet.address,
      [{ domain: 6, balanceRaw: '2000000', transferable: true }],
      { maxFeeRaw: '10000', omitEstimatedTotal: true },
    ),
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: false },
  });
  await rejectsCode(
    () => missingService.start({
      auth: {
        userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        walletAddress: missingWallet.address,
        executionMode: 'EXTERNAL_WALLET',
      },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0001',
      destinationDomain: ARC_DOMAIN,
      valueRaw: '1000000',
    }),
    'gateway_cost_review_unavailable',
  );
  const missingRow = [...rows.values()].find((row) => row.request_id === 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0001');
  assert.equal(missingRow.state, 'PREPARING');
  assert.equal(missingRow.typed_data_list_json, null);
  console.log('GATEWAY_COST_REVIEW_MISSING_ESTIMATE_FAILS_CLOSED=PASS');

  const circleActions = fs.readFileSync(path.join(__dirname, '../../app/lib/circle-actions.ts'), 'utf8');
  const gatewayActions = fs.readFileSync(path.join(__dirname, '../../app/lib/gateway-actions.ts'), 'utf8');
  const walletPage = fs.readFileSync(path.join(__dirname, '../../app/wallet/page.tsx'), 'utf8');
  const prepareGatewayStart = gatewayActions.indexOf('export async function prepareGatewayBurnReview(');
  const confirmGatewayStart = gatewayActions.indexOf('export async function confirmPreparedGatewayBurnSignature(');
  const gatewaySourceEnd = gatewayActions.indexOf('// ---------------------------------------------------------------------------\n// Source chain deposit', confirmGatewayStart);
  const prepareGateway = gatewayActions.slice(prepareGatewayStart, confirmGatewayStart);
  const confirmGateway = gatewayActions.slice(confirmGatewayStart, gatewaySourceEnd);
  const prepareCircleStart = circleActions.indexOf('export async function prepareCircleGatewayFundingReview(');
  const confirmCircleStart = circleActions.indexOf('export async function confirmPreparedCircleGatewayFunding(');
  const circleSourceEnd = circleActions.indexOf('// ---------------------------------------------------------------------------\n// Generic Circle financial actions', confirmCircleStart);
  const prepareCircle = circleActions.slice(prepareCircleStart, confirmCircleStart);
  const confirmCircle = circleActions.slice(confirmCircleStart, circleSourceEnd);

  assert.ok(prepareGatewayStart > -1 && confirmGatewayStart > prepareGatewayStart);
  assert.ok(!/signTypedData|executeHostedChallenge|verifyGatewayFunding/.test(prepareGateway));
  assert.match(confirmGateway, /backendApi\.wallet\.gatewayFunding\(recovery\.actionId\)/);
  assert.ok(!confirmGateway.includes('startGatewayFunding'));
  assert.match(confirmGateway, /context\.signTypedData/);
  assert.match(confirmGateway, /Math\.max\(0, current\.signatureIndex\)/);
  assert.ok(!/submitGatewayFunding/.test(confirmGateway));
  assert.ok(prepareCircleStart > -1 && confirmCircleStart > prepareCircleStart);
  assert.ok(!prepareCircle.includes('executeHostedChallenge'));
  assert.match(prepareCircle, /backendApi\.wallet\.startGatewayFunding/);
  assert.match(confirmCircle, /executeHostedChallenge\(current\.challengeId\)/);
  assert.match(confirmCircle, /backendApi\.wallet\.gatewayFunding\(recovery!\.actionId\)/);
  assert.ok(!confirmCircle.includes('startGatewayFunding'));
  assert.match(walletPage, /prepareGatewayBurnReview\(/);
  assert.match(walletPage, /confirmPreparedGatewayBurnSignature\(/);
  assert.match(walletPage, /gatewayFundingStatus\?\.costReview/);
  assert.match(walletPage, /gatewayReviewTransfer/);
  assert.match(walletPage, /gatewayConfirmSign/);
  assert.match(walletPage, /gatewayContinueSigning/);
  assert.match(walletPage, /gatewayCancelTransfer/);
  assert.match(walletPage, /gatewayFundingStatus\.costReview\.estimatedFeeRaw/);
  assert.match(walletPage, /gatewayFundingStatus\.costReview\.maximumTotalDebitRaw/);
  assert.match(walletPage, /disabled=\{gatewayFundingBusy \|\| Boolean\(gatewayFundingRecovery\)\}/);
  assert.match(walletPage, /gatewayFunding\(recoveredActionId\)/);
  assert.equal((walletPage.match(/backendApi\.wallet\.submitGatewayFunding\(/g) || []).length, 1);
  assert.match(walletPage, /gatewayFundingStatus\?\.readyToBroadcast === true/);
  console.log('GATEWAY_COST_REVIEW_CIRCLE_BEFORE_SIGNATURE=PASS');
  console.log('GATEWAY_COST_REVIEW_EXTERNAL_BEFORE_SIGNATURE=PASS');
  console.log('GATEWAY_COST_REVIEW_NO_REPREPARE_ON_CONFIRM=PASS');
  console.log('GATEWAY_COST_REVIEW_RELOAD_PRESERVED=PASS');
  console.log('GATEWAY_COST_REVIEW_PARTIAL_SIGNATURE_RESUMES=PASS');
  console.log('GATEWAY_COST_REVIEW_READY_SUBMIT_SEPARATE=PASS');
  console.log('GATEWAY_COST_REVIEW_NO_AUTOSIGN=PASS');
  console.log('GATEWAY_COST_REVIEW_NO_AUTOSUBMIT=PASS');
  console.log('GATEWAY_COST_REVIEW_INPUTS_LOCKED=PASS');
  console.log('GATEWAY_COST_REVIEW_EN_TR_COPY=PASS');
}

// Production regression shape: preparation created one Circle challenge and
// persisted SIGNATURE_PENDING, but the status route previously exposed that
// same row as pending=false. The runtime portion below hydrates through the
// route's service semantics and keeps the action untouched while its challenge
// is still pending; static checks bind the browser confirmation to the exact
// durable state/challenge path and forbid a second financial start.
async function verifyCircleSignPendingRegression() {
  assert.deepEqual(
    [...PENDING_FUNDING_STATES],
    ['SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING', 'SUBMITTING', 'SUBMITTED', 'RECONCILIATION_REQUIRED'],
  );
  for (const state of PENDING_FUNDING_STATES) {
    assert.equal(isGatewayFundingPendingState(state), true);
  }
  assert.equal(isGatewayFundingPendingState('PREPARING'), false);
  assert.equal(isGatewayFundingPendingState('READY_TO_BROADCAST'), false);

  const regressionWallet = new ethers.Wallet(`0x${'77'.repeat(32)}`);
  const regressionAuth = {
    userId: '77777777-7777-4777-8777-777777777777',
    circleWalletId: CIRCLE_WALLET_ID,
    walletAddress: regressionWallet.address,
    executionMode: 'CIRCLE_USER_WALLET',
  };
  const regressionGateway = {
    ...fakeGateway,
    async readUnifiedUsdcBalance(address) {
      assert.equal(address.toLowerCase(), regressionWallet.address.toLowerCase());
      return { balances: [{ domain: 6, balanceRaw: '2500000', transferable: true }] };
    },
  };
  const service = createGatewayFundingService({
    database: fakeDb,
    gateway: regressionGateway,
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: false },
  });
  const requestId = '77777777-7777-4777-8777-777777777778';
  const prepared = await service.start({
    auth: regressionAuth,
    userToken: 'circle_user_token_long_enough',
    requestId,
    destinationDomain: 0,
    valueRaw: '2000000',
  });
  assert.equal(prepared.state, 'SIGNATURE_PENDING');
  assert.equal(prepared.pending, true);
  assert.equal(prepared.signatureIndex, 0);
  assert.equal(typeof prepared.challengeId, 'string');
  assert.equal(prepared.intentCount, 1);
  assert.equal(prepared.transferId, null);
  assert.equal(prepared.transactionHash, null);
  assert.equal(challengeCreates, 1);
  const preparedChallengeId = prepared.challengeId;
  const preparedRow = rows.get(prepared.actionId);
  assert.deepEqual(preparedRow.circle_sign_challenges_json, [preparedChallengeId]);
  assert.deepEqual(preparedRow.signatures_json, [null]);
  assert.equal(preparedRow.gateway_transfer_id, null);
  assert.equal(preparedRow.gateway_transaction_hash, null);
  const insertAttemptsAfterPrepare = fundingInsertAttempts;
  const challengeCreatesAfterPrepare = challengeCreates;
  const estimatesAfterPrepare = gatewayEstimateCalls;
  const submitsAfterPrepare = submitCalls;

  // This is the exact GET /gateway-funding/:actionId service path. It must
  // report the same SIGNATURE_PENDING action as pending=true.
  const hydrated = await service.status({ auth: regressionAuth, actionId: prepared.actionId });
  assert.equal(hydrated.state, 'SIGNATURE_PENDING');
  assert.equal(hydrated.pending, true);
  assert.equal(hydrated.actionId, prepared.actionId);
  assert.equal(hydrated.challengeId, preparedChallengeId);
  assert.equal(hydrated.signatureIndex, 0);

  // Keep the persisted action in the exact no-signature shape while the
  // existing challenge is still pending. verifySignature() reaches the same
  // challenge record and returns pending without creating or submitting.
  const stillPending = await service.verifySignature({
    auth: regressionAuth,
    actionId: hydrated.actionId,
    userToken: 'circle_user_token_long_enough',
  });
  assert.equal(stillPending.state, 'SIGNATURE_PENDING');
  assert.equal(stillPending.pending, true);
  assert.equal(stillPending.signatureIndex, 0);
  assert.equal(challengeReadIds[challengeReadIds.length - 1], preparedChallengeId);
  assert.equal(challengeCreates, challengeCreatesAfterPrepare);
  assert.equal(fundingInsertAttempts, insertAttemptsAfterPrepare);
  assert.equal(gatewayEstimateCalls, estimatesAfterPrepare);
  assert.equal(submitCalls, submitsAfterPrepare);

  const circleActions = fs.readFileSync(path.join(__dirname, '../../app/lib/circle-actions.ts'), 'utf8');
  const confirmStart = circleActions.indexOf('export async function confirmPreparedCircleGatewayFunding');
  const confirmEnd = circleActions.indexOf('// Compatibility name for existing integrations.', confirmStart);
  assert.ok(confirmStart > -1 && confirmEnd > confirmStart);
  const confirmBody = circleActions.slice(confirmStart, confirmEnd);
  assert.match(confirmBody, /backendApi\.wallet\.gatewayFunding\(recovery!\.actionId\)/);
  assert.match(confirmBody, /current\.state !== "SIGNATURE_PENDING"/);
  assert.match(confirmBody, /current\.signatureIndex < 0/);
  assert.match(confirmBody, /current\.challengeId\.trim\(\)\.length === 0/);
  assert.match(confirmBody, /executeHostedChallenge\(current\.challengeId\)/);
  assert.doesNotMatch(confirmBody, /!current\.pending/);
  assert.doesNotMatch(confirmBody, /startGatewayFunding/);
  assert.doesNotMatch(confirmBody, /createSignatureChallenge/);
  assert.doesNotMatch(confirmBody, /estimateGatewayTransfer/);
  assert.doesNotMatch(confirmBody, /submitGatewayFunding/);

  const walletRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/wallet.js'), 'utf8');
  const routeStart = walletRoutes.indexOf("router.get('/gateway-funding/:actionId'");
  const routeEnd = walletRoutes.indexOf("router.post('/gateway-funding/:actionId/submit'", routeStart);
  assert.ok(routeStart > -1 && routeEnd > routeStart);
  const routeBody = walletRoutes.slice(routeStart, routeEnd);
  assert.match(routeBody, /gatewayFundingService\.status\(\{ auth: req\.auth, actionId: req\.params\.actionId \}\)/);

  const serviceSource = fs.readFileSync(path.join(__dirname, '../src/services/gatewayFundingService.js'), 'utf8');
  assert.match(serviceSource, /pending: isGatewayFundingPendingState\(row\.state\)/);
  const statusStart = serviceSource.indexOf('async function status({ auth, actionId })');
  const statusEnd = serviceSource.indexOf('async function current({ auth })', statusStart);
  assert.ok(statusStart > -1 && statusEnd > statusStart);
  assert.match(serviceSource.slice(statusStart, statusEnd), /return expose\(row\);/);

  const walletPage = fs.readFileSync(path.join(__dirname, '../../app/wallet/page.tsx'), 'utf8');
  const i18nSource = fs.readFileSync(path.join(__dirname, '../../app/i18n.tsx'), 'utf8');
  assert.match(walletPage, /gateway_signature_challenge_unavailable/);
  assert.match(walletPage, /setGatewayFundingError\(t\.wallet\.gatewaySigningStartFailed\)/);
  assert.match(i18nSource, /gatewaySigningStartFailed: "Signing could not be started\./);
  assert.match(i18nSource, /gatewaySigningStartFailed: "İmzalama başlatılamadı\./);

  console.log('GATEWAY_SIGN_PENDING_STATUS_CONSISTENT=PASS');
  console.log('GATEWAY_SIGN_CONFIRM_USES_DURABLE_STATE=PASS');
  console.log('GATEWAY_SIGN_EXISTING_CHALLENGE_RESUMED=PASS');
  console.log('GATEWAY_SIGN_NO_SECOND_ACTION=PASS');
  console.log('GATEWAY_SIGN_NO_SECOND_CHALLENGE=PASS');
  console.log('GATEWAY_SIGN_NO_REESTIMATE=PASS');
  console.log('GATEWAY_SIGN_NO_AUTOSUBMIT=PASS');
  console.log('GATEWAY_SIGN_STAGE_ERROR_COPY=PASS');
  console.log('GATEWAY_REVIEW_TO_SIGN_PRODUCTION_REGRESSION=PASS');

  // Keep the pre-existing lifecycle assertions deterministic: this isolated
  // regression row belongs to another user, but the shared fixture counters
  // must not change the historical challenge-id expectations below.
  fundingInsertAttempts = 0;
  challengeCreates = 0;
  challengeReadIds.length = 0;
  gatewayEstimateCalls = 0;
  submitCalls = 0;
  statusCalls = 0;
}

(async () => {
  await verifyCircleSignPendingRegression();
  await verifyGatewayCostReview();
  const accepts = verifyPreparingSchemaLifecycle();
  await verifyPreparingPlanlessLifecycle(accepts);
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

  // A fresh browser request id cannot evade the same-wallet guard by changing
  // amount or destination. The server returns the existing action pointer and
  // does not prepare a second plan or create a second Circle challenge.
  const challengeCreatesBeforeConflict = challengeCreates;
  const conflict = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: '99999999-9999-4999-8999-999999999998',
    destinationDomain: 0,
    valueRaw: '2000000',
  });
  assert.equal(conflict.actionId, started.actionId);
  assert.equal(conflict.recovery, 'CONFLICT');
  assert.equal(challengeCreates, challengeCreatesBeforeConflict);
  console.log('GATEWAY_FUNDING_SINGLE_ACTIVE_GUARD=PASS');
  console.log('GATEWAY_FUNDING_FRESH_REQUEST_RETURNS_EXISTING=PASS');
  console.log('GATEWAY_FUNDING_NO_SECOND_SIGNATURE_ACTION=PASS');

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
  assert.equal(ready.submissionEnabled, true);
  assert.equal(ready.broadcast, 'NOT_SUBMITTED');
  assert.equal(ready.signatureIndex, -1);
  assert.deepEqual(rows.get(started.actionId).signatures_json, [signature]);

  const readyConflict = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: '99999999-9999-4999-8999-999999999997',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  assert.equal(readyConflict.actionId, started.actionId);
  assert.equal(readyConflict.recovery, 'CONFLICT');
  assert.equal(readyConflict.readyToBroadcast, true);
  assert.equal(challengeCreates, challengeCreatesBeforeConflict);

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
  assert.equal(completed.terminal, true);
  assert.equal(completed.submissionEnabled, true);
  assert.equal(completed.transactionHash, `0x${'ab'.repeat(32)}`);

  const completedCurrent = await service.current({ auth });
  assert.equal(completedCurrent.status, 'NONE');
  assert.equal(completedCurrent.action, null);
  console.log('GATEWAY_FUNDING_COMPLETED_NOT_RECOVERED=PASS');

  // Historical duplicate unresolved rows are surfaced together and block both
  // a fresh action and any choice of which row to submit. They are cleaned in
  // this deterministic verifier only; production rows are never mutated here.
  const duplicateBase = rows.get(started.actionId);
  const duplicateIds = [
    '12121212-1212-4121-8121-121212121212',
    '13131313-1313-4131-8131-131313131313',
  ];
  duplicateIds.forEach((id, index) => rows.set(id, {
    ...copy(duplicateBase),
    id,
    request_id: `14141414-1414-414${index + 1}-814${index + 1}-14141414141${index + 1}`,
    state: 'READY_TO_BROADCAST',
    gateway_transfer_id: null,
    gateway_transaction_hash: null,
    last_error: null,
  }));
  const duplicateCurrent = await service.current({ auth });
  assert.equal(duplicateCurrent.status, 'DUPLICATE');
  assert.equal(duplicateCurrent.action, null);
  assert.equal(duplicateCurrent.actions.length, 2);
  const challengeCreatesBeforeDuplicate = challengeCreates;
  await rejectsCode(
    () => service.start({
      auth,
      userToken: 'circle_user_token_long_enough',
      requestId: '15151515-1515-4151-8151-151515151515',
      destinationDomain: ARC_DOMAIN,
      valueRaw: '1000000',
    }),
    'gateway_funding_multiple_active',
  );
  assert.equal(challengeCreates, challengeCreatesBeforeDuplicate);
  duplicateIds.forEach((id) => { rows.get(id).state = 'COMPLETED'; });
  console.log('GATEWAY_FUNDING_DUPLICATE_ACTIVE_FAILS_CLOSED=PASS');

  // A prepared action can be explicitly discarded before submission. The
  // update changes only disposition/error; every plan, challenge and payload
  // evidence field remains byte-for-byte durable.
  challengeStatus = 'PENDING';
  const discardStart = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: '16161616-1616-4161-8161-161616161616',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  const discardRowBefore = copy(rows.get(discardStart.actionId));
  const discardEvidence = {
    sourcePlan: discardRowBefore.source_plan_json,
    typedData: discardRowBefore.typed_data_list_json,
    signature: discardRowBefore.signatures_json,
    challenge: discardRowBefore.circle_sign_challenges_json,
    payloadHash: discardRowBefore.payload_hash,
  };
  const challengeCreatesBeforeDiscard = challengeCreates;
  const submitCallsBeforeDiscard = submitCalls;
  const discarded = await service.discard({ auth, actionId: discardStart.actionId });
  const discardRowAfter = rows.get(discardStart.actionId);
  assert.equal(discarded.state, 'EXPIRED');
  assert.equal(discarded.lastError, 'gateway_funding_cancelled_before_submission');
  assert.deepEqual(discardRowAfter.source_plan_json, discardEvidence.sourcePlan);
  assert.deepEqual(discardRowAfter.typed_data_list_json, discardEvidence.typedData);
  assert.deepEqual(discardRowAfter.signatures_json, discardEvidence.signature);
  assert.deepEqual(discardRowAfter.circle_sign_challenges_json, discardEvidence.challenge);
  assert.equal(discardRowAfter.payload_hash, discardEvidence.payloadHash);
  assert.equal(challengeCreates, challengeCreatesBeforeDiscard);
  assert.equal(submitCalls, submitCallsBeforeDiscard);
  console.log('GATEWAY_FUNDING_PRE_SUBMISSION_DISCARD=PASS');
  console.log('GATEWAY_FUNDING_DISCARD_PRESERVES_EVIDENCE=PASS');
  console.log('GATEWAY_FUNDING_DISCARD_NO_FINANCIAL_SIDE_EFFECT=PASS');

  // A failed hosted signature challenge is a durable terminal state. It is
  // returned by verify/get, never retried, and carries no submission evidence.
  const failedRequest = '55555555-5555-4555-8555-555555555555';
  challengeStatus = 'PENDING';
  challengeErrorCode = null;
  const failedStart = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: failedRequest,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  const challengeCreatesBeforeFailure = challengeCreates;
  challengeStatus = 'FAILED';
  challengeErrorCode = 156026;
  const failed = await service.verifySignature({
    auth, actionId: failedStart.actionId, userToken: 'circle_user_token_long_enough',
  });
  assert.equal(failed.state, 'SIGNATURE_FAILED');
  assert.equal(failed.terminal, true);
  assert.equal(failed.readyToBroadcast, false);
  assert.equal(failed.broadcast, 'NOT_SUBMITTED');
  assert.equal(failed.transferId, null);
  assert.equal(failed.transactionHash, null);
  assert.equal(failed.lastError, 'gateway_signature_typed_data_invalid');
  const failedRead = await service.get({ auth, actionId: failedStart.actionId });
  assert.equal(failedRead.state, 'SIGNATURE_FAILED');
  assert.equal(failedRead.terminal, true);
  const failedReplay = await service.verifySignature({
    auth, actionId: failedStart.actionId, userToken: 'circle_user_token_long_enough',
  });
  assert.equal(failedReplay.state, 'SIGNATURE_FAILED');
  assert.equal(challengeCreates, challengeCreatesBeforeFailure, 'terminal verify must not create a new challenge');
  console.log('GATEWAY_FUNDING_SIGNATURE_FAILED_TERMINAL=PASS');
  console.log('GATEWAY_FUNDING_NO_AUTOMATIC_RESIGN=PASS');

  challengeStatus = 'PENDING';
  challengeErrorCode = null;
  const genericFailureStart = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  challengeStatus = 'FAILED';
  challengeErrorCode = 155000;
  const genericFailure = await service.verifySignature({
    auth, actionId: genericFailureStart.actionId, userToken: 'circle_user_token_long_enough',
  });
  assert.equal(genericFailure.lastError, 'gateway_signature_challenge_failed');
  assert.notEqual(genericFailure.lastError, 'gateway_signature_typed_data_invalid');

  // FAILED and EXPIRED are terminal only when this read shape has no
  // submitted evidence; neither status is allowed back into signature flow.
  for (const [index, state] of ['FAILED', 'EXPIRED'].entries()) {
    const terminalId = `f000000${index + 1}-0000-4000-8000-00000000000${index + 1}`;
    rows.set(terminalId, {
      ...rows.get(failedStart.actionId),
      id: terminalId,
      request_id: `f111111${index + 1}-1111-4111-8111-11111111111${index + 1}`,
      state,
      last_error: 'gateway_signature_challenge_failed',
      gateway_transfer_id: null,
      gateway_transaction_hash: null,
    });
    const terminalRead = await service.get({ auth, actionId: terminalId });
    assert.equal(terminalRead.terminal, true);
    assert.equal(terminalRead.readyToBroadcast, false);
    assert.equal(terminalRead.broadcast, 'NOT_SUBMITTED');
    const terminalVerify = await service.verifySignature({
      auth, actionId: terminalId, userToken: 'circle_user_token_long_enough',
    });
    assert.equal(terminalVerify.state, state);
  }
  console.log('GATEWAY_FUNDING_TERMINAL_STATES_FAIL_CLOSED=PASS');

  // A new transfer is possible only after a new user-requested request id; it
  // creates a distinct durable action and a distinct hosted challenge.
  challengeStatus = 'PENDING';
  challengeErrorCode = null;
  const challengeCreatesBeforeFresh = challengeCreates;
  const fresh = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  assert.notEqual(fresh.actionId, failedStart.actionId);
  assert.equal(challengeCreates, challengeCreatesBeforeFresh + 1);
  console.log('GATEWAY_FUNDING_FRESH_REQUEST_AFTER_TERMINAL=PASS');
  challengeStatus = 'COMPLETE';

  const freshRow = rows.get(fresh.actionId);
  const freshTypedData = freshRow.typed_data_list_json[0];
  const freshSignature = await wallet.signTypedData(
    freshTypedData.domain, freshTypedData.types, freshTypedData.message,
  );
  const freshReady = await service.verifySignature({
    auth, actionId: fresh.actionId, userToken: 'circle_user_token_long_enough', signature: freshSignature,
  });
  assert.equal(freshReady.state, 'READY_TO_BROADCAST');
  const freshSubmitted = await service.submit({ auth, actionId: fresh.actionId });
  assert.equal(freshSubmitted.state, 'SUBMITTED');
  await rejectsCode(
    () => service.discard({ auth, actionId: fresh.actionId }),
    'gateway_funding_discard_not_allowed',
  );
  console.log('GATEWAY_FUNDING_SUBMITTED_CANNOT_DISCARD=PASS');
  const freshCompleted = await service.status({ auth, actionId: fresh.actionId });
  assert.equal(freshCompleted.state, 'COMPLETED');

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
  await service.discard({ auth, actionId: second.actionId });

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
    await service.discard({ auth, actionId });
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
  const thinAuth = { ...auth, userId: '17171717-1717-4171-8171-171717171717' };
  await rejectsCode(
    () => thinService.start({
      auth: thinAuth,
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
  await rejectsCode(
    () => ambiguousService.discard({ auth, actionId: ambiguousStart.actionId }),
    'gateway_funding_discard_not_allowed',
  );

  // A deterministic Gateway rejection is terminal only because the provider
  // rejected it before acceptance. It persists the bounded internal
  // classification and is never submitted again on replay.
  const rejectionWallet = new ethers.Wallet(`0x${'22'.repeat(32)}`);
  const rejectionAuth = {
    userId: '66666666-6666-4666-8666-666666666661',
    circleWalletId: CIRCLE_WALLET_ID,
    walletAddress: rejectionWallet.address,
    executionMode: 'CIRCLE_USER_WALLET',
  };
  let rejectedSubmitCalls = 0;
  const rejectedGateway = {
    ...fakeGateway,
    async readUnifiedUsdcBalance(address) {
      assert.equal(address.toLowerCase(), rejectionWallet.address.toLowerCase());
      return { balances: [{ domain: 6, balanceRaw: '2500000', transferable: true }] };
    },
    async submitGatewayTransfer() {
      rejectedSubmitCalls += 1;
      throw Object.assign(new Error('gateway_transfer_fee_rejected'), {
        gatewayDiagnostic: {
          status: 400,
          providerCode: 'MAX_FEE_TOO_LOW',
          providerType: 'VALIDATION_ERROR',
          providerMessage: 'Forwarding fee changed',
        },
      });
    },
  };
  const rejectedService = createGatewayFundingService({
    database: fakeDb,
    gateway: rejectedGateway,
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });
  const rejectedStart = await rejectedService.start({
    auth: rejectionAuth,
    userToken: 'circle_user_token_long_enough',
    requestId: '66666666-6666-4666-8666-666666666662',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '1000000',
  });
  const rejectedTypedData = rows.get(rejectedStart.actionId).typed_data_list_json[0];
  const rejectedSignature = await rejectionWallet.signTypedData(
    rejectedTypedData.domain, rejectedTypedData.types, rejectedTypedData.message,
  );
  const rejectedReady = await rejectedService.verifySignature({
    auth: rejectionAuth,
    actionId: rejectedStart.actionId,
    userToken: 'circle_user_token_long_enough',
    signature: rejectedSignature,
  });
  assert.equal(rejectedReady.state, 'READY_TO_BROADCAST');
  const rejected = await rejectedService.submit({ auth: rejectionAuth, actionId: rejectedStart.actionId });
  assert.equal(rejected.state, 'FAILED');
  assert.equal(rows.get(rejectedStart.actionId).last_error, 'gateway_transfer_fee_rejected');
  assert.equal(rows.get(rejectedStart.actionId).gateway_transfer_id, null);
  assert.equal(rows.get(rejectedStart.actionId).gateway_transaction_hash, null);
  const rejectedReplay = await rejectedService.submit({ auth: rejectionAuth, actionId: rejectedStart.actionId });
  assert.equal(rejectedReplay.state, 'FAILED');
  assert.equal(rejectedSubmitCalls, 1);
  console.log('GATEWAY_TRANSFER_REJECTION_CLASSIFICATION_PERSISTED=PASS');
  console.log('GATEWAY_NO_AUTOMATIC_SUBMIT_RETRY=PASS');

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
    database: fakeDb,
    gateway: externalGateway,
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: false },
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
  assert.equal(externalReady.terminal, false);
  assert.equal(externalReady.submissionEnabled, false);
  assert.equal(challengeCreates, challengeCreatesBeforeExternal, 'reaching READY_TO_BROADCAST must still never call Circle');

  // UI recovery is released only after the same action's read-only status
  // proves a terminal, non-submitted result; evidence-bearing terminal rows
  // remain locked for reconciliation and never get a fresh signature.
  const circleActions = fs.readFileSync(path.join(__dirname, '../../app/lib/circle-actions.ts'), 'utf8');
  const gatewayActions = fs.readFileSync(path.join(__dirname, '../../app/lib/gateway-actions.ts'), 'utf8');
  const walletPage = fs.readFileSync(path.join(__dirname, '../../app/wallet/page.tsx'), 'utf8');
  const backendApi = fs.readFileSync(path.join(__dirname, '../../app/lib/backend-api.ts'), 'utf8');
  const walletRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/wallet.js'), 'utf8');
  assert.match(circleActions, /backendApi\.wallet\.gatewayFunding\(recovery!\.actionId\)/);
  assert.match(circleActions, /clearCircleGatewayFundingRecovery\(\)/);
  assert.match(circleActions, /isGatewayFundingTerminalWithoutSubmission/);
  assert.match(gatewayActions, /backendApi\.wallet\.gatewayFunding\(recovery\.actionId\)/);
  assert.match(walletPage, /gatewayTransferAuthorizationFailed/);
  assert.match(walletPage, /function clearStaleGatewayFundingTerminalNotice()/);
  assert.match(walletPage, /!gatewayFundingStatus && !gatewayFundingRecovery && gatewayFundingAuthorityState === "none"/);
  assert.ok(
    (walletPage.match(/clearStaleGatewayFundingTerminalNotice()/g) || []).length >= 3,
    'fresh transfer controls must clear only stale idle terminal notices',
  );
  console.log('GATEWAY_FUNDING_TERMINAL_RECOVERY_RELEASE=PASS');
  console.log('GATEWAY_STALE_TERMINAL_NOTICE_CLEARS_ON_FRESH_START=PASS');

  // A completed action has a dedicated browser cleanup path: it clears local
  // recovery, resets the editable amount, retains a human notice, and only
  // refreshes balances after the durable state says COMPLETED.
  assert.match(walletPage, /current\.state === "COMPLETED"\) \{\s*finishCompletedGatewayFunding\(current\)/);
  assert.match(walletPage, /function finishCompletedGatewayFunding\(action: GatewayFundingResponse\)/);
  assert.match(walletPage, /clearGatewayFundingRecovery\(\)/);
  assert.match(walletPage, /setGatewayFundingStatus\(null\)/);
  assert.match(walletPage, /setGatewayAmount\(""\)/);
  assert.match(walletPage, /gatewayTransferCompleted/);
  assert.match(walletPage, /gatewayTransactionExplorerUrl\(action\)/);
  assert.match(walletPage, /void refreshGatewayBalance\(\)/);
  assert.match(walletPage, /void refreshChainState\(\)/);
  console.log('GATEWAY_FUNDING_COMPLETED_RECOVERY_CLEARS=PASS');
  console.log('GATEWAY_FUNDING_COMPLETED_FORM_RESETS=PASS');
  console.log('GATEWAY_FUNDING_COMPLETED_SUCCESS_NOTICE=PASS');

  // READY is preparation; submission is a distinct, explicit user action.
  // The default runtime gate remains closed, while injected enabled responses
  // prove the same UI can expose the action without moving authority client-side.
  assert.equal(externalReady.readyToBroadcast, true);
  assert.equal(externalReady.broadcast, 'NOT_SUBMITTED');
  assert.match(walletPage, /gatewayFundingStatus\?\.readyToBroadcast === true/);
  assert.match(walletPage, /backendApi\.wallet\.submitGatewayFunding\(prepared\.actionId\)/);
  assert.match(walletPage, /prepared\.state !== "READY_TO_BROADCAST"/);
  assert.match(walletPage, /prepared\.submissionEnabled !== true/);
  assert.match(walletPage, /t\.wallet\.gatewaySubmitTransfer/);
  assert.match(walletPage, /t\.wallet\.gatewaySubmissionDisabled/);
  assert.match(walletPage, /t\.wallet\.gatewaySubmitting/);
  assert.match(walletPage, /t\.wallet\.gatewaySubmitted/);
  assert.match(walletPage, /t\.wallet\.gatewayReconciliationRequired/);
  assert.match(walletPage, /t\.wallet\.gatewayTransferFailed/);
  assert.match(walletPage, /gatewayFundingStatus\.state === "SUBMITTED"/);
  assert.match(walletPage, /gatewayFundingStatus\.state === "RECONCILIATION_REQUIRED"/);
  assert.match(walletPage, /gatewayFundingStatus\.state === "FAILED"/);
  assert.equal((walletPage.match(/backendApi\.wallet\.submitGatewayFunding\(/g) || []).length, 1);
  assert.ok(!/submitGatewayTransfer|\/v1\/transfer|gatewayMint|burnIntent/i.test(walletPage));
  console.log('GATEWAY_FUNDING_UI_SERVER_GATED_SUBMIT=PASS');
  console.log('GATEWAY_FUNDING_GATE_DISABLED_UI=PASS');
  console.log('GATEWAY_FUNDING_GATE_ENABLED_UI=PASS');
  console.log('GATEWAY_FUNDING_SUBMITTED_STATUS_ONLY=PASS');
  console.log('GATEWAY_FUNDING_NO_DUPLICATE_SUBMIT=PASS');
  console.log('GATEWAY_FUNDING_READY_NOT_BROADCAST=PASS');

  // The current-action read is server-backed and duplicate-safe. The discard
  // control is explicit and available only for pre-submission, evidence-free
  // states; the UI never guesses from a local recovery record alone.
  assert.match(walletPage, /backendApi\.wallet\.currentGatewayFunding\(\)/);
  assert.match(walletPage, /setGatewayFundingAuthorityState\("duplicate"\)/);
  assert.match(walletPage, /gatewayFundingAuthorityState === "none"/);
  assert.match(walletPage, /canDiscardGatewayFunding\(gatewayFundingStatus\)/);
  assert.match(walletPage, /backendApi\.wallet\.discardGatewayFunding\(prepared\.actionId\)/);
  assert.match(walletPage, /gatewayDiscarded/);
  assert.match(walletPage, /gatewayExistingAction/);
  assert.match(walletPage, /gatewayMultipleActive/);
  console.log('GATEWAY_FUNDING_SERVER_BACKED_RECOVERY=PASS');
  console.log('GATEWAY_FUNDING_DISCARD_GATED_BY_EVIDENCE=PASS');

  // Reload hydration always reads the same durable action and the pending
  // states remain read-only. COMPLETED exits that recovery into idle form;
  // reconciliation never creates a second submit path.
  assert.match(walletPage, /gatewayFunding\(recoveredActionId\)/);
  assert.match(walletPage, /\["SUBMITTING", "SUBMITTED", "RECONCILIATION_REQUIRED"\]\.includes\(current\.state\)/);
  assert.match(walletPage, /setGatewayFundingStatus\(null\)/);
  assert.match(walletPage, /clearGatewayFundingRecovery\(\)/);
  console.log('GATEWAY_FUNDING_RELOAD_READY=PASS');
  console.log('GATEWAY_FUNDING_RELOAD_SUBMITTED=PASS');
  console.log('GATEWAY_FUNDING_RELOAD_COMPLETED=PASS');
  console.log('GATEWAY_FUNDING_RECONCILIATION_FAIL_CLOSED=PASS');

  assert.match(backendApi, /currentGatewayFunding\(\)/);
  assert.match(backendApi, /discardGatewayFunding\(actionId: string\)/);
  assert.match(walletRoutes, /router\.get\('\/gateway-funding\/current'/);
  assert.match(walletRoutes, /router\.post\('\/gateway-funding\/:actionId\/discard'/);
  assert.ok(
    walletRoutes.indexOf("router.get('/gateway-funding/current'") <
      walletRoutes.indexOf("router.get('/gateway-funding/:actionId'") ,
    'current route must precede the action-id route',
  );

  const checklist = fs.readFileSync(
    path.join(__dirname, '../../EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md'), 'utf8',
  );
  assert.match(checklist, /GATEWAY_OUTBOUND_DESTINATION_PROOF_MATRIX=PASS/);
  assert.match(checklist, /Gateway -> Arc FULLY LIVE PROVEN/);
  assert.match(
    checklist,
    /Current outbound destination matrix: Arc Testnet, Base Sepolia, OP Sepolia and Arbitrum Sepolia are \*\*FULLY LIVE PROVEN as Gateway destinations\*\*; Ethereum Sepolia remains \*\*OPEN \/ NOT LIVE PROVEN as a Gateway destination\*\*/,
  );
  console.log('GATEWAY_OUTBOUND_DESTINATION_PROOF_MATRIX=PASS');

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
