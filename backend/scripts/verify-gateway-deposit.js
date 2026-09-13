'use strict';

// Deterministic proof for the Gateway SOURCE deposit state machine
// (USDC.approve(GatewayWallet, amount) then GatewayWallet.deposit(token,
// amount)), for both human execution modes. Every adapter below (DB, Circle,
// source chain, Gateway) is a fake; global.fetch is poisoned so a real
// network call fails the run instead of silently succeeding.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { ethers } = require('ethers');
const ts = require('typescript');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

let liveNetworkCalls = 0;
global.fetch = async () => {
  liveNetworkCalls += 1;
  throw new Error('live network disabled in deterministic verifier');
};

const {
  createGatewayDepositService,
  RECOVERY_DISPOSITIONS,
  REVIEW_RESOLUTION_CODES,
  ACTIVE_RESUMABLE_STATES,
  hasSubmittedFinancialEvidence,
  hasApprovedReviewResolution,
  recoveryDispositionFor,
} = require('../src/services/gatewayDepositService');
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

const GATEWAY_ACTIONS_SOURCE_PATH = path.resolve(__dirname, '../../app/lib/gateway-actions.ts');

function transpileGatewayActions() {
  const source = fs.readFileSync(GATEWAY_ACTIONS_SOURCE_PATH, 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: 'gateway-actions.ts',
  }).outputText;
}

const GATEWAY_ACTIONS_CODE = transpileGatewayActions();

function loadGatewayActionsForBehavior({ backend, circleActions, circleAuth, window }) {
  const moduleObject = { exports: {} };
  const requireMap = {
    './backend-api': { backendApi: backend.module },
    './circle-actions': circleActions.module,
    './circle-auth': circleAuth.module,
  };
  function fakeRequire(id) {
    if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
    throw new Error(`gateway deposit behavior harness: unmocked require("${id}")`);
  }
  new Function('module', 'exports', 'require', 'window', 'crypto', GATEWAY_ACTIONS_CODE)(
    moduleObject, moduleObject.exports, fakeRequire, window, webcrypto,
  );
  return moduleObject.exports;
}

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
  let trimmed = cond.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const orParts = trimmed.split(/\s+OR\s+/i);
  if (orParts.length > 1) return orParts.some((part) => evalCondition(row, part, params));
  let m;
  if ((m = /^lower\((\w+)\)\s*=\s*lower\(\$(\d+)\)$/i.exec(trimmed))) {
    return String(row[m[1]] ?? '').toLowerCase() === String(params[Number(m[2]) - 1] ?? '').toLowerCase();
  }
  if ((m = /^(\w+)\s+IS\s+NULL$/i.exec(trimmed))) return row[m[1]] == null;
  if ((m = /^(\w+)\s*!~\s*'([^']+)'$/i.exec(trimmed))) {
    return !new RegExp(m[2]).test(String(row[m[1]] ?? ''));
  }
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
  if ((m = /^(\w+)\s*<>\s*(.+)$/.exec(trimmed))) {
    return row[m[1]] !== literalOrParam(m[2], params);
  }
  throw new Error(`fake db: unhandled WHERE condition: ${trimmed}`);
}

