'use strict';

// Deterministic verification of round result latency work:
//
//   A. readRoundResult reads the settled winner bundles concurrently (bounded,
//      at most three bundles of four view calls) instead of as a sequential
//      waterfall, and returns exactly the same shape and values.
//   B. The 15 second round result cache shares in flight computations,
//      serves hits without recomputing, recomputes after expiry and never
//      caches a failure.
//
// A fake Arc provider answers only view calls. Nothing here opens a database,
// contacts Arc or Binance, holds a key, or can send a transaction.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://verify:verify@127.0.0.1:1/verify';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'verify_only_session_secret_not_for_runtime';

const { ethers } = require('ethers');

function installModule(relativePath, exports) {
  const filename = require.resolve(relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const POOL_IFACE = new ethers.Interface([
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function getTicketMetadata(uint256 ticketId) view returns (tuple(uint256 roundId,uint64 predictionPriceCents,uint64 entrySequence,uint8 roundStatus,uint8 placement,bool isClaimed,bool isRefunded))',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
  'function claimableByTicket(uint256 ticketId) view returns (uint256)',
]);
const TICKET_IFACE = new ethers.Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const WINNER_CALLS = new Set(['entries', 'ownerOf', 'claimableByTicket', 'getTicketMetadata']);

const OWNER_A = ethers.getAddress('0x1000000000000000000000000000000000000001');
const OWNER_B = ethers.getAddress('0x2000000000000000000000000000000000000002');
const ENTRANT_C = ethers.getAddress('0x3000000000000000000000000000000000000003');
const OWNER_D = ethers.getAddress('0x4000000000000000000000000000000000000004');

const ROUND_ID = 7;
const WINNERS = {
  11: { prediction: 6_500_100n, sequence: 3n, owner: OWNER_A, entrant: OWNER_A, claimable: 2_700_000n, placement: 1, claimed: false, delayMs: 60 },
  12: { prediction: 6_499_700n, sequence: 1n, owner: OWNER_B, entrant: ENTRANT_C, claimable: 0n, placement: 2, claimed: true, delayMs: 35 },
  13: { prediction: 6_501_000n, sequence: 4n, owner: OWNER_D, entrant: OWNER_D, claimable: 675_000n, placement: 3, claimed: false, delayMs: 10 },
};

const chain = {
  status: 2,
  winnerTicketIds: [11n, 12n, 13n],
  metadataRoundOverride: null,
  latencyMs: null,
  inFlight: 0,
  maxWinnerInFlight: 0,
  winnerInFlight: 0,
  calls: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const provider = {
  async getNetwork() {
    if (chain.latencyMs) await sleep(chain.latencyMs);
    return { chainId: 5042002n };
  },
  async call(tx) {
    const iface = TICKET_IFACE.getFunction(tx.data.slice(0, 10)) ? TICKET_IFACE : POOL_IFACE;
    const parsed = iface.parseTransaction({ data: tx.data });
    chain.calls.push(parsed.name);
    const isWinnerCall = WINNER_CALLS.has(parsed.name);
    if (isWinnerCall) {
      chain.winnerInFlight += 1;
      chain.maxWinnerInFlight = Math.max(chain.maxWinnerInFlight, chain.winnerInFlight);
    }
    try {
      if (parsed.name === 'getRound') {
        if (chain.latencyMs) await sleep(chain.latencyMs);
        return POOL_IFACE.encodeFunctionResult('getRound', [[
          1000n, 2000n, 2000n, 3000n, chain.status, 5n, 6n, 5_000_000n, 1_000_000n, 6_500_000n, chain.winnerTicketIds,
        ]]);
      }
      const tokenId = Number(parsed.args[0]);
      const winner = WINNERS[tokenId];
      await sleep(chain.latencyMs ?? winner.delayMs);
      if (parsed.name === 'entries') {
        return POOL_IFACE.encodeFunctionResult('entries', [
          BigInt(tokenId), BigInt(ROUND_ID), winner.entrant, winner.prediction, winner.sequence,
        ]);
      }
      if (parsed.name === 'ownerOf') return TICKET_IFACE.encodeFunctionResult('ownerOf', [winner.owner]);
      if (parsed.name === 'claimableByTicket') return POOL_IFACE.encodeFunctionResult('claimableByTicket', [winner.claimable]);
      if (parsed.name === 'getTicketMetadata') {
        const roundId = chain.metadataRoundOverride?.[tokenId] ?? ROUND_ID;
        return POOL_IFACE.encodeFunctionResult('getTicketMetadata', [[
          BigInt(roundId), winner.prediction, winner.sequence, 2, winner.placement, winner.claimed, false,
        ]]);
      }
      throw new Error(`unexpected_call:${parsed.name}`);
    } finally {
      if (isWinnerCall) chain.winnerInFlight -= 1;
    }
  },
};

installModule('../src/services/arcRpcProviderService', {
  ARC_CHAIN_ID: 5042002n,
  getArcReadProvider: () => provider,
  getArcWriteProvider: () => {
    throw new Error('write_provider_must_not_be_used');
  },
  getArcRpcConfiguration: () => ({}),
});
installModule('../src/services/marketOutcomeService', {
  async getMarketOutcome() {
    throw new Error('non_canonical_fixture_must_not_read_market_outcome');
  },
});
installModule('../src/services/settlementEvidenceService', {
  async getSettlementEvidence() {
    throw new Error('result_read_must_not_read_settlement_evidence');
  },
});
installModule('../src/services/binanceResolverService', {
  async getLiveMarkPrices() {
    throw new Error('result_read_must_not_read_binance');
  },
});

const arcService = require('../src/services/arcService');
const {
  ROUND_RESULT_CACHE_TTL_MS,
  createPromiseTtlCache,
  createRoundResultCache,
} = require('../src/services/roundResultCache');

const SLUG = 'btc-daily-high';
const topology = arcService.ARC_POOL_TOPOLOGY.find((item) => item.asset === 'BTC' && item.direction === 'HIGH' && item.cadence === 'DAILY');

function expectedWinner(tokenId, rank) {
  const winner = WINNERS[tokenId];
  const distance = winner.prediction >= 6_500_000n ? winner.prediction - 6_500_000n : 6_500_000n - winner.prediction;
  return {
    rank,
    tokenId: String(tokenId),
    currentOwner: winner.owner,
    originalEntrant: winner.entrant,
    predictionPriceCents: winner.prediction.toString(),
    predictionPrice: (Number(winner.prediction) / 100).toFixed(2),
    distanceCents: distance.toString(),
    distance: (Number(distance) / 100).toFixed(2),
    entrySequence: Number(winner.sequence),
    placement: winner.placement,
    isClaimed: winner.claimed,
    claimableRaw: winner.claimable.toString(),
    claimableUsdc: ethers.formatUnits(winner.claimable, 6),
  };
}

function resetChain(overrides = {}) {
  Object.assign(chain, {
    status: 2,
    winnerTicketIds: [11n, 12n, 13n],
    metadataRoundOverride: null,
    latencyMs: null,
    maxWinnerInFlight: 0,
    winnerInFlight: 0,
    calls: [],
  }, overrides);
}

async function verifyConcurrentWinnerReads() {
  resetChain();
  const result = await arcService.readRoundResult({ slug: SLUG, roundId: ROUND_ID });

  // Bounded concurrency: all three bundles overlap (a sequential waterfall
  // would never exceed four winner calls in flight) and never more than
  // three bundles of four calls.
  assert.equal(chain.maxWinnerInFlight > 4, true, `winner bundles must overlap, max in flight ${chain.maxWinnerInFlight}`);
  assert.equal(chain.maxWinnerInFlight <= 12, true, 'winner fan out is bounded to 3 bundles x 4 calls');
  assert.equal(chain.calls.filter((name) => WINNER_CALLS.has(name)).length, 12, 'exactly four authoritative reads per winner');

  // Same shape and values; rank order holds although winner 3 answers first.
  assert.deepEqual(result.winners, [expectedWinner(11, 1), expectedWinner(12, 2), expectedWinner(13, 3)]);
  assert.deepEqual(Object.keys(result), ['chain', 'pool', 'round', 'winners']);
  assert.deepEqual(result.chain, { id: 5042002, name: 'Arc Testnet', explorerUrl: 'https://testnet.arcscan.app' });
  assert.deepEqual(result.pool, {
    slug: SLUG,
    poolAddress: ethers.getAddress(topology.poolAddress),
    ticketAddress: ethers.getAddress(topology.ticketAddress),
    asset: 'BTC',
    direction: 'HIGH',
    cadence: 'DAILY',
    source: 'Binance USDⓈ-M Futures Mark Price',
    sourceSymbol: 'BTCUSDT',
  });
  assert.deepEqual(result.round, {
    roundId: ROUND_ID,
    contractStatus: 'SETTLED',
    entryOpenAt: new Date(1000 * 1000).toISOString(),
    entryCloseAt: new Date(2000 * 1000).toISOString(),
    observationStartAt: new Date(2000 * 1000).toISOString(),
    observationEndAt: new Date(3000 * 1000).toISOString(),
    marketPeriodStartAt: null,
    marketPeriodEndAt: null,
    marketResultCents: null,
    marketResult: null,
    marketResultExact: null,
    marketEvidenceSha256: null,
    entryCount: 5,
    totalStakeRaw: '5000000',
    totalStakeUsdc: '5.0',
    escrowRemainingRaw: '1000000',
    escrowRemainingUsdc: '1.0',
    resolvedPriceCents: '6500000',
    resolvedPrice: '65000.00',
    winnerTicketIds: ['11', '12', '13'],
  });

  // An empty winner slot is skipped and later ranks keep their position.
  resetChain({ winnerTicketIds: [11n, 0n, 13n] });
  const withGap = await arcService.readRoundResult({ slug: SLUG, roundId: ROUND_ID });
  assert.deepEqual(withGap.winners, [expectedWinner(11, 1), expectedWinner(13, 3)]);

  // The round ID integrity check still fails the whole result.
  resetChain({ metadataRoundOverride: { 12: 99 } });
  await assert.rejects(
    () => arcService.readRoundResult({ slug: SLUG, roundId: ROUND_ID }),
    /round_result_winner_round_mismatch/,
  );

  // A round that is not settled performs no winner reads at all.
  resetChain({ status: 1 });
  const locked = await arcService.readRoundResult({ slug: SLUG, roundId: ROUND_ID });
  assert.deepEqual(locked.winners, []);
  assert.equal(chain.calls.some((name) => WINNER_CALLS.has(name)), false);

  // Read only: every call is one of the view functions above, and the reader
  // itself contains no signer or transaction path.
  const source = arcService.readRoundResult.toString();
  assert.equal(/sendTransaction|getArcWriteProvider|new ethers\.Wallet|getSigner/.test(source), false);

  // Simulated latency of 100 ms per RPC: network, round, then one overlapped
  // winner wave. A sequential waterfall would need three winner waves.
  resetChain({ latencyMs: 100 });
  const startedAt = Date.now();
  await arcService.readRoundResult({ slug: SLUG, roundId: ROUND_ID });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(elapsedMs < 450, true, `result with 100 ms RPC latency took ${elapsedMs} ms`);
  console.log(`ROUND_RESULT_SIMULATED_100MS_RPC_MS=${elapsedMs}`);
  console.log('ROUND_RESULT_CONCURRENT_WINNERS=PASS');
}

async function verifyResultCache() {
  assert.equal(ROUND_RESULT_CACHE_TTL_MS, 15_000, 'claim state is cached for 15 seconds, never longer');

  let nowMs = 1_000_000;
  let loads = 0;
  let failNext = false;
  let release;
  let gate = null;
  const results = createRoundResultCache({
    now: () => nowMs,
    async readRoundResult({ slug, roundId }) {
      loads += 1;
      if (gate) await gate;
      if (failNext) {
        failNext = false;
        throw new Error('rpc_unavailable');
      }
      return { slug, roundId, load: loads };
    },
  });

  // Concurrent identical requests share one computation.
  gate = new Promise((resolve) => { release = resolve; });
  const concurrent = Promise.all([
    results.read({ slug: SLUG, roundId: 7 }),
    results.read({ slug: SLUG, roundId: 7 }),
    results.read({ slug: SLUG, roundId: 7 }),
  ]);
  release();
  gate = null;
  const [first, second, third] = await concurrent;
  assert.equal(loads, 1, 'identical concurrent requests share one computation');
  assert.equal(first, second);
  assert.equal(second, third);

  // A hit inside the TTL does not compute again.
  nowMs += ROUND_RESULT_CACHE_TTL_MS - 1;
  assert.equal(await results.read({ slug: SLUG, roundId: 7 }), first);
  assert.equal(loads, 1, 'cache hit avoids another computation');

  // A different round is its own key.
  await results.read({ slug: SLUG, roundId: 8 });
  assert.equal(loads, 2);

  // After expiry the next request computes a fresh result.
  nowMs += 1;
  const refreshed = await results.read({ slug: SLUG, roundId: 7 });
  assert.equal(loads, 3, 'expiry allows a refresh');
  assert.notEqual(refreshed, first);

  // A failure is shared by its concurrent callers but never cached.
  nowMs += ROUND_RESULT_CACHE_TTL_MS;
  failNext = true;
  const failed = await Promise.allSettled([
    results.read({ slug: SLUG, roundId: 7 }),
    results.read({ slug: SLUG, roundId: 7 }),
  ]);
  assert.deepEqual(failed.map((outcome) => outcome.status), ['rejected', 'rejected']);
  assert.equal(loads, 4);
  const recovered = await results.read({ slug: SLUG, roundId: 7 });
  assert.equal(loads, 5, 'a failed computation is never cached');
  assert.equal(recovered.load, 5);

  // The generic cache rejects a missing TTL and clears in flight state.
  assert.throws(() => createPromiseTtlCache({ ttlMs: 0 }), /cache_ttl_invalid/);
  const bare = createPromiseTtlCache({ ttlMs: 1000, now: () => 0 });
  await bare.get('key', async () => 'value');
  assert.equal(bare.inFlightCount(), 0);
  assert.equal(bare.size(), 1);

  // The HTTP route reads results only through this cache.
  const routes = fs.readFileSync(path.resolve(__dirname, '../src/routes/rounds.js'), 'utf8');
  const route = routes.slice(routes.indexOf("router.get('/:slug/:roundId/result'"), routes.indexOf("router.get('/:slug/:roundId/entries'"));
  assert.match(route, /await roundResultCache\.read\(\{/);
  assert.equal(route.includes('arcService.readRoundResult('), false, 'the route never bypasses the result cache');
  console.log('ROUND_RESULT_CACHE=PASS');
}

async function main() {
  await verifyConcurrentWinnerReads();
  await verifyResultCache();
  console.log('ROUND_RESULT_PERFORMANCE=PASS');
}

main().catch((error) => {
  console.error('ROUND_RESULT_PERFORMANCE=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
