'use strict';

const { ethers } = require('ethers');
const config = require('../config');

const ARC_CHAIN_ID = 5042002;
const READ_STALL_TIMEOUT_MS = 750;

const ARC_NETWORK = Object.freeze({
  chainId: ARC_CHAIN_ID,
  name: 'Arc Testnet',
});

const READ_ONLY_RPC_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'net_version',
  'web3_clientVersion',
]);

let primaryWriteProvider = null;
let primaryReadProvider = null;
let fallbackReadProvider = null;
let readProvider = null;

function normalizeUrl(value) {
  const text = String(value || '').trim();
  return text || null;
}

function isTransientReadError(error) {
  if (!error) return false;

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

  const rpcCodes = [
    error?.error?.code,
    error?.info?.error?.code,
  ];

  if (rpcCodes.includes(-32005)) {
    return true;
  }

  const messages = [
    error?.message,
    error?.shortMessage,
    error?.error?.message,
    error?.info?.error?.message,
  ];

  return messages.some((message) => {
    const text = String(message || '').toLowerCase();

    return (
      text.includes('timeout') ||
      text.includes('rate limit') ||
      text.includes('socket') ||
      text.includes('connection reset') ||
      text.includes('connection refused')
    );
  });
}

function settleRead(source, work) {
  return Promise.resolve()
    .then(work)
    .then(
      (value) => ({
        source,
        ok: true,
        value,
      }),
      (error) => ({
        source,
        ok: false,
        error,
      }),
    );
}

// Starts on primary. If primary has not completed after the stall window,
// fallback starts in parallel. Both branches are converted to fulfilled
// tagged results, so a losing RPC request can never surface a late unhandled
// rejection after the winning endpoint has already returned.
//
// This is deliberately read-only. Writes remain pinned to the primary RPC and
// are never retried or failed over.
async function hedgedRead(
  primaryWork,
  fallbackWork,
  stallTimeoutMs = READ_STALL_TIMEOUT_MS,
) {
  const primary = settleRead(
    'primary',
    primaryWork,
  );

  let timer = null;

  const stalled = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({
        source: 'stall',
        ok: false,
      }),
      stallTimeoutMs,
    );

    timer.unref?.();
  });

  const first = await Promise.race([
    primary,
    stalled,
  ]);

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  if (first.source === 'primary') {
    if (first.ok) {
      return first.value;
    }

    if (!isTransientReadError(first.error)) {
      throw first.error;
    }

    const fallback = await settleRead(
      'fallback',
      fallbackWork,
    );

    if (fallback.ok) {
      return fallback.value;
    }

    throw fallback.error;
  }

  const fallback = settleRead(
    'fallback',
    fallbackWork,
  );

  const winner = await Promise.race([
    primary,
    fallback,
  ]);

  if (winner.ok) {
    return winner.value;
  }

  if (!isTransientReadError(winner.error)) {
    throw winner.error;
  }

  const other =
    winner.source === 'primary'
      ? fallback
      : primary;

  const second = await other;

  if (second.ok) {
    return second.value;
  }

  if (!isTransientReadError(second.error)) {
    throw second.error;
  }

  throw second.error || winner.error;
}

class ConcurrencyGate {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(work) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => {
        this.waiters.push(resolve);
      });
    }

    this.active += 1;

    try {
      return await work();
    } finally {
      this.active -= 1;

      const next =
        this.waiters.shift();

      if (next) next();
    }
  }
}

class LimitedReadJsonRpcProvider extends ethers.JsonRpcProvider {
  constructor(request, limit) {
    super(
      request,
      ARC_NETWORK,
      {
        staticNetwork: true,
        batchMaxCount: 1,
      },
    );

    this.readGate =
      new ConcurrencyGate(limit);
  }

  async _send(payload) {
    return this.readGate.run(
      () => super._send(payload),
    );
  }
}

class HedgedReadProvider extends ethers.AbstractProvider {
  constructor(primary, fallback) {
    super(ARC_NETWORK);

    this.primary = primary;
    this.fallback = fallback;
  }

