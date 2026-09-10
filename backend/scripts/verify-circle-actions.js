'use strict';

// Deterministic verification of the Circle user controlled wallet lifecycle:
// TRANSFER_TICKET, REFUND_TICKET, CLAIM_REWARD, MARKETPLACE_LIST,
// MARKETPLACE_UPDATE_PRICE, MARKETPLACE_CANCEL and MARKETPLACE_BUY.
//
// It runs the REAL actionAuthorizationService generic Circle state machine
// (against an in memory emulation of exactly the SQL statements it issues),
// the REAL circleActionExecutionService, and the REAL Circle transaction
// builders and receipt verifiers (against a fake Arc provider). Circle itself
// is a scripted fake. Nothing here opens a database, contacts Arc or Circle,
// holds a key, or can send a transaction.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

const { ethers } = require('ethers');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CIRCLE_WALLET_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CIRCLE_WALLET_ID = '99999999-9999-4999-8999-999999999999';
const WALLET = ethers.getAddress('0x1000000000000000000000000000000000000001');
const OTHER_WALLET = ethers.getAddress('0x2000000000000000000000000000000000000002');
const DESTINATION = ethers.getAddress('0x3000000000000000000000000000000000000003');
const SELLER = ethers.getAddress('0x4000000000000000000000000000000000000004');
const POOL = ethers.getAddress('0x5000000000000000000000000000000000000005');
const TICKET = ethers.getAddress('0x6000000000000000000000000000000000000006');
const USDC = ethers.getAddress('0x3600000000000000000000000000000000000000');
const MARKETPLACE = ethers.getAddress(require('../src/config').EXTREMA_MARKETPLACE_ADDRESS);
const USER_TOKEN = 'circle_user_token_long_enough';
const TOKEN_ID = '7';
const ROUND_ID = 3;
const LISTING_ID = '12';
const ASK = 4_500_000n;

