'use strict';

const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(config.ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 12;

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

function decrypt(payload) {
  const [version, ivPart, ciphertextPart, tagPart] = String(payload || '').split('.');
  if (version !== 'v1' || !ivPart || !ciphertextPart || !tagPart) {
    throw new Error('Invalid encrypted payload');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    KEY,
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt };
