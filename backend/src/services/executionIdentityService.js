'use strict';

const { ethers } = require('ethers');

const EXECUTION_MODES = Object.freeze({
  BACKEND_WALLET: 'BACKEND_WALLET',
  EXTERNAL_WALLET: 'EXTERNAL_WALLET',
  CIRCLE_USER_WALLET: 'CIRCLE_USER_WALLET',
  SYSTEM_SEED_WALLET: 'SYSTEM_SEED_WALLET',
});

const HUMAN_EXECUTION_MODES = new Set([
  EXECUTION_MODES.BACKEND_WALLET,
  EXECUTION_MODES.EXTERNAL_WALLET,
  EXECUTION_MODES.CIRCLE_USER_WALLET,
]);

function normalizeAddress(address, errorCode = 'wallet_address_invalid') {
  if (!ethers.isAddress(address)) throw new Error(errorCode);
  return ethers.getAddress(address);
}

function assertHumanExecutionMode(mode) {
  if (mode === EXECUTION_MODES.SYSTEM_SEED_WALLET) {
    throw new Error('system_seed_wallet_forbidden');
  }
  if (!HUMAN_EXECUTION_MODES.has(mode)) {
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

  if (mode === EXECUTION_MODES.CIRCLE_USER_WALLET) {
    const wallet = normalizeAddress(walletAddress, 'circle_wallet_address_invalid').toLowerCase();
    if (wallet !== owner) throw new Error('circle_wallet_session_mismatch');
    return { executionMode: mode, ownerAddress: owner, walletAddress: wallet };
  }

  if (walletAddress !== null && walletAddress !== undefined) {
    throw new Error('backend_wallet_session_address_forbidden');
  }

  return { executionMode: mode, ownerAddress: owner, walletAddress: null };
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

function isExternalActionMode(mode) {
  return mode === EXECUTION_MODES.EXTERNAL_WALLET || mode === 'EXTERNAL_OWNER';
}

module.exports = {
  EXECUTION_MODES,
  assertHumanExecutionMode,
  createSessionIdentity,
  assertExternalSessionAddress,
  isExternalActionMode,
};