function installModule(relativePath, exports) {
  const filename = require.resolve(relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

async function rejectsCode(fn, code, message) {
  await assert.rejects(fn, (error) => {
    assert.equal(error?.message, code, message || `expected ${code}, got ${error?.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// In memory emulation of the action_authorizations statements used by the
// generic Circle state machine. Each branch mirrors one real SQL statement,
// including its WHERE guards, so state rules are exercised, not bypassed.
// ---------------------------------------------------------------------------

const rows = new Map();
const COLUMNS = [
  'circle_state', 'circle_approval_challenge_id', 'circle_approval_idempotency_key',
  'circle_approval_ref_id', 'circle_approval_transaction_id', 'circle_approval_tx_hash',
  'circle_entry_challenge_id', 'circle_entry_idempotency_key', 'circle_entry_ref_id',
  'circle_entry_transaction_id', 'verified_tx_hash', 'verified_at',
];

function isLive(row) {
  return new Date(row.expires_at).getTime() > Date.now();
}

function matchesIdentity(row, [actionId, userId, walletAddress, circleWalletId], actionType) {
  return row && row.id === actionId && row.user_id === userId &&
    row.action_type === actionType &&
    String(row.payload_json.walletAddress).toLowerCase() === String(walletAddress).toLowerCase() &&
    row.circle_wallet_id === circleWalletId;
}

function out(row) {
  return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
}

const fakeDb = {
  async query(sql, params) {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('INSERT INTO action_authorizations') && text.includes('ON CONFLICT')) {
      const [id, userId, actionType, payloadHash, payload, expiresAt, circleWalletId, requestId] = params;
      const existing = [...rows.values()].find((row) =>
        row.user_id === userId && row.action_type === actionType && row.circle_request_id === requestId);
      if (existing) return out(existing);
      const row = {
        id, user_id: userId, action_type: actionType, payload_hash: payloadHash,
        payload_json: JSON.parse(JSON.stringify(payload)), expires_at: expiresAt,
        circle_wallet_id: circleWalletId, circle_request_id: requestId,
      };
      for (const column of COLUMNS) row[column] = null;
      rows.set(id, row);
      return out(row);
    }

    if (text.startsWith('SELECT id, action_type') && text.includes('action_type = $5')) {
      const row = rows.get(params[0]);
      const ok = matchesIdentity(row, params, params[4]) && row.payload_json.executionMode === 'CIRCLE_USER_WALLET';
      return out(ok ? row : null);
    }

    const reserve = text.match(/^UPDATE action_authorizations SET circle_state = \$6, (\w+) = COALESCE\(\1, \$7\), (\w+) = COALESCE\(\2, \$8\)/);
    if (reserve) {
      const row = rows.get(params[0]);
      const allowedStates = params[4];
      const nullAllowed = text.includes('circle_state IS NULL OR');
      const stateOk = (row && row.circle_state === null && nullAllowed) || (row && allowedStates.includes(row.circle_state));
      if (!matchesIdentity(row, params, params[8]) || row.payload_json.executionMode !== 'CIRCLE_USER_WALLET' || !stateOk || !isLive(row)) {
        return out(null);
      }
      row.circle_state = params[5];
      row[reserve[1]] = row[reserve[1]] || params[6];
      row[reserve[2]] = row[reserve[2]] || params[7];
      return out(row);
    }

    const persistChallenge = text.match(/^UPDATE action_authorizations SET (\w+) = COALESCE\(\1, \$5\) .* RETURNING \1 AS challenge_id$/);
    if (persistChallenge) {
      const column = persistChallenge[1];
      const row = rows.get(params[0]);
      if (!matchesIdentity(row, params, params[6]) || row.circle_state !== params[5] ||
        (row[column] !== null && row[column] !== params[4])) return out(null);
      row[column] = row[column] || params[4];
      return { rows: [{ challenge_id: row[column] }], rowCount: 1 };
    }

    const persistTransaction = text.match(/^UPDATE action_authorizations SET (\w+) = COALESCE\(\1, \$5\) WHERE .* circle_state = ANY\(\$6::varchar\[\]\)/);
    if (persistTransaction) {
      const column = persistTransaction[1];
      const row = rows.get(params[0]);
      if (!matchesIdentity(row, params, params[6]) || !params[5].includes(row.circle_state) ||
        (row[column] !== null && row[column] !== params[4])) return out(null);
      row[column] = row[column] || params[4];
      return out(row);
    }

    const bind = text.match(/^UPDATE action_authorizations SET circle_state = \$7, (\w+) = COALESCE\(\1, \$5\), (\w+) = COALESCE\(\2, \$6\)/);
    if (bind) {
      const [txIdColumn, txHashColumn] = [bind[1], bind[2]];
      const row = rows.get(params[0]);
      if (!matchesIdentity(row, params, params[8]) || !params[7].includes(row.circle_state) ||
        (row[txIdColumn] !== null && row[txIdColumn] !== params[4]) ||
        (row[txHashColumn] !== null && row[txHashColumn].toLowerCase() !== params[5].toLowerCase())) return out(null);
      row.circle_state = params[6];
      row[txIdColumn] = row[txIdColumn] || params[4];
      row[txHashColumn] = row[txHashColumn] || params[5];
      return out(row);
    }

    if (text.startsWith("UPDATE action_authorizations SET circle_state = 'APPROVAL_VERIFIED'")) {
      const row = rows.get(params[0]);
      if (!matchesIdentity(row, params, params[4]) || !['APPROVAL_SUBMITTED', 'APPROVAL_VERIFIED'].includes(row.circle_state)) {
        return { rows: [], rowCount: 0 };
      }
      row.circle_state = 'APPROVAL_VERIFIED';
      row.verified_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    if (text.startsWith("UPDATE action_authorizations SET circle_state = 'VERIFIED'")) {
      const row = rows.get(params[0]);
      if (!matchesIdentity(row, params, params[5]) || !params[6].includes(row.circle_state) ||
        String(row.verified_tx_hash).toLowerCase() !== params[4].toLowerCase()) return { rows: [], rowCount: 0 };
      row.circle_state = 'VERIFIED';
      row.verified_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unhandled_test_query: ${text.slice(0, 160)}`);
  },
};

// ---------------------------------------------------------------------------
// Fake Arc chain: contract reads, balances, transactions and receipts.
// ---------------------------------------------------------------------------

const TICKET_IFACE = new ethers.Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function approve(address to,uint256 tokenId)',
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
]);
const USDC_IFACE = new ethers.Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const POOL_IFACE = new ethers.Interface([
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
  'function refund(uint256 tokenId)',
  'function claim(uint256 tokenId)',
  'event RefundClaimed(uint256 indexed roundId, uint256 indexed ticketId, address indexed owner, uint256 amount)',
  'event RewardClaimed(uint256 indexed roundId, uint256 indexed ticketId, address indexed owner, uint256 amount)',
]);
const MARKETPLACE_IFACE = new ethers.Interface([
  'function list(address ticket,uint256 tokenId,uint256 askUsdc) returns (uint256 listingId)',
  'function updatePrice(uint256 listingId,uint256 newAskUsdc)',
  'function cancel(uint256 listingId)',
  'function buy(uint256 listingId,uint256 expectedAskUsdc)',
  'event Listed(uint256 indexed listingId,address indexed seller,address indexed ticket,uint256 tokenId,uint256 askUsdc,uint256 roundId)',
  'event ListingPriceUpdated(uint256 indexed listingId,uint256 askUsdc)',
  'event Cancelled(uint256 indexed listingId)',
  'event Sold(uint256 indexed listingId,address indexed seller,address indexed buyer,address ticket,uint256 tokenId,uint256 askUsdc)',
]);

const now = Math.floor(Date.now() / 1000);
const chain = {
  owner: WALLET,
  approved: ethers.ZeroAddress,
  usdcBalance: 10_000_000n,
  allowance: 0n,
  native: 1n,
  roundStatus: 0,
  transactions: new Map(),
};

function roundTuple() {
  return [[
    BigInt(now - 3600), BigInt(now + 3600), BigInt(now + 3600), BigInt(now + 86_400),
    chain.roundStatus, 3n, 4n, 3_000_000n, 3_000_000n, 0n, [0n, 0n, 0n],
  ]];
}

const provider = {
  async getNetwork() { return { chainId: 5042002n }; },
  async getBalance() { return chain.native; },
  async getTransaction(hash) { return chain.transactions.get(hash.toLowerCase())?.tx || null; },
  async getTransactionReceipt(hash) { return chain.transactions.get(hash.toLowerCase())?.receipt || null; },
  async call(tx) {
    const to = ethers.getAddress(tx.to);
    if (to === TICKET) {
      const parsed = TICKET_IFACE.parseTransaction({ data: tx.data });
      if (parsed.name === 'ownerOf') return TICKET_IFACE.encodeFunctionResult('ownerOf', [chain.owner]);
      if (parsed.name === 'getApproved') return TICKET_IFACE.encodeFunctionResult('getApproved', [chain.approved]);
    }
    if (to === USDC) {
      const parsed = USDC_IFACE.parseTransaction({ data: tx.data });
      if (parsed.name === 'balanceOf') return USDC_IFACE.encodeFunctionResult('balanceOf', [chain.usdcBalance]);
      if (parsed.name === 'allowance') return USDC_IFACE.encodeFunctionResult('allowance', [chain.allowance]);
    }
    if (to === POOL) {
      const parsed = POOL_IFACE.parseTransaction({ data: tx.data });
      if (parsed.name === 'getRound') return POOL_IFACE.encodeFunctionResult('getRound', roundTuple());
      if (parsed.name === 'entries') {
        return POOL_IFACE.encodeFunctionResult('entries', [BigInt(TOKEN_ID), BigInt(ROUND_ID), WALLET, 123_456n, 1n]);
      }
    }
    throw new Error(`unexpected_fake_call ${to}`);
  },
};

let txCounter = 0;
function mine({ from, to, data, value = 0n, status = 1, logs = [] }) {
  txCounter += 1;
  const hash = `0x${txCounter.toString(16).padStart(64, '0')}`;
  chain.transactions.set(hash, {
    tx: { hash, from, to, data, value },
    receipt: { status, blockNumber: 100 + txCounter, logs },
  });
  return hash;
}

function log(iface, address, name, args) {
  const encoded = iface.encodeEventLog(iface.getEvent(name), args);
  return { address, topics: encoded.topics, data: encoded.data };
}

const refundState = { isRefunded: false, roundStatus: 'CANCELLED', currentOwner: WALLET };
const claimState = { isClaimed: false, roundStatus: 'SETTLED', claimableRaw: '2160000', currentOwner: WALLET };

installModule('../src/db', fakeDb);
installModule('../src/services/arcService', {
  ARC_TESTNET_CHAIN_ID: 5042002n,
  ARC_TESTNET_USDC_ADDRESS: USDC,
  ARC_POOL_TOPOLOGY: [{ poolAddress: POOL, ticketAddress: TICKET, cadence: 'DAILY' }],
  getArcProvider: () => provider,
  invalidateArcWalletStateCache() {},
  refreshStandardRoundsCache: async () => {},
  async readRefundAuthorizationState() {
    return {
      poolAddress: POOL, ticketAddress: TICKET, tokenId: TOKEN_ID, roundId: ROUND_ID,
      roundStatus: refundState.roundStatus, currentOwner: refundState.currentOwner,
      isRefunded: refundState.isRefunded, amountRaw: '1000000', usdcAddress: USDC,
    };
  },
  async readClaimAuthorizationState() {
    return {
      poolAddress: POOL, ticketAddress: TICKET, tokenId: TOKEN_ID, roundId: ROUND_ID,
      roundStatus: claimState.roundStatus, currentOwner: claimState.currentOwner,
      isClaimed: claimState.isClaimed, claimableRaw: claimState.claimableRaw, usdcAddress: USDC,
    };
  },
});

const listing = {};
function resetListing(overrides = {}) {
  Object.assign(listing, {
    listingId: LISTING_ID, onchainStatus: 'ACTIVE', state: 'ACTIVE', isBuyable: true,
    seller: SELLER, currentOwner: SELLER, isApproved: true, askUsdcRaw: ASK.toString(),
    ticketAddress: TICKET, tokenId: TOKEN_ID,
  }, overrides);
}
resetListing();
let activeListingId = null;
installModule('../src/services/marketplaceService', {
  async readMarketplaceListing() { return { listing: { ...listing } }; },
  async readTicketApprovalState() {
    return { ticketAddress: TICKET, tokenId: TOKEN_ID, owner: chain.owner, marketplaceAddress: MARKETPLACE, isApproved: chain.approved === MARKETPLACE };
  },
  async readActiveListingForTicket() { return { activeListingId }; },
  async readUsdcAllowance({ owner }) {
    return { owner, marketplaceAddress: MARKETPLACE, usdcAddress: USDC, allowanceRaw: chain.allowance.toString() };
  },
  async refreshMarketplaceListingsCache() {},
});

const actionAuthorizationService = require('../src/services/actionAuthorizationService');
const circleActions = require('../src/services/circleActionExecutionService');
const engine = require('../src/services/circleExecutionEngine');
const transfers = require('../src/services/ticketTransferExecutionService');
const refunds = require('../src/services/refundExecutionService');
const claims = require('../src/services/claimExecutionService');
const marketplace = require('../src/services/marketplaceExecutionService');

const AUTH = {
  userId: USER_ID,
  executionMode: 'CIRCLE_USER_WALLET',
  walletAddress: WALLET,
  circleWalletId: CIRCLE_WALLET_ID,
};

// Scripted Circle: records every challenge creation and serves transactions.
function createFakeCircle() {
  const created = [];
  const circle = {
    created,
    challenges: new Map(),
    transactions: new Map(),
    listCalls: 0,
    getCalls: 0,
    async createContractExecutionChallenge(input) {
      created.push(input);
      const challengeId = `challenge-${input.idempotencyKey}`;
      circle.challenges.set(challengeId, { id: challengeId, status: 'PENDING', transactionId: null, refId: input.refId });
      return { challengeId };
    },
    async getContractExecutionChallenge({ challengeId }) {
      return circle.challenges.get(challengeId) || null;
    },
    async findContractExecutionTransaction({ refId }) {
      circle.listCalls += 1;
      return [...circle.transactions.values()].find((transaction) => transaction.refId === refId) || null;
    },
    async getContractExecutionTransaction({ id }) {
      circle.getCalls += 1;
      return circle.transactions.get(id) || null;
    },
    // Circle observed the user's approval of this challenge as a transaction.
    observe(challengeId, { txHash = null, state = 'SENT' } = {}) {
      const challenge = circle.challenges.get(challengeId);
      const id = crypto.randomUUID();
      circle.transactions.set(id, {
        id, refId: challenge.refId, walletId: CIRCLE_WALLET_ID, blockchain: 'ARC-TESTNET', state, txHash,
      });
      challenge.transactionId = id;
      return id;
    },
  };
  return circle;
}

function dependencies(circle, extra = {}) {
  return {
    circleService: circle,
    listArcEoa: async () => ({ id: CIRCLE_WALLET_ID, address: WALLET }),
    ...extra,
  };
}

function requestId() {
  return crypto.randomUUID();
}

async function createTransfer(overrides = {}) {
  return actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'TRANSFER_TICKET',
    userId: USER_ID,
    walletAddress: WALLET,
    circleWalletId: CIRCLE_WALLET_ID,
    requestId: overrides.requestId || requestId(),
    ticketAddress: TICKET,
    tokenId: TOKEN_ID,
    destinationAddress: overrides.destinationAddress || DESTINATION,
  });
}