  async _detectNetwork() {
    return ethers.Network.from(
      ARC_NETWORK,
    );
  }

  async _perform(request) {
    if (
      request?.method ===
      'broadcastTransaction'
    ) {
      throw new Error(
        'arc_read_provider_write_forbidden',
      );
    }

    return hedgedRead(
      () => this.primary._perform(request),
      () => this.fallback._perform(request),
    );
  }

  async send(method, params) {
    if (!READ_ONLY_RPC_METHODS.has(method)) {
      throw new Error(
        'arc_read_provider_method_forbidden',
      );
    }

    return hedgedRead(
      () => this.primary.send(method, params),
      () => this.fallback.send(method, params),
    );
  }

  destroy() {
    try {
      this.primary.destroy();
    } catch {}

    try {
      this.fallback.destroy();
    } catch {}

    super.destroy();
  }
}

function createFetchRequest(url) {
  const request =
    new ethers.FetchRequest(url);

  // A stalled HTTP request must eventually release its queue slot.
  request.timeout = 8_000;

  return request;
}

function createWriteJsonRpcProvider(url) {
  return new ethers.JsonRpcProvider(
    createFetchRequest(url),
    ARC_NETWORK,
    {
      staticNetwork: true,
      batchMaxCount: 1,
    },
  );
}

function createReadJsonRpcProvider(url) {
  return new LimitedReadJsonRpcProvider(
    createFetchRequest(url),
    config.ARC_RPC_READ_CONCURRENCY,
  );
}

function getPrimaryRpcUrl() {
  return normalizeUrl(
    config.ARC_TESTNET_RPC_URL,
  );
}

function getFallbackRpcUrl() {
  const primary =
    getPrimaryRpcUrl();

  const fallback =
    normalizeUrl(
      config.ARC_TESTNET_RPC_FALLBACK_URL,
    );

  if (
    !fallback ||
    fallback === primary
  ) {
    return null;
  }

  return fallback;
}

function getArcWriteProvider() {
  if (!primaryWriteProvider) {
    const url =
      getPrimaryRpcUrl();

    if (!url) {
      throw new Error(
        'arc_primary_rpc_unavailable',
      );
    }

    // Primary only. No failover and no read queue.
    primaryWriteProvider =
      createWriteJsonRpcProvider(url);
  }

  return primaryWriteProvider;
}

function getArcPrimaryReadProvider() {
  if (!primaryReadProvider) {
    const url =
      getPrimaryRpcUrl();

    if (!url) {
      throw new Error(
        'arc_primary_rpc_unavailable',
      );
    }

    primaryReadProvider =
      createReadJsonRpcProvider(url);
  }

  return primaryReadProvider;
}

function getArcFallbackProvider() {
  const url =
    getFallbackRpcUrl();

  if (!url) return null;

  if (!fallbackReadProvider) {
    fallbackReadProvider =
      createReadJsonRpcProvider(url);
  }

  return fallbackReadProvider;
}

function getArcReadProvider() {
  if (readProvider) {
    return readProvider;
  }

  const primary =
    getArcPrimaryReadProvider();

  const fallback =
    getArcFallbackProvider();

  if (!fallback) {
    readProvider = primary;
    return readProvider;
  }

  readProvider =
    new HedgedReadProvider(
      primary,
      fallback,
    );

  return readProvider;
}

function getArcRpcConfiguration() {
  return Object.freeze({
    chainId: ARC_CHAIN_ID,
    primaryRpcUrl:
      getPrimaryRpcUrl(),
    fallbackRpcUrl:
      getFallbackRpcUrl(),
    fallbackEnabled:
      Boolean(
        getFallbackRpcUrl(),
      ),
    readConcurrencyPerEndpoint:
      config.ARC_RPC_READ_CONCURRENCY,
    readStallTimeoutMs:
      READ_STALL_TIMEOUT_MS,
  });
}

module.exports = {
  ARC_CHAIN_ID,
  getArcReadProvider,
  getArcWriteProvider,
  getArcRpcConfiguration,
};
