'use strict';

// Deterministic proof for the Circle same-address source wallet path, across
// every Gateway funding source (Base, OP, Arbitrum and Ethereum Sepolia).
// Never contacts Circle: every client method below is a fake. Covers:
// reuse-if-exists, one idempotent creation challenge if missing, required
// address match against the session's canonical Arc EOA, and fail-closed
// behavior on mismatch or ambiguity. The browser never nominates the wallet
// id, the blockchain or the address in any of these paths.
//
// Preparation creates a wallet and nothing else: a test client that is asked
// to approve, deposit or transfer fails the run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify-only-session-secret-not-for-runtime';

const {
  BASE_SEPOLIA,
  ALREADY_INITIALIZED_CODE,
  createCircleUserWalletService,
  pickBaseSepoliaEoa,
} = require('../src/services/circleUserWalletService');
const gatewayNetworks = require('../src/services/gatewayNetworks');

const ARC_ADDRESS = '0x1000000000000000000000000000000000000001';
const OTHER_ADDRESS = '0x2000000000000000000000000000000000000002';

// Exactly the four funding sources, read from the one canonical table.
const SOURCE_BLOCKCHAINS = gatewayNetworks.DEPOSIT_SOURCE_NETWORKS
  .map((network) => network.circleBlockchain);

function sourceWallet(address, id = '11111111-1111-4111-8111-111111111111', blockchain = BASE_SEPOLIA) {
  return {
    id,
    address,
    blockchain,
    accountType: 'EOA',
    createDate: '2026-09-11T00:00:00.000Z',
  };
}

// Any financial Circle call reached from a preparation path is a test failure.
const NEVER_FINANCIAL = {
  async createUserTransactionContractExecutionChallenge() {
    throw new Error('wallet preparation must never execute a contract call');
  },
  async createUserTransactionTransferChallenge() {
    throw new Error('wallet preparation must never transfer');
  },
};

function walletListingClient(wallets, expectedBlockchain = BASE_SEPOLIA) {
  return {
    ...NEVER_FINANCIAL,
    async listWallets(input) {
      assert.equal(input.blockchain, expectedBlockchain);
      return { data: { wallets }, headers: {} };
    },
  };
}

