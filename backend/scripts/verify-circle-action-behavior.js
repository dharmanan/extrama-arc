'use strict';

// Behavioral coverage for the generic Circle action runner,
// confirmCircleAction() in app/lib/circle-actions.ts, which drives transfer,
// refund, claim and the four marketplace actions for Circle user controlled
// wallets.
//
// The real TypeScript module is transpiled and executed with faked backend,
// recovery storage, and hosted Circle SDK. Nothing here calls Circle, sends
// an Arc transaction, or waits real time: every poll delay fires immediately
// and is recorded.

process.env.NODE_ENV = 'test';
process.env.NEXT_PUBLIC_CIRCLE_APP_ID ||= 'behavior_test_circle_app_id';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SOURCE_PATH = path.resolve(__dirname, '../../app/lib/circle-actions.ts');
const POLL_INTERVAL_MS = 4000;
const MAX_ATTEMPTS = 45;
const DESTINATION = '0x3000000000000000000000000000000000000003';

function transpile() {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: 'circle-actions.ts',
  }).outputText;
}

const CODE = transpile();

function load({ auth, backend, sdk, window }) {
  const moduleObject = { exports: {} };
  const requireMap = {
    './backend-api': { backendApi: backend.module },
    './circle-auth': auth.module,
    '@circle-fin/w3s-pw-web-sdk': sdk.module,
  };
  function fakeRequire(id) {
    if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
    throw new Error(`circle action behavior harness: unmocked require("${id}")`);
  }
  new Function('module', 'exports', 'require', 'window', CODE)(
    moduleObject, moduleObject.exports, fakeRequire, window,
  );
  return moduleObject.exports;
}

function createWindow() {
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      return setImmediate(fn);
    },
  };
}

function sequence(name, steps) {
  let index = 0;
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    if (index >= steps.length) throw new Error(`${name}: sequence exhausted after ${calls.length} calls`);
    const step = steps[index];
    index += 1;
    return step(...args);
  };
  fn.calls = calls;
  return fn;
}

// Per tab recovery storage, in memory. history records every stored record
// so the exact phase progression can be asserted.
function createAuth({ initialRecovery = null, signedIn = true } = {}) {
  let recovery = initialRecovery;
  const history = [];
  let clears = 0;
  return {
    history,
    get recovery() { return recovery; },
    get clears() { return clears; },
    module: {
      readCircleTabAuth: () => (signedIn ? { userToken: 'behavior_user_token', encryptionKey: 'behavior_encryption_key' } : null),
      readCircleEntryRecovery: () => null,
      matchesCircleEntryRecovery: () => false,
      storeCircleEntryRecovery: () => { throw new Error('entry recovery must not be touched'); },
      clearCircleEntryRecovery: () => { throw new Error('entry recovery must not be touched'); },
      readCircleActionRecovery: () => recovery,
      storeCircleActionRecovery: (next) => { recovery = { ...next }; history.push({ ...next }); },
      clearCircleActionRecovery: () => { recovery = null; clears += 1; },
    },
  };
}

function createBackend({ approvalSteps = [], actionSteps = [], sessionSucceeds = true } = {}) {
  const sessionCalls = [];
  const verifyApproval = sequence('verifyCircleActionApproval', approvalSteps);
  const verifyAction = sequence('verifyCircleAction', actionSteps);
  return {
    sessionCalls,
    verifyApproval,
    verifyAction,
    module: {
      circle: {
        session: async (userToken) => {
          sessionCalls.push(userToken);
          if (!sessionSucceeds) throw new Error('circle_session_refresh_failed');
          return { refreshed: true };
        },
      },
      actions: {
        verifyCircleActionApproval: (...args) => verifyApproval(...args),
        verifyCircleAction: (...args) => verifyAction(...args),
      },
    },
  };
}

function createSdk(results = []) {
  const executeCalls = [];
  let index = 0;
  class FakeW3SSdk {
    async getDeviceId() { return 'behavior_device_id'; }
    setAuthentication(auth) { this.auth = auth; }
    execute(challengeId, onCompleted) {
      executeCalls.push(challengeId);
      const result = index < results.length ? results[index] : { status: 'COMPLETE' };
      index += 1;
      queueMicrotask(() => onCompleted(undefined, result));
    }
  }
  return { executeCalls, module: { W3SSdk: FakeW3SSdk } };
}

