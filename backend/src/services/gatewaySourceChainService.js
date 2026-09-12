'use strict';

// Generic Gateway SOURCE chain read/verify module.
//
// One implementation, four configurations. Every deposit source network
// (Base Sepolia, OP Sepolia, Arbitrum Sepolia and Ethereum Sepolia) shares the
// same USDC allowance/balance reads, the same approve and
// GatewayWallet.deposit calldata construction and the same receipt assertions.
// The only per chain facts are the chain id, the USDC address and the RPC
// endpoints, all of which come from gatewayNetworks and the backend config
// rather than being restated here.
//
// Deliberately separate from arcService/arcRpcProviderService: a source chain
// is not Arc, and this module must never be reached by pretending the Arc
// provider is multi-chain.

const { ethers } = require('ethers');
const config = require('../config');
const gatewayNetworks = require('./gatewayNetworks');

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

/**
 * Resolves a Gateway domain to a canonical deposit source network, or fails
 * closed. A domain that exists in Gateway but that the product does not offer
 * as a funding source (Arc, or any unlisted domain) never reaches a chain read
 * or a calldata builder.
 */
function sourceConfigFor(domain) {
  const network = gatewayNetworks.depositSourceForDomain(domain);
  if (!network) throw new Error('gateway_deposit_source_unsupported');
  return network;
}

