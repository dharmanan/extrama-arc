'use strict';

// Deterministic proof for automatic Gateway source allocation and multi-source
// signing.
//
// The product model is one unified balance: a user chooses an amount and a
// destination, and the server decides which deposited source balances pay for
// it. This file proves that decision is deterministic, never exceeds what a
// domain holds, never names an empty domain, fails closed when the total is
// short, and that a multi-source plan is signed and submitted as exactly the
// intents that were planned.
//
// Every adapter is in-memory. global.fetch is poisoned so a real network call
// fails the run instead of silently succeeding.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

let liveNetworkCalls = 0;
global.fetch = async () => {
  liveNetworkCalls += 1;
  throw new Error('live network disabled in deterministic verifier');
};

const gatewayService = require('../src/services/gatewayService');
const {
  canonicalJson,
  createGatewayFundingService,
  hashPayload,
} = require('../src/services/gatewayFundingService');

const {
  buildGatewayBurnIntent,
  buildGatewayTransferSpec,
  planSourceAllocation,
} = gatewayService;

const ARC_DOMAIN = 26;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CIRCLE_WALLET_ID = '22222222-2222-4222-8222-222222222222';

function balance(domain, balanceRaw, transferable = true) {
  return { domain, balanceRaw, transferable };
}

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error?.message === code);
}

// ---------------------------------------------------------------------------
// The planner itself
// ---------------------------------------------------------------------------

function verifyPlanner() {
  // One domain can cover the whole amount: exactly one intent, one signature.
  const single = planSourceAllocation({
    balances: [balance(6, '2500000'), balance(2, '100000')],
    valueRaw: '1000000',
  });
  assert.deepEqual(single.allocations, [{ sourceDomain: 6, valueRaw: '1000000' }]);
  assert.equal(single.totalValueRaw, '1000000');

  // Exact fit on one domain is still one intent.
  assert.deepEqual(
    planSourceAllocation({ balances: [balance(6, '1000000')], valueRaw: '1000000' }).allocations,
    [{ sourceDomain: 6, valueRaw: '1000000' }],
  );

  // The spec's own example: no single domain holds 2.00 USDC, so the transfer
  // is representable as a multi-source plan rather than rejected.
  const spread = planSourceAllocation({
    balances: [balance(6, '1000000'), balance(2, '750000'), balance(0, '250000')],
    valueRaw: '2000000',
  });
  assert.deepEqual(spread.allocations, [
    { sourceDomain: 6, valueRaw: '1000000' },
    { sourceDomain: 2, valueRaw: '750000' },
    { sourceDomain: 0, valueRaw: '250000' },
  ]);
  // The plan adds up to exactly the requested value, never more.
  assert.equal(
    spread.allocations.reduce((total, entry) => total + BigInt(entry.valueRaw), 0n),
    2000000n,
  );

  // Largest first keeps the plan minimal: only as many chains as necessary.
  const minimal = planSourceAllocation({
    balances: [balance(0, '400000'), balance(2, '400000'), balance(6, '1600000')],
    valueRaw: '1800000',
  });
  assert.equal(minimal.allocations.length, 2, 'uses two chains, not three');
  assert.deepEqual(minimal.allocations, [
    { sourceDomain: 6, valueRaw: '1600000' },
    { sourceDomain: 0, valueRaw: '200000' },
  ]);

  // No allocation ever exceeds what its domain holds.
  const available = new Map([[6, 1600000n], [0, 400000n], [2, 400000n]]);
  for (const entry of minimal.allocations) {
    assert.ok(
      BigInt(entry.valueRaw) <= available.get(entry.sourceDomain),
      'an allocation may never exceed the domain balance',
    );
  }

  // The order Gateway reports balances in must not change the plan.
  const input = [balance(6, '1000000'), balance(2, '750000'), balance(0, '250000')];
  const permutations = [
    [0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1],
  ];
  for (const order of permutations) {
    const plan = planSourceAllocation({
      balances: order.map((index) => input[index]),
      valueRaw: '2000000',
    });
    assert.deepEqual(plan.allocations, spread.allocations, 'plan replay is identical');
  }

  // Equal balances tie-break on domain ascending, so the plan stays total.
  const tie = planSourceAllocation({
    balances: [balance(6, '1000000'), balance(2, '1000000'), balance(0, '1000000')],
    valueRaw: '1500000',
  });
  assert.deepEqual(tie.allocations, [
    { sourceDomain: 0, valueRaw: '1000000' },
    { sourceDomain: 2, valueRaw: '500000' },
  ]);

  // A domain with nothing in it is never named in a plan.
  const withZeros = planSourceAllocation({
    balances: [balance(6, '0'), balance(2, '1000000'), balance(0, '0'), balance(3, '0')],
    valueRaw: '400000',
  });
  assert.deepEqual(withZeros.allocations, [{ sourceDomain: 2, valueRaw: '400000' }]);
  for (const entry of withZeros.allocations) {
    assert.notEqual(entry.valueRaw, '0');
  }

  // A balance Gateway reports but that cannot be burned through this signing
  // path (Solana, or any unlisted domain) is not spendable and is skipped.
  const withUnspendable = planSourceAllocation({
    balances: [balance(5, '9000000', false), balance(6, '1000000')],
    valueRaw: '1000000',
  });
  assert.deepEqual(withUnspendable.allocations, [{ sourceDomain: 6, valueRaw: '1000000' }]);
  assert.throws(
    () => planSourceAllocation({
      balances: [balance(5, '9000000', false)],
      valueRaw: '1000000',
    }),
    (error) => error.message === 'gateway_insufficient_usdc',
    'an unspendable balance can never fund a transfer',
  );

  // Total short of the request fails closed, including by a single unit.
  assert.throws(
    () => planSourceAllocation({
      balances: [balance(6, '1000000'), balance(2, '999999')],
      valueRaw: '2000000',
    }),
    (error) => error.message === 'gateway_insufficient_usdc',
  );
  assert.throws(
    () => planSourceAllocation({ balances: [], valueRaw: '1' }),
    (error) => error.message === 'gateway_insufficient_usdc',
  );

  // Circle caps a transfer at 16 intents, so a plan that would need more
  // fails closed instead of being submitted and partially rejected.
  const many = Array.from({ length: 20 }, (unused, index) => balance(100 + index, '1000'));
  assert.throws(
    () => planSourceAllocation({ balances: many, valueRaw: '20000' }),
    (error) => error.message === 'gateway_source_plan_too_many_intents',
  );
  // Exactly 16 is still allowed.
  const sixteen = Array.from({ length: 16 }, (unused, index) => balance(100 + index, '1000'));
  assert.equal(planSourceAllocation({ balances: sixteen, valueRaw: '16000' }).allocations.length, 16);

  // Malformed input is not silently treated as an empty plan.
  assert.throws(
    () => planSourceAllocation({ balances: [balance(6, '1000000')], valueRaw: '0' }),
    (error) => error.message === 'gateway_value_invalid',
  );
  assert.throws(
    () => planSourceAllocation({ balances: null, valueRaw: '1000000' }),
    (error) => error.message === 'gateway_source_plan_unavailable',
  );

  console.log('GATEWAY_AUTO_SOURCE_PLANNER=PASS');
}