const TRANSFER_PAYLOAD = {
  action: 'TRANSFER_TICKET',
  chainId: 5042002,
  executionMode: 'CIRCLE_USER_WALLET',
  tokenId: '7',
  destination: DESTINATION,
};

const BUY_PAYLOAD = {
  action: 'MARKETPLACE_BUY',
  chainId: 5042002,
  executionMode: 'CIRCLE_USER_WALLET',
  listingId: '12',
  expectedAskUsdcRaw: '4500000',
};

function started(step, overrides = {}) {
  return {
    actionId: 'behavior_action_1',
    payloadHash: 'behavior_payload_hash_1',
    expiresInSeconds: 1800,
    executionMode: 'CIRCLE_USER_WALLET',
    step,
    challengeId: step === 'APPROVAL_REQUIRED' ? 'approval_challenge_1' : 'action_challenge_1',
    ...overrides,
  };
}

function confirmed(result, overrides = {}) {
  return {
    confirmed: true,
    actionId: 'behavior_action_1',
    payloadHash: 'behavior_payload_hash_1',
    executionMode: 'CIRCLE_USER_WALLET',
    result,
    ...overrides,
  };
}

const PENDING = () => ({ pending: true, transactionObserved: false });
const OBSERVED = () => ({ pending: true, transactionObserved: true });

function transferIntent(startImpl, calls) {
  return {
    actionType: 'TRANSFER_TICKET',
    intentKey: `TRANSFER_TICKET:7:${DESTINATION.toLowerCase()}`,
    start: async (credentials) => {
      calls.push(credentials);
      return startImpl(credentials);
    },
    matchesIntent: (payload) => payload.tokenId === '7' && payload.destination === DESTINATION,
  };
}

function buyIntent(startImpl, calls) {
  return {
    actionType: 'MARKETPLACE_BUY',
    intentKey: 'MARKETPLACE_BUY:12:4500000',
    start: async (credentials) => {
      calls.push(credentials);
      return startImpl(credentials);
    },
    matchesIntent: (payload) => payload.listingId === '12' && payload.expectedAskUsdcRaw === '4500000',
  };
}

// ---------------------------------------------------------------------------

async function testOnePhaseAction() {
  const auth = createAuth();
  const backend = createBackend({
    actionSteps: [PENDING, OBSERVED, OBSERVED, () => confirmed({ transferTxHash: '0xabc' })],
  });
  const sdk = createSdk();
  const window = createWindow();
  const runner = load({ auth, backend, sdk, window });
  const startCalls = [];
  const intent = transferIntent((credentials) => {
    // The request ID is durable before the start request leaves the tab.
    assert.equal(auth.recovery.phase, 'START_PENDING');
    assert.equal(auth.recovery.requestId, credentials.circleRequestId);
    assert.equal(credentials.circleUserToken, 'behavior_user_token');
    return { ...started('ACTION_READY'), action: TRANSFER_PAYLOAD };
  }, startCalls);

  const result = await runner.confirmCircleAction(intent);

  assert.deepEqual(result, { transferTxHash: '0xabc' });
  assert.equal(startCalls.length, 1);
  assert.deepEqual(sdk.executeCalls, ['action_challenge_1'], 'exactly one hosted challenge');
  assert.deepEqual(auth.history.map((record) => record.phase), ['START_PENDING', 'ACTION_CHALLENGE', 'ACTION_PENDING']);
  assert.equal(auth.recovery, null, 'recovery cleared after verification');
  assert.equal(backend.verifyApproval.calls.length, 0, 'a one phase action never verifies an approval');
  assert.deepEqual(backend.verifyAction.calls[0], ['TRANSFER_TICKET', 'behavior_action_1', 'behavior_user_token']);
  assert.ok(window.delays.length >= 2 && window.delays.every((ms) => ms === POLL_INTERVAL_MS));
}

