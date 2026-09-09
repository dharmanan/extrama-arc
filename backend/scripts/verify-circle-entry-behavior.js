'use strict';

// Behavioral regression coverage for the Circle entry polling/session-refresh/
// rate-limit hardening in app/lib/circle-entry.ts and the per-route
// CIRCLE_VERIFY_LIMIT split in src/routes/actions.js.
//
// Every scenario here actually executes the real confirmCircleEntry() state
// machine -- transpiled straight from the shipped TypeScript, not
// reimplemented -- against hand-written fakes. It never calls real Circle,
// never sends a real Arc transaction, and never waits real wall-clock time
// even when a scenario simulates minutes of virtual polling.
//
// verify-circle-entry.js (static/source-text checks) stays the structural
// complement to this file; this file is the behavioral proof.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify-only-session-secret-not-for-runtime';
process.env.NEXT_PUBLIC_CIRCLE_APP_ID ||= 'behavior-test-circle-app-id';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const CIRCLE_ENTRY_SOURCE_PATH = path.resolve(__dirname, '../../app/lib/circle-entry.ts');
const CIRCLE_VERIFY_POLL_INTERVAL_MS = 4000;

const INPUT = {
  poolAddress: '0xPOOL0000000000000000000000000000000001',
  roundId: 7,
  predictionPriceCents: 987654,
  requestId: 'behavior-request-1',
};

const START_RESULT_ENTRY_READY = {
  actionId: 'behavior-action-entry-ready',
  payloadHash: 'behavior-payload-hash-1',
  step: 'ENTRY_READY',
  challengeId: 'behavior-entry-challenge-1',
};

const START_RESULT_APPROVAL_REQUIRED = {
  actionId: 'behavior-action-approval-required',
  payloadHash: 'behavior-payload-hash-2',
  step: 'APPROVAL_REQUIRED',
  challengeId: 'behavior-approval-challenge-1',
};

function finalEntryResult(startResult, overrides = {}) {
  return {
    actionId: startResult.actionId,
    payloadHash: startResult.payloadHash,
    result: {
      roundId: INPUT.roundId,
      predictionPriceCents: INPUT.predictionPriceCents,
      poolAddress: INPUT.poolAddress,
      approvalTxHash: null,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Harness: transpile the real frontend module (TypeScript compiler API, no
// new dependency -- it is already a root devDependency reachable from here)
// and run its actual body with faked dependencies substituted for its two
// imports and the dynamic Circle widget SDK import.
// ---------------------------------------------------------------------------

function transpileCircleEntry() {
  const source = fs.readFileSync(CIRCLE_ENTRY_SOURCE_PATH, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: 'circle-entry.ts',
  });
  return outputText;
}

function loadCircleEntry({ requireMap, window }) {
  const code = transpileCircleEntry();
  const moduleObject = { exports: {} };
  function fakeRequire(id) {
    if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
    throw new Error(`circle-entry behavior harness: unmocked require("${id}")`);
  }
  const run = new Function('module', 'exports', 'require', 'window', code);
  run(moduleObject, moduleObject.exports, fakeRequire, window);
  return moduleObject.exports;
}

// Records every requested delay and fires almost immediately instead of
// actually waiting -- so a scenario simulating minutes of polling still runs
// in well under a second of real time.
function createFakeWindow() {
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      return setImmediate(fn);
    },
  };
}

// Pops one scripted response per call. A step may throw to simulate a
// transient failure such as session_expired.
function createSequence(name, steps) {
  let index = 0;
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    if (index >= steps.length) {
      throw new Error(`${name}: sequence exhausted after ${calls.length} calls`);
    }
    const step = steps[index];
    index += 1;
    return step(...args);
  };
  fn.calls = calls;
  return fn;
}

function createCircleAuthMock() {
  const stored = [];
  const cleared = [];
  return {
    stored,
    cleared,
    module: {
      readCircleTabAuth: () => ({ userToken: 'behavior-user-token', encryptionKey: 'behavior-encryption-key' }),
      readCircleEntryRecovery: () => null,
      matchesCircleEntryRecovery: () => true,
      storeCircleEntryRecovery: (recovery) => { stored.push(recovery); },
      clearCircleEntryRecovery: () => { cleared.push(true); },
    },
  };
}