// ---------------------------------------------------------------------------
// Multi-source signing through the durable state machine
// ---------------------------------------------------------------------------

function jsonb(value) { return value === null || value === undefined ? null : JSON.parse(value); }

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().reverse().map((key) => [key, reorderObjectKeys(value[key])]),
  );
}

function createFakeDb(rows) {
  const copy = (row) => (row ? JSON.parse(JSON.stringify(row)) : null);
  const out = (row) => ({ rows: row ? [copy(row)] : [], rowCount: row ? 1 : 0 });
  return {
    async query(sql, params) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('INSERT INTO gateway_funding_actions')) {
        const [
          id, userId, executionMode, circleWalletId, walletAddress,
          requestId, destinationDomain, valueRaw, signRequestId, expiresAt,
        ] = params;
        if ([...rows.values()].some((row) => row.user_id === userId && row.request_id === requestId)) {
          return out(null);
        }
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
        row.state = 'SIGNATURE_FAILED';
        row.last_error = 'gateway_signature_challenge_failed';
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
        if (row.state !== 'READY_TO_BROADCAST') return out(null);
        row.state = 'SUBMITTING';
        row.last_error = null;
        return out(row);
      }
      if (text.includes('SET last_error = $2')) {
        row.last_error = params[1];
        return out(null);
      }
      throw new Error(`unhandled SQL: ${text}`);
    },
  };
}

// Base 1.00, OP 0.75, Ethereum 0.25 and a request for 2.00 USDC, which is the
// case that has no single-source answer at all.
// Each source includes a 0.01 USDC fee reserve. The requested plan itself is
// still exactly 2.00 USDC; the extra balance is never allocated.
const SPREAD_BALANCES = [balance(6, '1010000'), balance(2, '760000'), balance(0, '260000')];
const SPREAD_PLAN = [
  { sourceDomain: 6, valueRaw: '1000000' },
  { sourceDomain: 2, valueRaw: '750000' },
  { sourceDomain: 0, valueRaw: '250000' },
];