async function verifyBlockchain(blockchain) {
  const service = (client) => createCircleUserWalletService({ apiKey: 'verify-key', client });
  const prepare = (client, overrides = {}) => service(client).prepareEoaForBlockchain({
    userToken: 'circle-user-token',
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    blockchain,
    arcAddress: ARC_ADDRESS,
    ...overrides,
  });

  // A wallet already exists with the same address as the Arc session: reused,
  // nothing created.
  const reused = await prepare({
    ...walletListingClient([sourceWallet(ARC_ADDRESS, undefined, blockchain)], blockchain),
    async createWallet() { throw new Error('must not create when a wallet already exists'); },
  });
  assert.equal(reused.status, 'EXISTING');
  assert.equal(reused.wallet.address, ARC_ADDRESS);
  assert.equal(reused.wallet.blockchain, blockchain);
  assert.equal(reused.challengeId, null);

  // Already exists, but a DIFFERENT address than the Arc session: fail closed.
  // Circle's unified EVM addressing means the companion wallet must be the
  // same address, and a mismatch is never worked around.
  await assert.rejects(
    () => prepare(
      walletListingClient([sourceWallet(OTHER_ADDRESS, undefined, blockchain)], blockchain),
      { idempotencyKey: '44444444-4444-4444-8444-444444444444' },
    ),
    /circle_source_address_mismatch/,
  );

  // No wallet yet: one idempotent creation challenge, using createWallet (an
  // already onboarded user), never createUserPinWithWallets (first PIN setup).
  const createCalls = [];
  const created = await prepare(
    {
      ...walletListingClient([], blockchain),
      async createWallet(input) {
        createCalls.push(input);
        return { data: { challengeId: `source-wallet-challenge-${blockchain}` } };
      },
      async createUserPinWithWallets() {
        throw new Error('must not set up a new PIN for an existing user');
      },
    },
    { idempotencyKey: '55555555-5555-4555-8555-555555555555' },
  );
  assert.equal(created.status, 'CHALLENGE_REQUIRED');
  assert.equal(created.challengeId, `source-wallet-challenge-${blockchain}`);
  assert.equal(created.wallet, null, 'a challenge does not yet yield a wallet');
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].blockchains, [blockchain]);
  assert.equal(createCalls[0].accountType, 'EOA');
  assert.equal(createCalls[0].idempotencyKey, '55555555-5555-4555-8555-555555555555');

  // Re-read after the challenge completes: same address still required.
  const afterChallenge = await prepare(
    walletListingClient([sourceWallet(ARC_ADDRESS, undefined, blockchain)], blockchain),
    { idempotencyKey: '66666666-6666-4666-8666-666666666666' },
  );
  assert.equal(afterChallenge.status, 'EXISTING');
  assert.equal(afterChallenge.wallet.address, ARC_ADDRESS);

  // A retried creation call that Circle reports as already-initialized falls
  // back to a fresh listing rather than assuming success.
  const alreadyInit = await prepare(
    {
      ...walletListingClient([sourceWallet(ARC_ADDRESS, undefined, blockchain)], blockchain),
      async createWallet() {
        const error = new Error('already initialized');
        error.code = ALREADY_INITIALIZED_CODE;
        throw error;
      },
    },
    { idempotencyKey: '77777777-7777-4777-8777-777777777777' },
  );
  assert.equal(alreadyInit.status, 'EXISTING');
  assert.equal(alreadyInit.wallet.address, ARC_ADDRESS);

  // The already-initialized fallback still enforces the address match.
  await assert.rejects(
    () => prepare(
      {
        ...walletListingClient([sourceWallet(OTHER_ADDRESS, undefined, blockchain)], blockchain),
        async createWallet() {
          const error = new Error('already initialized');
          error.code = ALREADY_INITIALIZED_CODE;
          throw error;
        },
      },
      { idempotencyKey: '77777777-7777-4777-8777-777777777778' },
    ),
    /circle_source_address_mismatch/,
  );

  // An ambiguous multiple-wallet match fails closed rather than picking one.
  await assert.rejects(
    () => prepare(
      walletListingClient([
        sourceWallet(ARC_ADDRESS, '11111111-1111-4111-8111-111111111111', blockchain),
        sourceWallet(ARC_ADDRESS, '22222222-2222-4222-8222-222222222222', blockchain),
      ], blockchain),
      { idempotencyKey: '88888888-8888-4888-8888-888888888888' },
    ),
    /circle_source_eoa_ambiguous/,
  );

  // An invalid arcAddress is rejected before any Circle call is made.
  await assert.rejects(
    () => prepare(walletListingClient([], blockchain), {
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
      arcAddress: 'not-an-address',
    }),
    /circle_source_arc_address_invalid/,
  );

  // A listing for this chain only reports wallets on this chain: a wallet on
  // another blockchain never satisfies this source.
  const wrongChain = await service(
    walletListingClient([sourceWallet(ARC_ADDRESS, undefined, 'ARC-TESTNET')], blockchain),
  ).listEoaForBlockchain('circle-user-token', blockchain);
  assert.equal(wrongChain, null, 'a wallet on a different blockchain is not this source wallet');
}

