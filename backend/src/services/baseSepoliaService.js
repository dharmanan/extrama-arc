'use strict';

// Dedicated Base Sepolia read/verify module for the Gateway source deposit
// flow. Deliberately separate from arcService/arcRpcProviderService: Base
// Sepolia is a distinct chain with its own RPC, and this module must never be
// reached by pretending the Arc provider is multi-chain.
//
// The official GatewayWallet and Base Sepolia USDC addresses are not
// redeclared here: they are read from gatewayService, the single source of
// truth already asserted against Circle's live /v1/info response.

const { ethers } = require('ethers');
const config = require('../config');
const gatewayService = require('./gatewayService');

const BASE_SEPOLIA_CHAIN_ID = 84532n;
const BASE_SEPOLIA_GATEWAY_DOMAIN = 6;

const BASE_SEPOLIA_NETWORK = Object.freeze({
  chainId: Number(BASE_SEPOLIA_CHAIN_ID),
  name: 'Base Sepolia',
});

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
];
const GATEWAY_WALLET_ABI = [
  'function deposit(address token,uint256 value)',
];
const USDC_INTERFACE = new ethers.Interface(USDC_ABI);
const GATEWAY_WALLET_INTERFACE = new ethers.Interface(GATEWAY_WALLET_ABI);

function baseSepoliaUsdcAddress() {
  const address = gatewayService.SOURCE_USDC_BY_DOMAIN.get(BASE_SEPOLIA_GATEWAY_DOMAIN);
  if (!address) throw new Error('gateway_deposit_source_unsupported');
  return ethers.getAddress(address);
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  return text || null;
}

function createFetchRequest(url) {
  const request = new ethers.FetchRequest(url);
  request.timeout = 8_000;
  return request;
}

function createProvider(url) {
  return new ethers.JsonRpcProvider(
    createFetchRequest(url),
    BASE_SEPOLIA_NETWORK,
    { staticNetwork: true, batchMaxCount: 1 },
  );
}

let readProvider = null;

// Deposit reads are on-demand user actions, not a hot polling loop like Arc's
// round state, so a plain quorum-1 FallbackProvider (no read concurrency
// gate) is enough: one healthy endpoint answers every read.
function getBaseSepoliaProvider() {
  if (readProvider) return readProvider;

  const primaryUrl = normalizeUrl(config.BASE_SEPOLIA_RPC_URL);
  if (!primaryUrl) throw new Error('base_sepolia_primary_rpc_unavailable');
  const primary = createProvider(primaryUrl);

  const fallbackUrl = normalizeUrl(config.BASE_SEPOLIA_RPC_FALLBACK_URL);
  if (!fallbackUrl || fallbackUrl === primaryUrl) {
    readProvider = primary;
    return readProvider;
  }

  readProvider = new ethers.FallbackProvider(
    [
      { provider: primary, priority: 1, weight: 1, stallTimeout: 750 },
      { provider: createProvider(fallbackUrl), priority: 2, weight: 1, stallTimeout: 750 },
    ],
    BASE_SEPOLIA_NETWORK,
    { quorum: 1 },
  );
  return readProvider;
}

async function assertBaseSepoliaNetwork(provider) {
  const network = await provider.getNetwork();
  if (network.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error('base_sepolia_chain_id_mismatch');
  }
}

async function readBaseUsdcState(address) {
  if (!ethers.isAddress(address)) throw new Error('base_sepolia_wallet_invalid');
  const owner = ethers.getAddress(address);
  const provider = getBaseSepoliaProvider();
  await assertBaseSepoliaNetwork(provider);

  const usdc = new ethers.Contract(baseSepoliaUsdcAddress(), USDC_ABI, provider);
  const [balanceRaw, allowanceRaw] = await Promise.all([
    usdc.balanceOf(owner),
    usdc.allowance(owner, gatewayService.GATEWAY_WALLET_CONTRACT),
  ]);

  return {
    balanceRaw: balanceRaw.toString(),
    allowanceRaw: allowanceRaw.toString(),
  };
}

function transactionRequest({ from, to, data }) {
  return {
    chainId: Number(BASE_SEPOLIA_CHAIN_ID),
    from: ethers.getAddress(from),
    to: ethers.getAddress(to),
    data,
    value: '0x0',
  };
}

function buildApproveTransactionRequest({ from, amountRaw }) {
  return transactionRequest({
    from,
    to: baseSepoliaUsdcAddress(),
    data: USDC_INTERFACE.encodeFunctionData('approve', [
      gatewayService.GATEWAY_WALLET_CONTRACT,
      amountRaw,
    ]),
  });
}

// NEVER a plain ERC-20 transfer: GatewayWallet only credits amounts moved in
// through its own deposit(token, value) entry point.
function buildDepositTransactionRequest({ from, amountRaw }) {
  return transactionRequest({
    from,
    to: gatewayService.GATEWAY_WALLET_CONTRACT,
    data: GATEWAY_WALLET_INTERFACE.encodeFunctionData('deposit', [
      baseSepoliaUsdcAddress(),
      amountRaw,
    ]),
  });
}

function assertTransaction(tx, request) {
  if (ethers.getAddress(tx.from).toLowerCase() !== request.from.toLowerCase()) {
    throw new Error('gateway_deposit_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== request.to.toLowerCase()) {
    throw new Error('gateway_deposit_target_mismatch');
  }
  if (tx.value !== 0n) throw new Error('gateway_deposit_value_mismatch');
  if (String(tx.data).toLowerCase() !== request.data.toLowerCase()) {
    throw new Error('gateway_deposit_calldata_mismatch');
  }
}

async function readTransaction(txHash, notFoundError, failureError) {
  const provider = getBaseSepoliaProvider();
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error(notFoundError);
  if (receipt.status !== 1) throw new Error(failureError);
  return { tx, receipt };
}

module.exports = {
  BASE_SEPOLIA_CHAIN_ID: Number(BASE_SEPOLIA_CHAIN_ID),
  BASE_SEPOLIA_GATEWAY_DOMAIN,
  getBaseSepoliaProvider,
  baseSepoliaUsdcAddress,
  readBaseUsdcState,
  buildApproveTransactionRequest,
  buildDepositTransactionRequest,
  assertTransaction,
  readTransaction,
};
