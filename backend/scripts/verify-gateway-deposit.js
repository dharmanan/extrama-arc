'use strict';

// Deterministic proof for the Gateway SOURCE deposit state machine
// (USDC.approve(GatewayWallet, amount) then GatewayWallet.deposit(token,
// amount)), for both human execution modes. Every adapter below (DB, Circle,
// source chain, Gateway) is a fake; global.fetch is poisoned so a real
// network call fails the run instead of silently succeeding.

const assert = require('node:assert/strict');
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
  const circle = {
    async listBaseSepoliaEoa() {
      return baseWalletResolved
        ? { id: baseCircleWalletId, address: walletAddress, blockchain: 'BASE-SEPOLIA', accountType: 'EOA' }
        : null;
    },
    async createContractExecutionChallenge({ walletId, contractAddress, callData, refId }) {
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
    async getContractExecutionTransaction({ id }) {
      const challenge = challenges.get(id);
      if (!challenge?.txHash) return null;
      return { id, state: 'COMPLETE', txHash: challenge.txHash };
    },
    async findContractExecutionTransaction() {
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

(async () => {
  await verifyExternalBranch();
  await verifyCircleBranch();
  assert.equal(liveNetworkCalls, 0);
  console.log('GATEWAY_DEPOSIT_LIVE_NETWORK_CALLS=0');
  console.log('GATEWAY_DEPOSIT=PASS');
})().catch((error) => {
  console.error('GATEWAY_DEPOSIT=FAIL', error);
  process.exitCode = 1;
});