function createFakeGateway(walletAddress, state) {
  return {
    async readUnifiedUsdcBalance(address) {
      assert.equal(address.toLowerCase(), walletAddress.toLowerCase());
      return { balances: SPREAD_BALANCES };
    },
    buildGatewayTransferSpec,
    planSourceAllocation,
    enumerateSourceAllocationPlans: gatewayService.enumerateSourceAllocationPlans,
    async estimateGatewayTransfer(specs) {
      assert.ok(Array.isArray(specs), 'the whole plan is priced in one request');
      state.estimateCalls += 1;
      state.estimatedSpecCounts.push(specs.length);
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
      state.submitCalls += 1;
      state.submitted = requests;
      assert.equal(requestId.length, 36);
      return { transferId: '55555555-5555-4555-8555-555555555555' };
    },
    async readGatewayTransferStatus() {
      return { status: 'pending', transactionHash: null, forwardingFailure: null };
    },
  };
}

function createFeeGateway(walletAddress, balances, feeByDomain, state) {
  return {
    async readUnifiedUsdcBalance(address) {
      assert.equal(address.toLowerCase(), walletAddress.toLowerCase());
      return { balances };
    },
    buildGatewayTransferSpec,
    enumerateSourceAllocationPlans: gatewayService.enumerateSourceAllocationPlans,
    async estimateGatewayTransfer(specs) {
      state.estimateCalls += 1;
      state.estimatedSpecCounts.push(specs.length);
      return {
        intents: specs.map((spec) => ({
          maxFeeRaw: String(feeByDomain[spec.sourceDomain] || 0),
          maxBlockHeight: '999999999',
        })),
        // Deliberately omit fees.total: the planner must have a safe fallback
        // to the individual maxFee reserves when the API omits a total.
        fees: { token: 'USDC' },
      };
    },
    buildGatewayBurnIntent,
    recoverBurnIntentSigner(typedData, signature) {
      return ethers.verifyTypedData(typedData.domain, typedData.types, typedData.message, signature);
    },
    ARC_GATEWAY_DOMAIN: ARC_DOMAIN,
  };
}

async function verifyFeeAwarePlanner() {
  const wallet = new ethers.Wallet(`0x${'99'.repeat(32)}`);

  async function prepare({ requestId, balances, feeByDomain, valueRaw }) {
    const rows = new Map();
    const state = { estimateCalls: 0, estimatedSpecCounts: [] };
    const service = createGatewayFundingService({
      database: createFakeDb(rows),
      gateway: createFeeGateway(wallet.address, balances, feeByDomain, state),
      circle: {},
    });
    const result = await service.start({
      auth: { userId: USER_ID, walletAddress: wallet.address, executionMode: 'EXTERNAL_WALLET' },
      requestId,
      destinationDomain: ARC_DOMAIN,
      valueRaw,
    });
    return { result, state };
  }

  // A grossly sufficient balance is not enough when its fee reserve leaves it
  // short. With no second source, preparation fails before any signature.
  await rejectsCode(
    () => prepare({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      balances: [balance(6, '1005000')],
      feeByDomain: { 6: '10000' },
      valueRaw: '1000000',
    }),
    'gateway_insufficient_after_fees',
  );

  // When two sources can cover the value, the lower-fee single source wins.
  const cheaper = await prepare({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    balances: [balance(6, '2000000'), balance(2, '2000000')],
    feeByDomain: { 6: '30000', 2: '5000' },
    valueRaw: '1000000',
  });
  assert.deepEqual(cheaper.result.sourcePlan, [{ sourceDomain: 2, valueRaw: '1000000' }]);
  assert.deepEqual(cheaper.state.estimatedSpecCounts, [1, 1]);
  console.log('GATEWAY_FEE_AWARE_SOURCE_SELECTION=PASS');

  // A single source is short only after fees, but the exact multi-source
  // candidate covers the requested value and is checked against each fee.
  const spread = await prepare({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    balances: [balance(6, '1005000'), balance(2, '20000')],
    feeByDomain: { 6: '10000', 2: '1000' },
    valueRaw: '1000000',
  });
  assert.deepEqual(spread.result.sourcePlan, [
    { sourceDomain: 6, valueRaw: '995000' },
    { sourceDomain: 2, valueRaw: '5000' },
  ]);
  assert.deepEqual(spread.state.estimatedSpecCounts, [1, 1, 2]);

  // A balance that would otherwise cover the amount cannot enter signing when
  // its maxFee reserve makes it short.
  await rejectsCode(
    () => prepare({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      balances: [balance(6, '2000000')],
      feeByDomain: { 6: '20000' },
      valueRaw: '1990000',
    }),
    'gateway_insufficient_after_fees',
  );

  // Replaying the same deterministic inputs in a fresh durable adapter yields
  // the same source plan, payload hash and per-intent salt.
  const first = await prepare({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    balances: [balance(6, '1005000'), balance(2, '20000')],
    feeByDomain: { 6: '10000', 2: '1000' },
    valueRaw: '1000000',
  });
  const second = await prepare({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
    balances: [balance(6, '1005000'), balance(2, '20000')],
    feeByDomain: { 6: '10000', 2: '1000' },
    valueRaw: '1000000',
  });
  assert.deepEqual(second.result.sourcePlan, first.result.sourcePlan);
  assert.equal(second.result.payloadHash, first.result.payloadHash);
  assert.deepEqual(second.result.typedDataList, first.result.typedDataList);
  console.log('GATEWAY_FEE_SAFE_PLANNER=PASS');
}

