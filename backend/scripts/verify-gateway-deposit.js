'use strict';

// Deterministic proof for the Gateway SOURCE deposit state machine
// (USDC.approve(GatewayWallet, amount) then GatewayWallet.deposit(token,
// amount)), for both human execution modes. Every adapter below (DB, Circle,
// source chain, Gateway) is a fake; global.fetch is poisoned so a real
// network call fails the run instead of silently succeeding.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

let liveNetworkCalls = 0;
global.fetch = async () => {
  liveNetworkCalls += 1;
  throw new Error('live network disabled in deterministic verifier');
};

const { createGatewayDepositService } = require('../src/services/gatewayDepositService');
const circleExecutionEngine = require('../src/services/circleExecutionEngine');
const gatewayServiceForDeposit = require('../src/services/gatewayService');

const DOMAIN = 6;
const CHAIN_ID = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const AMOUNT = '1000000';

const USDC_INTERFACE = new ethers.Interface([
  'function approve(address spender,uint256 amount) returns (bool)',
]);
const GATEWAY_INTERFACE = new ethers.Interface([
  'function deposit(address token,uint256 value)',
]);

// ---------------------------------------------------------------------------
// Minimal generic fake Postgres: real WHERE/SET evaluation over an in-memory
// Map, so the service's actual SQL exercises real idempotency/CAS logic
// instead of a hand-matched string per query.
// ---------------------------------------------------------------------------

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function literalOrParam(token, params) {
  const trimmed = token.trim();
  const paramMatch = /^\$(\d+)$/.exec(trimmed);
  if (paramMatch) return params[Number(paramMatch[1]) - 1];
  if (trimmed === 'NULL') return null;
  const quoted = /^'(.*)'$/.exec(trimmed);
  if (quoted) return quoted[1];
  return trimmed;
}

function evalCondition(row, cond, params) {
  const trimmed = cond.trim();
  let m;
  if ((m = /^lower\((\w+)\)\s*=\s*lower\(\$(\d+)\)$/i.exec(trimmed))) {
    return String(row[m[1]] ?? '').toLowerCase() === String(params[Number(m[2]) - 1] ?? '').toLowerCase();
  }
  if ((m = /^(\w+)\s+IS\s+NULL$/i.exec(trimmed))) return row[m[1]] == null;
  if ((m = /^(\w+)\s+NOT IN\s*\(([^)]+)\)$/i.exec(trimmed))) {
    const values = m[2].split(',').map((v) => literalOrParam(v, params));
    return !values.includes(row[m[1]]);
  }
  if ((m = /^(\w+)\s+IN\s*\(([^)]+)\)$/i.exec(trimmed))) {
    const values = m[2].split(',').map((v) => literalOrParam(v, params));
    return values.includes(row[m[1]]);
  }
  if ((m = /^(\w+)\s*=\s*(.+)$/.exec(trimmed))) {
    return row[m[1]] === literalOrParam(m[2], params);
  }
  throw new Error(`fake db: unhandled WHERE condition: ${trimmed}`);
}

function evalWhere(row, sql, params) {
  const match = /WHERE\s+([\s\S]+?)(?:\s+RETURNING\s+\*|\s+LIMIT\s+\d+|$)/i.exec(sql);
  if (!match) return true;
  return match[1].split(/\bAND\b/i).every((cond) => evalCondition(row, cond, params));
}

function applySet(row, sql, params) {
  const match = /SET\s+([\s\S]+?)\s+WHERE/i.exec(sql);
  if (!match) return;
  for (const raw of splitTopLevel(match[1])) {
    const eq = raw.indexOf('=');
    const col = raw.slice(0, eq).trim();
    const rhs = raw.slice(eq + 1).trim();
    if (col === 'updated_at') continue;
    const coalesce = /^COALESCE\((\w+)\s*,\s*(.+)\)$/i.exec(rhs);
    if (coalesce) {
      if (row[coalesce[1]] == null) row[col] = literalOrParam(coalesce[2], params);
      continue;
    }
    if (/^NOW\(\)$/i.test(rhs)) continue;
    row[col] = literalOrParam(rhs, params);
  }
}

