'use strict';

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const db = require('../db');
const config = require('../config');

const REGISTER_PURPOSE = 'passkey_register';
const LOGIN_PURPOSE = 'passkey_login';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function normalizeOrigin(value) {
  const url = new URL(value);
  return url.origin;
}

function isAllowedDevOrigin(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return (
      (url.protocol === 'https:' && host.endsWith('.app.github.dev')) ||
      host === 'localhost' ||
      host === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

function resolveWebAuthnContext(requestOrigin) {
  const origin = normalizeOrigin(requestOrigin);

  if (config.NODE_ENV === 'production') {
    const codespaceAllowed = config.ALLOW_CODESPACE_ORIGINS && isAllowedDevOrigin(origin);
    if (!config.webauthnOrigins.includes(origin) && !codespaceAllowed) {
      throw new Error('webauthn_origin_not_allowed');
    }

    if (codespaceAllowed) {
      return {
        origin,
        rpID: new URL(origin).hostname,
      };
    }

    if (!config.WEBAUTHN_RP_ID) {
      throw new Error('WEBAUTHN_RP_ID is required in production');
    }

    return {
      origin,
      rpID: config.WEBAUTHN_RP_ID,
    };
  }

  if (!config.webauthnOrigins.includes(origin) && !isAllowedDevOrigin(origin)) {
    throw new Error('webauthn_origin_not_allowed');
  }

  return {
    origin,
    rpID: config.WEBAUTHN_RP_ID || new URL(origin).hostname,
  };
}

async function replaceChallenge(userId, purpose, challenge, context) {
  await db.query(
    'DELETE FROM auth_challenges WHERE user_id = $1 AND purpose = $2',
    [userId, purpose],
  );

  await db.query(
    `INSERT INTO auth_challenges
      (id, user_id, challenge, purpose, rp_id, origin, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(),
      userId,
      challenge,
      purpose,
      context.rpID,
      context.origin,
      new Date(Date.now() + CHALLENGE_TTL_MS),
    ],
  );
}

async function consumeChallenge(userId, purpose) {
  const { rows } = await db.query(
    `DELETE FROM auth_challenges
      WHERE user_id = $1
        AND purpose = $2
        AND expires_at > NOW()
      RETURNING challenge, rp_id, origin`,
    [userId, purpose],
  );

  if (!rows.length) throw new Error('challenge_expired');

  return {
    challenge: rows[0].challenge,
    rpID: rows[0].rp_id,
    origin: rows[0].origin,
  };
}

async function getCredentials(userId, rpID) {
  const { rows } = await db.query(
    `SELECT credential_id, public_key, counter
       FROM passkey_credentials
      WHERE user_id = $1
        AND rp_id = $2
      ORDER BY created_at DESC`,
    [userId, rpID],
  );

  return rows.map((row) => ({
    id: row.credential_id,
    publicKey: Buffer.from(row.public_key, 'base64url'),
    counter: Number(row.counter),
  }));
}

async function startRegistration(userId, ownerAddress, requestOrigin) {
  const context = resolveWebAuthnContext(requestOrigin);
  const existing = await getCredentials(userId, context.rpID);

  const options = await generateRegistrationOptions({
    rpName: config.WEBAUTHN_RP_NAME,
    rpID: context.rpID,
    userID: Buffer.from(userId),
    userName: ownerAddress.toLowerCase(),
    userDisplayName: ownerAddress.toLowerCase(),
    attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({
      id: credential.id,
      type: 'public-key',
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'preferred',
    },
    supportedAlgorithmIDs: [-7, -257],
  });

  await replaceChallenge(userId, REGISTER_PURPOSE, options.challenge, context);
  return options;
}

async function finishRegistration(userId, credentialResponse, deviceName) {
  const saved = await consumeChallenge(userId, REGISTER_PURPOSE);

  const verification = await verifyRegistrationResponse({
    response: credentialResponse,
    expectedChallenge: saved.challenge,
    expectedOrigin: saved.origin,
    expectedRPID: saved.rpID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('passkey_registration_failed');
  }

  const { credential } = verification.registrationInfo;
  const id = crypto.randomUUID();

  await db.query(
    `INSERT INTO passkey_credentials
      (id, user_id, credential_id, public_key, counter, device_name, rp_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (credential_id) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           counter = EXCLUDED.counter,
           device_name = EXCLUDED.device_name,
           last_used_at = NOW()`,
    [
      id,
      userId,
      credential.id,
      Buffer.from(credential.publicKey).toString('base64url'),
      credential.counter,
      String(deviceName || 'My Device').slice(0, 100),
      saved.rpID,
    ],
  );

  return true;
}

async function startAuthentication(userId, requestOrigin) {
  const context = resolveWebAuthnContext(requestOrigin);
  const credentials = await getCredentials(userId, context.rpID);

  if (!credentials.length) {
    throw new Error('passkey_not_registered');
  }

  const options = await generateAuthenticationOptions({
    rpID: context.rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      type: 'public-key',
    })),
    userVerification: 'required',
  });

  await replaceChallenge(userId, LOGIN_PURPOSE, options.challenge, context);
  return options;
}

async function finishAuthentication(userId, credentialResponse) {
  const saved = await consumeChallenge(userId, LOGIN_PURPOSE);
  const credentials = await getCredentials(userId, saved.rpID);
  const matching = credentials.find((credential) => credential.id === credentialResponse.id);

  if (!matching) throw new Error('passkey_not_found');

  const verification = await verifyAuthenticationResponse({
    response: credentialResponse,
    expectedChallenge: saved.challenge,
    expectedOrigin: saved.origin,
    expectedRPID: saved.rpID,
    credential: {
      id: matching.id,
      publicKey: matching.publicKey,
      counter: matching.counter,
    },
    requireUserVerification: true,
  });

  if (!verification.verified) {
    throw new Error('passkey_authentication_failed');
  }

  await db.query(
    `UPDATE passkey_credentials
        SET counter = $1,
            last_used_at = NOW()
      WHERE credential_id = $2`,
    [verification.authenticationInfo.newCounter, credentialResponse.id],
  );

  return true;
}


async function startStepUpAuthentication(userId, requestOrigin) {
  const context = resolveWebAuthnContext(requestOrigin);
  const credentials = await getCredentials(userId, context.rpID);

  if (!credentials.length) {
    throw new Error('passkey_not_registered');
  }

  const options = await generateAuthenticationOptions({
    rpID: context.rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      type: 'public-key',
    })),
    userVerification: 'required',
  });

  return { options, context };
}

async function finishStepUpAuthentication(userId, credentialResponse, saved) {
  const credentials = await getCredentials(userId, saved.rpID);
  const matching = credentials.find((credential) => credential.id === credentialResponse.id);

  if (!matching) throw new Error('passkey_not_found');

  const verification = await verifyAuthenticationResponse({
    response: credentialResponse,
    expectedChallenge: saved.challenge,
    expectedOrigin: saved.origin,
    expectedRPID: saved.rpID,
    credential: {
      id: matching.id,
      publicKey: matching.publicKey,
      counter: matching.counter,
    },
    requireUserVerification: true,
  });

  if (!verification.verified) {
    throw new Error('passkey_authentication_failed');
  }

  await db.query(
    `UPDATE passkey_credentials
        SET counter = $1,
            last_used_at = NOW()
      WHERE credential_id = $2`,
    [verification.authenticationInfo.newCounter, credentialResponse.id],
  );

  return true;
}

module.exports = {
  resolveWebAuthnContext,
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
  startStepUpAuthentication,
  finishStepUpAuthentication,
};