async function testTwoPhaseAction() {
  const auth = createAuth();
  const backend = createBackend({
    approvalSteps: [
      PENDING,
      OBSERVED,
      () => ({
        confirmed: true,
        actionId: 'behavior_action_1',
        payloadHash: 'behavior_payload_hash_1',
        executionMode: 'CIRCLE_USER_WALLET',
        approvalTxHash: '0xapproval',
        step: 'ACTION_READY',
        challengeId: 'action_challenge_2',
      }),
    ],
    actionSteps: [PENDING, OBSERVED, () => confirmed({ buyTxHash: '0xbuy' })],
  });
  const sdk = createSdk();
  const runner = load({ auth, backend, sdk, window: createWindow() });
  const startCalls = [];
  const result = await runner.confirmCircleAction(buyIntent(
    () => ({ ...started('APPROVAL_REQUIRED'), action: BUY_PAYLOAD }),
    startCalls,
  ));

  assert.deepEqual(result, { buyTxHash: '0xbuy' });
  assert.deepEqual(sdk.executeCalls, ['approval_challenge_1', 'action_challenge_2'], 'approval first, then the purchase');
  assert.deepEqual(auth.history.map((record) => record.phase), [
    'START_PENDING', 'APPROVAL_CHALLENGE', 'APPROVAL_PENDING', 'ACTION_CHALLENGE', 'ACTION_PENDING',
  ]);
  const actionChallengeRecord = auth.history.find((record) => record.phase === 'ACTION_CHALLENGE');
  assert.equal(actionChallengeRecord.approvalTxHash, '0xapproval');
  assert.equal(startCalls.length, 1);
  assert.equal(auth.recovery, null);
}

async function testSessionExpiryRefreshesOnce() {
  const auth = createAuth();
  const backend = createBackend({
    actionSteps: [
      PENDING,
      OBSERVED,
      () => { throw new Error('session_expired'); },
      OBSERVED,
      () => confirmed({ refundTxHash: '0xrefund' }),
    ],
  });
  const sdk = createSdk();
  const runner = load({ auth, backend, sdk, window: createWindow() });
  const startCalls = [];
  const result = await runner.confirmCircleAction(transferIntent(
    () => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }),
    startCalls,
  ));
  assert.deepEqual(result, { refundTxHash: '0xrefund' });
  assert.equal(backend.sessionCalls.length, 1, 'one session refresh for one expiry');
  assert.equal(sdk.executeCalls.length, 1, 'the hosted challenge is never executed twice');
  assert.equal(startCalls.length, 1, 'no second financial intent');

  const failing = createAuth();
  const failingBackend = createBackend({
    actionSteps: [
      PENDING,
      () => { throw new Error('session_expired'); },
      () => { throw new Error('session_expired'); },
    ],
  });
  const failingRunner = load({ auth: failing, backend: failingBackend, sdk: createSdk(), window: createWindow() });
  await assert.rejects(
    () => failingRunner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), [])),
    /session_expired/,
  );
  assert.equal(failingBackend.sessionCalls.length, 1, 'the refresh is retried only once');
  assert.equal(failing.recovery.phase, 'ACTION_PENDING', 'a session error keeps recovery for a later resume');
}

