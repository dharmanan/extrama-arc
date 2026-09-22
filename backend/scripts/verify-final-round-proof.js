'use strict';

const assert = require('node:assert/strict');
const {
  Interface,
  getAddress,
  zeroPadValue,
  toBeHex,
  toQuantity,
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
const EXPECTED_STAKE = 1000000n;

const SEARCH_LOW_BLOCK = 60000000;
const SEARCH_HIGH_BLOCK = 61052025;

const poolIface = new Interface([
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
  'function claimed(uint256 ticketId) view returns (bool)',
  'function claimableByTicket(uint256 ticketId) view returns (uint256)',
  'event RoundCreated(uint256 indexed roundId,uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt)',
  'event RoundLocked(uint256 indexed roundId)',
  'event PredictionEntered(uint256 indexed roundId,uint256 indexed ticketId,address indexed entrant,uint64 predictionPriceCents,uint64 entrySequence)',
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
      throw new Error(
        `HTTP_${response.status}_${url}`,
      );
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
    throw new Error(
      `RPC_${method}_${JSON.stringify(body.error)}`,
    );
  }

  return body.result;
}

async function rpc(method, params) {
  let primaryError = null;

  try {
    return await rpcOne(
      PRIMARY_RPC,
      method,
      params,
    );
  } catch (error) {
    primaryError = error;
  }

  try {
    return await rpcOne(
      FALLBACK_RPC,
      method,
      params,
    );
  } catch (fallbackError) {
    throw new Error(
      `both_rpc_endpoints_failed primary=${primaryError?.message} fallback=${fallbackError.message}`,
    );
  }
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

function roundTopic(eventName) {
  return [
    poolIface.getEvent(eventName).topicHash,
    zeroPadValue(
      toBeHex(ROUND_ID),
      32,
    ),
  ];
}

async function getBlockByNumber(number) {
  const block = await rpc(
    'eth_getBlockByNumber',
    [toQuantity(number), false],
  );

  assert.ok(
    block,
    `missing block ${number}`,
  );

  return block;
}

async function blockAtOrBeforeTimestamp(timestamp) {
  let low = SEARCH_LOW_BLOCK;
  let high = SEARCH_HIGH_BLOCK;
  let answer = low;

  while (low <= high) {
    const mid =
      Math.floor((low + high) / 2);

    const block =
      await getBlockByNumber(mid);

    const blockTime =
      Number(block.timestamp);

    if (blockTime <= timestamp) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer;
}

function isRangeTooLarge(error) {
  const text =
    String(error?.message || error);

  return (
    text.includes('requested range too large') ||
    text.includes('maxBlockRange') ||
    text.includes('maxFilteredBlockRange')
  );
}

async function getLogsAdaptive({
  address,
  topics,
  fromBlock,
  toBlock,
}) {
  if (fromBlock > toBlock) return [];

  const filter = {
    address,
    fromBlock: toQuantity(fromBlock),
    toBlock: toQuantity(toBlock),
    topics,
  };

  try {
    return await rpcOne(
      PRIMARY_RPC,
      'eth_getLogs',
      [filter],
    );
  } catch (primaryError) {
    const width =
      toBlock - fromBlock + 1;

    if (
      width <= 100 &&
      !isRangeTooLarge(primaryError)
    ) {
      try {
        return await rpcOne(
          FALLBACK_RPC,
          'eth_getLogs',
          [filter],
        );
      } catch {}
    }

    if (fromBlock === toBlock) {
      throw primaryError;
    }

    const middle =
      Math.floor(
        (fromBlock + toBlock) / 2,
      );

    const [left, right] =
      await Promise.all([
        getLogsAdaptive({
          address,
          topics,
          fromBlock,
          toBlock: middle,
        }),
        getLogsAdaptive({
          address,
          topics,
          fromBlock: middle + 1,
          toBlock,
        }),
      ]);

    return [...left, ...right];
  }
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

  const entryOpenBlock =
    await blockAtOrBeforeTimestamp(
      Number(round.entryOpenAt),
    );

  const entryCloseBlock =
    await blockAtOrBeforeTimestamp(
      Number(round.entryCloseAt),
    );

  const observationEndBlock =
    await blockAtOrBeforeTimestamp(
      Number(round.observationEndAt),
    );

  const createdLogs =
    await getLogsAdaptive({
      address: POOL,
      topics: roundTopic('RoundCreated'),
      fromBlock: Math.max(
        SEARCH_LOW_BLOCK,
        entryOpenBlock - 20000,
      ),
      toBlock: entryOpenBlock + 2000,
    });

  assert.equal(
    createdLogs.length,
    1,
    'exactly one RoundCreated event expected',
  );

  const created =
    parsePoolLog(createdLogs[0]);

  assert.equal(
    created.args.roundId,
    ROUND_ID,
  );

  const createdReceipt =
    await receipt(
      createdLogs[0].transactionHash,
    );

  const lockedLogs =
    await getLogsAdaptive({
      address: POOL,
      topics: roundTopic('RoundLocked'),
      fromBlock: Math.max(
        Number(createdLogs[0].blockNumber),
        entryCloseBlock - 1000,
      ),
      toBlock: Math.min(
        60988590,
        entryCloseBlock + 10000,
      ),
    });

  assert.equal(
    lockedLogs.length,
    1,
    'exactly one RoundLocked event expected',
  );

  await receipt(
    lockedLogs[0].transactionHash,
  );

  const entryLogs =
    await getLogsAdaptive({
      address: POOL,
      topics: roundTopic('PredictionEntered'),
      fromBlock: Math.max(
        Number(createdLogs[0].blockNumber),
        entryOpenBlock - 1000,
      ),
      toBlock: Math.min(
        Number(lockedLogs[0].blockNumber),
        entryCloseBlock + 1000,
      ),
    });

  assert.equal(
    entryLogs.length,
    3,
    'exactly 3 PredictionEntered events expected',
  );

  const entries = [];

  for (const log of entryLogs) {
    const parsed = parsePoolLog(log);
    const ticketId =
      BigInt(parsed.args.ticketId);
    const entrant =
      getAddress(parsed.args.entrant);
    const prediction =
      BigInt(
        parsed.args.predictionPriceCents,
      );

    assert.equal(
      prediction,
      EXPECTED_PREDICTIONS.get(ticketId),
      `prediction mismatch ticket ${ticketId}`,
    );

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
      BigInt(decoded.roundId),
      ROUND_ID,
    );
    assert.equal(
      getAddress(decoded.originalEntrant),
      entrant,
    );
    assert.equal(
      BigInt(decoded.predictionPriceCents),
      prediction,
    );

    const entryReceipt =
      await receipt(
        log.transactionHash,
      );

    assert.equal(
      findExactTransfer(
        entryReceipt,
        entrant,
        POOL,
        EXPECTED_STAKE,
      ),
      true,
      `1 USDC entry transfer missing ticket ${ticketId}`,
    );

    entries.push({
      ticketId: ticketId.toString(),
      entrant,
      predictionPriceCents:
        prediction.toString(),
      entrySequence:
        parsed.args.entrySequence.toString(),
      txHash: log.transactionHash,
      blockNumber:
        Number(log.blockNumber),
    });
  }

  entries.sort(
    (a, b) =>
      Number(a.entrySequence) -
      Number(b.entrySequence),
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
    roundId: 4,
    blockAnchors: {
      entryOpenBlock,
      entryCloseBlock,
      observationEndBlock,
    },
    roundCreated: {
      txHash:
        createdLogs[0].transactionHash,
      blockNumber:
        Number(createdLogs[0].blockNumber),
      receiptStatus:
        Number(createdReceipt.status),
      entryOpenAt:
        Number(created.args.entryOpenAt),
      entryCloseAt:
        Number(created.args.entryCloseAt),
      observationStartAt:
        Number(
          created.args.observationStartAt,
        ),
      observationEndAt:
        Number(
          created.args.observationEndAt,
        ),
    },
    entries,
    lock: {
      txHash:
        lockedLogs[0].transactionHash,
      blockNumber:
        Number(lockedLogs[0].blockNumber),
    },
    settlement: {
      txHash: EXPECTED_SETTLEMENT_TX,
      blockNumber:
        Number(
          settlementReceipt.blockNumber,
        ),
      resolver:
        getAddress(RESOLVER),
      resolvedPriceCents:
        EXPECTED_RESOLVED_PRICE.toString(),
      winners:
        EXPECTED_WINNERS.map(String),
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
    'RESULT=FINAL_SINGLE_ROUND_LIFECYCLE_PROOF_COMPLETE',
  );
}

main().catch((error) => {
  console.error(
    'RESULT=FINAL_SINGLE_ROUND_LIFECYCLE_PROOF_FAIL',
  );
  console.error(
    error.stack || error.message,
  );
  process.exitCode = 1;
});
