'use strict';

// Deterministic proof for the Circle Base Sepolia same-address wallet path.
// Never contacts Circle: every client method below is a fake. Covers:
// reuse-if-exists, one idempotent creation challenge if missing, required
// address match against the session's canonical Arc EOA, and fail-closed
// behavior on mismatch or ambiguity. The browser never nominates the wallet
// id or address in any of these paths.

const assert = require('node:assert/strict');

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

const ARC_ADDRESS = '0x1000000000000000000000000000000000000001';
const OTHER_ADDRESS = '0x2000000000000000000000000000000000000002';

function baseWallet(address, id = '11111111-1111-4111-8111-111111111111') {
  return {
    id,
    address,
    blockchain: BASE_SEPOLIA,
    accountType: 'EOA',
    createDate: '2026-09-11T00:00:00.000Z',
  };
}

function walletListingClient(wallets) {
  return {
    async listWallets(input) {
      assert.equal(input.blockchain, BASE_SEPOLIA);
      return { data: { wallets }, headers: {} };
    },
  };
}

async function main() {
  assert.equal(pickBaseSepoliaEoa([{ ...baseWallet(ARC_ADDRESS), blockchain: 'ARC-TESTNET' }]), null);
  assert.throws(
    () => pickBaseSepoliaEoa([
      baseWallet(ARC_ADDRESS, '11111111-1111-4111-8111-111111111111'),
      baseWallet(ARC_ADDRESS, '22222222-2222-4222-8222-222222222222'),
    ]),
    /circle_base_sepolia_eoa_ambiguous/,
  );

  // Already exists, same address as the Arc session: reused, nothing created.
  const reuseService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: {
      ...walletListingClient([baseWallet(ARC_ADDRESS)]),
      async createWallet() { throw new Error('must not create when a wallet already exists'); },
    },
  });
  const reused = await reuseService.prepareBaseSepoliaEoa({
    userToken: 'circle-user-token',
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    arcAddress: ARC_ADDRESS,
  });
  assert.equal(reused.status, 'EXISTING');
  assert.equal(reused.wallet.address, ARC_ADDRESS);
  assert.equal(reused.challengeId, null);

  // Already exists, but a DIFFERENT address than the Arc session: fail closed.
  const mismatchService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: walletListingClient([baseWallet(OTHER_ADDRESS)]),
  });
  await assert.rejects(
    () => mismatchService.prepareBaseSepoliaEoa({
      userToken: 'circle-user-token',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      arcAddress: ARC_ADDRESS,
    }),
    /circle_base_sepolia_address_mismatch/,
  );

  // No wallet yet: one idempotent creation challenge, using createWallet (an
  // already onboarded user), never createUserPinWithWallets (first PIN setup).
  const createCalls = [];
  const createService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: {
      ...walletListingClient([]),
      async createWallet(input) {
        createCalls.push(input);
        return { data: { challengeId: 'base-wallet-challenge-1' } };
      },
      async createUserPinWithWallets() { throw new Error('must not set up a new PIN for an existing user'); },
    },
  });
  const created = await createService.prepareBaseSepoliaEoa({
    userToken: 'circle-user-token',
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
    arcAddress: ARC_ADDRESS,
  });
  assert.equal(created.status, 'CHALLENGE_REQUIRED');
  assert.equal(created.challengeId, 'base-wallet-challenge-1');
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].blockchains, [BASE_SEPOLIA]);
  assert.equal(createCalls[0].accountType, 'EOA');
  assert.equal(createCalls[0].idempotencyKey, '55555555-5555-4555-8555-555555555555');

  // Re-read after the challenge completes: same address required.
  const afterChallengeService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: walletListingClient([baseWallet(ARC_ADDRESS)]),
  });
  const afterChallenge = await afterChallengeService.prepareBaseSepoliaEoa({
    userToken: 'circle-user-token',
    idempotencyKey: '66666666-6666-4666-8666-666666666666',
    arcAddress: ARC_ADDRESS,
  });
  assert.equal(afterChallenge.status, 'EXISTING');
  assert.equal(afterChallenge.wallet.address, ARC_ADDRESS);

  // A retried creation call that Circle reports as already-initialized falls
  // back to a fresh listing rather than assuming success.
  const alreadyInitService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: {
      ...walletListingClient([baseWallet(ARC_ADDRESS)]),
      async createWallet() {
        const error = new Error('already initialized');
        error.code = ALREADY_INITIALIZED_CODE;
        throw error;
      },
    },
  });
  const alreadyInit = await alreadyInitService.prepareBaseSepoliaEoa({
    userToken: 'circle-user-token',
    idempotencyKey: '77777777-7777-4777-8777-777777777777',
    arcAddress: ARC_ADDRESS,
  });
  assert.equal(alreadyInit.status, 'EXISTING');
  assert.equal(alreadyInit.wallet.address, ARC_ADDRESS);

  // Ambiguous multiple-wallet match fails closed even mid-creation flow.
  const ambiguousService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: walletListingClient([
      baseWallet(ARC_ADDRESS, '11111111-1111-4111-8111-111111111111'),
      baseWallet(ARC_ADDRESS, '22222222-2222-4222-8222-222222222222'),
    ]),
  });
  await assert.rejects(
    () => ambiguousService.prepareBaseSepoliaEoa({
      userToken: 'circle-user-token',
      idempotencyKey: '88888888-8888-4888-8888-888888888888',
      arcAddress: ARC_ADDRESS,
    }),
    /circle_base_sepolia_eoa_ambiguous/,
  );

  // An invalid arcAddress is rejected before any Circle call is made.
  await assert.rejects(
    () => createCircleUserWalletService({ apiKey: 'verify-key', client: walletListingClient([]) })
      .prepareBaseSepoliaEoa({ userToken: 'circle-user-token', idempotencyKey: '99999999-9999-4999-8999-999999999999', arcAddress: 'not-an-address' }),
    /circle_base_sepolia_arc_address_invalid/,
  );

  console.log('CIRCLE_BASE_WALLET=PASS');
}

main().catch((error) => {
  console.error('CIRCLE_BASE_WALLET=FAIL', error.message);
  process.exitCode = 1;
});
