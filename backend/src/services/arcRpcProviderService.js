'use strict';

const { ethers } = require('ethers');
const config = require('../config');

const ARC_CHAIN_ID = 5042002;

const ARC_NETWORK = Object.freeze({
  chainId: ARC_CHAIN_ID,
  name: 'Arc Testnet',
});

let primaryWriteProvider = null;
let primaryReadProvider = null;
let fallbackReadProvider = null;
let readProvider = null;

function normalizeUrl(value) {
  const text = String(value || '').trim();
  return text || null;
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

  // quorum=1 means one healthy provider is enough.
  // Primary starts first. If it stalls, fallback may begin
  // without waiting for the primary request to time out fully.
  readProvider =
    new ethers.FallbackProvider(
      [
        {
          provider: primary,
          priority: 1,
          weight: 1,
          stallTimeout: 750,
        },
        {
          provider: fallback,
          priority: 2,
          weight: 1,
          stallTimeout: 750,
        },
      ],
      ARC_NETWORK,
      {
        quorum: 1,
      },
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
  });
}

module.exports = {
  ARC_CHAIN_ID,
  getArcReadProvider,
  getArcWriteProvider,
  getArcRpcConfiguration,
};
