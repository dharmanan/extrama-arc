'use strict';

const {
  initiateUserControlledWalletsClient,
} = require('@circle-fin/user-controlled-wallets');

const config = require('../config');

const READINESS_CACHE_MS = 60 * 1000;

let client = null;
let readinessVerifiedAt = 0;
let readinessPromise = null;

function isConfigured() {
  return Boolean(config.CIRCLE_API_KEY);
}

function getClient() {
  if (!isConfigured()) {
    throw new Error('circle_wallet_not_configured');
  }

  if (!client) {
    client = initiateUserControlledWalletsClient({
      apiKey: config.CIRCLE_API_KEY,
    });
  }

  return client;
}

async function verifyReadiness() {
  if (
    readinessVerifiedAt > 0 &&
    Date.now() - readinessVerifiedAt < READINESS_CACHE_MS
  ) {
    return {
      configured: true,
      reachable: true,
    };
  }

  if (readinessPromise) {
    return readinessPromise;
  }

  readinessPromise = (async () => {
    const activeClient = getClient();

    await activeClient.listUsers({
      pageSize: 1,
    });

    readinessVerifiedAt = Date.now();

    return {
      configured: true,
      reachable: true,
    };
  })();

  try {
    return await readinessPromise;
  } finally {
    readinessPromise = null;
  }
}

module.exports = {
  isConfigured,
  getClient,
  verifyReadiness,
};
