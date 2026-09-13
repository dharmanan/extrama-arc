'use strict';

const crypto = require('node:crypto');
const { ethers } = require('ethers');
const gatewayNetworks = require('./gatewayNetworks');

const GATEWAY_API_URL = 'https://gateway-api-testnet.circle.com';
const TOKEN = 'USDC';

// Gateway identifies each chain by a CCTP domain, not by chain id. Arc Testnet
// is domain 26. Confirmed against the live GET /v1/info response on 2026-09-09,
// which lists ARC / Testnet / domain 26 with both a wallet and a minter
// contract, so Arc is usable as a Gateway transfer destination.
const ARC_GATEWAY_DOMAIN = 26;

// Contract addresses are not restated here: gatewayNetworks is the single
// canonical Gateway network configuration for the whole backend.
const { GATEWAY_WALLET_CONTRACT, GATEWAY_MINTER_CONTRACT } = gatewayNetworks;

// Circle caps one transfer request at 16 burn intents.
const MAX_BURN_INTENTS = 16;

// EIP-712 definition of a burn intent, copied field for field from Circle's
// current EVM unified balance quickstart. The domain deliberately carries only
// a name and a version: a burn intent is chain agnostic, which is why one Arc
// EOA signature can spend a balance held on any source domain. Address shaped
// fields are bytes32 because Gateway also serves non EVM chains, and the
// quickstart submits the signed message itself as the burn intent, so the
// submitted and signed shapes are one and the same.
const BURN_INTENT_EIP712_DOMAIN = { name: 'GatewayWallet', version: '1' };

const BURN_INTENT_EIP712_TYPES = {
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
};

// Circle's EVM Gateway contracts also define a BurnIntentSet, which packs
// several burn intents that share one sourceSigner into a single EIP-712
// signature. Its exact type string, from the typehash in Circle's own
// evm-gateway-contracts source, is:
//
//   BurnIntentSet(BurnIntent[] intents)BurnIntent(uint256 maxBlockHeight,
//   uint256 maxFee,TransferSpec spec)TransferSpec(...)
//
// verify-gateway-service asserts that this local definition still encodes to
// exactly that string, so the shape can never silently drift from Circle's.
//
// EXTREMA does NOT sign a set. Circle's documented multi-source example for
// the forwarding path this module uses signs each intent on its own and posts
// them as one array of { burnIntent, signature } entries to /v1/transfer, and
// that per-intent array is the only multi-source shape confirmed end to end
// against the current API. Keeping the definition here (verified, unused for
// submission) records the deliberate choice instead of leaving a guess in its
// place: a set signature would have to be matched by a set-shaped request
// body, and inventing that body is exactly the failure mode to avoid.
const BURN_INTENT_SET_EIP712_TYPES = {
  ...BURN_INTENT_EIP712_TYPES,
  BurnIntentSet: [{ name: 'intents', type: 'BurnIntent[]' }],
};

const TRANSFER_SPEC_VERSION = 1;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const GATEWAY_REJECTION_DIAGNOSTIC_MAX_TEXT = 160;

function gatewayHeaders() {
  const headers = { 'content-type': 'application/json' };
  // Gateway is a server-side Circle API. Keep the credential out of every
  // client payload and omit the header in deterministic local tests where no
  // credential is configured.
  if (process.env.CIRCLE_API_KEY) {
    headers.authorization = `Bearer ${process.env.CIRCLE_API_KEY}`;
  }
  return headers;
}