async function verifyBoundedPlanner() {
  const canonicalDomains = new Set([0, 2, 3, 6, 26]);
  const allCanonical = [0, 2, 3, 6, 26].map((domain) => balance(domain, '1000000'));
  const allCandidates = gatewayService.enumerateSourceAllocationPlans({
    balances: [
      ...allCanonical,
      balance(1, '9000000'),
      balance(7, '9000000'),
      balance(19, '9000000'),
    ],
    valueRaw: '5',
  });
  assert.equal(allCandidates.length, 31, 'five canonical sources have at most 31 non-empty subsets');
  assert.ok(allCandidates.every((plan) => plan.allocations.every((entry) => (
    canonicalDomains.has(entry.sourceDomain)
  ))));

  // A positive low-level Gateway balance outside the EXTREMA product source
  // set remains visible in totalRaw but cannot inflate the spendable total.
  const wallet = ethers.getAddress(`0x${'44'.repeat(20)}`);
  const read = await gatewayService.readUnifiedUsdcBalance(wallet, async () => ({
    ok: true,
    async json() {
      return {
        token: 'USDC',
        balances: [
          { domain: 1, depositor: wallet, balance: '9' },
          { domain: 6, depositor: wallet, balance: '2' },
        ],
      };
    },
  }));
  assert.equal(read.totalRaw, '11000000');
  assert.equal(read.transferableTotalRaw, '2000000');
  assert.equal(read.balances.find((item) => item.domain === 1).transferable, false);
  assert.equal(read.balances.find((item) => item.domain === 6).transferable, true);

  // Once the first valid two-source level is found, three-source candidates are
  // never estimated. The call count is also below the five-domain hard ceiling.
  const bounded = await (async () => {
    const rows = new Map();
    const state = { estimateCalls: 0, estimatedSpecCounts: [] };
    const service = createGatewayFundingService({
      database: createFakeDb(rows),
      gateway: createFeeGateway(wallet, [
        balance(26, '10000'),
        balance(6, '1005000'),
        balance(2, '20000'),
        balance(3, '10000'),
        balance(0, '10000'),
      ], { 26: '1000', 6: '10000', 2: '1000', 3: '1000', 0: '1000' }, state),
      circle: {},
    });
    const result = await service.start({
      auth: { userId: USER_ID, walletAddress: wallet, executionMode: 'EXTERNAL_WALLET' },
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
      destinationDomain: ARC_DOMAIN,
      valueRaw: '1000000',
    });
    return { result, state };
  })();
  assert.ok(bounded.result.sourcePlan.length <= 2);
  assert.ok(bounded.state.estimatedSpecCounts.includes(2));
  assert.ok(bounded.state.estimatedSpecCounts.every((count) => count <= 2));
  assert.ok(bounded.state.estimateCalls <= 31);
  console.log('GATEWAY_SOURCE_PLANNER_BOUNDED=PASS');
}

