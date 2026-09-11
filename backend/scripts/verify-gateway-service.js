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
  SOURCE_USDC_BY_DOMAIN,
  buildArcFundingBurnIntent,
  buildArcFundingTransferSpec,
  estimateArcFunding,
  isTransferableSourceDomain,
  readUnifiedUsdcBalance,
  submitArcFunding,
  readArcFundingTransferStatus,
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

  // Circle's quickstart submits the signed EIP-712 message itself as the burn
  // intent, so there must be exactly one shape. Anything weaker would allow a
  // 20 byte intent to be signed and a bytes32 one submitted, or the reverse.
  assert.deepEqual(built.burnIntent, built.typedData.message);
  assert.strictEqual(built.burnIntent, built.typedData.message);

  const ADDRESS_FIELDS = [
    'sourceContract',
    'destinationContract',
    'sourceToken',
    'destinationToken',
    'sourceDepositor',
    'destinationRecipient',
    'sourceSigner',
    'destinationCaller',
  ];

  // Every address shaped field of the submittable intent is bytes32 padded.
  for (const field of ADDRESS_FIELDS) {
    assert.match(
      built.burnIntent.spec[field],
      /^0x[0-9a-f]{64}$/,
      `${field} must be bytes32 padded in the submitted burn intent`,
    );
  }

  // Destination is pinned to Arc and to canonical Arc USDC, never caller supplied.
  assert.equal(built.burnIntent.spec.destinationDomain, ARC_GATEWAY_DOMAIN);
  assert.equal(built.burnIntent.spec.destinationDomain, 26);
  assert.equal(
    built.burnIntent.spec.destinationToken,
    ethers.zeroPadValue(ethers.getAddress(ARC_USDC), 32),
  );
  assert.equal(
    built.burnIntent.spec.destinationContract,
    ethers.zeroPadValue(GATEWAY_MINTER_CONTRACT, 32),
  );
  assert.equal(
    built.burnIntent.spec.sourceContract,
    ethers.zeroPadValue(GATEWAY_WALLET_CONTRACT, 32),
  );

  // The wallet is the only depositor, signer and recipient.
  for (const field of ['sourceDepositor', 'sourceSigner', 'destinationRecipient']) {
    assert.equal(
      built.burnIntent.spec[field],
      ethers.zeroPadValue(ethers.getAddress(ADDRESS), 32),
      `${field} must be the session wallet`,
    );
  }

  // Zero destinationCaller permits any caller, including Circle's forwarder.
  // Forwarding itself is requested with ?enableForwarder=true, not by this field.
  assert.equal(built.burnIntent.spec.destinationCaller, ethers.ZeroHash);

  // Source token is the source chain's USDC, not Arc's.
  assert.notEqual(
    built.burnIntent.spec.sourceToken,
    ethers.zeroPadValue(ethers.getAddress(ARC_USDC), 32),
  );
  assert.equal(
    built.burnIntent.spec.sourceToken,
    ethers.zeroPadValue(
      ethers.getAddress(SOURCE_USDC_BY_DOMAIN.get(BASE_SEPOLIA_DOMAIN)),
      32,
    ),
  );

  // The intent is frozen, so a caller cannot mutate it after signing.
  // Object.freeze is shallow, so the nested spec is frozen in its own right.
  assert.ok(Object.isFrozen(built.burnIntent));
  assert.ok(Object.isFrozen(built.burnIntent.spec));

  // isFrozen only reports the flag. Prove the effect: mutating a critical
  // nested field throws under strict mode and leaves the value untouched, so a
  // signed intent cannot be repointed at another token before submission.
  const destinationTokenBefore = built.burnIntent.spec.destinationToken;
  assert.throws(() => {
    built.burnIntent.spec.destinationToken = ethers.zeroPadValue(
      '0x000000000000000000000000000000000000dEaD',
      32,
    );
  }, TypeError);
  assert.equal(built.burnIntent.spec.destinationToken, destinationTokenBefore);

  // Same for the outer intent, where the fee lives.
  const maxFeeBefore = built.burnIntent.maxFee;
  assert.throws(() => {
    built.burnIntent.maxFee = '999999999';
  }, TypeError);
  assert.equal(built.burnIntent.maxFee, maxFeeBefore);

  // The signed message and the submitted intent are still the same object after
  // those attempts, so nothing can drift between signing and submission.
  assert.strictEqual(built.burnIntent, built.typedData.message);
  assert.equal(
    built.digest,
    ethers.TypedDataEncoder.hash(
      built.typedData.domain,
      built.typedData.types,
      built.typedData.message,
    ),
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

  // Every source domain address must survive checksum validation, which catches
  // a mistyped or misremembered address rather than letting it reach Circle.
  for (const [domain, address] of SOURCE_USDC_BY_DOMAIN) {
    assert.equal(
      ethers.getAddress(address),
      address,
      `domain ${domain} USDC address must be correctly checksummed`,
    );
    assert.ok(isTransferableSourceDomain(domain));
  }

  // The two Gateway domains that must never be on this EVM signing path.
  assert.ok(!SOURCE_USDC_BY_DOMAIN.has(5), 'Solana must not use this path');
  assert.ok(!SOURCE_USDC_BY_DOMAIN.has(ARC_GATEWAY_DOMAIN), 'Arc is the destination');
  assert.equal(isTransferableSourceDomain(5), false);
  assert.equal(isTransferableSourceDomain(ARC_GATEWAY_DOMAIN), false);

  // Domain 13 is Sonic Testnet, not the separate Sonic Blaze Testnet. Checksum
  // validation cannot tell these apart, so the mapping is pinned explicitly.
  assert.equal(
    SOURCE_USDC_BY_DOMAIN.get(13),
    '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51',
    'domain 13 must be Sonic Testnet USDC',
  );
  assert.notEqual(
    SOURCE_USDC_BY_DOMAIN.get(13),
    '0xA4879Fed32Ecbef99399e5cbC247E533421C4eC6',
    'Sonic Blaze Testnet USDC is a different network',
  );

  // Arc USDC must never be reachable as a source token.
  for (const address of SOURCE_USDC_BY_DOMAIN.values()) {
    assert.notEqual(ethers.getAddress(address), ethers.getAddress(ARC_USDC));
  }

  console.log('GATEWAY_BURN_INTENT=PASS');
}