// A burn intent must name the USDC contract on the source chain, and that
// address differs per chain. Every EVM testnet domain that Circle Gateway
// currently supports is listed, with the token address taken from Circle's
// published USDC contract addresses page as the single source of truth.
//
// Solana (5) is deliberately absent: it is not EVM and does not use this
// EIP-712 signing path at all.
//
// An unlisted domain fails closed rather than being guessed. Adding one
// requires its address from official Circle documentation, never inference.
//
// The five domains EXTREMA presents as products (Arc, Base, OP, Arbitrum and
// Ethereum) are NOT restated here: they are spread in from gatewayNetworks so
// that one table owns them. The remaining entries are low-level protocol
// metadata only; the automatic EXTREMA planner and its transferable total are
// bounded by gatewayNetworks.TRANSFER_SOURCE_NETWORKS below.
//
// Arc (26) is present as a source as well as a destination. A unified balance
// deposited on Arc is spendable like any other, and Gateway's instant transfer
// path also allows a same chain withdrawal where source and destination match.
const TRANSFER_SOURCE_USDC_BY_DOMAIN = new Map(
  gatewayNetworks.TRANSFER_SOURCE_NETWORKS.map((network) => [network.domain, network.usdc]),
);

const SOURCE_USDC_BY_DOMAIN = new Map([
  ...TRANSFER_SOURCE_USDC_BY_DOMAIN,
  [1, '0x5425890298aed601595a70AB815c96711a31Bc65'], // Avalanche Fuji
  [7, '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'], // Polygon PoS Amoy
  [10, '0x31d0220469e10c4E71834a79b1f276d740d3768F'], // Unichain Sepolia
  // Domain 13 is "Sonic / Testnet" per Gateway's supported blockchains page and
  // per live /v1/info. Circle's USDC page also lists a separate "Sonic Blaze
  // Testnet" (0xA4879Fed...), which is a different network and must not be used
  // here. Checksum validation cannot catch this class of mistake.
  [13, '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51'], // Sonic Testnet
  [14, '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88'], // World Chain Sepolia
  [16, '0x4fCF1784B31630811181f670Aea7A7bEF803eaED'], // Sei Testnet
  [19, '0x2B3370eE501B4a559b57D449569354196457D8Ab'], // HyperEVM Testnet
]);

/**
 * Whether a unified balance held on this domain can actually be spent to Arc
 * through the EIP-712 path in this module. readUnifiedUsdcBalance reports every
 * domain Gateway knows about, including Solana and Arc itself, so execution
 * must never assume that a reported balance is transferable.
 */
function isTransferableSourceDomain(domain) {
  return TRANSFER_SOURCE_USDC_BY_DOMAIN.has(domain);
}

async function readUnifiedUsdcBalance(depositor, fetchImpl = fetch) {
  if (!ethers.isAddress(depositor)) {
    throw new Error('gateway_depositor_invalid');
  }

  const normalizedDepositor = ethers.getAddress(depositor);

  let response;
  try {
    response = await fetchImpl(`${GATEWAY_API_URL}/v1/balances`, {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify({
        token: TOKEN,
        sources: [{ depositor: normalizedDepositor }],
      }),
    });
  } catch {
    throw new Error('gateway_service_unavailable');
  }

  if (!response.ok) {
    throw new Error('gateway_service_unavailable');
  }

  const body = await response.json();

  if (
    body?.token !== TOKEN ||
    !Array.isArray(body?.balances)
  ) {
    throw new Error('gateway_response_invalid');
  }

  const balances = body.balances.map((item) => {
    if (
      !Number.isInteger(item?.domain) ||
      typeof item?.depositor !== 'string' ||
      typeof item?.balance !== 'string' ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(item.balance)
    ) {
      throw new Error('gateway_response_invalid');
    }

    let balanceRaw;
    try {
      balanceRaw = ethers.parseUnits(item.balance, 6).toString();
    } catch {
      throw new Error('gateway_response_invalid');
    }

    return {
      domain: item.domain,
      depositor: item.depositor,
      balance: item.balance,
      balanceRaw,
      // Gateway reports every domain it knows about, including Solana and Arc
      // itself. Only a domain this module can actually build a burn intent for
      // is spendable to Arc, so the distinction is carried in the data rather
      // than left for a caller to rediscover.
      transferable: isTransferableSourceDomain(item.domain),
    };
  });

  const sumRaw = (items) => items
    .reduce((total, item) => total + BigInt(item.balanceRaw), 0n)
    .toString();

  const totalRaw = sumRaw(balances);
  const transferableTotalRaw = sumRaw(balances.filter((item) => item.transferable));

  return {
    token: TOKEN,
    depositor: normalizedDepositor,
    totalRaw,
    totalUsdc: ethers.formatUnits(BigInt(totalRaw), 6),
    transferableTotalRaw,
    transferableTotalUsdc: ethers.formatUnits(BigInt(transferableTotalRaw), 6),
    balances,
  };
}

