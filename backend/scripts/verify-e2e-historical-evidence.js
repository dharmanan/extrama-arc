'use strict';

// Layer 1: historical evidence reconciliation.
//
// Every fact this script checks is either permanent (a mined transaction's
// receipt never changes) or structural (factory/ticket wiring that cannot
// legitimately change without a redeploy). Unlike a round's entry count or
// trading window, none of this drifts as live rounds progress, so this script
// stays deterministic indefinitely -- it only ever performs eth_getTransactionReceipt
// / eth_call reads against Arc Testnet. It never sends a transaction and never
// needs a private key.
//
// Uses plain fetch() + ethers' pure ABI coder (no networking inside ethers
// itself) instead of ethers.JsonRpcProvider: the provider's own fetch layer
// timed out against this RPC endpoint in this environment even though a raw
// fetch()/curl to the same endpoint succeeds immediately.

const assert = require('node:assert/strict');
const { Interface, AbiCoder, getAddress, ZeroAddress } = require('ethers');

const ARC_RPC = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.network';
const ARC_CHAIN_ID = '0x4cef52'; // 5_042_002
const FACTORY = '0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A';
const USDC = '0x3600000000000000000000000000000000000000';

const FACTORY_IFACE = new Interface(['function isRegisteredPool(address pool) view returns (bool)']);
const POOL_IFACE = new Interface([
  'function TICKET() view returns (address)',
  'function USDC() view returns (address)',
]);
const TICKET_IFACE = new Interface([
  'function ownerOf(uint256) view returns (address)',
  'function MINTER() view returns (address)',
]);

// Historical Arc Testnet fixtures mirrored by
// contracts/test/ExtremaMarketplaceArcFork.t.sol. Only public identifiers.
const HISTORICAL_LOCK_RECEIPTS = [
  {
    label: 'ETH Daily High Round #1 lockRound',
    txHash: '0x0b9f2de2fa221a734b7877904c71348bc7eaf16845ed88fe215c93c2d00644a7',
    expectedTo: '0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f',
    expectedBlock: 60_637_750,
  },
  {
    label: 'ETH Daily Low Round #1 lockRound',
    txHash: '0xac32dde62e060f5fadbb5384ee6fcc528c2828d9637b9e7fb700639d20529219',
    expectedTo: '0x490A5CE02E3fd85d51095A69AAE9511552d91095',
    expectedBlock: 60_638_205,
  },
];

const LIVE_POOL = '0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f';
const LIVE_TICKET_ID = 4;

let requestId = 0;

// Bounded retry for transient transport failures only, mirroring
// arcService.js's rpcRead() convention. This environment's fetch to the Arc
// RPC has been observed to intermittently fail (connection-reset style) even
// though the endpoint itself is reachable via curl/plain fetch moments
// apart -- retrying a read is safe and never resends anything.
async function withTransientRetry(operation, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
      const delayMs = Math.min(4000, 250 * (2 ** attempt)) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function rpc(method, params) {
  return withTransientRetry(async () => {
    requestId += 1;
    const response = await fetch(ARC_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
    return body.result;
  });
}

async function ethCall(to, data) {
  return rpc('eth_call', [{ to, data }, 'latest']);
}

async function main() {
  const chainId = await rpc('eth_chainId', []);
  assert.equal(chainId, ARC_CHAIN_ID, 'Arc Testnet chain id must match the canonical value');

  for (const fixture of HISTORICAL_LOCK_RECEIPTS) {
    const receipt = await rpc('eth_getTransactionReceipt', [fixture.txHash]);
    assert.ok(receipt, `${fixture.label}: receipt must still be retrievable (${fixture.txHash})`);
    assert.equal(receipt.status, '0x1', `${fixture.label}: transaction must have succeeded`);
    assert.equal(
      Number(receipt.blockNumber),
      fixture.expectedBlock,
      `${fixture.label}: block number must match recorded evidence`,
    );
    assert.equal(
      getAddress(receipt.to),
      getAddress(fixture.expectedTo),
      `${fixture.label}: recipient pool address must match recorded evidence`,
    );
    console.log(`HISTORICAL_EVIDENCE[${fixture.label}]=PASS block=${Number(receipt.blockNumber)}`);
  }

  const isRegisteredResult = FACTORY_IFACE.decodeFunctionResult(
    'isRegisteredPool',
    await ethCall(FACTORY, FACTORY_IFACE.encodeFunctionData('isRegisteredPool', [LIVE_POOL])),
  );
  assert.equal(isRegisteredResult[0], true, 'the fork-test fixture pool must remain factory-registered');

  const ticketAddress = getAddress(
    POOL_IFACE.decodeFunctionResult('TICKET', await ethCall(LIVE_POOL, POOL_IFACE.encodeFunctionData('TICKET', [])))[0],
  );
  const poolUsdc = getAddress(
    POOL_IFACE.decodeFunctionResult('USDC', await ethCall(LIVE_POOL, POOL_IFACE.encodeFunctionData('USDC', [])))[0],
  );
  assert.equal(poolUsdc, getAddress(USDC), 'pool must remain wired to the canonical USDC address');

  const minter = getAddress(
    TICKET_IFACE.decodeFunctionResult('MINTER', await ethCall(ticketAddress, TICKET_IFACE.encodeFunctionData('MINTER', [])))[0],
  );
  assert.equal(minter, getAddress(LIVE_POOL), 'ticket collection must remain minted only by its own pool');

  const ownerOfData = TICKET_IFACE.encodeFunctionData('ownerOf', [LIVE_TICKET_ID]);
  const owner = getAddress(
    TICKET_IFACE.decodeFunctionResult('ownerOf', await ethCall(ticketAddress, ownerOfData))[0],
  );
  assert.notEqual(owner, ZeroAddress, 'the fork-test fixture ticket must still have a live owner');
  console.log(`HISTORICAL_EVIDENCE[LIVE_POOL/ticket #${LIVE_TICKET_ID} ownership]=PASS owner=${owner}`);

  console.log('HISTORICAL_EVIDENCE=PASS');
}

main().catch((error) => {
  console.error('HISTORICAL_EVIDENCE=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
