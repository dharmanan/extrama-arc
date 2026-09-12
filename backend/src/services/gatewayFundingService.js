'use strict';

// Durable Gateway transfer state machine.
//
// The product contract is a UNIFIED balance: the caller chooses an amount and
// a destination network, and nothing else. Which deposited source balances pay
// for the transfer is protocol execution detail resolved here, on the server,
// by gatewayService's deterministic fee-aware source candidate search. A browser never names a source
// domain, a token address or a contract address.
//
// Preparation produces one signed burn intent per source allocation. An
// explicitly enabled server may then submit exactly those intents once, as one
// transfer, and reconcile the forwarding-service transfer by id. Broadcast is
// disabled by default and never controlled by the browser.

const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../db');
const config = require('../config');
const gatewayService = require('./gatewayService');
const gatewayNetworks = require('./gatewayNetworks');
const circleUserWalletService = require('./circleUserWalletService');
const { EXECUTION_MODES, isHumanExecutionMode } = require('./executionIdentityService');

const FUNDING_TTL_MS = 30 * 60 * 1000;
const TERMINAL_FUNDING_STATES = new Set([
  'COMPLETED', 'FAILED', 'SIGNATURE_FAILED', 'EXPIRED',
]);
const ACTIVE_FUNDING_STATES = Object.freeze([
  'PREPARING', 'SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING',
  'READY_TO_BROADCAST', 'SUBMITTING', 'SUBMITTED', 'RECONCILIATION_REQUIRED',
]);
const PRE_SUBMISSION_DISCARD_STATES = Object.freeze([
  'PREPARING', 'SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING', 'READY_TO_BROADCAST',
]);
const FEE_AWARE_MAX_ITERATIONS = 6;
// Five canonical transfer sources produce 31 non-empty subsets. One-source
// plans are quoted once; multi-source subsets may be requoted at most six
// times, so preparation can make no more than 5 + 26 * 6 = 161 estimates.
const FEE_AWARE_MAX_ESTIMATE_CALLS = 161;

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('gateway_payload_invalid');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error('gateway_payload_invalid');
}

