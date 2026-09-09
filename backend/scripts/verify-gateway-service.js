'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const {
  ARC_GATEWAY_DOMAIN,
  GATEWAY_API_URL,
  GATEWAY_MINTER_CONTRACT,
  GATEWAY_WALLET_CONTRACT,
  buildArcFundingBurnIntent,
  readUnifiedUsdcBalance,
  recoverBurnIntentSigner,
} = require('../src/services/gatewayService');

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const BASE_SEPOLIA_DOMAIN = 6;

function burnIntentInput(overrides = {}) {
  return {
    walletAddress: ADDRESS,
    sourceDomain: BASE_SEPOLIA_DOMAIN,
    valueRaw: '1000000',
    maxFeeRaw: '10000',
    maxBlockHeight: '18446744073709551615',
    salt: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

async function verifyBurnIntent() {
  // gatewayService mirrors the canonical Arc USDC address instead of importing
  // arcService, which needs backend secrets. Prove the mirror has not drifted.
  const arcSource = fs.readFileSync(
    path.join(__dirname, '../src/services/arcService.js'),
    'utf8',
  );
  const gatewaySource = fs.readFileSync(
    path.join(__dirname, '../src/services/gatewayService.js'),
    'utf8',
  );
  const arcUsdc = /ARC_TESTNET_USDC_ADDRESS = '(0x[0-9a-fA-F]{40})'/.exec(arcSource);
  const gatewayUsdc = /ARC_TESTNET_USDC_ADDRESS = '(0x[0-9a-fA-F]{40})'/.exec(gatewaySource);
  assert.ok(arcUsdc && gatewayUsdc, 'both modules must declare the Arc USDC address');
  assert.equal(gatewayUsdc[1], arcUsdc[1]);
  assert.equal(ethers.getAddress(arcUsdc[1]), ethers.getAddress(ARC_USDC));

  const built = buildArcFundingBurnIntent(burnIntentInput());

  // Destination is pinned to Arc and to canonical Arc USDC, never caller supplied.
  assert.equal(built.burnIntent.spec.destinationDomain, ARC_GATEWAY_DOMAIN);
  assert.equal(built.burnIntent.spec.destinationDomain, 26);
  assert.equal(
    ethers.getAddress(built.burnIntent.spec.destinationToken),
    ethers.getAddress(ARC_USDC),
  );
  assert.equal(built.burnIntent.spec.destinationContract, GATEWAY_MINTER_CONTRACT);
  assert.equal(built.burnIntent.spec.sourceContract, GATEWAY_WALLET_CONTRACT);

  // The wallet is the only depositor, signer and recipient.
  for (const field of ['sourceDepositor', 'sourceSigner', 'destinationRecipient']) {
    assert.equal(
      ethers.getAddress(built.burnIntent.spec[field]),
      ethers.getAddress(ADDRESS),
      `${field} must be the session wallet`,
    );
  }

  // The forwarder submits the destination mint, so no destination gas is needed.
  assert.equal(
    built.burnIntent.spec.destinationCaller,
    '0x0000000000000000000000000000000000000000',
  );

  // Source token is the source chain's USDC, not Arc's.
  assert.notEqual(
    ethers.getAddress(built.burnIntent.spec.sourceToken),
    ethers.getAddress(ARC_USDC),
  );

  // REST payload keeps 20 byte addresses; the signed message widens them to bytes32.
  assert.match(built.burnIntent.spec.sourceDepositor, /^0x[0-9a-fA-F]{40}$/);
  assert.match(built.typedData.message.spec.sourceDepositor, /^0x[0-9a-fA-F]{64}$/);
  assert.equal(
    built.typedData.message.spec.sourceDepositor,
    ethers.zeroPadValue(ethers.getAddress(ADDRESS), 32),
  );

  // EIP-712 domain carries no chainId, which is what lets one Arc EOA signature
  // spend a balance held on any source domain.
  assert.deepEqual(built.typedData.domain, { name: 'GatewayWallet', version: '1' });
  assert.equal(built.typedData.primaryType, 'BurnIntent');

  // The digest is the real EIP-712 hash of the intent, and a signature over it
  // recovers the wallet. This proves the signing shape end to end without any
  // network call or live transaction.
  assert.equal(
    built.digest,
    ethers.TypedDataEncoder.hash(
      built.typedData.domain,
      built.typedData.types,
      built.typedData.message,
    ),
  );

  const signer = ethers.Wallet.createRandom();
  const signed = buildArcFundingBurnIntent(burnIntentInput({ walletAddress: signer.address }));
  const signature = await signer.signTypedData(
    signed.typedData.domain,
    signed.typedData.types,
    signed.typedData.message,
  );

  assert.equal(
    ethers.getAddress(recoverBurnIntentSigner(signed.typedData, signature)),
    ethers.getAddress(signer.address),
  );

  // A signature over a different intent must not validate against this one.
  const other = buildArcFundingBurnIntent(
    burnIntentInput({ walletAddress: signer.address, salt: `0x${'cd'.repeat(32)}` }),
  );
  assert.notEqual(
    ethers.getAddress(recoverBurnIntentSigner(other.typedData, signature)),
    ethers.getAddress(signer.address),
  );

  // Fail closed on every unsafe input.
  const rejections = [
    [{ sourceDomain: ARC_GATEWAY_DOMAIN }, /gateway_source_domain_is_destination/],
    [{ sourceDomain: 999 }, /gateway_source_domain_unsupported/],
    [{ walletAddress: 'not-an-address' }, /gateway_wallet_invalid/],
    [{ valueRaw: '0' }, /gateway_value_invalid/],
    [{ valueRaw: '-1' }, /gateway_value_invalid/],
    [{ maxFeeRaw: '1000000' }, /gateway_max_fee_exceeds_value/],
    [{ salt: '0xdeadbeef' }, /gateway_salt_invalid/],
  ];

  for (const [overrides, pattern] of rejections) {
    assert.throws(() => buildArcFundingBurnIntent(burnIntentInput(overrides)), pattern);
  }

  assert.throws(
    () => recoverBurnIntentSigner(built.typedData, '0xnotasignature'),
    /gateway_signature_invalid/,
  );

  console.log('GATEWAY_BURN_INTENT=PASS');
}

(async () => {
  let capturedUrl = '';
  let capturedBody = null;

  const result = await readUnifiedUsdcBalance(
    ADDRESS,
    async (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);

      return {
        ok: true,
        async json() {
          return {
            token: 'USDC',
            balances: [
              { domain: 26, depositor: ADDRESS, balance: '1.500000' },
              { domain: 0, depositor: ADDRESS, balance: '0.500000' },
            ],
          };
        },
      };
    },
  );

  assert.equal(capturedUrl, `${GATEWAY_API_URL}/v1/balances`);
  assert.deepEqual(capturedBody, {
    token: 'USDC',
    sources: [{ depositor: ADDRESS }],
  });

  assert.equal(result.token, 'USDC');
  assert.equal(result.totalRaw, '2000000');
  assert.equal(result.totalUsdc, '2.0');
  assert.equal(result.balances.length, 2);
  assert.equal(result.balances[0].balance, '1.500000');
  assert.equal(result.balances[0].balanceRaw, '1500000');

  await assert.rejects(
    () => readUnifiedUsdcBalance('not-an-address'),
    /gateway_depositor_invalid/,
  );

  const walletRoutes = fs.readFileSync(
    path.join(__dirname, '../src/routes/wallet.js'),
    'utf8',
  );

  assert.match(walletRoutes, /router\.get\('\/gateway-balance'/);
  assert.match(
    walletRoutes,
    /req\.auth\.executionMode !== EXECUTION_MODES\.CIRCLE_USER_WALLET/,
  );
  assert.match(
    walletRoutes,
    /readUnifiedUsdcBalance\(wallet\.address\)/,
  );

  const gatewaySection = walletRoutes.slice(
    walletRoutes.indexOf("router.get('/gateway-balance'"),
    walletRoutes.indexOf("router.get('/tickets'"),
  );

  assert.ok(!gatewaySection.includes('req.body'));
  assert.ok(!gatewaySection.includes('req.query'));

  const walletPage = fs.readFileSync(
    path.join(__dirname, '../../app/wallet/page.tsx'),
    'utf8',
  );

  const gatewayReader = walletPage.slice(
    walletPage.indexOf('async function refreshGatewayBalance()'),
    walletPage.indexOf('useEffect', walletPage.indexOf('async function refreshGatewayBalance()')),
  );

  assert.ok(gatewayReader.length > 0, 'refreshGatewayBalance must exist');

  // A Gateway outage is supplemental. It may only clear its own state; it must
  // never fabricate an Arc balance, raise a wallet error or expire the session.
  assert.ok(gatewayReader.includes('setGateway(null)'));
  assert.ok(!gatewayReader.includes('setChainState'));
  assert.ok(!gatewayReader.includes('setChainError'));
  assert.ok(!gatewayReader.includes('setSessionNeedsAuth'));
  assert.ok(!gatewayReader.includes('setError'));

  // The Gateway read is Circle only, and the figure is shown only when the
  // unified balance is actually funded.
  assert.match(
    walletPage,
    /executionMode === "CIRCLE_USER_WALLET"\s*\)\s*\{\s*void refreshGatewayBalance\(\);/,
  );
  assert.match(
    walletPage,
    /const gatewayFunded = gateway !== null && hasPositiveRawAmount\(gateway\.totalRaw\);/,
  );
  assert.match(walletPage, /\{gateway && gatewayFunded && \(/);

  await verifyBurnIntent();

  console.log('GATEWAY_SERVICE=PASS');
  console.log('GATEWAY_ROUTE=PASS');
  console.log('GATEWAY_WALLET_UI=PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
