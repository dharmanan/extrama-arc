'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const { decrypt } = require('./cryptoService');

// The resolver is an operator role, not an end-user wallet, so it is
// deliberately not stored in extrema_wallets: that table is keyed per user and
// cascades on user deletion. The key is supplied instead as an AES-256-GCM
// envelope in EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED, produced with the same
// ENCRYPTION_KEY the backend already uses. It is decrypted only here, only
// into an ethers Wallet, and is never returned, persisted or logged.

function isResolverSigningConfigured() {
  return Boolean(config.EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED);
}

let unconfiguredWarningEmitted = false;

// One warning per process, so an unconfigured deployment is obvious without
// repeating every lifecycle tick.
function warnIfUnconfigured() {
  if (isResolverSigningConfigured() || unconfiguredWarningEmitted) return;
  unconfiguredWarningEmitted = true;
  console.warn(
    '[round-automation] resolver signing disabled: EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED is not configured',
  );
}

function getResolverSigner(provider) {
  if (!isResolverSigningConfigured()) {
    throw new Error('resolver_signing_not_configured');
  }

  let privateKey;
  try {
    privateKey = decrypt(config.EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED);
  } catch {
    // Never surface the cause: it can echo key material.
    throw new Error('resolver_key_decrypt_failed');
  }

  try {
    return new ethers.Wallet(privateKey, provider);
  } catch {
    throw new Error('resolver_key_invalid');
  }
}

module.exports = {
  isResolverSigningConfigured,
  warnIfUnconfigured,
  getResolverSigner,
};
