'use strict';

const { ethers } = require('ethers');
const db = require('../db');
const { decrypt } = require('./cryptoService');

// Signer access for the approved, encrypted SYSTEM_SEED_WALLET agent wallets
// only. Human users never receive an EXTREMA created wallet: they sign with
// their own connected wallet or Circle user controlled wallet.
async function getSignerForUser(userId, provider) {
  const { rows } = await db.query(
    `SELECT wallet_address, private_key_encrypted
       FROM extrema_wallets
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );

  if (!rows.length) throw new Error('EXTREMA wallet not found');

  const privateKey = decrypt(rows[0].private_key_encrypted);
  const signer = new ethers.Wallet(privateKey, provider);

  if (signer.address.toLowerCase() !== rows[0].wallet_address.toLowerCase()) {
    throw new Error('Stored wallet integrity check failed');
  }

  return signer;
}

module.exports = {
  getSignerForUser,
};