function toBytes32(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

function assertPositiveIntegerString(value, errorName) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(errorName);
  }
  return value;
}

/**
 * Builds one Gateway transfer spec.
 *
 * The destination is selectable, but only as a DOMAIN NUMBER: the destination
 * token and the minter contract are always read from the canonical network
 * table, never accepted from a caller. A browser can therefore choose which
 * supported network to be paid on and nothing else. The recipient, depositor
 * and signer are all the authenticated session wallet.
 *
 * sourceDomain === destinationDomain is allowed on purpose. A balance
 * deposited on Base can legitimately be materialized back onto Base through
 * Gateway's same chain withdrawal path, so matching domains are a valid
 * transfer rather than an error.
 */
function buildGatewayTransferSpec({
  walletAddress,
  sourceDomain,
  destinationDomain,
  valueRaw,
  salt = ethers.hexlify(crypto.randomBytes(32)),
}) {
  if (!ethers.isAddress(walletAddress)) throw new Error('gateway_wallet_invalid');
  if (!Number.isInteger(sourceDomain) || sourceDomain < 0) {
    throw new Error('gateway_source_domain_invalid');
  }
  if (!TRANSFER_SOURCE_USDC_BY_DOMAIN.has(sourceDomain)) {
    throw new Error('gateway_source_domain_unsupported');
  }
  if (!Number.isInteger(destinationDomain) || destinationDomain < 0) {
    throw new Error('gateway_destination_domain_invalid');
  }
  const destination = gatewayNetworks.destinationForDomain(destinationDomain);
  if (!destination) throw new Error('gateway_destination_domain_unsupported');
  assertPositiveIntegerString(valueRaw, 'gateway_value_invalid');
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error('gateway_salt_invalid');

  const wallet = ethers.getAddress(walletAddress);
  return Object.freeze({
    version: TRANSFER_SPEC_VERSION,
    sourceDomain,
    destinationDomain,
    sourceContract: toBytes32(GATEWAY_WALLET_CONTRACT),
    destinationContract: toBytes32(GATEWAY_MINTER_CONTRACT),
    sourceToken: toBytes32(TRANSFER_SOURCE_USDC_BY_DOMAIN.get(sourceDomain)),
    destinationToken: toBytes32(destination.usdc),
    sourceDepositor: toBytes32(wallet),
    destinationRecipient: toBytes32(wallet),
    sourceSigner: toBytes32(wallet),
    destinationCaller: toBytes32(ZERO_ADDRESS),
    value: valueRaw,
    salt,
    hookData: '0x',
  });
}

/**
 * Deterministically decides WHICH deposited source balances pay for a
 * transfer. This is protocol execution detail, resolved entirely on the
 * server: the product model is one unified balance, so a user picks an amount
 * and a destination and never nominates a source ledger.
 *
 * The rule is greedy largest first:
 *
 *   1. Keep only domains that hold a positive, spendable balance. A domain
 *      with nothing in it is never named in a plan.
 *   2. Order them by balance descending, then by domain ascending. Both keys
 *      together are unique, so the order is total and does not depend on the
 *      order Gateway happened to report balances in.
 *   3. Draw from each in turn, taking no more than that domain holds, until
 *      the requested value is covered.
 *
 * Largest first is what keeps the plan minimal: whenever a single domain can
 * cover the whole amount it produces exactly one intent and one signature, and
 * no allocation uses more chains than necessary. Replaying the same balances
 * and value always yields the identical plan.
 */