async function main() {
  chain.owner = WALLET;

  // -------------------------------------------------------------------------
  // 1. Session binding, payload binding and request idempotency
  // -------------------------------------------------------------------------
  const firstRequest = requestId();
  const transferAction = await createTransfer({ requestId: firstRequest });
  const p = transferAction.payload;
  assert.equal(p.action, 'TRANSFER_TICKET');
  assert.equal(p.chainId, 5042002);
  assert.equal(p.executionMode, 'CIRCLE_USER_WALLET');
  assert.equal(p.contract, TICKET);
  assert.equal(p.tokenId, TOKEN_ID);
  assert.equal(p.from, WALLET);
  assert.equal(p.walletAddress, WALLET);
  assert.equal(p.destination, DESTINATION);
  assert.ok(p.nonce.length >= 16, 'nonce is bound');
  assert.ok(Date.parse(p.expiresAt) > Date.now(), 'expiry is bound');
  assert.equal(
    transferAction.payloadHash,
    crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex'),
    'payload hash binds the exact canonical payload',
  );
  const replayed = await createTransfer({ requestId: firstRequest });
  assert.equal(replayed.id, transferAction.id, 'the same request id returns the same financial intent');
  await rejectsCode(
    () => createTransfer({ requestId: firstRequest, destinationAddress: OTHER_WALLET }),
    'circle_request_id_conflict',
    'one request id can never represent a different destination',
  );
  const refundSameRequest = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'REFUND_TICKET', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: firstRequest, poolAddress: POOL, ticketAddress: TICKET, tokenId: TOKEN_ID,
    roundId: ROUND_ID, currentOwner: WALLET,
  });
  assert.notEqual(refundSameRequest.id, transferAction.id, 'action type is part of request identity');
  await rejectsCode(
    () => actionAuthorizationService.getCircleAction('TRANSFER_TICKET', USER_ID, transferAction.id, OTHER_WALLET, CIRCLE_WALLET_ID),
    'circle_action_authorization_invalid', 'a different session wallet cannot read the action',
  );
  await rejectsCode(
    () => actionAuthorizationService.getCircleAction('TRANSFER_TICKET', USER_ID, transferAction.id, WALLET, OTHER_CIRCLE_WALLET_ID),
    'circle_action_authorization_invalid', 'a different Circle wallet ID cannot read the action',
  );
  await rejectsCode(
    () => actionAuthorizationService.getCircleAction('CLAIM_REWARD', USER_ID, transferAction.id, WALLET, CIRCLE_WALLET_ID),
    'circle_action_authorization_invalid', 'the action type is bound',
  );
  await rejectsCode(
    () => engine.assertCircleTokenSession({ auth: AUTH, userToken: USER_TOKEN }, {
      listArcEoa: async () => ({ id: CIRCLE_WALLET_ID, address: OTHER_WALLET }),
    }),
    'circle_wallet_session_mismatch', 'a Circle token for a different wallet is refused',
  );
  await rejectsCode(
    () => engine.assertCircleTokenSession({ auth: AUTH, userToken: USER_TOKEN }, {
      listArcEoa: async () => ({ id: OTHER_CIRCLE_WALLET_ID, address: WALLET }),
    }),
    'circle_wallet_session_mismatch', 'a Circle token for a different Circle wallet ID is refused',
  );
  await rejectsCode(
    () => actionAuthorizationService.reserveCircleChallenge('TRANSFER_TICKET', USER_ID, transferAction.id, WALLET, CIRCLE_WALLET_ID, 'APPROVAL'),
    'circle_action_authorization_invalid', 'a transfer has no approval phase',
  );
  await rejectsCode(
    () => actionAuthorizationService.reserveCircleChallenge('TRANSFER_TICKET', USER_ID, transferAction.id, WALLET, CIRCLE_WALLET_ID, 'ENTRY'),
    'circle_action_authorization_invalid', 'the ENTRY phase belongs to ENTRY only',
  );
  console.log('CIRCLE_ACTION_BINDING=PASS');

  // -------------------------------------------------------------------------
  // 2. One phase Circle action (transfer): challenge idempotency, pending,
  //    reconciliation, verification and duplicate verification
  // -------------------------------------------------------------------------
  const circle = createFakeCircle();
  const started = await circleActions.startCircleAction(
    { actionType: 'TRANSFER_TICKET', action: transferAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(circle),
  );
  assert.equal(started.step, 'ACTION_READY');
  assert.equal(circle.created.length, 1);
  assert.equal(circle.created[0].contractAddress, TICKET, 'challenge targets the ticket contract');
  assert.equal(
    circle.created[0].callData,
    TICKET_IFACE.encodeFunctionData('safeTransferFrom', [WALLET, DESTINATION, BigInt(TOKEN_ID)]),
    'challenge carries the exact safeTransferFrom calldata',
  );
  assert.equal(circle.created[0].refId, `${transferAction.id}:action`);
  const restarted = await circleActions.startCircleAction(
    { actionType: 'TRANSFER_TICKET', action: transferAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(circle),
  );
  assert.equal(restarted.challengeId, started.challengeId, 'a replayed start returns the saved challenge');
  assert.equal(circle.created.length, 1, 'no second Circle challenge is ever created');

  const notObserved = await circleActions.verifyCircleAction(
    { actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: transferAction.id, userToken: USER_TOKEN },
    dependencies(circle),
  );
  assert.deepEqual(notObserved, { pending: true, transactionObserved: false });
  const circleTxId = circle.observe(started.challengeId);
  const observedNoHash = await circleActions.verifyCircleAction(
    { actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: transferAction.id, userToken: USER_TOKEN },
    dependencies(circle),
  );
  assert.deepEqual(observedNoHash, { pending: true, transactionObserved: true });
  assert.equal(rows.get(transferAction.id).circle_entry_transaction_id, circleTxId, 'the Circle transaction ID persists');

  // Mined but not yet visible to Arc: stays pending, never resends.
  circle.transactions.get(circleTxId).txHash = `0x${'ab'.repeat(32)}`;
  const receiptPending = await circleActions.verifyCircleAction(
    { actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: transferAction.id, userToken: USER_TOKEN },
    dependencies(circle),
  );
  assert.deepEqual(receiptPending, { pending: true, transactionObserved: true });
  assert.equal(rows.get(transferAction.id).verified_tx_hash, `0x${'ab'.repeat(32)}`, 'the tx hash persists once known');
  assert.equal(circle.created.length, 1, 'an uncertain result never creates another challenge');

  // The real mined transfer, then verification of the exact receipt.
  const transferHash = `0x${'ab'.repeat(32)}`;
  chain.transactions.set(transferHash, {
    tx: {
      hash: transferHash, from: WALLET, to: TICKET, value: 0n,
      data: TICKET_IFACE.encodeFunctionData('safeTransferFrom', [WALLET, DESTINATION, BigInt(TOKEN_ID)]),
    },
    receipt: { status: 1, blockNumber: 50, logs: [] },
  });
  chain.owner = DESTINATION;
  const transferVerified = await circleActions.verifyCircleAction(
    { actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: transferAction.id, userToken: USER_TOKEN },
    dependencies(circle),
  );
  assert.equal(transferVerified.pending, false);
  assert.equal(transferVerified.result.executionMode, 'CIRCLE_USER_WALLET');
  assert.equal(transferVerified.result.ownerAfter, DESTINATION);
  assert.equal(rows.get(transferAction.id).circle_state, 'VERIFIED');
  const getCallsBefore = circle.getCalls;
  const duplicateVerified = await circleActions.verifyCircleAction(
    { actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: transferAction.id, userToken: USER_TOKEN },
    dependencies(circle),
  );
  assert.deepEqual(duplicateVerified.result, transferVerified.result, 'duplicate verification is idempotent');
  assert.ok(circle.getCalls > getCallsBefore, 'a persisted Circle transaction ID is looked up directly');
  assert.equal(circle.created.length, 1);
  await rejectsCode(
    () => actionAuthorizationService.bindCircleTransaction('TRANSFER_TICKET', USER_ID, transferAction.id, WALLET, CIRCLE_WALLET_ID, 'ACTION', {
      id: crypto.randomUUID(), txHash: `0x${'cd'.repeat(32)}`,
    }),
    'circle_action_authorization_invalid', 'a submitted Circle transaction is never replaced',
  );
  console.log('CIRCLE_ONE_PHASE_ACTION=PASS');

  // -------------------------------------------------------------------------
  // 3. Crash after durable reservation retries the SAME Circle request
  // -------------------------------------------------------------------------
  chain.owner = WALLET;
  const crashAction = await createTransfer();
  await actionAuthorizationService.reserveCircleChallenge('TRANSFER_TICKET', USER_ID, crashAction.id, WALLET, CIRCLE_WALLET_ID, 'ACTION');
  const reservedKey = rows.get(crashAction.id).circle_entry_idempotency_key;
  const crashCircle = createFakeCircle();
  const recovered = await circleActions.startCircleAction(
    { actionType: 'TRANSFER_TICKET', action: crashAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(crashCircle),
  );
  assert.equal(crashCircle.created[0].idempotencyKey, reservedKey, 'the reserved idempotency key is reused');
  assert.equal(recovered.challengeId, `challenge-${reservedKey}`);
  console.log('CIRCLE_NO_BLIND_RESUBMISSION=PASS');

  // -------------------------------------------------------------------------
  // 4. Failed and expired challenges
  // -------------------------------------------------------------------------
  const failCircle = createFakeCircle();
  const failAction = await createTransfer();
  const failStart = await circleActions.startCircleAction(
    { actionType: 'TRANSFER_TICKET', action: failAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(failCircle),
  );
  failCircle.challenges.get(failStart.challengeId).status = 'FAILED';
  await rejectsCode(
    () => circleActions.verifyCircleAction({ actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: failAction.id, userToken: USER_TOKEN }, dependencies(failCircle)),
    'circle_transaction_failed',
  );
  failCircle.challenges.get(failStart.challengeId).status = 'EXPIRED';
  await rejectsCode(
    () => circleActions.verifyCircleAction({ actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: failAction.id, userToken: USER_TOKEN }, dependencies(failCircle)),
    'circle_transaction_failed', 'an expired Circle challenge is terminal',
  );
  const deniedCircle = createFakeCircle();
  const deniedAction = await createTransfer();
  const deniedStart = await circleActions.startCircleAction(
    { actionType: 'TRANSFER_TICKET', action: deniedAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(deniedCircle),
  );
  deniedCircle.observe(deniedStart.challengeId, { state: 'DENIED' });
  await rejectsCode(
    () => circleActions.verifyCircleAction({ actionType: 'TRANSFER_TICKET', auth: AUTH, actionId: deniedAction.id, userToken: USER_TOKEN }, dependencies(deniedCircle)),
    'circle_transaction_failed',
  );

  const expiredAction = await createTransfer();
  rows.get(expiredAction.id).expires_at = new Date(Date.now() - 1000);
  const expiredCircle = createFakeCircle();
  await rejectsCode(
    () => circleActions.startCircleAction({ actionType: 'TRANSFER_TICKET', action: expiredAction, auth: AUTH, userToken: USER_TOKEN }, dependencies(expiredCircle)),
    'circle_action_authorization_invalid', 'an expired authorization can never reserve a challenge',
  );
  assert.equal(expiredCircle.created.length, 0, 'an expired action never creates a Circle challenge');
  await rejectsCode(
    () => transfers.buildCircleTransferTransactionRequest({
      ...expiredAction.payload, expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
    'action_authorization_expired', 'an expired bound payload never builds a transaction',
  );
  console.log('CIRCLE_FAILED_EXPIRED=PASS');

  // -------------------------------------------------------------------------
  // 5. Two phase MARKETPLACE_LIST: exact per token approval, then list
  // -------------------------------------------------------------------------
  chain.owner = WALLET;
  chain.approved = ethers.ZeroAddress;
  const listAction = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'MARKETPLACE_LIST', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: requestId(), marketplaceAddress: MARKETPLACE, ticketAddress: TICKET, tokenId: TOKEN_ID,
    askUsdcRaw: ASK.toString(),
  });
  const listCircle = createFakeCircle();
  const listStart = await circleActions.startCircleAction(
    { actionType: 'MARKETPLACE_LIST', action: listAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(listCircle),
  );
  assert.equal(listStart.step, 'APPROVAL_REQUIRED');
  assert.equal(listCircle.created[0].contractAddress, TICKET);
  assert.equal(
    listCircle.created[0].callData,
    TICKET_IFACE.encodeFunctionData('approve', [MARKETPLACE, BigInt(TOKEN_ID)]),
    'the approval is exactly approve(marketplace, tokenId)',
  );
  const approvalHash = mine({
    from: WALLET, to: TICKET, data: TICKET_IFACE.encodeFunctionData('approve', [MARKETPLACE, BigInt(TOKEN_ID)]),
  });
  const approvalTxId = listCircle.observe(listStart.challengeId, { txHash: approvalHash });
  // The approval is mined but getApproved does not reflect it: never list.
  await rejectsCode(
    () => circleActions.verifyCircleActionApproval({ actionType: 'MARKETPLACE_LIST', auth: AUTH, actionId: listAction.id, userToken: USER_TOKEN }, dependencies(listCircle)),
    'marketplace_approval_failed', 'list() is never issued before the approval is verified onchain',
  );
  assert.equal(listCircle.created.length, 1);
  chain.approved = MARKETPLACE;
  const approvalVerified = await circleActions.verifyCircleActionApproval(
    { actionType: 'MARKETPLACE_LIST', auth: AUTH, actionId: listAction.id, userToken: USER_TOKEN },
    dependencies(listCircle),
  );
  assert.equal(approvalVerified.step, 'ACTION_READY');
  assert.equal(approvalVerified.approvalTxHash, approvalHash);
  assert.equal(listCircle.created.length, 2);
  assert.equal(listCircle.created[1].contractAddress, MARKETPLACE);
  assert.equal(
    listCircle.created[1].callData,
    MARKETPLACE_IFACE.encodeFunctionData('list', [TICKET, BigInt(TOKEN_ID), ASK]),
  );
  assert.equal(rows.get(listAction.id).circle_approval_transaction_id, approvalTxId);
  const approvalDuplicate = await circleActions.verifyCircleActionApproval(
    { actionType: 'MARKETPLACE_LIST', auth: AUTH, actionId: listAction.id, userToken: USER_TOKEN },
    dependencies(listCircle),
  );
  assert.equal(approvalDuplicate.challengeId, approvalVerified.challengeId);
  assert.equal(listCircle.created.length, 2, 'a duplicate approval verify never creates another challenge');
  const listHash = mine({
    from: WALLET, to: MARKETPLACE, data: MARKETPLACE_IFACE.encodeFunctionData('list', [TICKET, BigInt(TOKEN_ID), ASK]),
    logs: [log(MARKETPLACE_IFACE, MARKETPLACE, 'Listed', [5n, WALLET, TICKET, BigInt(TOKEN_ID), ASK, BigInt(ROUND_ID)])],
  });
  listCircle.observe(approvalVerified.challengeId, { txHash: listHash });
  const listVerified = await circleActions.verifyCircleAction(
    { actionType: 'MARKETPLACE_LIST', auth: AUTH, actionId: listAction.id, userToken: USER_TOKEN },
    dependencies(listCircle),
  );
  assert.equal(listVerified.result.listingId, '5');
  assert.equal(listVerified.result.executionMode, 'CIRCLE_USER_WALLET');
  console.log('CIRCLE_TWO_PHASE_LIST=PASS');

  // An expired action may still reconcile an already observed approval but
  // can never issue the action challenge afterwards.
  chain.approved = ethers.ZeroAddress;
  const lateList = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'MARKETPLACE_LIST', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: requestId(), marketplaceAddress: MARKETPLACE, ticketAddress: TICKET, tokenId: TOKEN_ID,
    askUsdcRaw: ASK.toString(),
  });
  const lateCircle = createFakeCircle();
  const lateStart = await circleActions.startCircleAction(
    { actionType: 'MARKETPLACE_LIST', action: lateList, auth: AUTH, userToken: USER_TOKEN },
    dependencies(lateCircle),
  );
  const lateApprovalHash = mine({
    from: WALLET, to: TICKET, data: TICKET_IFACE.encodeFunctionData('approve', [MARKETPLACE, BigInt(TOKEN_ID)]),
  });
  lateCircle.observe(lateStart.challengeId, { txHash: lateApprovalHash });
  chain.approved = MARKETPLACE;
  rows.get(lateList.id).expires_at = new Date(Date.now() - 1000);
  await rejectsCode(
    () => circleActions.verifyCircleActionApproval({ actionType: 'MARKETPLACE_LIST', auth: AUTH, actionId: lateList.id, userToken: USER_TOKEN }, dependencies(lateCircle)),
    'circle_action_expired_after_approval',
  );
  assert.equal(rows.get(lateList.id).circle_state, 'APPROVAL_VERIFIED', 'the observed approval is still reconciled');
  assert.equal(lateCircle.created.length, 1, 'no action challenge after expiry');
  console.log('CIRCLE_EXPIRY_RECONCILES_OBSERVED=PASS');

  // -------------------------------------------------------------------------
  // 6. MARKETPLACE_BUY: sufficient allowance skips approval; insufficient
  //    allowance approves the exact ask; stale data never buys
  // -------------------------------------------------------------------------
  resetListing();
  chain.owner = SELLER;
  chain.allowance = ASK;
  const buyAction = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'MARKETPLACE_BUY', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: requestId(), marketplaceAddress: MARKETPLACE, listingId: LISTING_ID, ticketAddress: TICKET,
    tokenId: TOKEN_ID, sellerAddress: SELLER, expectedAskUsdcRaw: ASK.toString(),
  });
  const buyCircle = createFakeCircle();
  const buyStart = await circleActions.startCircleAction(
    { actionType: 'MARKETPLACE_BUY', action: buyAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(buyCircle),
  );
  assert.equal(buyStart.step, 'ACTION_READY', 'an existing sufficient allowance skips the approval phase');
  assert.equal(buyCircle.created[0].callData, MARKETPLACE_IFACE.encodeFunctionData('buy', [BigInt(LISTING_ID), ASK]));

  chain.allowance = 0n;
  const buyApprovalAction = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'MARKETPLACE_BUY', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: requestId(), marketplaceAddress: MARKETPLACE, listingId: LISTING_ID, ticketAddress: TICKET,
    tokenId: TOKEN_ID, sellerAddress: SELLER, expectedAskUsdcRaw: ASK.toString(),
  });
  const buyApprovalCircle = createFakeCircle();
  const buyApprovalStart = await circleActions.startCircleAction(
    { actionType: 'MARKETPLACE_BUY', action: buyApprovalAction, auth: AUTH, userToken: USER_TOKEN },
    dependencies(buyApprovalCircle),
  );
  assert.equal(buyApprovalStart.step, 'APPROVAL_REQUIRED');
  assert.equal(buyApprovalCircle.created[0].contractAddress, USDC);
  assert.equal(buyApprovalCircle.created[0].callData, USDC_IFACE.encodeFunctionData('approve', [MARKETPLACE, ASK]),
    'the USDC approval is exactly the expected ask');
  const usdcApprovalHash = mine({ from: WALLET, to: USDC, data: USDC_IFACE.encodeFunctionData('approve', [MARKETPLACE, ASK]) });
  buyApprovalCircle.observe(buyApprovalStart.challengeId, { txHash: usdcApprovalHash });
  chain.allowance = ASK;
  resetListing({ askUsdcRaw: '5000000' });
  await rejectsCode(
    () => circleActions.verifyCircleActionApproval({ actionType: 'MARKETPLACE_BUY', auth: AUTH, actionId: buyApprovalAction.id, userToken: USER_TOKEN }, dependencies(buyApprovalCircle)),
    'marketplace_price_changed', 'the listing is refetched after approval and a changed ask never buys',
  );
  assert.equal(buyApprovalCircle.created.length, 1, 'no purchase challenge on stale price');
  resetListing({ onchainStatus: 'SOLD', state: 'SOLD', isBuyable: false });
  await rejectsCode(
    () => marketplace.buildCircleBuyTransactionRequest(buyApprovalAction.payload),
    'marketplace_listing_not_active',
  );
  resetListing({ isBuyable: false, state: 'ACTION_NEEDED' });
  await rejectsCode(() => marketplace.buildCircleBuyTransactionRequest(buyApprovalAction.payload), 'marketplace_listing_not_buyable');
  resetListing({ seller: WALLET, currentOwner: WALLET });
  await rejectsCode(() => marketplace.buildCircleBuyTransactionRequest(buyApprovalAction.payload), 'marketplace_buyer_is_seller');
  resetListing();
  chain.usdcBalance = 1n;
  await rejectsCode(() => marketplace.prepareCircleBuyApproval(buyApprovalAction.payload), 'marketplace_insufficient_usdc');
  await rejectsCode(() => marketplace.buildCircleBuyTransactionRequest(buyApprovalAction.payload), 'marketplace_insufficient_usdc');
  chain.usdcBalance = 10_000_000n;
  const resumedBuy = await circleActions.verifyCircleActionApproval(
    { actionType: 'MARKETPLACE_BUY', auth: AUTH, actionId: buyApprovalAction.id, userToken: USER_TOKEN },
    dependencies(buyApprovalCircle),
  );
  assert.equal(resumedBuy.step, 'ACTION_READY');
  const soldLogs = [
    log(USDC_IFACE, USDC, 'Transfer', [WALLET, SELLER, ASK]),
    log(TICKET_IFACE, TICKET, 'Transfer', [SELLER, WALLET, BigInt(TOKEN_ID)]),
    log(MARKETPLACE_IFACE, MARKETPLACE, 'Sold', [BigInt(LISTING_ID), SELLER, WALLET, TICKET, BigInt(TOKEN_ID), ASK]),
  ];
  const buyData = MARKETPLACE_IFACE.encodeFunctionData('buy', [BigInt(LISTING_ID), ASK]);
  const buyHash = mine({ from: WALLET, to: MARKETPLACE, data: buyData, logs: soldLogs });
  buyApprovalCircle.observe(resumedBuy.challengeId, { txHash: buyHash });
  const bought = await circleActions.verifyCircleAction(
    { actionType: 'MARKETPLACE_BUY', auth: AUTH, actionId: buyApprovalAction.id, userToken: USER_TOKEN },
    dependencies(buyApprovalCircle),
  );
  assert.equal(bought.result.buyer, WALLET);
  assert.equal(bought.result.askUsdcRaw, ASK.toString());
  const noSettlement = mine({ from: WALLET, to: MARKETPLACE, data: buyData, logs: [soldLogs[2]] });
  await rejectsCode(() => marketplace.verifyCircleBuyReceipt(buyApprovalAction.payload, noSettlement), 'marketplace_usdc_settlement_missing');
  const noTicketMove = mine({ from: WALLET, to: MARKETPLACE, data: buyData, logs: [soldLogs[0], soldLogs[2]] });
  await rejectsCode(() => marketplace.verifyCircleBuyReceipt(buyApprovalAction.payload, noTicketMove), 'marketplace_ticket_transfer_missing');
  console.log('CIRCLE_TWO_PHASE_BUY=PASS');

  // -------------------------------------------------------------------------
  // 7. Strict receipt verification for every Circle action
  // -------------------------------------------------------------------------
  const receiptCases = [];
  function addCases(name, verify, payload, good) {
    receiptCases.push([`${name} sender`, verify, payload, { ...good, from: OTHER_WALLET }, /_sender_mismatch$/]);
    receiptCases.push([`${name} target`, verify, payload, { ...good, to: OTHER_WALLET }, /_target_mismatch$/]);
    receiptCases.push([`${name} calldata`, verify, payload, { ...good, data: `${good.data}00` }, /_calldata_mismatch$/]);
    receiptCases.push([`${name} value`, verify, payload, { ...good, value: 1n }, /_value_mismatch$/]);
    receiptCases.push([`${name} reverted`, verify, payload, { ...good, status: 0 }, /_transaction_failed$/]);
  }
  addCases('transfer', transfers.verifyCircleTransferReceipt, transferAction.payload, {
    from: WALLET, to: TICKET, data: TICKET_IFACE.encodeFunctionData('safeTransferFrom', [WALLET, DESTINATION, BigInt(TOKEN_ID)]),
  });
  addCases('list', marketplace.verifyCircleListReceipt, listAction.payload, {
    from: WALLET, to: MARKETPLACE, data: MARKETPLACE_IFACE.encodeFunctionData('list', [TICKET, BigInt(TOKEN_ID), ASK]),
  });
  addCases('buy', marketplace.verifyCircleBuyReceipt, buyApprovalAction.payload, { from: WALLET, to: MARKETPLACE, data: buyData });
  for (const [name, verify, payload, txShape, expected] of receiptCases) {
    const hash = mine(txShape);
    await assert.rejects(() => verify(payload, hash), expected, name);
  }
  // Mode binding: a Circle verifier never accepts a connected wallet payload
  // and a connected wallet verifier never accepts a Circle payload.
  const goodTransferHash = mine({
    from: WALLET, to: TICKET, data: TICKET_IFACE.encodeFunctionData('safeTransferFrom', [WALLET, DESTINATION, BigInt(TOKEN_ID)]),
  });
  await rejectsCode(() => transfers.verifyExternalTransferReceipt(transferAction.payload, goodTransferHash), 'transfer_execution_mode_mismatch');
  await rejectsCode(
    () => transfers.verifyCircleTransferReceipt({ ...transferAction.payload, executionMode: 'EXTERNAL_WALLET' }, goodTransferHash),
    'transfer_execution_mode_mismatch',
  );
  chain.owner = OTHER_WALLET;
  await rejectsCode(() => transfers.verifyCircleTransferReceipt(transferAction.payload, goodTransferHash), 'transfer_postcondition_failed');
  await rejectsCode(() => transfers.buildCircleTransferTransactionRequest(transferAction.payload), 'transfer_not_ticket_owner',
    'owner changed before the action: no transaction is built');
  console.log('CIRCLE_RECEIPT_MISMATCH_REJECTED=PASS');

  // -------------------------------------------------------------------------
  // 8. Refund and claim: authoritative state, exact calldata, events
  // -------------------------------------------------------------------------
  chain.owner = WALLET;
  const refundAction = refundSameRequest;
  const refundBuilt = await refunds.buildCircleRefundTransactionRequest(refundAction.payload);
  assert.equal(refundBuilt.to, POOL);
  assert.equal(refundBuilt.data, POOL_IFACE.encodeFunctionData('refund', [BigInt(TOKEN_ID)]));
  refundState.isRefunded = true;
  await rejectsCode(() => refunds.buildCircleRefundTransactionRequest(refundAction.payload), 'refund_already_refunded');
  refundState.isRefunded = false;
  refundState.roundStatus = 'SETTLED';
  await rejectsCode(() => refunds.buildCircleRefundTransactionRequest(refundAction.payload), 'refund_round_not_cancelled');
  refundState.roundStatus = 'CANCELLED';
  refundState.currentOwner = OTHER_WALLET;
  await rejectsCode(() => refunds.buildCircleRefundTransactionRequest(refundAction.payload), 'refund_owner_mismatch');
  refundState.currentOwner = WALLET;
  const refundHash = mine({
    from: WALLET, to: POOL, data: refundBuilt.data,
    logs: [
      log(USDC_IFACE, USDC, 'Transfer', [POOL, WALLET, 1_000_000n]),
      log(POOL_IFACE, POOL, 'RefundClaimed', [BigInt(ROUND_ID), BigInt(TOKEN_ID), WALLET, 1_000_000n]),
    ],
  });
  refundState.isRefunded = true;
  const refunded = await refunds.verifyCircleRefundReceipt(refundAction.payload, refundHash);
  assert.equal(refunded.executionMode, 'CIRCLE_USER_WALLET');
  assert.equal(refunded.currentOwner, WALLET);
  const refundNoEvent = mine({ from: WALLET, to: POOL, data: refundBuilt.data, logs: [] });
  await rejectsCode(() => refunds.verifyCircleRefundReceipt(refundAction.payload, refundNoEvent), 'refund_transfer_event_missing');
  refundState.isRefunded = false;
  await rejectsCode(() => refunds.verifyCircleRefundReceipt(refundAction.payload, refundHash), 'refund_postcondition_failed');

  const claimAction = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'CLAIM_REWARD', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: requestId(), poolAddress: POOL, ticketAddress: TICKET, tokenId: TOKEN_ID, roundId: ROUND_ID,
    currentOwner: WALLET, amountRaw: '2160000',
  });
  assert.equal(claimAction.payload.amountRaw, '2160000', 'the claim amount is bound');
  const claimBuilt = await claims.buildCircleClaimTransactionRequest(claimAction.payload);
  assert.equal(claimBuilt.data, POOL_IFACE.encodeFunctionData('claim', [BigInt(TOKEN_ID)]));
  claimState.isClaimed = true;
  await rejectsCode(() => claims.buildCircleClaimTransactionRequest(claimAction.payload), 'claim_already_claimed');
  claimState.isClaimed = false;
  claimState.claimableRaw = '1';
  await rejectsCode(() => claims.buildCircleClaimTransactionRequest(claimAction.payload), 'claim_amount_mismatch');
  claimState.claimableRaw = '2160000';
  const claimHash = mine({
    from: WALLET, to: POOL, data: claimBuilt.data,
    logs: [
      log(USDC_IFACE, USDC, 'Transfer', [POOL, WALLET, 2_160_000n]),
      log(POOL_IFACE, POOL, 'RewardClaimed', [BigInt(ROUND_ID), BigInt(TOKEN_ID), WALLET, 2_160_000n]),
    ],
  });
  claimState.isClaimed = true;
  claimState.claimableRaw = '0';
  const claimed = await claims.verifyCircleClaimReceipt(claimAction.payload, claimHash);
  assert.equal(claimed.amountRaw, '2160000');
  assert.equal(claimed.executionMode, 'CIRCLE_USER_WALLET');
  const claimWrongSender = mine({ from: OTHER_WALLET, to: POOL, data: claimBuilt.data });
  await rejectsCode(() => claims.verifyCircleClaimReceipt(claimAction.payload, claimWrongSender), 'claim_sender_mismatch');
  console.log('CIRCLE_REFUND_CLAIM=PASS');

  // -------------------------------------------------------------------------
  // 9. Update price and cancel: seller, active listing, exact calldata
  // -------------------------------------------------------------------------
  resetListing({ seller: WALLET, currentOwner: WALLET });
  const updateAction = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'MARKETPLACE_UPDATE_PRICE', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: requestId(), marketplaceAddress: MARKETPLACE, listingId: LISTING_ID, ticketAddress: TICKET,
    tokenId: TOKEN_ID, newAskUsdcRaw: '6000000',
  });
  const updateBuilt = await marketplace.buildCircleUpdatePriceTransactionRequest(updateAction.payload);
  assert.equal(updateBuilt.data, MARKETPLACE_IFACE.encodeFunctionData('updatePrice', [BigInt(LISTING_ID), 6_000_000n]));
  resetListing();
  await rejectsCode(() => marketplace.buildCircleUpdatePriceTransactionRequest(updateAction.payload), 'marketplace_not_listing_seller');
  resetListing({ seller: WALLET, currentOwner: WALLET, onchainStatus: 'CANCELLED' });
  await rejectsCode(() => marketplace.buildCircleUpdatePriceTransactionRequest(updateAction.payload), 'marketplace_listing_not_active');

  resetListing({ seller: WALLET, currentOwner: WALLET, isApproved: false });
  const cancelAction = await actionAuthorizationService.createOrGetCircleActionRequest({
    actionType: 'MARKETPLACE_CANCEL', userId: USER_ID, walletAddress: WALLET, circleWalletId: CIRCLE_WALLET_ID,
    requestId: requestId(), marketplaceAddress: MARKETPLACE, listingId: LISTING_ID, ticketAddress: TICKET, tokenId: TOKEN_ID,
  });
  const cancelBuilt = await marketplace.buildCircleCancelTransactionRequest(cancelAction.payload);
  assert.equal(cancelBuilt.data, MARKETPLACE_IFACE.encodeFunctionData('cancel', [BigInt(LISTING_ID)]),
    'cancel needs no NFT approval');
  const cancelHash = mine({
    from: WALLET, to: MARKETPLACE, data: cancelBuilt.data,
    logs: [log(MARKETPLACE_IFACE, MARKETPLACE, 'Cancelled', [BigInt(LISTING_ID)])],
  });
  const cancelled = await marketplace.verifyCircleCancelReceipt(cancelAction.payload, cancelHash);
  assert.equal(cancelled.listingId, LISTING_ID);
  chain.approved = ethers.ZeroAddress;
  await rejectsCode(() => marketplace.buildCircleListTransactionRequest(listAction.payload), 'marketplace_token_not_approved',
    'a missing or revoked NFT approval never builds list()');
  console.log('CIRCLE_UPDATE_CANCEL=PASS');

  for (const actionType of ['TRANSFER_TICKET', 'REFUND_TICKET', 'CLAIM_REWARD', 'MARKETPLACE_LIST', 'MARKETPLACE_UPDATE_PRICE', 'MARKETPLACE_CANCEL', 'MARKETPLACE_BUY']) {
    assert.ok(circleActions.CIRCLE_ACTION_TYPES.includes(actionType), `${actionType} is a supported Circle action`);
  }
  console.log('CIRCLE_ACTIONS=PASS');
}

main().catch((error) => {
  console.error('CIRCLE_ACTIONS=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