async function main() {
  assert.deepEqual(
    SOURCE_BLOCKCHAINS.slice().sort(),
    ['ARB-SEPOLIA', 'BASE-SEPOLIA', 'ETH-SEPOLIA', 'OP-SEPOLIA'],
    'all four Gateway funding sources are covered',
  );

  for (const blockchain of SOURCE_BLOCKCHAINS) {
    await verifyBlockchain(blockchain);
  }

  // A blockchain that is not a configured funding source never reaches Circle,
  // including Arc itself, whose wallet is the session's own and is never
  // prepared through this path.
  for (const rejected of ['ARC-TESTNET', 'MATIC-AMOY', 'not-a-chain']) {
    await assert.rejects(
      () => createCircleUserWalletService({ apiKey: 'verify-key', client: walletListingClient([]) })
        .prepareEoaForBlockchain({
          userToken: 'circle-user-token',
          idempotencyKey: '99999999-9999-4999-8999-999999999990',
          blockchain: rejected,
          arcAddress: ARC_ADDRESS,
        }),
      /circle_source_blockchain_unsupported/,
    );
  }

  // The historical Base-only helpers still behave exactly as they did, so
  // nothing that already depends on them changes meaning.
  assert.equal(pickBaseSepoliaEoa([{ ...sourceWallet(ARC_ADDRESS), blockchain: 'ARC-TESTNET' }]), null);
  assert.throws(
    () => pickBaseSepoliaEoa([
      sourceWallet(ARC_ADDRESS, '11111111-1111-4111-8111-111111111111'),
      sourceWallet(ARC_ADDRESS, '22222222-2222-4222-8222-222222222222'),
    ]),
    /circle_base_sepolia_eoa_ambiguous/,
  );
  const legacyReuse = await createCircleUserWalletService({
    apiKey: 'verify-key',
    client: {
      ...walletListingClient([sourceWallet(ARC_ADDRESS)]),
      async createWallet() { throw new Error('must not create when a wallet already exists'); },
    },
  }).prepareBaseSepoliaEoa({
    userToken: 'circle-user-token',
    idempotencyKey: '33333333-3333-4333-8333-333333333334',
    arcAddress: ARC_ADDRESS,
  });
  assert.equal(legacyReuse.status, 'EXISTING');
  assert.equal(legacyReuse.wallet.blockchain, BASE_SEPOLIA);

  console.log('CIRCLE_SOURCE_WALLET_ALL_CHAINS=PASS');
  console.log('CIRCLE_BASE_WALLET=PASS');
}

