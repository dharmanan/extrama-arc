'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';
const {
  ARC_GATEWAY_DOMAIN,
  GATEWAY_API_URL,
  GATEWAY_MINTER_CONTRACT,
  GATEWAY_WALLET_CONTRACT,
  TRANSFER_SOURCE_USDC_BY_DOMAIN,
  SOURCE_USDC_BY_DOMAIN,
  buildGatewayBurnIntent,
  buildGatewayTransferSpec,
  estimateGatewayTransfer,
  isTransferableSourceDomain,
  readUnifiedUsdcBalance,
  submitGatewayTransfer,
  readGatewayTransferStatus,
  recoverBurnIntentSigner,
} = require('../src/services/gatewayService');
const {
  assertCircleSourceWalletMatchesAddress,
} = require('../src/services/circleUserWalletService');

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const BASE_SEPOLIA_DOMAIN = 6;

function burnIntentInput(overrides = {}) {
  return {
    walletAddress: ADDRESS,
    sourceDomain: BASE_SEPOLIA_DOMAIN,
    destinationDomain: ARC_GATEWAY_DOMAIN,
    valueRaw: '1000000',
    maxFeeRaw: '10000',
    maxBlockHeight: '18446744073709551615',
    salt: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

async function verifyBurnIntent() {
  // The canonical Arc USDC address now lives once, in gatewayNetworks, and
  // arcService must still agree with it. A drift between the chain the product
  // settles on and the token a burn intent mints would be invisible otherwise.
  const arcSource = fs.readFileSync(
    path.join(__dirname, '../src/services/arcService.js'),
    'utf8',
  );
  const arcUsdc = /ARC_TESTNET_USDC_ADDRESS = '(0x[0-9a-fA-F]{40})'/.exec(arcSource);
  assert.ok(arcUsdc, 'arcService must declare the Arc USDC address');
  const canonicalArc = require('../src/services/gatewayNetworks').networkForDomain(ARC_GATEWAY_DOMAIN);
  assert.equal(ethers.getAddress(canonicalArc.usdc), ethers.getAddress(arcUsdc[1]));
  assert.equal(ethers.getAddress(arcUsdc[1]), ethers.getAddress(ARC_USDC));
  // gatewayService must not keep its own copy of the token or the contracts.
  const gatewaySource = fs.readFileSync(
    path.join(__dirname, '../src/services/gatewayService.js'),
    'utf8',
  );
  assert.equal(
    /ARC_TESTNET_USDC_ADDRESS\s*=\s*'0x/.test(gatewaySource), false,
    'gatewayService must read the Arc token from the canonical network table',
  );

  const built = buildGatewayBurnIntent(burnIntentInput());

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
  const signed = buildGatewayBurnIntent(burnIntentInput({ walletAddress: signer.address }));
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
  const other = buildGatewayBurnIntent(
    burnIntentInput({ walletAddress: signer.address, salt: `0x${'cd'.repeat(32)}` }),
  );
  assert.notEqual(
    ethers.getAddress(recoverBurnIntentSigner(other.typedData, signature)),
    ethers.getAddress(signer.address),
  );

  // Fail closed on every unsafe input.
  const rejections = [
    [{ sourceDomain: 999 }, /gateway_source_domain_unsupported/],
    [{ destinationDomain: 999 }, /gateway_destination_domain_unsupported/],
    // Gateway supports these domains, but this product does not offer them as
    // destinations, so a mint there must never be authorized.
    [{ destinationDomain: 7 }, /gateway_destination_domain_unsupported/],
    [{ destinationDomain: 5 }, /gateway_destination_domain_unsupported/],
    [{ walletAddress: 'not-an-address' }, /gateway_wallet_invalid/],
    [{ valueRaw: '0' }, /gateway_value_invalid/],
    [{ valueRaw: '-1' }, /gateway_value_invalid/],
    [{ salt: '0xdeadbeef' }, /gateway_salt_invalid/],
  ];

  for (const [overrides, pattern] of rejections) {
    assert.throws(() => buildGatewayBurnIntent(burnIntentInput(overrides)), pattern);
  }

  // maxFee is a separately bounded Gateway fee reserve, not a deduction from
  // the requested transfer value. It may exceed value on a high-fee source.
  const feeCanExceedValue = buildGatewayBurnIntent(burnIntentInput({
    valueRaw: '100', maxFeeRaw: '1000000',
  }));
  assert.equal(feeCanExceedValue.burnIntent.maxFee, '1000000');

  // Arc as a SOURCE is legitimate now: a balance deposited on Arc is spendable
  // like any other, and Gateway's same chain withdrawal path means matching
  // source and destination domains are a valid transfer, not an error. The old
  // Arc-specific prohibition must not have been recreated anywhere.
  const arcSourced = buildGatewayBurnIntent(burnIntentInput({
    sourceDomain: ARC_GATEWAY_DOMAIN, destinationDomain: BASE_SEPOLIA_DOMAIN,
  }));
  assert.equal(arcSourced.burnIntent.spec.sourceDomain, ARC_GATEWAY_DOMAIN);
  assert.equal(arcSourced.burnIntent.spec.destinationDomain, BASE_SEPOLIA_DOMAIN);
  const sameChain = buildGatewayBurnIntent(burnIntentInput({
    sourceDomain: BASE_SEPOLIA_DOMAIN, destinationDomain: BASE_SEPOLIA_DOMAIN,
  }));
  assert.equal(sameChain.burnIntent.spec.sourceDomain, sameChain.burnIntent.spec.destinationDomain);

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
    assert.equal(
      isTransferableSourceDomain(domain),
      TRANSFER_SOURCE_USDC_BY_DOMAIN.has(domain),
      `domain ${domain} transfer eligibility must follow the canonical EXTREMA source set`,
    );
  }

  // Solana is not EVM and must never be on this EIP-712 signing path.
  assert.ok(!SOURCE_USDC_BY_DOMAIN.has(5), 'Solana must not use this path');
  assert.equal(isTransferableSourceDomain(5), false);
  // Arc is now a source as well as a destination: a unified balance held on
  // Arc is spendable, including back onto Arc itself.
  assert.ok(SOURCE_USDC_BY_DOMAIN.has(ARC_GATEWAY_DOMAIN), 'an Arc balance is spendable');
  assert.equal(isTransferableSourceDomain(ARC_GATEWAY_DOMAIN), true);
  for (const domain of [1, 7, 10, 13, 14, 16, 19]) {
    assert.ok(SOURCE_USDC_BY_DOMAIN.has(domain), `domain ${domain} may remain low-level metadata`);
    assert.equal(isTransferableSourceDomain(domain), false);
  }

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

  // Arc USDC is reachable as a source token on exactly one domain: Arc's own.
  // Any OTHER domain claiming the Arc token would be a cross-chain mix-up.
  for (const [domain, address] of SOURCE_USDC_BY_DOMAIN) {
    if (domain === ARC_GATEWAY_DOMAIN) {
      assert.equal(ethers.getAddress(address), ethers.getAddress(ARC_USDC));
    } else {
      assert.notEqual(ethers.getAddress(address), ethers.getAddress(ARC_USDC));
    }
  }

  console.log('GATEWAY_BURN_INTENT=PASS');
}

async function verifyEstimate() {
  const spec = buildGatewayTransferSpec({
    walletAddress: ADDRESS,
    sourceDomain: BASE_SEPOLIA_DOMAIN,
    destinationDomain: ARC_GATEWAY_DOMAIN,
    valueRaw: '1000000',
    salt: `0x${'cd'.repeat(32)}`,
  });
  let capturedUrl = null;
  let capturedBody = null;
  const result = await estimateGatewayTransfer([spec], async (url, init) => {
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
    intents: [{ maxFeeRaw: '10000', maxBlockHeight: '123456' }],
    fees: { token: 'USDC', forwardingFee: '0.2' },
  });

  // A whole multi-source plan is priced in one request, and each spec gets its
  // own answer in the same order.
  const second = buildGatewayTransferSpec({
    walletAddress: ADDRESS,
    sourceDomain: 2,
    destinationDomain: ARC_GATEWAY_DOMAIN,
    valueRaw: '400000',
    salt: `0x${'ef'.repeat(32)}`,
  });
  const planEstimate = await estimateGatewayTransfer([spec, second], async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          body: [
            { burnIntent: { maxFee: '10000', maxBlockHeight: '123456' } },
            { burnIntent: { maxFee: '7000', maxBlockHeight: '123457' } },
          ],
        };
      },
    };
  });
  assert.deepEqual(capturedBody, [{ spec }, { spec: second }]);
  assert.deepEqual(planEstimate.intents, [
    { maxFeeRaw: '10000', maxBlockHeight: '123456' },
    { maxFeeRaw: '7000', maxBlockHeight: '123457' },
  ]);

  // A response that does not answer every spec fails closed, so one estimate
  // can never be reused for a different source domain.
  await assert.rejects(
    () => estimateGatewayTransfer([spec, second], async () => ({
      ok: true,
      async json() { return { body: [{ burnIntent: { maxFee: '10000', maxBlockHeight: '123456' } }] }; },
    })),
    /gateway_response_invalid/,
  );
}

