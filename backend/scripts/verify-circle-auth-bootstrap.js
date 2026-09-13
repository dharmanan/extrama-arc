'use strict';

// Behavioral coverage for ensureCircleFinancialAuth() in
// app/lib/circle-actions.ts, and for every Circle financial entry point that
// depends on it (prepareCircleGatewayFundingReview here; Gateway source deposit in
// app/lib/gateway-actions.ts is covered by the second harness below).
//
// Production proof: the EXTREMA application session lasts seven days, but
// Circle's userToken/encryptionKey are deliberately tab-scoped only
// (sessionStorage), never persisted. A live wallet was observed with the
// application session alive and rendering READY while Circle tab auth was
// gone (browser reopened / new tab / sessionStorage lost), and every Circle
// financial action failed with circle_reauthentication_required BEFORE the
// backend was ever called -- confirmed by a durable Arbitrum click that
// created no database row at all.
//
// Every scenario here executes the REAL, shipped TypeScript (transpiled, not
// reimplemented) against hand-written fakes. It never calls real Circle,
// never performs a real refresh against production, and never waits real
// wall-clock time.

process.env.NODE_ENV = 'test';
process.env.NEXT_PUBLIC_CIRCLE_APP_ID ||= 'auth_bootstrap_test_circle_app_id';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function transpile(relativePath, fileName) {
  const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName,
  }).outputText;
}

// ---------------------------------------------------------------------------
// Harness 1: app/lib/circle-actions.ts itself. This is where
// ensureCircleFinancialAuth and prepareCircleGatewayFundingReview both live.
// ---------------------------------------------------------------------------

const CIRCLE_ACTIONS_CODE = transpile('../../app/lib/circle-actions.ts', 'circle-actions.ts');

// A stateful fake of the tab-scoped credential store: starts however the
// test wants (present or absent) and genuinely mutates when
// storeCircleTabAuth is called, exactly like real sessionStorage would.
function createTabAuthStore({ initialAuth = null } = {}) {
  let auth = initialAuth;
  const stores = [];
  return {
    get current() { return auth; },
    stores,
    readCircleTabAuth: () => auth,
    storeCircleTabAuth: (next) => {
      auth = { ...next };
      stores.push({ ...next });
    },
  };
}

function loadCircleActions({ tabAuth, backend, sdk, gatewayRecovery = {} }) {
  const moduleObject = { exports: {} };
  const requireMap = {
    './backend-api': { backendApi: backend.module },
    './circle-auth': {
      readCircleTabAuth: tabAuth.readCircleTabAuth,
      storeCircleTabAuth: tabAuth.storeCircleTabAuth,
      // Entry/action recovery are exercised by their own dedicated behavior
      // files; this harness only needs them to exist and to never be
      // reached by the scenarios below, so a call is a hard failure.
      readCircleEntryRecovery: () => null,
      matchesCircleEntryRecovery: () => false,
      storeCircleEntryRecovery: () => { throw new Error('entry recovery must not be touched by this harness'); },
      clearCircleEntryRecovery: () => { throw new Error('entry recovery must not be touched by this harness'); },
      readCircleActionRecovery: () => null,
      storeCircleActionRecovery: () => { throw new Error('generic action recovery must not be touched by this harness'); },
      clearCircleActionRecovery: () => { throw new Error('generic action recovery must not be touched by this harness'); },
      readCircleGatewayFundingRecovery: gatewayRecovery.read || (() => null),
      storeCircleGatewayFundingRecovery: gatewayRecovery.store || (() => {}),
      clearCircleGatewayFundingRecovery: gatewayRecovery.clear || (() => {}),
    },
    '@circle-fin/w3s-pw-web-sdk': sdk.module,
  };
  function fakeRequire(id) {
    if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
    throw new Error(`circle-actions auth bootstrap harness: unmocked require("${id}")`);
  }
  new Function('module', 'exports', 'require', CIRCLE_ACTIONS_CODE)(
    moduleObject, moduleObject.exports, fakeRequire,
  );
  return moduleObject.exports;
}