function createBackendApiMock({ startResult, approvalSteps = [], entrySteps = [], sessionSucceeds = true }) {
  const sessionCalls = [];
  const startCalls = [];
  const verifyApproval = createSequence('verifyCircleEntryApproval', approvalSteps);
  const verifyEntry = createSequence('verifyCircleEntry', entrySteps);
  return {
    sessionCalls,
    startCalls,
    verifyApproval,
    verifyEntry,
    module: {
      circle: {
        session: async (userToken) => {
          sessionCalls.push(userToken);
          if (!sessionSucceeds) throw new Error('circle_session_refresh_failed');
          return { refreshed: true };
        },
      },
      actions: {
        startCircleEntry: async (input) => { startCalls.push(input); return startResult; },
        verifyCircleEntryApproval: (...args) => verifyApproval(...args),
        verifyCircleEntry: (...args) => verifyEntry(...args),
      },
      wallet: { get: async () => ({ wallet: null }) },
      rounds: { list: async () => ({ pools: [] }), entries: async () => ({ entries: [] }) },
    },
  };
}

function createSdkModule({ executeResults = [] } = {}) {
  const executeCalls = [];
  let index = 0;
  class FakeW3SSdk {
    constructor(settings) { this.settings = settings; }
    async getDeviceId() { return 'behavior-device-id'; }
    setAuthentication(auth) { this.auth = auth; }
    execute(challengeId, onCompleted) {
      executeCalls.push(challengeId);
      const result = index < executeResults.length ? executeResults[index] : { status: 'COMPLETE' };
      index += 1;
      queueMicrotask(() => onCompleted(undefined, result));
    }
  }
  return { module: { W3SSdk: FakeW3SSdk }, executeCalls };
}

function loadWithMocks({ auth, backend, sdk, window }) {
  return loadCircleEntry({
    requireMap: {
      './backend-api': { backendApi: backend.module },
      './circle-auth': auth.module,
      '@circle-fin/w3s-pw-web-sdk': sdk.module,
    },
    window,
  });
}

// ---------------------------------------------------------------------------
// A. Session expiry during polling
// ---------------------------------------------------------------------------

async function testSessionExpiryDuringPolling() {
  const auth = createCircleAuthMock();
  const backend = createBackendApiMock({
    startResult: START_RESULT_ENTRY_READY,
    entrySteps: [
      () => ({ pending: false }), // ENTRY_CHALLENGE probe -> falls through to the hosted challenge
      ...Array.from({ length: 8 }, () => () => ({ pending: true, transactionObserved: true })),
      () => { throw new Error('session_expired'); }, // one poll attempt fails mid-flight
      () => ({ pending: true, transactionObserved: true }), // the single retry succeeds, still pending
      () => ({ pending: true, transactionObserved: true }),
      () => finalEntryResult(START_RESULT_ENTRY_READY),
    ],
  });
  const sdk = createSdkModule();
  const window = createFakeWindow();
  const circleEntry = loadWithMocks({ auth, backend, sdk, window });

  const result = await circleEntry.confirmCircleEntry(INPUT);

  assert.equal(backend.sessionCalls.length, 1, 'session must be refreshed exactly once for the one injected expiry');
  assert.equal(backend.startCalls.length, 1, 'no second financial intent may be created');
  assert.equal(sdk.executeCalls.length, 1, 'the hosted challenge must execute exactly once (no duplicate submission)');
  assert.equal(result.roundId, INPUT.roundId);
  assert.equal(result.predictionPriceCents, INPUT.predictionPriceCents);
  assert.equal(auth.cleared.length, 1, 'recovery must be cleared exactly once on success');
  assert.ok(window.delays.every((ms) => ms === CIRCLE_VERIFY_POLL_INTERVAL_MS), 'every poll must request the production poll interval');
  assert.ok(window.delays.length >= 8, 'the scenario must actually exercise multiple real poll iterations, not skip them');
}

// ---------------------------------------------------------------------------
// B. Session refresh retries only once
// ---------------------------------------------------------------------------

async function testSessionRefreshRetriesOnlyOnce() {
  const auth = createCircleAuthMock();
  const backend = createBackendApiMock({
    startResult: START_RESULT_ENTRY_READY,
    entrySteps: [
      () => ({ pending: false }), // probe -> hosted challenge
      () => { throw new Error('session_expired'); }, // first failure
      () => { throw new Error('session_expired'); }, // the one retry fails again
    ],
  });
  const sdk = createSdkModule();
  const window = createFakeWindow();
  const circleEntry = loadWithMocks({ auth, backend, sdk, window });

  await assert.rejects(() => circleEntry.confirmCircleEntry(INPUT), /session_expired/);

  assert.equal(backend.sessionCalls.length, 1, 'only one refresh attempt is allowed per failing call');
  assert.equal(backend.verifyEntry.calls.length, 3, 'probe + first failure + the single retry, and nothing more');
  assert.equal(backend.startCalls.length, 1, 'no second financial intent may be created after a bounded-retry failure');
  assert.equal(sdk.executeCalls.length, 1, 'the hosted challenge must not be re-executed after a verify failure');
  assert.equal(auth.cleared.length, 0, 'session_expired is not a terminal error and must not discard recovery');
}

// ---------------------------------------------------------------------------
// C. Independent verify rate limiters
// ---------------------------------------------------------------------------

