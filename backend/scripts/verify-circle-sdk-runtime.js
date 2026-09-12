'use strict';

// circleUserWalletService loads backend config at require-time.
// These values satisfy validation only; this smoke never opens a DB connection
// and never calls Circle's network.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://smoke:smoke@127.0.0.1:1/smoke';
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'circle-sdk-runtime-smoke-jwt-secret-00000000';

const assert = require('node:assert/strict');
const http = require('node:http');
const { ethers } = require('ethers');
const {
  initiateUserControlledWalletsClient,
} = require('@circle-fin/user-controlled-wallets');
const {
  buildCircleTypedDataWirePayload,
  createCircleUserWalletService,
  matchesContractExecutionTransaction,
  matchesFetchedContractExecutionTransaction,
} = require('../src/services/circleUserWalletService');
const { buildGatewayBurnIntent } = require('../src/services/gatewayService');
const { hashPayload } = require('../src/services/gatewayFundingService');

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
const REF_ID = '22222222-2222-4222-8222-222222222222:approval';
const CONTRACT = '0x3600000000000000000000000000000000000000';
const TX_ID = '33333333-3333-4333-8333-333333333333';
const TX_HASH = `0x${'a'.repeat(64)}`;
const CHALLENGE_ID = '44444444-4444-4444-8444-444444444444';
const USER_TOKEN = 'circle-user-token-long-enough-for-runtime-smoke';

async function verifyGatewayCircleWirePayload() {
  const built = buildGatewayBurnIntent({
    walletAddress: '0x1111111111111111111111111111111111111111',
    sourceDomain: 6,
    destinationDomain: 26,
    valueRaw: '1000000',
    maxFeeRaw: '10000',
    maxBlockHeight: '999999999',
    salt: `0x${'ab'.repeat(32)}`,
  });
  const internalTypes = JSON.parse(JSON.stringify(built.typedData.types));
  const internalDomain = JSON.parse(JSON.stringify(built.typedData.domain));
  const digestBefore = ethers.TypedDataEncoder.hash(
    built.typedData.domain, built.typedData.types, built.typedData.message,
  );
  const payload = {
    destinationDomain: 26,
    valueRaw: '1000000',
    allocations: [{ sourceDomain: 6, valueRaw: '1000000' }],
    burnIntents: [built.burnIntent],
  };
  const payloadHashBefore = hashPayload(payload);

  const wire = buildCircleTypedDataWirePayload(built.typedData);
  const expectedDomainDeclaration = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
  ];
  assert.deepEqual(wire.types.EIP712Domain, expectedDomainDeclaration);
  assert.deepEqual(wire.domain, internalDomain);
  assert.deepEqual(built.typedData.types, internalTypes);
  assert.deepEqual(built.typedData.domain, internalDomain);
  const extendedWire = buildCircleTypedDataWirePayload({
    ...built.typedData,
    domain: {
      ...built.typedData.domain,
      chainId: 11155111,
      verifyingContract: '0x2222222222222222222222222222222222222222',
      salt: `0x${'cd'.repeat(32)}`,
    },
  });
  assert.deepEqual(extendedWire.types.EIP712Domain, [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ]);
  const digestAfter = ethers.TypedDataEncoder.hash(
    built.typedData.domain, built.typedData.types, built.typedData.message,
  );
  const payloadHashAfter = hashPayload({
    ...payload,
    burnIntents: [wire.message],
  });
  assert.equal(digestAfter, digestBefore);
  assert.equal(payloadHashAfter, payloadHashBefore);
  console.log('GATEWAY_CIRCLE_WIRE_EIP712_DOMAIN=PASS');
  console.log('GATEWAY_CIRCLE_WIRE_DOMAIN_MATCH=PASS');
  console.log('GATEWAY_CIRCLE_WIRE_DIGEST_PRESERVED=PASS');
  console.log('GATEWAY_CIRCLE_WIRE_INTERNAL_TYPES_UNCHANGED=PASS');

  assert.throws(
    () => buildCircleTypedDataWirePayload({
      ...built.typedData,
      domain: { ...built.typedData.domain, privateKey: 'must-not-cross-the-wire' },
    }),
    (error) => error?.message === 'circle_typed_data_invalid',
  );
  assert.throws(
    () => buildCircleTypedDataWirePayload({
      ...built.typedData,
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }],
        ...built.typedData.types,
      },
    }),
    (error) => error?.message === 'circle_typed_data_invalid',
  );
  const matchingDeclaration = buildCircleTypedDataWirePayload({
    ...built.typedData,
    types: { EIP712Domain: expectedDomainDeclaration, ...built.typedData.types },
  });
  assert.deepEqual(matchingDeclaration.types.EIP712Domain, expectedDomainDeclaration);
  console.log('GATEWAY_CIRCLE_WIRE_UNKNOWN_DOMAIN_FAILS_CLOSED=PASS');

  let sent;
  const service = createCircleUserWalletService({
    apiKey: 'TEST_API_KEY',
    client: {
      async signTypedData(input) {
        sent = input;
        return { data: { challengeId: CHALLENGE_ID } };
      },
      async getUserChallenge() {
        return { data: { challenge: { id: CHALLENGE_ID, status: 'FAILED', type: 'SIGN_TYPEDDATA' } } };
      },
    },
  });
  await service.createTypedDataChallenge({
    userToken: USER_TOKEN,
    walletId: WALLET_ID,
    typedData: built.typedData,
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
  });
  assert.deepEqual(JSON.parse(sent.data), wire);

  const diagnosticClient = {
    async getUserChallenge() {
      return {
        data: {
          challenge: {
            id: CHALLENGE_ID,
            status: 'FAILED',
            type: 'SIGN_TYPEDDATA',
            errorCode: 156026,
            errorMessage: 'error: there is extra data provided in the message (0 < 2)',
          },
        },
      };
    },
  };
  const diagnosticService = createCircleUserWalletService({
    apiKey: 'TEST_API_KEY', client: diagnosticClient,
  });
  const diagnostic = await diagnosticService.getTypedDataChallenge({
    userToken: USER_TOKEN, challengeId: CHALLENGE_ID,
  });
  assert.equal(diagnostic.errorCode, 156026);
  assert.equal(diagnostic.errorMessage, 'error: there is extra data provided in the message (0 < 2)');
  assert.ok(diagnostic.errorMessage.length <= 300);

  diagnosticClient.getUserChallenge = async () => ({
    data: {
      challenge: {
        id: CHALLENGE_ID, status: 'FAILED', type: 'SIGN_TYPEDDATA',
        errorCode: 155000, errorMessage: 'generic signature failure',
      },
    },
  });
  const generic = await diagnosticService.getTypedDataChallenge({
    userToken: USER_TOKEN, challengeId: CHALLENGE_ID,
  });
  assert.equal(generic.errorCode, 155000);
  assert.equal(generic.errorMessage, 'generic signature failure');
  console.log('GATEWAY_CIRCLE_TYPED_DATA_FAILURE_DIAGNOSTICS=PASS');
}