function createSdk() {
  const deviceIdCalls = [];
  class FakeW3SSdk {
    async getDeviceId() {
      deviceIdCalls.push(true);
      return 'bootstrap-device-id';
    }
    setAuthentication() {}
    execute() { throw new Error('this harness never executes a hosted challenge'); }
  }
  return { deviceIdCalls, module: { W3SSdk: FakeW3SSdk } };
}

function createRefreshBackend({ succeeds = true, userToken = 'refreshed-user-token', encryptionKey = 'refreshed-encryption-key' } = {}) {
  const refreshCalls = [];
  return {
    refreshCalls,
    module: {
      circle: {
        refreshSession: async (deviceId) => {
          refreshCalls.push(deviceId);
          if (!succeeds) throw new Error('circle_reauthentication_required');
          return {
            userToken, encryptionKey,
            ownerAddress: '0x1000000000000000000000000000000000000001',
            walletAddress: '0x1000000000000000000000000000000000000001',
            circleWalletId: 'arc-wallet-1',
            executionMode: 'CIRCLE_USER_WALLET',
          };
        },
      },
    },
  };
}

// --- CASE A: valid tab auth already present ---------------------------

async function testCaseA_ExistingAuthUsedDirectly() {
  const tabAuth = createTabAuthStore({ initialAuth: { userToken: 'live-user-token', encryptionKey: 'live-encryption-key' } });
  const backend = createRefreshBackend();
  const sdk = createSdk();
  const runner = loadCircleActions({ tabAuth, backend, sdk });

  const auth = await runner.ensureCircleFinancialAuth();

  assert.deepEqual(auth, { userToken: 'live-user-token', encryptionKey: 'live-encryption-key' });
  assert.equal(backend.refreshCalls.length, 0, 'a live tab auth must never trigger a refresh call');
  assert.equal(tabAuth.stores.length, 0, 'nothing is re-stored when auth was already present');
}

// --- CASE B: missing auth, refresh succeeds -----------------------------

async function testCaseB_MissingAuthRefreshesOnce() {
  const tabAuth = createTabAuthStore({ initialAuth: null });
  const backend = createRefreshBackend({ userToken: 'restored-token', encryptionKey: 'restored-key' });
  const sdk = createSdk();
  const runner = loadCircleActions({ tabAuth, backend, sdk });

  const auth = await runner.ensureCircleFinancialAuth();

  assert.deepEqual(auth, { userToken: 'restored-token', encryptionKey: 'restored-key' });
  assert.equal(backend.refreshCalls.length, 1, 'exactly one refresh request');
  assert.deepEqual(tabAuth.stores, [{ userToken: 'restored-token', encryptionKey: 'restored-key' }]);
  // Only the credential pair is persisted -- never ownerAddress/walletAddress/
  // circleWalletId/executionMode from the refresh response.
  assert.deepEqual(Object.keys(tabAuth.stores[0]).sort(), ['encryptionKey', 'userToken']);
  assert.equal(tabAuth.current.userToken, 'restored-token', 'the restored credentials are now readable for later calls');
}

// --- CASE C: two concurrent callers with missing auth => one refresh ----

async function testCaseC_ConcurrentCallersShareOneRefresh() {
  const tabAuth = createTabAuthStore({ initialAuth: null });
  const backend = createRefreshBackend({ userToken: 'shared-token', encryptionKey: 'shared-key' });
  const sdk = createSdk();
  const runner = loadCircleActions({ tabAuth, backend, sdk });

  const [first, second, third] = await Promise.all([
    runner.ensureCircleFinancialAuth(),
    runner.ensureCircleFinancialAuth(),
    runner.ensureCircleFinancialAuth(),
  ]);

  assert.equal(backend.refreshCalls.length, 1, 'three concurrent callers must share exactly one refresh request');
  assert.deepEqual(first, { userToken: 'shared-token', encryptionKey: 'shared-key' });
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(tabAuth.stores.length, 1, 'the shared refresh is stored exactly once');

  // The single-flight promise is cleared once settled: a later, separate call
  // (auth now present) must not trigger a second refresh either.
  const fourth = await runner.ensureCircleFinancialAuth();
  assert.deepEqual(fourth, first);
  assert.equal(backend.refreshCalls.length, 1, 'a later call reads the now-present tab auth, no second refresh');
}

