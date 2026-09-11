'use strict';

// Transaction-free architecture verification. This script exercises the pure
// execution-identity guards and inspects the concrete entry/auth boundaries.
// It never imports the server, opens the database, contacts Arc, or owns a key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

// Static verifier placeholders satisfy config validation only. No database,
// RPC, signer, or wallet connection is opened by this script.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify-only-session-secret-not-for-runtime';

const {
  EXECUTION_MODES,
  createSessionIdentity,
  assertExternalSessionAddress,
  assertHumanExecutionMode,
} = require('../src/services/executionIdentityService');
const arcService = require('../src/services/arcService');
const {
  assertPayload,
  assertTransaction,
  prepareExternalEntry,
  verifyExternalApprovalReceipt,
  verifyExternalEntryReceipt,
} = require('../src/services/externalEntryExecutionService');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof Error && error.message === code);
}

async function throwsCodeAsync(fn, code) {
  await assert.rejects(fn, (error) => error instanceof Error && error.message === code);
}

const owner = '0x1000000000000000000000000000000000000001';
const other = '0x2000000000000000000000000000000000000002';

async function main() {
// The locked architecture has exactly three execution identities, and only
// the two human ones can ever back a session. There is no default mode.
assert.deepEqual(
  Object.keys(EXECUTION_MODES).sort(),
  ['CIRCLE_USER_WALLET', 'EXTERNAL_WALLET', 'SYSTEM_SEED_WALLET'],
);
throwsCode(
  () => createSessionIdentity({ executionMode: undefined, ownerAddress: owner, walletAddress: owner }),
  'wallet_execution_mode_invalid',
);
throwsCode(
  () => createSessionIdentity({ executionMode: 'LEGACY_SERVER_WALLET', ownerAddress: owner, walletAddress: null }),
  'wallet_execution_mode_invalid',
);
throwsCode(
  () => createSessionIdentity({ executionMode: EXECUTION_MODES.SYSTEM_SEED_WALLET, ownerAddress: owner, walletAddress: owner }),
  'system_seed_wallet_forbidden',
);

const external = createSessionIdentity({
  executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
  ownerAddress: owner,
  walletAddress: owner,
});
assert.equal(external.walletAddress, owner.toLowerCase());
assert.equal(
  assertExternalSessionAddress(external, owner).toLowerCase(),
  owner.toLowerCase(),
);
throwsCode(
  () => assertExternalSessionAddress(external, other),
  'external_wallet_session_mismatch',
);
throwsCode(
  () => createSessionIdentity({
    executionMode: EXECUTION_MODES.EXTERNAL_WALLET,
    ownerAddress: owner,
    walletAddress: other,
  }),
  'external_wallet_session_mismatch',
);
assert.equal(
  assertHumanExecutionMode(EXECUTION_MODES.CIRCLE_USER_WALLET),
  EXECUTION_MODES.CIRCLE_USER_WALLET,
);
const circle = createSessionIdentity({
  executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
  ownerAddress: owner,
  walletAddress: owner,
});
assert.equal(circle.walletAddress, owner.toLowerCase());
throwsCode(
  () => createSessionIdentity({
    executionMode: EXECUTION_MODES.CIRCLE_USER_WALLET,
    ownerAddress: owner,
    walletAddress: other,
  }),
  'circle_wallet_session_mismatch',
);
throwsCode(
  () => assertHumanExecutionMode(EXECUTION_MODES.SYSTEM_SEED_WALLET),
  'system_seed_wallet_forbidden',
);

const schema = read('../src/db/schema.sql');
const auth = read('../src/routes/auth.js');
const middleware = read('../src/middleware/auth.js');
const sessions = read('../src/services/sessionService.js');
const actions = read('../src/routes/actions.js');
const actionAuth = read('../src/services/actionAuthorizationService.js');
const legacyEntry = read('../src/services/entryExecutionService.js');
const externalEntry = read('../src/services/externalEntryExecutionService.js');
const transfers = read('../src/services/ticketTransferExecutionService.js');
const claims = read('../src/services/claimExecutionService.js');
const refunds = read('../src/services/refundExecutionService.js');
const marketplace = read('../src/services/marketplaceExecutionService.js');
const clientActions = read('../../app/lib/wallet-actions.ts');
const circleActions = read('../../app/lib/circle-actions.ts');
const walletPage = read('../../app/wallet/page.tsx');
const walletService = read('../src/services/walletService.js');
const seedBots = read('../src/services/seedBotExecutionService.js');

// schema.sql keeps its historical column definitions (no destructive
// migration); the runtime never relies on the column default.
assert.match(schema, /execution_mode VARCHAR\(32\) NOT NULL/);
assert.match(schema, /wallet_address VARCHAR\(42\)/);
assert.match(schema, /circle_wallet_id UUID/);
assert.match(sessions, /executionMode: options\.executionMode,/);
assert.ok(!/options\.executionMode \|\|/.test(sessions), 'a session never falls back to a default mode');
assert.match(middleware, /!isHumanExecutionMode\(active\.executionMode\)/);
assert.match(middleware, /active\.executionMode !== payload\.executionMode/);
assert.match(middleware, /active\.walletAddress \|\| null/);

// No human path signs with a server held key, and no WebAuthn ceremony
// remains in the human runtime.
for (const removed of [
  '../src/services/passkeyService.js',
  '../../app/lib/passkey-client.ts',
  '../../app/lib/circle-entry.ts',
]) {
  assert.ok(!fs.existsSync(path.resolve(__dirname, removed)), `${removed} must not exist`);
}
for (const [name, source] of [
  ['routes/auth.js', auth],
  ['routes/actions.js', actions],
  ['wallet-actions.ts', clientActions],
  ['circle-actions.ts', circleActions],
  ['wallet/page.tsx', walletPage],
]) {
  assert.ok(!/passkey|webauthn|PublicKeyCredential/i.test(source), `${name} must not reference a passkey flow`);
}
assert.match(walletService, /async function getSignerForUser/);
assert.ok(!/encrypt\(|createWallet|generateWallet|Wallet\.createRandom/.test(walletService),
  'walletService never creates a wallet; it only signs for seed agents');
assert.match(seedBots, /executionMode: 'SYSTEM_SEED_WALLET'/);

const walletLogin = auth.slice(
  auth.indexOf("router.post('/wallet-login/challenge'"),
  auth.indexOf("router.get('/session'"),
);
assert.match(walletLogin, /ethers\.verifyMessage/);
assert.match(walletLogin, /executionMode: EXECUTION_MODES\.EXTERNAL_WALLET/);
assert.ok(!walletLogin.includes('passkeyService'), 'external wallet login must not call passkeyService');
assert.match(walletPage, /walletLoginChallenge/);
assert.match(walletPage, /finishWalletLogin/);

assert.match(legacyEntry, /walletService\.getSignerForUser/);
assert.match(legacyEntry, /payload\.executionMode !== 'SYSTEM_SEED_WALLET'/);
assert.ok(!externalEntry.includes('getSignerForUser'));
assert.ok(!externalEntry.includes('new ethers.Wallet'));
assert.ok(!externalEntry.includes('.sendTransaction('));
assert.match(externalEntry, /ARC_POOL_TOPOLOGY\.find/);
assert.match(externalEntry, /isCanonicalV2Round/);
assert.match(externalEntry, /POOL_INTERFACE\.encodeFunctionData\('enterPrediction'/);
assert.match(externalEntry, /USDC_INTERFACE\.encodeFunctionData\('approve'/);
assert.match(externalEntry, /receipt\.status !== 1/);
assert.match(externalEntry, /entry\.roundId/);
assert.match(externalEntry, /entry\.predictionPriceCents/);
assert.match(externalEntry, /ticketOwner/);
assert.match(externalEntry, /entry_sender_mismatch/);
assert.match(externalEntry, /entry_target_mismatch/);
assert.match(externalEntry, /entry_calldata_mismatch/);
assert.match(externalEntry, /entry_approval_failed/);

const topology = arcService.ARC_POOL_TOPOLOGY.find((item) => item.cadence === 'DAILY');
assert.ok(topology, 'a canonical DAILY pool is required');
const poolAddress = ethers.getAddress(topology.poolAddress);
const usdcAddress = ethers.getAddress(arcService.ARC_TESTNET_USDC_ADDRESS);
const ticketAddress = '0x3000000000000000000000000000000000000003';
const start = 1_799_712_000n;
const end = start + 86_400n;
const close = end - 14_400n;
const payload = {
  action: 'ENTRY',
  chainId: Number(arcService.ARC_TESTNET_CHAIN_ID),
  contract: poolAddress,
  destination: poolAddress,
  roundId: 42,
  amountRaw: '1000000',
  predictionPriceCents: 12_345,
  executionMode: 'EXTERNAL_WALLET',
  walletAddress: owner,
  nonce: '0123456789abcdef0123456789abcdef',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const makeState = (overrides = {}) => ({
  provider: {},
  network: { chainId: arcService.ARC_TESTNET_CHAIN_ID },
  walletAddress: ethers.getAddress(owner),
  poolAddress,
  usdcAddress,
  ticketAddress,
  pool: {},
  round: {
    entryOpenAt: start,
    entryCloseAt: close,
    observationStartAt: close,
    observationEndAt: end,
    status: 0n,
  },
  chainTimestamp: start + 300n,
  hasEntered: false,
  predictionTaken: false,
  balance: 2_000_000n,
  allowance: 0n,
  nativeBalance: 1n,
  ...overrides,
});

assertPayload(payload);
throwsCode(() => assertPayload({ ...payload, chainId: 1 }), 'action_authorization_invalid');
throwsCode(() => assertPayload({ ...payload, roundId: 0 }), 'action_authorization_invalid');
throwsCode(
  () => assertPayload({ ...payload, predictionPriceCents: 0 }),
  'action_authorization_invalid',
);

const approval = await prepareExternalEntry(payload, {
  readLiveState: async () => makeState(),
});
assert.equal(approval.step, 'APPROVAL_REQUIRED');
assert.equal(approval.transactionRequest.from, ethers.getAddress(owner));
assert.equal(approval.transactionRequest.to, usdcAddress);
assert.equal(approval.transactionRequest.chainId, 5042002);

const fakePool = '0x4000000000000000000000000000000000000004';
await throwsCodeAsync(
  () => prepareExternalEntry(
    { ...payload, contract: fakePool, destination: fakePool },
    { readLiveState: async () => makeState({ poolAddress: fakePool }) },
  ),
  'entry_round_not_available',
);
await throwsCodeAsync(
  () => prepareExternalEntry(payload, {
    readLiveState: async () => makeState({ round: { ...makeState().round, status: 1n } }),
  }),
  'entry_round_not_available',
);
await throwsCodeAsync(
  () => prepareExternalEntry(payload, {
    readLiveState: async () => makeState({ predictionTaken: true }),
  }),
  'entry_price_taken',
);

throwsCode(
  () => assertTransaction(
    { from: owner, to: poolAddress, value: 0n, data: '0x1234' },
    { from: owner, to: poolAddress, data: '0xabcd' },
  ),
  'entry_calldata_mismatch',
);

const failedApprovalState = makeState({
  provider: {
    getTransaction: async () => ({
      from: owner,
      to: approval.transactionRequest.to,
      value: 0n,
      data: approval.transactionRequest.data,
    }),
    getTransactionReceipt: async () => ({ status: 0, logs: [] }),
  },
});
await throwsCodeAsync(
  () => verifyExternalApprovalReceipt(payload, `0x${'1'.repeat(64)}`, {
    readLiveState: async () => failedApprovalState,
  }),
  'entry_approval_failed',
);

const entryReady = await prepareExternalEntry(payload, {
  readLiveState: async () => makeState({ allowance: 1_000_000n }),
});
const failedEntryState = makeState({
  allowance: 1_000_000n,
  provider: {
    getTransaction: async () => ({
      from: owner,
      to: entryReady.transactionRequest.to,
      value: 0n,
      data: entryReady.transactionRequest.data,
    }),
    getTransactionReceipt: async () => ({ status: 0, logs: [] }),
  },
});
await throwsCodeAsync(
  () => verifyExternalEntryReceipt(payload, `0x${'2'.repeat(64)}`, {
    readLiveState: async () => failedEntryState,
  }),
  'entry_transaction_failed',
);

const eventInterface = new ethers.Interface([
  'event PredictionEntered(uint256 indexed roundId,uint256 indexed ticketId,address indexed entrant,uint64 predictionPriceCents,uint64 entrySequence)',
]);
const event = eventInterface.encodeEventLog(
  eventInterface.getEvent('PredictionEntered'),
  [payload.roundId, 7n, owner, payload.predictionPriceCents, 3n],
);
await throwsCodeAsync(
  () => verifyExternalEntryReceipt(payload, `0x${'3'.repeat(64)}`, {
    readLiveState: async () => makeState({ allowance: 1_000_000n }),
    readTransaction: async () => ({
      tx: {
        from: owner,
        to: entryReady.transactionRequest.to,
        value: 0n,
        data: entryReady.transactionRequest.data,
      },
      receipt: { status: 1, logs: [{ address: poolAddress, ...event }] },
    }),
    readPostconditions: async () => ({
      entry: {
        ticketId: 7n,
        roundId: 42n,
        originalEntrant: owner,
        predictionPriceCents: 12_345n,
        entrySequence: 3n,
      },
      ticketOwner: other,
      roundAfter: { entryCount: 1n, totalStake: 1_000_000n, escrowRemaining: 1_000_000n },
      hasEntered: true,
      predictionTaken: true,
    }),
  }),
  'entry_postcondition_failed',
);

const externalEntryStart = actions.slice(
  actions.indexOf("router.post('/entry/start'"),
  actions.indexOf("router.post('/entry/approval/verify'"),
);
assert.ok(!actions.includes("'/entry/finish'"), 'entry has no finish step: the wallet signs, then verify');
assert.match(externalEntryStart, /prepareExternalEntry/);
assert.match(externalEntryStart, /executionMode: EXECUTION_MODES\.EXTERNAL_WALLET/);
assert.ok(!externalEntryStart.includes('executeEntry('));
assert.match(actions, /'\/entry\/approval\/verify'/);
assert.match(actions, /'\/entry\/verify'/);
assert.match(actions, /'APPROVAL_REQUIRED'/);
assert.match(actions, /bindExternalEntryTransaction/);
assert.match(actionAuth, /initializeExternalEntryState/);
assert.match(actionAuth, /getPendingExternalEntryAction/);
assert.match(actionAuth, /completeExternalEntryApproval/);
assert.match(actionAuth, /bindExternalEntryTransaction/);
assert.match(actionAuth, /markExternalEntryReceiptVerified/);
assert.match(actionAuth, /authorization_expires_at/);
assert.match(actionAuth, /consumeExternalAction/);
assert.match(clientActions, /authorization === "EXTERNAL_WALLET_SESSION"/);
assert.match(clientActions, /verifyEntryApproval/);
assert.match(clientActions, /verifyEntry\(start\.actionId/);

assert.match(transfers, /buildExternalTransferTransactionRequest/);
assert.match(transfers, /verifyExternalTransferReceipt/);
assert.match(transfers, /assertTransferPayloadFresh/);
assert.match(schema, /external_state VARCHAR\(32\)/);
assert.match(schema, /verified_tx_hash VARCHAR\(66\)/);
assert.match(claims, /buildExternalClaimTransactionRequest/);
assert.match(claims, /verifyExternalClaimReceipt/);
assert.match(refunds, /buildExternalRefundTransactionRequest/);
assert.match(refunds, /verifyExternalRefundReceipt/);
for (const functionName of [
  'buildExternalListTransactionRequest',
  'verifyExternalListReceipt',
  'buildExternalUpdatePriceTransactionRequest',
  'verifyExternalUpdatePriceReceipt',
  'buildExternalCancelTransactionRequest',
  'verifyExternalCancelReceipt',
  'buildExternalBuyTransactionRequest',
  'verifyExternalBuyReceipt',
]) assert.match(marketplace, new RegExp(`function ${functionName}`));

assert.match(actions, /assertExternalSessionAddress\(req\.auth, action\.payload\.walletAddress\)/);
for (const route of [
  'ticket-transfer', 'refund', 'claim', 'marketplace-list', 'marketplace-update-price',
  'marketplace-cancel', 'marketplace-buy',
]) {
  assert.ok(actions.includes(`'/${route}/start'`), `${route} start route`);
  assert.ok(actions.includes(`'/${route}/verify'`), `${route} verify route`);
}
assert.match(actions, /circleActionExecutionService\.startCircleAction/);
assert.match(actions, /circleActionExecutionService\.verifyCircleAction\(/);
assert.match(actions, /circleActionExecutionService\.verifyCircleActionApproval/);
assert.ok(!walletPage.includes('createCircleWallet'));

// Gateway is available to both human execution modes. The wallet page may
// read balances, prepare the existing transfer signature, and drive a Base
// Sepolia source deposit, but it must never hold transfer/mint calldata
// implementation itself or a direct Gateway broadcast path: all of that
// stays server-side (gatewayService/baseSepoliaService) or in the shared
// gateway-actions helper, which the page only calls into.
const gatewayActions = read('../../app/lib/gateway-actions.ts');
assert.ok(walletPage.includes('backendApi.wallet.gatewayBalance()'));
assert.ok(walletPage.includes('confirmGatewayBurnSignature'));
assert.ok(walletPage.includes('confirmGatewayBaseDeposit'));
assert.ok(gatewayActions.includes('confirmCircleGatewayFunding'), 'Circle Gateway funding support must be preserved');
assert.ok(!/gatewayMint|burnIntent|\/v1\/transfer|encodeFunctionData/i.test(walletPage));
assert.ok(!walletPage.includes('submitGatewayFunding'), 'the wallet page must not expose direct Gateway broadcast');

console.log('multi wallet execution: PASS');
}

main().catch((error) => {
  console.error('multi wallet execution: FAIL', error.message);
  process.exitCode = 1;
});