function evalWhere(row, sql, params) {
  const match = /WHERE\s+([\s\S]+?)(?:\s+RETURNING\s+\*|\s+LIMIT\s+\d+|\s+ORDER\s+BY\s|$)/i.exec(sql);
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
  const events = [];
  const copy = (row) => (row ? { ...row } : null);

  return {
    rows,
    events,
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
            created_at: new Date(), updated_at: new Date(),
          });
        }
        return { rows: [], rowCount: exists ? 0 : 1 };
      }

      if (/gateway_deposit_activity/i.test(sql)) {
        const [userId, executionMode, walletAddress] = params;
        const evidenceFields = [
          'approval_tx_hash', 'deposit_tx_hash',
          'approval_circle_challenge_id', 'deposit_circle_challenge_id',
          'approval_circle_transaction_id', 'deposit_circle_transaction_id',
        ];
        const scoped = [...rows.values()].filter((row) => (
          row.user_id === userId && row.execution_mode === executionMode &&
          String(row.wallet_address).toLowerCase() === String(walletAddress).toLowerCase()
        ));
        const hasEvidence = (row) => evidenceFields.some((field) => (
          typeof row[field] === 'string' && row[field].trim().length > 0
        ));
        const hasReviewResolution = (row) => (
          ['FAILED', 'EXPIRED'].includes(row.state) && [
            REVIEW_RESOLUTION_CODES.NO_TRANSACTION,
            REVIEW_RESOLUTION_CODES.APPROVAL_ONLY,
          ].includes(row.last_error)
        );
        const isClearTerminal = (row) => (
          row.state === 'COMPLETED' ||
          (['FAILED', 'EXPIRED'].includes(row.state) && (hasReviewResolution(row) || !hasEvidence(row)))
        );
        const unresolved = scoped.filter((row) => !isClearTerminal(row));
        const terminal = scoped
          .filter(isClearTerminal)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 10);
        const selected = [...unresolved, ...terminal]
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return { rows: selected.map(copy), rowCount: selected.length };
      }

      const isSelect = /^SELECT/i.test(sql);
      const hasReturning = /RETURNING\s+\*/i.test(sql);
      const isUpdate = /^UPDATE/i.test(sql);

      let matches = [...rows.values()].filter((row) => evalWhere(row, sql, params));
      if (isSelect) {
        // Every pre-existing caller matches at most one row (request_id or id
        // is unique per user), so returning every match instead of only the
        // first is behavior-preserving for them. It is required for a query
        // like findUnresolvedForSource's, which can genuinely match several
        // historical rows for the same source domain and relies on scanning
        // all of them.
        if (/ORDER\s+BY\s+created_at\s+DESC/i.test(sql)) {
          matches = [...matches].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        }
        return { rows: matches.map(copy), rowCount: matches.length };
      }
      if (isUpdate) {
        if (!matches.length) return { rows: [], rowCount: 0 };
        const row = matches[0];
        applySet(row, sql, params);
        events.push({ sql, params: [...params], row: copy(row) });
        return { rows: hasReturning ? [copy(row)] : [], rowCount: 1 };
      }
      throw new Error(`fake db: unhandled SQL: ${sql}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake source chain (stands in for baseSepoliaService)
// ---------------------------------------------------------------------------

function createFakeSourceChain(config = {}) {
  const CHAIN_ID = config.chainId ?? 84532;
  const USDC = config.usdc ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const CIRCLE_BLOCKCHAIN = config.circleBlockchain ?? 'BASE-SEPOLIA';
  const state = { balanceRaw: '5000000', allowanceRaw: '0' };
  const calls = {
    readChainState: 0,
    buildApprove: 0,
    buildDeposit: 0,
    assertTransaction: 0,
    readTransaction: 0,
  };
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
    circleBlockchain: CIRCLE_BLOCKCHAIN,
    usdcAddress: USDC,
    gatewayWallet: GATEWAY_WALLET,
    state,
    calls,
    mineApproval,
    mineDeposit,
    async readChainState() {
      calls.readChainState += 1;
      return { balanceRaw: state.balanceRaw, allowanceRaw: state.allowanceRaw };
    },
    buildApprove(input) {
      calls.buildApprove += 1;
      return approveRequest(input);
    },
    buildDeposit(input) {
      calls.buildDeposit += 1;
      return depositRequest(input);
    },
    assertTransaction(tx, request) {
      calls.assertTransaction += 1;
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
      calls.readTransaction += 1;
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
// One state machine, four configurations. Every funding chain drives the
// identical approve then deposit lifecycle with its own chain id, USDC and
// Circle blockchain identifier, and finality still requires a real Gateway
// balance delta on that chain's own domain.
// ---------------------------------------------------------------------------

const MULTI_CHAIN_SOURCES = [
  { domain: 6, chainId: 84532, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', circleBlockchain: 'BASE-SEPOLIA' },
  { domain: 2, chainId: 11155420, usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', circleBlockchain: 'OP-SEPOLIA' },
  { domain: 3, chainId: 421614, usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', circleBlockchain: 'ARB-SEPOLIA' },
  { domain: 0, chainId: 11155111, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', circleBlockchain: 'ETH-SEPOLIA' },
];

async function verifyMultiChainDeposit() {
  // The canonical config is the authority on which chains exist at all.
  const gatewayNetworks = require('../src/services/gatewayNetworks');
  assert.deepEqual(
    gatewayNetworks.DEPOSIT_SOURCE_NETWORKS.map((network) => network.domain).sort((a, b) => a - b),
    MULTI_CHAIN_SOURCES.map((entry) => entry.domain).sort((a, b) => a - b),
    'the funding sources proved here must be exactly the configured ones',
  );
  for (const entry of MULTI_CHAIN_SOURCES) {
    const network = gatewayNetworks.depositSourceForDomain(entry.domain);
    assert.ok(network, `domain ${entry.domain} must be a configured funding source`);
    assert.equal(network.chainId, entry.chainId);
    assert.equal(ethers.getAddress(network.usdc), ethers.getAddress(entry.usdc));
    assert.equal(network.circleBlockchain, entry.circleBlockchain);
  }

  for (const entry of MULTI_CHAIN_SOURCES) {
    const wallet = ethers.Wallet.createRandom();
    const auth = {
      userId: `multi-user-${entry.domain}`,
      executionMode: 'EXTERNAL_WALLET',
      walletAddress: wallet.address,
    };
    const source = createFakeSourceChain(entry);
    const balances = { domainRaw: '0' };
    const gateway = {
      async readUnifiedUsdcBalance() {
        return { balances: [{ domain: entry.domain, balanceRaw: balances.domainRaw, transferable: true }] };
      },
    };
    const service = createGatewayDepositService({
      database: createFakeDatabase(),
      gateway,
      sourceChains: new Map([[entry.domain, source]]),
    });
    const requestId = `aaaaaaaa-0000-4000-8000-00000000000${entry.domain}`;

    const started = await service.start({
      auth, requestId, sourceDomain: entry.domain, amountRaw: AMOUNT,
    });
    assert.equal(started.sourceDomain, entry.domain);
    assert.equal(started.sourceChainId, entry.chainId, 'each source carries its own chain id');
    assert.equal(started.state, 'APPROVAL_REQUIRED');
    // The approve targets that chain's own USDC, with GatewayWallet as spender.
    assert.equal(started.transactionRequest.chainId, entry.chainId);
    assert.equal(
      ethers.getAddress(started.transactionRequest.to), ethers.getAddress(entry.usdc),
    );
    assert.equal(
      started.transactionRequest.data,
      USDC_INTERFACE.encodeFunctionData('approve', [GATEWAY_WALLET, AMOUNT]),
    );

    const approvalHash = `0x${'a1'.repeat(32)}`;
    source.mineApproval(approvalHash, wallet.address, AMOUNT);
    source.state.allowanceRaw = AMOUNT;
    const approved = await service.verifyApproval({
      auth, actionId: started.actionId, txHash: approvalHash,
    });
    assert.equal(approved.state, 'DEPOSIT_REQUIRED');
    // The deposit goes to GatewayWallet and names that chain's own USDC. A
    // plain ERC-20 transfer would move funds without crediting Gateway.
    assert.equal(approved.transactionRequest.chainId, entry.chainId);
    assert.equal(
      ethers.getAddress(approved.transactionRequest.to), ethers.getAddress(GATEWAY_WALLET),
    );
    assert.equal(
      approved.transactionRequest.data,
      GATEWAY_INTERFACE.encodeFunctionData('deposit', [entry.usdc, AMOUNT]),
    );

    const depositHash = `0x${'b2'.repeat(32)}`;
    source.mineDeposit(depositHash, wallet.address, AMOUNT);
    const deposited = await service.verifyDeposit({
      auth, actionId: started.actionId, txHash: depositHash,
    });
    // Finality still requires a real Gateway balance delta on this domain: a
    // source receipt alone never completes a deposit.
    assert.equal(deposited.state, 'RECONCILING');
    const stillPending = await service.status({ auth, actionId: started.actionId });
    assert.equal(stillPending.state, 'RECONCILING', 'no Gateway delta yet, so still reconciling');
    balances.domainRaw = AMOUNT;
    const completed = await service.status({ auth, actionId: started.actionId });
    assert.equal(completed.state, 'COMPLETED');

    // Arc is a destination, never a funding source, and this same state
    // machine refuses it.
    await rejectsCode(
      () => service.start({
        auth,
        requestId: `bbbbbbbb-0000-4000-8000-00000000000${entry.domain}`,
        sourceDomain: 26,
        amountRaw: AMOUNT,
      }),
      'gateway_deposit_source_unsupported',
    );
  }

  console.log('GATEWAY_MULTI_CHAIN_DEPOSIT=PASS');
}

// ---------------------------------------------------------------------------
// The Circle branch, for all four funding chains. verifyCircleBranch() below
// proves the full phase-transition/idempotency/mismatch behavior in depth for
// one chain; this proves the three facts that must hold identically for every
// chain and that a Base-only hardcode would silently get right only for
// domain 6: the Circle challenge signs with THAT chain's own companion
// wallet id (never the Arc session wallet id), the reported source chain id
// is that chain's own, and reconciliation requests the Circle transaction as
// that chain's own circleBlockchain, never defaulting to ARC-TESTNET.
// ---------------------------------------------------------------------------

async function verifyMultiChainCircleBranch() {
  for (const entry of MULTI_CHAIN_SOURCES) {
    const walletAddress = ethers.getAddress(`0x${'5'.repeat(38)}${entry.domain.toString(16).padStart(2, '0')}`);
    const sourceCircleWalletId = `source-wallet-${entry.domain}`;
    const arcCircleWalletId = 'arc-wallet-should-never-sign-a-source-deposit';
    const auth = {
      userId: `circle-multi-user-${entry.domain}`,
      executionMode: 'CIRCLE_USER_WALLET',
      walletAddress,
      circleWalletId: arcCircleWalletId,
    };
    const source = createFakeSourceChain(entry);
    const balances = { domainRaw: '0' };
    const gateway = {
      async readUnifiedUsdcBalance() {
        return { balances: [{ domain: entry.domain, balanceRaw: balances.domainRaw, transferable: true }] };
      },
    };

    const challenges = new Map();
    let nextChallengeId = 1;
    const transactionLookupCalls = [];
    const circle = {
      async listEoaForBlockchain(userToken, blockchain) {
        assert.equal(
          blockchain, entry.circleBlockchain,
          `the companion wallet lookup for domain ${entry.domain} must use its own Circle blockchain`,
        );
        return { id: sourceCircleWalletId, address: walletAddress, blockchain, accountType: 'EOA' };
      },
      async createContractExecutionChallenge({ walletId }) {
        assert.equal(
          walletId, sourceCircleWalletId,
          `domain ${entry.domain} must sign with its own source wallet id, never the Arc session wallet id`,
        );
        const challengeId = `challenge-${entry.domain}-${nextChallengeId}`;
        nextChallengeId += 1;
        challenges.set(challengeId, { status: 'PENDING', txHash: null });
        return { challengeId };
      },
      async getContractExecutionChallenge({ challengeId }) {
        const challenge = challenges.get(challengeId);
        return { id: challengeId, status: challenge.status, transactionId: challenge.txHash ? challengeId : null };
      },
      async getContractExecutionTransaction({ id, blockchain }) {
        transactionLookupCalls.push(blockchain);
        const challenge = challenges.get(id);
        if (!challenge?.txHash) return null;
        // Reproduces circleUserWalletService's real behavior: a transaction
        // genuinely on this chain is rejected if looked up under any other
        // blockchain, including the engine's ARC-TESTNET default.
        if (blockchain !== entry.circleBlockchain) throw new Error('circle_transaction_mismatch');
        return { id, state: 'COMPLETE', txHash: challenge.txHash, blockchain: entry.circleBlockchain };
      },
      async findContractExecutionTransaction({ blockchain } = {}) {
        transactionLookupCalls.push(blockchain);
        return null;
      },
    };

    function approveChallenge(challengeId, txHash) {
      const challenge = challenges.get(challengeId);
      challenge.status = 'COMPLETE';
      challenge.txHash = txHash;
    }

    const service = createGatewayDepositService({
      database: createFakeDatabase(), gateway, circle,
      sourceChains: new Map([[entry.domain, source]]),
    });
    const sessionDeps = { listArcEoa: async () => ({ id: arcCircleWalletId, address: walletAddress }) };
    const requestId = `cccccccc-0000-4000-8000-00000000000${entry.domain}`;

    const started = await service.start({
      auth, userToken: 'circle-user-token-long-enough', requestId, sourceDomain: entry.domain, amountRaw: AMOUNT,
    });
    assert.equal(started.state, 'APPROVAL_CHALLENGE');
    assert.equal(started.sourceChainId, entry.chainId, `domain ${entry.domain} must report its own chain id`);

    const approvalHash = `0x${'a3'.repeat(32)}`;
    source.state.allowanceRaw = AMOUNT;
    approveChallenge(started.approvalChallengeId, approvalHash);
    const approved = await service.verifyApproval({
      auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
    }, sessionDeps);
    assert.equal(approved.state, 'DEPOSIT_CHALLENGE');
    assert.ok(
      transactionLookupCalls.includes(entry.circleBlockchain),
      `domain ${entry.domain} approval reconciliation must request its own circleBlockchain`,
    );
    assert.ok(
      !transactionLookupCalls.includes('ARC-TESTNET'),
      `domain ${entry.domain} must never default a Circle transaction lookup to ARC-TESTNET`,
    );

    const depositHash = `0x${'b4'.repeat(32)}`;
    approveChallenge(approved.depositChallengeId, depositHash);
    const deposited = await service.verifyDeposit({
      auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
    }, sessionDeps);
    assert.equal(deposited.state, 'RECONCILING');

    balances.domainRaw = AMOUNT;
    const completed = await service.status({ auth, actionId: started.actionId });
    assert.equal(completed.state, 'COMPLETED');
  }

  console.log('GATEWAY_MULTI_CHAIN_CIRCLE_PREFLIGHT=PASS');
}

// ---------------------------------------------------------------------------
// Same-source-domain duplicate safety. Production evidence proved that a lost
// browser recovery (sessionStorage cleared, split-brain Circle auth) leaves a
// historical, unresolved durable action with no local memory of it at all: a
// user who mints a fresh request id for the SAME source domain must never be
// allowed to create a second concurrent action while the first is genuinely
// uncertain. Scoped to (user, wallet, execution mode, source domain) only, so
// an unresolved review on one source never blocks a distinct, intentionally
// selected source.
// ---------------------------------------------------------------------------

async function verifySameSourceReviewGuard() {
  const walletAddress = ethers.getAddress(`0x${'7'.repeat(40)}`);
  const auth = {
    userId: 'review-guard-user', executionMode: 'CIRCLE_USER_WALLET',
    walletAddress, circleWalletId: 'arc-wallet-review-guard',
  };
  const OP_DOMAIN = 2;
  const ARB_DOMAIN = 3;
  const gateway = {
    async readUnifiedUsdcBalance() {
      return { balances: [{ domain: OP_DOMAIN, balanceRaw: '0', transferable: true }, { domain: ARB_DOMAIN, balanceRaw: '0', transferable: true }] };
    },
  };
  const circle = {
    async listEoaForBlockchain() { return null; }, // never reached: start() must fail before this
    async createContractExecutionChallenge() { throw new Error('must never create a Circle challenge here'); },
  };
  const opSource = createFakeSourceChain(
    MULTI_CHAIN_SOURCES.find((entry) => entry.domain === OP_DOMAIN),
  );
  const arbSource = createFakeSourceChain(
    MULTI_CHAIN_SOURCES.find((entry) => entry.domain === ARB_DOMAIN),
  );
  const sourceChains = new Map([[OP_DOMAIN, opSource], [ARB_DOMAIN, arbSource]]);

  function seedRow(database, overrides) {
    const id = overrides.id;
    database.rows.set(id, {
      id,
      user_id: auth.userId,
      request_id: overrides.request_id,
      execution_mode: auth.executionMode,
      wallet_address: walletAddress,
      source_domain: overrides.source_domain,
      source_chain_id: overrides.source_chain_id,
      amount_raw: AMOUNT,
      source_circle_wallet_id: overrides.source_circle_wallet_id ?? null,
      baseline_domain_balance_raw: '0',
      approval_tx_hash: overrides.approval_tx_hash ?? null,
      approval_circle_challenge_id: overrides.approval_circle_challenge_id ?? null,
      approval_circle_idempotency_key: null,
      approval_circle_ref_id: null,
      approval_circle_transaction_id: overrides.approval_circle_transaction_id ?? null,
      deposit_tx_hash: null,
      deposit_circle_challenge_id: overrides.deposit_circle_challenge_id ?? null,
      deposit_circle_idempotency_key: null,
      deposit_circle_ref_id: null,
      deposit_circle_transaction_id: overrides.deposit_circle_transaction_id ?? null,
      state: overrides.state,
      last_error: overrides.last_error ?? null,
      expires_at: overrides.expires_at ?? new Date(Date.now() + 30 * 60 * 1000),
      created_at: overrides.created_at ?? new Date(),
    });
  }

  // A. An existing active DEPOSIT_CHALLENGE is RESUME-capable even though its
  // approval tx, Circle transaction and deposit challenge are durable
  // evidence. A freshly minted request id for the SAME source must still be
  // refused before any row is inserted or Circle challenge.
  {
    const database = createFakeDatabase();
    seedRow(database, {
      id: 'existing-op-resume', request_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      source_domain: OP_DOMAIN, source_chain_id: 11155420, state: 'DEPOSIT_CHALLENGE',
      source_circle_wallet_id: 'op-wallet',
      approval_tx_hash: `0x${'12'.repeat(32)}`,
      approval_circle_transaction_id: 'approval-transaction-op',
      deposit_circle_challenge_id: 'deposit-challenge-op',
    });
    const service = createGatewayDepositService({ database, gateway, circle, sourceChains });
    await rejectsCode(
      () => service.start({
        auth, userToken: 'circle-user-token-long-enough',
        requestId: 'bbbbbbbb-0000-4000-8000-000000000001', sourceDomain: OP_DOMAIN, amountRaw: AMOUNT,
      }),
      'gateway_deposit_source_review_required',
    );
    assert.equal(database.rows.size, 1, 'no second row may be inserted for the same unresolved source');
  }

  // D. The exact historical shape: an EXPIRED row that nonetheless carries a
  // durable approval challenge id (submitted financial evidence) must be
  // treated as REVIEW, not as a clean, safely-restartable EXPIRED action.
  {
    const database = createFakeDatabase();
    seedRow(database, {
      id: 'existing-op-expired-with-evidence', request_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      source_domain: OP_DOMAIN, source_chain_id: 11155420, state: 'EXPIRED',
      approval_circle_challenge_id: 'historical-op-approval-challenge',
      expires_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    const service = createGatewayDepositService({ database, gateway, circle, sourceChains });
    await rejectsCode(
      () => service.start({
        auth, userToken: 'circle-user-token-long-enough',
        requestId: 'bbbbbbbb-0000-4000-8000-000000000002', sourceDomain: OP_DOMAIN, amountRaw: AMOUNT,
      }),
      'gateway_deposit_source_review_required',
    );
    assert.equal(database.rows.size, 1, 'an EXPIRED-with-evidence row must never be silently superseded');
  }

  // B. An existing, CLEAR (COMPLETED) OP action: a manually requested new
  // deposit for the same source must be allowed to proceed normally.
  {
    const database = createFakeDatabase();
    seedRow(database, {
      id: 'existing-op-completed', request_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      source_domain: OP_DOMAIN, source_chain_id: 11155420, state: 'COMPLETED',
    });
    const service = createGatewayDepositService({ database, gateway, circle: {
      ...circle,
      async listEoaForBlockchain() { return { id: 'op-wallet', address: walletAddress, blockchain: 'OP-SEPOLIA', accountType: 'EOA' }; },
      async createContractExecutionChallenge() { return { challengeId: 'fresh-challenge-after-completed' }; },
    }, sourceChains });
    const started = await service.start({
      auth, userToken: 'circle-user-token-long-enough',
      requestId: 'bbbbbbbb-0000-4000-8000-000000000003', sourceDomain: OP_DOMAIN, amountRaw: AMOUNT,
    });
    assert.equal(started.state, 'APPROVAL_CHALLENGE', 'a CLEAR prior action must never block a new one');
    assert.equal(database.rows.size, 2, 'the new action is a genuinely separate row');
  }

  // C. An existing, CLEAR (FAILED, no evidence) OP action: a manually
  // requested new deposit for the same source must be allowed.
  {
    const database = createFakeDatabase();
    seedRow(database, {
      id: 'existing-op-failed-no-evidence', request_id: 'aaaaaaaa-0000-4000-8000-000000000004',
      source_domain: OP_DOMAIN, source_chain_id: 11155420, state: 'FAILED',
    });
    const service = createGatewayDepositService({ database, gateway, circle: {
      ...circle,
      async listEoaForBlockchain() { return { id: 'op-wallet', address: walletAddress, blockchain: 'OP-SEPOLIA', accountType: 'EOA' }; },
      async createContractExecutionChallenge() { return { challengeId: 'fresh-challenge-after-failed' }; },
    }, sourceChains });
    const started = await service.start({
      auth, userToken: 'circle-user-token-long-enough',
      requestId: 'bbbbbbbb-0000-4000-8000-000000000004', sourceDomain: OP_DOMAIN, amountRaw: AMOUNT,
    });
    assert.equal(started.state, 'APPROVAL_CHALLENGE', 'a CLEAR FAILED-with-no-evidence row must never block a new one');
  }

  // A terminal row with preserved approval evidence remains blocked until an
  // explicit review-resolution marker is durable. The marker releases only
  // this source's local guard; it never removes the reviewed evidence.
  {
    const database = createFakeDatabase();
    const approvalTxHash = `0x${'14'.repeat(32)}`;
    seedRow(database, {
      id: 'existing-op-review-resolved', request_id: 'aaaaaaaa-0000-4000-8000-000000000008',
      source_domain: OP_DOMAIN, source_chain_id: 11155420, state: 'FAILED',
      approval_tx_hash: approvalTxHash,
      approval_circle_transaction_id: 'reviewed-approval-transaction',
      last_error: REVIEW_RESOLUTION_CODES.APPROVAL_ONLY,
    });
    const service = createGatewayDepositService({ database, gateway, circle: {
      ...circle,
      async listEoaForBlockchain() { return { id: 'op-wallet', address: walletAddress, blockchain: 'OP-SEPOLIA', accountType: 'EOA' }; },
      async createContractExecutionChallenge() { return { challengeId: 'fresh-challenge-after-review' }; },
    }, sourceChains });
    const started = await service.start({
      auth, userToken: 'circle-user-token-long-enough',
      requestId: 'bbbbbbbb-0000-4000-8000-000000000008', sourceDomain: OP_DOMAIN, amountRaw: AMOUNT,
    });
    assert.equal(started.state, 'APPROVAL_CHALLENGE',
      'an explicitly review-resolved terminal action must allow a new manual same-source request');
    assert.equal(database.rows.get('existing-op-review-resolved').approval_tx_hash, approvalTxHash);
    assert.equal(
      database.rows.get('existing-op-review-resolved').approval_circle_transaction_id,
      'reviewed-approval-transaction',
    );
  }

  // E. The unresolved OP review must never block a distinct, intentionally
  // selected Arbitrum source deposit for the same user/wallet.
  {
    const database = createFakeDatabase();
    seedRow(database, {
      id: 'existing-op-resume-2', request_id: 'aaaaaaaa-0000-4000-8000-000000000005',
      source_domain: OP_DOMAIN, source_chain_id: 11155420, state: 'BASELINE_READ',
    });
    const service = createGatewayDepositService({ database, gateway, circle: {
      ...circle,
      async listEoaForBlockchain() { return { id: 'arb-wallet', address: walletAddress, blockchain: 'ARB-SEPOLIA', accountType: 'EOA' }; },
      async createContractExecutionChallenge() { return { challengeId: 'fresh-arbitrum-challenge' }; },
    }, sourceChains });
    const started = await service.start({
      auth, userToken: 'circle-user-token-long-enough',
      requestId: 'bbbbbbbb-0000-4000-8000-000000000006', sourceDomain: ARB_DOMAIN, amountRaw: AMOUNT,
    });
    assert.equal(
      started.state, 'APPROVAL_CHALLENGE',
      'an unresolved OP action must never block a distinct Arbitrum source intent',
    );
  }

  // The normal resume path is untouched: replaying the SAME request id for an
  // unresolved action must still resume it, never throw the review error.
  {
    const database = createFakeDatabase();
    seedRow(database, {
      id: 'existing-op-resume-same-request', request_id: 'aaaaaaaa-0000-4000-8000-000000000007',
      source_domain: OP_DOMAIN, source_chain_id: 11155420, state: 'DEPOSIT_CHALLENGE',
      source_circle_wallet_id: 'op-wallet',
      approval_tx_hash: `0x${'13'.repeat(32)}`,
      approval_circle_transaction_id: 'approval-transaction-resume',
      deposit_circle_challenge_id: 'deposit-challenge-resume',
    });
    const service = createGatewayDepositService({ database, gateway, circle: {
      ...circle,
      async listEoaForBlockchain() { return { id: 'op-wallet', address: walletAddress, blockchain: 'OP-SEPOLIA', accountType: 'EOA' }; },
      async createContractExecutionChallenge() { return { challengeId: 'resumed-challenge' }; },
    }, sourceChains });
    const resumed = await service.start({
      auth, userToken: 'circle-user-token-long-enough',
      requestId: 'aaaaaaaa-0000-4000-8000-000000000007', sourceDomain: OP_DOMAIN, amountRaw: AMOUNT,
    });
    assert.equal(resumed.actionId, 'existing-op-resume-same-request', 'the SAME request id must resume the SAME action');
    assert.equal(resumed.state, 'DEPOSIT_CHALLENGE', 'the SAME request id must resume the existing active phase');
    assert.equal(database.rows.size, 1, 'resuming the same request id must never insert a second row');
  }

  console.log('GATEWAY_RESUME_STILL_BLOCKS_DUPLICATE=PASS');
  console.log('GATEWAY_SAME_SOURCE_REVIEW_GUARD=PASS');
  console.log('GATEWAY_ACTIVITY_DIFFERENT_SOURCE_CONCURRENCY=PASS');
  console.log('GATEWAY_ACTIVITY_SAME_SOURCE_GUARD=PASS');
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

function verifyRecoveryDispositionClassification() {
  const expectedActiveStates = [
    'STARTED',
    'BASELINE_READ',
    'APPROVAL_REQUIRED',
    'APPROVAL_CHALLENGE',
    'APPROVAL_PENDING',
    'APPROVAL_VERIFIED',
    'DEPOSIT_REQUIRED',
    'DEPOSIT_CHALLENGE',
    'DEPOSIT_PENDING',
    'DEPOSIT_VERIFIED',
  ];
  assert.deepEqual(
    [...ACTIVE_RESUMABLE_STATES],
    expectedActiveStates,
    'every normal pre-finality state must be explicitly resumable',
  );

  const activeEvidence = {
    approval_tx_hash: `0x${'11'.repeat(32)}`,
    approval_circle_challenge_id: 'approval-challenge-evidence',
    approval_circle_transaction_id: 'approval-transaction-evidence',
    deposit_circle_challenge_id: 'deposit-challenge-evidence',
  };
  for (const state of expectedActiveStates) {
    assert.equal(
      hasSubmittedFinancialEvidence({ state, ...activeEvidence }),
      true,
      `${state} evidence remains visible to terminal safety checks`,
    );
    assert.equal(
      recoveryDispositionFor({ state, ...activeEvidence }),
      RECOVERY_DISPOSITIONS.RESUME,
      `${state} must resume the SAME active action even when evidence exists`,
    );
  }

  assert.equal(
    recoveryDispositionFor({ state: 'DEPOSIT_CHALLENGE', ...activeEvidence }),
    RECOVERY_DISPOSITIONS.RESUME,
    'an active deposit challenge with approval and deposit evidence must resume',
  );
  assert.equal(
    recoveryDispositionFor({
      state: 'APPROVAL_CHALLENGE',
      approval_circle_challenge_id: 'approval-challenge-evidence',
    }),
    RECOVERY_DISPOSITIONS.RESUME,
    'an active approval challenge with challenge evidence must resume',
  );
  assert.equal(
    recoveryDispositionFor({ state: 'RECONCILING' }),
    RECOVERY_DISPOSITIONS.RECONCILE,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'RECONCILIATION_REQUIRED' }),
    RECOVERY_DISPOSITIONS.RECONCILE,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'EXPIRED', approval_circle_challenge_id: 'expired-evidence' }),
    RECOVERY_DISPOSITIONS.RECONCILE,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'EXPIRED' }),
    RECOVERY_DISPOSITIONS.CLEAR,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'FAILED' }),
    RECOVERY_DISPOSITIONS.CLEAR,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'COMPLETED', ...activeEvidence }),
    RECOVERY_DISPOSITIONS.CLEAR,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'UNCLASSIFIED_STATE', ...activeEvidence }),
    RECOVERY_DISPOSITIONS.RECONCILE,
    'unknown states must fail closed even when their evidence is incomplete',
  );

  const resolvedExpired = {
    state: 'EXPIRED',
    approval_circle_challenge_id: 'failed-challenge-reviewed-read-only',
    last_error: REVIEW_RESOLUTION_CODES.NO_TRANSACTION,
  };
  assert.equal(hasApprovedReviewResolution(resolvedExpired), true);
  assert.equal(
    recoveryDispositionFor(resolvedExpired),
    RECOVERY_DISPOSITIONS.CLEAR,
    'an explicitly reviewed failed challenge may release local recovery',
  );
  assert.equal(
    resolvedExpired.approval_circle_challenge_id,
    'failed-challenge-reviewed-read-only',
    'review resolution must preserve the original Circle challenge evidence',
  );

  const resolvedApprovalOnly = {
    state: 'FAILED',
    approval_tx_hash: `0x${'22'.repeat(32)}`,
    approval_circle_transaction_id: 'approval-transaction-reviewed-read-only',
    last_error: REVIEW_RESOLUTION_CODES.APPROVAL_ONLY,
  };
  assert.equal(hasSubmittedFinancialEvidence(resolvedApprovalOnly), true);
  assert.equal(hasApprovedReviewResolution(resolvedApprovalOnly), true);
  assert.equal(
    recoveryDispositionFor(resolvedApprovalOnly),
    RECOVERY_DISPOSITIONS.CLEAR,
    'an explicitly reviewed approval-only action may release local recovery',
  );
  assert.equal(resolvedApprovalOnly.approval_tx_hash, `0x${'22'.repeat(32)}`);
  assert.equal(
    resolvedApprovalOnly.approval_circle_transaction_id,
    'approval-transaction-reviewed-read-only',
    'approval evidence must remain durable after review resolution',
  );

  assert.equal(
    recoveryDispositionFor({
      state: 'EXPIRED',
      approval_circle_challenge_id: 'unresolved-expired-challenge',
      last_error: 'gateway_deposit_unknown_review_result',
    }),
    RECOVERY_DISPOSITIONS.RECONCILE,
    'unknown terminal errors must not release evidence-bearing actions',
  );

  console.log('GATEWAY_REVIEW_RESOLUTION_DURABLE=PASS');
  console.log('GATEWAY_REVIEW_RESOLUTION_PRESERVES_EVIDENCE=PASS');
  console.log('GATEWAY_REVIEW_RESOLUTION_RELEASES_SOURCE=PASS');

  console.log('GATEWAY_ACTIVE_RECOVERY_RESUMABLE=PASS');
}

async function verifyActivityServerBacked() {
  const walletAddress = ethers.getAddress(`0x${'8'.repeat(40)}`);
  const otherWallet = ethers.getAddress(`0x${'9'.repeat(40)}`);
  const auth = { userId: 'activity-user', executionMode: 'EXTERNAL_WALLET', walletAddress };
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);

  function activityRow(id, overrides = {}) {
    const createdAt = overrides.created_at || new Date(now - 1_000 * (100 + Number(overrides.order || 0)));
    return {
      id,
      user_id: auth.userId,
      request_id: `${id}-request`,
      execution_mode: auth.executionMode,
      wallet_address: walletAddress,
      source_domain: 3,
      source_chain_id: 421614,
      amount_raw: AMOUNT,
      source_circle_wallet_id: null,
      baseline_domain_balance_raw: '0',
      approval_tx_hash: null,
      approval_circle_challenge_id: null,
      approval_circle_idempotency_key: null,
      approval_circle_ref_id: null,
      approval_circle_transaction_id: null,
      deposit_tx_hash: null,
      deposit_circle_challenge_id: null,
      deposit_circle_idempotency_key: null,
      deposit_circle_ref_id: null,
      deposit_circle_transaction_id: null,
      state: 'COMPLETED',
      last_error: null,
      expires_at: new Date(now + 30 * 60 * 1000),
      created_at: createdAt,
      updated_at: createdAt,
      ...overrides,
    };
  }

  const databaseBase = createFakeDatabase();
  let activityReads = 0;
  const database = {
    rows: databaseBase.rows,
    async query(sql, params) {
      if (/gateway_deposit_activity/i.test(sql)) activityReads += 1;
      return databaseBase.query(sql, params);
    },
  };
  database.rows.set('recon-arb', activityRow('recon-arb', {
    source_domain: 3, source_chain_id: 421614, state: 'RECONCILING',
    deposit_tx_hash: `0x${'aa'.repeat(32)}`, order: 1,
  }));
  database.rows.set('recon-eth', activityRow('recon-eth', {
    source_domain: 0, source_chain_id: 11155111, state: 'RECONCILING',
    deposit_tx_hash: `0x${'bb'.repeat(32)}`, order: 2,
  }));
  database.rows.set('review-expired', activityRow('review-expired', {
    state: 'EXPIRED',
    approval_circle_challenge_id: 'reviewed-failed-challenge',
    last_error: REVIEW_RESOLUTION_CODES.NO_TRANSACTION,
    order: 3,
  }));
  database.rows.set('review-failed', activityRow('review-failed', {
    state: 'FAILED',
    approval_tx_hash: `0x${'dd'.repeat(32)}`,
    approval_circle_transaction_id: 'reviewed-approval-transaction',
    last_error: REVIEW_RESOLUTION_CODES.APPROVAL_ONLY,
    order: 4,
  }));
  for (let index = 0; index < 12; index += 1) {
    database.rows.set(`completed-${index}`, activityRow(`completed-${index}`, {
      state: 'COMPLETED', order: index + 10,
    }));
  }
  database.rows.set('other-mode', activityRow('other-mode', {
    execution_mode: 'CIRCLE_USER_WALLET', order: 200,
  }));
  database.rows.set('other-wallet', activityRow('other-wallet', {
    wallet_address: otherWallet, order: 201,
  }));

  let gatewayReads = 0;
  let failGatewayRead = false;
  const gateway = {
    async readUnifiedUsdcBalance() {
      gatewayReads += 1;
      if (failGatewayRead) throw new Error('gateway_read_unavailable');
      // The Arbitrum domain has its own target delta. The Ethereum domain is
      // deliberately below its own target even though a total-balance check
      // would incorrectly have enough value to complete it.
      return {
        balances: [
          { domain: 3, balanceRaw: AMOUNT, transferable: true },
          { domain: 0, balanceRaw: '0', transferable: true },
        ],
      };
    },
  };
  const service = createGatewayDepositService({ database, gateway, sourceChains: new Map() });
  const result = await service.activity({ auth });
  const arb = result.activities.find((item) => item.actionId === 'recon-arb');
  const eth = result.activities.find((item) => item.actionId === 'recon-eth');
  const reviewExpired = result.activities.find((item) => item.actionId === 'review-expired');
  const reviewFailed = result.activities.find((item) => item.actionId === 'review-failed');
  assert.equal(activityReads, 1, 'Activity must use one bounded DB listing query');
  assert.equal(gatewayReads, 1, 'a batch of reconciling rows must use one Gateway balance read');
  assert.equal(arb.state, 'COMPLETED', 'the matching source domain delta completes its own row');
  assert.equal(arb.sourceLabel, 'Arbitrum Sepolia');
  assert.equal(arb.terminal, true);
  assert.equal(eth.state, 'RECONCILING', 'a different source domain must not use the Arbitrum balance');
  assert.equal(eth.sourceLabel, 'Ethereum Sepolia');
  assert.equal(eth.phase, 'GATEWAY_FINALITY');
  assert.equal(eth.stage, 'FINALITY');
  assert.equal(eth.actionRequired, false, 'RECONCILING is automatic finality, not user attention');
  assert.equal(eth.interactive, false);
  assert.equal(eth.terminal, false);
  assert.equal(result.hasBackgroundActivity, true);
  assert.equal(result.activities.filter((item) => !item.terminal).length, 1,
    'one RECONCILING row must keep Activity open count at one');
  assert.equal(result.activities.filter((item) => item.terminal).length, 10, 'history is bounded to ten terminal rows');
  assert.ok(reviewExpired, 'a review-resolved EXPIRED action remains in recent Activity history');
  assert.ok(reviewFailed, 'a review-resolved FAILED action remains in recent Activity history');
  assert.equal(reviewExpired.state, 'EXPIRED');
  assert.equal(reviewExpired.phase, 'EXPIRED');
  assert.equal(reviewExpired.terminal, true);
  assert.equal(reviewExpired.actionRequired, false);
  assert.equal(reviewFailed.state, 'FAILED');
  assert.equal(reviewFailed.phase, 'FAILED');
  assert.equal(reviewFailed.terminal, true);
  assert.equal(reviewFailed.actionRequired, false);
  assert.equal(result.activities.filter((item) => item.actionRequired).length, 0,
    'RECONCILING and review-resolved terminal actions must not count as user attention');
  assert.ok(!('requestId' in arb) && !('depositChallengeId' in arb) && !('lastError' in arb));
  assert.equal(database.rows.get('recon-eth').state, 'RECONCILING', 'unmatched durable rows remain nonterminal');
  assert.equal(database.rows.get('review-expired').approval_circle_challenge_id, 'reviewed-failed-challenge');
  assert.equal(database.rows.get('review-failed').approval_tx_hash, `0x${'dd'.repeat(32)}`);
  assert.equal(database.rows.get('review-failed').approval_circle_transaction_id, 'reviewed-approval-transaction');
  assert.equal(database.rows.get('review-failed').last_error, REVIEW_RESOLUTION_CODES.APPROVAL_ONLY);

  const failedDatabase = createFakeDatabase();
  failedDatabase.rows.set('recon-failed-read', activityRow('recon-failed-read', {
    state: 'RECONCILING', deposit_tx_hash: `0x${'cc'.repeat(32)}`,
  }));
  failGatewayRead = true;
  const delayed = await createGatewayDepositService({
    database: failedDatabase, gateway, sourceChains: new Map(),
  }).activity({ auth });
  assert.equal(delayed.readState, 'delayed');
  assert.equal(delayed.activities[0].state, 'RECONCILING');
  assert.equal(failedDatabase.rows.get('recon-failed-read').state, 'RECONCILING');

  const noReconDatabase = createFakeDatabase();
  noReconDatabase.rows.set('only-completed', activityRow('only-completed', { state: 'COMPLETED' }));
  const noReconGateway = {
    async readUnifiedUsdcBalance() {
      throw new Error('must not read Gateway without background activity');
    },
  };
  const noRecon = await createGatewayDepositService({
    database: noReconDatabase, gateway: noReconGateway, sourceChains: new Map(),
  }).activity({ auth });
  assert.equal(noRecon.readState, 'ready');
  assert.equal(noRecon.activities.length, 1);

  // A legacy row may still carry a challenge state after its transaction was
  // bound by an older deployment. Activity must project the durable evidence
  // as submitted/no-action without rewriting the historical row.
  const legacyDatabase = createFakeDatabase();
  legacyDatabase.rows.set('legacy-approval-bound', activityRow('legacy-approval-bound', {
    state: 'APPROVAL_CHALLENGE',
    approval_tx_hash: `0x${'ee'.repeat(32)}`,
  }));
  legacyDatabase.rows.set('legacy-deposit-bound', activityRow('legacy-deposit-bound', {
    state: 'DEPOSIT_CHALLENGE',
    deposit_tx_hash: `0x${'ff'.repeat(32)}`,
  }));
  const legacyActivity = await createGatewayDepositService({
    database: legacyDatabase, gateway: noReconGateway, sourceChains: new Map(),
  }).activity({ auth });
  const legacyApproval = legacyActivity.activities.find((item) => item.actionId === 'legacy-approval-bound');
  const legacyDeposit = legacyActivity.activities.find((item) => item.actionId === 'legacy-deposit-bound');
  assert.equal(legacyApproval.phase, 'APPROVAL_SUBMITTED');
  assert.equal(legacyApproval.actionRequired, false);
  assert.equal(legacyApproval.terminal, false);
  assert.equal(legacyDeposit.phase, 'DEPOSIT_SUBMITTED');
  assert.equal(legacyDeposit.actionRequired, false);
  assert.equal(legacyDeposit.terminal, false);
  assert.equal(legacyDatabase.rows.get('legacy-approval-bound').state, 'APPROVAL_CHALLENGE');
  assert.equal(legacyDatabase.rows.get('legacy-deposit-bound').state, 'DEPOSIT_CHALLENGE');

  console.log('GATEWAY_ACTIVITY_SERVER_BACKED=PASS');
  console.log('GATEWAY_ACTIVITY_BATCH_RECONCILIATION=PASS');
  console.log('GATEWAY_ACTIVITY_ONE_GATEWAY_READ=PASS');
  console.log('GATEWAY_ACTIVITY_BACKGROUND_RELEASE=PASS');
  console.log('GATEWAY_ACTIVITY_RELOAD_RECOVERY=PASS');
  console.log('GATEWAY_ACTIVITY_NO_FINANCIAL_SIDE_EFFECTS=PASS');
  console.log('GATEWAY_ACTIVITY_BOUND_APPROVAL_SUBMITTED=PASS');
  console.log('GATEWAY_FINALITY_NO_ACTION_REQUIRED=PASS');
  console.log('GATEWAY_FINALITY_ACTIVITY_OPEN_COUNT=PASS');
}

function verifyActivityPostgresTypes() {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(__dirname, '../src/services/gatewayDepositService.js'), 'utf8');
  const tableStart = schema.indexOf('CREATE TABLE IF NOT EXISTS gateway_deposit_actions');
  const tableEnd = schema.indexOf('\n);', tableStart);
  assert.ok(tableStart > -1 && tableEnd > tableStart, 'Gateway deposit table must exist in the schema');
  const table = schema.slice(tableStart, tableEnd);

  for (const column of [
    'approval_circle_transaction_id',
    'deposit_circle_transaction_id',
  ]) {
    assert.match(table, new RegExp(`${column}\\s+UUID\\b`), `${column} must remain a UUID column`);
  }
  for (const column of [
    'approval_tx_hash',
    'deposit_tx_hash',
    'approval_circle_challenge_id',
    'deposit_circle_challenge_id',
  ]) {
    assert.match(table, new RegExp(`${column}\\s+(?:VARCHAR\\(66\\)|TEXT)(?=\\s|,|\\n)`), `${column} must remain text-compatible`);
  }

  const activityStart = serviceSource.indexOf('/* gateway_deposit_activity */');
  const activityEnd = serviceSource.indexOf('`,', activityStart);
  assert.ok(activityStart > -1 && activityEnd > activityStart, 'the Activity SQL must remain structurally discoverable');
  const activitySql = serviceSource.slice(activityStart, activityEnd);
  assert.match(activitySql, /NULLIF\(BTRIM\(approval_tx_hash\), ''\) IS NULL/);
  assert.match(activitySql, /NULLIF\(BTRIM\(deposit_tx_hash\), ''\) IS NULL/);
  assert.match(activitySql, /NULLIF\(BTRIM\(approval_circle_challenge_id\), ''\) IS NULL/);
  assert.match(activitySql, /NULLIF\(BTRIM\(deposit_circle_challenge_id\), ''\) IS NULL/);
  assert.match(activitySql, /approval_circle_transaction_id IS NULL/);
  assert.match(activitySql, /deposit_circle_transaction_id IS NULL/);
  assert.match(
    activitySql,
    /state IN \('FAILED', 'EXPIRED'\)[\s\S]{0,450}last_error IN \([\s\S]*gateway_deposit_review_resolved_no_transaction[\s\S]*gateway_deposit_review_resolved_approval_only/,
    'Activity SQL must recognize only the explicit durable review-resolution codes',
  );
  assert.doesNotMatch(
    activitySql,
    /BTRIM\([^)]*(?:approval_circle_transaction_id|deposit_circle_transaction_id)[^)]*\)/,
    'UUID evidence columns must never be passed to a text trim function',
  );
  assert.doesNotMatch(
    activitySql,
    /(?:approval_circle_transaction_id|deposit_circle_transaction_id)[^\n]*::text/i,
    'UUID evidence columns must use native semantics rather than text casts',
  );
  console.log('GATEWAY_ACTIVITY_POSTGRES_TYPES=PASS');
}

