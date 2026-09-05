'use strict';

const assert = require('assert');
const crypto = require('crypto');

const actionRows = new Map();

function isFresh(row) {
  return new Date(row.expires_at).getTime() > Date.now();
}

const fakeDb = {
  async query(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('INSERT INTO action_authorizations')) {
      const [id, userId, actionType, payloadHash, payloadJson, expiresAt] = params;
      actionRows.set(id, {
        id,
        user_id: userId,
        action_type: actionType,
        payload_hash: payloadHash,
        payload_json: payloadJson,
        expires_at: expiresAt,
        challenge: null,
        rp_id: null,
        origin: null,
        challenge_consumed_at: null,
        verified_at: null,
        consumed_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    if (
      normalized.startsWith('UPDATE action_authorizations SET challenge = $1')
    ) {
      const [challenge, rpId, origin, actionId, userId] = params;
      const row = actionRows.get(actionId);
      if (
        !row ||
        row.user_id !== userId ||
        !isFresh(row) ||
        row.verified_at ||
        row.consumed_at
      ) {
        return { rowCount: 0, rows: [] };
      }

      row.challenge = challenge;
      row.rp_id = rpId;
      row.origin = origin;
      return { rowCount: 1, rows: [] };
    }

    if (
      normalized.startsWith(
        'UPDATE action_authorizations SET challenge_consumed_at = NOW()',
      )
    ) {
      const [actionId, userId] = params;
      const row = actionRows.get(actionId);
      if (
        !row ||
        row.user_id !== userId ||
        !isFresh(row) ||
        !row.challenge ||
        row.challenge_consumed_at ||
        row.verified_at ||
        row.consumed_at
      ) {
        return { rowCount: 0, rows: [] };
      }

      row.challenge_consumed_at = new Date();
      return {
        rowCount: 1,
        rows: [
          {
            challenge: row.challenge,
            rp_id: row.rp_id,
            origin: row.origin,
            payload_hash: row.payload_hash,
            payload_json: row.payload_json,
            action_type: row.action_type,
          },
        ],
      };
    }

    if (
      normalized.startsWith(
        'UPDATE action_authorizations SET verified_at = NOW(), consumed_at = NOW()',
      )
    ) {
      const [actionId, userId, payloadHash, actionType] = params;
      const row = actionRows.get(actionId);
      if (
        !row ||
        row.user_id !== userId ||
        row.payload_hash !== payloadHash ||
        row.action_type !== actionType ||
        !row.challenge_consumed_at ||
        row.verified_at ||
        row.consumed_at ||
        !isFresh(row)
      ) {
        return { rowCount: 0, rows: [] };
      }

      row.verified_at = new Date();
      row.consumed_at = new Date();
      return {
        rowCount: 1,
        rows: [
          {
            id: row.id,
            action_type: row.action_type,
            payload_hash: row.payload_hash,
            payload_json: row.payload_json,
            verified_at: row.verified_at,
            consumed_at: row.consumed_at,
          },
        ],
      };
    }

    if (
      normalized.startsWith(
        'SELECT id, action_type, payload_hash, payload_json, consumed_at FROM action_authorizations',
      )
    ) {
      const [actionId, userId, actionType] = params;
      const row = actionRows.get(actionId);
      if (
        !row ||
        row.user_id !== userId ||
        row.action_type !== actionType ||
        !row.consumed_at
      ) {
        return { rowCount: 0, rows: [] };
      }

      return {
        rowCount: 1,
        rows: [
          {
            id: row.id,
            action_type: row.action_type,
            payload_hash: row.payload_hash,
            payload_json: row.payload_json,
            consumed_at: row.consumed_at,
          },
        ],
      };
    }

    throw new Error(`unhandled_test_query: ${normalized}`);
  },
};

const dbPath = require.resolve('../backend/src/db.js');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
};

const actionAuthorizationService = require('../backend/src/services/actionAuthorizationService');

async function expectError(operation, expectedMessage) {
  let caught = null;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }

  assert(caught, `Expected error ${expectedMessage}`);
  assert.strictEqual(caught.message, expectedMessage);
}