// Static wiring proof for the wallet page's Base Sepolia preparation flow.
// This is a pure source-text check: it opens no connection, contacts no
// service, and never mounts the component, so it makes zero live network
// calls by construction. It closes two gaps production hit in this exact
// order: first the hosted challenge was never executed at all, then, once
// fixed, an "error" status read (the prerequisite read itself failing) could
// still fall through into minting a fresh idempotency key or discarding a
// live/expired recovery. Every assertion below anchors on exact source
// slices and their relative order, not on a symbol merely existing
// somewhere in the file, so a regression in branch ordering fails this test.
function verifyWalletPageWiring() {
  const walletPage = fs.readFileSync(
    path.join(__dirname, '../../app/wallet/page.tsx'),
    'utf8',
  );

  assert.match(
    walletPage,
    /import \{ ensureCircleFinancialAuth, executeHostedChallenge \} from "\.\.\/lib\/circle-actions";/,
    'must reuse the existing hosted challenge executor and the shared Circle auth bootstrap, not a second implementation of either',
  );
  assert.match(
    walletPage,
    /readCircleSourceWalletRecovery,\s*\n\s*storeCircleSourceWalletRecovery,\s*\n\s*clearCircleSourceWalletRecovery,/,
    'must import the per-chain CircleSourceWalletRecovery helpers',
  );
  // Recovery is now per funding chain: preparing one network must never
  // consume or clear another network's idempotency key.
  for (const call of [
    'readCircleSourceWalletRecovery(domain)',
    'clearCircleSourceWalletRecovery(domain)',
  ]) {
    assert.ok(walletPage.includes(call), `${call} must be addressed per domain`);
  }

  // --- runSourceWalletChallenge: the shared prepare/execute/reconcile tail ---
  const runnerStart = walletPage.indexOf('async function runSourceWalletChallenge(');
  assert.ok(runnerStart > -1, 'runSourceWalletChallenge must exist as the single shared challenge executor');
  const runnerEnd = walletPage.indexOf('\n  async function handlePrepareSourceWallet', runnerStart);
  assert.ok(runnerEnd > runnerStart);
  const runner = walletPage.slice(runnerStart, runnerEnd);

  assert.match(runner, /storeCircleSourceWalletRecovery\(/);
  assert.match(runner, /clearCircleSourceWalletRecovery\(domain\)/);
  assert.match(runner, /executeHostedChallenge\(challengeId\)/);
  // The runner itself never mints an idempotency key: whatever recovery it
  // is handed is the only one it will ever use.
  assert.ok(
    !runner.includes('crypto.randomUUID()'),
    'runSourceWalletChallenge must never mint its own idempotency key; callers decide that',
  );
  // An existing challengeId is resumed; prepareSourceWallet only runs when
  // there is none.
  assert.match(
    runner,
    /let challengeId = recovery\.challengeId;\s*\n\s*if \(!challengeId\) \{/,
    'an existing challengeId must be resumed without another prepare/createWallet request',
  );
  // Recovery is durably stored WITH the challenge id strictly before the
  // hosted challenge is ever executed.
  const storeWithChallengeIndex = runner.indexOf('recovery = { ...recovery, challengeId };');
  const executeIndex = runner.indexOf('executeHostedChallenge(challengeId)');
  assert.ok(storeWithChallengeIndex > -1 && executeIndex > -1 && storeWithChallengeIndex < executeIndex,
    'recovery must be persisted with the challenge id before executeHostedChallenge runs');
  const storeAfterChallengeIndex = runner.indexOf(
    'storeCircleSourceWalletRecovery(recovery);', storeWithChallengeIndex,
  );
  assert.ok(storeAfterChallengeIndex > -1 && storeAfterChallengeIndex < executeIndex);

  // Every path that marks a chain ready also clears that chain's recovery.
  const readyMatches = [...runner.matchAll(/setStatusFor\(domain, "ready"\)/g)];
  assert.ok(readyMatches.length >= 2, 'expected ready transitions for EXISTING and post-challenge reconciliation');
  for (const match of readyMatches) {
    const precedingText = runner.slice(0, match.index);
    const lastClear = precedingText.lastIndexOf('clearCircleSourceWalletRecovery(domain);');
    const gap = precedingText.length - lastClear;
    assert.ok(lastClear > -1 && gap < 90, 'each "ready" transition must be preceded by clearing that chain\'s recovery record');
  }

  // Mismatch still fails closed and is never converted to "ready".
  assert.match(runner, /setStatusFor\(domain, "mismatch"\)/);
  assert.ok(
    !/reconciled === "mismatch"[\s\S]{0,40}setStatusFor\(domain, "ready"\)/.test(runner),
    'a mismatch must never be reported as ready',
  );

  // --- handlePrepareSourceWallet: the "initial" status dispatcher --------
  const start = walletPage.indexOf('async function handlePrepareSourceWallet');
  assert.ok(start > -1, 'handlePrepareSourceWallet must exist');
  const end = walletPage.indexOf('\n  useEffect(', start);
  const handler = walletPage.slice(start, end);

  assert.match(handler, /const initial = await refreshCircleSourceWalletStatus\(domain, auth\.userToken\);/);

  // READY and MISMATCH must both return before the recovery is even read,
  // proving neither can fall through into any mutation branch below.
  const readyReturnIndex = handler.indexOf('if (initial === "ready") return;');
  const mismatchReturnIndex = handler.indexOf('if (initial === "mismatch") return;');
  const recoveryReadIndex = handler.indexOf('const storedRecovery = readCircleSourceWalletRecovery(domain);');
  assert.ok(readyReturnIndex > -1 && readyReturnIndex < recoveryReadIndex, 'initial "ready" must be a terminal return before recovery is read');
  assert.ok(mismatchReturnIndex > -1 && mismatchReturnIndex < recoveryReadIndex, 'initial "mismatch" must be a terminal fail-closed return before recovery is read');
  // The single recovery read is shared by every remaining branch: there is
  // no second, possibly-inconsistent read anywhere else in the handler.
  assert.equal(
    (handler.match(/readCircleSourceWalletRecovery\(domain\)/g) || []).length, 1,
    'recovery must be read exactly once and reused by every branch below',
  );

  // --- initial === "error": split into its two sub-branches --------------
  const errorBlockStart = handler.indexOf('if (initial === "error") {');
  const errorWithRecoveryCall = 'await runSourceWalletChallenge(domain, auth.userToken, storedRecovery);';
  const errorWithRecoveryCallIndex = handler.indexOf(errorWithRecoveryCall);
  const missingBlockStart = handler.indexOf('// Step 6: MISSING.');
  assert.ok(errorBlockStart > -1 && errorWithRecoveryCallIndex > errorBlockStart && missingBlockStart > errorWithRecoveryCallIndex);

  // error + live (non-expired) recovery: resumes that EXACT recovery via the
  // shared runner and nothing else; never touches crypto.randomUUID or
  // prepareSourceWallet directly, and never clears anything itself.
  const errorWithRecoverySlice = handler.slice(errorBlockStart, errorWithRecoveryCallIndex + errorWithRecoveryCall.length);
  assert.match(errorWithRecoverySlice, /if \(storedRecovery && !recoveryExpired\) \{/,
    'error must only resume when a stored recovery exists and is not expired');
  assert.ok(!errorWithRecoverySlice.includes('crypto.randomUUID()'),
    'error + live recovery must never mint a new idempotency key');
  assert.ok(!errorWithRecoverySlice.includes('backendApi.circle.prepareSourceWallet'),
    'error + live recovery must never call prepare directly (only via the shared runner, which reuses the exact recovery)');
  assert.ok(!errorWithRecoverySlice.includes('clearCircleSourceWalletRecovery('),
    'error + live recovery must never clear recovery itself (only success inside the shared runner may)');

  // error + no usable recovery (none at all, or expired): no mutation of any
  // kind, specifically no UUID, no prepare call, and no clearing of the
  // expired recovery (an errored read is not evidence the wallet is absent).
  const errorNoRecoverySlice = handler.slice(errorWithRecoveryCallIndex + errorWithRecoveryCall.length, missingBlockStart);
  assert.match(errorNoRecoverySlice, /setStatusFor\(domain, "error"\)/);
  assert.ok(!errorNoRecoverySlice.includes('crypto.randomUUID()'),
    'error + no usable recovery must never mint a new idempotency key');
  assert.ok(!errorNoRecoverySlice.includes('backendApi.circle.prepareSourceWallet') && !errorNoRecoverySlice.includes('runSourceWalletChallenge'),
    'error + no usable recovery must never start any prepare attempt');
  assert.ok(!errorNoRecoverySlice.includes('clearCircleSourceWalletRecovery('),
    'error + no usable recovery must never clear an expired recovery: the failed read proves nothing');

  // --- initial === "missing": the only branch allowed to mint a UUID -----
  const missingRunnerCall = 'await runSourceWalletChallenge(domain, auth.userToken, recovery);';
  const missingRunnerCallIndex = handler.indexOf(missingRunnerCall, missingBlockStart);
  assert.ok(missingRunnerCallIndex > missingBlockStart);
  const missingSlice = handler.slice(missingBlockStart, missingRunnerCallIndex + missingRunnerCall.length);

  // Exactly one UUID is minted in the whole handler, and only here.
  assert.equal((handler.match(/crypto\.randomUUID\(\)/g) || []).length, 1,
    'exactly one new idempotency key may ever be minted per call, and only in the "missing" branch');
  assert.ok(missingSlice.includes('crypto.randomUUID()'));
  // The minted recovery is bound to THIS chain, so it can never be replayed
  // against another network's preparation.
  assert.match(missingSlice, /recovery = \{\s*\n\s*domain,/);

  // A live (non-expired) recovery is reused as-is, with no UUID in that arm.
  const reuseStart = missingSlice.indexOf('if (storedRecovery && !recoveryExpired) {');
  const reuseElseStart = missingSlice.indexOf('} else {', reuseStart);
  assert.ok(reuseStart > -1 && reuseElseStart > reuseStart);
  const reuseArm = missingSlice.slice(reuseStart, reuseElseStart);
  assert.match(reuseArm, /recovery = storedRecovery;/);
  assert.ok(!reuseArm.includes('crypto.randomUUID()'), 'reusing a live recovery in "missing" must not also mint a new one');

  // The expired-or-absent arm may clear an expired recovery, but ONLY there,
  // and strictly before minting the new one.
  const freshArm = missingSlice.slice(reuseElseStart);
  const expiredClearIndex = freshArm.indexOf('clearCircleSourceWalletRecovery(domain);');
  const mintIndex = freshArm.indexOf('crypto.randomUUID()');
  assert.ok(mintIndex > -1);
  if (expiredClearIndex > -1) {
    assert.ok(expiredClearIndex < mintIndex, 'clearing an expired recovery must happen before minting the replacement');
    assert.match(
      freshArm.slice(0, mintIndex),
      /if \(storedRecovery && recoveryExpired\) \{\s*\n[\s\S]*?clearCircleSourceWalletRecovery\(domain\);/,
      'the expired recovery may be cleared only when initial === "missing" already proved it, guarded explicitly',
    );
  }

  // --- Unaffected surfaces -------------------------------------------------
  // No hosted challenge runs without the explicit user click that invokes
  // this handler; the readiness effect only ever calls the read-only status
  // check, never the handler or the challenge executor.
  const mountEffectStart = walletPage.indexOf('// One read-only Circle readiness check per funding chain');
  assert.ok(mountEffectStart > -1);
  const mountEffectEnd = walletPage.indexOf('}, [executionMode, sourceState, sourceWalletStatus]);', mountEffectStart);
  assert.ok(mountEffectEnd > mountEffectStart);
  const mountEffect = walletPage.slice(mountEffectStart, mountEffectEnd);
  assert.ok(!mountEffect.includes('executeHostedChallenge'));
  assert.ok(!mountEffect.includes('handlePrepareSourceWallet'));
  assert.ok(!mountEffect.includes('prepareSourceWallet'));
  assert.ok(!mountEffect.includes('crypto.randomUUID()'));

  // Split-brain auth: the application session can be ready for up to seven
  // days while this tab's Circle credentials are gone. This same read-only
  // effect is what restores them, non-financially, before it ever reports a
  // funding chain "ready" -- so the page never shows a clickable Add to
  // Gateway control that would only fail after the click.
  assert.match(mountEffect, /void ensureCircleFinancialAuth\(\)/);
  assert.match(mountEffect, /\.catch\(\(\) => \{[\s\S]{0,80}setCircleReauthRequired\(true\)/);
  assert.ok(
    !mountEffect.includes('readCircleTabAuth()'),
    'the readiness effect must restore auth through the shared bootstrap, never assert it directly',
  );

  // Preparing a companion source wallet is a distinct Circle-authenticated
  // action and must restore auth the same way, never its own copy.
  const prepareHandlerStart = walletPage.indexOf('async function handlePrepareSourceWallet(domain: number) {');
  assert.ok(prepareHandlerStart > -1);
  const prepareHandlerAuthSlice = walletPage.slice(prepareHandlerStart, prepareHandlerStart + 300);
  assert.match(prepareHandlerAuthSlice, /auth = await ensureCircleFinancialAuth\(\);/);
  assert.match(prepareHandlerAuthSlice, /catch \{\s*\n\s*setCircleReauthRequired\(true\);/);
  assert.ok(!prepareHandlerAuthSlice.includes('readCircleTabAuth()'));

  // External wallet Gateway behavior is unaffected: it needs no companion
  // wallet at all (the same address exists on every EVM chain it switches
  // to), and the shared Gateway deposit/transfer entry points are still
  // present. Neither calls into this Circle-only preparation flow.
  assert.match(walletPage, /if \(executionMode !== "EXTERNAL_WALLET" \|\| !sourceState\) return;/);
  assert.match(walletPage, /confirmGatewaySourceDeposit/);
  assert.match(walletPage, /confirmGatewayBurnSignature/);
  const externalDepositStart = walletPage.indexOf('async function handleGatewaySourceDeposit');
  const externalDepositEnd = walletPage.indexOf('\n  async function ensureArcTestnet()', externalDepositStart);
  assert.ok(externalDepositStart > -1 && externalDepositEnd > externalDepositStart);
  const externalDeposit = walletPage.slice(externalDepositStart, externalDepositEnd);
  assert.ok(
    !externalDeposit.includes('handlePrepareSourceWallet') && !externalDeposit.includes('runSourceWalletChallenge'),
    'Gateway deposit must not call into the Circle source wallet preparation flow',
  );

  // This script never imports or calls anything network-capable, never
  // touches Gateway deposit/broadcast logic, and never mounts the
  // component or a real Circle SDK: the assertions above are pure
  // string/regex checks against local source only.
  console.log('CIRCLE_BASE_WALLET_UI_LIVE_NETWORK_CALLS=0');
  console.log('CIRCLE_SOURCE_WALLET_UI=PASS');
  console.log('CIRCLE_BASE_WALLET_UI=PASS');
}

main()
  .then(verifyWalletPageWiring)
  .catch((error) => {
    console.error('CIRCLE_BASE_WALLET=FAIL', error.message);
    process.exitCode = 1;
  });
