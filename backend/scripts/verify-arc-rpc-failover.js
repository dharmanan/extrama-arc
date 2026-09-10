'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL =
  'postgres://test:test@127.0.0.1:5432/test';

process.env.ENCRYPTION_KEY =
  '0'.repeat(64);

process.env.JWT_SECRET =
  'rpc-failover-deterministic-verifier-secret';

const CHAIN_ID = 5042002;
const CHAIN_ID_HEX =
  `0x${CHAIN_ID.toString(16)}`;

function createRpcServer({
  blockNumber,
  callResult,
  healthy = true,
}) {
  const state = {
    healthy,
    requests: 0,
    methods: [],
  };

  const server =
    http.createServer((req, res) => {
      let body = '';

      req.setEncoding('utf8');

      req.on('data', chunk => {
        body += chunk;
      });

      req.on('end', () => {
        state.requests += 1;

        let payload;

        try {
          payload = JSON.parse(body);
        } catch {
          res.statusCode = 400;
          res.end('invalid json');
          return;
        }

        const requests =
          Array.isArray(payload)
            ? payload
            : [payload];

        for (const item of requests) {
          state.methods.push(
            item.method,
          );
        }

        if (!state.healthy) {
          res.statusCode = 503;
          res.setHeader(
            'content-type',
            'application/json',
          );

          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: requests[0]?.id ?? null,
              error: {
                code: -32005,
                message:
                  'simulated primary RPC transport failure',
              },
            }),
          );

          return;
        }

        const reply = item => {
          let result;

          switch (item.method) {
            case 'eth_chainId':
              result = CHAIN_ID_HEX;
              break;

            case 'net_version':
              result = String(CHAIN_ID);
              break;

            case 'eth_blockNumber':
              result = blockNumber;
              break;

            case 'eth_call':
              result = callResult;
              break;

            default:
              return {
                jsonrpc: '2.0',
                id: item.id,
                error: {
                  code: -32601,
                  message:
                    `unsupported:${item.method}`,
                },
              };
          }

          return {
            jsonrpc: '2.0',
            id: item.id,
            result,
          };
        };

        const response =
          Array.isArray(payload)
            ? requests.map(reply)
            : reply(requests[0]);

        res.statusCode = 200;
        res.setHeader(
          'content-type',
          'application/json',
        );
        res.end(
          JSON.stringify(response),
        );
      });
    });

  return {
    server,
    state,

    async listen() {
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

      return `http://127.0.0.1:${address.port}`;
    },

    async close() {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

async function main() {
  const primary =
    createRpcServer({
      blockNumber: '0x111',
      callResult: '0xaaaaaaaa',
      healthy: false,
    });

  const fallback =
    createRpcServer({
      blockNumber: '0x222',
      callResult: '0xdeadbeef',
      healthy: true,
    });

  try {
    const primaryUrl =
      await primary.listen();

    const fallbackUrl =
      await fallback.listen();

    process.env.ARC_TESTNET_RPC_URL =
      primaryUrl;

    process.env.ARC_TESTNET_RPC_FALLBACK_URL =
      fallbackUrl;

    const {
      getArcReadProvider,
      getArcWriteProvider,
      getArcRpcConfiguration,
    } = require(
      '../src/services/arcRpcProviderService'
    );

    const config =
      getArcRpcConfiguration();

    assert.equal(
      config.chainId,
      CHAIN_ID,
    );

    assert.equal(
      config.primaryRpcUrl,
      primaryUrl,
    );

    assert.equal(
      config.fallbackRpcUrl,
      fallbackUrl,
    );

    assert.equal(
      config.fallbackEnabled,
      true,
    );

    /* --------------------------------------------------------
       Primary fails. An eth_call must be served by fallback.
       This mirrors the class of read that getRound uses.
       -------------------------------------------------------- */

    const readProvider =
      getArcReadProvider();

    const callResult =
      await readProvider.call({
        to:
          '0x0000000000000000000000000000000000000001',
        data: '0x12345678',
      });

    assert.equal(
      callResult,
      '0xdeadbeef',
      'read falls back when primary RPC fails',
    );

    assert.equal(
      primary.state.requests > 0,
      true,
      'primary was attempted',
    );

    assert.equal(
      fallback.state.methods.includes(
        'eth_call',
      ),
      true,
      'fallback served the contract read',
    );

    /* --------------------------------------------------------
       Make primary healthy again. The WRITE provider must talk
       directly to primary and never route through fallback.
       -------------------------------------------------------- */

    primary.state.healthy = true;

    const fallbackBefore =
      fallback.state.requests;

    const primaryBefore =
      primary.state.requests;

    const writeProvider =
      getArcWriteProvider();

    const writeSideRead =
      await writeProvider.send(
        'eth_blockNumber',
        [],
      );

    assert.equal(
      writeSideRead,
      '0x111',
      'write provider is the primary endpoint',
    );

    assert.equal(
      primary.state.requests >
        primaryBefore,
      true,
      'primary received write-provider traffic',
    );

    assert.equal(
      fallback.state.requests,
      fallbackBefore,
      'write provider never touched fallback',
    );

    /* --------------------------------------------------------
       Static wiring guards.
       -------------------------------------------------------- */

    const root =
      path.resolve(__dirname, '..');

    const automationSource =
      fs.readFileSync(
        path.join(
          root,
          'src/services/roundAutomationService.js',
        ),
        'utf8',
      );

    const arcSource =
      fs.readFileSync(
        path.join(
          root,
          'src/services/arcService.js',
        ),
        'utf8',
      );

    assert.match(
      automationSource,
      /function getAutomationProvider\(\)[\s\S]*?return getArcReadProvider\(\)/,
    );

    assert.equal(
      (
        automationSource.match(
          /getResolverSigner\(getArcWriteProvider\(\)\)/g,
        ) || []
      ).length,
      2,
      'resolver signer remains pinned to primary RPC',
    );

    assert.match(
      automationSource,
      /new ethers\.Wallet\([\s\S]{0,200}?getArcWriteProvider\(\)/,
    );

    assert.match(
      arcSource,
      /function getProvider\(\)[\s\S]*?return getArcReadProvider\(\)/,
    );

    for (const source of [
      automationSource,
      arcSource,
    ]) {
      assert.match(
        source,
        /ETIMEDOUT/,
        'raw ETIMEDOUT is classified as transient read failure',
      );
    }

    console.log(
      'ARC_RPC_FAILOVER=PASS',
    );

    console.log(
      'ARC_RPC_WRITE_PRIMARY_ONLY=PASS',
    );

    console.log(
      'ARC_RPC_ETIMEDOUT_CLASSIFICATION=PASS',
    );
  } finally {
    await primary.close();
    await fallback.close();
  }
}

main().catch(error => {
  console.error(
    `ARC_RPC_FAILOVER=FAIL ${error.stack || error}`,
  );

  process.exitCode = 1;
});