function planSourceAllocation({ balances, valueRaw }) {
  assertPositiveIntegerString(valueRaw, 'gateway_value_invalid');
  if (!Array.isArray(balances)) throw new Error('gateway_source_plan_unavailable');

  const spendable = balances
    .filter((item) => (
      item && item.transferable === true &&
      Number.isInteger(item.domain) &&
      typeof item.balanceRaw === 'string' && /^\d+$/.test(item.balanceRaw) &&
      BigInt(item.balanceRaw) > 0n
    ))
    .map((item) => ({ domain: item.domain, availableRaw: BigInt(item.balanceRaw) }))
    .sort((left, right) => {
      if (left.availableRaw !== right.availableRaw) {
        return left.availableRaw > right.availableRaw ? -1 : 1;
      }
      return left.domain - right.domain;
    });

  const requested = BigInt(valueRaw);
  const totalAvailable = spendable.reduce((total, item) => total + item.availableRaw, 0n);
  if (totalAvailable < requested) throw new Error('gateway_insufficient_usdc');

  const allocations = [];
  let remaining = requested;
  for (const item of spendable) {
    if (remaining === 0n) break;
    const draw = item.availableRaw < remaining ? item.availableRaw : remaining;
    allocations.push({ sourceDomain: item.domain, valueRaw: draw.toString() });
    remaining -= draw;
  }
  // Unreachable while the total check above holds, but a plan that does not
  // add up must never reach a signature.
  if (remaining !== 0n) throw new Error('gateway_insufficient_usdc');
  if (allocations.length > MAX_BURN_INTENTS) {
    throw new Error('gateway_source_plan_too_many_intents');
  }

  return {
    totalValueRaw: requested.toString(),
    allocations,
  };
}

// Fee-aware preparation needs to compare more than the one largest balance.
// Keep the historical greedy planner above unchanged for legacy callers, and
// expose a bounded deterministic candidate enumerator for the durable funding
// service. Only the five canonical EXTREMA transfer-source domains are
// returned; low-level metadata for other Gateway domains is never an automatic
// spendability signal.
function enumerateSourceAllocationPlans({
  balances,
  valueRaw,
  maxSources = MAX_BURN_INTENTS,
  sourceCount = null,
}) {
  assertPositiveIntegerString(valueRaw, 'gateway_value_invalid');
  if (!Array.isArray(balances)) throw new Error('gateway_source_plan_unavailable');
  if (!Number.isInteger(maxSources) || maxSources < 1) {
    throw new Error('gateway_source_plan_unavailable');
  }
  if (sourceCount !== null && (!Number.isInteger(sourceCount) || sourceCount < 1)) {
    throw new Error('gateway_source_plan_unavailable');
  }

  const spendable = balances
    .filter((item) => (
      item && item.transferable === true &&
      TRANSFER_SOURCE_USDC_BY_DOMAIN.has(item.domain) &&
      Number.isInteger(item.domain) &&
      typeof item.balanceRaw === 'string' && /^\d+$/.test(item.balanceRaw) &&
      BigInt(item.balanceRaw) > 0n
    ))
    .map((item) => ({ domain: item.domain, availableRaw: BigInt(item.balanceRaw) }))
    .sort((left, right) => {
      if (left.availableRaw !== right.availableRaw) {
        return left.availableRaw > right.availableRaw ? -1 : 1;
      }
      return left.domain - right.domain;
    });

  const requested = BigInt(valueRaw);
  const candidates = new Map();
  function addOrderedCandidate(ordered) {
    let remaining = requested;
    const allocations = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const item = ordered[index];
      const remainingSources = ordered.length - index - 1;
      // Keep at least one raw unit for every source in this candidate. This
      // makes the candidate's source count truthful and prevents zero-value
      // intents from entering the signing state machine.
      if (remaining < BigInt(remainingSources + 1)) return;
      const maximumDraw = remaining - BigInt(remainingSources);
      const draw = item.availableRaw < maximumDraw ? item.availableRaw : maximumDraw;
      if (draw <= 0n) return;
      allocations.push({ sourceDomain: item.domain, valueRaw: draw.toString() });
      remaining -= draw;
    }
    if (remaining !== 0n || allocations.length > maxSources) return;
    const key = JSON.stringify(allocations);
    candidates.set(key, { totalValueRaw: requested.toString(), allocations });
  }

  function choose(start, needed, subset) {
    if (needed === 0) {
      addOrderedCandidate(subset.slice().sort((left, right) => {
        if (left.availableRaw !== right.availableRaw) {
          return left.availableRaw > right.availableRaw ? -1 : 1;
        }
        return left.domain - right.domain;
      }));
      return;
    }
    for (let index = start; index <= spendable.length - needed; index += 1) {
      choose(index + 1, needed - 1, subset.concat(spendable[index]));
    }
  }

  const firstCount = sourceCount === null ? 1 : sourceCount;
  const lastCount = sourceCount === null ? Math.min(maxSources, spendable.length) : sourceCount;
  if (firstCount > lastCount || firstCount > maxSources || firstCount > spendable.length) return [];
  for (let count = firstCount; count <= lastCount; count += 1) {
    choose(0, count, []);
  }

  return [...candidates.values()].sort((left, right) => {
    if (left.allocations.length !== right.allocations.length) {
      return left.allocations.length - right.allocations.length;
    }
    return JSON.stringify(left.allocations).localeCompare(JSON.stringify(right.allocations));
  });
}

