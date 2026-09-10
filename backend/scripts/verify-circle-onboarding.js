'use strict';

const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify-only-session-secret-not-for-runtime';

const {
  ARC_TESTNET,
  createCircleUserWalletService,
  pickArcEoa,
} = require('../src/services/circleUserWalletService');

const ADDRESS = '0x1000000000000000000000000000000000000001';
const WALLET = {
  id: '11111111-1111-4111-8111-111111111111',
  address: ADDRESS,
  blockchain: ARC_TESTNET,
  accountType: 'EOA',
  createDate: '2026-09-08T00:00:00.000Z',
};

async function main() {
  assert.equal(pickArcEoa([{ ...WALLET, blockchain: 'BASE-SEPOLIA' }]), null);
  assert.equal(pickArcEoa([{ ...WALLET, accountType: 'SCA' }]), null);
  assert.throws(() => pickArcEoa([WALLET, { ...WALLET, id: '22222222-2222-4222-8222-222222222222' }]), /circle_arc_eoa_ambiguous/);

  const calls = [];
  const client = {
    async listWallets(input) {
      calls.push(['list', input]);
      if (!input.pageAfter) return { data: { wallets: [] }, headers: { 'x-next-page-after': 'cursor-2' } };
      return { data: { wallets: [WALLET] }, headers: {} };
    },
    async createUserPinWithWallets(input) {
      calls.push(['initialize', input]);
      return { data: { challengeId: 'challenge-1' } };
    },
  };
  const service = createCircleUserWalletService({ apiKey: 'verify-key', client });
  const listed = await service.listArcEoa('circle-user-token');
  assert.equal(listed.address, ADDRESS);
  assert.equal(calls.length, 2, 'all pagination pages must be traversed');
  assert.equal(calls[0][1].blockchain, ARC_TESTNET);
  assert.equal(calls[0][1].pageSize, 50);

  const initCalls = [];
  const initService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: {
      async listWallets() { return { data: { wallets: [] }, headers: {} }; },
      async createUserPinWithWallets(input) {
        initCalls.push(input);
        return { data: { challengeId: 'challenge-2' } };
      },
    },
  });
  const initialized = await initService.initializeArcEoa({
    userToken: 'circle-user-token', idempotencyKey: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(initialized.status, 'CHALLENGE_REQUIRED');
  assert.deepEqual(initCalls[0].blockchains, [ARC_TESTNET]);
  assert.equal(initCalls[0].accountType, 'EOA');
  assert.equal(initCalls[0].idempotencyKey, '33333333-3333-4333-8333-333333333333');

  const restoredService = createCircleUserWalletService({
    apiKey: 'verify-key',
    client: {
      async listWallets() { return { data: { wallets: [WALLET] }, headers: {} }; },
      async createUserPinWithWallets() { throw new Error('must not create a duplicate'); },
    },
  });
  const restored = await restoredService.initializeArcEoa({
    userToken: 'circle-user-token', idempotencyKey: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(restored.status, 'EXISTING');
  assert.equal(restored.wallet.id, WALLET.id);

  await assert.rejects(
    () => createCircleUserWalletService().listArcEoa('circle-user-token'),
    /circle_service_not_configured/,
  );
  console.log('CIRCLE_ONBOARDING_FOUNDATION=PASS');
}

main().catch((error) => {
  console.error('CIRCLE_ONBOARDING_FOUNDATION=FAIL', error.message);
  process.exitCode = 1;
});