function createCountingStore() {
  let count = 0;
  return {
    get count() { return count; },
    async increment() {
      count += 1;
      return { totalHits: count, resetTime: new Date(Date.now() + 60_000) };
    },
    async decrement() { count = Math.max(0, count - 1); },
    async resetKey() { count = 0; },
  };
}

function fakeExpressReq() {
  return { ip: '127.0.0.1', headers: {}, app: { get: () => false } };
}

function fakeExpressRes() {
  const headers = {};
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(key, value) { headers[key] = value; },
    getHeader(key) { return headers[key]; },
    append(key, value) { headers[key] = headers[key] ? `${headers[key]}, ${value}` : value; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; this.writableEnded = true; return this; },
    once() {},
  };
}

async function invokeLimiter(limiter) {
  const req = fakeExpressReq();
  const res = fakeExpressRes();
  let calledNext = false;
  await limiter(req, res, () => { calledNext = true; });
  return { calledNext, statusCode: res.statusCode };
}

async function testIndependentVerifyRateLimiters() {
  const actionsRouter = require('../src/routes/actions.js');
  const testables = actionsRouter.__circleVerifyLimitersForTests;
  assert.ok(testables, 'actions.js must expose its test-only limiter accessor');
  const { createCircleVerifyLimiter, entryApprovalVerifyLimiter, entryVerifyLimiter } = testables;

  // Structural: the two production instances must not be the same object,
  // and the route wiring must actually point at them (not some other pair).
  assert.notStrictEqual(
    entryApprovalVerifyLimiter,
    entryVerifyLimiter,
    'the production approval-verify and entry-verify limiters must be distinct instances',
  );
  const approvalRoute = actionsRouter.stack.find(
    (layer) => layer.route && layer.route.path === '/entry/approval/verify' && layer.route.methods.post,
  );
  const entryRoute = actionsRouter.stack.find(
    (layer) => layer.route && layer.route.path === '/entry/verify' && layer.route.methods.post,
  );
  assert.ok(approvalRoute && entryRoute, 'both verify routes must be registered');
  assert.strictEqual(approvalRoute.route.stack[0].handle, entryApprovalVerifyLimiter, 'approval route must be wired to the approval limiter');
  assert.strictEqual(entryRoute.route.stack[0].handle, entryVerifyLimiter, 'entry route must be wired to the entry limiter');

  // Behavioral: exhausting one limiter's quota must never touch the other's,
  // proven against real express-rate-limit instances with isolated stores
  // (avoids depending on wall-clock windows or IP-keyed timing).
  const storeA = createCountingStore();
  const storeB = createCountingStore();
  const limiterA = createCircleVerifyLimiter(storeA);
  const limiterB = createCircleVerifyLimiter(storeB);

  const outcomesA = [];
  for (let i = 0; i < 25; i += 1) outcomesA.push(await invokeLimiter(limiterA));
  assert.equal(storeB.count, 0, 'exhausting limiter A must never touch limiter B state');
  assert.equal(outcomesA.filter((o) => o.calledNext).length, 20, 'exactly 20 requests/minute may pass');
  assert.equal(outcomesA.filter((o) => !o.calledNext && o.statusCode === 429).length, 5);

  const outcomesB = [];
  for (let i = 0; i < 5; i += 1) outcomesB.push(await invokeLimiter(limiterB));
  assert.equal(storeA.count, 25, 'calling limiter B must never touch limiter A state');
  assert.ok(outcomesB.every((o) => o.calledNext), 'limiter B must start with a fresh, unshared quota');

  // Mathematical invariant: sustained polling plus its one preflight probe
  // must stay at/under the shared 20/minute ceiling.
  const pollsPerMinute = Math.ceil(60_000 / CIRCLE_VERIFY_POLL_INTERVAL_MS);
  assert.equal(pollsPerMinute, 15, 'polling request/minute arithmetic must match the production interval');
  assert.ok(pollsPerMinute + 1 <= 20, 'polling plus its one preflight probe must stay at/under the 20/minute limit');
}

// ---------------------------------------------------------------------------
// D. Hosted Circle challenge result handling
// ---------------------------------------------------------------------------