(async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const walletAddress = '0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b';
  const poolAddress = '0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f';
  const ticketAddress = '0xF65Cf4a67299ad596e139e3F6a9594E809F05637';
  const currentOwner = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321';

  const created = await actionAuthorizationService.createClaimRequest({
    userId,
    walletAddress,
    poolAddress,
    ticketAddress,
    tokenId: '1',
    roundId: 1,
    currentOwner,
    amountRaw: '2160000',
    executionMode: 'EXTERNAL_OWNER',
  });

  assert.strictEqual(created.payload.action, 'CLAIM_REWARD');
  assert.strictEqual(created.payload.chainId, 5042002);
  assert.strictEqual(created.payload.contract, poolAddress);
  assert.strictEqual(created.payload.poolAddress, poolAddress);
  assert.strictEqual(created.payload.ticketAddress, ticketAddress);
  assert.strictEqual(created.payload.tokenId, '1');
  assert.strictEqual(created.payload.roundId, 1);
  assert.strictEqual(created.payload.amountRaw, '2160000');
  assert.strictEqual(created.payload.currentOwner, currentOwner);
  assert.strictEqual(created.payload.destination, currentOwner);
  assert.strictEqual(created.payload.executionMode, 'EXTERNAL_OWNER');
  assert.strictEqual(created.payload.walletAddress, walletAddress);
  assert(created.payload.nonce.length >= 16);
  assert(Date.parse(created.payload.expiresAt) > Date.now());
  assert.strictEqual(created.expiresInSeconds, 120);

  const expectedHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(created.payload))
    .digest('hex');
  assert.strictEqual(created.payloadHash, expectedHash);

  console.log('CLAIM_ACTION_PAYLOAD=PASS');

  await actionAuthorizationService.attachWebAuthnChallenge(
    userId,
    created.id,
    'test-webauthn-challenge',
    {
      rpID: 'example.test',
      origin: 'https://example.test',
    },
  );

  const saved = await actionAuthorizationService.consumeWebAuthnChallenge(
    userId,
    created.id,
  );

  assert.strictEqual(saved.challenge, 'test-webauthn-challenge');
  assert.strictEqual(saved.payloadHash, created.payloadHash);
  assert.strictEqual(saved.actionType, 'CLAIM_REWARD');

  await expectError(
    () =>
      actionAuthorizationService.consumeWebAuthnChallenge(
        userId,
        created.id,
      ),
    'action_challenge_expired',
  );

  console.log('CLAIM_CHALLENGE_SINGLE_USE=PASS');

  await expectError(
    () =>
      actionAuthorizationService.consumeVerifiedAction(
        userId,
        created.id,
        '0'.repeat(64),
        'CLAIM_REWARD',
      ),
    'action_authorization_invalid',
  );

  await expectError(
    () =>
      actionAuthorizationService.consumeVerifiedAction(
        userId,
        created.id,
        created.payloadHash,
        'REFUND_TICKET',
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_PAYLOAD_AND_TYPE_BINDING=PASS');

  const consumed = await actionAuthorizationService.consumeVerifiedAction(
    userId,
    created.id,
    created.payloadHash,
    'CLAIM_REWARD',
  );

  assert.strictEqual(consumed.actionType, 'CLAIM_REWARD');
  assert.strictEqual(consumed.payloadHash, created.payloadHash);

  await expectError(
    () =>
      actionAuthorizationService.consumeVerifiedAction(
        userId,
        created.id,
        created.payloadHash,
        'CLAIM_REWARD',
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_ACTION_SINGLE_USE=PASS');

  const recovered = await actionAuthorizationService.getConsumedAction(
    userId,
    created.id,
    'CLAIM_REWARD',
  );

  assert.strictEqual(recovered.actionType, 'CLAIM_REWARD');
  assert.strictEqual(recovered.payloadHash, created.payloadHash);
  assert.deepStrictEqual(recovered.payload, created.payload);

  await expectError(
    () =>
      actionAuthorizationService.getConsumedAction(
        userId,
        created.id,
        'REFUND_TICKET',
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_CONSUMED_ACTION_LOOKUP=PASS');
  console.log('CLAIM_ACTION_AUTH_SMOKE=PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