// Estimate is a preparation read. Submission below is kept as a separate
// explicit financial boundary and is only reached by the durable service when
// the server-side broadcast gate is enabled.
/**
 * Estimates every spec in a source plan in ONE request, and returns one
 * maxFee/maxBlockHeight pair per spec in the same order.
 *
 * Gateway's estimate endpoint already takes an array, which is also how a
 * multi-source transfer is submitted, so the plan is priced exactly as it will
 * be spent. A response that does not answer every spec fails closed instead of
 * letting one estimate be reused for a different source domain.
 */
async function estimateGatewayTransfer(specs, fetchImpl = fetch) {
  const list = Array.isArray(specs) ? specs : [specs];
  if (!list.length || list.length > MAX_BURN_INTENTS) {
    throw new Error('gateway_source_plan_unavailable');
  }

  let response;
  try {
    response = await fetchImpl(`${GATEWAY_API_URL}/v1/estimate?enableForwarder=true`, {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify(list.map((spec) => ({ spec }))),
    });
  } catch {
    throw new Error('gateway_service_unavailable');
  }
  if (!response.ok) throw new Error('gateway_estimate_unavailable');

  let body;
  try { body = await response.json(); } catch { throw new Error('gateway_response_invalid'); }
  const entries = body?.body;
  if (!Array.isArray(entries) || entries.length !== list.length) {
    throw new Error('gateway_response_invalid');
  }

  const intents = entries.map((entry) => {
    const burnIntent = entry?.burnIntent;
    if (
      !burnIntent ||
      !/^\d+$/.test(String(burnIntent.maxFee)) ||
      !/^[1-9]\d*$/.test(String(burnIntent.maxBlockHeight))
    ) {
      throw new Error('gateway_response_invalid');
    }
    return {
      maxFeeRaw: String(burnIntent.maxFee),
      maxBlockHeight: String(burnIntent.maxBlockHeight),
    };
  });

  return {
    intents,
    fees: body?.fees && typeof body.fees === 'object' ? body.fees : null,
  };
}

function gatewayError(code, metadata = {}) {
  const error = new Error(code);
  Object.assign(error, metadata);
  return error;
}