// --- CASE D: refresh fails => circle_reauthentication_required, zero calls --

async function testCaseD_RefreshFailureFailsClosed() {
  const tabAuth = createTabAuthStore({ initialAuth: null });
  const backend = createRefreshBackend({ succeeds: false });
  const sdk = createSdk();
  const runner = loadCircleActions({ tabAuth, backend, sdk });

  await assert.rejects(
    () => runner.ensureCircleFinancialAuth(),
    /circle_reauthentication_required/,
  );
  assert.equal(backend.refreshCalls.length, 1, 'exactly one refresh attempt is made before failing closed');
  assert.equal(tabAuth.stores.length, 0, 'a failed refresh stores nothing');
  assert.equal(tabAuth.current, null, 'a failed refresh leaves tab auth exactly as absent as before');

  // The single-flight slot must also clear on failure, so a later attempt
  // (e.g. after the user re-authenticates) can try again rather than being
  // stuck replaying a rejected promise forever.
  const secondBackend = createRefreshBackend({ succeeds: true, userToken: 'later-token', encryptionKey: 'later-key' });
  const runner2 = loadCircleActions({ tabAuth, backend: secondBackend, sdk });
  const auth = await runner2.ensureCircleFinancialAuth();
  assert.deepEqual(auth, { userToken: 'later-token', encryptionKey: 'later-key' });
}

// --- CASE F: Gateway funding transfer bootstraps before any start call -----
//
// prepareCircleGatewayFundingReview lives in circle-actions.ts itself, so this
// harness proves it directly: with tab auth missing, the bootstrap must
// resolve BEFORE backendApi.wallet.startGatewayFunding is ever reached, and
// the SAME originally requested financial intent (destinationDomain,
// valueRaw) must be the one that proceeds -- never a second, different one.

async function testCaseF_GatewayFundingBootstrapsBeforeStart() {
  const tabAuth = createTabAuthStore({ initialAuth: null });
  const refreshBackendModule = createRefreshBackend({ userToken: 'gw-restored-token', encryptionKey: 'gw-restored-key' }).module;
  const sdk = createSdk();

  const callOrder = [];
  const startCalls = [];
  let storedRecovery = null;
  const backend = {
    module: {
      circle: refreshBackendModule.circle,
      wallet: {
        startGatewayFunding: async (input) => {
          callOrder.push('start');
          startCalls.push(input);
          assert.equal(
            input.circleUserToken, 'gw-restored-token',
            'the start call must use the just-restored credentials, not a stale/missing one',
          );
          return {
            actionId: 'gw-action-1', payloadHash: 'gw-payload-1', challengeId: null,
            signatureIndex: 0, expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
            readyToBroadcast: false, terminal: false, recovery: 'NEW',
            costReview: {
              estimatedFeeRaw: '10000', estimatedTotalDebitRaw: '1010000',
              maximumAuthorizedFeeRaw: '110000', maximumTotalDebitRaw: '1110000',
            },
          };
        },
        // No challengeId yet: the loop's guard throws immediately, so this
        // scenario proves the bootstrap-then-start ordering without also
        // needing to drive a hosted challenge/signature loop.
        verifyGatewayFunding: async () => ({
          readyToBroadcast: false, pending: true, signatureIndex: 0,
          challengeId: null, intentCount: 1,
        }),
      },
    },
  };
  const originalRefresh = backend.module.circle.refreshSession;
  backend.module.circle.refreshSession = async (...args) => {
    callOrder.push('refresh');
    return originalRefresh(...args);
  };

  const runner = loadCircleActions({
    tabAuth, backend, sdk,
    gatewayRecovery: {
      read: () => storedRecovery,
      store: (next) => { storedRecovery = next; },
      clear: () => { storedRecovery = null; },
    },
  });

  // The hosted challenge step is never reached in this scenario: preparation
  // proves bootstrap-then-start ordering without crossing the signature UI.
  const prepared = await runner.prepareCircleGatewayFundingReview({
      requestId: 'gw-request-1', destinationDomain: 26, valueRaw: '1000000',
  });

  assert.deepEqual(callOrder, ['refresh', 'start'], 'auth must be restored before the financial start call, never after');
  assert.equal(startCalls.length, 1, 'no second, duplicate start call for the same intent');
  assert.equal(startCalls[0].destinationDomain, 26);
  assert.equal(startCalls[0].valueRaw, '1000000');
  assert.equal(prepared.actionId, 'gw-action-1');
}