async function verifyCircleMultiSource() {
  const wallet = new ethers.Wallet(`0x${'55'.repeat(32)}`);
  const auth = {
    userId: USER_ID,
    circleWalletId: CIRCLE_WALLET_ID,
    walletAddress: wallet.address,
    executionMode: 'CIRCLE_USER_WALLET',
  };
  const rows = new Map();
  const state = { estimateCalls: 0, estimatedSpecCounts: [], submitCalls: 0, submitted: null };

  const challengesByKey = new Map();
  let challengeCreates = 0;
  const fakeCircle = {
    async createTypedDataChallenge({ walletId, typedData, idempotencyKey }) {
      assert.equal(walletId, CIRCLE_WALLET_ID);
      assert.equal(typedData.primaryType, 'BurnIntent');
      // The same idempotency key must never produce a second challenge.
      if (challengesByKey.has(idempotencyKey)) {
        return { challengeId: challengesByKey.get(idempotencyKey) };
      }
      challengeCreates += 1;
      const challengeId = `plan-challenge-${challengeCreates}`;
      challengesByKey.set(idempotencyKey, challengeId);
      state[`challenge_${challengeId}`] = typedData;
      return { challengeId };
    },
    async getTypedDataChallenge({ challengeId }) {
      return { id: challengeId, type: 'SIGN_TYPEDDATA', status: 'COMPLETE' };
    },
  };

  const service = createGatewayFundingService({
    database: createFakeDb(rows),
    gateway: createFakeGateway(wallet.address, state),
    circle: fakeCircle,
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });

  const requestId = '66666666-6666-4666-8666-666666666661';
  const started = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '2000000',
  });

  // The server resolved a three-way plan the browser never asked for.
  assert.deepEqual(started.sourcePlan, SPREAD_PLAN);
  assert.equal(started.intentCount, 3);
  assert.equal(state.estimateCalls, 4, 'one-source probes plus one exact multi-source estimate');
  assert.deepEqual(state.estimatedSpecCounts, [1, 1, 1, 3]);
  assert.equal(started.signatureIndex, 0, 'signing starts at the first allocation');
  assert.equal(started.challengeId, 'plan-challenge-1');
  assert.equal(challengeCreates, 1, 'only the first allocation has a challenge yet');

  // Every intent carries its own source and value, and all share the one
  // destination and recipient.
  const expectedDepositor = ethers.zeroPadValue(wallet.address, 32).toLowerCase();
  started.typedDataList.forEach((typedData, index) => {
    const spec = typedData.message.spec;
    assert.equal(spec.sourceDomain, SPREAD_PLAN[index].sourceDomain);
    assert.equal(spec.value, SPREAD_PLAN[index].valueRaw);
    assert.equal(spec.destinationDomain, ARC_DOMAIN);
    assert.equal(spec.destinationRecipient.toLowerCase(), expectedDepositor);
    assert.equal(spec.sourceSigner.toLowerCase(), expectedDepositor);
    assert.equal(typedData.primaryType, 'BurnIntent');
  });
  // Distinct salts, so two allocations can never collide as the same intent.
  assert.equal(
    new Set(started.typedDataList.map((typedData) => typedData.message.spec.salt)).size, 3,
  );

  // A replay must not create a second challenge for the same allocation.
  const replay = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '2000000',
  });
  assert.equal(replay.challengeId, 'plan-challenge-1');
  assert.equal(challengeCreates, 1);
  assert.deepEqual(replay.sourcePlan, SPREAD_PLAN);
  assert.equal(state.estimateCalls, 4, 'a replay never re-prices the plan');

  // Sign allocation by allocation. Each step issues the next challenge and the
  // action stays short of READY_TO_BROADCAST until every intent is signed.
  const signatures = [];
  for (let index = 0; index < 3; index += 1) {
    const current = await service.get({ auth, actionId: started.actionId });
    assert.equal(current.signatureIndex, index);
    assert.equal(current.state, 'SIGNATURE_PENDING');
    const typedData = current.typedDataList[index];
    const signature = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
    signatures.push(signature);
    const result = await service.verifySignature({
      auth, actionId: started.actionId, userToken: 'circle_user_token_long_enough', signature,
    });
    if (index < 2) {
      assert.equal(result.state, 'SIGNATURE_PENDING', 'a partly signed plan is never ready');
      assert.equal(result.readyToBroadcast, false);
      assert.equal(result.signatureIndex, index + 1);
      assert.equal(result.challengeId, `plan-challenge-${index + 2}`);
    } else {
      assert.equal(result.state, 'READY_TO_BROADCAST');
      assert.equal(result.signatureIndex, -1);
    }
  }
  assert.equal(challengeCreates, 3, 'exactly one challenge per allocation');

  // A signature that recovers to anyone else is refused, even mid-plan.
  const stranger = new ethers.Wallet(`0x${'66'.repeat(32)}`);
  const strangerRequest = '66666666-6666-4666-8666-666666666662';
  const strangerAction = await service.start({
    auth,
    userToken: 'circle_user_token_long_enough',
    requestId: strangerRequest,
    destinationDomain: ARC_DOMAIN,
    valueRaw: '2000000',
  });
  const strangerTypedData = strangerAction.typedDataList[0];
  const strangerSignature = await stranger.signTypedData(
    strangerTypedData.domain, strangerTypedData.types, strangerTypedData.message,
  );
  await rejectsCode(
    () => service.verifySignature({
      auth, actionId: strangerAction.actionId, userToken: 'circle_user_token_long_enough',
      signature: strangerSignature,
    }),
    'gateway_signature_wallet_mismatch',
  );
  // A signature for allocation 0 that was actually made over allocation 1's
  // message is rejected too: the index and the message are bound together.
  const crossSignature = await wallet.signTypedData(
    strangerAction.typedDataList[1].domain,
    strangerAction.typedDataList[1].types,
    strangerAction.typedDataList[1].message,
  );
  await rejectsCode(
    () => service.verifySignature({
      auth, actionId: strangerAction.actionId, userToken: 'circle_user_token_long_enough',
      signature: crossSignature,
    }),
    'gateway_signature_wallet_mismatch',
  );

  // Submission sends exactly the three planned, persisted, signed intents.
  const submitted = await service.submit({ auth, actionId: started.actionId });
  assert.equal(submitted.state, 'SUBMITTED');
  assert.equal(state.submitCalls, 1);
  assert.equal(state.submitted.length, 3, 'one entry per source allocation');
  const persisted = rows.get(started.actionId);
  state.submitted.forEach((entry, index) => {
    assert.deepEqual(
      entry.burnIntent, persisted.burn_intents_json[index],
      'the submitted object is exactly the persisted, signed object',
    );
    assert.equal(entry.signature, signatures[index]);
    assert.equal(entry.burnIntent.spec.sourceDomain, SPREAD_PLAN[index].sourceDomain);
    assert.equal(entry.burnIntent.spec.destinationDomain, ARC_DOMAIN);
    // Every signature still verifies against the exact submitted intent.
    const recovered = ethers.verifyTypedData(
      gatewayService.BURN_INTENT_EIP712_DOMAIN,
      gatewayService.BURN_INTENT_EIP712_TYPES,
      entry.burnIntent,
      entry.signature,
    );
    assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase());
  });
  assert.equal(
    state.submitted.reduce((total, entry) => total + BigInt(entry.burnIntent.spec.value), 0n),
    2000000n,
    'the submitted intents sum to exactly the requested value',
  );

  // A replay cannot submit a second transfer.
  await service.submit({ auth, actionId: started.actionId });
  assert.equal(state.submitCalls, 1);

  return { rows, service, auth, wallet, state };
}