function safeGatewayDiagnosticText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/(?:authorization|bearer|api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|private[\s_-]?key|secret)\s*[:=]?/i.test(text)) {
    return null;
  }
  if (/0x[0-9a-f]{64,}/i.test(text)) return null;
  return text.slice(0, GATEWAY_REJECTION_DIAGNOSTIC_MAX_TEXT);
}

function providerDiagnosticRoots(body) {
  if (!body || typeof body !== 'object') return [];
  const roots = [
    body,
    body.body,
    Array.isArray(body.body) ? body.body[0] : null,
    body.error,
    body.body?.error,
    body.data,
    body.body?.data,
    body.details,
    body.body?.details,
  ];
  return roots.filter((root) => root && typeof root === 'object' && !Array.isArray(root));
}

function firstProviderDiagnosticValue(roots, keys) {
  for (const root of roots) {
    for (const key of keys) {
      if (root[key] !== undefined && root[key] !== null) return root[key];
    }
  }
  return null;
}

function extractGatewayTransferRejectionDiagnostics({ status, body, rawText }) {
  const roots = providerDiagnosticRoots(body);
  const providerCode = safeGatewayDiagnosticText(firstProviderDiagnosticValue(
    roots, ['errorCode', 'error_code', 'providerErrorCode', 'code'],
  ));
  const providerType = safeGatewayDiagnosticText(firstProviderDiagnosticValue(
    roots, ['errorType', 'error_type', 'providerErrorType', 'type'],
  ));
  const providerMessage = safeGatewayDiagnosticText(firstProviderDiagnosticValue(
    roots, ['errorMessage', 'error_message', 'providerMessage', 'message', 'detail'],
  )) || (body === null ? safeGatewayDiagnosticText(rawText) : null);
  const providerReason = safeGatewayDiagnosticText(firstProviderDiagnosticValue(
    roots, ['failureReason', 'failure_reason', 'reason'],
  ));
  return {
    status,
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(providerReason ? { providerReason } : {}),
  };
}

function classifyGatewayTransferRejection(diagnostics) {
  const providerSignals = [
    diagnostics?.providerCode,
    diagnostics?.providerType,
    diagnostics?.providerMessage,
    diagnostics?.providerReason,
  ].filter(Boolean).join(' ');
  if (/(?:fee|max[\s_-]?fee|forwarding[\s_-]?fee)/i.test(providerSignals)) {
    return 'gateway_transfer_fee_rejected';
  }
  if (/(?:invalid[\s_-]?(?:burn[\s_-]?)?intent|burn[\s_-]?intent|invalid[\s_-]?signature|validation)/i.test(providerSignals)) {
    return 'gateway_transfer_invalid_intent';
  }
  return 'gateway_transfer_rejected';
}

// A failed response body has one consumable stream. Prefer text so JSON can be
// parsed without a second read, while deterministic test doubles that only
// expose json() remain supported.
async function readGatewayErrorBodyOnce(response) {
  try {
    if (typeof response.text === 'function') {
      const rawText = await response.text();
      try { return { body: JSON.parse(rawText), rawText }; } catch { return { body: null, rawText }; }
    }
    if (typeof response.json === 'function') return { body: await response.json(), rawText: null };
  } catch {
    // The status itself remains useful even when the provider body is unreadable.
  }
  return { body: null, rawText: null };
}

