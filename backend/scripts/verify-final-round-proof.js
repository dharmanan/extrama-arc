'use strict';

const assert = require('node:assert/strict');

const BACKEND_URL =
  process.env.EXTREMA_PUBLIC_BACKEND_URL ||
  'https://extrama-arc-production.up.railway.app';

const POOL =
  '0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f';
const TICKET =
  '0xF65Cf4a67299ad596e139e3F6a9594E809F05637';

const EXPECTED_SETTLEMENT_TX =
  '0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9';
const EXPECTED_CLAIM_TX =
  '0xc7913e802e228549cfb564e60eba6f6f57afbbc1e8e4e8fe33ee0f11e59cf2ff';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(path) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      20_000,
    );
    timer.unref?.();

    try {
      const response = await fetch(
        `${BACKEND_URL}${path}`,
        {
          signal: controller.signal,
          headers: {
            accept: 'application/json',
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `HTTP_${response.status}_${path}`,
        );
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (attempt === 4) {
        throw error;
      }

      await sleep(
        500 * (2 ** attempt),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

function winnerByTicket(result, tokenId) {
  return (result.winners || []).find(
    item => String(item.tokenId) === String(tokenId),
  );
}

async function main() {
  const [result, verification] =
    await Promise.all([
      fetchJson(
        '/api/rounds/eth-daily-high/4/result',
      ),
      fetchJson(
        '/api/rounds/eth-daily-high/4/verification',
      ),
    ]);

  assert.equal(
    result?.chain?.id,
    5042002,
    'result chain mismatch',
  );
  assert.equal(
    result?.pool?.poolAddress?.toLowerCase(),
    POOL.toLowerCase(),
    'pool mismatch',
  );
  assert.equal(
    result?.pool?.ticketAddress?.toLowerCase(),
    TICKET.toLowerCase(),
    'ticket contract mismatch',
  );
  assert.equal(
    result?.pool?.asset,
    'ETH',
  );
  assert.equal(
    result?.pool?.direction,
    'HIGH',
  );
  assert.equal(
    result?.pool?.cadence,
    'DAILY',
  );

  assert.equal(
    result?.round?.roundId,
    4,
  );
  assert.equal(
    result?.round?.contractStatus,
    'SETTLED',
  );
  assert.equal(
    result?.round?.entryCount,
    3,
  );
  assert.equal(
    result?.round?.totalStakeRaw,
    '3000000',
  );
  assert.equal(
    result?.round?.totalStakeUsdc,
    '3.0',
  );
  assert.equal(
    result?.round?.resolvedPriceCents,
    '253500',
  );
  assert.deepEqual(
    result?.round?.winnerTicketIds,
    ['4', '3', '2'],
  );

  assert.equal(
    result?.winners?.length,
    3,
  );

  const first = winnerByTicket(
    result,
    4,
  );
  const second = winnerByTicket(
    result,
    3,
  );
  const third = winnerByTicket(
    result,
    2,
  );

  assert.ok(first);
  assert.ok(second);
  assert.ok(third);

  assert.equal(
    first.rank,
    1,
  );
  assert.equal(
    first.predictionPriceCents,
    '250856',
  );
  assert.equal(
    first.distanceCents,
    '2644',
  );

  assert.equal(
    second.rank,
    2,
  );
  assert.equal(
    second.predictionPriceCents,
    '250756',
  );
  assert.equal(
    second.distanceCents,
    '2744',
  );

  assert.equal(
    third.rank,
    3,
  );
  assert.equal(
    third.predictionPriceCents,
    '250656',
  );
  assert.equal(
    third.distanceCents,
    '2844',
  );
  assert.equal(
    third.isClaimed,
    true,
  );
  assert.equal(
    third.claimableRaw,
    '0',
  );

  assert.equal(
    verification?.chain?.id,
    5042002,
  );
  assert.equal(
    verification?.round?.roundId,
    4,
  );
  assert.equal(
    verification?.round?.contractStatus,
    'SETTLED',
  );
  assert.equal(
    verification?.round?.resolvedPriceCents,
    '253500',
  );

  assert.equal(
    verification?.verification?.status,
    'VERIFIED',
  );
  assert.equal(
    String(
      verification?.verification
        ?.settlementTxHash || '',
    ).toLowerCase(),
    EXPECTED_SETTLEMENT_TX,
  );

  const integrity =
    verification?.verification?.integrity;

  assert.equal(
    integrity?.evidenceHashValid,
    true,
  );
  assert.equal(
    integrity?.poolIdentityMatches,
    true,
  );
  assert.equal(
    integrity?.marketPeriodMatches,
    true,
  );
  assert.equal(
    integrity?.resolvedPriceMatchesOnchain,
    true,
  );

  const proof = {
    chainId: 5042002,
    pool: POOL,
    ticketContract: TICKET,
    roundId: 4,
    roundStatus: 'SETTLED',
    entryCount: 3,
    totalStakeUsdc: '3.0',
    resolvedPrice: '2535.00',
    winners: result.winners.map(
      item => ({
        rank: item.rank,
        tokenId: item.tokenId,
        originalEntrant:
          item.originalEntrant,
        currentOwner:
          item.currentOwner,
        predictionPrice:
          item.predictionPrice,
        distance:
          item.distance,
        isClaimed:
          item.isClaimed,
        claimableUsdc:
          item.claimableUsdc,
      }),
    ),
    settlement: {
      txHash:
        EXPECTED_SETTLEMENT_TX,
      verificationStatus:
        verification.verification.status,
      evidenceSha256:
        verification.verification
          .evidenceSha256,
      sourceDataSha256:
        verification.verification
          .sourceDataSha256,
      integrity,
    },
    recordedClaim: {
      ticketId: '2',
      txHash:
        EXPECTED_CLAIM_TX,
      amountUsdc: '0.405',
      currentStateClaimed:
        third.isClaimed,
      currentStateClaimableRaw:
        third.claimableRaw,
    },
  };

  console.log(
    'FINAL_ROUND_PROOF=' +
      JSON.stringify(
        proof,
        null,
        2,
      ),
  );

  console.log(
    'RESULT=FINAL_SINGLE_ROUND_PROOF_COMPLETE',
  );
}

main().catch((error) => {
  console.error(
    'RESULT=FINAL_SINGLE_ROUND_PROOF_FAIL',
  );
  console.error(
    error.stack || error.message,
  );
  process.exitCode = 1;
});