async function verifyMultiSourceTampering() {
  const wallet = new ethers.Wallet(`0x${'77'.repeat(32)}`);
  const auth = {
    userId: USER_ID,
    walletAddress: wallet.address,
    executionMode: 'EXTERNAL_WALLET',
  };
  const rows = new Map();
  const state = { estimateCalls: 0, estimatedSpecCounts: [], submitCalls: 0, submitted: null };
  const service = createGatewayFundingService({
    database: createFakeDb(rows),
    gateway: createFakeGateway(wallet.address, state),
    circle: {},
    runtimeConfig: { EXTREMA_ENABLE_GATEWAY_BROADCAST: true },
  });

  async function readyPlan(requestId) {
    const started = await service.start({
      auth, requestId, destinationDomain: ARC_DOMAIN, valueRaw: '2000000',
    });
    assert.equal(started.intentCount, 3);
    assert.equal(started.challengeId, null, 'external mode never creates a Circle challenge');
    // An external wallet may return the whole set of signatures at once.
    const signatures = [];
    for (const typedData of started.typedDataList) {
      signatures.push(await wallet.signTypedData(typedData.domain, typedData.types, typedData.message));
    }
    const ready = await service.verifySignature({
      auth, actionId: started.actionId, signatures,
    });
    assert.equal(ready.state, 'READY_TO_BROADCAST');
    assert.equal(ready.signatureIndex, -1);
    return ready.actionId;
  }

  const happyActionId = await readyPlan('88888888-8888-4888-8888-888888888801');
  assert.equal(rows.get(happyActionId).signatures_json.length, 3);

  // PostgreSQL JSONB may return object keys in a different order. The durable
  // binding is canonical, so a semantically identical JSONB round-trip still
  // verifies and submits the same payload.
  const jsonbRoundTripActionId = await readyPlan('88888888-8888-4888-8888-888888888800');
  const jsonbRoundTripRow = rows.get(jsonbRoundTripActionId);
  const payload = {
    destinationDomain: jsonbRoundTripRow.destination_domain,
    valueRaw: jsonbRoundTripRow.value_raw,
    allocations: jsonbRoundTripRow.source_plan_json,
    burnIntents: jsonbRoundTripRow.burn_intents_json,
  };
  const reorderedPayload = reorderObjectKeys(payload);
  assert.equal(canonicalJson(payload), canonicalJson(reorderedPayload));
  assert.equal(hashPayload(payload), hashPayload(reorderedPayload));
  const jsonbRoundTripSubmitted = await service.submit({ auth, actionId: jsonbRoundTripActionId });
  assert.equal(jsonbRoundTripSubmitted.state, 'SUBMITTED');
  console.log('GATEWAY_CANONICAL_PAYLOAD_HASH=PASS');
  console.log('GATEWAY_JSONB_ROUNDTRIP_HASH=PASS');

  // A partial signature set is never accepted as complete.
  const partialStarted = await service.start({
    auth,
    requestId: '88888888-8888-4888-8888-888888888802',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '2000000',
  });
  const firstTypedData = partialStarted.typedDataList[0];
  const onlyFirst = await wallet.signTypedData(
    firstTypedData.domain, firstTypedData.types, firstTypedData.message,
  );
  const partial = await service.verifySignature({
    auth, actionId: partialStarted.actionId, signatures: [onlyFirst],
  });
  assert.equal(partial.state, 'SIGNATURE_PENDING');
  assert.equal(partial.readyToBroadcast, false);
  assert.equal(partial.signatureIndex, 1);
  await rejectsCode(
    () => service.submit({ auth, actionId: partialStarted.actionId }),
    'gateway_funding_not_ready',
  );

  // Altering ANY allocation of a prepared multi-source plan fails closed
  // before submission, including the ones that are not first.
  const mutations = [
    ['88888888-8888-4888-8888-888888888811', 1, (intent) => { intent.spec.sourceDomain = 3; }],
    ['88888888-8888-4888-8888-888888888812', 2, (intent) => { intent.spec.value = '250001'; }],
    ['88888888-8888-4888-8888-888888888813', 1, (intent) => { intent.spec.destinationDomain = 6; }],
    ['88888888-8888-4888-8888-888888888814', 2, (intent) => {
      intent.spec.destinationRecipient = ethers.zeroPadValue(`0x${'99'.repeat(20)}`, 32);
    }],
  ];
  for (const [requestId, index, mutate] of mutations) {
    const actionId = await readyPlan(requestId);
    const row = rows.get(actionId);
    row.burn_intents_json = JSON.parse(JSON.stringify(row.burn_intents_json));
    mutate(row.burn_intents_json[index]);
    await rejectsCode(
      () => service.submit({ auth, actionId }),
      'gateway_funding_payload_mismatch',
    );
  }

  // Dropping or reordering an allocation is caught by the same binding.
  const droppedActionId = await readyPlan('88888888-8888-4888-8888-888888888821');
  const droppedRow = rows.get(droppedActionId);
  droppedRow.burn_intents_json = droppedRow.burn_intents_json.slice(0, 2);
  await rejectsCode(
    () => service.submit({ auth, actionId: droppedActionId }),
    'gateway_funding_payload_mismatch',
  );

  const reorderedActionId = await readyPlan('88888888-8888-4888-8888-888888888822');
  const reorderedRow = rows.get(reorderedActionId);
  reorderedRow.burn_intents_json = [
    reorderedRow.burn_intents_json[1],
    reorderedRow.burn_intents_json[0],
    reorderedRow.burn_intents_json[2],
  ];
  await rejectsCode(
    () => service.submit({ auth, actionId: reorderedActionId }),
    'gateway_funding_payload_mismatch',
  );

  // Rewriting the persisted PLAN to name a source the intents do not use is
  // caught as well, so the plan and the intents cannot drift apart.
  const planTamperActionId = await readyPlan('88888888-8888-4888-8888-888888888823');
  const planRow = rows.get(planTamperActionId);
  planRow.source_plan_json = JSON.parse(JSON.stringify(planRow.source_plan_json));
  planRow.source_plan_json[0].sourceDomain = 3;
  await rejectsCode(
    () => service.submit({ auth, actionId: planTamperActionId }),
    'gateway_funding_payload_mismatch',
  );

  console.log('GATEWAY_MULTI_SOURCE_INTENT=PASS');
}