// Submit an already-signed source plan to Circle's forwarding service as ONE
// transfer. Each entry is an individually signed burn intent, which is the
// official multi-source shape for this path: /v1/transfer takes the array and
// mints the aggregate value once on the destination.
//
// The durable request id is validated by the caller/state machine, and the
// state machine never retries this mutation after an uncertain response.
async function submitGatewayTransfer({ requests, requestId }, fetchImpl = fetch) {
  if (!Array.isArray(requests) || !requests.length || requests.length > MAX_BURN_INTENTS) {
    throw new Error('gateway_burn_intent_invalid');
  }
  for (const entry of requests) {
    if (!entry?.burnIntent || typeof entry.burnIntent !== 'object') {
      throw new Error('gateway_burn_intent_invalid');
    }
    if (typeof entry.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(entry.signature)) {
      throw new Error('gateway_signature_invalid');
    }
  }
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new Error('gateway_request_id_invalid');
  }

  let response;
  try {
    response = await fetchImpl(`${GATEWAY_API_URL}/v1/transfer?enableForwarder=true`, {
      method: 'POST',
      headers: gatewayHeaders(),
      body: JSON.stringify(requests.map((entry) => ({
        burnIntent: entry.burnIntent,
        signature: entry.signature,
      }))),
    });
  } catch {
    throw gatewayError('gateway_transfer_submit_unknown');
  }

  if (!response.ok) {
    const { body, rawText } = await readGatewayErrorBodyOnce(response);
    const gatewayDiagnostic = extractGatewayTransferRejectionDiagnostics({
      status: response.status,
      body,
      rawText,
    });
    // A deterministic 4xx is a remote rejection before acceptance. 5xx and
    // throttling remain ambiguous because the transfer may already exist.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw gatewayError(classifyGatewayTransferRejection(gatewayDiagnostic), {
        status: response.status,
        gatewayDiagnostic,
      });
    }
    throw gatewayError('gateway_transfer_submit_unknown', {
      status: response.status,
      gatewayDiagnostic,
    });
  }

  let body;
  try { body = await response.json(); } catch {
    throw new Error('gateway_transfer_submit_unknown');
  }
  const transferId = body?.transferId || body?.body?.transferId || body?.body?.[0]?.transferId || body?.id;
  if (typeof transferId !== 'string' || !/^[0-9a-f-]{36}$/i.test(transferId)) {
    throw new Error('gateway_transfer_submit_unknown');
  }
  return { transferId };
}

async function readGatewayTransferStatus(transferId, fetchImpl = fetch) {
  if (typeof transferId !== 'string' || !/^[0-9a-f-]{36}$/i.test(transferId)) {
    throw new Error('gateway_transfer_id_invalid');
  }
  let response;
  try {
    response = await fetchImpl(`${GATEWAY_API_URL}/v1/transfer/${encodeURIComponent(transferId)}`, {
      headers: gatewayHeaders(),
    });
  } catch {
    throw new Error('gateway_status_unknown');
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error('gateway_transfer_not_found');
    throw new Error('gateway_status_unknown');
  }
  let body;
  try { body = await response.json(); } catch { throw new Error('gateway_status_unknown'); }
  const status = String(body?.status || body?.body?.status || body?.body?.[0]?.status || '').toLowerCase();
  if (!status) throw new Error('gateway_status_unknown');
  const forwardingDetails = body?.forwardingDetails || body?.body?.forwardingDetails || body?.body?.[0]?.forwardingDetails;
  return {
    status,
    transactionHash: typeof body?.transactionHash === 'string'
      ? body.transactionHash
      : typeof body?.body?.transactionHash === 'string'
        ? body.body.transactionHash
        : typeof body?.body?.[0]?.transactionHash === 'string' ? body.body[0].transactionHash : null,
    forwardingFailure: typeof forwardingDetails?.failureReason === 'string'
      ? forwardingDetails.failureReason.slice(0, 120)
      : null,
  };
}

