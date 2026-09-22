'use strict';

// Deterministic, transaction-free proof for Arc's one-economic-USDC model.
// This script uses only local source and pure service builders. It never
// creates a provider connection, calls Arc/Circle, or touches Postgres.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'verify-one-usdc-asset-only-secret';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.ARC_TESTNET_RPC_URL = 'http://127.0.0.1:1';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const arcService = require('../src/services/arcService');
const externalEntry = require('../src/services/externalEntryExecutionService');

const ROOT = path.resolve(__dirname, '..', '..');
const POOL = arcService.ARC_POOL_TOPOLOGY[0];
const WALLET = '0x1000000000000000000000000000000000000001';
const ATTACKER = '0x2000000000000000000000000000000000000002';
const STAKE_RAW = 1_000_000n;
const NATIVE_ONE_USDC_RAW = 1_000_000_000_000_000_000n;
const ROUND_START = 1_893_456_000n; // 2030-01-01T00:00:00Z
const ROUND_CLOSE = ROUND_START + 86_400n - 14_400n;
const ROUND = {
  entryOpenAt: ROUND_START,
  entryCloseAt: ROUND_CLOSE,
  observationStartAt: ROUND_CLOSE,
  observationEndAt: ROUND_START + 86_400n,
  status: 0,
};

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function collectRuntimeSource(directory) {
  const absolute = path.join(ROOT, directory);
  const chunks = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      chunks.push(collectRuntimeSource(relative));
    } else if (/\.(?:js|ts|tsx)$/.test(entry.name)) {
      chunks.push(source(relative));
    }
  }
  return chunks.join('\n');
}

function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => error?.message === code);
}