async function verifyForwardingClient() {
  const transferId = '55555555-5555-4555-8555-555555555555';
  const burnIntent = buildGatewayBurnIntent(burnIntentInput()).burnIntent;
  const signature = `0x${'ab'.repeat(65)}`;
  const requestId = '66666666-6666-4666-8666-666666666666';
  let submitUrl = '';
  let submitInit = null;
  let statusUrl = '';
  const submitted = await submitGatewayTransfer(
    { requests: [{ burnIntent, signature }], requestId },
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

  // Circle's documented multi-source shape for this forwarding path is one
  // array of individually signed intents, posted as a single transfer.
  const secondIntent = buildGatewayBurnIntent(burnIntentInput({
    sourceDomain: 2, valueRaw: '400000', salt: `0x${'12'.repeat(32)}`,
  })).burnIntent;
  const secondSignature = `0x${'cd'.repeat(65)}`;
  let planInit = null;
  await submitGatewayTransfer(
    {
      requests: [
        { burnIntent, signature },
        { burnIntent: secondIntent, signature: secondSignature },
      ],
      requestId,
    },
    async (url, init) => {
      planInit = init;
      return { ok: true, async json() { return { transferId }; } };
    },
  );
  const planBody = JSON.parse(planInit.body);
  assert.equal(planBody.length, 2, 'one array entry per source allocation');
  assert.deepEqual(planBody, [
    { burnIntent, signature },
    { burnIntent: secondIntent, signature: secondSignature },
  ]);
  assert.equal(planBody[0].burnIntent.spec.sourceDomain, BASE_SEPOLIA_DOMAIN);
  assert.equal(planBody[1].burnIntent.spec.sourceDomain, 2);
  // Every entry mints on the one selected destination.
  for (const entry of planBody) {
    assert.equal(entry.burnIntent.spec.destinationDomain, ARC_GATEWAY_DOMAIN);
  }

  // A plan with no entries, or with an unsigned entry, never reaches Gateway.
  await assert.rejects(
    () => submitGatewayTransfer({ requests: [], requestId }, async () => { throw new Error('unreachable'); }),
    /gateway_burn_intent_invalid/,
  );
  await assert.rejects(
    () => submitGatewayTransfer(
      { requests: [{ burnIntent, signature: 'nope' }], requestId },
      async () => { throw new Error('unreachable'); },
    ),
    /gateway_signature_invalid/,
  );

  const status = await readGatewayTransferStatus(transferId, async (url, init) => {
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
    () => submitGatewayTransfer(
      { requests: [{ burnIntent, signature }], requestId },
      async () => ({ ok: false, status: 503 }),
    ),
    /gateway_transfer_submit_unknown/,
  );
  await assert.rejects(
    () => readGatewayTransferStatus(transferId, async () => ({ ok: false, status: 404 })),
    /gateway_transfer_not_found/,
  );
}

function verifyGatewaySecurityBoundaries() {
  const walletPage = fs.readFileSync(path.join(__dirname, '../../app/wallet/page.tsx'), 'utf8');
  const circleAuth = fs.readFileSync(path.join(__dirname, '../../app/lib/circle-auth.ts'), 'utf8');
  const circleActions = fs.readFileSync(path.join(__dirname, '../../app/lib/circle-actions.ts'), 'utf8');
  const circleRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/circle.js'), 'utf8');
  const authRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');
  const walletRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/wallet.js'), 'utf8');
  const circleWalletService = fs.readFileSync(
    path.join(__dirname, '../src/services/circleUserWalletService.js'),
    'utf8',
  );

  // Browser source-chain identity is always a server-mapped domain. Funding
  // preparation accepts no client blockchain, contract, token or address.
  const fundingSchemaStart = walletRoutes.indexOf('const gatewayFundingStartSchema');
  const fundingSchemaEnd = walletRoutes.indexOf('const gatewayFundingVerifySchema', fundingSchemaStart);
  const fundingSchema = walletRoutes.slice(fundingSchemaStart, fundingSchemaEnd);
  assert.ok(fundingSchemaStart > -1 && fundingSchemaEnd > fundingSchemaStart);
  assert.doesNotMatch(fundingSchema, /sourceDomain|blockchain|contractAddress|tokenAddress/);
  assert.match(walletRoutes, /router\.use\(requireAuth\)/);
  assert.match(walletRoutes, /gatewayFundingService\.start\(\{ auth: req\.auth/);

  const sourcePrepareStart = circleWalletService.indexOf('async function prepareEoaForBlockchain');
  const sourcePrepareEnd = circleWalletService.indexOf('async function prepareBaseSepoliaEoa', sourcePrepareStart);
  const sourcePrepare = circleWalletService.slice(sourcePrepareStart, sourcePrepareEnd);
  assert.match(sourcePrepare, /assertGatewaySourceBlockchain\(blockchain\)/);
  assert.match(sourcePrepare, /ethers\.isAddress\(arcAddress\)/);
  assert.match(sourcePrepare, /wallet\.address\.toLowerCase\(\) !== canonicalArc/);
  assert.match(sourcePrepare, /getClient\(\)\.createWallet/);
  assert.doesNotMatch(sourcePrepare, /getClient().createUserPinWithWallets/);
  assert.doesNotMatch(sourcePrepare, /signUserTypedData|createContractExecutionChallenge|\.approve\(|\.deposit\(/);

  const sourceRouteStart = circleRoutes.indexOf("router.post('/wallet/source/:domain/prepare'");
  const sourceRouteEnd = circleRoutes.indexOf("router.post('/session'");
  const sourceRoute = circleRoutes.slice(sourceRouteStart, sourceRouteEnd);
  assert.match(sourceRoute, /requireAuth/);
  assert.match(sourceRoute, /network.circleBlockchain/);
  assert.match(sourceRoute, /arcAddress: req.auth.walletAddress/);
  assert.doesNotMatch(sourceRoute, /arcAddress:\s*req\.body|blockchain:\s*req\.body/);

  // Circle credentials are used only by the existing tab-auth record; no
  // refresh token or Gateway API key is written to browser recovery storage.
  assert.doesNotMatch(circleAuth, /CIRCLE_API_KEY/);
  const recoveryStart = circleAuth.indexOf('// Gateway preparation has a distinct recovery record');
  const recoveryEnd = circleAuth.indexOf('// Durable recovery for every other Circle financial action');
  const recoverySource = circleAuth.slice(recoveryStart, recoveryEnd);
  assert.doesNotMatch(recoverySource, /refreshToken|encryptionKey/);
  assert.match(circleAuth, /storeCircleGatewayFundingRecovery\(recovery/);
  assert.match(circleAuth, /storeExternalGatewayFundingRecovery\(recovery/);

  // Gateway signing is a read/prepare/challenge flow in the browser. The
  // browser executes only the returned Circle challenge and has no transfer
  // broadcast endpoint of its own.
  const gatewayActionStart = circleActions.indexOf('export async function confirmCircleGatewayFunding');
  const gatewayActionEnd = circleActions.indexOf('// ---------------------------------------------------------------------------\n// Generic Circle financial actions', gatewayActionStart);
  const gatewayAction = circleActions.slice(gatewayActionStart, gatewayActionEnd);
  assert.match(gatewayAction, /withFreshExtremaCircleSession/);
  assert.match(gatewayAction, /executeHostedChallenge\(current\.challengeId\)/);
  assert.match(gatewayAction, /storeCircleGatewayFundingRecovery\(recovery\)/);
  assert.doesNotMatch(gatewayAction, /submitGatewayTransfer|\/v1\/transfer/);

  // Session refresh is authenticated, server-side credential-backed, and
  // refuses a rotated wallet identity. Logout revokes the durable session and
  // deletes the encrypted Circle refresh record.
  const refreshStart = circleRoutes.indexOf("router.post('/session/refresh'");
  const refresh = circleRoutes.slice(refreshStart);
  assert.match(refresh, /requireAuth/);
  assert.match(refresh, /wallet\.id !== req\.auth\.circleWalletId/);
  assert.match(refresh, /wallet\.address\.toLowerCase\(\) !== req\.auth\.walletAddress\.toLowerCase\(\)/);
  assert.match(refresh, /refresh_token_encrypted/);
  assert.match(authRoutes, /sessionService\.revokeSession\(req\.auth\.jti\)/);
  assert.match(authRoutes, /DELETE FROM circle_refresh_credentials/);

  console.log('GATEWAY_CIRCLE_MULTICHAIN_SECURITY=PASS');
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
              // Solana. Reported by Gateway, but not spendable through this
              // EVM EIP-712 signing path.
              { domain: 5, depositor: ADDRESS, balance: '3.000000' },
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
  assert.equal(result.totalRaw, '5000000');
  assert.equal(result.totalUsdc, '5.0');
  assert.equal(result.balances.length, 3);
  assert.equal(result.balances[0].balance, '1.500000');
  assert.equal(result.balances[0].balanceRaw, '1500000');

  // Arc (26) and Ethereum Sepolia (0) are both spendable now: a unified
  // balance is spendable wherever it sits, including back onto its own chain.
  // Solana (5) is reported but is not on this EVM signing path, so the
  // spendable total is deliberately smaller than the reported total.
  assert.equal(result.balances[0].domain, 26);
  assert.equal(result.balances[0].transferable, true);
  assert.equal(result.balances[1].domain, 0);
  assert.equal(result.balances[1].transferable, true);
  assert.equal(result.balances[2].domain, 5);
  assert.equal(result.balances[2].transferable, false);
  assert.equal(result.transferableTotalRaw, '2000000');
  assert.equal(result.transferableTotalUsdc, '2.0');
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
  // Gateway balance is now shared by both human execution modes: the old
  // Circle-only 409 gate is gone, and the response reports whichever mode the
  // authenticated session actually is.
  assert.equal(
    walletRoutes.includes('EXECUTION_MODES.CIRCLE_USER_WALLET) {\n      return res.status(409)'),
    false,
    'gateway-balance must no longer reject EXTERNAL_WALLET sessions',
  );
  assert.match(walletRoutes, /executionMode: req\.auth\.executionMode/);
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

  // Gateway SOURCE deposit routes (Base Sepolia approve + deposit), also
  // shared by both human execution modes.
  assert.match(walletRoutes, /router\.post\('\/gateway-deposit\/start'/);
  assert.match(walletRoutes, /router\.get\('\/gateway-deposit\/:actionId'/);
  assert.match(walletRoutes, /router\.post\('\/gateway-deposit\/:actionId\/verify-approval'/);
  assert.match(walletRoutes, /router\.post\('\/gateway-deposit\/:actionId\/verify'/);
  assert.match(walletRoutes, /gatewayDepositService\.start/);
  assert.match(walletRoutes, /gatewayDepositService\.verifyApproval/);
  assert.match(walletRoutes, /gatewayDepositService\.verifyDeposit/);
  assert.match(walletRoutes, /gatewayDepositService\.status/);

  const circleRoutes = fs.readFileSync(
    path.join(__dirname, '../src/routes/circle.js'),
    'utf8',
  );
  // The companion source wallet routes are generic over the four funding
  // sources and are addressed by Gateway domain, not by a blockchain name the
  // browser supplies.
  assert.match(circleRoutes, /router\.post\('\/wallet\/source\/:domain'/);
  assert.match(circleRoutes, /router\.post\('\/wallet\/source\/:domain\/prepare'/);
  const sourceWalletSection = circleRoutes.slice(
    circleRoutes.indexOf("router.post('/wallet/source/:domain'"),
    circleRoutes.indexOf("router.post('/session'"),
  );
  assert.match(sourceWalletSection, /requireAuth/);
  assert.match(sourceWalletSection, /req\.auth\.walletAddress/);
  assert.match(sourceWalletSection, /assertCircleSourceWalletMatchesAddress/);
  const sourceReadStart = sourceWalletSection.indexOf("router.post('/wallet/source/:domain'");
  const sourceRead = sourceWalletSection.slice(sourceReadStart, sourceWalletSection.indexOf("// Preparation creates"));
  assert.ok(
    sourceRead.indexOf('resolveSourceDomain') < sourceRead.indexOf('listEoaForBlockchain'),
    'unsupported source domains must fail before the Circle listing call',
  );
  assert.ok(
    !/arcAddress:\s*req\.body/.test(sourceWalletSection),
    'the Arc comparison address must come from the session, never the request body',
  );
  // A domain that is not a configured funding source never reaches Circle.
  assert.match(sourceWalletSection, /depositSourceForDomain|resolveSourceDomain/);
  assert.match(sourceWalletSection, /gateway_deposit_source_unsupported/);
  // The blockchain identifier comes from canonical config, never the request.
  assert.match(sourceWalletSection, /blockchain:\s*network\.circleBlockchain/);
  assert.ok(
    !/blockchain:\s*(req\.body|input\.blockchain)/.test(sourceWalletSection),
    'the Circle blockchain identifier must never come from the browser',
  );

  assert.equal(
    assertCircleSourceWalletMatchesAddress({ address: ADDRESS }, ADDRESS).address,
    ADDRESS,
  );
  assert.equal(assertCircleSourceWalletMatchesAddress(null, ADDRESS), null);
  assert.throws(
    () => assertCircleSourceWalletMatchesAddress(
      { address: '0x2222222222222222222222222222222222222222' }, ADDRESS,
    ),
    (error) => error.message === 'circle_source_address_mismatch',
  );
  assert.throws(
    () => assertCircleSourceWalletMatchesAddress({ address: 'not-an-address' }, ADDRESS),
    (error) => error.message === 'circle_source_address_mismatch',
  );
  console.log('GATEWAY_SOURCE_WALLET_SERVER_IDENTITY=PASS');

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

  // The Gateway read now covers BOTH human execution modes, superseding the
  // old Circle-only visibility rule. Its explicit state still distinguishes
  // loading, successful zero, and failure, and the UI stays visible in every
  // state, for either mode.
  assert.match(
    walletPage,
    /\(executionMode === "CIRCLE_USER_WALLET" \|\| executionMode === "EXTERNAL_WALLET"\)\s*\)\s*\{\s*void refreshGatewayBalance\(\);/,
  );
  assert.match(
    walletPage,
    /const \[gatewayReadState, setGatewayReadState\] = useState<GatewayReadState>\("idle"\);/,
  );
  assert.match(walletPage, /setGatewayReadState\("loading"\)/);
  assert.match(walletPage, /setGatewayReadState\("ready"\)/);
  assert.match(walletPage, /setGatewayReadState\("error"\)/);
  // The Gateway section itself is no longer behind any execution-mode gate.
  assert.equal(
    /\{executionMode === "CIRCLE_USER_WALLET" && \(\s*<section className="ex-wallet-gateway"/.test(walletPage),
    false,
    'the Gateway section must render unconditionally for both human modes',
  );
  assert.match(walletPage, /<section className="ex-wallet-gateway" aria-label=\{t\.wallet\.gatewayFundingAriaLabel\}>/);
  assert.match(walletPage, /aria-label=\{t\.wallet\.gatewayDepositAriaLabel\}/);
  assert.match(walletPage, /gatewayReadState === "ready" && gateway/);
  assert.match(walletPage, /gatewayBalanceUnavailable/);
  assert.match(walletPage, /gatewayRetry/);
  // Sending is gated on the SPENDABLE UNIFIED total, not on any single
  // source's balance: that is the whole point of a unified balance.
  assert.match(
    walletPage,
    /gatewayFundingRecovery\) \|\| \(\s*gatewayReadState === "ready" && hasPositiveRawAmount\(gatewaySpendableRaw\)/,
  );
  assert.match(walletPage, /const gatewaySpendableRaw = gateway\?\.transferableTotalRaw/);
  assert.match(walletPage, /t\.wallet\.gatewayNoTransferableBalance/);
  assert.equal(walletPage.includes('submitGatewayFunding'), false, 'wallet UI must not expose live broadcast control');

  // Source deposit and transfer surfaces, for both modes, driven by the
  // canonical server-side network config rather than page-local constants.
  assert.match(walletPage, /confirmGatewaySourceDeposit/);
  assert.match(walletPage, /confirmGatewayBurnSignature/);
  assert.match(walletPage, /gatewayPrepareWallet/);
  assert.match(walletPage, /gatewaySwitchNetwork/);
  // The page must not restate any chain, token or contract constant: the
  // network lists arrive from the server.
  assert.equal(
    /const GATEWAY_SOURCE_CONFIGS = \[/.test(walletPage), false,
    'the wallet page must not keep its own Gateway source table',
  );
  assert.equal(
    /0x0077777d7EBA4688BDeF3E311b846F25870A19B9|0x0022222ABE238Cc2C7Bb1f21003F0a260052475B/i.test(walletPage),
    false,
    'no Gateway contract address may appear in the wallet page',
  );
  assert.equal(
    /0x036CbD53842c5426634e7929541eC2318f3dCF7e|0x3600000000000000000000000000000000000000/i.test(walletPage),
    false,
    'no USDC token address may appear in the wallet page',
  );
  assert.equal(
    walletPage.includes('AVAX') || walletPage.includes('Avalanche'), false,
    'only the five canonical networks are ever presented',
  );

  await verifyBurnIntent();
  await verifyEstimate();
  await verifyForwardingClient();
  verifyGatewaySecurityBoundaries();

  console.log('GATEWAY_SERVICE=PASS');
  console.log('GATEWAY_ROUTE=PASS');
  console.log('GATEWAY_WALLET_UI=PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
