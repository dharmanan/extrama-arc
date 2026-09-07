'use strict';

// Static, transaction-free verification of the marketplace write layer.
// Every check here reads source text directly rather than requiring the
// application modules, so this never needs a database, an encryption key,
// or a live RPC connection to run -- matching every other script in the
// backend:check chain, and guaranteeing this file can never itself send a
// transaction.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

const executionSource = read('../src/services/marketplaceExecutionService.js');
const authSource = read('../src/services/actionAuthorizationService.js');
const routesSource = read('../src/routes/actions.js');
const configSource = read('../src/config.js');
const serverSource = read('../src/server.js');

// ---------------------------------------------------------------------------
// Every Solidity custom error the marketplace contract can revert with must
// be mapped to a stable application-level identifier. An unmapped revert
// falls through as a raw, undecoded contract error, which is exactly the
// "expose contract error identifiers" failure mode this layer exists to
// prevent.
// ---------------------------------------------------------------------------
const abiErrorNames = [...executionSource.matchAll(/'error (\w+)\(\)'/g)].map((m) => m[1]);
assert.ok(abiErrorNames.length >= 18, `expected the full marketplace error ABI, found ${abiErrorNames.length}`);

const mapMatch = executionSource.match(
  /CONTRACT_ERROR_TO_APP_ERROR = \{([\s\S]*?)\};/,
);
assert.ok(mapMatch, 'CONTRACT_ERROR_TO_APP_ERROR map not found');
const mappedErrorNames = [...mapMatch[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

for (const name of abiErrorNames) {
  assert.ok(
    mappedErrorNames.includes(name),
    `Solidity error ${name} has no CONTRACT_ERROR_TO_APP_ERROR mapping`,
  );
}

// Every mapped value must itself be a marketplace_-prefixed identifier, never
// the raw PascalCase Solidity name.
for (const match of mapMatch[1].matchAll(/:\s*'([^']+)'/g)) {
  assert.ok(
    match[1].startsWith('marketplace_'),
    `mapped error value is not a stable marketplace_ identifier: ${match[1]}`,
  );
}

// ---------------------------------------------------------------------------
// Never setApprovalForAll. This is checked directly in both files that
// could plausibly ever call it.
// ---------------------------------------------------------------------------
assert.ok(!executionSource.includes('setApprovalForAll'), 'setApprovalForAll must never be used');
assert.ok(!routesSource.includes('setApprovalForAll'), 'setApprovalForAll must never be used');

// Approval, when sent, is always for exactly one tokenId via approve(...),
// never a blanket operator approval.
assert.match(executionSource, /ticket\.approve\(marketplaceAddress, tokenId\)/);

// ---------------------------------------------------------------------------
// Cancel must never gate on approval -- the one flow explicitly required to
// remain possible without it.
// ---------------------------------------------------------------------------
const cancelSection = executionSource.slice(
  executionSource.indexOf('// Cancel'),
  executionSource.indexOf('// ====', executionSource.indexOf('// Cancel') + 1),
);
assert.ok(!cancelSection.includes('isApproved'), 'cancel must not reference approval state');
assert.ok(!cancelSection.includes('.approve('), 'cancel must never send an approve transaction');

// ---------------------------------------------------------------------------
// Buy must never retry automatically on a price change: the reverify step
// throws immediately, and nothing in the buy path calls itself again.
// ---------------------------------------------------------------------------
const buySection = executionSource.slice(executionSource.indexOf('// Buy'));
assert.match(buySection, /askUsdcRaw !== payload\.expectedAskUsdcRaw/);
assert.ok(!buySection.includes('while ('), 'buy path must not contain a retry loop');
assert.ok(!buySection.includes('for (let attempt'), 'buy path must not contain a retry loop');

// ---------------------------------------------------------------------------
// Every new action type is registered on both allow-lists in
// actionAuthorizationService.js (one gate is not enough -- both the
// challenge-consuming and already-consumed lookup paths must recognise it).
// ---------------------------------------------------------------------------
const marketplaceActionTypes = [
  'MARKETPLACE_LIST',
  'MARKETPLACE_UPDATE_PRICE',
  'MARKETPLACE_CANCEL',
  'MARKETPLACE_BUY',
];

const authAllowlists = [...authSource.matchAll(/\[('ENTRY'[\s\S]*?)\]\.includes/g)];
assert.equal(authAllowlists.length, 2, 'expected exactly two action-type allow-lists');
for (const allowlist of authAllowlists) {
  for (const actionType of marketplaceActionTypes) {
    assert.ok(
      allowlist[1].includes(`'${actionType}'`),
      `${actionType} missing from an action-type allow-list`,
    );
  }
}

for (const actionType of marketplaceActionTypes) {
  assert.ok(authSource.includes(`action: '${actionType}'`), `${actionType} has no canonical payload builder`);
}

// ---------------------------------------------------------------------------
// Every start/finish/verify route exists for every marketplace action.
// ---------------------------------------------------------------------------
const routePrefixes = [
  'marketplace-list',
  'marketplace-update-price',
  'marketplace-cancel',
  'marketplace-buy',
];
for (const prefix of routePrefixes) {
  for (const suffix of ['start', 'finish', 'verify']) {
    assert.ok(
      routesSource.includes(`'/${prefix}/${suffix}'`),
      `route missing: /${prefix}/${suffix}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Every thrown marketplace_ identifier that is meant to reach the client is
// present in server.js's public error allow-list -- otherwise it silently
// collapses into a generic 500 and the frontend can never distinguish it
// (this is exactly the gap that would have hidden marketplace_price_changed
// from ever reaching the buyer).
// ---------------------------------------------------------------------------
const thrownInExecution = new Set(
  [...executionSource.matchAll(/throw new Error\('([a-z_]+)'\)/g)]
    .map((m) => m[1])
    .filter((name) => name.startsWith('marketplace_')),
);
assert.ok(thrownInExecution.size >= 25, `expected a substantial thrown-error surface, found ${thrownInExecution.size}`);

const allowlistMatch = serverSource.match(/const safeKnownErrors = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(allowlistMatch, 'safeKnownErrors allow-list not found in server.js');
const publicCodes = new Set([...allowlistMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

for (const code of thrownInExecution) {
  assert.ok(publicCodes.has(code), `marketplace error thrown but not public: ${code}`);
}

// ---------------------------------------------------------------------------
// The configured marketplace address matches the canonical Arc Testnet
// deployment. A silent drift here would misdirect every write action.
// ---------------------------------------------------------------------------
assert.match(
  configSource,
  /EXTREMA_MARKETPLACE_ADDRESS:\s*z\.string\(\)\.default\("0x0C50FE3edD739B7268d58E1414F973e9A55dd037"\)/,
);

console.log('marketplace-actions: PASS');
