'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  GATEWAY_API_URL,
  readUnifiedUsdcBalance,
} = require('../src/services/gatewayService');

const ADDRESS = '0x1111111111111111111111111111111111111111';

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

  console.log('GATEWAY_SERVICE=PASS');
  console.log('GATEWAY_ROUTE=PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