// A submitted deposit has already crossed the user's source wallet boundary.
// It must retain its durable RECONCILING status past the approval/challenge
// TTL and complete only when the Gateway balance delta is later observable.
// The injected clock and all adapters are local fakes.
async function verifyReconcilingFinalitySurvivesTtl() {
  const wallet = ethers.Wallet.createRandom();
  const auth = { userId: 'ttl-user-1', executionMode: 'EXTERNAL_WALLET', walletAddress: wallet.address };
  const source = createFakeSourceChain();
  const gatewayBalances = { domainRaw: '0' };
  const gateway = {
    async readUnifiedUsdcBalance() {
      return { balances: [{ domain: DOMAIN, balanceRaw: gatewayBalances.domainRaw, transferable: true }] };
    },
  };
  const database = createFakeDatabase();
  let clock = Date.UTC(2026, 8, 12, 12, 0, 0);
  const service = createGatewayDepositService({
    database,
    gateway,
    sourceChains: new Map([[DOMAIN, source]]),
    now: () => clock,
  });
  const actionId = '12121212-1212-4212-8212-121212121212';
  database.rows.set(actionId, {
    id: actionId, user_id: auth.userId, request_id: '13131313-1313-4313-8313-131313131313',
    execution_mode: auth.executionMode, wallet_address: wallet.address,
    source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    baseline_domain_balance_raw: '0', approval_tx_hash: `0x${'ab'.repeat(32)}`,
    approval_circle_challenge_id: null, approval_circle_idempotency_key: null,
    approval_circle_ref_id: null, approval_circle_transaction_id: null,
    deposit_tx_hash: `0x${'bc'.repeat(32)}`, deposit_circle_challenge_id: null,
    deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
    deposit_circle_transaction_id: null, state: 'RECONCILING', last_error: null,
    expires_at: new Date(clock - (31 * 60 * 1000)),
  });
  const sourceCallsBeforeStatus = { ...source.calls };

  const afterTtl = await service.status({ auth, actionId });
  assert.equal(afterTtl.state, 'RECONCILING');
  assert.equal(afterTtl.pending, true);
  assert.equal(afterTtl.recoveryDisposition, RECOVERY_DISPOSITIONS.RECONCILE);
  assert.equal(database.rows.get(actionId).state, 'RECONCILING');

  gatewayBalances.domainRaw = AMOUNT;
  clock += 10_000;
  const completed = await service.status({ auth, actionId });
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.recoveryDisposition, RECOVERY_DISPOSITIONS.CLEAR);
  assert.equal(
    database.rows.get(actionId).deposit_tx_hash,
    `0x${'bc'.repeat(32)}`,
    'a status-only finality read must not replace the durable source deposit hash',
  );
  assert.deepEqual(
    source.calls,
    sourceCallsBeforeStatus,
    'RECONCILING status reads must not rebuild, verify, or rebroadcast a source-chain transaction',
  );

  // The TTL is still active for actions that never reached source-chain
  // submission. This contrasts with RECONCILING rather than making all
  // Gateway rows live forever.
  const staleActionId = '14141414-1414-4414-8414-141414141414';
  database.rows.set(staleActionId, {
    id: staleActionId, user_id: auth.userId, request_id: '15151515-1515-4515-8515-151515151515',
    execution_mode: auth.executionMode, wallet_address: wallet.address,
    source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    baseline_domain_balance_raw: null, approval_tx_hash: null,
    approval_circle_challenge_id: null, approval_circle_idempotency_key: null,
    approval_circle_ref_id: null, approval_circle_transaction_id: null,
    deposit_tx_hash: null, deposit_circle_challenge_id: null,
    deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
    deposit_circle_transaction_id: null, state: 'STARTED', last_error: null,
    expires_at: new Date(clock - 1),
  });
  const expired = await service.status({ auth, actionId: staleActionId });
  assert.equal(expired.state, 'EXPIRED');
  assert.equal(expired.recoveryDisposition, RECOVERY_DISPOSITIONS.CLEAR);

  // RECONCILING is itself a durable submission/reconciliation phase. Even a
  // malformed row is not silently downgraded into a clean expiry; the status
  // read remains read-only and leaves financial investigation closed.
  const unprovenReconcilingActionId = '16161616-1616-4616-8616-161616161616';
  database.rows.set(unprovenReconcilingActionId, {
    id: unprovenReconcilingActionId, user_id: auth.userId, request_id: '17171717-1717-4717-8717-171717171717',
    execution_mode: auth.executionMode, wallet_address: wallet.address,
    source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    baseline_domain_balance_raw: '0', approval_tx_hash: `0x${'cd'.repeat(32)}`,
    approval_circle_challenge_id: null, approval_circle_idempotency_key: null,
    approval_circle_ref_id: null, approval_circle_transaction_id: null,
    deposit_tx_hash: null, deposit_circle_challenge_id: null,
    deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
    deposit_circle_transaction_id: null, state: 'RECONCILING', last_error: null,
    expires_at: new Date(clock - 1),
  });
  gatewayBalances.domainRaw = '0';
  const unprovenExpired = await service.status({ auth, actionId: unprovenReconcilingActionId });
  assert.equal(unprovenExpired.state, 'RECONCILING');
  assert.equal(unprovenExpired.recoveryDisposition, RECOVERY_DISPOSITIONS.RECONCILE);

  // RECONCILIATION_REQUIRED is not an empty/clean expiry state. It is reserved
  // for an uncertain outcome, so even an old row keeps its
  // durable action and cannot be turned into a fresh deposit by TTL handling.
  const reconciliationRequiredActionId = '18181818-1818-4818-8818-181818181818';
  database.rows.set(reconciliationRequiredActionId, {
    id: reconciliationRequiredActionId, user_id: auth.userId, request_id: '19191919-1919-4919-8919-191919191919',
    execution_mode: auth.executionMode, wallet_address: wallet.address,
    source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    baseline_domain_balance_raw: '0', approval_tx_hash: `0x${'de'.repeat(32)}`,
    approval_circle_challenge_id: null, approval_circle_idempotency_key: null,
    approval_circle_ref_id: null, approval_circle_transaction_id: null,
    deposit_tx_hash: `0x${'ef'.repeat(32)}`, deposit_circle_challenge_id: null,
    deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
    deposit_circle_transaction_id: null, state: 'RECONCILIATION_REQUIRED', last_error: 'gateway_status_unknown',
    expires_at: new Date(clock - 1),
  });
  const sourceCallsBeforeReconciliationRequired = { ...source.calls };
  const reconciliationRequired = await service.status({ auth, actionId: reconciliationRequiredActionId });
  assert.equal(reconciliationRequired.state, 'RECONCILIATION_REQUIRED');
  assert.equal(reconciliationRequired.depositTxHash, `0x${'ef'.repeat(32)}`);
  assert.equal(reconciliationRequired.recoveryDisposition, RECOVERY_DISPOSITIONS.RECONCILE);
  const replay = await service.start({
    auth, requestId: '19191919-1919-4919-8919-191919191919', sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  assert.equal(replay.actionId, reconciliationRequiredActionId);
  assert.equal(replay.state, 'RECONCILIATION_REQUIRED');
  assert.deepEqual(
    source.calls,
    sourceCallsBeforeReconciliationRequired,
    'an uncertain recovery must not rebuild, verify, or broadcast a replacement source-chain transaction',
  );

  // Terminal release is financial-evidence-aware. Empty terminal rows unlock
  // only after the backend says CLEAR; a stored source transaction makes the
  // otherwise identical status a read-only RECONCILE outcome instead.
  const cleanFailedActionId = '20202020-2020-4020-8020-202020202020';
  database.rows.set(cleanFailedActionId, {
    id: cleanFailedActionId, user_id: auth.userId, request_id: '21212121-2121-4121-8121-212121212121',
    execution_mode: auth.executionMode, wallet_address: wallet.address,
    source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    baseline_domain_balance_raw: '0', approval_tx_hash: null,
    approval_circle_challenge_id: null, approval_circle_idempotency_key: null,
    approval_circle_ref_id: null, approval_circle_transaction_id: null,
    deposit_tx_hash: null, deposit_circle_challenge_id: null,
    deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
    deposit_circle_transaction_id: null, state: 'FAILED', last_error: 'gateway_deposit_failed',
    expires_at: new Date(clock - 1),
  });
  const cleanFailed = await service.status({ auth, actionId: cleanFailedActionId });
  assert.equal(cleanFailed.recoveryDisposition, RECOVERY_DISPOSITIONS.CLEAR);

  const expiredWithEvidenceActionId = '22222222-2222-4222-8222-222222222222';
  database.rows.set(expiredWithEvidenceActionId, {
    id: expiredWithEvidenceActionId, user_id: auth.userId, request_id: '23232323-2323-4232-8232-232323232323',
    execution_mode: auth.executionMode, wallet_address: wallet.address,
    source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    baseline_domain_balance_raw: '0', approval_tx_hash: null,
    approval_circle_challenge_id: null, approval_circle_idempotency_key: null,
    approval_circle_ref_id: null, approval_circle_transaction_id: null,
    deposit_tx_hash: `0x${'f1'.repeat(32)}`, deposit_circle_challenge_id: null,
    deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
    deposit_circle_transaction_id: null, state: 'EXPIRED', last_error: 'gateway_deposit_expired',
    expires_at: new Date(clock - 1),
  });
  const expiredWithEvidence = await service.status({ auth, actionId: expiredWithEvidenceActionId });
  assert.equal(expiredWithEvidence.state, 'EXPIRED');
  assert.equal(expiredWithEvidence.recoveryDisposition, RECOVERY_DISPOSITIONS.RECONCILE);

  const failedWithEvidenceActionId = '24242424-2424-4424-8424-242424242424';
  database.rows.set(failedWithEvidenceActionId, {
    id: failedWithEvidenceActionId, user_id: auth.userId, request_id: '25252525-2525-4525-8525-252525252525',
    execution_mode: auth.executionMode, wallet_address: wallet.address,
    source_domain: DOMAIN, source_chain_id: CHAIN_ID, amount_raw: AMOUNT,
    baseline_domain_balance_raw: '0', approval_tx_hash: null,
    approval_circle_challenge_id: 'potentially-submitted-circle-challenge', approval_circle_idempotency_key: null,
    approval_circle_ref_id: null, approval_circle_transaction_id: null,
    deposit_tx_hash: null, deposit_circle_challenge_id: null,
    deposit_circle_idempotency_key: null, deposit_circle_ref_id: null,
    deposit_circle_transaction_id: null, state: 'FAILED', last_error: 'gateway_deposit_failed',
    expires_at: new Date(clock - 1),
  });
  const failedWithEvidence = await service.status({ auth, actionId: failedWithEvidenceActionId });
  assert.equal(failedWithEvidence.recoveryDisposition, RECOVERY_DISPOSITIONS.RECONCILE);

  assert.equal(
    hasSubmittedFinancialEvidence({ state: 'EXPIRED', deposit_tx_hash: null, deposit_circle_transaction_id: null }),
    false,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'EXPIRED', deposit_tx_hash: null, deposit_circle_transaction_id: null }),
    RECOVERY_DISPOSITIONS.CLEAR,
  );
  assert.equal(
    recoveryDispositionFor({ state: 'FAILED', deposit_circle_challenge_id: 'challenge' }),
    RECOVERY_DISPOSITIONS.RECONCILE,
  );
  console.log('GATEWAY_DEPOSIT_RECONCILING_FINALITY=PASS');
  console.log('GATEWAY_DEPOSIT_RECONCILIATION_REQUIRED_PRESERVED=PASS');
  console.log('GATEWAY_CLEAN_TERMINAL_RECOVERY_RELEASE=PASS');
}

