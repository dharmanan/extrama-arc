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

    if (normalized.startsWith('INSERT INTO action_authorizations') && normalized.includes('ON CONFLICT')) {
      const [id, userId, actionType, payloadHash, payloadJson, expiresAt, circleWalletId, requestId] = params;
      const existing = [...actionRows.values()].find((row) =>
        row.user_id === userId && row.action_type === actionType && row.circle_request_id === requestId);
      const row = existing || {
        id,
        user_id: userId,
        action_type: actionType,
        payload_hash: payloadHash,
        payload_json: payloadJson,
        expires_at: expiresAt,
        circle_wallet_id: circleWalletId,
        circle_request_id: requestId,
        verified_at: null,
        consumed_at: null,
      };
      actionRows.set(row.id, row);
      return { rowCount: 1, rows: [{ ...row, circle_state: null }] };
    }

    if (normalized.startsWith('INSERT INTO action_authorizations')) {
      const [id, userId, actionType, payloadHash, payloadJson, expiresAt] = params;
      actionRows.set(id, {
        id,
        user_id: userId,
        action_type: actionType,
        payload_hash: payloadHash,
        payload_json: payloadJson,
        expires_at: expiresAt,
        verified_at: null,
        consumed_at: null,
      });
      return { rowCount: 1, rows: [] };
    }

    // consumeExternalAction(): the one and only consumption of a connected
    // wallet authorization, bound to its action type and session wallet.
    if (normalized.startsWith('UPDATE action_authorizations SET consumed_at = NOW(), authorization_expires_at =')) {
      const [actionId, userId, actionType, walletAddress] = params;
      const row = actionRows.get(actionId);
      const executionMode = row && row.payload_json && row.payload_json.executionMode;
      if (
        !row ||
        row.user_id !== userId ||
        row.action_type !== actionType ||
        String(row.payload_json.walletAddress).toLowerCase() !== String(walletAddress).toLowerCase() ||
        !(executionMode === 'EXTERNAL_WALLET' || executionMode === 'EXTERNAL_OWNER') ||
        row.consumed_at ||
        !isFresh(row)
      ) {
        return { rowCount: 0, rows: [] };
      }

      row.consumed_at = new Date();
      row.authorization_expires_at = new Date(Date.now() + 10 * 60 * 1000);
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

    if (
      normalized.startsWith(
        'SELECT id, action_type, payload_hash, payload_json, consumed_at, external_state, authorization_expires_at, verified_tx_hash FROM action_authorizations',
      )
    ) {
      const [actionId, userId, actionType] = params;
      const row = actionRows.get(actionId);
      const executionMode = row && row.payload_json && row.payload_json.executionMode;
      const isExternal = executionMode === 'EXTERNAL_WALLET' || executionMode === 'EXTERNAL_OWNER';
      const authorizationStillFresh =
        row && (row.authorization_expires_at == null || row.authorization_expires_at > new Date());
      if (
        !row ||
        row.user_id !== userId ||
        row.action_type !== actionType ||
        !row.consumed_at ||
        (isExternal && !authorizationStillFresh)
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
            external_state: row.external_state ?? null,
            authorization_expires_at: row.authorization_expires_at ?? null,
            verified_tx_hash: row.verified_tx_hash ?? null,
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
  // expiresInSeconds is Math.floor((expiresAt - Date.now()) / 1000): the
  // nonzero time this function itself takes to run means it is almost always
  // 119, not 120, even though the TTL requested was exactly 120s. Asserting
  // the exact value made this check flaky/timing-dependent rather than
  // deterministic; a tolerant range still proves the real invariant (~120s TTL).
  assert.ok(
    created.expiresInSeconds === 119 || created.expiresInSeconds === 120,
    `expected expiresInSeconds to floor to 119 or 120, got ${created.expiresInSeconds}`,
  );

  const expectedHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(created.payload))
    .digest('hex');
  assert.strictEqual(created.payloadHash, expectedHash);

  console.log('CLAIM_ACTION_PAYLOAD=PASS');

  // A connected wallet authorization is consumable only by the session wallet
  // it is bound to, and only as the action type it was created for.
  await expectError(
    () =>
      actionAuthorizationService.consumeExternalAction(
        userId,
        created.id,
        'CLAIM_REWARD',
        currentOwner,
      ),
    'action_authorization_invalid',
  );

  await expectError(
    () =>
      actionAuthorizationService.consumeExternalAction(
        userId,
        created.id,
        'REFUND_TICKET',
        walletAddress,
      ),
    'action_authorization_invalid',
  );

  await expectError(
    () =>
      actionAuthorizationService.consumeExternalAction(
        '22222222-2222-4222-8222-222222222222',
        created.id,
        'CLAIM_REWARD',
        walletAddress,
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_PAYLOAD_AND_TYPE_BINDING=PASS');

  const consumed = await actionAuthorizationService.consumeExternalAction(
    userId,
    created.id,
    'CLAIM_REWARD',
    walletAddress.toLowerCase(),
  );

  assert.strictEqual(consumed.actionType, 'CLAIM_REWARD');
  assert.strictEqual(consumed.payloadHash, created.payloadHash);
  assert.deepStrictEqual(consumed.payload, created.payload);

  await expectError(
    () =>
      actionAuthorizationService.consumeExternalAction(
        userId,
        created.id,
        'CLAIM_REWARD',
        walletAddress,
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_ACTION_SINGLE_USE=PASS');

  const expired = await actionAuthorizationService.createClaimRequest({
    userId,
    walletAddress,
    poolAddress,
    ticketAddress,
    tokenId: '2',
    roundId: 1,
    currentOwner,
    amountRaw: '2160000',
    executionMode: 'EXTERNAL_OWNER',
  });
  actionRows.get(expired.id).expires_at = new Date(Date.now() - 1000);
  await expectError(
    () =>
      actionAuthorizationService.consumeExternalAction(
        userId,
        expired.id,
        'CLAIM_REWARD',
        walletAddress,
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_ACTION_EXPIRY=PASS');

  // A Circle claim is signed through its own Circle challenge. It can never
  // be consumed by the connected wallet path, even by the same wallet.
  const circleClaim = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'CLAIM_REWARD',
    userId,
    walletAddress,
    circleWalletId: '33333333-3333-4333-8333-333333333333',
    requestId: '44444444-4444-4444-8444-444444444444',
    poolAddress,
    ticketAddress,
    tokenId: '3',
    roundId: 1,
    currentOwner,
    amountRaw: '2160000',
  });
  assert.strictEqual(circleClaim.payload.executionMode, 'CIRCLE_USER_WALLET');
  await expectError(
    () =>
      actionAuthorizationService.consumeExternalAction(
        userId,
        circleClaim.id,
        'CLAIM_REWARD',
        walletAddress,
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_CIRCLE_NOT_EXTERNALLY_CONSUMABLE=PASS');

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

  await expectError(
    () =>
      actionAuthorizationService.getConsumedAction(
        userId,
        created.id,
        'NOT_AN_ACTION',
      ),
    'action_authorization_invalid',
  );

  console.log('CLAIM_CONSUMED_ACTION_LOOKUP=PASS');
  console.log('CLAIM_ACTION_AUTH_SMOKE=PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