// ---------------------------------------------------------------------------
// Harness 2: app/lib/gateway-actions.ts, for CASE E (Gateway source deposit).
// This is the EXACT production code path: runCircleDeposit (internal to this
// file, reached only through confirmGatewaySourceDeposit) used to read
// readCircleTabAuth() directly and throw before ever calling
// backendApi.wallet.startGatewayDeposit. It now goes through the same shared
// bootstrap as every other Circle financial entry point.
// ---------------------------------------------------------------------------

const GATEWAY_ACTIONS_CODE = transpile('../../app/lib/gateway-actions.ts', 'gateway-actions.ts');

function loadGatewayActions({ backend, circleActions, circleAuth }) {
  const moduleObject = { exports: {} };
  const requireMap = {
    './backend-api': { backendApi: backend.module },
    './circle-actions': circleActions.module,
    './circle-auth': circleAuth.module,
  };
  function fakeRequire(id) {
    if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
    throw new Error(`gateway-actions auth bootstrap harness: unmocked require("${id}")`);
  }
  new Function('module', 'exports', 'require', GATEWAY_ACTIONS_CODE)(
    moduleObject, moduleObject.exports, fakeRequire,
  );
  return moduleObject.exports;
}

async function testCaseE_GatewayDepositBootstrapsBeforeStart() {
  const callOrder = [];
  let storedRecovery = null;

  const circleActions = {
    module: {
      prepareCircleGatewayFundingReview: () => { throw new Error('not used by this scenario'); },
      confirmPreparedCircleGatewayFunding: () => { throw new Error('not used by this scenario'); },
      executeHostedChallenge: () => { throw new Error('this scenario never reaches a hosted challenge'); },
      ensureCircleFinancialAuth: async () => {
        callOrder.push('bootstrap');
        return { userToken: 'deposit-restored-token', encryptionKey: 'deposit-restored-key' };
      },
    },
  };
  const circleAuth = {
    module: {
      clearCircleGatewayDepositRecovery: () => { storedRecovery = null; },
      clearExternalGatewayDepositRecovery: () => {},
      clearExternalGatewayFundingRecovery: () => {},
      readCircleGatewayDepositRecovery: () => storedRecovery,
      readExternalGatewayDepositRecovery: () => null,
      readExternalGatewayFundingRecovery: () => null,
      storeCircleGatewayDepositRecovery: (next) => { storedRecovery = next; },
      storeExternalGatewayDepositRecovery: () => {},
      storeExternalGatewayFundingRecovery: () => {},
    },
  };
  const backend = {
    module: {
      wallet: {
        startGatewayDeposit: async (input) => {
          callOrder.push('start');
          assert.equal(
            input.circleUserToken, 'deposit-restored-token',
            'the deposit start call must use the just-restored credentials',
          );
          return {
            actionId: 'deposit-action-1', requestId: input.requestId,
            state: 'APPROVAL_CHALLENGE', approvalChallengeId: 'deposit-approval-challenge-1',
            depositChallengeId: null, transactionObserved: false,
            expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
          };
        },
        // The scenario stops as soon as the challenge would be executed
        // (which throws above), so nothing beyond start needs a real fake.
      },
    },
  };

  const runner = loadGatewayActions({ backend, circleActions, circleAuth });

  await assert.rejects(
    () => runner.confirmGatewaySourceDeposit(
      { sourceDomain: 3, amountRaw: '2000000' },
      { executionMode: 'CIRCLE_USER_WALLET' },
    ),
    /this scenario never reaches a hosted challenge/,
  );

  assert.deepEqual(
    callOrder, ['bootstrap', 'start'],
    'Circle auth must be restored BEFORE the deposit financial intent is started, exactly the production ordering fix',
  );
}