async function verifyEstimate() {
  const spec = buildArcFundingTransferSpec({
    walletAddress: ADDRESS,
    sourceDomain: BASE_SEPOLIA_DOMAIN,
    valueRaw: '1000000',
    salt: `0x${'cd'.repeat(32)}`,
  });
  let capturedUrl = null;
  let capturedBody = null;
  const result = await estimateArcFunding(spec, async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          body: [{ burnIntent: { maxFee: '10000', maxBlockHeight: '123456' } }],
          fees: { token: 'USDC', forwardingFee: '0.2' },
        };
      },
    };
  });
  assert.equal(capturedUrl, `${GATEWAY_API_URL}/v1/estimate?enableForwarder=true`);
  assert.deepEqual(capturedBody, [{ spec }]);
  assert.deepEqual(result, {
    maxFeeRaw: '10000', maxBlockHeight: '123456', fees: { token: 'USDC', forwardingFee: '0.2' },
  });
}

async function verifyForwardingClient() {
  const transferId = '55555555-5555-4555-8555-555555555555';
  const burnIntent = buildArcFundingBurnIntent(burnIntentInput()).burnIntent;
  const signature = `0x${'ab'.repeat(65)}`;
  const requestId = '66666666-6666-4666-8666-666666666666';
  let submitUrl = '';
  let submitInit = null;
  let statusUrl = '';
  const submitted = await submitArcFunding(
    { burnIntent, signature, requestId },
    async (url, init) => {
      submitUrl = url;
      submitInit = init;
      return { ok: true, async json() { return { transferId }; } };
    },
  );
  assert.equal(submitUrl, `${GATEWAY_API_URL}/v1/transfer?enableForwarder=true`);
  assert.equal(submitInit.method, 'POST');
  assert.equal(submitInit.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(submitInit.body), [{ burnIntent, signature }]);
  const forwardedBody = JSON.parse(submitInit.body)[0];
  assert.equal(forwardedBody.burnIntent.spec.destinationDomain, ARC_GATEWAY_DOMAIN);
  assert.equal(forwardedBody.burnIntent.spec.value, '1000000');
  assert.equal(Object.prototype.hasOwnProperty.call(forwardedBody, 'value'), false, 'Gateway body must not introduce native ETH');
  assert.deepEqual(submitted, { transferId });

  const status = await readArcFundingTransferStatus(transferId, async (url, init) => {
    statusUrl = url;
    assert.equal(init.method, undefined);
    assert.equal(init.headers['content-type'], 'application/json');
    return {
      ok: true,
      async json() {
        return { status: 'complete', transactionHash: `0x${'cd'.repeat(32)}` };
      },
    };
  });
  assert.equal(statusUrl, `${GATEWAY_API_URL}/v1/transfer/${transferId}`);
  assert.deepEqual(status, { status: 'complete', transactionHash: `0x${'cd'.repeat(32)}`, forwardingFailure: null });

  await assert.rejects(
    () => submitArcFunding({ burnIntent, signature, requestId }, async () => ({ ok: false, status: 503 })),
    /gateway_transfer_submit_unknown/,
  );
  await assert.rejects(
    () => readArcFundingTransferStatus(transferId, async () => ({ ok: false, status: 404 })),
    /gateway_transfer_not_found/,
  );
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

  // Domain 26 is Arc itself and domain 0 is Ethereum Sepolia, so only the
  // second balance can actually be spent to Arc through the burn intent path.
  assert.equal(result.balances[0].domain, 26);
  assert.equal(result.balances[0].transferable, false);
  assert.equal(result.balances[1].domain, 0);
  assert.equal(result.balances[1].transferable, true);
  assert.equal(result.transferableTotalRaw, '500000');
  assert.equal(result.transferableTotalUsdc, '0.5');
  assert.notEqual(result.transferableTotalRaw, result.totalRaw);

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
    walletRoutes.indexOf("router.post('/gateway-funding/start'"),
  );

  assert.ok(!gatewaySection.includes('req.body'));
  assert.ok(!gatewaySection.includes('req.query'));
  assert.match(walletRoutes, /router\.post\('\/gateway-funding\/start'/);
  assert.match(walletRoutes, /router\.get\('\/gateway-funding\/:actionId'/);
  assert.match(walletRoutes, /router\.post\('\/gateway-funding\/:actionId\/submit'/);
  assert.match(walletRoutes, /router\.post\('\/gateway-funding\/:actionId\/verify'/);
  assert.match(walletRoutes, /gatewayFundingService\.start/);
  assert.match(walletRoutes, /gatewayFundingService\.submit/);
  assert.match(walletRoutes, /gatewayFundingService\.status/);
  assert.match(walletRoutes, /gatewayFundingService\.verifySignature/);

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

  // The Gateway read is Circle only. Its explicit state distinguishes loading,
  // successful zero, and failure, while the UI remains visible in every state.
  assert.match(
    walletPage,
    /executionMode === "CIRCLE_USER_WALLET"\s*\)\s*\{\s*void refreshGatewayBalance\(\);/,
  );
  assert.match(
    walletPage,
    /const \[gatewayReadState, setGatewayReadState\] = useState<GatewayReadState>\("idle"\);/,
  );
  assert.match(walletPage, /setGatewayReadState\("loading"\)/);
  assert.match(walletPage, /setGatewayReadState\("ready"\)/);
  assert.match(walletPage, /setGatewayReadState\("error"\)/);
  assert.match(walletPage, /\{executionMode === "CIRCLE_USER_WALLET" && \(\s*<section className="ex-wallet-gateway"/);
  assert.match(walletPage, /gatewayReadState === "ready" && gateway/);
  assert.match(walletPage, /gatewayBalanceUnavailable/);
  assert.match(walletPage, /gatewayRetry/);
  assert.match(walletPage, /gatewayFundingRecovery\) \|\| \(\s*gatewayReadState === "ready" && gatewaySources\.length > 0/);
  assert.match(walletPage, /t\.wallet\.gatewayNoTransferableBalance/);
  assert.equal(walletPage.includes('submitGatewayFunding'), false, 'wallet UI must not expose live broadcast control');

  await verifyBurnIntent();
  await verifyEstimate();
  await verifyForwardingClient();

  console.log('GATEWAY_SERVICE=PASS');
  console.log('GATEWAY_ROUTE=PASS');
  console.log('GATEWAY_WALLET_UI=PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