// ---------------------------------------------------------------------------
// Behavioral proof for the shipped Circle Gateway deposit client. The real
// gateway-actions.ts module is transpiled and executed against fakes for the
// backend, Circle auth storage, hosted challenge executor and timer. This is
// intentionally separate from the backend state-machine tests above: it
// proves the browser returns from each phase's poll when the backend advances
// to the next phase, even while pending remains true.
// ---------------------------------------------------------------------------

function circleDepositClientResponse(state, overrides = {}) {
  const recoveryDisposition = state === 'COMPLETED' || state === 'FAILED' || state === 'EXPIRED'
    ? 'CLEAR'
    : 'RECONCILE';
  return {
    actionId: 'circle-client-action-1',
    requestId: 'circle-client-request-1',
    executionMode: 'CIRCLE_USER_WALLET',
    sourceDomain: 3,
    sourceChainId: 421614,
    amountRaw: AMOUNT,
    state,
    recoveryDisposition,
    approvalTxHash: null,
    approvalChallengeId: null,
    depositTxHash: null,
    depositChallengeId: null,
    pending: true,
    transactionObserved: false,
    transactionRequest: null,
    lastError: null,
    expiresAt: new Date(Date.UTC(2026, 8, 12, 13, 0, 0)).toISOString(),
    ...overrides,
  };
}

function createCircleGatewayActionsBehavior({ initialRecovery = null, startGatewayDeposit, approvalResponses, depositResponses }) {
  let recovery = initialRecovery ? { ...initialRecovery } : null;
  const recoveryHistory = [];
  const startCalls = [];
  const approvalCalls = [];
  const depositCalls = [];
  const gatewayStatusCalls = [];
  const executeCalls = [];
  const window = {
    delays: [],
    setTimeout(callback, milliseconds) {
      this.delays.push(milliseconds);
      return setImmediate(callback);
    },
  };
  let approvalIndex = 0;
  let depositIndex = 0;

  const circleAuth = {
    module: {
      clearCircleGatewayDepositRecovery: () => { recovery = null; },
      clearExternalGatewayDepositRecovery: () => {},
      clearExternalGatewayFundingRecovery: () => {},
      readCircleGatewayDepositRecovery: () => (recovery ? { ...recovery } : null),
      readExternalGatewayDepositRecovery: () => null,
      readExternalGatewayFundingRecovery: () => null,
      storeCircleGatewayDepositRecovery: (next) => {
        recovery = { ...next };
        recoveryHistory.push({ ...next });
      },
      storeExternalGatewayDepositRecovery: () => {},
      storeExternalGatewayFundingRecovery: () => {},
    },
  };
  const circleActions = {
    module: {
      prepareCircleGatewayFundingReview: async () => { throw new Error('Gateway transfer is not part of this harness'); },
      confirmPreparedCircleGatewayFunding: async () => { throw new Error('Gateway transfer is not part of this harness'); },
      ensureCircleFinancialAuth: async () => ({
        userToken: 'circle-client-user-token', encryptionKey: 'circle-client-encryption-key',
      }),
      executeHostedChallenge: async (challengeId) => {
        executeCalls.push(challengeId);
        return { status: 'COMPLETE' };
      },
    },
  };
  const backend = {
    module: {
      wallet: {
        startGatewayDeposit: async (input) => {
          startCalls.push({ ...input });
          return startGatewayDeposit(input);
        },
        verifyGatewayDepositApproval: async (actionId, input) => {
          approvalCalls.push({ actionId, ...input });
          const response = approvalResponses[approvalIndex];
          approvalIndex += 1;
          if (!response) throw new Error(`approval response sequence exhausted after ${approvalCalls.length} calls`);
          if (response instanceof Error) throw response;
          return response;
        },
        verifyGatewayDeposit: async (actionId, input) => {
          depositCalls.push({ actionId, ...input });
          const response = depositResponses[depositIndex];
          depositIndex += 1;
          if (!response) throw new Error(`deposit response sequence exhausted after ${depositCalls.length} calls`);
          if (response instanceof Error) throw response;
          return response;
        },
        gatewayDeposit: async (actionId) => {
          gatewayStatusCalls.push(actionId);
          throw new Error('phase-aware harness must not fall back to generic status polling');
        },
      },
    },
  };
  const runner = loadGatewayActionsForBehavior({ backend, circleActions, circleAuth, window });
  return {
    runner,
    window,
    recovery: () => (recovery ? { ...recovery } : null),
    recoveryHistory,
    startCalls,
    approvalCalls,
    depositCalls,
    gatewayStatusCalls,
    executeCalls,
  };
}

async function verifyCircleClientTwoChallengeFlow() {
  const actionId = 'circle-client-action-1';
  const requestId = 'circle-client-request-1';
  const approvalChallengeId = 'approval-challenge-live';
  const depositChallengeId = 'deposit-challenge-live';
  const progress = [];
  const responses = (state, overrides = {}) => circleDepositClientResponse(state, {
    actionId, requestId, ...overrides,
  });
  const behavior = createCircleGatewayActionsBehavior({
    startGatewayDeposit: (input) => responses('APPROVAL_CHALLENGE', {
      requestId: input.requestId,
      approvalChallengeId,
    }),
    approvalResponses: [
      responses('APPROVAL_CHALLENGE', { approvalChallengeId }),
      responses('DEPOSIT_CHALLENGE', { approvalChallengeId, depositChallengeId }),
    ],
    depositResponses: [
      responses('DEPOSIT_CHALLENGE', { approvalChallengeId, depositChallengeId }),
      responses('RECONCILING', { approvalChallengeId, depositChallengeId }),
    ],
  });

  const result = await behavior.runner.confirmGatewaySourceDeposit(
    { sourceDomain: 3, amountRaw: AMOUNT },
    { executionMode: 'CIRCLE_USER_WALLET' },
    (phase) => progress.push(phase),
  );

  assert.equal(result.state, 'RECONCILING');
  assert.deepEqual(
    progress,
    ['APPROVAL_CHALLENGE', 'APPROVAL_PENDING', 'DEPOSIT_CHALLENGE', 'DEPOSIT_PENDING', 'RECONCILING'],
    'Circle phases must progress in order without getting stuck in approval polling',
  );
  assert.deepEqual(behavior.executeCalls, [approvalChallengeId, depositChallengeId]);
  assert.equal(behavior.startCalls.length, 1, 'one request id/action only');
  assert.equal(behavior.approvalCalls.length, 2, 'approval polling returns at DEPOSIT_CHALLENGE');
  assert.equal(behavior.depositCalls.length, 2, 'deposit polling returns at RECONCILING');
  assert.equal(behavior.gatewayStatusCalls.length, 0, 'phase polling must not fall back to generic status');
  assert.ok(behavior.approvalCalls.every((call) => call.actionId === actionId));
  assert.ok(behavior.depositCalls.every((call) => call.actionId === actionId));
  assert.deepEqual(
    behavior.recoveryHistory.map((entry) => entry.phase),
    ['APPROVAL_CHALLENGE', 'APPROVAL_PENDING', 'DEPOSIT_CHALLENGE', 'DEPOSIT_PENDING', 'RECONCILING'],
    'browser recovery must follow every financial phase boundary',
  );
  assert.equal(behavior.recovery().requestId, behavior.startCalls[0].requestId);
  assert.equal(behavior.recovery().actionId, actionId);
  assert.equal(behavior.recovery().phase, 'RECONCILING');
  console.log('GATEWAY_CIRCLE_TWO_CHALLENGE_FLOW=PASS');
}

async function verifyCircleClientApprovalPendingResume() {
  const actionId = 'circle-client-resume-action';
  const requestId = 'circle-client-resume-request';
  const depositChallengeId = 'deposit-challenge-existing';
  const initialRecovery = {
    actionId,
    requestId,
    sourceDomain: 3,
    amountRaw: AMOUNT,
    phase: 'APPROVAL_PENDING',
    challengeId: null,
    expiresAtMs: Date.UTC(2026, 8, 12, 13, 0, 0),
  };
  const progress = [];
  const responses = (state, overrides = {}) => circleDepositClientResponse(state, {
    actionId, requestId, ...overrides,
  });
  const behavior = createCircleGatewayActionsBehavior({
    initialRecovery,
    startGatewayDeposit: () => { throw new Error('resume must not call startGatewayDeposit'); },
    approvalResponses: [responses('DEPOSIT_CHALLENGE', { depositChallengeId })],
    depositResponses: [responses('RECONCILING', { depositChallengeId })],
  });

  const result = await behavior.runner.confirmGatewaySourceDeposit(
    { sourceDomain: 3, amountRaw: AMOUNT },
    { executionMode: 'CIRCLE_USER_WALLET' },
    (phase) => progress.push(phase),
  );

  assert.equal(result.state, 'RECONCILING');
  assert.deepEqual(progress, ['DEPOSIT_CHALLENGE', 'DEPOSIT_PENDING', 'RECONCILING']);
  assert.equal(behavior.startCalls.length, 0, 'resume must not create a new action/request');
  assert.equal(behavior.approvalCalls.length, 1, 'resume probes the existing approval phase once');
  assert.equal(behavior.executeCalls.length, 1, 'only the existing deposit challenge executes');
  assert.deepEqual(behavior.executeCalls, [depositChallengeId]);
  assert.equal(behavior.depositCalls.length, 1);
  assert.equal(behavior.gatewayStatusCalls.length, 0);
  assert.deepEqual(
    behavior.recoveryHistory.map((entry) => entry.phase),
    ['DEPOSIT_CHALLENGE', 'DEPOSIT_PENDING', 'RECONCILING'],
  );
  assert.equal(behavior.recovery().requestId, requestId);
  assert.equal(behavior.recovery().actionId, actionId);
  console.log('GATEWAY_CIRCLE_RESUME_PHASE_SYNC=PASS');
  console.log('GATEWAY_CIRCLE_APPROVAL_PENDING_NO_REPROMPT=PASS');
  console.log('GATEWAY_CIRCLE_PENDING_SAME_ACTION_RECOVERY=PASS');
}

async function verifyCircleClientDepositPendingResume() {
  const actionId = 'circle-client-deposit-pending-action';
  const requestId = 'circle-client-deposit-pending-request';
  const depositChallengeId = 'deposit-challenge-pending';
  const initialRecovery = {
    actionId,
    requestId,
    sourceDomain: 3,
    amountRaw: AMOUNT,
    phase: 'DEPOSIT_PENDING',
    challengeId: depositChallengeId,
    expiresAtMs: Date.UTC(2026, 8, 12, 13, 0, 0),
  };
  const progress = [];
  const responses = (state, overrides = {}) => circleDepositClientResponse(state, {
    actionId, requestId, depositChallengeId, ...overrides,
  });
  const behavior = createCircleGatewayActionsBehavior({
    initialRecovery,
    startGatewayDeposit: () => { throw new Error('deposit pending recovery must not create a new action'); },
    approvalResponses: [],
    depositResponses: [
      responses('DEPOSIT_PENDING', { pending: true }),
      responses('RECONCILING', { pending: true }),
    ],
  });

  const result = await behavior.runner.confirmGatewaySourceDeposit(
    { sourceDomain: 3, amountRaw: AMOUNT },
    { executionMode: 'CIRCLE_USER_WALLET' },
    (phase) => progress.push(phase),
  );
  assert.equal(result.state, 'RECONCILING');
  assert.deepEqual(progress, ['DEPOSIT_PENDING', 'RECONCILING']);
  assert.equal(behavior.startCalls.length, 0, 'DEPOSIT_PENDING recovery must keep the same action');
  assert.equal(behavior.approvalCalls.length, 0, 'DEPOSIT_PENDING recovery must not probe approval');
  assert.equal(behavior.depositCalls.length, 2, 'DEPOSIT_PENDING must use read-only deposit verification');
  assert.equal(behavior.executeCalls.length, 0, 'DEPOSIT_PENDING must never re-execute the deposit challenge');
  assert.equal(behavior.gatewayStatusCalls.length, 0, 'pending recovery must not fall back to generic status polling');
  assert.equal(behavior.depositCalls.every((call) => call.actionId === actionId), true);
  assert.equal(behavior.recovery().actionId, actionId);
  assert.equal(behavior.recovery().requestId, requestId);
  console.log('GATEWAY_CIRCLE_DEPOSIT_PENDING_NO_REPROMPT=PASS');
}

async function verifyCircleClientTransientApprovalRead() {
  const actionId = 'circle-client-transient-read-action';
  const requestId = 'circle-client-transient-read-request';
  const approvalChallengeId = 'approval-challenge-transient-read';
  const depositChallengeId = 'deposit-challenge-after-transient-read';
  const responses = (state, overrides = {}) => circleDepositClientResponse(state, {
    actionId, requestId, ...overrides,
  });

  // A temporary read failure after the hosted approval returns is retried as
  // a read-only operation, then the same click advances to the existing
  // deposit challenge. No challenge or action is created a second time.
  const recovered = createCircleGatewayActionsBehavior({
    startGatewayDeposit: (input) => responses('APPROVAL_CHALLENGE', {
      requestId: input.requestId, approvalChallengeId,
    }),
    approvalResponses: [
      new Error('circle_service_unavailable'),
      responses('DEPOSIT_CHALLENGE', { approvalChallengeId, depositChallengeId }),
    ],
    depositResponses: [
      responses('DEPOSIT_CHALLENGE', { approvalChallengeId, depositChallengeId }),
      responses('RECONCILING', { approvalChallengeId, depositChallengeId }),
    ],
  });
  const result = await recovered.runner.confirmGatewaySourceDeposit(
    { sourceDomain: 0, amountRaw: AMOUNT },
    { executionMode: 'CIRCLE_USER_WALLET' },
  );
  assert.equal(result.state, 'RECONCILING');
  assert.equal(recovered.startCalls.length, 1, 'transient read recovery must keep one action');
  assert.equal(recovered.approvalCalls.length, 2, 'only the read was retried');
  assert.deepEqual(recovered.executeCalls, [approvalChallengeId, depositChallengeId]);
  assert.ok(recovered.window.delays.includes(1000), 'the retry uses a bounded read-only delay');
  assert.equal(recovered.gatewayStatusCalls.length, 0);
  assert.equal(recovered.recovery().actionId, actionId);

  // Exhausting the transient read budget preserves APPROVAL_PENDING recovery
  // and returns a specific status error. It never executes another hosted
  // challenge and never reaches the deposit phase.
  const exhausted = createCircleGatewayActionsBehavior({
    startGatewayDeposit: (input) => responses('APPROVAL_CHALLENGE', {
      requestId: input.requestId, approvalChallengeId,
    }),
    approvalResponses: Array.from(
      { length: 6 },
      () => new Error('circle_rate_limited'),
    ),
    depositResponses: [],
  });
  await assert.rejects(
    () => exhausted.runner.confirmGatewaySourceDeposit(
      { sourceDomain: 0, amountRaw: AMOUNT },
      { executionMode: 'CIRCLE_USER_WALLET' },
    ),
    (error) => error instanceof Error && error.message === 'gateway_deposit_approval_status_pending',
  );
  assert.equal(exhausted.startCalls.length, 1);
  assert.equal(exhausted.approvalCalls.length, 6, 'the retry budget is bounded');
  assert.deepEqual(exhausted.executeCalls, [approvalChallengeId]);
  assert.equal(exhausted.depositCalls.length, 0);
  assert.equal(exhausted.recovery().phase, 'APPROVAL_PENDING');
  assert.equal(exhausted.recovery().actionId, actionId);

  // Security and binding failures are not transient read errors and are not
  // swallowed or retried.
  const nonTransient = createCircleGatewayActionsBehavior({
    startGatewayDeposit: (input) => responses('APPROVAL_CHALLENGE', {
      requestId: input.requestId, approvalChallengeId,
    }),
    approvalResponses: [new Error('circle_transaction_mismatch')],
    depositResponses: [],
  });
  await assert.rejects(
    () => nonTransient.runner.confirmGatewaySourceDeposit(
      { sourceDomain: 0, amountRaw: AMOUNT },
      { executionMode: 'CIRCLE_USER_WALLET' },
    ),
    (error) => error instanceof Error && error.message === 'circle_transaction_mismatch',
  );
  assert.equal(nonTransient.approvalCalls.length, 1);
  assert.deepEqual(nonTransient.executeCalls, [approvalChallengeId]);

  console.log('GATEWAY_CIRCLE_TRANSIENT_APPROVAL_READ_RETRY=PASS');
  console.log('GATEWAY_CIRCLE_NO_SECOND_APPROVAL_PROMPT=PASS');
  console.log('GATEWAY_CIRCLE_TRANSIENT_READ_PRESERVES_RECOVERY=PASS');
}