async function verifyExternalPartialSignatureRecovery() {
  const wallet = new ethers.Wallet(`0x${'aa'.repeat(32)}`);
  const auth = {
    userId: USER_ID,
    walletAddress: wallet.address,
    executionMode: 'EXTERNAL_WALLET',
  };
  const rows = new Map();
  const state = { estimateCalls: 0, estimatedSpecCounts: [], submitCalls: 0, submitted: null };
  const service = createGatewayFundingService({
    database: createFakeDb(rows),
    gateway: createFakeGateway(wallet.address, state),
    circle: {},
  });

  const started = await service.start({
    auth,
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '2000000',
  });
  assert.equal(started.intentCount, 3);

  const requestedIndexes = [];
  async function signAt(index) {
    requestedIndexes.push(index);
    const typedData = started.typedDataList[index];
    return wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
  }

  // The first verify response is lost after the server durably accepts intent 0.
  const firstSignature = await signAt(0);
  const partial = await service.verifySignature({
    auth, actionId: started.actionId, signatures: [firstSignature],
  });
  assert.equal(partial.signatureIndex, 1);
  assert.equal(partial.state, 'SIGNATURE_PENDING');

  // A browser reload reads the same action and sends only the unsigned tail.
  const reloaded = await service.get({ auth, actionId: started.actionId });
  assert.equal(reloaded.signatureIndex, 1);
  const resumedSignatures = [await signAt(1), await signAt(2)];
  assert.ok(resumedSignatures.every((signature) => /^0x[0-9a-fA-F]{130}$/.test(signature)));
  assert.ok(!resumedSignatures.includes(''));
  const ready = await service.verifySignature({
    auth, actionId: started.actionId, signatures: resumedSignatures,
  });
  assert.equal(ready.state, 'READY_TO_BROADCAST');
  assert.equal(ready.signatureIndex, -1);
  assert.deepEqual(requestedIndexes, [0, 1, 2]);

  const persisted = rows.get(started.actionId);
  assert.equal(persisted.signatures_json[0], firstSignature, 'intent 0 signature is never replaced');
  assert.deepEqual(persisted.signatures_json, [firstSignature, ...resumedSignatures]);
  persisted.signatures_json.forEach((signature, index) => {
    const typedData = persisted.typed_data_list_json[index];
    assert.equal(
      ethers.verifyTypedData(typedData.domain, typedData.types, typedData.message, signature).toLowerCase(),
      wallet.address.toLowerCase(),
    );
  });

  // The API schema rejects empty placeholders and the frontend never pushes
  // one. This is a static proof of the boundary plus the exact signature shape.
  const walletRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/wallet.js'), 'utf8');
  const verifySchemaStart = walletRoutes.indexOf('const gatewayFundingVerifySchema');
  const verifySchemaEnd = walletRoutes.indexOf('const gatewayDepositStartSchema');
  const verifySchema = walletRoutes.slice(verifySchemaStart, verifySchemaEnd);
  assert.match(
    verifySchema,
    /signatures: z\.array\(z\.string\(\)\.regex\(\/\^0x\[0-9a-fA-F\]\{130\}\$\/\)\)/,
  );
  assert.ok(!verifySchema.includes("z.literal('')"));
  const signaturePattern = /^0x[0-9a-fA-F]{130}$/;
  assert.equal(signaturePattern.test(''), false);
  assert.equal(signaturePattern.test(`0x${'11'.repeat(65)}`), true);

  const gatewayActions = fs.readFileSync(path.join(__dirname, '../../app/lib/gateway-actions.ts'), 'utf8');
  assert.match(gatewayActions, /const firstUnsignedIndex = Math\.max\(0, started\.signatureIndex\)/);
  assert.doesNotMatch(gatewayActions, /signatures\.push\(""\)/);
  console.log('GATEWAY_EXTERNAL_PARTIAL_SIGNATURE_RECOVERY=PASS');
}

