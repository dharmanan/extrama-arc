'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../db');
const { encrypt, decrypt } = require('./cryptoService');

function formatWalletRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    address: row.wallet_address,
    createdAt: row.created_at,
  };
}

async function getWalletForUser(userId) {
  const { rows } = await db.query(
    `SELECT id, wallet_address, created_at
       FROM extrema_wallets
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );

  return formatWalletRow(rows[0]);
}

async function createWalletForUser(userId) {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id, wallet_address, created_at
         FROM extrema_wallets
        WHERE user_id = $1
        LIMIT 1
        FOR UPDATE`,
      [userId],
    );

    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return {
        created: false,
        wallet: formatWalletRow(existing.rows[0]),
        privateKey: null,
      };
    }

    const wallet = ethers.Wallet.createRandom();
    const id = crypto.randomUUID();
    const privateKeyEncrypted = encrypt(wallet.privateKey);

    const { rows } = await client.query(
      `INSERT INTO extrema_wallets
        (id, user_id, wallet_address, private_key_encrypted)
       VALUES ($1, $2, $3, $4)
       RETURNING id, wallet_address, created_at`,
      [id, userId, wallet.address, privateKeyEncrypted],
    );

    await client.query('COMMIT');

    return {
      created: true,
      wallet: formatWalletRow(rows[0]),
      privateKey: wallet.privateKey,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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
  getWalletForUser,
  createWalletForUser,
  getSignerForUser,
};