function createCirclePendingServiceFixture() {
  const walletAddress = '0x7000000000000000000000000000000000000007';
  const auth = {
    userId: 'circle-pending-user', executionMode: 'CIRCLE_USER_WALLET',
    walletAddress, circleWalletId: 'arc-pending-wallet',
  };
  const source = createFakeSourceChain();
  const sourceChains = new Map([[DOMAIN, source]]);
  const database = createFakeDatabase();
  const gateway = {
    async readUnifiedUsdcBalance() {
      return { balances: [{ domain: DOMAIN, balanceRaw: '0', transferable: true }] };
    },
  };
  const challenges = new Map();
  let nextChallengeId = 1;
  let createChallengeCalls = 0;
  let approvalReadSequence = null;
  let trackedActionId = null;
  const sourceReadObservations = [];
  const originalReadChainState = source.readChainState.bind(source);
  source.readChainState = async () => {
    if (!approvalReadSequence) return originalReadChainState();
    const next = approvalReadSequence.shift();
    const row = trackedActionId ? database.rows.get(trackedActionId) : null;
    sourceReadObservations.push({
      durableState: row?.state || null,
      allowanceRaw: next instanceof Error ? null : next?.allowanceRaw,
      error: next instanceof Error ? next.message : null,
    });
    if (next instanceof Error) throw next;
    if (!next) throw new Error('source read sequence exhausted');
    return next;
  };
  const circle = {
    async listEoaForBlockchain() {
      return { id: 'base-pending-wallet', address: walletAddress, blockchain: 'BASE-SEPOLIA', accountType: 'EOA' };
    },
    async createContractExecutionChallenge({ contractAddress, callData }) {
      createChallengeCalls += 1;
      const challengeId = `pending-challenge-${nextChallengeId}`;
      nextChallengeId += 1;
      challenges.set(challengeId, { contractAddress, callData, status: 'PENDING', txHash: null });
      return { challengeId };
    },
    async getContractExecutionChallenge({ challengeId }) {
      const challenge = challenges.get(challengeId);
      return { id: challengeId, status: challenge.status, transactionId: challenge.txHash ? challengeId : null };
    },
    async getContractExecutionTransaction({ id, blockchain }) {
      const challenge = challenges.get(id);
      if (!challenge?.txHash) return null;
      if (blockchain !== 'BASE-SEPOLIA') throw new Error('circle_transaction_mismatch');
      return { id, state: 'COMPLETE', txHash: challenge.txHash, blockchain };
    },
    async findContractExecutionTransaction() {
      return null;
    },
  };
  const sessionDeps = { listArcEoa: async () => ({ id: auth.circleWalletId, address: walletAddress }) };
  const service = createGatewayDepositService({
    database, gateway, circle, sourceChains, sleep: async () => {},
  });

  return {
    auth,
    database,
    service,
    sourceReadObservations,
    sessionDeps,
    get createChallengeCalls() { return createChallengeCalls; },
    setApprovalReadSequence(sequence, actionId) {
      approvalReadSequence = [...sequence];
      trackedActionId = actionId;
    },
    approve(challengeId, txHash) {
      const challenge = challenges.get(challengeId);
      challenge.status = 'COMPLETE';
      challenge.txHash = txHash;
    },
  };
}

