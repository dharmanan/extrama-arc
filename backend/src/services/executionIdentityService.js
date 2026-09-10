'use strict';

const { ethers } = require('ethers');

// The locked EXTREMA participant architecture has exactly three execution
// identities:
//
//   EXTERNAL_WALLET     human; an injected EVM wallet signs every transaction
//   CIRCLE_USER_WALLET  human; a Circle user controlled Arc EOA signs every
//                       transaction through a Circle hosted challenge
//   SYSTEM_SEED_WALLET  autonomous EXTREMA agents; never a browser session
//
// Only the two human modes can ever back an authenticated HTTP session.
const EXECUTION_MODES = Object.freeze({
  EXTERNAL_WALLET: 'EXTERNAL_WALLET',
  CIRCLE_USER_WALLET: 'CIRCLE_USER_WALLET',
  SYSTEM_SEED_WALLET: 'SYSTEM_SEED_WALLET',
});

const HUMAN_EXECUTION_MODES = new Set([
  EXECUTION_MODES.EXTERNAL_WALLET,
  EXECUTION_MODES.CIRCLE_USER_WALLET,
]);

function normalizeAddress(address, errorCode = 'wallet_address_invalid') {
  if (!ethers.isAddress(address)) throw new Error(errorCode);
  return ethers.getAddress(address);
}

function isHumanExecutionMode(mode) {
  return HUMAN_EXECUTION_MODES.has(mode);
}

function assertHumanExecutionMode(mode) {
  if (mode === EXECUTION_MODES.SYSTEM_SEED_WALLET) {
    throw new Error('system_seed_wallet_forbidden');
  }
  if (!isHumanExecutionMode(mode)) {
    throw new Error('wallet_execution_mode_invalid');
  }
  return mode;
}

function createSessionIdentity({ executionMode, ownerAddress, walletAddress }) {
  const mode = assertHumanExecutionMode(executionMode);
  const owner = normalizeAddress(ownerAddress).toLowerCase();

  if (mode === EXECUTION_MODES.EXTERNAL_WALLET) {
    const wallet = normalizeAddress(walletAddress, 'external_wallet_address_invalid').toLowerCase();
    if (wallet !== owner) throw new Error('external_wallet_session_mismatch');
    return { executionMode: mode, ownerAddress: owner, walletAddress: wallet };
  }

  const wallet = normalizeAddress(walletAddress, 'circle_wallet_address_invalid').toLowerCase();
  if (wallet !== owner) throw new Error('circle_wallet_session_mismatch');
  return { executionMode: mode, ownerAddress: owner, walletAddress: wallet };
}

function assertExternalSessionAddress(auth, expectedAddress) {
  if (auth?.executionMode !== EXECUTION_MODES.EXTERNAL_WALLET) {
    throw new Error('external_wallet_session_required');
  }
  const sessionWallet = normalizeAddress(auth.walletAddress, 'external_wallet_session_mismatch');
  const expected = normalizeAddress(expectedAddress, 'external_wallet_session_mismatch');
  if (sessionWallet.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('external_wallet_session_mismatch');
  }
  return sessionWallet;
}

function assertCircleSession(auth, expectedAddress, expectedCircleWalletId) {
  if (auth?.executionMode !== EXECUTION_MODES.CIRCLE_USER_WALLET) {
    throw new Error('circle_wallet_session_required');
  }
  const sessionWallet = normalizeAddress(auth.walletAddress, 'circle_wallet_session_mismatch');
  const expected = normalizeAddress(expectedAddress, 'circle_wallet_session_mismatch');
  if (
    sessionWallet.toLowerCase() !== expected.toLowerCase() ||
    typeof auth.circleWalletId !== 'string' ||
    !auth.circleWalletId ||
    (expectedCircleWalletId && auth.circleWalletId !== expectedCircleWalletId)
  ) {
    throw new Error('circle_wallet_session_mismatch');
  }
  return { walletAddress: sessionWallet, circleWalletId: auth.circleWalletId };
}

// Connected wallet actions label their payloads EXTERNAL_WALLET (entry and
// transfer) or EXTERNAL_OWNER (refund, claim, marketplace). Both mean the
// user's own connected wallet signs the transaction.
function isExternalActionMode(mode) {
  return mode === EXECUTION_MODES.EXTERNAL_WALLET || mode === 'EXTERNAL_OWNER';
}

module.exports = {
  EXECUTION_MODES,
  HUMAN_EXECUTION_MODES,
  isHumanExecutionMode,
  assertHumanExecutionMode,
  createSessionIdentity,
  assertExternalSessionAddress,
  assertCircleSession,
  isExternalActionMode,
};