async function testStartRetryReusesRequestId() {
  const auth = createAuth();
  const backend = createBackend({ actionSteps: [PENDING, () => confirmed({ ok: true })] });
  const sdk = createSdk();
  const startCalls = [];
  let attempt = 0;
  const intentFor = () => transferIntent(() => {
    attempt += 1;
    if (attempt === 1) throw new Error('circle_service_unavailable');
    if (attempt === 2) throw new Error('Failed to fetch');
    return { ...started('ACTION_READY'), action: TRANSFER_PAYLOAD };
  }, startCalls);

  const runner = load({ auth, backend, sdk, window: createWindow() });
  await assert.rejects(() => runner.confirmCircleAction(intentFor()), /circle_service_unavailable/);
  assert.equal(auth.recovery.phase, 'START_PENDING', 'a retryable start failure keeps the request ID');
  const firstRequestId = auth.recovery.requestId;
  await assert.rejects(() => runner.confirmCircleAction(intentFor()), /Failed to fetch/);
  assert.equal(auth.recovery.requestId, firstRequestId, 'a transport failure keeps the same request ID');
  await runner.confirmCircleAction(intentFor());
  assert.equal(startCalls.length, 3);
  assert.ok(startCalls.every((call) => call.circleRequestId === firstRequestId), 'every retry reuses one request ID');
  assert.equal(sdk.executeCalls.length, 1);

  const refused = createAuth();
  const refusedRunner = load({ auth: refused, backend: createBackend(), sdk: createSdk(), window: createWindow() });
  await assert.rejects(
    () => refusedRunner.confirmCircleAction(transferIntent(() => { throw new Error('transfer_not_ticket_owner'); }, [])),
    /transfer_not_ticket_owner/,
  );
  assert.equal(refused.recovery, null, 'a definitive refusal before any challenge clears recovery');
}

async function testResumeNeverRepeatsChallenge() {
  const recovery = {
    actionType: 'TRANSFER_TICKET',
    intentKey: `TRANSFER_TICKET:7:${DESTINATION.toLowerCase()}`,
    requestId: 'request_1',
    actionId: 'behavior_action_1',
    payloadHash: 'behavior_payload_hash_1',
    phase: 'ACTION_CHALLENGE',
    challengeId: 'action_challenge_1',
    approvalTxHash: null,
    expiresAtMs: Date.now() + 60_000,
  };
  const auth = createAuth({ initialRecovery: recovery });
  const backend = createBackend({ actionSteps: [OBSERVED, OBSERVED, () => confirmed({ resumed: true })] });
  const sdk = createSdk();
  const runner = load({ auth, backend, sdk, window: createWindow() });
  const startCalls = [];
  const result = await runner.confirmCircleAction(transferIntent(() => {
    throw new Error('start must not run while an action is recoverable');
  }, startCalls));
  assert.deepEqual(result, { resumed: true });
  assert.equal(startCalls.length, 0, 'a reload resumes the saved action, never a new one');
  assert.equal(sdk.executeCalls.length, 0, 'an already observed transaction is never approved again');
  assert.equal(auth.recovery, null);
}

async function testDifferentIntentIsBlocked() {
  const foreign = {
    actionType: 'MARKETPLACE_BUY',
    intentKey: 'MARKETPLACE_BUY:12:4500000',
    requestId: 'request_foreign',
    actionId: 'foreign_action',
    payloadHash: 'foreign_hash',
    phase: 'ACTION_PENDING',
    challengeId: null,
    approvalTxHash: '0xapproval',
    expiresAtMs: Date.now() + 60_000,
  };
  const auth = createAuth({ initialRecovery: foreign });
  const backend = createBackend({ actionSteps: [OBSERVED] });
  const runner = load({ auth, backend, sdk: createSdk(), window: createWindow() });
  const startCalls = [];
  await assert.rejects(
    () => runner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), startCalls)),
    /circle_pending_action_for_different_intent/,
  );
  assert.equal(startCalls.length, 0);
  assert.equal(auth.recovery.actionId, 'foreign_action', 'an in flight foreign action is never discarded');

  // A foreign record whose start never returned can hold no challenge.
  const stale = createAuth({ initialRecovery: { ...foreign, phase: 'START_PENDING', actionId: null, payloadHash: null } });
  const staleBackend = createBackend({ actionSteps: [PENDING, () => confirmed({ ok: true })] });
  const staleRunner = load({ auth: stale, backend: staleBackend, sdk: createSdk(), window: createWindow() });
  const staleStarts = [];
  await staleRunner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), staleStarts));
  assert.equal(staleStarts.length, 1);
  assert.notEqual(staleStarts[0].circleRequestId, 'request_foreign', 'a new intent never reuses a foreign request ID');
}