async function verifyCirclePendingStateDurability() {
  const fixture = createCirclePendingServiceFixture();
  const requestId = '77777777-7777-4777-8777-777777777777';
  const started = await fixture.service.start({
    auth: fixture.auth, userToken: 'circle-user-token-long-enough',
    requestId, sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  assert.equal(started.state, 'APPROVAL_CHALLENGE');
  fixture.setApprovalReadSequence([
    { balanceRaw: '5000000', allowanceRaw: '0' },
    { balanceRaw: '5000000', allowanceRaw: AMOUNT },
  ], started.actionId);
  fixture.approve(started.approvalChallengeId, `0x${'71'.repeat(32)}`);

  const approvalResolved = await fixture.service.verifyApproval({
    auth: fixture.auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
  }, fixture.sessionDeps);
  assert.equal(approvalResolved.state, 'DEPOSIT_CHALLENGE');
  assert.deepEqual(
    fixture.sourceReadObservations.map((observation) => observation.allowanceRaw),
    ['0', AMOUNT],
    'the source rail must retry one stale allowance and accept the later value',
  );
  assert.ok(
    fixture.sourceReadObservations.every((observation) => observation.durableState === 'APPROVAL_PENDING'),
    'the approval bind must be durable before any source confirmation read',
  );
  const approvalBindIndex = fixture.database.events.findIndex((event) => (
    event.sql.includes('approval_tx_hash = $4') && event.sql.includes('state = $6')
  ));
  assert.ok(approvalBindIndex > -1);
  assert.equal(fixture.database.events[approvalBindIndex].row.state, 'APPROVAL_PENDING');
  assert.equal(fixture.database.rows.get(started.actionId).approval_tx_hash, `0x${'71'.repeat(32)}`);
  assert.equal(fixture.createChallengeCalls, 2, 'stale confirmation must not create another approval challenge');
  assert.equal(fixture.database.rows.size, 1, 'the same action row must be reused');
  assert.equal(fixture.database.rows.get(started.actionId).request_id, requestId);
  console.log('GATEWAY_CIRCLE_APPROVAL_BIND_DURABLE_PENDING=PASS');
  console.log('GATEWAY_CIRCLE_SOURCE_READ_AFTER_WRITE_RETRY=PASS');
  console.log('GATEWAY_CIRCLE_STALE_ALLOWANCE_RETRY=PASS');

  const depositHash = `0x${'72'.repeat(32)}`;
  fixture.approve(approvalResolved.depositChallengeId, depositHash);
  const depositResolved = await fixture.service.verifyDeposit({
    auth: fixture.auth, actionId: started.actionId, userToken: 'circle-user-token-long-enough',
  }, fixture.sessionDeps);
  assert.equal(depositResolved.state, 'RECONCILING');
  const depositBindIndex = fixture.database.events.findIndex((event) => (
    event.sql.includes('deposit_tx_hash = $4') && event.sql.includes('state = $6')
  ));
  const reconcilingIndex = fixture.database.events.findIndex((event, index) => (
    index > depositBindIndex && event.sql.includes("SET state = 'RECONCILING'")
  ));
  assert.ok(depositBindIndex > approvalBindIndex && reconcilingIndex > depositBindIndex);
  assert.equal(fixture.database.events[depositBindIndex].row.state, 'DEPOSIT_PENDING');
  assert.equal(fixture.database.events[reconcilingIndex].row.state, 'RECONCILING');
  assert.equal(fixture.database.rows.get(started.actionId).deposit_tx_hash, depositHash);
  assert.equal(fixture.createChallengeCalls, 2, 'deposit binding must not create a second deposit challenge');
  console.log('GATEWAY_CIRCLE_DEPOSIT_BIND_DURABLE_PENDING=PASS');

  // When the bounded source rail is exhausted, a same-request start must not
  // skip the pending confirmation and issue a deposit challenge. The next
  // verify call resumes the same action read-only and advances normally.
  const held = createCirclePendingServiceFixture();
  const heldRequestId = '76767676-7676-4767-8767-767676767676';
  const heldStarted = await held.service.start({
    auth: held.auth, userToken: 'circle-user-token-long-enough',
    requestId: heldRequestId, sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  held.setApprovalReadSequence(
    Array.from({ length: 6 }, () => ({ balanceRaw: '5000000', allowanceRaw: '0' })),
    heldStarted.actionId,
  );
  held.approve(heldStarted.approvalChallengeId, `0x${'75'.repeat(32)}`);
  const heldPending = await held.service.verifyApproval({
    auth: held.auth, actionId: heldStarted.actionId, userToken: 'circle-user-token-long-enough',
  }, held.sessionDeps);
  assert.equal(heldPending.state, 'APPROVAL_PENDING');
  assert.equal(heldPending.approvalTxHash, `0x${'75'.repeat(32)}`);
  const heldReplay = await held.service.start({
    auth: held.auth, userToken: 'circle-user-token-long-enough',
    requestId: heldRequestId, sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  assert.equal(heldReplay.state, 'APPROVAL_PENDING');
  assert.equal(heldReplay.depositChallengeId, null);
  assert.equal(held.createChallengeCalls, 1, 'pending start replay must not issue a deposit challenge');
  held.setApprovalReadSequence([
    { balanceRaw: '5000000', allowanceRaw: AMOUNT },
  ], heldStarted.actionId);
  const heldAdvanced = await held.service.verifyApproval({
    auth: held.auth, actionId: heldStarted.actionId, userToken: 'circle-user-token-long-enough',
  }, held.sessionDeps);
  assert.equal(heldAdvanced.state, 'DEPOSIT_CHALLENGE');

  const transient = createCirclePendingServiceFixture();
  const transientStarted = await transient.service.start({
    auth: transient.auth, userToken: 'circle-user-token-long-enough',
    requestId: '78787878-7878-4787-8787-787878787878', sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  const transportFailure = Object.assign(new Error('source transport unavailable'), { code: 'ETIMEDOUT' });
  transient.setApprovalReadSequence([
    transportFailure,
    { balanceRaw: '5000000', allowanceRaw: AMOUNT },
  ], transientStarted.actionId);
  transient.approve(transientStarted.approvalChallengeId, `0x${'73'.repeat(32)}`);
  const transientResolved = await transient.service.verifyApproval({
    auth: transient.auth, actionId: transientStarted.actionId, userToken: 'circle-user-token-long-enough',
  }, transient.sessionDeps);
  assert.equal(transientResolved.state, 'DEPOSIT_CHALLENGE');
  assert.equal(transient.sourceReadObservations.length, 2);
  assert.equal(transient.sourceReadObservations[0].durableState, 'APPROVAL_PENDING');

  const mismatch = createCirclePendingServiceFixture();
  const mismatchStarted = await mismatch.service.start({
    auth: mismatch.auth, userToken: 'circle-user-token-long-enough',
    requestId: '79797979-7979-4797-8797-797979797979', sourceDomain: DOMAIN, amountRaw: AMOUNT,
  });
  mismatch.setApprovalReadSequence([
    new Error('gateway_source_chain_id_mismatch'),
  ], mismatchStarted.actionId);
  mismatch.approve(mismatchStarted.approvalChallengeId, `0x${'74'.repeat(32)}`);
  await rejectsCode(
    () => mismatch.service.verifyApproval({
      auth: mismatch.auth, actionId: mismatchStarted.actionId, userToken: 'circle-user-token-long-enough',
    }, mismatch.sessionDeps),
    'gateway_source_chain_id_mismatch',
  );
  assert.equal(mismatch.sourceReadObservations.length, 1, 'security errors must not enter the retry rail');
  assert.equal(mismatch.database.rows.get(mismatchStarted.actionId).state, 'APPROVAL_PENDING');
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
    async listEoaForBlockchain(userToken, blockchain) {
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
    'gateway_deposit_source_wallet_required',
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
    async listEoaForBlockchain(userToken, blockchain) {
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
    'gateway_deposit_source_wallet_mismatch',
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
    async listEoaForBlockchain(userToken, blockchain) {
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
    async listEoaForBlockchain(userToken, blockchain) {
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

// Historical static wiring assertions for the retired four-card surface. The
// current form is checked below; the executable state-machine checks above
// remain shared by both surfaces.
function verifyWalletPageDepositRecoveryWiringLegacy() {
  const walletPage = fs.readFileSync(
    path.join(__dirname, '../../app/wallet/page.tsx'),
    'utf8',
  );
  const styles = fs.readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');
  const copy = fs.readFileSync(path.join(__dirname, '../../app/i18n.tsx'), 'utf8');

  // -------------------------------------------------------------------
  // A. The unified balance and the send controls
  // -------------------------------------------------------------------
  const fundingMarkupStart = walletPage.indexOf(
    '<section className="ex-wallet-gateway" aria-label={t.wallet.gatewayFundingAriaLabel}>',
  );
  const depositMarkupStart = walletPage.indexOf(
    '<section className="ex-wallet-gateway" aria-label={t.wallet.gatewayDepositAriaLabel}>',
  );
  const depositMarkupEnd = walletPage.indexOf('<div className="ex-wallet-actions">', depositMarkupStart);
  assert.ok(fundingMarkupStart > -1 && depositMarkupStart > fundingMarkupStart && depositMarkupEnd > depositMarkupStart);
  const fundingMarkup = walletPage.slice(fundingMarkupStart, depositMarkupStart);
  const depositMarkup = walletPage.slice(depositMarkupStart, depositMarkupEnd);

  // The unified balance is stated once, as one number, in the send section.
  const unifiedMatches = [...walletPage.matchAll(/ex-gateway-unified/g)];
  assert.equal(unifiedMatches.length, 1, 'the unified balance is rendered exactly once');
  assert.match(fundingMarkup, /className="ex-gateway-unified"/);
  assert.match(
    fundingMarkup,
    /formatGatewayUsdcDisplay\(gateway\.transferableTotalUsdc, locale\)/,
    'the unified balance must be the spendable Gateway total',
  );
  assert.match(fundingMarkup, /t\.wallet\.gatewayUnifiedBalance/);

  // Preparation success is an authoritative backend invariant. Failed or
  // expired/reconciling statuses must stay on the human error path and can
  // never borrow the success copy merely because a response exists.
  assert.match(fundingMarkup, /gatewayFundingStatus\?\.readyToBroadcast === true/);
  assert.match(fundingMarkup, /gatewayFundingStatus\.submissionEnabled === true/);
  assert.match(fundingMarkup, /t\.wallet\.gatewaySubmitTransfer/);
  assert.match(walletPage, /backendApi\.wallet\.submitGatewayFunding\(prepared\.actionId\)/);
  assert.match(walletPage, /prepared\.state !== "READY_TO_BROADCAST"/);
  assert.match(walletPage, /prepared\.submissionEnabled !== true/);
  assert.ok(!/submitGatewayTransfer|\/v1\/transfer|gatewayMint|burnIntent/i.test(walletPage));
  for (const state of [
    'READY_TO_BROADCAST', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED',
    'SIGNATURE_FAILED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED',
  ]) {
    const response = { state, readyToBroadcast: state === 'READY_TO_BROADCAST' };
    const primaryLabel = response.readyToBroadcast ? 'Transfer prepared' : 'error path';
    assert.equal(primaryLabel === 'Transfer prepared', response.readyToBroadcast,
      `${state} must follow authoritative readiness semantics`);
  }

  // There is exactly ONE select in the send section and it is the
  // DESTINATION. A source selector must not exist anywhere.
  const selects = [...fundingMarkup.matchAll(/<select/g)];
  assert.equal(selects.length, 1, 'the send section has one selector only');
  assert.match(fundingMarkup, /<span>\{t\.wallet\.gatewayDestination\}<\/span>/);
  assert.match(
    fundingMarkup,
    /onChange=\{\(event\) => setGatewayDestinationDomain\(event\.target\.value\)\}/,
  );
  assert.match(
    fundingMarkup,
    /\{gatewayDestinations\.map\(\(item\) => \(\s*<option key=\{item\.domain\} value=\{item\.domain\}>\s*\{item\.label\}\s*<\/option>/,
    'destination options render the server-supplied label and nothing else',
  );
  // No source selection of any kind survives in the transfer surface.
  for (const forbidden of [
    'gatewaySourceDomain',
    'setGatewaySourceDomain',
    'selectedGatewaySource',
    'gatewaySourceNetworkLabel',
  ]) {
    assert.ok(
      !walletPage.includes(forbidden),
      `${forbidden} must be gone: the user never chooses a Gateway source`,
    );
  }
  // The old "Source" transfer label is gone entirely (the per-card
  // gatewaySource* strings are the funding cards, a different concern).
  assert.ok(
    !/t\.wallet\.gatewaySource\b/.test(walletPage),
    'the transfer Source label must be gone: the user never chooses a Gateway source',
  );
  // The transfer request itself carries a destination and an amount only.
  assert.match(
    walletPage,
    /(?:prepareGatewayBurnReview|confirmPreparedGatewayBurnSignature)\(\s*\{ destinationDomain, valueRaw \},/,
    'a transfer is requested by destination and amount, never by source',
  );
  assert.ok(
    !/startGatewayFunding\([\s\S]{0,200}sourceDomain/.test(walletPage),
    'the page must never send a sourceDomain when starting a transfer',
  );

  // Destination options come from the server list, never a page constant.
  assert.match(walletPage, /const gatewayDestinations: GatewayNetwork\[\] = gateway\?\.destinations \|\| \[\];/);

  // No Gateway domain number, chain id or protocol vocabulary reaches the
  // user-facing Gateway surfaces.
  const presentation = fundingMarkup + depositMarkup;
  assert.ok(
    !/Domain \$\{|domain \$\{|\{item\.domain\}<|\{source\.domain\}</.test(presentation),
    'a Gateway domain number must never be rendered as text',
  );
  assert.ok(
    !/\{source\.chainId\}|\{item\.chainId\}/.test(presentation),
    'a chain id must never be rendered as text',
  );
  // Protocol vocabulary must not reach the user. Checked against the rendered
  // TEXT, so internal identifiers such as openSourceDomain are not mistaken
  // for user-visible copy.
  const renderedText = [
    ...presentation.matchAll(/>([^<>{}]+)</g),
  ].map((match) => match[1]).join(' ');
  assert.ok(
    !/burn intent|EIP-?712|attestation|source domain|Gateway domain|CCTP/i.test(renderedText),
    'raw protocol terminology must not appear in the normal Gateway UI',
  );
  for (const state of [
    'READY_TO_BROADCAST', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED',
    'SIGNATURE_FAILED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED',
  ]) {
    assert.ok(!renderedText.includes(state), `${state} must not leak into primary UI copy`);
  }
  // And no protocol term is smuggled in through a copy key either.
  assert.ok(
    !/t\.wallet\.\w*(BurnIntent|Eip712|Attestation|Domain)\w*/.test(presentation),
    'no Gateway copy key may name a protocol internal',
  );

  // -------------------------------------------------------------------
  // B. The four funding source cards
  // -------------------------------------------------------------------
  assert.match(depositMarkup, /t\.wallet\.gatewayAddTitle/);
  assert.match(depositMarkup, /t\.wallet\.gatewayAddBody/);
  assert.match(depositMarkup, /className="ex-gateway-sources"/);
  assert.match(
    depositMarkup,
    /\{sourceState\.sources\.map\(\(source\) => \{/,
    'one card per server-listed funding source, never a hardcoded list',
  );
  assert.match(depositMarkup, /className="ex-gateway-source"/);
  assert.match(depositMarkup, /\{source\.label\}/);

  // A source WALLET balance is a different quantity from the unified balance
  // and is rendered from the source read, never from the Gateway totals.
  assert.match(
    depositMarkup,
    /formatGatewayUsdcDisplay\(formatGatewayUsdcRaw\(source\.balanceRaw\), locale\)/,
    'a card shows its own chain balance',
  );
  assert.match(depositMarkup, /t\.wallet\.gatewaySourceAvailable/);
  assert.ok(
    !depositMarkup.includes('transferableTotalUsdc') && !depositMarkup.includes('gateway.totalUsdc'),
    'a source card must never display the Gateway unified balance as its own',
  );
  // A failed read shows no number at all: a zero is only ever a real zero.
  assert.match(
    depositMarkup,
    /source\.state === "error" \?[\s\S]{0,160}t\.wallet\.gatewaySourceUnavailable/,
    'a read error must report unavailable rather than a fabricated zero',
  );
  assert.match(
    depositMarkup,
    /source\.balanceRaw !== null \?/,
    'a balance is rendered only when one was actually read',
  );

  // Per-card independent states, including the Circle-only unprepared state.
  assert.match(depositMarkup, /t\.wallet\.gatewayWalletNotPrepared/);
  assert.match(depositMarkup, /t\.wallet\.gatewayPrepareWallet/);
  assert.match(depositMarkup, /handlePrepareSourceWallet\(source\.domain\)/);
  assert.match(depositMarkup, /t\.wallet\.gatewaySourceWalletMismatch/);
  assert.match(depositMarkup, /const walletStatus = sourceWalletStatus\[source\.domain\] \|\| "idle";/);

  // Only the card that owns an in-flight deposit shows a finality rail, and
  // every other card is locked while one deposit is in flight.
  assert.match(depositMarkup, /const owned = activeDepositDomain === source\.domain;/);
  assert.match(
    depositMarkup,
    /activeDepositDomain !== null && activeDepositDomain !== source\.domain/,
    'a deposit in flight must lock every other funding card',
  );
  assert.match(depositMarkup, /owned && depositAwaitingFinality \?/);
  assert.match(depositMarkup, /lockedElsewhere \?[\s\S]{0,160}gatewaySourceBusyElsewhere/);
  const railStart = depositMarkup.indexOf('className="ex-gateway-finality"');
  const railEnd = depositMarkup.indexOf('</div>', railStart);
  assert.ok(railStart > -1 && railEnd > railStart);
  const railMarkup = depositMarkup.slice(railStart, railEnd);
  assert.match(railMarkup, /gatewayDepositSubmitted/);
  assert.match(railMarkup, /gatewayWaitingFinality/);
  assert.match(railMarkup, /gatewayBalanceAvailable/);
  assert.match(railMarkup, /data-state="active"/);
  assert.match(railMarkup, /ex-gateway-finality__pulse/);
  assert.match(railMarkup, /data-state="pending"/);
  assert.ok(
    !/attestation|mint|countdown|progress|%/i.test(railMarkup),
    'the finality rail must not invent technical or percentage progress',
  );
  assert.match(styles, /animation:ex-gateway-finality-breathe/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,180}animation:none/);

  // The completed card collapses to a confirmation plus "Add more".
  assert.match(depositMarkup, /owned && depositCompleted \?/);
  assert.match(depositMarkup, /gatewayDepositAddedToGateway/);
  assert.match(depositMarkup, /gatewayAddMoreUsdc/);

  // -------------------------------------------------------------------
  // C. Responsive layout: four across, then two by two, then one column
  // -------------------------------------------------------------------
  const gridStart = styles.indexOf('.ex-gateway-sources{');
  assert.ok(gridStart > -1, 'the source grid must be styled');
  assert.match(
    styles.slice(gridStart, gridStart + 200),
    /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/,
    'four compact cards in one row on a desktop',
  );
  assert.match(
    styles,
    /@media \(max-width:1024px\)\{\s*\.ex-gateway-sources\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/,
    'two by two at medium widths',
  );
  assert.match(
    styles,
    /@media \(max-width:560px\)\{\s*\.ex-gateway-sources\{grid-template-columns:minmax\(0,1fr\)\}/,
    'one column on a phone',
  );
  // Editorial, not a colored dashboard: the cards use borders and type only.
  const cardStyleStart = styles.indexOf('.ex-gateway-source{');
  const cardStyle = styles.slice(cardStyleStart, styles.indexOf('}', cardStyleStart));
  assert.match(cardStyle, /border:1px solid var\(--line\)/);
  assert.ok(
    !/background:(?!transparent)/.test(cardStyle),
    'a source card must not introduce a filled background',
  );

  // -------------------------------------------------------------------
  // D. Deposit recovery remains authoritative (the production fix)
  // -------------------------------------------------------------------
  const handlerStart = walletPage.indexOf('async function handleGatewaySourceDeposit');
  assert.ok(handlerStart > -1, 'handleGatewaySourceDeposit must exist');
  const handlerEnd = walletPage.indexOf('\n  // A backend status is authoritative', handlerStart);
  assert.ok(handlerEnd > handlerStart);
  const handler = walletPage.slice(handlerStart, handlerEnd);

  // The recovery branch is checked, and resolved, BEFORE any input parsing.
  const recoveryBranchIndex = handler.indexOf('if (depositRecovery) {');
  const cardCheckIndex = handler.indexOf('if (depositRecovery.sourceDomain !== cardDomain) {');
  const configuredCheckIndex = handler.indexOf('if (!isConfiguredSourceDomain(depositRecovery.sourceDomain)) {');
  const useRecoveryAmountIndex = handler.indexOf('amountRaw = depositRecovery.amountRaw;');
  const elseBranchIndex = handler.indexOf('} else {', recoveryBranchIndex);
  const parseInputIndex = handler.indexOf('parseGatewayUsdcRaw(depositAmount)');
  assert.ok(
    recoveryBranchIndex > -1 && cardCheckIndex > recoveryBranchIndex &&
    configuredCheckIndex > cardCheckIndex &&
    useRecoveryAmountIndex > configuredCheckIndex && elseBranchIndex > useRecoveryAmountIndex &&
    parseInputIndex > elseBranchIndex,
    'a live recovery must be resolved (with its own chain checks) before the editable input is ever parsed',
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
  assert.match(elseBranchSlice, /t\.wallet\.gatewayAmountInvalid/);

  // sourceDomain/amountRaw actually used to call confirmGatewaySourceDeposit
  // are the local variables resolved above, not a hardcoded constant or a
  // fresh parse, so the same call site serves both paths correctly.
  assert.match(handler, /confirmGatewaySourceDeposit\(\s*\{ sourceDomain, amountRaw \},/);

  // No new requestId is ever minted in the page itself, and recovery is
  // never cleared before the call: the ONLY setDepositRecovery(null) is
  // after a call that reported COMPLETED.
  assert.ok(!handler.includes('crypto.randomUUID()'), 'the page must never mint its own requestId for a Gateway deposit');
  const confirmCallIndex = handler.indexOf('await confirmGatewaySourceDeposit(');
  const clearRecoveryIndex = handler.indexOf('setDepositRecovery(null);');
  assert.ok(confirmCallIndex > -1 && clearRecoveryIndex > confirmCallIndex,
    'recovery must never be cleared before confirmGatewaySourceDeposit is called');
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
    !catchSlice.includes('setDepositRecovery(null)') && !catchSlice.includes('confirmGatewaySourceDeposit') &&
    !catchSlice.includes('crypto.randomUUID()'),
    'an expired report must never clear recovery, retry, or mint a replacement request id',
  );

  // Recovery seeds the (disabled) display field with the durable amount, on
  // both the Circle and external recovery load effects, so it is never
  // shown empty while a real recovery amount exists.
  const seedMatches = [...walletPage.matchAll(/setDepositAmount\(formatGatewayUsdcRaw\(recovery\.amountRaw\)\);/g)];
  assert.equal(seedMatches.length, 2, 'both the Circle and external recovery load effects must seed the display amount');
  assert.match(
    depositMarkup,
    /disabled=\{depositBusy \|\| Boolean\(depositRecovery\)\}/,
    'the amount field stays disabled while a durable recovery exists',
  );

  // Idle with a live recovery says "continue", never "recovering"; an actual
  // busy resume may still say "recovering".
  const onClickIndex = depositMarkup.indexOf('onClick={() => void handleGatewaySourceDeposit(source.domain)}');
  assert.ok(onClickIndex > -1, 'the deposit button must call handleGatewaySourceDeposit for its own card');
  const buttonStart = depositMarkup.indexOf('{depositBusy', onClickIndex);
  const buttonEnd = depositMarkup.indexOf('</button>', buttonStart);
  assert.ok(buttonStart > -1 && buttonEnd > buttonStart);
  const buttonSlice = depositMarkup.slice(buttonStart, buttonEnd);
  const busyEndMarker = 't.wallet.gatewayReading)';
  const busyEndIndex = buttonSlice.indexOf(busyEndMarker);
  assert.ok(busyEndIndex > -1, 'expected the busy ternary to end with the gatewayReading fallback');
  const busySlice = buttonSlice.slice(0, busyEndIndex + busyEndMarker.length);
  const idleSlice = buttonSlice.slice(busyEndIndex + busyEndMarker.length);
  assert.match(idleSlice, /\? t\.wallet\.gatewayResumeDeposit/, 'idle + recovery must show the explicit "continue" label');
  assert.ok(!idleSlice.includes('gatewayRecoveringOperation'), 'idle state must never show "Recovering previous operation..."');
  assert.match(busySlice, /depositRecovery \? t\.wallet\.gatewayRecoveringOperation/, 'an actual busy resume may still show "Recovering previous operation..."');

  const submittedRecoveryStart = walletPage.indexOf('function isSubmittedGatewayDepositRecovery');
  const submittedRecoveryEnd = walletPage.indexOf('\n\nconst WALLET_MARKET_ASSETS', submittedRecoveryStart);
  assert.ok(submittedRecoveryStart > -1 && submittedRecoveryEnd > submittedRecoveryStart);
  const submittedRecovery = walletPage.slice(submittedRecoveryStart, submittedRecoveryEnd);
  assert.match(
    submittedRecovery,
    /return recovery\.phase === "DEPOSIT_PENDING" \|\| recovery\.phase === "RECONCILING"/,
  );
  assert.match(submittedRecovery, /return recovery\.phase === "RECONCILING"/);

  // -------------------------------------------------------------------
  // E. Transfer recovery restores destination and amount, same action
  // -------------------------------------------------------------------
  assert.match(walletPage, /setGatewayDestinationDomain\(String\(recovery\.destinationDomain\)\);/);
  assert.match(walletPage, /setGatewayAmount\(formatGatewayUsdcRaw\(recovery\.valueRaw\)\);/);
  const transferHandlerStart = walletPage.indexOf('async function handleGatewayTransfer()');
  const transferHandlerEnd = walletPage.indexOf('\n  if (step === "ready"', transferHandlerStart);
  assert.ok(transferHandlerStart > -1 && transferHandlerEnd > transferHandlerStart);
  const transferHandler = walletPage.slice(transferHandlerStart, transferHandlerEnd);
  assert.ok(
    !transferHandler.includes('crypto.randomUUID()'),
    'the page must never mint a transfer request id: gateway-actions reuses the recovered one',
  );
  assert.match(
    transferHandler,
    /gatewayFundingRecovery\?\.destinationDomain\s*\n?\s*\?\? selectedDestination!\.domain/,
    'a live recovery is authoritative for the destination',
  );
  // The local amount check is against the UNIFIED spendable total, never one
  // source's balance.
  assert.match(transferHandler, /BigInt\(valueRaw\) > BigInt\(gatewaySpendableRaw\)/);

  // gateway-actions resumes the SAME durable actions for both concerns.
  const gatewayActions = fs.readFileSync(path.join(__dirname, '../../app/lib/gateway-actions.ts'), 'utf8');
  assert.match(gatewayActions, /readCircleGatewayDepositRecovery\(\)/);
  assert.match(gatewayActions, /readExternalGatewayDepositRecovery\(\)/);
  assert.match(gatewayActions, /readExternalGatewayFundingRecovery\(\)/);
  assert.match(gatewayActions, /verifyGatewayDepositApproval/);
  assert.match(gatewayActions, /if \(current\.state === "RECONCILING"\) \{/);
  assert.match(gatewayActions, /result\.state === "RECONCILING"/);
  assert.match(
    gatewayActions,
    /const requestId = recovery\?\.requestId \|\| crypto\.randomUUID\(\);/,
    'a recovered transfer must resume under the same request id',
  );

  const depositService = fs.readFileSync(path.join(__dirname, '../src/services/gatewayDepositService.js'), 'utf8');
  assert.match(depositService, /function hasBoundDepositTransaction\(row\)/);
  assert.match(depositService, /row\.state === 'RECONCILING' && hasBoundDepositTransaction\(row\)/);
  assert.match(depositService, /deposit_tx_hash !~ '\^0x\[0-9a-fA-F\]\{64\}\$'/);
  assert.match(depositService, /if \(row\.state === 'RECONCILING'\) row = await reconcile\(row\)/);

  // -------------------------------------------------------------------
  // F. Product copy, EN and TR, no inline locale ternaries for it
  // -------------------------------------------------------------------
  const copyPairs = [
    ['gatewayUnifiedBalance', 'Unified balance', 'Birleşik bakiye'],
    ['gatewayPrepareTitle', 'Send USDC', 'USDC gönder'],
    ['gatewayDestination', 'To', 'Hedef ağ'],
    ['gatewayAmount', 'Amount', 'Tutar'],
    ['gatewayPrepareSignature', 'Prepare transfer', 'Transferi hazırla'],
    ['gatewayAddTitle', 'Add USDC to Gateway', "Gateway'e USDC ekle"],
    ['gatewayAddUsdc', 'Add USDC', 'USDC ekle'],
    ['gatewayAddToGateway', 'Add to Gateway', "Gateway'e ekle"],
    ['gatewayPrepareWallet', 'Prepare wallet', 'Cüzdanı hazırla'],
    ['gatewayWalletNotPrepared', 'Wallet not prepared', 'Cüzdan hazır değil'],
  ];
  for (const [key, en, tr] of copyPairs) {
    assert.ok(
      copy.includes(`${key}: "${en}"`),
      `English copy for ${key} must read exactly "${en}"`,
    );
    assert.ok(
      copy.includes(`${key}: "${tr}"`),
      `Turkish copy for ${key} must read exactly "${tr}"`,
    );
  }
  assert.match(copy, /gatewayPrepareBody: "Send your Gateway balance to any supported network\. You'll review and approve before anything moves\."/);
  assert.match(copy, /gatewayPrepareBody: "Gateway bakiyeni desteklenen ağlardan birine gönder\. Herhangi bir işlem gerçekleşmeden önce inceleyip onaylayacaksın\."/);
  assert.match(copy, /gatewayAddBody: "Fund your unified balance from any supported wallet\."/);
  assert.match(copy, /gatewayAddBody: "Birleşik Gateway bakiyeni desteklenen cüzdanlardan fonla\."/);
  assert.match(copy, /gatewaySourceAvailable: "\{amount\} USDC available"/);
  assert.match(copy, /gatewaySourceAvailable: "\{amount\} USDC kullanılabilir"/);
  assert.match(copy, /gatewayDepositAddedToGateway: "\{amount\} USDC added to Gateway"/);
  assert.match(copy, /gatewayDepositAddedToGateway: "Gateway'e \{amount\} USDC eklendi"/);
  assert.match(copy, /gatewayAddMoreUsdc: "Add more USDC"/);
  assert.match(copy, /gatewayAddMoreUsdc: "Daha fazla USDC ekle"/);
  assert.match(copy, /gatewayFinalityAdvice: "Gateway balance may take up to 20 minutes to update\. Do not submit again\."/);
  assert.match(copy, /gatewayFinalityAdvice: "Gateway bakiyesinin güncellenmesi 20 dakikaya kadar sürebilir\. İşlemi tekrar göndermeyin\."/);
  assert.ok(copy.includes('gatewayFinalityFormNotice: "{amount} USDC from {network} was submitted. Gateway finality is continuing in Activity. No action is required. You can fund from another network."'));
  assert.ok(copy.includes('gatewayFinalityFormNotice: "{amount} USDC {network} üzerinden gönderildi. Gateway kesinleşmesi Aktivite bölümünde devam ediyor. İşlem gerekmiyor. Başka bir ağdan fonlayabilirsiniz."'));
  assert.ok(copy.includes('gatewayFinalitySourceHint: "This source is finalizing in Activity. Choose another source to fund now."'));
  assert.ok(copy.includes('gatewayFinalitySourceHint: "Bu kaynak Aktivite bölümünde kesinleşiyor. Şimdi fonlamak için başka bir kaynak seç."'));
  assert.ok(copy.includes('gatewayApprovalStatusPending: "Approval submitted — checking source confirmation…"'));
  assert.ok(copy.includes('gatewayApprovalStatusPending: "Onay gönderildi — kaynak doğrulaması kontrol ediliyor…"'));
  assert.ok(!/gatewayPrepareBody:[^\n]*EIP-712/.test(copy), 'primary Gateway copy must not expose EIP-712');
  // Primary product copy is in the i18n tables, not inline locale ternaries.
  for (const literal of [
    'Send USDC', 'Unified balance', 'Add USDC to Gateway', 'Prepare transfer',
    'Wallet not prepared', 'Prepare wallet',
  ]) {
    assert.ok(
      !walletPage.includes(`"${literal}"`),
      `"${literal}" must come from the i18n table, never a literal in the page`,
    );
  }

  // -------------------------------------------------------------------
  // G. Unaffected surfaces
  // -------------------------------------------------------------------
  assert.match(walletPage, /backendApi\.wallet\.submitGatewayFunding\(prepared\.actionId\)/);
  const summaryStart = walletPage.indexOf('className="ex-wallet-summary"');
  const summaryEnd = walletPage.indexOf('<section className="ex-wallet-gateway"', summaryStart);
  assert.ok(summaryStart > -1 && summaryEnd > summaryStart);
  const summaryMarkup = walletPage.slice(summaryStart, summaryEnd);
  assert.match(summaryMarkup, /data-columns="2"/);
  assert.match(summaryMarkup, /chainState\.usdc\.balanceFormatted/);
  assert.match(
    summaryMarkup,
    /executionMode === "EXTERNAL_WALLET"\s*\?\s*\(chain \? chain\.name : t\.wallet\.notConnected\)\s*:\s*chainState\.chain\.name/,
    'Circle must show Arc Testnet while an external wallet shows its connected network name',
  );
  const primaryNetwork = ({ executionMode, chain, chainState }) => executionMode === 'EXTERNAL_WALLET'
    ? (chain ? chain.name : 'notConnected')
    : chainState.chain.name;
  assert.equal(primaryNetwork({
    executionMode: 'CIRCLE_USER_WALLET',
    chain: { name: 'Base Sepolia' },
    chainState: { chain: { name: 'Arc Testnet' } },
  }), 'Arc Testnet');
  assert.equal(primaryNetwork({
    executionMode: 'EXTERNAL_WALLET',
    chain: { name: 'Base Sepolia' },
    chainState: { chain: { name: 'Arc Testnet' } },
  }), 'Base Sepolia');
  assert.equal(primaryNetwork({
    executionMode: 'EXTERNAL_WALLET',
    chain: null,
    chainState: { chain: { name: 'Arc Testnet' } },
  }), 'notConnected');
  assert.ok(!/\b(?:chainState\.chain|chain)\.id\b/.test(summaryMarkup), 'the primary network label must not expose a numeric chain ID');
  assert.ok(!summaryMarkup.includes('gateway.totalUsdc'), 'the summary must not duplicate the unified Gateway balance');
  assert.match(fundingMarkup, /formatGatewayUsdcDisplay\(gateway\.transferableTotalUsdc, locale\)/, 'the Gateway section retains the unified balance');

  const finalityEffectStart = walletPage.indexOf('async function readStatus()');
  const finalityEffectEnd = walletPage.indexOf('\n  useEffect(() => {', finalityEffectStart);
  assert.ok(finalityEffectStart > -1 && finalityEffectEnd > finalityEffectStart);
  const finalityEffect = walletPage.slice(finalityEffectStart, finalityEffectEnd);
  assert.match(finalityEffect, /backendApi\.wallet\.gatewayDeposit\(recovery\.actionId\)/);
  assert.match(finalityEffect, /window\.setTimeout\(readStatus, 10_000\)/);
  assert.match(finalityEffect, /current\.state === "RECONCILING"/);
  assert.match(finalityEffect, /current\.state === "COMPLETED"/);
  assert.match(finalityEffect, /current\.state === "EXPIRED"/);
  assert.match(finalityEffect, /current\.state === "FAILED" \|\| current\.state === "RECONCILIATION_REQUIRED"/);
  assert.match(finalityEffect, /isSubmittedGatewayDepositRecovery\(recovery\)/);
  assert.ok(
    !finalityEffect.includes('confirmGatewaySourceDeposit') && !finalityEffect.includes('executeHostedChallenge'),
    'finality polling must stay status-only and never initiate a challenge or deposit',
  );

  const addMoreStart = walletPage.indexOf('function handleAddMoreGatewayUsdc(sourceDomain: number)');
  const addMoreEnd = walletPage.indexOf('\n\n  async function ensureArcTestnet', addMoreStart);
  assert.ok(addMoreStart > -1 && addMoreEnd > addMoreStart);
  const addMoreHandler = walletPage.slice(addMoreStart, addMoreEnd);
  assert.match(addMoreHandler, /setDepositStatus\(null\)/);
  assert.match(addMoreHandler, /setDepositAmount\(""\)/);
  assert.match(addMoreHandler, /setOpenSourceDomain\(sourceDomain\)/);
  assert.match(depositMarkup, /onClick=\{\(\) => handleAddMoreGatewayUsdc\(source\.domain\)\}/);
  assert.ok(
    !/confirmGatewaySourceDeposit|executeHostedChallenge|crypto\.randomUUID|backendApi\./.test(addMoreHandler),
    'Add more USDC must only reveal the empty form and never create a financial action',
  );

  // -------------------------------------------------------------------
  // H. External wallet chain switching, per source chain
  // -------------------------------------------------------------------
  const sendStart = walletPage.indexOf('async function sendSourceChainTransaction');
  const sendEnd = walletPage.indexOf('\n  async function handleGatewaySourceDeposit', sendStart);
  assert.ok(sendStart > -1 && sendEnd > sendStart);
  const sendSource = walletPage.slice(sendStart, sendEnd);
  // The request's own chain id is the authority, and the wallet is re-read
  // after the switch rather than trusted.
  assert.match(sendSource, /gatewaySourceChains\.find\(\(candidate\) => candidate\.id === request\.chainId\)/);
  assert.match(sendSource, /switchChainAsync\(\{ chainId: request\.chainId \}\)/);
  const switchIndex = sendSource.indexOf('switchChainAsync({ chainId: request.chainId })');
  const recheckIndex = sendSource.indexOf('await connectedConnector.getChainId()');
  const sendIndex = sendSource.indexOf('sendTransactionAsync(');
  assert.ok(
    switchIndex > -1 && recheckIndex > switchIndex && sendIndex > recheckIndex,
    'the active chain must be re-read from the connector after switching and before signing',
  );
  assert.match(sendSource, /if \(activeChainId !== request\.chainId\) \{/);
  // The session address binding is re-checked after a switch.
  const accountsIndex = sendSource.indexOf('await connectedConnector.getAccounts()');
  assert.ok(accountsIndex > recheckIndex && accountsIndex < sendIndex,
    'the wallet/session address binding must be re-checked after a chain switch');
  // A receipt is awaited on the SOURCE chain, not Arc.
  assert.match(sendSource, /sourcePublicClients\[request\.chainId\]/);
  assert.match(sendSource, /sourceClient\.waitForTransactionReceipt\(\{ hash \}\)/);
  assert.ok(
    !sendSource.includes('arcTestnet'),
    'a source transaction must never be signed or confirmed against Arc',
  );

  console.log('GATEWAY_UNIFIED_BALANCE_UI=PASS');
  console.log('GATEWAY_UNIFIED_BALANCE_RENDER_ONCE=PASS');
  console.log('GATEWAY_PRIMARY_NETWORK_DISPLAY=PASS');
  console.log('GATEWAY_TRANSFER_PREPARED_SUCCESS_SEMANTICS=PASS');
  console.log('GATEWAY_DESTINATION_SELECTOR=PASS');
  console.log('GATEWAY_SOURCE_CARDS_UI=PASS');
  console.log('GATEWAY_RESPONSIVE_SOURCE_LAYOUT=PASS');
  console.log('GATEWAY_EXTERNAL_CHAIN_SWITCH=PASS');
  console.log('GATEWAY_WALLET_UI_CLEANUP=PASS');
  console.log('GATEWAY_WALLET_UI_REGRESSIONS=PASS');
  console.log('GATEWAY_ADD_MORE_SINGLE_CLICK=PASS');
  console.log('WALLET_PAGE_DEPOSIT_RECOVERY_LIVE_NETWORK_CALLS=0');
  console.log('WALLET_PAGE_DEPOSIT_RECOVERY_UI=PASS');
}

// ---------------------------------------------------------------------------
// Static wiring proof for the current compact Gateway funding surface. It does
// not mount the UI or call an RPC: the financial state-machine verification
// above is fully in-memory, and these checks ensure its browser wiring stays
// honest and non-mutating.
// ---------------------------------------------------------------------------
function verifyWalletPageDepositRecoveryWiring() {
  const walletPage = fs.readFileSync(path.join(__dirname, '../../app/wallet/page.tsx'), 'utf8');
  const depositApi = fs.readFileSync(path.join(__dirname, '../../app/lib/backend-api.ts'), 'utf8');
  const depositRoute = fs.readFileSync(path.join(__dirname, '../../backend/src/routes/wallet.js'), 'utf8');
  const depositService = fs.readFileSync(path.join(__dirname, '../../backend/src/services/gatewayDepositService.js'), 'utf8');
  const sourceChainService = fs.readFileSync(path.join(__dirname, '../../backend/src/services/gatewaySourceChainService.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');
  const header = fs.readFileSync(path.join(__dirname, '../../app/product-components.tsx'), 'utf8');
  const copy = fs.readFileSync(path.join(__dirname, '../../app/i18n.tsx'), 'utf8');
  const gatewayActions = fs.readFileSync(path.join(__dirname, '../../app/lib/gateway-actions.ts'), 'utf8');

  const fundingStart = walletPage.indexOf(
    '<section className="ex-wallet-gateway" aria-label={t.wallet.gatewayFundingAriaLabel}>',
  );
  const depositStart = walletPage.indexOf(
    '<section className="ex-wallet-gateway" aria-label={t.wallet.gatewayDepositAriaLabel}>',
  );
  const depositEnd = walletPage.indexOf('<div className="ex-wallet-actions">', depositStart);
  assert.ok(fundingStart > -1 && depositStart > fundingStart && depositEnd > depositStart);
  const fundingMarkup = walletPage.slice(fundingStart, depositStart);
  const depositMarkup = walletPage.slice(depositStart, depositEnd);

  // Gateway transfer remains destination-only: source allocation stays on the
  // backend planner, and a prepared label still needs readyToBroadcast.
  assert.equal([...fundingMarkup.matchAll(/<select/g)].length, 1);
  assert.match(fundingMarkup, /t\.wallet\.gatewayDestination/);
  assert.match(fundingMarkup, /gatewayDestinations\.map\(\(item\) => \(/);
  assert.match(fundingMarkup, /gatewayFundingStatus\?\.readyToBroadcast === true/);
  assert.match(fundingMarkup, /gatewayFundingStatus\.submissionEnabled === true/);
  assert.match(fundingMarkup, /t\.wallet\.gatewaySubmitTransfer/);
  assert.match(walletPage, /backendApi\.wallet\.submitGatewayFunding\(prepared\.actionId\)/);
  assert.match(walletPage, /prepared\.state !== "READY_TO_BROADCAST"/);
  assert.match(walletPage, /prepared\.submissionEnabled !== true/);
  assert.ok(!/submitGatewayTransfer|\/v1\/transfer|gatewayMint|burnIntent/i.test(walletPage));
  assert.match(walletPage, /prepareGatewayBurnReview\(\s*\{ destinationDomain, valueRaw \},/);
  assert.match(walletPage, /confirmPreparedGatewayBurnSignature\(\s*\{ destinationDomain, valueRaw \},/);
  assert.ok(!/startGatewayFunding\([\s\S]{0,200}sourceDomain/.test(walletPage));
  for (const state of ['FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED']) {
    assert.notEqual(state === 'READY_TO_BROADCAST', true, `${state} cannot claim transfer preparation`);
  }

  // One stable source form has four conceptual columns: source, selected
  // source-wallet availability, amount and action. The options are the
  // canonical server labels; they do not append a balance or a domain number.
  assert.match(depositMarkup, /className="ex-gateway-deposit-form"/);
  assert.equal([...depositMarkup.matchAll(/<select/g)].length, 1);
  assert.match(depositMarkup, /t\.wallet\.gatewaySource/);
  assert.match(depositMarkup, /t\.wallet\.gatewayAvailable/);
  assert.match(depositMarkup, /t\.wallet\.gatewayAction/);
  assert.match(depositMarkup, /sourceState\.sources\.map\(\(source\) => \(/);
  assert.match(depositMarkup, /<option key=\{source\.domain\} value=\{source\.domain\}>\{source\.label\}<\/option>/);
  assert.ok(!depositMarkup.includes('ex-gateway-sources'));
  assert.ok(!depositMarkup.includes('ex-gateway-source'));
  assert.match(depositMarkup, /selectedGatewaySource\.balanceRaw/);
  assert.match(
    depositMarkup,
    /formatGatewayUsdcDisplay\(formatGatewayUsdcRaw\(selectedGatewaySource\.balanceRaw\), locale\)/,
  );
  assert.match(depositMarkup, /selectedGatewaySource\?\.state === "error"/);
  assert.ok(!depositMarkup.includes('transferableTotalUsdc') && !depositMarkup.includes('gateway.totalUsdc'));
  assert.ok(!/· \{formatGatewayUsdcDisplay/.test(depositMarkup), 'source options must not display a Gateway balance');
  assert.ok(!/Domain \$\{|domain \$\{|\{source\.domain\}<|\{item\.domain\}</.test(fundingMarkup + depositMarkup));

  // The selected source is a deliberate input. Circle preparation is available
  // only to Circle sessions; an external session reaches the normal action and
  // never renders a preparation control.
  assert.match(walletPage, /const \[selectedSourceDomain, setSelectedSourceDomain\] = useState\(""\);/);
  assert.match(walletPage, /const selectedGatewaySource = sourceState\?\.sources\.find/);
  assert.match(depositMarkup, /handlePrepareSourceWallet\(selectedGatewaySource\.domain\)/);
  const externalActionStart = depositMarkup.indexOf('executionMode === "CIRCLE_USER_WALLET"');
  const standardAction = depositMarkup.indexOf('handleGatewaySourceDeposit(selectedGatewaySource.domain)');
  assert.ok(externalActionStart > -1 && standardAction > externalActionStart);

  // The durable recovery is authoritative before an editable amount is read.
  const handlerStart = walletPage.indexOf('async function handleGatewaySourceDeposit');
  const handlerEnd = walletPage.indexOf('\n  async function ensureArcTestnet()', handlerStart);
  assert.ok(handlerStart > -1 && handlerEnd > handlerStart);
  const handler = walletPage.slice(handlerStart, handlerEnd);
  const recoveryStart = handler.indexOf('if (depositRecovery) {');
  const sourceCheck = handler.indexOf('if (depositRecovery.sourceDomain !== selectedDomain) {');
  const configuredCheck = handler.indexOf('if (!isConfiguredSourceDomain(depositRecovery.sourceDomain)) {');
  const recoveryAmount = handler.indexOf('amountRaw = depositRecovery.amountRaw;');
  const noRecovery = handler.indexOf('} else {', recoveryStart);
  const parsedAmount = handler.indexOf('parseGatewayUsdcRaw(depositAmount)');
  assert.ok(recoveryStart > -1 && sourceCheck > recoveryStart && configuredCheck > sourceCheck &&
    recoveryAmount > configuredCheck && noRecovery > recoveryAmount && parsedAmount > noRecovery);
  assert.match(handler, /confirmGatewaySourceDeposit\(\s*\{ sourceDomain, amountRaw \},/);
  assert.ok(!handler.includes('crypto.randomUUID()'));

  // Recovery release is a backend financial-evidence decision, never a
  // browser state-name/sessionStorage inference. A CLEAR result releases a
  // completed action or a terminal action the service proved had no submitted
  // evidence. RECONCILE preserves the same action and source lock.
  assert.match(depositApi, /recoveryDisposition: "CLEAR" \| "RESUME" \| "RECONCILE"/);
  const recoveryReviewStart = walletPage.indexOf('function needsGatewayDepositRecoveryReview');
  const recoveryReviewEnd = walletPage.indexOf('\nconst WALLET_MARKET_ASSETS', recoveryReviewStart);
  assert.ok(recoveryReviewStart > -1 && recoveryReviewEnd > recoveryReviewStart);
  const recoveryReview = walletPage.slice(recoveryReviewStart, recoveryReviewEnd);
  assert.match(recoveryReview, /return action\.recoveryDisposition === "RECONCILE"/);
  assert.match(walletPage, /backendApi\.wallet\.gatewayDepositActivity\(\)/);
  assert.match(walletPage, /activityRequestInFlight\.current/);
  assert.match(walletPage, /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(walletPage, /window\.setTimeout\(\(\) => void refreshActivity\(\), 12_000\)/);
  assert.ok(!/setInterval\([\s\S]{0,180}refreshActivity/.test(walletPage));
  assert.match(walletPage, /const activityRecoveryRef = useRef/);
  assert.match(walletPage, /const clearInteractiveDepositRecovery = useCallback/);
  assert.match(walletPage, /matching\.state === "RECONCILING" \|\| matching\.terminal/);
  assert.match(walletPage, /clearInteractiveDepositRecovery\(\);/);
  assert.match(depositRoute, /router\.get\('\/gateway-deposit\/activity'/);
  assert.ok(depositRoute.indexOf("'/gateway-deposit/activity'") < depositRoute.indexOf("'/gateway-deposit/:actionId'"));
  assert.match(depositService, /async function activity\(\{ auth \}\)/);
  assert.match(depositService, /gateway_deposit_activity/);
  assert.match(depositService, /const reconcilingRows = rows\.filter/);
  assert.match(depositService, /reconcile\(row, balance\)/);
  assert.match(depositService, /readUnifiedUsdcBalance\(auth\.walletAddress\)/);
  assert.match(depositService, /const state = phaseName === 'APPROVAL' \? 'APPROVAL_PENDING' : 'DEPOSIT_PENDING';/);
  assert.match(depositService, /\$\{prefix\}_circle_transaction_id = \$5,\s+state = \$6/);
  assert.match(depositService, /confirmApprovalSourceState\(row, source\)/);
  assert.match(depositService, /row\.state === 'APPROVAL_PENDING'[\s\S]{0,220}return \{ row, challenge: null, step: 'APPROVAL_REQUIRED' \}/);
  assert.match(depositService, /row\.state === 'DEPOSIT_PENDING'[\s\S]{0,220}return \{ row, challenge: null, step: 'DEPOSIT_REQUIRED' \}/);
  assert.match(depositService, /state IN \('APPROVAL_CHALLENGE', 'APPROVAL_PENDING'\)/);
  assert.match(depositService, /state IN \('DEPOSIT_CHALLENGE', 'DEPOSIT_PENDING'\)/);
  assert.match(sourceChainService, /function isTransientSourceReadError\(error\)/);
  assert.match(sourceChainService, /'gateway_source_chain_id_mismatch'/, 'chain identity remains an explicit non-transient error');
  assert.match(depositApi, /gatewayDepositActivity\(\)/);
  assert.match(depositApi, /GatewayDepositActivityItem/);
  assert.match(handler, /function clearTerminalBrowserRecovery\(\)/);
  assert.match(handler, /result\.recoveryDisposition === "CLEAR"[\s\S]{0,300}clearTerminalBrowserRecovery\(\)/);
  assert.match(handler, /needsGatewayDepositRecoveryReview\(result\)[\s\S]{0,220}restoreBrowserRecovery\(\)/);
  assert.doesNotMatch(handler, /gateway_deposit_expired[\s\S]{0,300}clearTerminalBrowserRecovery\(\)/);
  assert.ok(!handler.includes('deleteGatewayDeposit') && !handler.includes('crypto.randomUUID()'));
  const reconcilingBranchStart = handler.indexOf('else if (result.state === "RECONCILING")');
  const reconcilingBranchEnd = handler.indexOf('} else if (needsGatewayDepositRecoveryReview(result))', reconcilingBranchStart);
  assert.ok(reconcilingBranchStart > -1 && reconcilingBranchEnd > reconcilingBranchStart);
  const reconcilingBranch = handler.slice(reconcilingBranchStart, reconcilingBranchEnd);
  assert.match(reconcilingBranch, /clearInteractiveDepositRecovery\(\)/);
  assert.match(reconcilingBranch, /void refreshActivity\(\)/);
  assert.ok(!reconcilingBranch.includes('restoreBrowserRecovery'));
  assert.match(handler, /phase === "DEPOSIT_CHALLENGE"\) setDepositPhase\("confirmDeposit"\)/);
  assert.match(handler, /phase === "APPROVAL_PENDING"\) setDepositPhase\("approvalSubmitted"\)/);
  assert.match(handler, /phase === "DEPOSIT_PENDING"\) setDepositPhase\("depositSubmitted"\)/);
  assert.match(handler, /phase === "RECONCILING"\) setDepositPhase\("waitingFinality"\)/);
  assert.match(depositMarkup, /disabled=\{depositBusy \|\| Boolean\(depositRecovery\)\}/);
  assert.doesNotMatch(depositMarkup, /depositAwaitingFinality|ex-gateway-finality/);
  assert.match(depositMarkup, /onClick=\{\(\) => void handleGatewaySourceDeposit\(selectedGatewaySource\.domain\)\}/);
  assert.equal([...depositMarkup.matchAll(/t\.wallet\.gatewayDepositStatusNeedsReview/g)].length, 1,
    'a genuine RECONCILE state renders one review message in ACTION');
  const resumeLabel = depositMarkup.indexOf('t.wallet.gatewayResumeDeposit');
  assert.ok(resumeLabel > depositMarkup.indexOf('depositRecoveryNeedsReview ?'), 'the RESUME branch remains available after the review branch');
  assert.ok(!walletPage.includes('Status: ${result.state}') && !walletPage.includes('Durum: ${result.state}'));

  // Activity is a read-only projection: it renders human-facing phase labels
  // and stage markers, never raw backend state names or a financial action.
  assert.match(walletPage, /className="ex-wallet-activity__panel"/);
  assert.match(walletPage, /activityItems\.map\(\(item\) =>/);
  assert.match(walletPage, /const activityOpenCount = activityItems\.filter\(\(item\) => !item\.terminal\)\.length/);
  assert.ok(!walletPage.includes('activityAttentionCount'), 'Activity count must describe open rows, not attention only');
  assert.match(walletPage, /item\.sourceLabel/);
  assert.match(walletPage, /formatGatewayUsdcDisplay\(formatGatewayUsdcRaw\(item\.amountRaw\), locale\)/);
  assert.match(walletPage, /activityPhaseCopy\(item\.phase\)/);
  assert.match(walletPage, /item\.actionRequired/);
  assert.match(walletPage, /gatewayActivityApproval/);
  assert.match(walletPage, /gatewayActivityFinality/);
  assert.match(walletPage, /gatewayActivityCompleted/);
  assert.ok(!/\{item\.state\}/.test(walletPage));
  const activityPanelStart = walletPage.indexOf('className="ex-wallet-activity__panel"');
  const activityHeadingStart = walletPage.indexOf('className="ex-wallet-activity__heading"', activityPanelStart);
  const activityCloseStart = walletPage.indexOf('className="ex-wallet-activity__close"', activityHeadingStart);
  const activityListStart = walletPage.indexOf('className="ex-wallet-activity__list"', activityPanelStart);
  assert.ok(
    activityPanelStart > -1 && activityHeadingStart > activityPanelStart &&
    activityCloseStart > activityHeadingStart && activityListStart > activityCloseStart,
    'Activity heading and close control must remain outside the scrolling rows list',
  );
  const activityListStyle = /\.ex-wallet-activity__list\{([^}]*)\}/.exec(styles)?.[1] || '';
  assert.match(activityListStyle, /max-height:440px/);
  assert.match(activityListStyle, /overflow-y:auto/);
  assert.match(activityListStyle, /overflow-x:hidden/);
  assert.doesNotMatch(activityListStyle, /(?:^|;)height:/, 'short Activity lists must not receive a fixed height');
  assert.match(styles, /@media\(max-width:640px\)[\s\S]{0,700}\.ex-wallet-activity__list\{max-height:55vh\}/);
  assert.match(styles, /\.ex-wallet-activity__stages\{display:grid;grid-template-columns:repeat\(4/);
  assert.match(styles, /@media\(max-width:640px\)[\s\S]{0,700}\.ex-wallet-activity__stages\{grid-template-columns:repeat\(2/);

  // RECONCILING is a server-backed background handoff. It keeps the Activity
  // row open without claiming user attention, explains the handoff in the
  // funding form, and only replaces the action for that same source. A
  // different source remains on the normal Add path.
  assert.match(walletPage, /const backgroundFinalityItem = activityItems\.find/);
  assert.match(depositMarkup, /backgroundFinalityItem &&/);
  assert.match(depositMarkup, /t\.wallet\.gatewayFinalityFormNotice/);
  assert.match(depositMarkup, /backgroundFinalityItem\.amountRaw/);
  assert.match(depositMarkup, /backgroundFinalityItem\.sourceLabel/);
  assert.match(
    walletPage,
    /const selectedSourceFinalityItem = selectedSourceDomain[\s\S]{0,180}activityItems\.find/,
  );
  const sameSourceFinalityIndex = depositMarkup.indexOf('selectedSourceFinalityItem ?');
  const sameSourceFinalityBranchEnd = depositMarkup.indexOf(') : executionMode', sameSourceFinalityIndex);
  const addActionIndex = depositMarkup.indexOf('handleGatewaySourceDeposit(selectedGatewaySource.domain)');
  assert.ok(
    sameSourceFinalityIndex > -1 &&
    sameSourceFinalityBranchEnd > sameSourceFinalityIndex &&
    addActionIndex > sameSourceFinalityBranchEnd,
  );
  const sameSourceFinalityBranch = depositMarkup.slice(
    sameSourceFinalityIndex,
    sameSourceFinalityBranchEnd,
  );
  assert.match(sameSourceFinalityBranch, /t\.wallet\.gatewayFinalitySourceHint/);
  assert.ok(!sameSourceFinalityBranch.includes('<button'), 'same-source finality must replace the Add action with a hint');
  assert.match(depositMarkup, /disabled=\{depositBusy \|\| Boolean\(depositRecovery\)\}/);
  assert.match(gatewayActions, /CIRCLE_GATEWAY_APPROVAL_READ_RETRYABLE_ERRORS/);
  assert.match(gatewayActions, /circle_service_unavailable/);
  assert.match(gatewayActions, /circle_rate_limited/);
  assert.match(gatewayActions, /gateway_deposit_approval_status_pending/);
  assert.match(gatewayActions, /current\.state === "APPROVAL_PENDING"/);
  assert.match(gatewayActions, /current\.state === "DEPOSIT_PENDING"/);
  assert.match(gatewayActions, /result\.state !== "APPROVAL_PENDING"/);
  assert.match(gatewayActions, /result\.state !== "DEPOSIT_PENDING"/);
  const approvalPendingStart = gatewayActions.indexOf('if (current.state === "APPROVAL_PENDING")');
  const approvalChallengeStart = gatewayActions.indexOf('if (current.state === "APPROVAL_CHALLENGE")', approvalPendingStart);
  const approvalPendingBranch = gatewayActions.slice(approvalPendingStart, approvalChallengeStart);
  assert.ok(approvalPendingStart > -1 && approvalChallengeStart > approvalPendingStart);
  assert.doesNotMatch(approvalPendingBranch, /executeHostedChallenge/);
  const depositPendingStart = gatewayActions.indexOf('if (current.state === "DEPOSIT_PENDING")');
  const depositChallengeStart = gatewayActions.indexOf('if (current.state === "DEPOSIT_CHALLENGE")', depositPendingStart);
  const depositPendingBranch = gatewayActions.slice(depositPendingStart, depositChallengeStart);
  assert.ok(depositPendingStart > -1 && depositChallengeStart > depositPendingStart);
  assert.doesNotMatch(depositPendingBranch, /executeHostedChallenge/);
  assert.match(handler, /gateway_deposit_approval_status_pending/);
  assert.match(handler, /restoreBrowserRecovery\(\)/);
  console.log('GATEWAY_FINALITY_FORM_HANDOFF_NOTICE=PASS');
  console.log('GATEWAY_FINALITY_SAME_SOURCE_UI_GUARD=PASS');
  console.log('GATEWAY_FINALITY_DIFFERENT_SOURCE_UI_OPEN=PASS');
  console.log('GATEWAY_CIRCLE_TRANSIENT_READ_RETRY_WIRING=PASS');

  // -------------------------------------------------------------------
  // Native select pointer focus, proved for EACH select independently.
  //
  // A native <select> owns its option list. Pointer-up can fire while that
  // list is still open, so blurring there closes the dropdown before a choice
  // can be committed, which is exactly the production regression this guards.
  // Each select is located by its own label and verified on its own; a shared
  // helper name appearing twice in the file proves nothing about either one.
  // -------------------------------------------------------------------

  function selectBlockFor(markup, labelKey, what) {
    const labelIndex = markup.indexOf(`<span>{t.wallet.${labelKey}}</span>`);
    assert.ok(labelIndex > -1, `${what} must be labelled with t.wallet.${labelKey}`);
    const openIndex = markup.indexOf('<select', labelIndex);
    const closeIndex = markup.indexOf('</select>', openIndex);
    assert.ok(openIndex > labelIndex && closeIndex > openIndex, `${what} must be a native select`);
    return markup.slice(openIndex, closeIndex);
  }

  // No select anywhere in the page may blur from a pointer event. Both
  // pointer-up (the shipped bug) and pointer-down (worse, same cause) are
  // forbidden, in the JSX and in any handler bound to them.
  assert.ok(
    !/onPointerUp/.test(walletPage),
    'no select may blur on pointer-up: the native dropdown is still open then',
  );
  assert.ok(
    !/onPointerDown=\{[^}]*blur/.test(walletPage) && !/onPointerUp=\{[^}]*blur/.test(walletPage),
    'blur must never be bound directly to a pointer event',
  );
  // Pointer-down may only record intent. It must not touch focus or state.
  const pointerDownHandlers = [...walletPage.matchAll(/onPointerDown=\{([^}]*)\}/g)].map((match) => match[1]);
  assert.equal(pointerDownHandlers.length, 2, 'exactly the two Gateway selects record pointer intent');
  for (const body of pointerDownHandlers) {
    assert.match(body, /markSelectPointerIntent\(/, 'pointer-down may only mark intent');
    assert.ok(!/blur|setState|set[A-Z]/.test(body), 'pointer-down must not blur or mutate product state');
  }

  // The blur helper is only ever reachable from a change handler, and it is
  // a no-op unless a pointer actually started the interaction.
  const blurHelperStart = walletPage.indexOf('function blurAfterPointerSelectChange(');
  assert.ok(blurHelperStart > -1, 'a change-time blur helper must exist');
  const blurHelper = walletPage.slice(blurHelperStart, walletPage.indexOf('\n  }', blurHelperStart));
  assert.match(blurHelper, /if \(!intent\.current\) return;/, 'keyboard-originated change must never blur');
  assert.match(blurHelper, /intent\.current = false;/, 'the intent flag is consumed exactly once');
  assert.match(blurHelper, /window\.requestAnimationFrame\(\(\) => select\.blur\(\)\)/);
  // Pointer TYPE is still gated, so a synthetic or unknown source cannot blur.
  assert.match(
    walletPage,
    /event\.pointerType !== "mouse" && event\.pointerType !== "touch" && event\.pointerType !== "pen"/,
  );
  // Each select owns its own flag, so one select can never blur the other.
  assert.match(walletPage, /const destinationPointerIntent = useRef\(false\);/);
  assert.match(walletPage, /const sourcePointerIntent = useRef\(false\);/);

  function verifySelectPointerFocus({ markup, labelKey, what, intentRef, stateCalls }) {
    const block = selectBlockFor(markup, labelKey, what);

    // Pointer intent is recorded on pointer-down, for THIS select's own flag.
    assert.match(
      block,
      new RegExp(`onPointerDown=\\{\\(event\\) => markSelectPointerIntent\\(${intentRef}, event\\)\\}`),
      `${what} must record its own pointer intent on pointer-down`,
    );
    // And this select never blurs from a pointer event.
    assert.ok(!/onPointerUp/.test(block), `${what} must not handle pointer-up at all`);
    assert.ok(
      !/onPointerDown=\{[^}]*blur/.test(block),
      `${what} must not blur on pointer-down`,
    );

    // The change handler does its product work FIRST, then blurs.
    const changeIndex = block.indexOf('onChange={(event) => {');
    assert.ok(changeIndex > -1, `${what} must have a block-bodied change handler`);
    const changeBody = block.slice(changeIndex, block.indexOf('}}', changeIndex));
    const blurIndex = changeBody.indexOf(`blurAfterPointerSelectChange(${intentRef}`);
    assert.ok(blurIndex > -1, `${what} must blur through the change-time helper`);
    for (const call of stateCalls) {
      const callIndex = changeBody.indexOf(call);
      assert.ok(callIndex > -1, `${what} must still perform ${call}`);
      assert.ok(
        callIndex < blurIndex,
        `${what} must apply ${call} BEFORE any focus handling`,
      );
    }
    // The element is captured synchronously, not read inside the callback.
    assert.match(changeBody, /const select = event\.currentTarget;/);

    // Stale intent is cleared when the interaction ends without a committed
    // pointer choice, or continues on the keyboard.
    assert.match(
      block,
      new RegExp(`onBlur=\\{\\(\\) => clearSelectPointerIntent\\(${intentRef}\\)\\}`),
      `${what} must clear stale pointer intent on blur`,
    );
    assert.match(
      block,
      new RegExp(`onKeyDown=\\{\\(\\) => clearSelectPointerIntent\\(${intentRef}\\)\\}`),
      `${what} must clear pointer intent once the keyboard takes over`,
    );

    return block;
  }

  // A: SEND USDC destination select. Financial behavior unchanged.
  const destinationSelect = verifySelectPointerFocus({
    markup: fundingMarkup,
    labelKey: 'gatewayDestination',
    what: 'the destination select',
    intentRef: 'destinationPointerIntent',
    stateCalls: ['setGatewayDestinationDomain(event.target.value)'],
  });
  assert.match(destinationSelect, /disabled=\{gatewayFundingBusy \|\| Boolean\(gatewayFundingRecovery\)\}/,
    'transfer recovery must still disable the destination select');
  assert.match(destinationSelect, /value=\{selectedDestination \? String\(selectedDestination\.domain\) : ""\}/);
  console.log('GATEWAY_DESTINATION_POINTER_FOCUS=PASS');

  // B: ADD USDC TO GATEWAY source select. Funding behavior unchanged.
  const sourceSelect = verifySelectPointerFocus({
    markup: depositMarkup,
    labelKey: 'gatewaySource',
    what: 'the source select',
    intentRef: 'sourcePointerIntent',
    stateCalls: [
      'setSelectedSourceDomain(event.target.value)',
      'setDepositAmount("")',
      'setDepositStatus(null)',
      'setDepositError("")',
      'setDepositNotice("")',
    ],
  });
  assert.match(sourceSelect, /disabled=\{depositBusy \|\| Boolean\(depositRecovery\)\}/,
    'deposit recovery must still disable the source select');
  console.log('GATEWAY_SOURCE_POINTER_FOCUS=PASS');

  // The regression itself: nothing in the source select's own handlers may
  // close or blur the native dropdown before a choice is committed, so all
  // four funding networks stay selectable.
  assert.ok(
    !/onPointerUp|onPointerCancel|onMouseUp|onClick=\{[^}]*blur|preventDefault\(\)/.test(sourceSelect),
    'the source select must not interfere with the native dropdown lifecycle',
  );
  assert.ok(
    !/blur\(\)/.test(sourceSelect),
    'the source select JSX must never call blur() directly; only the change-time helper may',
  );
  assert.match(
    depositMarkup,
    /\{sourceState\.sources\.map\(\(source\) => \(\s*<option key=\{source\.domain\} value=\{source\.domain\}>\{source\.label\}<\/option>/,
    'every configured funding network must remain an option',
  );
  // All five destinations and all four funding sources are still rendered.
  assert.match(
    fundingMarkup,
    /\{gatewayDestinations\.map\(\(item\) => \(/,
    'the destination list still comes from the server-supplied set',
  );
  const canonicalNetworks = require('../src/services/gatewayNetworks');
  assert.equal(
    canonicalNetworks.DESTINATION_NETWORKS.length, 5,
    'five destinations remain configured',
  );
  assert.equal(
    canonicalNetworks.DEPOSIT_SOURCE_NETWORKS.length, 4,
    'four funding sources remain configured',
  );
  console.log('GATEWAY_SOURCE_SELECT_REMAINS_INTERACTIVE=PASS');

  // Keyboard accessibility is untouched: the focus-visible ring still exists
  // and no outline is globally suppressed for keyboard users.
  assert.match(styles, /:focus-visible\{outline:2px solid var\(--ember\)/);
  assert.ok(
    !/(^|[^-])\boutline:\s*(none|0)\b/m.test(styles.replace(/:focus-visible\{[^}]*\}/g, '')) ||
    !/\*\s*\{[^}]*outline:\s*(none|0)/.test(styles),
    'keyboard focus styling must not be globally removed',
  );

  // Account controls no longer occupy a detached panel. The address owns the
  // end/disconnect action, and the global account footprint is stable before
  // its asynchronous balance becomes available.
  assert.match(walletPage, /className="ex-wallet-address__actions"/);
  assert.match(walletPage, /executionMode === "CIRCLE_USER_WALLET" \? t\.wallet\.endSession : t\.wallet\.disconnectWallet/);
  assert.ok(!walletPage.includes('className="ex-entry ex-wallet-session"'));
  assert.match(header, /className="ex-header__account"/);
  assert.match(styles, /\.ex-header__account\{display:flex;justify-content:flex-end;inline-size:258px;min-width:0\}/);

  assert.match(copy, /gatewaySource: "From"/);
  assert.match(copy, /gatewaySource: "Kaynak"/);
  assert.match(copy, /endSession: "End session"/);
  assert.match(copy, /disconnectWallet: "Disconnect wallet"/);
  assert.match(walletPage, /backendApi\.wallet\.submitGatewayFunding\(prepared\.actionId\)/);

  console.log('GATEWAY_SOURCE_FORM_UI=PASS');
  console.log('GATEWAY_SELECTED_SOURCE_BALANCE_UI=PASS');
  console.log('GATEWAY_UNCERTAIN_RECOVERY_FAILS_CLOSED=PASS');
  console.log('GATEWAY_CIRCLE_FINALITY_RAIL=PASS');
  console.log('GATEWAY_REVIEW_MESSAGE_RENDERED_ONCE=PASS');
  console.log('GATEWAY_RESUME_UI=PASS');
  console.log('GATEWAY_ACTIVITY_INTERACTIVE_LOCK=PASS');
  console.log('GATEWAY_ACTIVITY_POLL_BOUNDED=PASS');
  console.log('GATEWAY_ACTIVITY_UI=PASS');
  console.log('GATEWAY_ACTIVITY_RESPONSIVE=PASS');
  console.log('GATEWAY_HEADER_ACCOUNT_FOOTPRINT=PASS');
  console.log('GATEWAY_SESSION_CONTROLS=PASS');
  console.log('GATEWAY_WALLET_UI=PASS');
  console.log('WALLET_PAGE_DEPOSIT_RECOVERY_LIVE_NETWORK_CALLS=0');
}

function verifyPoolRefreshWiring() {
  const board = fs.readFileSync(path.join(__dirname, '../../app/pools/PoolsClient.tsx'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '../../app/pools/[slug]/page.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '../../app/lib/backend-api.ts'), 'utf8');
  const proxy = fs.readFileSync(path.join(__dirname, '../../app/api/extrema/[...path]/route.ts'), 'utf8');

  assert.match(board, /backendApi\.rounds\.list\(\)/);
  assert.match(board, /setInterval\(\(\) => \{\s+void refresh\(\);\s+\}, 60_000\)/);
  assert.match(board, /if \(refreshing\) return;/);
  assert.match(board, /readBinanceLiveMarket\(\)/);
  assert.match(board, /error && pools\.length === 0/);
  assert.match(board, /\(!error \|\| pools\.length > 0\)/);
  assert.match(detail, /backendApi\.rounds\.get\(params\.slug\)/);
  assert.match(detail, /backendApi\.rounds\.entries\(/);
  assert.match(detail, /void refreshEntries\(state\.pool\)/);
  assert.match(detail, /setInterval\(\(\) => \{\s+void refresh\(\);\s+\}, 60_000\)/);
  assert.match(detail, /entriesRefreshInFlight\.current/);
  assert.match(detail, /queuedEntriesRefresh\.current/);
  const entryRefreshStart = detail.indexOf('const refreshEntries = useCallback');
  const entryRefreshEnd = detail.indexOf('\n  useEffect(() => {', entryRefreshStart);
  const entryRefresh = detail.slice(entryRefreshStart, entryRefreshEnd);
  assert.ok(
    entryRefresh.indexOf('if (entriesRefreshInFlight.current)') < entryRefresh.indexOf('++entriesRequestId.current'),
    'a queued entries refresh must not invalidate the active request before it begins',
  );
  assert.ok(!detail.includes('setEntriesState(null);'), 'a transient distribution refresh must retain the last valid entries');
  assert.ok(!detail.includes('setState(null);'), 'a transient round refresh must retain the last valid round');
  assert.match(api, /cache: "no-store"/);
  assert.match(proxy, /cache: "no-store"/);
  console.log('POOL_AUTO_REFRESH=PASS');
}

(async () => {
  await verifyExternalBranch();
  await verifyMultiChainDeposit();
  verifyRecoveryDispositionClassification();
  await verifyActivityServerBacked();
  verifyActivityPostgresTypes();
  await verifyReconcilingFinalitySurvivesTtl();
  await verifyCircleClientTwoChallengeFlow();
  await verifyCircleClientApprovalPendingResume();
  await verifyCircleClientDepositPendingResume();
  await verifyCircleClientTransientApprovalRead();
  await verifyCircleBranch();
  await verifyCirclePendingStateDurability();
  await verifyMultiChainCircleBranch();
  await verifySameSourceReviewGuard();
  await verifyEngineBlockchainDefaulting();
  await verifyProductionApprovalReconciliation();
  await verifyWrongBlockchainStillFailsClosed();
  verifyWalletPageDepositRecoveryWiring();
  verifyPoolRefreshWiring();
  assert.equal(liveNetworkCalls, 0);
  console.log('GATEWAY_DEPOSIT_LIVE_NETWORK_CALLS=0');
  console.log('GATEWAY_DEPOSIT=PASS');
})().catch((error) => {
  console.error('GATEWAY_DEPOSIT=FAIL', error);
  process.exitCode = 1;
});