async function runHostedChallengeResultCase(status, { expectFailure }) {
  const auth = createCircleAuthMock();
  const backend = createBackendApiMock({
    startResult: START_RESULT_ENTRY_READY,
    entrySteps: expectFailure
      ? [() => ({ pending: false })]
      : [
        () => ({ pending: false }),
        () => ({ pending: true, transactionObserved: true }),
        () => finalEntryResult(START_RESULT_ENTRY_READY),
      ],
  });
  const sdk = createSdkModule({ executeResults: [{ status }] });
  const window = createFakeWindow();
  const circleEntry = loadWithMocks({ auth, backend, sdk, window });

  if (expectFailure) {
    await assert.rejects(
      () => circleEntry.confirmCircleEntry(INPUT),
      /circle_transaction_failed/,
      `status ${status} must surface as circle_transaction_failed`,
    );
    assert.equal(auth.cleared.length, 1, `a terminal ${status} hosted-challenge result must clear recovery`);
  } else {
    const result = await circleEntry.confirmCircleEntry(INPUT);
    assert.equal(result.roundId, INPUT.roundId);
    assert.equal(auth.cleared.length, 1, 'a normal successful completion must still clear recovery exactly once');
  }
  assert.equal(sdk.executeCalls.length, 1, 'the hosted challenge must execute exactly once per case');
}

async function testHostedChallengeResult() {
  await runHostedChallengeResultCase('FAILED', { expectFailure: true });
  await runHostedChallengeResultCase('EXPIRED', { expectFailure: true });
  await runHostedChallengeResultCase('COMPLETE', { expectFailure: false });
}

// ---------------------------------------------------------------------------
// E. Slow indexing state machine (60-120s virtual, approval then entry)
// ---------------------------------------------------------------------------

async function testSlowIndexingStateMachine() {
  const auth = createCircleAuthMock();
  const approvalTxHash = `0x${'a'.repeat(64)}`;
  const backend = createBackendApiMock({
    startResult: START_RESULT_APPROVAL_REQUIRED,
    approvalSteps: [
      () => ({ pending: false }), // APPROVAL_CHALLENGE probe -> hosted challenge #1
      ...Array.from({ length: 9 }, () => () => ({ pending: true, transactionObserved: true })),
      () => { throw new Error('session_expired'); }, // the one injected mid-poll expiry
      () => ({ pending: true, transactionObserved: true }), // the single retry, still pending
      ...Array.from({ length: 8 }, () => () => ({ pending: true, transactionObserved: true })),
      () => ({
        actionId: START_RESULT_APPROVAL_REQUIRED.actionId,
        payloadHash: START_RESULT_APPROVAL_REQUIRED.payloadHash,
        challengeId: 'behavior-entry-challenge-slow',
        approvalTxHash,
      }),
    ],
    entrySteps: [
      () => ({ pending: false }), // ENTRY_CHALLENGE probe -> hosted challenge #2
      ...Array.from({ length: 14 }, () => () => ({ pending: true, transactionObserved: true })),
      () => finalEntryResult(START_RESULT_APPROVAL_REQUIRED, { approvalTxHash }),
    ],
  });
  const sdk = createSdkModule();
  const window = createFakeWindow();
  const circleEntry = loadWithMocks({ auth, backend, sdk, window });

  const realStartMs = Date.now();
  const result = await circleEntry.confirmCircleEntry(INPUT);
  const realElapsedMs = Date.now() - realStartMs;
  const nominalVirtualMs = window.delays.reduce((sum, ms) => sum + ms, 0);

  // This scenario never touches a real HTTP layer or a real rate limiter, so
  // "no 429" holds here by construction; the actual 429-avoidance proof is
  // the arithmetic + independent-limiter assertions in test C above.
  assert.ok(nominalVirtualMs >= 60_000, `nominal virtual polling duration must span at least 60s, got ${nominalVirtualMs}ms`);
  assert.ok(realElapsedMs < 5_000, `the test itself must never really wait; took ${realElapsedMs}ms`);
  assert.equal(backend.sessionCalls.length, 1, 'exactly one session expiry was injected and must trigger exactly one refresh');
  assert.equal(backend.startCalls.length, 1, 'requestId/actionId must stay attached to the single original financial intent');
  assert.equal(backend.startCalls[0].circleRequestId, INPUT.requestId, 'requestId must reach the backend unchanged');
  assert.equal(sdk.executeCalls.length, 2, 'exactly one hosted challenge per phase: approval, then entry -- never a duplicate submission');
  assert.equal(result.roundId, INPUT.roundId);
  assert.equal(result.predictionPriceCents, INPUT.predictionPriceCents);
  assert.equal(auth.cleared.length, 1);

  for (const call of [...backend.verifyApproval.calls, ...backend.verifyEntry.calls]) {
    assert.equal(call[0], START_RESULT_APPROVAL_REQUIRED.actionId, 'every verify call must use the same actionId throughout');
  }
}

async function main() {
  await testSessionExpiryDuringPolling();
  await testSessionRefreshRetriesOnlyOnce();
  await testIndependentVerifyRateLimiters();
  await testHostedChallengeResult();
  await testSlowIndexingStateMachine();
  console.log('CIRCLE_ENTRY_BEHAVIOR=PASS');
}

main().catch((error) => {
  console.error('CIRCLE_ENTRY_BEHAVIOR=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