async function testExpiryReconcilesObservedTransaction() {
  const base = {
    actionType: 'TRANSFER_TICKET',
    intentKey: `TRANSFER_TICKET:7:${DESTINATION.toLowerCase()}`,
    requestId: 'request_1',
    actionId: 'behavior_action_1',
    payloadHash: 'behavior_payload_hash_1',
    phase: 'ACTION_PENDING',
    challengeId: null,
    approvalTxHash: null,
    expiresAtMs: Date.now() - 1000,
  };
  const observed = createAuth({ initialRecovery: base });
  const observedRunner = load({
    auth: observed,
    backend: createBackend({ actionSteps: [OBSERVED, OBSERVED, () => confirmed({ late: true })] }),
    sdk: createSdk(),
    window: createWindow(),
  });
  assert.deepEqual(await observedRunner.confirmCircleAction(transferIntent(() => {
    throw new Error('must not start');
  }, [])), { late: true }, 'a transaction Circle already sees is reconciled after local expiry');

  const unobserved = createAuth({ initialRecovery: base });
  const unobservedRunner = load({
    auth: unobserved, backend: createBackend({ actionSteps: [PENDING] }), sdk: createSdk(), window: createWindow(),
  });
  await assert.rejects(
    () => unobservedRunner.confirmCircleAction(transferIntent(() => { throw new Error('must not start'); }, [])),
    /circle_action_recovery_expired/,
  );
  assert.equal(unobserved.recovery, null);
}

async function testTerminalErrorsClearRecovery() {
  const auth = createAuth();
  const backend = createBackend({ actionSteps: [PENDING, () => { throw new Error('circle_transaction_failed'); }] });
  const runner = load({ auth, backend, sdk: createSdk(), window: createWindow() });
  await assert.rejects(
    () => runner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), [])),
    /circle_transaction_failed/,
  );
  assert.equal(auth.recovery, null, 'a failed Circle transaction clears recovery');

  const rejected = createAuth();
  const rejectedSdk = createSdk([{ status: 'FAILED' }]);
  const rejectedRunner = load({
    auth: rejected, backend: createBackend({ actionSteps: [PENDING] }), sdk: rejectedSdk, window: createWindow(),
  });
  await assert.rejects(
    () => rejectedRunner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), [])),
    /circle_transaction_failed/,
  );
  assert.equal(rejected.recovery, null, 'a rejected hosted challenge clears recovery');

  const transient = createAuth();
  const transientRunner = load({
    auth: transient,
    backend: createBackend({ actionSteps: [PENDING, () => { throw new Error('circle_service_unavailable'); }] }),
    sdk: createSdk(),
    window: createWindow(),
  });
  await assert.rejects(
    () => transientRunner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), [])),
    /circle_service_unavailable/,
  );
  assert.equal(transient.recovery.phase, 'ACTION_PENDING', 'a transient error keeps recovery');

  const expired = createAuth();
  const expiredRunner = load({
    auth: expired,
    backend: createBackend({ approvalSteps: [PENDING, () => { throw new Error('circle_action_expired_after_approval'); }] }),
    sdk: createSdk(),
    window: createWindow(),
  });
  await assert.rejects(
    () => expiredRunner.confirmCircleAction(buyIntent(() => ({ ...started('APPROVAL_REQUIRED'), action: BUY_PAYLOAD }), [])),
    /circle_action_expired_after_approval/,
  );
  assert.equal(expired.recovery, null);
}

