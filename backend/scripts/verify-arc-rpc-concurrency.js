'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DATABASE_URL =
  'postgres://test:test@127.0.0.1:5432/test';

process.env.ENCRYPTION_KEY =
  '0'.repeat(64);

process.env.JWT_SECRET =
  'rpc-concurrency-deterministic-verifier-secret';

process.env.ARC_RPC_READ_CONCURRENCY =
  '8';

const USER_COUNT = 100;
const READS_PER_USER = 8;
const TOTAL_READS =
  USER_COUNT * READS_PER_USER;

let active = 0;
let maxActive = 0;
let requestCount = 0;
let activeReads = 0;
let maxActiveReads = 0;
let completedReads = 0;
let writeObservedWhileReadSaturated = false;

const server = http.createServer(
  (req, res) => {
    let body = '';

    req.setEncoding('utf8');

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      active += 1;
      requestCount += 1;

      maxActive =
        Math.max(maxActive, active);

      try {
        const payload =
          JSON.parse(body);

        const isRead =
          payload.method === 'eth_blockNumber';

        if (isRead) {
          activeReads += 1;
          maxActiveReads =
            Math.max(
              maxActiveReads,
              activeReads,
            );

          // Keep read requests alive so the bounded queue is saturated.
          await new Promise(resolve => {
            setTimeout(resolve, 30);
          });
        }

        let result;

        switch (payload.method) {
          case 'eth_chainId':
            result = '0x4cef52';
            break;

          case 'net_version':
            writeObservedWhileReadSaturated =
              activeReads === 8 &&
              completedReads < TOTAL_READS;

            result = '5042002';
            break;

          case 'eth_blockNumber':
            result = '0x3a98ac0';
            break;

          default:
            res.statusCode = 200;
            res.setHeader(
              'content-type',
              'application/json',
            );

            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: payload.id,
                error: {
                  code: -32601,
                  message:
                    `unsupported:${payload.method}`,
                },
              }),
            );

            return;
        }

        res.statusCode = 200;

        res.setHeader(
          'content-type',
          'application/json',
        );

        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result,
          }),
        );
      } finally {
        try {
          const payload =
            JSON.parse(body);

          if (
            payload.method ===
            'eth_blockNumber'
          ) {
            activeReads -= 1;
            completedReads += 1;
          }
        } catch {}

        active -= 1;
      }
    });
  },
);

async function listen() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);

    server.listen(
      0,
      '127.0.0.1',
      resolve,
    );
  });

  const address =
    server.address();

  return (
    `http://127.0.0.1:${address.port}`
  );
}

async function close() {
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function main() {
  const url =
    await listen();

  // Same URL deliberately disables fallback for this test.
  // We are measuring one endpoint's queue in isolation.
  process.env.ARC_TESTNET_RPC_URL =
    url;

  process.env.ARC_TESTNET_RPC_FALLBACK_URL =
    url;

  const {
    getArcReadProvider,
    getArcRpcConfiguration,
  } = require(
    '../src/services/arcRpcProviderService'
  );

  const configuration =
    getArcRpcConfiguration();

  assert.equal(
    configuration.readConcurrencyPerEndpoint,
    8,
  );

  assert.equal(
    configuration.fallbackEnabled,
    false,
  );

  const provider =
    getArcReadProvider();

  const users =
    Array.from(
      { length: USER_COUNT },
      (_, userIndex) =>
        Promise.all(
          Array.from(
            { length: READS_PER_USER },
            (_, readIndex) =>
              provider.send(
                'eth_blockNumber',
                [],
              ).then(result => ({
                userIndex,
                readIndex,
                result,
              })),
          ),
        ),
    );

  const readWork =
    Promise.all(users);

  // Wait until all 8 read slots are genuinely occupied.
  const deadline =
    Date.now() + 2_000;

  while (
    activeReads < 8 &&
    Date.now() < deadline
  ) {
    await new Promise(resolve => {
      setTimeout(resolve, 5);
    });
  }

  assert.equal(
    activeReads,
    8,
    'read queue did not reach configured saturation',
  );

  // This uses the separate primary-only provider. It must not wait
  // behind the 792 queued read requests.
  const {
    getArcWriteProvider,
  } = require(
    '../src/services/arcRpcProviderService'
  );

  const writeSideResult =
    await getArcWriteProvider().send(
      'net_version',
      [],
    );

  assert.equal(
    writeSideResult,
    '5042002',
  );

  assert.equal(
    writeObservedWhileReadSaturated,
    true,
    'write provider was blocked behind read queue',
  );

  const results =
    await readWork;

  assert.equal(
    results.length,
    USER_COUNT,
  );

  assert.equal(
    results.flat().length,
    TOTAL_READS,
  );

  assert.equal(
    results
      .flat()
      .every(
        item =>
          item.result === '0x3a98ac0',
      ),
    true,
  );

  assert.equal(
    completedReads,
    TOTAL_READS,
    'all simulated RPC reads must complete',
  );

  assert.equal(
    requestCount,
    TOTAL_READS + 1,
    '800 reads plus one write-provider probe expected',
  );

  assert.equal(
    maxActiveReads <= 8,
    true,
    `RPC read concurrency exceeded limit: ${maxActiveReads}`,
  );

  assert.equal(
    maxActive > 1,
    true,
    'test did not generate real concurrency',
  );

  console.log(
    'ARC_RPC_100_USER_READ_QUEUE=PASS',
  );

  console.log(
    `USERS=${USER_COUNT}`,
  );

  console.log(
    `SIMULATED_READS=${TOTAL_READS}`,
  );

  console.log(
    `MAX_ACTIVE_READ_REQUESTS=${maxActiveReads}`,
  );

  console.log(
    `MAX_ACTIVE_TOTAL_REQUESTS=${maxActive}`,
  );

  console.log(
    'RPC_READ_CONCURRENCY_LIMIT=8',
  );

  console.log(
    'ARC_RPC_WRITE_BYPASSES_READ_QUEUE=PASS',
  );
}

main()
  .catch(error => {
    console.error(
      `ARC_RPC_100_USER_READ_QUEUE=FAIL ${error.stack || error}`,
    );

    process.exitCode = 1;
  })
  .finally(close);