async function main() {
  // 18 native decimals -> 6 ERC-20 decimals, with conservative integer floor.
  assert.equal(arcService.ARC_NATIVE_TO_ERC20_SCALE, 1_000_000_000_000n);
  assert.equal(
    arcService.nativeUsdcRawToErc20Raw(NATIVE_ONE_USDC_RAW),
    STAKE_RAW,
  );
  assert.equal(
    arcService.nativeUsdcRawToErc20Raw(NATIVE_ONE_USDC_RAW + 999_999_999_999n),
    STAKE_RAW,
  );
  assertThrowsCode(() => arcService.nativeUsdcRawToErc20Raw(-1n), 'native_usdc_balance_invalid');
  assertThrowsCode(() => arcService.nativeUsdcRawToErc20Raw('not-an-integer'), 'native_usdc_balance_invalid');

  const payload = {
    action: 'ENTRY',
    chainId: Number(arcService.ARC_TESTNET_CHAIN_ID),
    executionMode: 'EXTERNAL_WALLET',
    contract: POOL.poolAddress,
    destination: POOL.poolAddress,
    walletAddress: WALLET,
    roundId: 7,
    predictionPriceCents: 123_456,
    amountRaw: STAKE_RAW.toString(),
    nonce: 'one-usdc-asset-nonce-1234',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  const baseState = {
    network: { chainId: arcService.ARC_TESTNET_CHAIN_ID },
    walletAddress: ethers.getAddress(WALLET),
    poolAddress: ethers.getAddress(POOL.poolAddress),
    usdcAddress: ethers.getAddress(arcService.ARC_TESTNET_USDC_ADDRESS),
    ticketAddress: ethers.getAddress(POOL.ticketAddress),
    round: ROUND,
    chainTimestamp: ROUND_START + 3_600n,
    hasEntered: false,
    predictionTaken: false,
    balance: STAKE_RAW + 25_000n,
    allowance: 0n,
    // Positive native-interface balance represents fee availability from the
    // same USDC asset; it is intentionally not added to `balance`.
    nativeUsdcGasBalance: NATIVE_ONE_USDC_RAW,
  };

  const approval = await externalEntry.prepareExternalEntry(payload, {
    readLiveState: async () => ({ ...baseState }),
  });
  assert.equal(approval.step, 'APPROVAL_REQUIRED');
  assert.equal(approval.transactionRequest.from, ethers.getAddress(WALLET));
  assert.equal(approval.transactionRequest.to, ethers.getAddress(arcService.ARC_TESTNET_USDC_ADDRESS));
  const usdcInterface = new ethers.Interface([
    'function approve(address spender,uint256 amount)',
  ]);
  const approvalDecoded = usdcInterface.decodeFunctionData('approve', approval.transactionRequest.data);
  assert.equal(ethers.getAddress(approvalDecoded.spender), ethers.getAddress(POOL.poolAddress));
  assert.equal(approvalDecoded.amount, STAKE_RAW);

  const ready = await externalEntry.prepareExternalEntry(payload, {
    readLiveState: async () => ({ ...baseState, allowance: STAKE_RAW }),
  });
  assert.equal(ready.step, 'ENTRY_READY');
  const poolInterface = new ethers.Interface([
    'function enterPrediction(uint256 roundId,uint64 predictionPriceCents)',
  ]);
  const entryDecoded = poolInterface.decodeFunctionData('enterPrediction', ready.transactionRequest.data);
  assert.equal(entryDecoded.roundId, 7n);
  assert.equal(entryDecoded.predictionPriceCents, 123_456n);
  assert.equal(ready.transactionRequest.value, '0x0');

  await assert.rejects(
    () => externalEntry.prepareExternalEntry(
      { ...payload, walletAddress: ATTACKER, destination: POOL.poolAddress },
      { readLiveState: async () => ({ ...baseState }) },
    ),
    (error) => error?.message === 'entry_wallet_mismatch',
  );
  await assert.rejects(
    () => externalEntry.prepareExternalEntry(
      payload,
      { readLiveState: async () => ({ ...baseState, nativeUsdcGasBalance: 0n }) },
    ),
    (error) => error?.message === 'entry_insufficient_gas',
  );

  const arcServiceSource = source('backend/src/services/arcService.js');
  assert.match(arcServiceSource, /nativeUsdcGasInterface/);
  assert.doesNotMatch(arcServiceSource, /\n\s+native:\s*\{/);
  const backendApiSource = source('app/lib/backend-api.ts');
  assert.match(backendApiSource, /nativeUsdcGasInterface/);
  assert.doesNotMatch(backendApiSource, /\n\s+native:\s*\{/);

  const walletPage = source('app/wallet/page.tsx');
  assert.equal((walletPage.match(/chainState\.usdc\.balanceFormatted/g) || []).length, 1);
  assert.doesNotMatch(walletPage, /chainState\.native\b/);
  assert.doesNotMatch(walletPage, /native gas|gas token|ETH balance/i);

  const i18n = source('app/i18n.tsx');
  assert.doesNotMatch(i18n, /Native gas balance|Native gas bakiyesi|gas balance to send/i);
  assert.match(i18n, /Not enough USDC to cover this transaction and its network fee/);
  assert.match(i18n, /Bu işlem ve ağ ücreti için yeterli USDC yok/);

  const executionSources = [
    source('backend/src/services/entryExecutionService.js'),
    source('backend/src/services/externalEntryExecutionService.js'),
    source('backend/src/services/marketplaceExecutionService.js'),
    source('backend/src/services/refundExecutionService.js'),
    source('backend/src/services/claimExecutionService.js'),
    source('backend/src/services/seedBotCore.js'),
    source('backend/src/services/seedBotExecutionService.js'),
  ].join('\n');
  assert.doesNotMatch(executionSources, /(?:nativeBalance|nativeRaw|nativeUsdcRaw|nativeUsdcGasBalance)\s*\+\s*(?:usdc|balance|walletUsdc)/i);
  assert.doesNotMatch(executionSources, /(?:usdc|balance|walletUsdc)\s*\+\s*(?:nativeBalance|nativeRaw|nativeUsdcRaw|nativeUsdcGasBalance)/i);

  const marketplaceSource = source('backend/src/services/marketplaceExecutionService.js');
  assert.match(marketplaceSource, /approve', \[marketplaceAddress, expectedAskUsdc\]/);
  assert.match(marketplaceSource, /usdcBalance < expectedAskUsdc/);
  assert.doesNotMatch(marketplaceSource, /usdcBalance !== expectedAskUsdc/);
  const refundSource = source('backend/src/services/refundExecutionService.js');
  assert.match(refundSource, /const REFUND_AMOUNT_RAW = 1_000_000n/);
  assert.match(refundSource, /parsed\.args\.value === REFUND_AMOUNT_RAW/);
  const claimSource = source('backend/src/services/claimExecutionService.js');
  assert.match(claimSource, /parsed\.args\.value === amount/);
  assert.match(claimSource, /claimableRaw/);

  const readme = source('README.md');

  // Documentation verification is semantic rather than coupled to one
  // exact heading or sentence. The README must preserve the actual Arc
  // one-USDC accounting model.
  assert.match(
    readme,
    /USDC is both the application currency and the native gas currency/i,
  );
  assert.match(
    readme,
    /same underlying USDC through two technical interfaces/i,
  );
  assert.match(
    readme,
    /Native USDC\s*\|\s*18\s*\|/i,
  );
  assert.match(
    readme,
    /ERC-20 USDC\s*\|\s*6\s*\|/i,
  );
  assert.match(
    readme,
    /never adds them together/i,
  );
  assert.match(
    readme,
    /Application accounting uses the 6 decimal ERC-20 interface/i,
  );
  assert.match(
    readme,
    /Native balance reads are used only where EVM gas semantics require them/i,
  );

  const activeRuntime = `${collectRuntimeSource('backend/src')}\n${collectRuntimeSource('app')}`;
  const count = (pattern) => (activeRuntime.match(pattern) || []).length;
  assert.equal(count(/passkey|webauthn/gi), 0);
  assert.equal(count(/BACKEND_WALLET/g), 0);
  assert.equal(count(/UNSUPPORTED_BY_DESIGN/g), 0);
  assert.equal(count(/circle_wallet_not_configured/g), 0);

  console.log('ONE_USDC_ASSET=PASS');
  console.log('ONE_USDC_DECIMAL_CONVERSION=PASS');
  console.log('ONE_USDC_ENTRY_STAKE_AND_FEE_BOUNDARIES=PASS');
  console.log('ONE_USDC_API_UI_SINGLE_CANONICAL_BALANCE=PASS');
  console.log('ONE_USDC_NO_NATIVE_ERC20_SUM=PASS');
  console.log('ACTIVE_RUNTIME_PASSKEY_COUNT=0');
  console.log('ACTIVE_RUNTIME_BACKEND_WALLET_HUMAN_COUNT=0');
  console.log('CIRCLE_UNSUPPORTED_BY_DESIGN_COUNT=0');
  console.log('CIRCLE_WALLET_NOT_CONFIGURED_COUNT=0');
}

main().catch((error) => {
  console.error(`ONE_USDC_ASSET=FAIL ${error?.stack || error}`);
  process.exitCode = 1;
});
