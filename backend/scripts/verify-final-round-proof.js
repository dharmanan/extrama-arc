'use strict';

const assert = require('node:assert/strict');
const {
  Interface,
  getAddress,
} = require('ethers');

const CHAIN_ID_HEX = '0x4cef52';
const PRIMARY_RPC =
  process.env.ARC_TESTNET_RPC_URL ||
  'https://rpc.testnet.arc.network';
const FALLBACK_RPC =
  process.env.ARC_TESTNET_RPC_FALLBACK_URL ||
  'https://rpc.solidrpc.io/public/evm/5042002';

const BACKEND_URL =
  process.env.EXTREMA_PUBLIC_BACKEND_URL ||
  'https://extrama-arc-production.up.railway.app';

const POOL =
  '0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f';
const TICKET =
  '0xF65Cf4a67299ad596e139e3F6a9594E809F05637';
const USDC =
  '0x3600000000000000000000000000000000000000';
const TREASURY =
  '0x1D00C89Ed4AF7227a858D305183B4037f732b87e';
const RESOLVER =
  '0x1EDC4594195fFb134315c3258DE974563Ed9762A';

const ROUND_ID = 4n;
const EXPECTED_RESOLVED_PRICE = 253500n;
const EXPECTED_WINNERS = [4n, 3n, 2n];
const EXPECTED_PREDICTIONS = new Map([
  [2n, 250656n],
  [3n, 250756n],
  [4n, 250856n],
]);

const EXPECTED_SETTLEMENT_TX =
  '0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9';
const EXPECTED_CLAIM_TX =
  '0xc7913e802e228549cfb564e60eba6f6f57afbbc1e8e4e8fe33ee0f11e59cf2ff';
const EXPECTED_CLAIM_TICKET = 2n;
const EXPECTED_CLAIM_AMOUNT = 405000n;
const EXPECTED_TREASURY_AMOUNT = 300000n;

const poolIface = new Interface([
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
  'function claimed(uint256 ticketId) view returns (bool)',
  'function claimableByTicket(uint256 ticketId) view returns (uint256)',
  'event RoundSettled(uint256 indexed roundId,uint64 resolvedPriceCents,uint256 firstTicketId,uint256 secondTicketId,uint256 thirdTicketId)',
  'event RewardClaimed(uint256 indexed roundId,uint256 indexed ticketId,address indexed owner,uint256 amount)',
  'event TreasuryAllocated(uint256 indexed roundId,address indexed treasury,uint256 amount)',
]);

const ticketIface = new Interface([
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const usdcIface = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

let rpcId = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );
  timer.unref?.();

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(
        `HTTP_${response.status}_${url}`,
      );
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function rpcOne(url, method, params) {
  rpcId += 1;

  const body = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcId,
        method,
        params,
      }),
    },
  );

  if (body.error) {
    const error = new Error(
      `RPC_${method}_${JSON.stringify(body.error)}`,
    );
    error.rpcCode = body.error.code;
    throw error;
  }

  return body.result;
}

function transient(error) {
  const text =
    String(error?.message || error)
      .toLowerCase();

  return (
    error?.status === 429 ||
    error?.rpcCode === -32005 ||
    text.includes('timeout') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('socket') ||
    text.includes('fetch failed')
  );
}

async function rpc(method, params) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const url of [PRIMARY_RPC, FALLBACK_RPC]) {
      try {
        return await rpcOne(
          url,
          method,
          params,
        );
      } catch (error) {
        lastError = error;
        if (!transient(error)) {
          throw error;
        }
      }
    }

    await sleep(
      300 * (2 ** attempt),
    );
  }

  throw lastError;
}

async function ethCall(to, data, block = 'latest') {
  return rpc(
    'eth_call',
    [{ to, data }, block],
  );
}

async function receipt(txHash) {
  const value = await rpc(
    'eth_getTransactionReceipt',
    [txHash],
  );

  assert.ok(
    value,
    `missing receipt ${txHash}`,
  );

  assert.equal(
    value.status,
    '0x1',
    `failed receipt ${txHash}`,
  );

  return value;
}

function parsePoolLog(log) {
  return poolIface.parseLog({
    topics: log.topics,
    data: log.data,
  });
}

function findExactTransfer(
  receiptValue,
  from,
  to,
  amount,
) {
  for (const log of receiptValue.logs || []) {
    if (
      log.address.toLowerCase() !==
      USDC.toLowerCase()
    ) {
      continue;
    }

    try {
      const parsed = usdcIface.parseLog({
        topics: log.topics,
        data: log.data,
      });

      if (
        parsed.name === 'Transfer' &&
        parsed.args.from.toLowerCase() ===
          from.toLowerCase() &&
        parsed.args.to.toLowerCase() ===
          to.toLowerCase() &&
        parsed.args.value === amount
      ) {
        return true;
      }
    } catch {}
  }

  return false;
}