async function testServerBindingIsChecked() {
  const mismatched = createAuth();
  const sdk = createSdk();
  const runner = load({ auth: mismatched, backend: createBackend(), sdk, window: createWindow() });
  await assert.rejects(
    () => runner.confirmCircleAction(transferIntent(
      () => ({ ...started('ACTION_READY'), action: { ...TRANSFER_PAYLOAD, destination: '0x4000000000000000000000000000000000000004' } }),
      [],
    )),
    /circle_action_verification_failed/,
  );
  assert.equal(sdk.executeCalls.length, 0, 'a mismatched server payload is never shown as a challenge');
  assert.equal(mismatched.recovery, null);

  const wrongStep = createAuth();
  const wrongSdk = createSdk();
  const wrongRunner = load({ auth: wrongStep, backend: createBackend(), sdk: wrongSdk, window: createWindow() });
  await assert.rejects(
    () => wrongRunner.confirmCircleAction(transferIntent(
      () => ({ ...started('APPROVAL_REQUIRED'), action: TRANSFER_PAYLOAD }),
      [],
    )),
    /circle_action_verification_failed/,
    'a one phase action can never be sent an approval challenge',
  );
  assert.equal(wrongSdk.executeCalls.length, 0);

  const wrongResult = createAuth();
  const wrongResultRunner = load({
    auth: wrongResult,
    backend: createBackend({ actionSteps: [PENDING, () => confirmed({ ok: true }, { actionId: 'another_action' })] }),
    sdk: createSdk(),
    window: createWindow(),
  });
  await assert.rejects(
    () => wrongResultRunner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), [])),
    /circle_action_verification_failed/,
  );

  const wrongApproval = createAuth();
  const wrongApprovalSdk = createSdk();
  const wrongApprovalRunner = load({
    auth: wrongApproval,
    backend: createBackend({
      approvalSteps: [PENDING, () => ({
        confirmed: true,
        actionId: 'behavior_action_1',
        payloadHash: 'another_hash',
        executionMode: 'CIRCLE_USER_WALLET',
        approvalTxHash: '0xapproval',
        step: 'ACTION_READY',
        challengeId: 'action_challenge_2',
      })],
    }),
    sdk: wrongApprovalSdk,
    window: createWindow(),
  });
  await assert.rejects(
    () => wrongApprovalRunner.confirmCircleAction(buyIntent(() => ({ ...started('APPROVAL_REQUIRED'), action: BUY_PAYLOAD }), [])),
    /circle_action_verification_failed/,
  );
  assert.deepEqual(wrongApprovalSdk.executeCalls, ['approval_challenge_1'], 'no purchase challenge after a mismatched approval');
}

async function testPollingIsBounded() {
  const auth = createAuth();
  const window = createWindow();
  const runner = load({
    auth,
    backend: createBackend({ actionSteps: [PENDING, ...Array.from({ length: MAX_ATTEMPTS }, () => OBSERVED)] }),
    sdk: createSdk(),
    window,
  });
  await assert.rejects(
    () => runner.confirmCircleAction(transferIntent(() => ({ ...started('ACTION_READY'), action: TRANSFER_PAYLOAD }), [])),
    /circle_transaction_pending/,
  );
  assert.equal(window.delays.length, MAX_ATTEMPTS);
  assert.equal(auth.recovery.phase, 'ACTION_PENDING', 'a still pending action stays recoverable');
}

async function testSignedOutTabIsRefused() {
  const auth = createAuth({ signedIn: false });
  const runner = load({ auth, backend: createBackend(), sdk: createSdk(), window: createWindow() });
  const startCalls = [];
  await assert.rejects(
    () => runner.confirmCircleAction(transferIntent(() => ({}), startCalls)),
    /circle_reauthentication_required/,
  );
  assert.equal(startCalls.length, 0);
}

const SCENARIOS = [
  ['one phase action', testOnePhaseAction],
  ['two phase action', testTwoPhaseAction],
  ['session expiry refreshes once', testSessionExpiryRefreshesOnce],
  ['start retry reuses the request ID', testStartRetryReusesRequestId],
  ['resume never repeats a challenge', testResumeNeverRepeatsChallenge],
  ['different intent is blocked', testDifferentIntentIsBlocked],
  ['expiry reconciles an observed transaction', testExpiryReconcilesObservedTransaction],
  ['terminal errors clear recovery', testTerminalErrorsClearRecovery],
  ['server binding is checked', testServerBindingIsChecked],
  ['polling is bounded', testPollingIsBounded],
  ['signed out tab is refused', testSignedOutTabIsRefused],
];

(async () => {
  for (const [name, run] of SCENARIOS) {
    await run();
    console.log(`CIRCLE_ACTION_BEHAVIOR ${name}: PASS`);
  }
  console.log('CIRCLE_ACTION_BEHAVIOR=PASS');
})().catch((error) => {
  console.error('CIRCLE_ACTION_BEHAVIOR=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
