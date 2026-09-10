'use strict';

const { ethers } = require('ethers');
const POOL_STATE_ABI = [
  'function getRound(uint256) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function hasEntered(uint256,address) view returns (bool)',
  'function predictionTaken(uint256,uint64) view returns (bool)',
];

const USDC_STATE_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

function createSeedBotLiveStateService({
  arc = null,
  ethersLib = ethers,
  timeoutMs = 15_000,
} = {}) {
  const resolvedArc = arc || require('./arcService');
  function canonicalTopologyFor(entry) {
    const poolAddress = String(entry?.poolAddress || '').toLowerCase();

    return resolvedArc.ARC_POOL_TOPOLOGY.find(
      item =>
        item.cadence === 'DAILY' &&
        item.poolAddress.toLowerCase() === poolAddress,
    ) || null;
  }

  async function readFreshSeedEntryState(entry) {
    const topology = canonicalTopologyFor(entry);
    if (!topology) throw new Error('seed_live_pool_not_canonical');

    if (!ethersLib.isAddress(entry?.wallet)) {
      throw new Error('seed_live_wallet_invalid');
    }

    const roundId = Number(entry.roundId);
    const predictionPriceCents = Number(entry.predictionPriceCents);

    if (!Number.isSafeInteger(roundId) || roundId <= 0) {
      throw new Error('seed_live_round_invalid');
    }

    if (
      !Number.isSafeInteger(predictionPriceCents) ||
      predictionPriceCents <= 0
    ) {
      throw new Error('seed_live_prediction_invalid');
    }

    const provider = resolvedArc.getArcProvider();

    const pool = new ethersLib.Contract(
      topology.poolAddress,
      POOL_STATE_ABI,
      provider,
    );

    const usdc = new ethersLib.Contract(
      resolvedArc.ARC_TESTNET_USDC_ADDRESS,
      USDC_STATE_ABI,
      provider,
    );

    const reads = Promise.all([
      provider.getNetwork(),
      provider.getBlock('latest'),
      pool.getRound(roundId),
      pool.hasEntered(roundId, entry.wallet),
      pool.predictionTaken(roundId, predictionPriceCents),
      usdc.balanceOf(entry.wallet),
      provider.getBalance(entry.wallet),
    ]);

    const [
      network,
      latestBlock,
      round,
      hasEntered,
      predictionTaken,
      usdcRaw,
      nativeRaw,
    ] = await Promise.race([
      reads,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('seed_live_state_timeout')),
          timeoutMs,
        ),
      ),
    ]);

    if (!latestBlock) throw new Error('seed_live_block_unavailable');

    return {
      topology,
      liveState: {
        chainId: Number(network.chainId),
        chainTimestamp: Number(latestBlock.timestamp),
        poolAddress: topology.poolAddress,
        ticketAddress: topology.ticketAddress,
        roundId,
        roundStatus: Number(round.status),
        entryOpenAt: Number(round.entryOpenAt),
        entryCloseAt: Number(round.entryCloseAt),
        hasEntered: Boolean(hasEntered),
        predictionTaken: Boolean(predictionTaken),
        usdcRaw: usdcRaw.toString(),
        // Technical native-interface read of the same underlying USDC asset.
        nativeUsdcRaw: nativeRaw.toString(),
        // Keep the historical field as an internal compatibility alias while
        // callers migrate to the explicit name above.
        nativeRaw: nativeRaw.toString(),
      },
    };
  }

  return Object.freeze({
    readFreshSeedEntryState,
  });
}

async function readFreshSeedEntryState(entry) {
  return createSeedBotLiveStateService().readFreshSeedEntryState(entry);
}

module.exports = {
  createSeedBotLiveStateService,
  readFreshSeedEntryState,
};