async function main() {
  const chainId = await rpc(
    'eth_chainId',
    [],
  );

  assert.equal(
    chainId,
    CHAIN_ID_HEX,
    'wrong Arc chain',
  );

  const roundRaw = await ethCall(
    POOL,
    poolIface.encodeFunctionData(
      'getRound',
      [ROUND_ID],
    ),
  );

  const [round] =
    poolIface.decodeFunctionResult(
      'getRound',
      roundRaw,
    );

  assert.equal(
    Number(round.status),
    2,
    'round must be SETTLED',
  );
  assert.equal(
    BigInt(round.entryCount),
    3n,
    'round must have exactly 3 entries',
  );
  assert.equal(
    BigInt(round.totalStake),
    3000000n,
    'round stake must be exactly 3 USDC',
  );
  assert.equal(
    BigInt(round.resolvedPriceCents),
    EXPECTED_RESOLVED_PRICE,
    'resolved price mismatch',
  );

  const winners =
    Array.from(
      round.winnerTicketIds,
      value => BigInt(value),
    );

  assert.deepEqual(
    winners,
    EXPECTED_WINNERS,
    'winner ordering mismatch',
  );

  const entries = [];

  for (const ticketId of [2n, 3n, 4n]) {
    const entryRaw =
      await ethCall(
        POOL,
        poolIface.encodeFunctionData(
          'entries',
          [ticketId],
        ),
      );

    const decoded =
      poolIface.decodeFunctionResult(
        'entries',
        entryRaw,
      );

    assert.equal(
      BigInt(decoded.ticketId),
      ticketId,
    );
    assert.equal(
      BigInt(decoded.roundId),
      ROUND_ID,
    );
    assert.equal(
      BigInt(decoded.predictionPriceCents),
      EXPECTED_PREDICTIONS.get(ticketId),
      `prediction mismatch ticket ${ticketId}`,
    );
    assert.notEqual(
      getAddress(decoded.originalEntrant),
      '0x0000000000000000000000000000000000000000',
      `missing original entrant ticket ${ticketId}`,
    );

    entries.push({
      ticketId: ticketId.toString(),
      originalEntrant:
        getAddress(decoded.originalEntrant),
      predictionPriceCents:
        decoded.predictionPriceCents.toString(),
      entrySequence:
        decoded.entrySequence.toString(),
    });
  }

  entries.sort(
    (a, b) =>
      Number(a.entrySequence) -
      Number(b.entrySequence),
  );

  assert.deepEqual(
    entries.map(item => item.ticketId),
    ['2', '3', '4'],
    'entry sequence ordering mismatch',
  );

  const settlementReceipt =
    await receipt(
      EXPECTED_SETTLEMENT_TX,
    );

  assert.equal(
    getAddress(
      settlementReceipt.to,
    ),
    getAddress(POOL),
    'settlement target mismatch',
  );

  const settlementTx =
    await rpc(
      'eth_getTransactionByHash',
      [EXPECTED_SETTLEMENT_TX],
    );

  assert.ok(
    settlementTx,
    'settlement tx missing',
  );

  assert.equal(
    getAddress(settlementTx.from),
    getAddress(RESOLVER),
    'settlement sender mismatch',
  );

  let roundSettled = null;
  let treasuryAllocated = null;

  for (
    const log of settlementReceipt.logs || []
  ) {
    if (
      log.address.toLowerCase() !==
      POOL.toLowerCase()
    ) {
      continue;
    }

    try {
      const parsed = parsePoolLog(log);

      if (
        parsed.name === 'RoundSettled'
      ) {
        roundSettled = parsed;
      }

      if (
        parsed.name ===
        'TreasuryAllocated'
      ) {
        treasuryAllocated = parsed;
      }
    } catch {}
  }

  assert.ok(
    roundSettled,
    'RoundSettled event missing',
  );
  assert.equal(
    roundSettled.args.roundId,
    ROUND_ID,
  );
  assert.equal(
    roundSettled.args.resolvedPriceCents,
    EXPECTED_RESOLVED_PRICE,
  );
  assert.deepEqual(
    [
      roundSettled.args.firstTicketId,
      roundSettled.args.secondTicketId,
      roundSettled.args.thirdTicketId,
    ],
    EXPECTED_WINNERS,
  );

  assert.ok(
    treasuryAllocated,
    'TreasuryAllocated event missing',
  );
  assert.equal(
    getAddress(
      treasuryAllocated.args.treasury,
    ),
    getAddress(TREASURY),
  );
  assert.equal(
    treasuryAllocated.args.amount,
    EXPECTED_TREASURY_AMOUNT,
  );
  assert.equal(
    findExactTransfer(
      settlementReceipt,
      POOL,
      TREASURY,
      EXPECTED_TREASURY_AMOUNT,
    ),
    true,
    'treasury USDC transfer missing',
  );

  const claimReceipt =
    await receipt(
      EXPECTED_CLAIM_TX,
    );

  assert.equal(
    getAddress(
      claimReceipt.to,
    ),
    getAddress(POOL),
    'claim target mismatch',
  );

  let rewardClaimed = null;

  for (
    const log of claimReceipt.logs || []
  ) {
    if (
      log.address.toLowerCase() !==
      POOL.toLowerCase()
    ) {
      continue;
    }

    try {
      const parsed = parsePoolLog(log);

      if (
        parsed.name === 'RewardClaimed'
      ) {
        rewardClaimed = parsed;
      }
    } catch {}
  }

  assert.ok(
    rewardClaimed,
    'RewardClaimed event missing',
  );
  assert.equal(
    rewardClaimed.args.roundId,
    ROUND_ID,
  );
  assert.equal(
    rewardClaimed.args.ticketId,
    EXPECTED_CLAIM_TICKET,
  );
  assert.equal(
    rewardClaimed.args.amount,
    EXPECTED_CLAIM_AMOUNT,
  );

  const claimOwner =
    getAddress(
      rewardClaimed.args.owner,
    );

  assert.equal(
    findExactTransfer(
      claimReceipt,
      POOL,
      claimOwner,
      EXPECTED_CLAIM_AMOUNT,
    ),
    true,
    'claim USDC transfer missing',
  );

  const ownerRaw =
    await ethCall(
      TICKET,
      ticketIface.encodeFunctionData(
        'ownerOf',
        [EXPECTED_CLAIM_TICKET],
      ),
    );

  const [currentOwner] =
    ticketIface.decodeFunctionResult(
      'ownerOf',
      ownerRaw,
    );

  assert.equal(
    getAddress(currentOwner),
    claimOwner,
    'claimed ticket owner mismatch',
  );

  const claimedRaw =
    await ethCall(
      POOL,
      poolIface.encodeFunctionData(
        'claimed',
        [EXPECTED_CLAIM_TICKET],
      ),
    );

  const [isClaimed] =
    poolIface.decodeFunctionResult(
      'claimed',
      claimedRaw,
    );

  assert.equal(
    isClaimed,
    true,
    'ticket must remain claimed',
  );

  const claimableRaw =
    await ethCall(
      POOL,
      poolIface.encodeFunctionData(
        'claimableByTicket',
        [EXPECTED_CLAIM_TICKET],
      ),
    );

  const [claimable] =
    poolIface.decodeFunctionResult(
      'claimableByTicket',
      claimableRaw,
    );

  assert.equal(
    claimable,
    0n,
    'claimed ticket must have zero claimable',
  );

  const verification =
    await fetchJson(
      `${BACKEND_URL}/api/rounds/eth-daily-high/4/verification`,
      {},
      15000,
    );

  assert.equal(
    verification?.chain?.id,
    5042002,
    'verification chain mismatch',
  );
  assert.equal(
    verification?.round?.roundId,
    4,
    'verification round mismatch',
  );
  assert.equal(
    verification?.round?.contractStatus,
    'SETTLED',
    'verification round status mismatch',
  );
  assert.equal(
    verification?.verification?.status,
    'VERIFIED',
    'settlement evidence must be VERIFIED',
  );
  assert.equal(
    String(
      verification?.verification
        ?.settlementTxHash || '',
    ).toLowerCase(),
    EXPECTED_SETTLEMENT_TX,
    'verification settlement tx mismatch',
  );
  assert.equal(
    verification?.verification?.integrity
      ?.evidenceHashValid,
    true,
  );
  assert.equal(
    verification?.verification?.integrity
      ?.poolIdentityMatches,
    true,
  );
  assert.equal(
    verification?.verification?.integrity
      ?.marketPeriodMatches,
    true,
  );
  assert.equal(
    verification?.verification?.integrity
      ?.resolvedPriceMatchesOnchain,
    true,
  );

  const summary = {
    chainId: 5042002,
    pool: getAddress(POOL),
    ticket: getAddress(TICKET),
    round: {
      roundId: 4,
      status: 'SETTLED',
      entryOpenAt:
        Number(round.entryOpenAt),
      entryCloseAt:
        Number(round.entryCloseAt),
      observationStartAt:
        Number(round.observationStartAt),
      observationEndAt:
        Number(round.observationEndAt),
      entryCount:
        Number(round.entryCount),
      totalStakeRaw:
        round.totalStake.toString(),
      resolvedPriceCents:
        round.resolvedPriceCents.toString(),
      winnerTicketIds:
        winners.map(String),
    },
    entries,
    settlement: {
      txHash: EXPECTED_SETTLEMENT_TX,
      blockNumber:
        Number(
          settlementReceipt.blockNumber,
        ),
      resolver:
        getAddress(RESOLVER),
      treasuryUsdcRaw:
        EXPECTED_TREASURY_AMOUNT.toString(),
    },
    claim: {
      ticketId:
        EXPECTED_CLAIM_TICKET.toString(),
      owner: claimOwner,
      txHash: EXPECTED_CLAIM_TX,
      blockNumber:
        Number(claimReceipt.blockNumber),
      amountUsdcRaw:
        EXPECTED_CLAIM_AMOUNT.toString(),
      claimed: true,
      claimableRaw: '0',
    },
    verification: {
      status:
        verification.verification.status,
      evidenceSha256:
        verification.verification
          .evidenceSha256,
      sourceDataSha256:
        verification.verification
          .sourceDataSha256,
      settlementTxHash:
        verification.verification
          .settlementTxHash,
      integrity:
        verification.verification
          .integrity,
    },
  };

  console.log(
    'FINAL_ROUND_PROOF=' +
      JSON.stringify(
        summary,
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