/**
 * Builds one burn intent that moves part of a unified balance to the selected
 * destination network.
 *
 * Every address in the payload is pinned rather than accepted from the caller:
 * the destination token and minter come from the canonical network table for
 * the chosen domain, and the depositor, recipient and signer are all the
 * wallet the authenticated session already owns. A browser can choose the
 * destination network and the amount; it can never redirect a signed burn
 * intent to another token, another contract or another recipient, which is the
 * only part of this payload that can lose funds.
 *
 * There is exactly one burn intent shape. Circle's quickstart submits the
 * signed EIP-712 message itself to /v1/transfer, so the returned `burnIntent`
 * and `typedData.message` are the same frozen object: what gets signed is
 * byte for byte what gets submitted, and the two cannot drift apart. For a
 * multi-source plan this holds per intent, since each is signed individually
 * and posted unchanged in the transfer array.
 *
 * `maxFeeRaw` and `maxBlockHeight` are validated inputs, not values this module
 * may invent. They must come from POST /v1/estimate?enableForwarder=true, whose
 * response supplies the maxFee and maxBlockHeight for the intent. A caller must
 * never pass browser supplied figures straight through.
 */
function buildGatewayBurnIntent({
  walletAddress,
  sourceDomain,
  destinationDomain,
  valueRaw,
  maxFeeRaw,
  maxBlockHeight,
  salt = ethers.hexlify(crypto.randomBytes(32)),
}) {
  // Preserve the original fail-closed precedence: identity/source/destination/
  // value/salt are invalid independently of any estimate values supplied
  // alongside them.
  const spec = buildGatewayTransferSpec({
    walletAddress, sourceDomain, destinationDomain, valueRaw, salt,
  });
  assertPositiveIntegerString(maxBlockHeight, 'gateway_max_block_height_invalid');

  if (typeof maxFeeRaw !== 'string' || !/^\d+$/.test(maxFeeRaw)) {
    throw new Error('gateway_max_fee_invalid');
  }
  const burnIntent = Object.freeze({ maxBlockHeight, maxFee: maxFeeRaw, spec });

  return {
    burnIntent,
    typedData: {
      domain: BURN_INTENT_EIP712_DOMAIN,
      types: BURN_INTENT_EIP712_TYPES,
      primaryType: 'BurnIntent',
      // Same object, not a copy: the signed message is the submitted intent.
      message: burnIntent,
    },
    // The digest the Circle wallet is asked to sign. Recovering this address
    // from the returned signature proves the session wallet signed this exact
    // intent before anything is submitted to Gateway.
    digest: ethers.TypedDataEncoder.hash(
      BURN_INTENT_EIP712_DOMAIN,
      BURN_INTENT_EIP712_TYPES,
      burnIntent,
    ),
  };
}

/**
 * Confirms a signature really came from the session wallet for this exact
 * intent. Gateway would reject a bad signature anyway, but checking locally
 * keeps a malformed or swapped signature from ever being submitted.
 */
function recoverBurnIntentSigner(typedData, signature) {
  try {
    return ethers.verifyTypedData(
      typedData.domain,
      typedData.types,
      typedData.message,
      signature,
    );
  } catch {
    throw new Error('gateway_signature_invalid');
  }
}

module.exports = {
  ARC_GATEWAY_DOMAIN,
  BURN_INTENT_EIP712_DOMAIN,
  BURN_INTENT_EIP712_TYPES,
  BURN_INTENT_SET_EIP712_TYPES,
  GATEWAY_API_URL,
  GATEWAY_MINTER_CONTRACT,
  GATEWAY_WALLET_CONTRACT,
  MAX_BURN_INTENTS,
  GATEWAY_REJECTION_DIAGNOSTIC_MAX_TEXT,
  TRANSFER_SOURCE_USDC_BY_DOMAIN,
  SOURCE_USDC_BY_DOMAIN,
  buildGatewayTransferSpec,
  buildGatewayBurnIntent,
  estimateGatewayTransfer,
  enumerateSourceAllocationPlans,
  planSourceAllocation,
  submitGatewayTransfer,
  classifyGatewayTransferRejection,
  extractGatewayTransferRejectionDiagnostics,
  readGatewayTransferStatus,
  isTransferableSourceDomain,
  readUnifiedUsdcBalance,
  recoverBurnIntentSigner,
};
