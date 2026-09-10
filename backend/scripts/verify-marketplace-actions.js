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
// never a blanket operator approval. The same per token calldata backs the
// Circle approval phase and its onchain verification.
assert.match(executionSource, /TICKET_INTERFACE\.encodeFunctionData\('approve', \[marketplaceAddress, tokenId\]\)/);
for (const fn of ['prepareCircleListApproval', 'verifyCircleListApprovalReceipt']) {
  const body = executionSource.slice(executionSource.indexOf(`async function ${fn}`));
  assert.match(body.slice(0, body.indexOf('\n}\n')), /perTokenApprovalCalldata\(marketplaceAddress, BigInt\(payload\.tokenId\)\)/,
    `${fn} must use the exact per token approval`);
}

// A purchase approval is always exactly the expected ask, never unlimited.
assert.ok(!executionSource.includes('MaxUint256'), 'an unlimited USDC approval must never be built');
assert.match(executionSource, /USDC_INTERFACE\.encodeFunctionData\('approve', \[marketplaceAddress, expectedAskUsdc\]\)/);

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
// Every marketplace action type is registered on the single action type
// allow list that the consumed action lookup enforces, and on the Circle
// phase table (list and buy carry an approval phase, the others do not).
// ---------------------------------------------------------------------------
const marketplaceActionTypes = [
  'MARKETPLACE_LIST',
  'MARKETPLACE_UPDATE_PRICE',
  'MARKETPLACE_CANCEL',
  'MARKETPLACE_BUY',
];

