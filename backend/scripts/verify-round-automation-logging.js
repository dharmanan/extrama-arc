'use strict';

// Zero-dependency, DB/chain-free regression test for the round-automation
// duplicate-logging fix.
//
// roundAutomationService.js pulls in the database pool, Arc RPC clients,
// and several signing services at require() time, so this deliberately
// never requires the real module -- that would need a live Postgres
// connection and a live chain, neither available here, and this test must
// run with no live transactions.
//
// Instead it extracts the real runLifecycle() and runAndLog() function
// source verbatim from the file and executes it in an isolated vm context,
// with only the one genuinely heavy dependency (runLifecycleInternal, which
// performs the actual chain reads and transactions) substituted for a
// controllable fake. Every other line -- the runPromise dedup guard, the
// started-this-run capture, the logging body -- runs exactly as shipped, so
// this test breaks if the real fix is ever reverted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractFunctionSource(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`function not found in source: ${signature}`);

  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let index = braceStart;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting: ${signature}`);

  return source.slice(start, index + 1);
}

const roundAutomationSource = fs.readFileSync(
  path.resolve(__dirname, '../src/services/roundAutomationService.js'),
  'utf8',
);

const runLifecycleSource = extractFunctionSource(roundAutomationSource, 'async function runLifecycle()');
const runAndLogSource = extractFunctionSource(roundAutomationSource, 'function runAndLog()');

// ---------------------------------------------------------------------------
// Static shape: the guard against re-attaching a logger must be in place,
// and must run before runLifecycle() is even called (capturing whether this
// tick started the run) and before .then() is ever reached.
// ---------------------------------------------------------------------------
assert.match(
  runAndLogSource,
  /const startedThisRun = runPromise === null;/,
  'runAndLog must capture whether this tick is the one starting the run, before calling runLifecycle()',
);
assert.match(
  runAndLogSource,
  /if \(!startedThisRun\) return;/,
  'a tick that did not start the run must return before attaching a result logger',
);
{
  const captureIndex = runAndLogSource.indexOf('const startedThisRun = runPromise === null;');
  // Search for the actual call site after the capture line, not the leading
  // comment, which also contains the literal text "runLifecycle()".
  const callIndex = runAndLogSource.indexOf('runLifecycle()', captureIndex);
  const guardIndex = runAndLogSource.indexOf('if (!startedThisRun)', callIndex);
  const thenIndex = runAndLogSource.indexOf('.then(', guardIndex);
  assert.ok(
    captureIndex >= 0 && captureIndex < callIndex && callIndex < guardIndex && guardIndex < thenIndex,
    'expected order: capture startedThisRun, call runLifecycle(), guard, then attach .then()',
  );
}

// ---------------------------------------------------------------------------
// Behavioral proof: a lifecycle run spanning several overlapping timer
// ticks logs its result exactly once, and a later independent run still
// logs normally (the fix must suppress duplicate attachments only, not
// logging itself).
// ---------------------------------------------------------------------------
function buildSandbox() {
  const dailyLogCount = { value: 0 };

  const context = {
    runPromise: null,
    withAutomationLock: (fn) => fn(),
    resolverSignature: () => '',
    lastResolverSignature: '',
    console: {
      log(...args) {
        if (String(args[0]) === '[round-automation] daily rounds ensured') {
          dailyLogCount.value += 1;
        }
      },
      warn() {},
      error(...args) {
        throw new Error(`unexpected console.error in behavioral check: ${args.join(' ')}`);
      },
    },
  };

  vm.createContext(context);

  const runLifecycleForTest = runLifecycleSource.replace(
    'withAutomationLock(runLifecycleInternal)',
    'withAutomationLock(runLifecycleInternalStub)',
  );
  assert.notEqual(
    runLifecycleForTest,
    runLifecycleSource,
    'expected to substitute the one heavy dependency (runLifecycleInternal) for a test stub',
  );

  vm.runInContext(`${runLifecycleForTest}\nthis.runLifecycle = runLifecycle;`, context);
  vm.runInContext(`${runAndLogSource}\nthis.runAndLog = runAndLog;`, context);

  return { context, dailyLogCount };
}

function fakeResult(marker) {
  return {
    skipped: false,
    created: { daily: { skipped: false, marker } },
    lock: {},
    resolver: {},
    readFailures: [],
  };
}

// A macrotask yield, not a fixed number of microtask hops: the real chain is
// runLifecycleInternal() -> .finally() -> .then(), and counting exact
// microtask turns across that chain is a fragile way to wait for it. A
// setTimeout(0) always runs after every pending microtask has drained,
// regardless of how many hops the chain needs.
function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function main() {
  const { context, dailyLogCount } = buildSandbox();

  let resolveRun;
  const slowRun = new Promise((resolve) => { resolveRun = resolve; });
  context.runLifecycleInternalStub = () => slowRun;

  // Three timer ticks land while the single lifecycle run is still in
  // flight -- exactly the reported scenario: a run lasting longer than the
  // 60 second timer interval, so several ticks overlap it.
  context.runAndLog();
  context.runAndLog();
  context.runAndLog();

  assert.equal(dailyLogCount.value, 0, 'nothing should be logged before the in-flight run resolves');

  resolveRun(fakeResult('overlapping-ticks'));
  await flushAsyncWork();

  assert.equal(
    dailyLogCount.value,
    1,
    `expected the one lifecycle result to be logged exactly once across 3 overlapping ticks, logged ${dailyLogCount.value} times`,
  );

  // A later, genuinely separate run must still be logged -- the fix must
  // not suppress logging outright, only the duplicate attachments onto the
  // same in-flight promise.
  context.runPromise = null;
  let resolveSecondRun;
  const secondRun = new Promise((resolve) => { resolveSecondRun = resolve; });
  context.runLifecycleInternalStub = () => secondRun;

  context.runAndLog();
  resolveSecondRun(fakeResult('later-run'));
  await flushAsyncWork();

  assert.equal(dailyLogCount.value, 2, 'a later, independent lifecycle run must still be logged once');

  console.log('round-automation-logging: PASS');
}

main().catch((error) => {
  console.error('round-automation-logging: FAIL', error);
  process.exit(1);
});