async function verifyBrowserCannotChooseSource() {
  // The transfer entry point takes a destination and an amount. A client that
  // tries to smuggle a source domain in changes nothing: the field is not read
  // and the plan is still derived from the wallet's own Gateway balances.
  const wallet = new ethers.Wallet(`0x${'88'.repeat(32)}`);
  const auth = {
    userId: USER_ID,
    walletAddress: wallet.address,
    executionMode: 'EXTERNAL_WALLET',
  };
  const rows = new Map();
  const state = { estimateCalls: 0, estimatedSpecCounts: [], submitCalls: 0, submitted: null };
  const service = createGatewayFundingService({
    database: createFakeDb(rows),
    gateway: createFakeGateway(wallet.address, state),
    circle: {},
  });

  const withSmuggledSource = await service.start({
    auth,
    requestId: '99999999-9999-4999-8999-999999999901',
    destinationDomain: ARC_DOMAIN,
    valueRaw: '2000000',
    // Not part of the contract. Present here only to prove it is ignored.
    sourceDomain: 3,
    sourcePlan: [{ sourceDomain: 3, valueRaw: '2000000' }],
  });
  assert.deepEqual(
    withSmuggledSource.sourcePlan, SPREAD_PLAN,
    'a client-supplied source is ignored entirely',
  );
  withSmuggledSource.typedDataList.forEach((typedData, index) => {
    assert.equal(typedData.message.spec.sourceDomain, SPREAD_PLAN[index].sourceDomain);
  });

  console.log('GATEWAY_FRONTEND_NEVER_CHOOSES_SOURCE=PASS');
}

(async () => {
  verifyPlanner();
  await verifyFeeAwarePlanner();
  await verifyBoundedPlanner();
  await verifyCircleMultiSource();
  await verifyExternalPartialSignatureRecovery();
  await verifyMultiSourceTampering();
  await verifyBrowserCannotChooseSource();
  assert.equal(liveNetworkCalls, 0);
  console.log('GATEWAY_TRANSFER_PLAN_LIVE_NETWORK_CALLS=0');
  console.log('LIVE_GATEWAY_BROADCAST=NOT_EXECUTED');
  console.log('GATEWAY_TRANSFER_PLAN=PASS');
})().catch((error) => {
  console.error('GATEWAY_TRANSFER_PLAN=FAIL', error);
  process.exitCode = 1;
});