const actionTypesMatch = authSource.match(/const ACTION_TYPES = Object\.freeze\(\[([\s\S]*?)\]\);/);
assert.ok(actionTypesMatch, 'ACTION_TYPES allow list not found');
assert.match(authSource, /if \(!ACTION_TYPES\.includes\(expectedActionType\)\)/, 'the consumed action lookup must enforce ACTION_TYPES');
const circlePhasesMatch = authSource.match(/const CIRCLE_ACTION_PHASES = Object\.freeze\(\{([\s\S]*?)\}\);/);
assert.ok(circlePhasesMatch, 'CIRCLE_ACTION_PHASES not found');
for (const actionType of marketplaceActionTypes) {
  assert.ok(actionTypesMatch[1].includes(`'${actionType}'`), `${actionType} missing from ACTION_TYPES`);
  const expectedPhases = actionType === 'MARKETPLACE_LIST' || actionType === 'MARKETPLACE_BUY'
    ? "['APPROVAL', 'ACTION']"
    : "['ACTION']";
  assert.ok(circlePhasesMatch[1].includes(`${actionType}: ${expectedPhases},`), `${actionType} Circle phases`);
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
// The Circle approval phase has its own verify route for list and buy only.
for (const prefix of ['marketplace-list', 'marketplace-buy']) {
  assert.ok(routesSource.includes(`'/${prefix}/approval/verify', circleActionApprovalVerifyLimiter,`),
    `route missing: /${prefix}/approval/verify`);
}
for (const prefix of ['marketplace-update-price', 'marketplace-cancel']) {
  assert.ok(!routesSource.includes(`'/${prefix}/approval/verify'`), `/${prefix} has no approval phase`);
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

// ---------------------------------------------------------------------------
// Duplicate-listing preflight. A ticket that already has an active listing
// must be rejected by a direct, uncached chain read before any action
// authorization or Circle challenge is ever created -- not only at the
// final list() revert. Regression coverage for the bug where /tickets kept
// offering "List for sale" after a listing had already gone through.
// ---------------------------------------------------------------------------
const marketplaceServiceSource = read('../src/services/marketplaceService.js');

assert.match(
  marketplaceServiceSource,
  /'function activeListingId\(address ticket,uint256 tokenId\) view returns \(uint256\)'/,
  'activeListingId must be declared in the marketplace ABI',
);
assert.match(
  marketplaceServiceSource,
  /async function readActiveListingForTicket/,
  'readActiveListingForTicket preflight reader is missing',
);

const activeListingReaderSection = marketplaceServiceSource.slice(
  marketplaceServiceSource.indexOf('async function readActiveListingForTicket'),
  marketplaceServiceSource.indexOf('async function readUsdcAllowance'),
);
assert.match(
  activeListingReaderSection,
  /marketplace\.activeListingId\(/,
  'the preflight must call activeListingId directly on the contract',
);
assert.ok(
  !activeListingReaderSection.includes('getMarketplaceListingsState')
    && !activeListingReaderSection.includes('marketplaceListingsCache'),
  'the duplicate-listing preflight must never read through the cached board',
);

// --- active listing blocks /marketplace-list/start before any challenge ---
const startRouteSection = routesSource.slice(
  routesSource.indexOf("router.post('/marketplace-list/start'"),
  routesSource.indexOf("router.post('/marketplace-list/finish'"),
);
assert.match(
  startRouteSection,
  /readActiveListingForTicket/,
  '/marketplace-list/start must perform the fresh active-listing preflight',
);
assert.ok(
  !startRouteSection.includes('getMarketplaceListingsState'),
  '/marketplace-list/start must not rely on the cached board for its preflight',
);
{
  const preflightIndex = startRouteSection.indexOf('activeListing.activeListingId');
  const actionCreatedIndex = startRouteSection.indexOf('createMarketplaceListRequest');
  const circleStartIndex = startRouteSection.indexOf("startCircleFinancialAction(req, res, input, 'MARKETPLACE_LIST'");
  assert.ok(
    preflightIndex >= 0 && actionCreatedIndex >= 0 && preflightIndex < actionCreatedIndex,
    'the active listing check must reject before createMarketplaceListRequest',
  );
  assert.ok(
    circleStartIndex >= 0 && preflightIndex < circleStartIndex,
    'the active listing check must reject before any Circle action or challenge is created',
  );
}

// --- stale client cannot trigger a second valid list flow -----------------
// The same fresh check runs again immediately before any list related
// transaction is built, on the connected wallet list() and on the Circle
// approval phase alike, closing the window between start and the signature
// where another client's listing could have landed.
const listSection = executionSource.slice(
  executionSource.indexOf('// List'),
  executionSource.indexOf('// Update price'),
);
const listableReader = listSection.slice(
  listSection.indexOf('async function readListableTicket'),
  listSection.indexOf('async function buildListTransactionRequest'),
);
assert.match(listableReader, /await assertTicketNotAlreadyListed\(ticketAddress, payload\.tokenId\)/,
  'the fresh reader must run the not already listed guard');
for (const fn of ['buildListTransactionRequest', 'prepareCircleListApproval']) {
  const body = listSection.slice(listSection.indexOf(`async function ${fn}`));
  assert.match(body.slice(0, body.indexOf('\n}\n')), /await readListableTicket\(payload\)/,
    `${fn} must take a fresh listable ticket read`);
}

// --- successful list refreshes current listing state deterministically ---
// The cache refresh is awaited at every write-action call site, never left
// running in the background, so the board is already correct by the time
// the HTTP response goes out.
{
  const declarationIndex = executionSource.indexOf('async function refreshMarketplaceCaches');
  assert.ok(declarationIndex >= 0, 'refreshMarketplaceCaches must be an async function');

  const afterDeclaration = executionSource.slice(declarationIndex);
  const bodyEnd = afterDeclaration.indexOf('\n}\n');
  const refreshBody = afterDeclaration.slice(0, bodyEnd);
  assert.match(
    refreshBody,
    /await marketplaceService\.refreshMarketplaceListingsCache\(\)/,
    'refreshMarketplaceCaches must itself await the cache refresh, not fire it in the background',
  );

  const restOfFile = afterDeclaration.slice(bodyEnd);
  const callSites = [...restOfFile.matchAll(/refreshMarketplaceCaches\(/g)];
  assert.ok(
    callSites.length >= 4,
    `expected at least 4 refreshMarketplaceCaches call sites (one per verified write action), found ${callSites.length}`,
  );
  for (const fn of ['verifyListReceipt', 'verifyUpdatePriceReceipt', 'verifyCancelReceipt', 'verifyBuyReceipt']) {
    const body = executionSource.slice(executionSource.indexOf(`async function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\n}\n')), /await refreshMarketplaceCaches\(/,
      `${fn} must refresh the board before returning`);
  }
  for (const match of callSites) {
    const precedingText = restOfFile.slice(Math.max(0, match.index - 10), match.index);
    assert.match(
      precedingText,
      /await\s*$/,
      'every refreshMarketplaceCaches call site must be awaited, never fire-and-forget',
    );
  }
}

// The frontend must force a fresh, uncached read immediately after its own
// list, price change, or cancel action -- belt and suspenders alongside the
// server-side await above, so the ticket page cannot show stale state
// regardless of timing.
const backendApiSource = read('../../app/lib/backend-api.ts');
assert.match(
  backendApiSource,
  /options\?\.forceFresh \? "\?fresh=1" : ""/,
  'the marketplace listings client must support a forced fresh read',
);

const ticketsPageSource = read('../../app/tickets/page.tsx');
const forceFreshRefreshCount = [...ticketsPageSource.matchAll(/loadMarketplaceListings\(true\)/g)].length;
assert.ok(
  forceFreshRefreshCount >= 3,
  `expected list, price change, and cancel to force a fresh listings read, found ${forceFreshRefreshCount}`,
);

// --- contract ActiveListingExists behavior remains intact -----------------
assert.match(
  executionSource,
  /error ActiveListingExists\(\)/,
  'the contract-level ActiveListingExists safeguard must remain declared in the ABI',
);
assert.match(
  executionSource,
  /ActiveListingExists:\s*'marketplace_already_listed'/,
  'ActiveListingExists must still map to marketplace_already_listed as the final safeguard',
);

console.log('marketplace actions: PASS');