function hashPayload(value) {
  // String input is deliberately hashed byte-for-byte for the historical
  // single-source rows whose hash was made from JSON.stringify text. New rows
  // use the stable object serializer below, independent of JSONB key order.
  const serialized = typeof value === 'string' ? value : canonicalJson(value);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// A stable, UUID-shaped idempotency key derived from durable row state. The
// same row and the same allocation index always produce the same key, so a
// retried challenge creation can never become a second Circle challenge, and
// the key never depends on wall-clock time or randomness.
function derivedIdempotencyKey(seed) {
  const hex = hashPayload(seed).slice(0, 32);
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

// Both human execution modes can hold a Gateway transfer action. Circle mode
// additionally requires the session's Circle wallet id, since that is the
// wallet a Circle hosted challenge signs with; external mode signs locally
// with the connected wallet and never carries a Circle wallet id at all.
function assertHumanGatewaySession(auth) {
  if (
    !auth || !isHumanExecutionMode(auth.executionMode) ||
    typeof auth.userId !== 'string' ||
    !ethers.isAddress(auth.walletAddress) ||
    (auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET && typeof auth.circleWalletId !== 'string')
  ) {
    throw new Error('gateway_wallet_session_required');
  }
}

function assertInput({ requestId, destinationDomain, valueRaw }) {
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new Error('gateway_request_id_invalid');
  }
  if (!Number.isInteger(destinationDomain) || destinationDomain < 0) {
    throw new Error('gateway_destination_domain_invalid');
  }
  // The only destination identity a client may supply is a domain number, and
  // it must name a network this product actually supports. Everything else
  // about the destination is read from canonical server config.
  if (!gatewayNetworks.destinationForDomain(destinationDomain)) {
    throw new Error('gateway_destination_domain_unsupported');
  }
  if (typeof valueRaw !== 'string' || !/^[1-9]\d*$/.test(valueRaw)) {
    throw new Error('gateway_value_invalid');
  }
}

function isExpired(row) {
  return new Date(row.expires_at).getTime() <= Date.now();
}

// --- Row shape compatibility ---------------------------------------------
//
// Rows created by the Arc-only, single-source implementation stored one burn
// intent in `burn_intent_json`, one typed data object in `typed_data_json`,
// one signature in `signature`, one source in `source_domain`, and no
// destination at all because the destination was always Arc. Those rows must
// stay readable, reconcilable and provable forever, so every reader below goes
// through these adapters instead of touching the columns directly.

function destinationDomainOf(row) {
  return row.destination_domain === null || row.destination_domain === undefined
    ? gatewayService.ARC_GATEWAY_DOMAIN
    : Number(row.destination_domain);
}

function sourcePlanOf(row) {
  if (Array.isArray(row.source_plan_json) && row.source_plan_json.length) {
    return row.source_plan_json.map((entry) => ({
      sourceDomain: Number(entry.sourceDomain),
      valueRaw: String(entry.valueRaw),
    }));
  }
  if (row.source_domain === null || row.source_domain === undefined) return [];
  return [{ sourceDomain: Number(row.source_domain), valueRaw: String(row.value_raw) }];
}

function burnIntentsOf(row) {
  if (Array.isArray(row.burn_intents_json) && row.burn_intents_json.length) {
    return row.burn_intents_json;
  }
  return row.burn_intent_json ? [row.burn_intent_json] : [];
}

function typedDataListOf(row) {
  if (Array.isArray(row.typed_data_list_json) && row.typed_data_list_json.length) {
    return row.typed_data_list_json;
  }
  return row.typed_data_json ? [row.typed_data_json] : [];
}

function signaturesOf(row) {
  const intentCount = burnIntentsOf(row).length;
  if (Array.isArray(row.signatures_json)) {
    const list = row.signatures_json.slice(0, Math.max(intentCount, row.signatures_json.length));
    while (list.length < intentCount) list.push(null);
    return list;
  }
  const list = new Array(intentCount).fill(null);
  if (typeof row.signature === 'string' && intentCount) list[0] = row.signature;
  return list;
}

function challengeIdsOf(row) {
  const intentCount = burnIntentsOf(row).length;
  if (Array.isArray(row.circle_sign_challenges_json)) {
    const list = row.circle_sign_challenges_json.slice();
    while (list.length < intentCount) list.push(null);
    return list;
  }
  const list = new Array(intentCount).fill(null);
  if (row.circle_sign_challenge_id && intentCount) list[0] = row.circle_sign_challenge_id;
  return list;
}

/** The first allocation still waiting for a signature, or -1 when complete. */
function nextUnsignedIndex(row) {
  const signatures = signaturesOf(row);
  if (!signatures.length) return -1;
  const index = signatures.findIndex((value) => typeof value !== 'string');
  return index;
}

function publicAction(row, options = {}) {
  const destinationDomain = destinationDomainOf(row);
  const destination = gatewayNetworks.networkForDomain(destinationDomain);
  const typedDataList = typedDataListOf(row);
  const signatureIndex = nextUnsignedIndex(row);
  const challengeIds = challengeIdsOf(row);
  return {
    actionId: row.id,
    requestId: row.request_id,
    executionMode: row.execution_mode,
    destinationDomain,
    destinationLabel: destination ? destination.label : null,
    valueRaw: row.value_raw,
    // The resolved source plan is reported for transparency and durable proof,
    // never as an input. A client cannot influence it.
    sourcePlan: sourcePlanOf(row),
    intentCount: typedDataList.length,
    payloadHash: row.payload_hash || null,
    // Which allocation still needs a signature, and the Circle challenge that
    // signs it. -1 means every intent is signed.
    signatureIndex,
    challengeId: signatureIndex >= 0 ? challengeIds[signatureIndex] || null : null,
    // Not secret: these are the exact messages a wallet needs to sign. An
    // external wallet session signs them directly with signTypedData; Circle
    // sessions sign each through its own hosted challenge.
    typedDataList,
    state: row.state,
    recovery: options.recovery || null,
    terminal: TERMINAL_FUNDING_STATES.has(row.state),
    pending: options.pending === true,
    readyToBroadcast: row.state === 'READY_TO_BROADCAST',
    // Submission capability is a server decision. The browser may render
    // this boolean, but it cannot enable or override the submit route.
    submissionEnabled: options.submissionEnabled === true,
    broadcast: row.state === 'COMPLETED'
      ? 'COMPLETED'
      : row.gateway_transfer_id ? 'SUBMITTED' : 'NOT_SUBMITTED',
    transferId: row.gateway_transfer_id || null,
    transactionHash: row.gateway_transaction_hash || null,
    lastError: row.last_error || null,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function createGatewayFundingService({
  database = db,
  gateway = gatewayService,
  circle = circleUserWalletService,
  runtimeConfig = config,
  now = () => Date.now(),
} = {}) {
  function expose(row, options = {}) {
    return publicAction(row, {
      ...options,
      submissionEnabled: runtimeConfig.EXTREMA_ENABLE_GATEWAY_BROADCAST === true,
    });
  }

  async function findByRequest(auth, requestId, executor = database) {
    const result = await executor.query(
      `SELECT * FROM gateway_funding_actions
        WHERE user_id = $1 AND request_id = $2
        LIMIT 1`,
      [auth.userId, requestId],
    );
    return result.rows[0] || null;
  }

  async function findUnresolved(auth, executor = database) {
    const result = await executor.query(
      `SELECT * FROM gateway_funding_actions
        WHERE user_id = $1 AND execution_mode = $2
          AND lower(wallet_address) = lower($3)
          AND state = ANY($4::varchar[])
        ORDER BY created_at ASC, id ASC`,
      [auth.userId, auth.executionMode, auth.walletAddress, ACTIVE_FUNDING_STATES],
    );
    return result.rows;
  }

  async function findById(auth, actionId) {
    const result = await database.query(
      `SELECT * FROM gateway_funding_actions
        WHERE id = $1 AND user_id = $2 AND execution_mode = $3
          AND lower(wallet_address) = lower($4)
        LIMIT 1`,
      [actionId, auth.userId, auth.executionMode, auth.walletAddress],
    );
    const row = result.rows[0] || null;
    if (!row) throw new Error('gateway_funding_not_found');
    return row;
  }

  async function markExpired(row) {
    if (
      !isExpired(row) ||
      !['PREPARING', 'SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING'].includes(row.state)
    ) return row;
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET state = 'EXPIRED', updated_at = NOW()
        WHERE id = $1 AND state <> 'READY_TO_BROADCAST'
        RETURNING *`,
      [row.id],
    );
    return result.rows[0] || row;
  }

  async function createOrGet(auth, input) {
    // The same-wallet guard must cover the read and insert as one critical
    // section. A PostgreSQL transaction-scoped advisory lock closes the race
    // where two fresh request ids arrive at the same time; the in-memory
    // verifier below intentionally uses its injected database without this
    // optional client path.
    const client = typeof database.getClient === 'function'
      ? await database.getClient()
      : null;
    const executor = client || database;
    let inTransaction = false;
    try {
      if (client) {
        await client.query('BEGIN');
        inTransaction = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`gateway-funding:${auth.userId}:${auth.executionMode}:${auth.walletAddress.toLowerCase()}`],
        );
      }

      const unresolved = await findUnresolved(auth, executor);
      if (unresolved.length > 1) throw new Error('gateway_funding_multiple_active');
      if (unresolved.length === 1) {
        const result = {
          row: unresolved[0],
          disposition: unresolved[0].request_id === input.requestId ? 'EXISTING' : 'CONFLICT',
        };
        if (inTransaction) await client.query('COMMIT');
        return result;
      }

      const actionId = crypto.randomUUID();
      const expiresAt = new Date(now() + FUNDING_TTL_MS);
      const isCircle = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET;
      await executor.query(
        `INSERT INTO gateway_funding_actions
          (id, user_id, execution_mode, circle_wallet_id, wallet_address, request_id,
           destination_domain, value_raw, circle_sign_request_id, state, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PREPARING', $10)
         ON CONFLICT (user_id, request_id) DO NOTHING`,
        [
          actionId, auth.userId, auth.executionMode,
          isCircle ? auth.circleWalletId : null, ethers.getAddress(auth.walletAddress),
          input.requestId, input.destinationDomain, input.valueRaw,
          isCircle ? crypto.randomUUID() : null, expiresAt,
        ],
      );
      const result = { row: await findByRequest(auth, input.requestId, executor), disposition: 'NEW' };
      if (inTransaction) await client.query('COMMIT');
      return result;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Resolves the source plan, prices it, and builds one burn intent per
   * allocation.
   *
   * The plan is derived from the wallet's own latest Gateway balances and is
   * persisted in full, together with a payload hash that binds every source
   * allocation AND the destination, before any signature is requested. A
   * signature can therefore only ever apply to a plan that is already durable.
   */
  function feeScore(estimate) {
    const total = estimate?.fees?.total;
    if (typeof total === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(total)) {
      try { return ethers.parseUnits(total, 6); } catch { /* use maxFee sum */ }
    }
    return estimate.intents.reduce((sum, intent) => sum + BigInt(intent.maxFeeRaw), 0n);
  }

  function deterministicSalt({ requestId, sourceDomain, destinationDomain, valueRaw, index }) {
    return `0x${hashPayload({ requestId, sourceDomain, destinationDomain, valueRaw, index })}`;
  }

  async function prepareIntents(auth, row) {
    const destinationDomain = destinationDomainOf(row);
    const balance = await gateway.readUnifiedUsdcBalance(auth.walletAddress);
    const sources = (Array.isArray(balance.balances) ? balance.balances : [])
      .filter((item) => (
      item && item.transferable === true &&
        gatewayService.TRANSFER_SOURCE_USDC_BY_DOMAIN.has(item.domain) &&
        typeof item.balanceRaw === 'string' && /^\d+$/.test(item.balanceRaw) &&
        BigInt(item.balanceRaw) > 0n
      ))
      .map((item) => ({ ...item, balanceRaw: String(item.balanceRaw) }));
    const requested = BigInt(row.value_raw);
    const grossAvailable = sources.reduce((sum, item) => sum + BigInt(item.balanceRaw), 0n);
    if (grossAvailable < requested) throw new Error('gateway_insufficient_usdc');

    const enumerate = gateway.enumerateSourceAllocationPlans
      || gatewayService.enumerateSourceAllocationPlans;
    const estimates = [];

    async function pricePlan(plan) {
      const specs = plan.allocations.map((allocation, index) => gateway.buildGatewayTransferSpec({
        walletAddress: auth.walletAddress,
        sourceDomain: allocation.sourceDomain,
        destinationDomain,
        valueRaw: allocation.valueRaw,
        salt: deterministicSalt({
          requestId: row.request_id,
          sourceDomain: allocation.sourceDomain,
          destinationDomain,
          valueRaw: allocation.valueRaw,
          index,
        }),
      }));
      const estimate = await gateway.estimateGatewayTransfer(specs);
      if (
        !estimate || !Array.isArray(estimate.intents) || estimate.intents.length !== specs.length ||
        estimate.intents.some((intent) => (
          !intent || typeof intent.maxFeeRaw !== 'string' || !/^\d+$/.test(intent.maxFeeRaw) ||
          typeof intent.maxBlockHeight !== 'string' || !/^\d+$/.test(intent.maxBlockHeight)
        ))
      ) {
        throw new Error('gateway_response_invalid');
      }
      return { plan, specs, estimate };
    }

    // Price every one-source option first. A safe one-source plan wins before
    // any multi-source subset is considered, preserving minimum source count.
    for (const source of sources) {
      const oneSourcePlan = {
        totalValueRaw: row.value_raw,
        allocations: [{ sourceDomain: source.domain, valueRaw: row.value_raw }],
      };
      const priced = await pricePlan(oneSourcePlan);
      const feeRaw = BigInt(priced.estimate.intents[0].maxFeeRaw);
      estimates.push({ ...priced, source, feeRaw });
    }

    const validOneSource = estimates
      .filter((candidate) => BigInt(candidate.source.balanceRaw) >= requested + candidate.feeRaw)
      .sort((left, right) => (
        left.feeRaw < right.feeRaw ? -1 : left.feeRaw > right.feeRaw ? 1
          : left.source.domain - right.source.domain
      ));
    let selected = validOneSource[0] || null;

    if (!selected) {
      const sourceByDomain = new Map(sources.map((source) => [source.domain, BigInt(source.balanceRaw)]));
      const maxCandidateSources = Math.min(
        gatewayService.MAX_BURN_INTENTS,
        sources.length,
      );

      function allocationKey(plan) {
        return plan.allocations
          .map((allocation) => `${allocation.sourceDomain}:${allocation.valueRaw}`)
          .join('|');
      }

      function reallocateWithinSubset(plan, estimate) {
        const capacities = plan.allocations.map((allocation, index) => {
          const available = sourceByDomain.get(allocation.sourceDomain);
          const fee = BigInt(estimate.intents[index].maxFeeRaw);
          return available === undefined ? null : available - fee;
        });
        if (capacities.some((capacity) => capacity === null || capacity <= 0n)) return null;
        const totalCapacity = capacities.reduce((total, capacity) => total + capacity, 0n);
        if (totalCapacity < requested || requested < BigInt(plan.allocations.length)) return null;

        // Preserve the enumerator's total deterministic source order. Reserve
        // one raw unit for every included source, then fill each source up to
        // its own fee-adjusted capacity. No source can pay another source's
        // fee reserve, and no zero-value intent can be produced.
        let remaining = requested - BigInt(plan.allocations.length);
        const allocations = plan.allocations.map((allocation, index) => {
          const minimum = 1n;
          const extra = remaining > capacities[index] - minimum
            ? capacities[index] - minimum
            : remaining;
          remaining -= extra;
          return {
            sourceDomain: allocation.sourceDomain,
            valueRaw: (minimum + extra).toString(),
          };
        });
        return remaining === 0n
          ? { totalValueRaw: requested.toString(), allocations }
          : null;
      }

      function isFeeSafe(plan, estimate) {
        return estimate.intents.every((intent, index) => {
          const available = sourceByDomain.get(plan.allocations[index].sourceDomain);
          return available !== undefined &&
            available >= BigInt(plan.allocations[index].valueRaw) + BigInt(intent.maxFeeRaw);
        });
      }

      // The canonical transfer-source set has five domains. There are 26
      // multi-source subsets; each gets at most six exact quote/reallocation
      // iterations, and a smaller source count always wins before larger ones.
      for (let sourceCount = 2; sourceCount <= maxCandidateSources && !selected; sourceCount += 1) {
        const candidates = enumerate({
          balances: sources,
          valueRaw: row.value_raw,
          maxSources: gatewayService.MAX_BURN_INTENTS,
          sourceCount,
        });
        const plans = Array.isArray(candidates) ? candidates : [];
        const pricedCandidates = [];
        for (const initialPlan of plans) {
          let plan = initialPlan;
          const seen = new Set();
          for (let iteration = 0; iteration < FEE_AWARE_MAX_ITERATIONS; iteration += 1) {
            const key = allocationKey(plan);
            if (seen.has(key)) break;
            seen.add(key);

            const priced = await pricePlan(plan);
            const reallocated = reallocateWithinSubset(plan, priced.estimate);
            if (!reallocated) break;
            const nextKey = allocationKey(reallocated);
            if (nextKey === key) {
              if (isFeeSafe(plan, priced.estimate)) pricedCandidates.push(priced);
              break;
            }
            if (seen.has(nextKey)) break;
            plan = reallocated;
          }
        }
        pricedCandidates.sort((left, right) => {
          const leftFee = feeScore(left.estimate);
          const rightFee = feeScore(right.estimate);
          if (leftFee !== rightFee) return leftFee < rightFee ? -1 : 1;
          return JSON.stringify(left.plan.allocations).localeCompare(JSON.stringify(right.plan.allocations));
        });
        selected = pricedCandidates[0] || null;
      }
    }

    if (!selected) throw new Error('gateway_insufficient_after_fees');

    const plan = selected.plan;
    const specs = selected.specs;
    const estimate = selected.estimate;

    const built = specs.map((spec, index) => gateway.buildGatewayBurnIntent({
      walletAddress: auth.walletAddress,
      sourceDomain: spec.sourceDomain,
      destinationDomain,
      valueRaw: spec.value,
      maxFeeRaw: estimate.intents[index].maxFeeRaw,
      maxBlockHeight: estimate.intents[index].maxBlockHeight,
      salt: spec.salt,
    }));

    const burnIntents = built.map((entry) => entry.burnIntent);
    const typedDataList = built.map((entry) => entry.typedData);
    // The hash covers the complete plan and the destination, not one intent,
    // so a swapped, dropped or reordered allocation cannot pass verification.
    const payloadHash = hashPayload({
      destinationDomain,
      valueRaw: row.value_raw,
      allocations: plan.allocations,
      burnIntents,
    });

    // Circle signs through a hosted challenge, so preparation pauses at
    // SIGN_CHALLENGE_CREATING for that mode. An external wallet signs the
    // already-returned typed data directly with no server-side challenge, so
    // it goes straight to SIGNATURE_PENDING.
    const nextState = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET
      ? 'SIGN_CHALLENGE_CREATING'
      : 'SIGNATURE_PENDING';
    // Single-allocation plans keep the historical singular columns populated
    // as well, so a row written today is still readable by the same proof
    // queries that read the live Base action.
    const single = burnIntents.length === 1;
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET payload_hash = $2,
              source_plan_json = $3,
              burn_intents_json = $4,
              burn_intents_json_text = $5,
              typed_data_list_json = $6,
              signatures_json = $7,
              circle_sign_challenges_json = $8,
              source_domain = $9,
              burn_intent_json = $10,
              burn_intent_json_text = $11,
              typed_data_json = $12,
              max_fee_raw = $13,
              max_block_height = $14,
              estimate_fees_json = $15,
              state = $16, last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'PREPARING'
        RETURNING *`,
      [
        row.id, payloadHash,
        JSON.stringify(plan.allocations),
        JSON.stringify(burnIntents),
        canonicalJson(burnIntents),
        JSON.stringify(typedDataList),
        JSON.stringify(new Array(burnIntents.length).fill(null)),
        JSON.stringify(new Array(burnIntents.length).fill(null)),
        single ? plan.allocations[0].sourceDomain : null,
        single ? JSON.stringify(burnIntents[0]) : null,
        single ? JSON.stringify(burnIntents[0]) : null,
        single ? JSON.stringify(typedDataList[0]) : null,
        estimate.intents[0].maxFeeRaw, estimate.intents[0].maxBlockHeight,
        estimate.fees === null ? null : JSON.stringify(estimate.fees),
        nextState,
      ],
    );
    return result.rows[0] || findById(auth, row.id);
  }

  /**
   * Creates the Circle typed-data challenge for ONE allocation: the first one
   * still unsigned. A multi-source plan is signed allocation by allocation,
   * and a challenge already recorded for an index is never created twice.
   */
  async function createSignatureChallenge(auth, row, userToken) {
    if (!['SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING'].includes(row.state)) return row;
    const index = nextUnsignedIndex(row);
    if (index < 0) return row;
    const challengeIds = challengeIdsOf(row);
    if (challengeIds[index]) return row;

    const typedData = typedDataListOf(row)[index];
    if (!typedData) throw new Error('gateway_funding_payload_mismatch');
    const plan = sourcePlanOf(row);
    const destination = gatewayNetworks.networkForDomain(destinationDomainOf(row));

    // Never retry an ambiguous Circle mutation automatically. A response loss
    // leaves this durable state visible for manual support/reconciliation, and
    // no Gateway transfer can have occurred because no signature was submitted.
    let created;
    try {
      created = await circle.createTypedDataChallenge({
        userToken,
        walletId: auth.circleWalletId,
        typedData,
        // One idempotency key per allocation, derived from the row's durable
        // sign request id, so a repeated attempt at the same allocation can
        // never create a second challenge.
        idempotencyKey: index === 0
          ? row.circle_sign_request_id
          : derivedIdempotencyKey(`${row.circle_sign_request_id}:${index}`),
        memo: `Authorize ${plan.length > 1 ? `part ${index + 1} of ${plan.length} of ` : ''}`
          + `a USDC transfer to ${destination ? destination.label : 'the selected network'}. `
          + 'No transfer is submitted yet.',
      });
    } catch (error) {
      await database.query(
        `UPDATE gateway_funding_actions
            SET last_error = $2, updated_at = NOW()
          WHERE id = $1 AND state IN ('SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING')`,
        [row.id, error?.message?.startsWith('circle_') ? error.message : 'circle_service_unavailable'],
      );
      throw error;
    }

    const nextChallengeIds = challengeIdsOf(row).slice();
    nextChallengeIds[index] = created.challengeId;
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET circle_sign_challenges_json = $2,
              circle_sign_challenge_id = COALESCE(circle_sign_challenge_id, $3),
              state = 'SIGNATURE_PENDING',
              last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state IN ('SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING')
        RETURNING *`,
      [row.id, JSON.stringify(nextChallengeIds), index === 0 ? created.challengeId : null],
    );
    return result.rows[0] || findById(auth, row.id);
  }

  /**
   * Re-derives every safety property of a prepared row before it may be
   * submitted: the intents must match the persisted plan one for one, carry
   * the row's own destination, be payable to the session wallet only, hash to
   * the recorded payload hash, and be fully signed.
   */
  function assertPreparedPayload(auth, row) {
    const intents = burnIntentsOf(row);
    const plan = sourcePlanOf(row);
    const destinationDomain = destinationDomainOf(row);
    const signatures = signaturesOf(row);
    const expectedDepositor = ethers
      .zeroPadValue(ethers.getAddress(auth.walletAddress), 32)
      .toLowerCase();

    if (!intents.length || intents.length !== plan.length) {
      throw new Error('gateway_funding_payload_mismatch');
    }
    let total = 0n;
    intents.forEach((intent, index) => {
      const spec = intent?.spec;
      const allocation = plan[index];
      if (
        !spec ||
        Number(spec.sourceDomain) !== allocation.sourceDomain ||
        String(spec.value) !== String(allocation.valueRaw) ||
        Number(spec.destinationDomain) !== destinationDomain ||
        typeof spec.sourceDepositor !== 'string' ||
        spec.sourceDepositor.toLowerCase() !== expectedDepositor ||
        typeof spec.destinationRecipient !== 'string' ||
        spec.destinationRecipient.toLowerCase() !== expectedDepositor ||
        typeof spec.sourceSigner !== 'string' ||
        spec.sourceSigner.toLowerCase() !== expectedDepositor
      ) {
        throw new Error('gateway_funding_payload_mismatch');
      }
      total += BigInt(allocation.valueRaw);
    });
    if (total !== BigInt(row.value_raw)) {
      throw new Error('gateway_funding_payload_mismatch');
    }

    const recomputed = hashPayload({
      destinationDomain,
      valueRaw: row.value_raw,
      allocations: plan,
      burnIntents: intents,
    });
    // A row written by the single-source implementation hashed only its one
    // burn intent. Accept either binding so historical proof still verifies,
    // and require the plan-wide binding for anything multi-source.
    const legacy = intents.length === 1 &&
      hashPayload(row.burn_intent_json_text || intents[0]) === row.payload_hash;
    if (typeof row.payload_hash !== 'string' || (recomputed !== row.payload_hash && !legacy)) {
      throw new Error('gateway_funding_payload_mismatch');
    }
    if (signatures.some((value) => typeof value !== 'string')) {
      throw new Error('gateway_signature_required');
    }
  }

  async function updateState(row, state, extras = {}) {
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET state = $2, gateway_transfer_id = COALESCE($3, gateway_transfer_id),
              gateway_transaction_hash = COALESCE($4, gateway_transaction_hash),
              last_error = $5, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, state, extras.transferId || null, extras.transactionHash || null, extras.lastError || null],
    );
    return result.rows[0] || findById({
      userId: row.user_id,
      circleWalletId: row.circle_wallet_id,
      walletAddress: row.wallet_address,
      executionMode: row.execution_mode,
    }, row.id);
  }

  function isRemoteComplete(status) {
    return ['complete', 'completed', 'confirmed', 'finalized', 'success', 'succeeded', 'forwarded'].includes(status);
  }

  function isRemoteFailed(status) {
    return ['failed', 'failure', 'reverted', 'rejected', 'expired'].includes(status);
  }

  async function reconcileRemote(auth, row) {
    if (!row.gateway_transfer_id) {
      if (row.state === 'SUBMITTING') {
        return updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_submit_interrupted' });
      }
      return row;
    }
    let remote;
    try {
      remote = await gateway.readGatewayTransferStatus(row.gateway_transfer_id);
    } catch (error) {
      if (error?.message === 'gateway_transfer_not_found') {
        return updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_transfer_not_found' });
      }
      return updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_status_unknown' });
    }
    if (isRemoteComplete(remote.status)) {
      return updateState(row, 'COMPLETED', { transactionHash: remote.transactionHash });
    }
    if (isRemoteFailed(remote.status)) {
      return updateState(row, 'FAILED', { lastError: remote.forwardingFailure || 'gateway_transfer_failed' });
    }
    return updateState(row, 'SUBMITTED');
  }

  async function submit({ auth, actionId }) {
    assertHumanGatewaySession(auth);
    if (!runtimeConfig.EXTREMA_ENABLE_GATEWAY_BROADCAST) {
      throw new Error('gateway_broadcast_disabled');
    }
    let row = await markExpired(await findById(auth, actionId));
    if (['SUBMITTED', 'COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(row.state)) {
      return expose(row, { pending: row.state === 'SUBMITTED' || row.state === 'RECONCILIATION_REQUIRED' });
    }
    if (row.state !== 'READY_TO_BROADCAST') {
      throw new Error('gateway_funding_not_ready');
    }
    assertPreparedPayload(auth, row);

    // The CAS is the financial idempotency gate. Once SUBMITTING is durable,
    // every retry returns the row for reconciliation and can never POST again.
    const reserved = await database.query(
      `UPDATE gateway_funding_actions
          SET state = 'SUBMITTING', last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'READY_TO_BROADCAST'
        RETURNING *`,
      [row.id],
    );
    if (!reserved.rows[0]) {
      row = await findById(auth, actionId);
      return expose(row, { pending: true });
    }
    row = reserved.rows[0];

    try {
      // Exactly the persisted intents and exactly the persisted signatures.
      const intents = burnIntentsOf(row);
      const signatures = signaturesOf(row);
      const submitted = await gateway.submitGatewayTransfer({
        requests: intents.map((burnIntent, index) => ({
          burnIntent,
          signature: signatures[index],
        })),
        requestId: row.request_id,
      });
      row = await updateState(row, 'SUBMITTED', { transferId: submitted.transferId });
      return expose(row, { pending: true });
    } catch (error) {
      if (error?.message === 'gateway_transfer_rejected') {
        row = await updateState(row, 'FAILED', { lastError: 'gateway_transfer_rejected' });
        return expose(row);
      }
      row = await updateState(row, 'RECONCILIATION_REQUIRED', { lastError: 'gateway_transfer_submit_unknown' });
      return expose(row, { pending: true });
    }
  }

  async function discard({ auth, actionId }) {
    assertHumanGatewaySession(auth);
    const row = await findById(auth, actionId);
    if (
      !PRE_SUBMISSION_DISCARD_STATES.includes(row.state) ||
      row.gateway_transfer_id !== null || row.gateway_transaction_hash !== null
    ) {
      throw new Error('gateway_funding_discard_not_allowed');
    }
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET state = 'EXPIRED', last_error = 'gateway_funding_cancelled_before_submission', updated_at = NOW()
        WHERE id = $1
          AND state = ANY($2::varchar[])
          AND gateway_transfer_id IS NULL
          AND gateway_transaction_hash IS NULL
        RETURNING *`,
      [actionId, PRE_SUBMISSION_DISCARD_STATES],
    );
    if (!result.rows[0]) throw new Error('gateway_funding_discard_not_allowed');
    return expose(result.rows[0]);
  }

  async function status({ auth, actionId }) {
    assertHumanGatewaySession(auth);
    let row = await markExpired(await findById(auth, actionId));
    if (['SUBMITTED', 'SUBMITTING', 'RECONCILIATION_REQUIRED'].includes(row.state)) {
      row = await reconcileRemote(auth, row);
    }
    return expose(row, {
      pending: ['SUBMITTED', 'SUBMITTING', 'RECONCILIATION_REQUIRED'].includes(row.state),
    });
  }

  async function current({ auth }) {
    assertHumanGatewaySession(auth);
    const active = [];
    for (const candidate of await findUnresolved(auth)) {
      const row = await markExpired(candidate);
      if (ACTIVE_FUNDING_STATES.includes(row.state)) active.push(row);
    }
    if (active.length > 1) {
      return {
        status: 'DUPLICATE',
        action: null,
        actions: active.map((row) => expose(row)),
      };
    }
    if (active.length === 1) {
      const action = expose(active[0]);
      return { status: 'ACTIVE', action, actions: [action] };
    }
    return { status: 'NONE', action: null, actions: [] };
  }

  async function start({ auth, userToken = null, requestId, destinationDomain, valueRaw }) {
    assertHumanGatewaySession(auth);
    assertInput({ requestId, destinationDomain, valueRaw });
    const isCircle = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET;
    if (isCircle && (typeof userToken !== 'string' || userToken.length < 16)) {
      throw new Error('circle_request_invalid');
    }

    const created = await createOrGet(auth, { requestId, destinationDomain, valueRaw });
    let row = created.row;
    if (!row) throw new Error('gateway_funding_not_found');
    // A replayed request id must describe the same financial intent, or it is
    // a different operation wearing the same name. A fresh request id that
    // collides with another unresolved action is handled by the same-wallet
    // conflict below; its destination and amount must not bypass that guard.
    if (created.disposition !== 'CONFLICT' &&
      (destinationDomainOf(row) !== destinationDomain || row.value_raw !== valueRaw)) {
      throw new Error('gateway_request_id_conflict');
    }
    if (created.disposition === 'CONFLICT') {
      return expose(row, {
        pending: ['SIGNATURE_PENDING', 'SUBMITTING', 'SUBMITTED', 'RECONCILIATION_REQUIRED']
          .includes(row.state),
        recovery: 'CONFLICT',
      });
    }
    row = await markExpired(row);
    if (row.state === 'EXPIRED') throw new Error('gateway_funding_expired');
    if (row.state === 'PREPARING') row = await prepareIntents(auth, row);
    if (isCircle) {
      if (row.state === 'SIGN_CHALLENGE_CREATING' && row.last_error) {
        throw new Error('gateway_signature_challenge_uncertain');
      }
      if (['SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING'].includes(row.state)) {
        row = await createSignatureChallenge(auth, row, userToken);
      }
    }
    return expose(row, {
      pending: row.state === 'SIGNATURE_PENDING',
      recovery: created.disposition,
    });
  }

  async function get({ auth, actionId }) {
    assertHumanGatewaySession(auth);
    const row = await markExpired(await findById(auth, actionId));
    return expose(row, { pending: row.state === 'SIGNATURE_PENDING' });
  }

  /**
   * Persists one verified signature for one allocation.
   *
   * The canonical tail for both modes: recover the EIP-712 signer locally from
   * the server-pinned typed data, require it to equal the authenticated
   * session wallet, and only then store it. Neither branch ever trusts a
   * browser-provided intent, source or destination, and a signature that
   * recovers to anyone else is refused before it can be submitted.
   */
  async function storeSignature(auth, row, index, signature) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new Error('gateway_signature_required');
    }
    const typedData = typedDataListOf(row)[index];
    if (!typedData) throw new Error('gateway_funding_payload_mismatch');
    const signer = gateway.recoverBurnIntentSigner(typedData, signature);
    if (ethers.getAddress(signer).toLowerCase() !== ethers.getAddress(auth.walletAddress).toLowerCase()) {
      throw new Error('gateway_signature_wallet_mismatch');
    }

    const signatures = signaturesOf(row).slice();
    signatures[index] = signature;
    const complete = signatures.every((value) => typeof value === 'string');
    const result = await database.query(
      `UPDATE gateway_funding_actions
          SET signatures_json = $2,
              signature = COALESCE(signature, $3),
              state = $4, last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'SIGNATURE_PENDING'
        RETURNING *`,
      [
        row.id, JSON.stringify(signatures),
        index === 0 ? signature : null,
        complete ? 'READY_TO_BROADCAST' : 'SIGNATURE_PENDING',
      ],
    );
    return result.rows[0] || findById(auth, row.id);
  }

  async function verifySignature({
    auth, actionId, userToken = null, signature = null, signatures = null,
  }) {
    assertHumanGatewaySession(auth);
    let row = await markExpired(await findById(auth, actionId));
    if (TERMINAL_FUNDING_STATES.has(row.state)) return expose(row);
    if (row.state === 'READY_TO_BROADCAST') return expose(row);
    if (row.state !== 'SIGNATURE_PENDING') {
      throw new Error('gateway_signature_challenge_unavailable');
    }

    const isCircle = auth.executionMode === EXECUTION_MODES.CIRCLE_USER_WALLET;
    if (isCircle && (typeof userToken !== 'string' || userToken.length < 16)) {
      throw new Error('circle_request_invalid');
    }

    // An external wallet may hand back only the still-unsigned tail, since it
    // signs locally with no per-allocation hosted interaction. Circle mode
    // advances one challenge at a time. The batch is intentionally compact:
    // its first item always belongs to the server's current nextUnsignedIndex.
    const batch = !isCircle && Array.isArray(signatures) ? signatures : null;
    if (batch) {
      if (!batch.length || batch.some((value) => (
        typeof value !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value)
      ))) {
        throw new Error('gateway_signature_required');
      }
      const remaining = signaturesOf(row).filter((value) => typeof value !== 'string').length;
      if (batch.length > remaining) throw new Error('gateway_signature_batch_mismatch');
    }
    let batchCursor = 0;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > gatewayService.MAX_BURN_INTENTS + 1) break;
      const index = nextUnsignedIndex(row);
      if (index < 0) break;

      if (isCircle) {
        const challengeId = challengeIdsOf(row)[index];
        if (!challengeId) throw new Error('gateway_signature_challenge_unavailable');
        const challenge = await circle.getTypedDataChallenge({ userToken, challengeId });
        if (!challenge || challenge.status === 'PENDING' || challenge.status === 'IN_PROGRESS') {
          return expose(row, { pending: true });
        }
        if (challenge.status !== 'COMPLETE') {
          const failure = challenge.errorCode === 156026
            ? 'gateway_signature_typed_data_invalid'
            : 'gateway_signature_challenge_failed';
          const failedResult = await database.query(
            `UPDATE gateway_funding_actions
                SET state = 'SIGNATURE_FAILED', last_error = $2, updated_at = NOW()
              WHERE id = $1
              RETURNING *`,
            [row.id, failure],
          );
          row = failedResult.rows[0] || await findById(auth, row.id);
          return expose(row);
        }
      }

      const value = batch ? batch[batchCursor] : signature;
      if (typeof value !== 'string') {
        // A batch that runs out simply leaves the rest of the plan unsigned.
        // Every signature already accepted stays durable, and the response
        // says which allocation is still outstanding.
        if (batch) break;
        throw new Error('gateway_signature_required');
      }
      row = await storeSignature(auth, row, index, value);
      if (batch) batchCursor += 1;

      if (row.state === 'READY_TO_BROADCAST') return expose(row);
      if (!batch && !isCircle) {
        // One signature per call for a single-signature external submission:
        // report the next allocation instead of looping on the same value.
        return expose(row, { pending: true });
      }
      if (isCircle) {
        // Issue the next allocation's challenge and hand it back so the
        // browser can run it. No further signature exists yet.
        row = await createSignatureChallenge(auth, row, userToken);
        return expose(row, { pending: true });
      }
    }

    return expose(row, { pending: row.state === 'SIGNATURE_PENDING' });
  }

  return { start, get, verifySignature, submit, discard, status, current };
}

const gatewayFundingService = createGatewayFundingService();

module.exports = {
  FUNDING_TTL_MS,
  canonicalJson,
  hashPayload,
  ACTIVE_FUNDING_STATES,
  PRE_SUBMISSION_DISCARD_STATES,
  FEE_AWARE_MAX_ITERATIONS,
  FEE_AWARE_MAX_ESTIMATE_CALLS,
  createGatewayFundingService,
  ...gatewayFundingService,
};