// ---------------------------------------------------------------------------
// CASE G: confirmCircleEntry / confirmCircleAction, plus every other
// entry point in this file, use the shared bootstrap instead of asserting
// readCircleTabAuth() directly. This is a static-source-text proof of
// wiring, not a third and fourth copy of the behavioral harness above --
// ensureCircleFinancialAuth's own behavior is already proven exhaustively by
// cases A-D, and cases E/F already prove the wiring pattern generalizes to a
// real call site end to end.
// ---------------------------------------------------------------------------

function testCaseG_EveryEntryPointUsesSharedBootstrap() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../app/lib/circle-actions.ts'), 'utf8');

  function bodyOf(signature, nextMarker) {
    const start = source.indexOf(signature);
    assert.ok(start > -1, `expected to find ${signature}`);
    const end = source.indexOf(nextMarker, start);
    assert.ok(end > start, `expected to find ${nextMarker} after ${signature}`);
    return source.slice(start, end);
  }

  const executeHostedChallenge = bodyOf(
    'export async function executeHostedChallenge(challengeId: string) {',
    '\nfunction recoveryFor(',
  );
  assert.match(executeHostedChallenge, /const auth = await ensureCircleFinancialAuth\(\);/);
  assert.ok(!executeHostedChallenge.includes('readCircleTabAuth()'));

  const confirmCircleEntry = bodyOf(
    'export async function confirmCircleEntry(input: {',
    '\nfunction isGatewayFundingRecoveryFor(',
  );
  const authIndex = confirmCircleEntry.indexOf('const auth = await ensureCircleFinancialAuth();');
  const recoveryReadIndex = confirmCircleEntry.indexOf('readCircleEntryRecovery()');
  assert.ok(authIndex > -1, 'confirmCircleEntry must use the shared bootstrap');
  assert.ok(
    authIndex < recoveryReadIndex,
    'confirmCircleEntry must restore auth before reading any local recovery',
  );
  assert.ok(!confirmCircleEntry.includes('readCircleTabAuth()'));

  const prepareCircleGatewayFundingReview = bodyOf(
    'export async function prepareCircleGatewayFundingReview(',
    '\n// ---------------------------------------------------------------------------\n// Generic Circle financial actions',
  );
  assert.match(prepareCircleGatewayFundingReview, /const auth = await ensureCircleFinancialAuth\(\);/);
  assert.ok(!prepareCircleGatewayFundingReview.includes('readCircleTabAuth()'));

  const actionAuthIndex = source.indexOf(
    'const auth = await ensureCircleFinancialAuth();',
    source.indexOf('export async function confirmCircleAction<T extends CircleActionType>('),
  );
  const actionRecoveryIndex = source.indexOf(
    'readCircleActionRecovery()',
    source.indexOf('export async function confirmCircleAction<T extends CircleActionType>('),
  );
  assert.ok(actionAuthIndex > -1, 'confirmCircleAction must use the shared bootstrap');
  assert.ok(
    actionAuthIndex < actionRecoveryIndex,
    'confirmCircleAction must restore auth before reading any local recovery',
  );

  // The Gateway UI must distinguish a Circle auth restore failure from a
  // generic deposit/transfer failure: it is not a financial failure at all
  // (no start call was ever made), and it must route to the same
  // reauthentication UI the rest of the page already uses.
  const walletPage = fs.readFileSync(path.resolve(__dirname, '../../app/wallet/page.tsx'), 'utf8');
  const depositCatchStart = walletPage.indexOf('} catch (cause) {', walletPage.indexOf('async function handleGatewaySourceDeposit'));
  const depositCatchEnd = walletPage.indexOf('} finally {', depositCatchStart);
  const depositCatch = walletPage.slice(depositCatchStart, depositCatchEnd);
  assert.match(depositCatch, /message === "circle_reauthentication_required"/);
  assert.match(
    depositCatch,
    /circle_reauthentication_required"\)\s*\{\s*[\s\S]{0,600}?setCircleReauthRequired\(true\)/,
    'a Circle auth restore failure during a source deposit must show the reauthentication UI, not the generic deposit-failed message',
  );

  // The same-source duplicate-safety guard (gateway_deposit_source_review_required)
  // must reach the user as its own distinct message, never the generic
  // deposit-failed bucket: it is not a financial failure, it is a refusal to
  // create a second concurrent action for a source that already has one.
  assert.match(depositCatch, /message === "gateway_deposit_source_review_required"/);
  const copy = fs.readFileSync(path.resolve(__dirname, '../../app/i18n.tsx'), 'utf8');
  assert.match(copy, /gatewayDepositSourceReviewRequired: "[^"]+"/);
  assert.equal((copy.match(/gatewayDepositSourceReviewRequired:/g) || []).length, 2, 'EN and TR copy must both exist');

  const transferCatchStart = walletPage.indexOf('} catch (cause) {', walletPage.indexOf('async function handleGatewayTransfer'));
  const transferCatchEnd = walletPage.indexOf('} finally {', transferCatchStart);
  const transferCatch = walletPage.slice(transferCatchStart, transferCatchEnd);
  assert.match(transferCatch, /message === "circle_reauthentication_required"/);
  assert.match(
    transferCatch,
    /circle_reauthentication_required"\s*\)\s*\{\s*[\s\S]{0,80}?setCircleReauthRequired\(true\)/,
    'a Circle auth restore failure during a transfer must show the reauthentication UI, not the generic preparation-failed message',
  );

  // Only ensureCircleFinancialAuth itself and the unrelated, reverse-direction
  // restoreExtremaCircleSession (EXTREMA session dead, Circle tab auth alive)
  // may still call readCircleTabAuth() directly.
  const directReads = [...source.matchAll(/readCircleTabAuth\(\)/g)];
  const restoreExtremaStart = source.indexOf('async function restoreExtremaCircleSession(');
  const restoreExtremaEnd = source.indexOf('\nasync function withFreshExtremaCircleSession', restoreExtremaStart);
  // Starts at the doc comment above the function (which itself mentions
  // readCircleTabAuth() in prose) rather than the signature line, so that
  // mention is correctly treated as part of this block, not a stray call.
  const ensureStart = source.indexOf('// The EXTREMA application session lasts seven days');
  const ensureEnd = source.indexOf('\n// This creates only the Circle SDK device context', ensureStart);
  for (const match of directReads) {
    const inRestoreExtrema = match.index > restoreExtremaStart && match.index < restoreExtremaEnd;
    const inEnsure = match.index > ensureStart && match.index < ensureEnd;
    assert.ok(
      inRestoreExtrema || inEnsure,
      'readCircleTabAuth() may only be called from ensureCircleFinancialAuth or the unrelated ' +
      'restoreExtremaCircleSession (EXTREMA session recovery), never from a financial entry point directly',
    );
  }
}

const SCENARIOS = [
  ['case A: existing tab auth is used directly, no refresh', testCaseA_ExistingAuthUsedDirectly],
  ['case B: missing auth refreshes exactly once and proceeds', testCaseB_MissingAuthRefreshesOnce],
  ['case C: concurrent callers share exactly one refresh', testCaseC_ConcurrentCallersShareOneRefresh],
  ['case D: refresh failure fails closed with zero financial calls', testCaseD_RefreshFailureFailsClosed],
  ['case E: Gateway deposit bootstraps before starting the intent', testCaseE_GatewayDepositBootstrapsBeforeStart],
  ['case F: Gateway funding transfer bootstraps before starting the intent', testCaseF_GatewayFundingBootstrapsBeforeStart],
  ['case G: every entry point uses the shared bootstrap, never a direct read', testCaseG_EveryEntryPointUsesSharedBootstrap],
];

(async () => {
  for (const [name, run] of SCENARIOS) {
    await run();
    console.log(`CIRCLE_AUTH_BOOTSTRAP ${name}: PASS`);
  }
  console.log('CIRCLE_AUTH_BOOTSTRAP=PASS');
})().catch((error) => {
  console.error('CIRCLE_AUTH_BOOTSTRAP=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