function createFakeDatabase() {
  const rows = new Map();
  const copy = (row) => (row ? { ...row } : null);

  return {
    rows,
    async query(sqlText, params = []) {
      const sql = sqlText.replace(/\s+/g, ' ').trim();

      if (/^INSERT INTO gateway_deposit_actions/i.test(sql)) {
        const [
          id, userId, requestId, executionMode, walletAddress,
          sourceDomain, sourceChainId, amountRaw, expiresAt,
        ] = params;
        const exists = [...rows.values()].some(
          (row) => row.user_id === userId && row.request_id === requestId,
        );
        if (!exists) {
          rows.set(id, {
            id, user_id: userId, request_id: requestId, execution_mode: executionMode,
            wallet_address: walletAddress, source_domain: sourceDomain, source_chain_id: sourceChainId,
            amount_raw: amountRaw, source_circle_wallet_id: null, baseline_domain_balance_raw: null,
            approval_tx_hash: null, approval_circle_challenge_id: null,
            approval_circle_idempotency_key: null, approval_circle_ref_id: null,
            approval_circle_transaction_id: null,
            deposit_tx_hash: null, deposit_circle_challenge_id: null,
            deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
            deposit_circle_transaction_id: null,
            state: 'STARTED', last_error: null, expires_at: expiresAt,
          });
        }
        return { rows: [], rowCount: exists ? 0 : 1 };
      }

      const isSelect = /^SELECT/i.test(sql);
      const hasReturning = /RETURNING\s+\*/i.test(sql);
      const isUpdate = /^UPDATE/i.test(sql);

      const matches = [...rows.values()].filter((row) => evalWhere(row, sql, params));
      if (isSelect) {
        return { rows: matches.length ? [copy(matches[0])] : [], rowCount: matches.length ? 1 : 0 };
      }
      if (isUpdate) {
        if (!matches.length) return { rows: [], rowCount: 0 };
        const row = matches[0];
        applySet(row, sql, params);
        return { rows: hasReturning ? [copy(row)] : [], rowCount: 1 };
      }
      throw new Error(`fake db: unhandled SQL: ${sql}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake source chain (stands in for baseSepoliaService)
// ---------------------------------------------------------------------------

function createFakeSourceChain() {
  const state = { balanceRaw: '5000000', allowanceRaw: '0' };
  const approveRequest = ({ from, amountRaw }) => ({
    chainId: CHAIN_ID, from: ethers.getAddress(from), to: USDC,
    data: USDC_INTERFACE.encodeFunctionData('approve', [GATEWAY_WALLET, amountRaw]),
    value: '0x0',
  });
  const depositRequest = ({ from, amountRaw }) => ({
    chainId: CHAIN_ID, from: ethers.getAddress(from), to: GATEWAY_WALLET,
    data: GATEWAY_INTERFACE.encodeFunctionData('deposit', [USDC, amountRaw]),
    value: '0x0',
  });
  const transactions = new Map();

  function mineApproval(txHash, from, amountRaw, { badCalldata = false, badTo = false, failed = false } = {}) {
    const request = approveRequest({ from, amountRaw });
    transactions.set(txHash, {
      tx: {
        from,
        to: badTo ? GATEWAY_WALLET : request.to,
        value: 0n,
        data: badCalldata ? '0xdeadbeef' : request.data,
      },
      receipt: { status: failed ? 0 : 1 },
    });
  }

  function mineDeposit(txHash, from, amountRaw, { badCalldata = false, failed = false } = {}) {
    const request = depositRequest({ from, amountRaw });
    transactions.set(txHash, {
      tx: {
        from,
        to: request.to,
        value: 0n,
        data: badCalldata ? '0xdeadbeef' : request.data,
      },
      receipt: { status: failed ? 0 : 1 },
    });
  }

  return {
    chainId: CHAIN_ID,
    circleBlockchain: 'BASE-SEPOLIA',
    usdcAddress: USDC,
    state,
    mineApproval,
    mineDeposit,
    async readChainState() {
      return { balanceRaw: state.balanceRaw, allowanceRaw: state.allowanceRaw };
    },
    buildApprove: approveRequest,
    buildDeposit: depositRequest,
    assertTransaction(tx, request) {
      if (ethers.getAddress(tx.from).toLowerCase() !== request.from.toLowerCase()) {
        throw new Error('gateway_deposit_sender_mismatch');
      }
      if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== request.to.toLowerCase()) {
        throw new Error('gateway_deposit_target_mismatch');
      }
      if (tx.value !== 0n) throw new Error('gateway_deposit_value_mismatch');
      if (String(tx.data).toLowerCase() !== request.data.toLowerCase()) {
        throw new Error('gateway_deposit_calldata_mismatch');
      }
    },
    async readTransaction(txHash, notFoundError, failureError) {
      const found = transactions.get(txHash);
      if (!found) throw new Error(notFoundError);
      if (found.receipt.status !== 1) throw new Error(failureError);
      return found;
    },
  };
}

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error?.message === code);
}

// ---------------------------------------------------------------------------
// External wallet branch
// ---------------------------------------------------------------------------

async function verifyExternalBranch() {
  const wallet = ethers.Wallet.createRandom();
  const auth = { userId: 'ext-user-1', executionMode: 'EXTERNAL_WALLET', walletAddress: wallet.address };
  const source = createFakeSourceChain();
  const sourceChains = new Map([[DOMAIN, source]]);
  const gatewayBalances = { domainRaw: '0' };
  const gateway = {
    async readUnifiedUsdcBalance() {
      return { balances: [{ domain: DOMAIN, balanceRaw: gatewayBalances.domainRaw, transferable: true }] };
    },
  };
  const database = createFakeDatabase();
  const service = createGatewayDepositService({ database, gateway, sourceChains });

  const requestId = '11111111-1111-4111-8111-111111111111';
  const started = await service.start({ auth, requestId, sourceDomain: DOMAIN, amountRaw: AMOUNT });
  assert.equal(started.state, 'APPROVAL_REQUIRED');
  assert.equal(started.transactionRequest.chainId, CHAIN_ID);
  assert.equal(started.transactionRequest.to.toLowerCase(), USDC.toLowerCase());
  assert.equal(
    started.transactionRequest.data,
    USDC_INTERFACE.encodeFunctionData('approve', [GATEWAY_WALLET, AMOUNT]),
    'approval must be exact USDC.approve(GatewayWallet, amount), never a plain transfer',
  );

  // Duplicate request id cannot change the intent.
  await rejectsCode(
    () => service.start({ auth, requestId, sourceDomain: DOMAIN, amountRaw: '2000000' }),
    'gateway_deposit_request_id_conflict',
  );

  // A mismatched receipt (wrong calldata) is rejected before anything is bound.
  const badApprovalHash = `0x${'aa'.repeat(32)}`;
  source.mineApproval(badApprovalHash, wallet.address, AMOUNT, { badCalldata: true });
  await rejectsCode(
    () => service.verifyApproval({ auth, actionId: started.actionId, txHash: badApprovalHash }),
    'gateway_deposit_calldata_mismatch',
  );

  // Correct approval: allowance must ALSO be re-read as sufficient afterward.
  const approvalHash = `0x${'ab'.repeat(32)}`;
  source.mineApproval(approvalHash, wallet.address, AMOUNT);
  await rejectsCode(
    () => service.verifyApproval({ auth, actionId: started.actionId, txHash: approvalHash }),
    'gateway_deposit_approval_failed',
    'allowance must be confirmed on-chain, not merely asserted from the tx shape',
  );
  source.state.allowanceRaw = AMOUNT;
  const approved = await service.verifyApproval({ auth, actionId: started.actionId, txHash: approvalHash });
  assert.equal(approved.state, 'DEPOSIT_REQUIRED');
  assert.equal(approved.approvalTxHash, approvalHash);
  assert.equal(
    approved.transactionRequest.data,
    GATEWAY_INTERFACE.encodeFunctionData('deposit', [USDC, AMOUNT]),
    'deposit must be exact GatewayWallet.deposit(token, amount), never a plain transfer',
  );
  assert.equal(approved.transactionRequest.to.toLowerCase(), GATEWAY_WALLET.toLowerCase());

  // Re-verifying the SAME approval hash again is a no-op, not a re-bind.
  const reverified = await service.verifyApproval({ auth, actionId: started.actionId, txHash: approvalHash });
  assert.equal(reverified.approvalTxHash, approvalHash);

  // A different hash for an already-bound phase is rejected outright.
  await rejectsCode(
    () => service.verifyApproval({ auth, actionId: started.actionId, txHash: `0x${'ac'.repeat(32)}` }),
    'gateway_deposit_approval_already_bound',
  );

  // Deposit: uncertain/mismatched receipt rejected, never resubmitted.
  const badDepositHash = `0x${'bd'.repeat(32)}`;
  source.mineDeposit(badDepositHash, wallet.address, AMOUNT, { badCalldata: true });
  await rejectsCode(
    () => service.verifyDeposit({ auth, actionId: started.actionId, txHash: badDepositHash }),
    'gateway_deposit_calldata_mismatch',
  );

  const depositHash = `0x${'be'.repeat(32)}`;
  source.mineDeposit(depositHash, wallet.address, AMOUNT);
  const deposited = await service.verifyDeposit({ auth, actionId: started.actionId, txHash: depositHash });
  assert.equal(deposited.state, 'RECONCILING', 'must not complete from the Base receipt alone');
  assert.equal(deposited.pending, true);

  // Gateway has not credited the balance yet: status stays RECONCILING.
  const stillPending = await service.status({ auth, actionId: started.actionId });
  assert.equal(stillPending.state, 'RECONCILING');

  // Only baseline + delta proves completion, never the raw current balance.
  gatewayBalances.domainRaw = '999999';
  const notYet = await service.status({ auth, actionId: started.actionId });
  assert.equal(notYet.state, 'RECONCILING');
  gatewayBalances.domainRaw = AMOUNT;
  const completed = await service.status({ auth, actionId: started.actionId });
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.depositTxHash, depositHash);

  // An unsupported source domain fails closed before any chain read.
  await rejectsCode(
    () => service.start({
      auth, requestId: '22222222-2222-4222-8222-222222222222', sourceDomain: 99, amountRaw: AMOUNT,
    }),
    'gateway_deposit_source_unsupported',
  );

  console.log('GATEWAY_DEPOSIT_EXTERNAL=PASS');
}

// ---------------------------------------------------------------------------
// Circle branch
// ---------------------------------------------------------------------------

async function verifyCircleBranch() {
  const walletAddress = '0x3000000000000000000000000000000000000003';
  const baseCircleWalletId = 'base-wallet-1';
  const auth = {
    userId: 'circle-user-1', executionMode: 'CIRCLE_USER_WALLET',
    walletAddress, circleWalletId: 'arc-wallet-1',
  };
  const source = createFakeSourceChain();
  const sourceChains = new Map([[DOMAIN, source]]);
  const gatewayBalances = { domainRaw: '0' };
  const gateway = {
    async readUnifiedUsdcBalance() {
      return { balances: [{ domain: DOMAIN, balanceRaw: gatewayBalances.domainRaw, transferable: true }] };
    },
  };
  const database = createFakeDatabase();

  let baseWalletResolved = null;
  const challenges = new Map();
  let nextChallengeId = 1;
  let createChallengeCalls = 0;
  const transactionLookupCalls = [];
  // The real Circle transaction genuinely lives on BASE-SEPOLIA. This fake
  // reproduces circleUserWalletService's real mismatch-throwing behavior
  // (matchesFetchedContractExecutionTransaction) instead of ignoring the
  // blockchain argument: production's circle_transaction_mismatch bug came
  // exactly from the engine defaulting this to ARC-TESTNET, and a fake that
  // accepts any blockchain would never have caught it.
  const circle = {
    async listBaseSepoliaEoa() {
      return baseWalletResolved
        ? { id: baseCircleWalletId, address: walletAddress, blockchain: 'BASE-SEPOLIA', accountType: 'EOA' }
        : null;
    },
    async createContractExecutionChallenge({ walletId, contractAddress, callData, refId }) {
      createChallengeCalls += 1;
      assert.equal(walletId, baseCircleWalletId, 'must sign with the Base wallet id, never the Arc session id');
      const challengeId = `challenge-${nextChallengeId}`;
      nextChallengeId += 1;
      challenges.set(challengeId, { walletId, contractAddress, callData, refId, status: 'PENDING', txHash: null });
      return { challengeId };
    },
    async getContractExecutionChallenge({ challengeId }) {
      const challenge = challenges.get(challengeId);
      return { id: challengeId, status: challenge.status, transactionId: challenge.txHash ? challengeId : null };
    },
    async getContractExecutionTransaction({ id, blockchain }) {
      transactionLookupCalls.push({ fn: 'get', id, blockchain });
      const challenge = challenges.get(id);
      if (!challenge?.txHash) return null;
      if (blockchain !== 'BASE-SEPOLIA') throw new Error('circle_transaction_mismatch');
      return { id, state: 'COMPLETE', txHash: challenge.txHash, blockchain: 'BASE-SEPOLIA' };
    },
    async findContractExecutionTransaction({ blockchain } = {}) {
      transactionLookupCalls.push({ fn: 'find', blockchain });
      return null;
    },
  };

  function approveChallenge(challengeId, txHash) {
    const challenge = challenges.get(challengeId);
    challenge.status = 'COMPLETE';
    challenge.txHash = txHash;
  }

  const service = createGatewayDepositService({ database, gateway, circle, sourceChains });
  const requestId = '33333333-3333-4333-8333-333333333333';
  // circleExecutionEngine re-verifies the Arc session on every resolve; the
  // real check hits circleUserWalletService.listArcEoa, which needs a
  // configured Circle API key, so tests inject a fake in its place.
  const sessionDeps = { listArcEoa: async () => ({ id: auth.circleWalletId, address: walletAddress }) };

  // Base wallet not ready yet: fail closed before any Circle challenge.
  await rejectsCode(
    () => service.start({ auth, userToken: 'circle-user-token-long-enough', requestId, sourceDomain: DOMAIN, amountRaw: AMOUNT }),
    'gateway_deposit_base_wallet_required',
  );

  baseWalletResolved = true;
  const started = await service.start({
    auth, userToken: 'circle-user-token-long-enough', requestId, sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  assert.equal(started.state, 'APPROVAL_CHALLENGE');
  assert.equal(started.approvalChallengeId, 'challenge-1');

  // Calling start again must not create a second challenge (idempotent).
  const replay = await service.start({
    auth, userToken: 'circle-user-token-long-enough', requestId, sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  assert.equal(replay.approvalChallengeId, 'challenge-1');
  assert.equal(challenges.size, 1, 'a second start must never create a second approval challenge');

  // Still pending: verify-approval must not re-execute, just report pending.
  const stillPending = await service.verifyApproval({
    auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
  }, sessionDeps);
  assert.equal(stillPending.pending, true);
  assert.equal(stillPending.transactionObserved, false);

  // Circle observed the transaction but it has no hash yet.
  challenges.get('challenge-1').txHash = null;
  challenges.get('challenge-1').status = 'PENDING';
  // (transactionObserved requires a persisted transactionId; simulate via challenge completion below.)

  const approvalHash = `0x${'ca'.repeat(32)}`;
  source.state.allowanceRaw = AMOUNT;
  approveChallenge('challenge-1', approvalHash);
  const approvalResolved = await service.verifyApproval({
    auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
  }, sessionDeps);
  assert.equal(approvalResolved.state, 'DEPOSIT_CHALLENGE');
  assert.equal(approvalResolved.approvalTxHash, approvalHash);
  assert.equal(approvalResolved.depositChallengeId, 'challenge-2');
  assert.equal(challenges.get('challenge-2').walletId, baseCircleWalletId);
  // The exact production bug: the Circle transaction reconciled above lives
  // on Base Sepolia, not Arc. Reconciliation must request it as such, not
  // fall back to the engine's ARC-TESTNET default.
  assert.ok(
    transactionLookupCalls.some((call) => call.fn === 'get' && call.blockchain === 'BASE-SEPOLIA'),
    'approval reconciliation must fetch the Circle transaction as BASE-SEPOLIA, never the ARC-TESTNET default',
  );
  assert.ok(
    !transactionLookupCalls.some((call) => call.blockchain === 'ARC-TESTNET'),
    'no Base Sepolia Gateway deposit lookup may ever default to ARC-TESTNET',
  );
  // Exactly one Circle challenge was ever created per phase: the approval
  // challenge from service.start, and now exactly one deposit challenge.
  assert.equal(createChallengeCalls, 2, 'exactly one approval challenge and one deposit challenge, never more');

  // Duplicate deposit challenge is never created on a repeat call.
  const depositReplay = await service.verifyDeposit({
    auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
  }, sessionDeps);
  assert.equal(depositReplay.pending, true);
  assert.equal(challenges.size, 2, 'a repeat verify must never create a second deposit challenge');

  const depositHash = `0x${'cd'.repeat(32)}`;
  approveChallenge('challenge-2', depositHash);
  const depositResolved = await service.verifyDeposit({
    auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
  }, sessionDeps);
  assert.equal(depositResolved.state, 'RECONCILING');
  assert.equal(depositResolved.depositTxHash, depositHash);

  gatewayBalances.domainRaw = AMOUNT;
  const completed = await service.status({ auth, actionId: started.actionId });
  assert.equal(completed.state, 'COMPLETED');

  // Ambiguous multiple wallet match / address mismatch on a fresh action
  // still fails closed, never proceeding with the browser's own say-so.
  const mismatchCircle = {
    ...circle,
    async listBaseSepoliaEoa() {
      return { id: 'other-wallet', address: '0x4000000000000000000000000000000000000004', blockchain: 'BASE-SEPOLIA', accountType: 'EOA' };
    },
  };
  const mismatchService = createGatewayDepositService({
    database: createFakeDatabase(), gateway, circle: mismatchCircle, sourceChains,
  });
  await rejectsCode(
    () => mismatchService.start({
      auth, userToken: 'circle-user-token-long-enough',
      requestId: '44444444-4444-4444-8444-444444444444', sourceDomain: DOMAIN, amountRaw: AMOUNT,
    }),
    'gateway_deposit_base_wallet_mismatch',
  );

  console.log('GATEWAY_DEPOSIT_CIRCLE=PASS');
}

// ---------------------------------------------------------------------------
// Direct, low-level proof that circleExecutionEngine.resolvePhaseTransaction
// defaults to ARC-TESTNET when no blockchain is given, and passes through
// whatever blockchain IS given, for both lookup functions. This is the
// engine-level guarantee every existing Arc caller (entry, ticket transfer,
// refund, claim, all four marketplace actions) relies on implicitly by never
// passing the parameter at all.
// ---------------------------------------------------------------------------

function minimalEnginePort(action) {
  return {
    invalidError: 'test_action_invalid',
    async getAction() { return action; },
    async persistTransactionId(_u, _a, _w, _c, _phase, transactionId) {
      action = { ...action, circleApprovalTransactionId: transactionId };
      return action;
    },
    async bindTransaction(_u, _a, _w, _c, _phase, transaction) {
      action = { ...action, circleApprovalTransactionId: transaction.id };
      return action;
    },
  };
}

async function verifyEngineBlockchainDefaulting() {
  const auth = { userId: 'u1', walletAddress: '0x1000000000000000000000000000000000000001', circleWalletId: 'arc-wallet-1' };
  const dependencies = { listArcEoa: async () => ({ id: auth.circleWalletId, address: auth.walletAddress }) };
  const action = {
    id: 'action-1', payloadHash: null,
    circleApprovalChallengeId: null, circleApprovalIdempotencyKey: null,
    circleApprovalRefId: 'ref-1', circleApprovalTransactionId: 'tx-1',
  };

  const calls = [];
  const circle = {
    async getContractExecutionTransaction({ id, blockchain }) {
      calls.push({ fn: 'get', id, blockchain });
      return { id, state: 'COMPLETE', txHash: `0x${'11'.repeat(32)}`, blockchain };
    },
    async findContractExecutionTransaction({ blockchain } = {}) {
      calls.push({ fn: 'find', blockchain });
      return null;
    },
  };

  // No blockchain argument at all: this is exactly how every existing Arc
  // caller (circleEntryExecutionService, circleActionExecutionService)
  // invokes this function today.
  await circleExecutionEngine.resolvePhaseTransaction({
    auth, actionId: action.id, userToken: 'circle-user-token-long-enough', phaseName: 'APPROVAL',
    contractAddressFor: () => '0x2000000000000000000000000000000000000002',
    port: minimalEnginePort(action), circle, dependencies,
  });
  assert.equal(calls[0].blockchain, 'ARC-TESTNET', 'omitting blockchain must still resolve as ARC-TESTNET for existing Arc callers');

  // Explicit blockchain is threaded straight through, unmodified.
  calls.length = 0;
  await circleExecutionEngine.resolvePhaseTransaction({
    auth, actionId: action.id, userToken: 'circle-user-token-long-enough', phaseName: 'APPROVAL',
    contractAddressFor: () => '0x2000000000000000000000000000000000000002',
    port: minimalEnginePort(action), circle, dependencies,
    blockchain: 'BASE-SEPOLIA',
  });
  assert.equal(calls[0].blockchain, 'BASE-SEPOLIA', 'an explicit blockchain must be passed through exactly as given');

  console.log('CIRCLE_ENGINE_BLOCKCHAIN_DEFAULT=PASS');
}

// ---------------------------------------------------------------------------
// Reproduces the exact live production incident: a durable action already
// has approval_circle_transaction_id persisted (from a resolve call made
// before this fix), approval_tx_hash is still null, and the prior code's
// ARC-TESTNET default caused circle_transaction_mismatch even though the
// approval had genuinely landed on Base Sepolia (allowance already 2 USDC).
// The very next explicit call must reconcile the SAME action using the SAME
// transaction id: no new approval challenge, no new idempotency key, no
// second gateway_deposit_actions row, no re-issued approve calldata.
// ---------------------------------------------------------------------------

async function verifyProductionApprovalReconciliation() {
  const walletAddress = '0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876';
  const baseCircleWalletId = 'base-wallet-prod-1';
  const auth = {
    userId: 'circle-user-prod', executionMode: 'CIRCLE_USER_WALLET',
    walletAddress, circleWalletId: 'arc-wallet-prod-1',
  };
  const source = createFakeSourceChain();
  // Onchain read-only proof from production: allowance is already 2 USDC.
  source.state.allowanceRaw = AMOUNT;
  const sourceChains = new Map([[DOMAIN, source]]);
  const gateway = {
    async readUnifiedUsdcBalance() {
      return { balances: [{ domain: DOMAIN, balanceRaw: '0', transferable: true }] };
    },
  };
  const database = createFakeDatabase();

  const PROD_APPROVAL_TX_ID = '4087c4ae-a983-534c-9bc3-c1c454eab0fa';
  const PROD_TX_HASH = `0x${'ab'.repeat(32)}`;
  let createChallengeCalls = 0;
  const transactionLookupCalls = [];
  const circle = {
    async listBaseSepoliaEoa() {
      return { id: baseCircleWalletId, address: walletAddress, blockchain: 'BASE-SEPOLIA', accountType: 'EOA' };
    },
    async createContractExecutionChallenge({ contractAddress }) {
      createChallengeCalls += 1;
      if (contractAddress.toLowerCase() === source.usdcAddress.toLowerCase()) {
        throw new Error('must_not_recreate_the_approval_challenge');
      }
      // Only the deposit (GatewayWallet) challenge may ever be created here.
      assert.equal(contractAddress.toLowerCase(), gatewayServiceForDeposit.GATEWAY_WALLET_CONTRACT.toLowerCase());
      return { challengeId: 'deposit-challenge-prod-1' };
    },
    async getContractExecutionChallenge() {
      throw new Error('must_not_poll_the_challenge_when_the_transaction_id_is_already_known');
    },
    async getContractExecutionTransaction({ id, blockchain }) {
      transactionLookupCalls.push({ id, blockchain });
      assert.equal(id, PROD_APPROVAL_TX_ID, 'must reconcile the SAME already-known transaction id, never a different one');
      if (blockchain !== 'BASE-SEPOLIA') throw new Error('circle_transaction_mismatch');
      return { id, state: 'COMPLETE', txHash: PROD_TX_HASH, blockchain: 'BASE-SEPOLIA' };
    },
    async findContractExecutionTransaction() {
      throw new Error('must_not_list_transactions_when_the_transaction_id_is_already_known');
    },
  };

  const service = createGatewayDepositService({ database, gateway, circle, sourceChains });
  const requestId = '5208053f-c67e-44b1-907c-8bc4f04c5d27';
  const actionId = '769088d9-cd91-4466-92e1-726ac76e8cf4';
  const sessionDeps = { listArcEoa: async () => ({ id: auth.circleWalletId, address: walletAddress }) };

  // Seed the durable row exactly as production held it after the bug.
  database.rows.set(actionId, {
    id: actionId, user_id: auth.userId, request_id: requestId, execution_mode: 'CIRCLE_USER_WALLET',
    wallet_address: walletAddress, source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    source_circle_wallet_id: baseCircleWalletId, baseline_domain_balance_raw: '0',
    approval_tx_hash: null, approval_circle_challenge_id: '0b06a6fe-6f0b-58df-a9e4-a8c35c16383d',
    approval_circle_idempotency_key: 'idem-approval-1', approval_circle_ref_id: 'ref-approval-1',
    approval_circle_transaction_id: PROD_APPROVAL_TX_ID,
    deposit_tx_hash: null, deposit_circle_challenge_id: null, deposit_circle_idempotency_key: null,
    deposit_circle_ref_id: null, deposit_circle_transaction_id: null,
    state: 'APPROVAL_CHALLENGE', last_error: null, expires_at: new Date(Date.now() + 30 * 60 * 1000),
  });

  const reconciled = await service.verifyApproval({
    auth, actionId, userToken: 'circle-user-token-long-enough',
  }, sessionDeps);

  assert.equal(reconciled.state, 'DEPOSIT_CHALLENGE');
  assert.equal(reconciled.approvalTxHash, PROD_TX_HASH, 'the already-landed Base Sepolia approval must be bound by its real hash');
  assert.ok(reconciled.depositChallengeId, 'exactly one deposit challenge is prepared once approval reconciles');
  assert.equal(createChallengeCalls, 1, 'the only Circle challenge created here is the ONE deposit challenge; the approval is never recreated');
  assert.equal(database.rows.get(actionId).request_id, requestId, 'the same durable row and request id are reused, never a new one');
  assert.equal([...database.rows.values()].length, 1, 'no second gateway_deposit_actions row is ever created');
  assert.ok(
    transactionLookupCalls.length > 0 && transactionLookupCalls.every((call) => call.blockchain === 'BASE-SEPOLIA'),
    'every transaction lookup for this Base Sepolia action must use BASE-SEPOLIA, never the ARC-TESTNET default',
  );

  console.log('GATEWAY_DEPOSIT_PRODUCTION_RECONCILIATION=PASS');
}

// A transaction that genuinely does not belong to the expected blockchain
// must still fail closed, even after the fix: the fix threads the CONFIGURED
// blockchain through, it does not disable the mismatch check.
async function verifyWrongBlockchainStillFailsClosed() {
  const walletAddress = '0x5000000000000000000000000000000000000005';
  const baseCircleWalletId = 'base-wallet-2';
  const auth = {
    userId: 'circle-user-2', executionMode: 'CIRCLE_USER_WALLET',
    walletAddress, circleWalletId: 'arc-wallet-2',
  };
  const source = createFakeSourceChain();
  source.state.allowanceRaw = AMOUNT;
  const sourceChains = new Map([[DOMAIN, source]]);
  const gateway = { async readUnifiedUsdcBalance() { return { balances: [{ domain: DOMAIN, balanceRaw: '0', transferable: true }] }; } };
  const database = createFakeDatabase();
  const TX_ID = 'tx-wrong-chain-1';
  const circle = {
    async listBaseSepoliaEoa() {
      return { id: baseCircleWalletId, address: walletAddress, blockchain: 'BASE-SEPOLIA', accountType: 'EOA' };
    },
    async createContractExecutionChallenge() { throw new Error('must_not_create_a_challenge_in_this_case'); },
    async getContractExecutionChallenge() { throw new Error('must_not_poll_challenge'); },
    // The transaction genuinely belongs to a different blockchain than the
    // one this Gateway deposit action expects: reconciliation must reject
    // it exactly like the real Circle service does, not accept it.
    async getContractExecutionTransaction({ id, blockchain }) {
      assert.equal(id, TX_ID);
      if (blockchain !== 'BASE-SEPOLIA') throw new Error('circle_transaction_mismatch');
      throw new Error('circle_transaction_mismatch');
    },
    async findContractExecutionTransaction() { throw new Error('must_not_list_transactions'); },
  };
  const service = createGatewayDepositService({ database, gateway, circle, sourceChains });
  const requestId = '66666666-6666-4666-8666-666666666666';
  const actionId = '77777777-7777-4777-8777-777777777777';
  const sessionDeps = { listArcEoa: async () => ({ id: auth.circleWalletId, address: walletAddress }) };
  database.rows.set(actionId, {
    id: actionId, user_id: auth.userId, request_id: requestId, execution_mode: 'CIRCLE_USER_WALLET',
    wallet_address: walletAddress, source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    source_circle_wallet_id: baseCircleWalletId, baseline_domain_balance_raw: '0',
    approval_tx_hash: null, approval_circle_challenge_id: 'challenge-wrong-chain',
    approval_circle_idempotency_key: 'idem-1', approval_circle_ref_id: 'ref-1',
    approval_circle_transaction_id: TX_ID,
    deposit_tx_hash: null, deposit_circle_challenge_id: null, deposit_circle_idempotency_key: null,
    deposit_circle_ref_id: null, deposit_circle_transaction_id: null,
    state: 'APPROVAL_CHALLENGE', last_error: null, expires_at: new Date(Date.now() + 30 * 60 * 1000),
  });

  await rejectsCode(
    () => service.verifyApproval({ auth, actionId, userToken: 'circle-user-token-long-enough' }, sessionDeps),
    'circle_transaction_mismatch',
  );
  assert.equal(database.rows.get(actionId).state, 'APPROVAL_CHALLENGE', 'a genuine mismatch must never advance the action');

  console.log('GATEWAY_DEPOSIT_WRONG_BLOCKCHAIN_FAILS_CLOSED=PASS');
}

// ---------------------------------------------------------------------------
// Static wiring proof for the wallet page's Gateway deposit RECOVERY UI.
// Reproduces the exact production symptom: recovery is detected, the input
// is disabled and empty, and clicking "continue" must use the recovery's own
// durable amount/sourceDomain rather than the empty editable field, and must
// resume the SAME action rather than minting a new requestId or clearing
// recovery first. Pure source-text check: no network, no component mount.
// ---------------------------------------------------------------------------

function verifyWalletPageDepositRecoveryWiring() {
  const walletPage = fs.readFileSync(
    path.join(__dirname, '../../app/wallet/page.tsx'),
    'utf8',
  );

  const handlerStart = walletPage.indexOf('async function handleGatewayBaseDeposit');
  assert.ok(handlerStart > -1, 'handleGatewayBaseDeposit must exist');
  const handlerEnd = walletPage.indexOf('\n  async function ensureArcTestnet', handlerStart);
  assert.ok(handlerEnd > handlerStart);
  const handler = walletPage.slice(handlerStart, handlerEnd);

  // The recovery branch is checked, and resolved, BEFORE any input parsing.
  const recoveryBranchIndex = handler.indexOf('if (depositRecovery) {');
  const sourceDomainCheckIndex = handler.indexOf('if (depositRecovery.sourceDomain !== BASE_SEPOLIA_SOURCE.domain) {');
  const useRecoveryAmountIndex = handler.indexOf('amountRaw = depositRecovery.amountRaw;');
  const elseBranchIndex = handler.indexOf('} else {', recoveryBranchIndex);
  const parseInputIndex = handler.indexOf('parseGatewayUsdcRaw(depositAmount)');
  assert.ok(
    recoveryBranchIndex > -1 && sourceDomainCheckIndex > recoveryBranchIndex &&
    useRecoveryAmountIndex > sourceDomainCheckIndex && elseBranchIndex > useRecoveryAmountIndex &&
    parseInputIndex > elseBranchIndex,
    'a live recovery must be resolved (with its own source domain check) before the editable input is ever parsed',
  );

  // The "enter a valid amount" input-parsing error exists ONLY inside the
  // no-recovery else branch: a recovery can never trigger it.
  const recoveryBranchSlice = handler.slice(recoveryBranchIndex, elseBranchIndex);
  const elseBranchSlice = handler.slice(elseBranchIndex);
  assert.ok(
    !recoveryBranchSlice.includes('parseGatewayUsdcRaw') && !recoveryBranchSlice.includes('valid USDC amount'),
    'recovery present must never fall through to input parsing or its error',
  );
  assert.match(elseBranchSlice, /parseGatewayUsdcRaw\(depositAmount\)/);
  assert.match(elseBranchSlice, /Enter a valid USDC amount/);

  // sourceDomain/amountRaw actually used to call confirmGatewayBaseDeposit
  // are the local variables resolved above, not a hardcoded constant or a
  // fresh parse, so the same call site serves both the recovery and fresh
  // paths correctly.
  assert.match(handler, /confirmGatewayBaseDeposit\(\s*\{ sourceDomain, amountRaw \},/);

  // No new requestId is ever minted in the page itself, and recovery is
  // never cleared before the call: the ONLY setDepositRecovery(null) is
  // after a call that reported COMPLETED.
  assert.ok(!handler.includes('crypto.randomUUID()'), 'the page must never mint its own requestId for a Gateway deposit');
  const confirmCallIndex = handler.indexOf('await confirmGatewayBaseDeposit(');
  const clearRecoveryIndex = handler.indexOf('setDepositRecovery(null);');
  assert.ok(confirmCallIndex > -1 && clearRecoveryIndex > confirmCallIndex,
    'recovery must never be cleared before confirmGatewayBaseDeposit is called');
  const completedGuardIndex = handler.lastIndexOf('if (result.state === "COMPLETED") {', clearRecoveryIndex);
  assert.ok(completedGuardIndex > confirmCallIndex && completedGuardIndex < clearRecoveryIndex,
    'recovery may only be cleared after the SAME call reports COMPLETED');

  // Expiry fails closed: an expired report never clears recovery or retries.
  const catchStart = handler.indexOf('} catch (cause) {');
  const catchEnd = handler.indexOf('} finally {', catchStart);
  assert.ok(catchStart > -1 && catchEnd > catchStart);
  const catchSlice = handler.slice(catchStart, catchEnd);
  assert.match(catchSlice, /gateway_deposit_expired/);
  assert.ok(
    !catchSlice.includes('setDepositRecovery(null)') && !catchSlice.includes('confirmGatewayBaseDeposit') &&
    !catchSlice.includes('crypto.randomUUID()'),
    'an expired report must never clear recovery, retry, or mint a replacement request id',
  );

  // Recovery seeds the (disabled) display field with the durable amount, on
  // both the Circle and external recovery load effects, so it is never
  // shown empty while a real recovery amount exists.
  const seedMatches = [...walletPage.matchAll(/setDepositAmount\(formatGatewayUsdcRaw\(recovery\.amountRaw\)\);/g)];
  assert.equal(seedMatches.length, 2, 'both the Circle and external recovery load effects must seed the display amount');

  // The amount input for Gateway deposit stays disabled while a recovery is
  // live (unchanged by this fix, reconfirmed here since it is load-bearing
  // for why the field can appear empty in the first place).
  assert.match(walletPage, /gatewayDepositAmount[\s\S]{0,400}?disabled=\{depositBusy \|\| Boolean\(depositRecovery\)\}/);

  // Button copy: idle with a live recovery says "continue", never
  // "recovering" (which falsely implies something is already in progress);
  // an actual busy resume may still say "recovering". This is the JSX
  // render, a different part of the file than the handler above.
  const onClickIndex = walletPage.indexOf('onClick={handleGatewayBaseDeposit}');
  assert.ok(onClickIndex > -1, 'the deposit button must call handleGatewayBaseDeposit');
  const buttonStart = walletPage.indexOf('{depositBusy', onClickIndex);
  const buttonEnd = walletPage.indexOf('</button>', buttonStart);
  assert.ok(buttonStart > -1 && buttonEnd > buttonStart);
  const buttonSlice = walletPage.slice(buttonStart, buttonEnd);
  // The busy ternary's final fallback (no specific phase yet) closes with
  // this exact marker; everything after it is the idle (non-busy) ternary.
  const busyEndMarker = 't.wallet.gatewayReading)';
  const busyEndIndex = buttonSlice.indexOf(busyEndMarker);
  assert.ok(busyEndIndex > -1, 'expected the busy ternary to end with the gatewayReading fallback');
  const busySlice = buttonSlice.slice(0, busyEndIndex + busyEndMarker.length);
  const idleSlice = buttonSlice.slice(busyEndIndex + busyEndMarker.length);
  assert.match(idleSlice, /\? t\.wallet\.gatewayResumeDeposit/, 'idle + recovery must show the explicit "continue" label');
  assert.ok(!idleSlice.includes('gatewayRecoveringOperation'), 'idle state must never show "Recovering previous operation..."');
  assert.match(busySlice, /depositRecovery \? t\.wallet\.gatewayRecoveringOperation/, 'an actual busy resume may still show "Recovering previous operation..."');

  // gateway-actions.ts's existing recovery-first logic (unmodified by this
  // fix) is still what actually resumes the SAME durable action.
  const gatewayActions = fs.readFileSync(path.join(__dirname, '../../app/lib/gateway-actions.ts'), 'utf8');
  assert.match(gatewayActions, /readCircleGatewayDepositRecovery\(\)/);
  assert.match(gatewayActions, /readExternalGatewayDepositRecovery\(\)/);
  assert.match(gatewayActions, /verifyGatewayDepositApproval/);

  console.log('WALLET_PAGE_DEPOSIT_RECOVERY_LIVE_NETWORK_CALLS=0');
  console.log('WALLET_PAGE_DEPOSIT_RECOVERY_UI=PASS');
}

(async () => {
  await verifyExternalBranch();
  await verifyCircleBranch();
  await verifyEngineBlockchainDefaulting();
  await verifyProductionApprovalReconciliation();
  await verifyWrongBlockchainStillFailsClosed();
  verifyWalletPageDepositRecoveryWiring();
  assert.equal(liveNetworkCalls, 0);
  console.log('GATEWAY_DEPOSIT_LIVE_NETWORK_CALLS=0');
  console.log('GATEWAY_DEPOSIT=PASS');
})().catch((error) => {
  console.error('GATEWAY_DEPOSIT=FAIL', error);
  process.exitCode = 1;
});