function sourceUsdcAddress(domain) {
  return ethers.getAddress(sourceConfigFor(domain).usdc);
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

function createProvider(url, network) {
  return new ethers.JsonRpcProvider(
    createFetchRequest(url),
    { chainId: network.chainId, name: network.label },
    { staticNetwork: true, batchMaxCount: 1 },
  );
}

const providers = new Map();

// Deposit reads are on-demand user actions, not a hot polling loop like Arc's
// round state, so a plain quorum-1 FallbackProvider (no read concurrency
// gate) is enough: one healthy endpoint answers every read.
function getSourceProvider(domain) {
  const cached = providers.get(domain);
  if (cached) return cached;

  const network = sourceConfigFor(domain);
  const primaryUrl = normalizeUrl(config[network.rpcConfigKey]);
  if (!primaryUrl) throw new Error('gateway_source_rpc_unavailable');
  const primary = createProvider(primaryUrl, network);

  const fallbackUrl = normalizeUrl(config[network.rpcFallbackConfigKey]);
  const provider = !fallbackUrl || fallbackUrl === primaryUrl
    ? primary
    : new ethers.FallbackProvider(
      [
        { provider: primary, priority: 1, weight: 1, stallTimeout: 750 },
        { provider: createProvider(fallbackUrl, network), priority: 2, weight: 1, stallTimeout: 750 },
      ],
      { chainId: network.chainId, name: network.label },
      { quorum: 1 },
    );

  providers.set(domain, provider);
  return provider;
}

async function assertSourceNetwork(domain, provider) {
  const expected = BigInt(sourceConfigFor(domain).chainId);
  const network = await provider.getNetwork();
  if (network.chainId !== expected) {
    throw new Error('gateway_source_chain_id_mismatch');
  }
}

// Only transport/provider availability failures are safe to retry after a
// transaction has already been positively bound. Explicit source identity,
// calldata, wallet and configuration errors deliberately do not match this
// allowlist and therefore fail closed at the caller.
function isTransientSourceReadError(error) {
  if (!error) return false;
  const nestedCodes = [error?.error?.code, error?.info?.error?.code];
  if (nestedCodes.includes(-32005)) return true;

  const messages = [
    error?.error?.message,
    error?.info?.error?.message,
    error?.shortMessage,
    error?.message,
  ];
  if (messages.some((message) => String(message || '').toLowerCase().includes('rate limit'))) {
    return true;
  }

  if ([
    'NETWORK_ERROR',
    'SERVER_ERROR',
    'TIMEOUT',
    'UNKNOWN_ERROR',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(error.code)) {
    return true;
  }

  // A contract/view call that has no revert data is provider transport noise;
  // a real revert carries data and must not be retried as if it were stale.
  return error.code === 'CALL_EXCEPTION' && (error.data === null || error.data === undefined);
}

/**
 * The user's real USDC position on a source chain: what they hold, and how
 * much of it GatewayWallet is currently allowed to move.
 *
 * This is the SOURCE WALLET balance. It is a different quantity from the
 * Gateway unified balance and the two are never interchanged.
 */
async function readSourceUsdcState(domain, address) {
  if (!ethers.isAddress(address)) throw new Error('gateway_source_wallet_invalid');
  const owner = ethers.getAddress(address);
  const provider = getSourceProvider(domain);
  await assertSourceNetwork(domain, provider);

  const usdc = new ethers.Contract(sourceUsdcAddress(domain), USDC_ABI, provider);
  const [balanceRaw, allowanceRaw] = await Promise.all([
    usdc.balanceOf(owner),
    usdc.allowance(owner, gatewayNetworks.GATEWAY_WALLET_CONTRACT),
  ]);

  return {
    balanceRaw: balanceRaw.toString(),
    allowanceRaw: allowanceRaw.toString(),
  };
}

function transactionRequest({ chainId, from, to, data }) {
  return {
    chainId,
    from: ethers.getAddress(from),
    to: ethers.getAddress(to),
    data,
    value: '0x0',
  };
}

function buildApproveTransactionRequest(domain, { from, amountRaw }) {
  const network = sourceConfigFor(domain);
  return transactionRequest({
    chainId: network.chainId,
    from,
    to: sourceUsdcAddress(domain),
    data: USDC_INTERFACE.encodeFunctionData('approve', [
      gatewayNetworks.GATEWAY_WALLET_CONTRACT,
      amountRaw,
    ]),
  });
}

// NEVER a plain ERC-20 transfer: GatewayWallet only credits amounts moved in
// through its own deposit(token, value) entry point.
function buildDepositTransactionRequest(domain, { from, amountRaw }) {
  const network = sourceConfigFor(domain);
  return transactionRequest({
    chainId: network.chainId,
    from,
    to: gatewayNetworks.GATEWAY_WALLET_CONTRACT,
    data: GATEWAY_WALLET_INTERFACE.encodeFunctionData('deposit', [
      sourceUsdcAddress(domain),
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
  // A transaction mined on a different chain can carry identical calldata.
  // Binding the chain id keeps a source receipt from one network from ever
  // satisfying a deposit recorded against another.
  // A provider that omits chainId has not proved which network mined the
  // transaction. Missing identity is therefore a failure, not a match.
  if (tx.chainId === undefined || tx.chainId === null) {
    throw new Error('gateway_deposit_chain_unavailable');
  }
  if (BigInt(tx.chainId) !== BigInt(request.chainId)) {
    throw new Error('gateway_deposit_chain_mismatch');
  }
}

async function readTransaction(domain, txHash, notFoundError, failureError) {
  const provider = getSourceProvider(domain);
  await assertSourceNetwork(domain, provider);
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error(notFoundError);
  if (receipt.status !== 1) throw new Error(failureError);
  return { tx, receipt };
}

/**
 * The per domain execution bundle the deposit state machine consumes.
 *
 * Every deposit source produces the same shape, so the durable state machine
 * stays one state machine with four configurations: it never branches on which
 * chain it is funding from.
 */
function sourceChainExecution(domain) {
  const network = sourceConfigFor(domain);
  return Object.freeze({
    domain: network.domain,
    label: network.label,
    chainId: network.chainId,
    circleBlockchain: network.circleBlockchain,
    usdcAddress: sourceUsdcAddress(domain),
    gatewayWallet: gatewayNetworks.GATEWAY_WALLET_CONTRACT,
    readChainState: (address) => readSourceUsdcState(domain, address),
    buildApprove: (input) => buildApproveTransactionRequest(domain, input),
    buildDeposit: (input) => buildDepositTransactionRequest(domain, input),
    assertTransaction,
    readTransaction: (txHash, notFoundError, failureError) => (
      readTransaction(domain, txHash, notFoundError, failureError)
    ),
  });
}

/** Every configured deposit source, keyed by Gateway domain. */
function sourceChainExecutionMap() {
  return new Map(
    gatewayNetworks.DEPOSIT_SOURCE_NETWORKS.map((network) => [
      network.domain,
      sourceChainExecution(network.domain),
    ]),
  );
}

module.exports = {
  assertTransaction,
  buildApproveTransactionRequest,
  buildDepositTransactionRequest,
  getSourceProvider,
  isTransientSourceReadError,
  readSourceUsdcState,
  readTransaction,
  sourceChainExecution,
  sourceChainExecutionMap,
  sourceConfigFor,
  sourceUsdcAddress,
};