async function main() {
  await verifyGatewayCircleWirePayload();
  assert.equal(
    matchesFetchedContractExecutionTransaction(
      {
        walletId: WALLET_ID,
        blockchain: 'ARC-TESTNET',
      },
      { walletId: WALLET_ID, refId: REF_ID, contractAddress: CONTRACT },
    ),
    true,
    'exact transaction ID fetch may omit optional refId and contractAddress',
  );

  assert.equal(
    matchesFetchedContractExecutionTransaction(
      {
        walletId: WALLET_ID,
        blockchain: 'ARC-TESTNET',
        refId: 'wrong-ref',
      },
      { walletId: WALLET_ID, refId: REF_ID, contractAddress: CONTRACT },
    ),
    false,
    'a present but wrong refId must still be rejected',
  );

  assert.equal(
    matchesContractExecutionTransaction(
      {
        walletId: WALLET_ID,
        blockchain: 'ARC-TESTNET',
        refId: REF_ID,
      },
      { walletId: WALLET_ID, refId: REF_ID, contractAddress: CONTRACT },
    ),
    true,
    'optional Circle contractAddress must not block an otherwise exact match',
  );

  assert.equal(
    matchesContractExecutionTransaction(
      {
        walletId: WALLET_ID,
        blockchain: 'ARC-TESTNET',
        refId: REF_ID,
        contractAddress: '0x1000000000000000000000000000000000000001',
      },
      { walletId: WALLET_ID, refId: REF_ID, contractAddress: CONTRACT },
    ),
    false,
    'a present but wrong Circle contractAddress must still be rejected',
  );

  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      headers: req.headers,
    });

    res.writeHead(200, { 'content-type': 'application/json' });

    if (req.url.includes('/challenges/')) {
      res.end(JSON.stringify({
        data: {
          challenge: {
            id: CHALLENGE_ID,
            correlationIds: [TX_ID],
            status: 'COMPLETE',
            type: 'CONTRACT_EXECUTION',
          },
        },
      }));
      return;
    }

    res.end(JSON.stringify({
      data: {
        transactions: [{
          id: TX_ID,
          walletId: WALLET_ID,
          blockchain: 'ARC-TESTNET',
          refId: REF_ID,
          txHash: TX_HASH,
          state: 'CONFIRMED',
        }],
      },
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, 'object');

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const sdkClient = initiateUserControlledWalletsClient({
      apiKey: 'TEST_API_KEY',
      baseUrl,
    });

    const service = createCircleUserWalletService({
      apiKey: 'TEST_API_KEY',
      client: sdkClient,
    });

    const transaction = await service.findContractExecutionTransaction({
      userToken: USER_TOKEN,
      walletId: WALLET_ID,
      refId: REF_ID,
      contractAddress: CONTRACT,
    });

    assert.equal(transaction?.id, TX_ID);
    assert.equal(transaction?.txHash, TX_HASH);
    assert.equal(requests.length, 1);

    const requestUrl = new URL(requests[0].url, baseUrl);

    assert.equal(requestUrl.pathname, '/v1/w3s/transactions');
    assert.equal(requestUrl.searchParams.get('walletIds'), WALLET_ID);
    assert.equal(requestUrl.searchParams.get('pageSize'), '50');
    assert.equal(requestUrl.searchParams.get('order'), 'DESC');
    assert.equal(requestUrl.searchParams.has('blockchain'), false);
    assert.equal(requestUrl.searchParams.has('operation'), false);
    assert.equal(requests[0].headers['x-user-token'], USER_TOKEN);

    const challenge = await service.getContractExecutionChallenge({
      userToken: USER_TOKEN,
      challengeId: CHALLENGE_ID,
    });

    assert.equal(challenge?.id, CHALLENGE_ID);
    assert.equal(challenge?.status, 'COMPLETE');
    assert.equal(challenge?.type, 'CONTRACT_EXECUTION');
    assert.equal(challenge?.transactionId, TX_ID);
    assert.equal(requests.length, 2);

    const challengeRequestUrl = new URL(requests[1].url, baseUrl);

    assert.ok(
      challengeRequestUrl.pathname.endsWith(`/challenges/${CHALLENGE_ID}`),
    );
    assert.equal(requests[1].headers['x-user-token'], USER_TOKEN);

    console.log('CIRCLE_SDK_RUNTIME=PASS');
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
