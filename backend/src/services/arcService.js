'use strict';

const { ethers } = require('ethers');
const config = require('../config');

const ARC_TESTNET_CHAIN_ID = 5042002n;
const ARC_TESTNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

const FACTORY_ABI = [
  'function pools() view returns (address[])',
];

const POOL_ABI = [
  'function ASSET() view returns (uint8)',
  'function DIRECTION() view returns (uint8)',
  'function CADENCE() view returns (uint8)',
  'function TICKET() view returns (address)',
  'function nextRoundId() view returns (uint256)',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
];

const ASSETS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const DIRECTIONS = ['HIGH', 'LOW'];
const CADENCES = ['DAILY', 'WEEKLY', 'QUARTERLY'];
const CONTRACT_STATUSES = ['ENTRY_OPEN', 'LOCKED', 'SETTLED', 'CANCELLED'];
const SOURCE_SYMBOLS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  HYPE: 'HYPEUSDT',
};

function getProvider() {
  return new ethers.JsonRpcProvider(
    config.ARC_TESTNET_RPC_URL,
    { chainId: Number(ARC_TESTNET_CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );
}

function toIso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function slugify(asset, cadence, direction) {
  return `${asset.toLowerCase()}-${cadence.toLowerCase()}-${direction.toLowerCase()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  return (
    error?.info?.error?.code === -32005 ||
    String(error?.info?.error?.message || '').toLowerCase().includes('rate limit') ||
    String(error?.shortMessage || error?.message || '').toLowerCase().includes('rate limit')
  );
}

async function rpcRead(operation, attempts = 6) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === attempts - 1) {
        throw error;
      }

      await sleep(250 * (2 ** attempt));
    }
  }

  throw lastError;
}

async function readArcWalletState(address) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const provider = getProvider();
  const [network, blockNumber, code, nativeBalanceRaw] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getCode(ARC_TESTNET_USDC_ADDRESS),
    provider.getBalance(address),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  if (code === '0x') {
    throw new Error('arc_usdc_contract_not_found');
  }

  const usdc = new ethers.Contract(ARC_TESTNET_USDC_ADDRESS, USDC_ABI, provider);
  const [balanceRaw, decimals, symbol, name] = await Promise.all([
    usdc.balanceOf(address),
    usdc.decimals(),
    usdc.symbol(),
    usdc.name(),
  ]);

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      rpcUrl: config.ARC_TESTNET_RPC_URL,
      explorerUrl: 'https://testnet.arcscan.app',
      blockNumber,
    },
    native: {
      symbol: 'USDC',
      decimals: 18,
      balanceRaw: nativeBalanceRaw.toString(),
      balanceFormatted: ethers.formatUnits(nativeBalanceRaw, 18),
    },
    usdc: {
      address: ARC_TESTNET_USDC_ADDRESS,
      name,
      symbol,
      decimals: Number(decimals),
      balanceRaw: balanceRaw.toString(),
      balanceFormatted: ethers.formatUnits(balanceRaw, decimals),
      contractCodePresent: true,
    },
    wallet: {
      address: ethers.getAddress(address),
      explorerUrl: `https://testnet.arcscan.app/address/${ethers.getAddress(address)}`,
    },
  };
}

async function readStandardRounds() {
  const provider = getProvider();
  const factoryAddress = ethers.getAddress(config.EXTREMA_FACTORY_ADDRESS);

  const [network, blockNumber, latestBlock, factoryCode] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getBlock('latest'),
    provider.getCode(factoryAddress),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }
  if (factoryCode === '0x') {
    throw new Error('extrema_factory_contract_not_found');
  }
  if (!latestBlock) {
    throw new Error('arc_latest_block_unavailable');
  }

  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const poolAddresses = await factory.pools();
  if (poolAddresses.length !== 24) {
    throw new Error('extrema_pool_count_mismatch');
  }

  const chainTimestamp = BigInt(latestBlock.timestamp);

  // Arc's public RPC rate-limits large bursts of eth_call requests.
  // Read pools sequentially and retry only explicit rate-limit failures.
  // This is slower than a 24-way Promise.all, but deterministic and reliable.
  const pools = [];

  for (const poolAddressRaw of poolAddresses) {
    const poolAddress = ethers.getAddress(poolAddressRaw);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    const assetIndex = await rpcRead(() => pool.ASSET());
    const directionIndex = await rpcRead(() => pool.DIRECTION());
    const cadenceIndex = await rpcRead(() => pool.CADENCE());
    const ticketAddressRaw = await rpcRead(() => pool.TICKET());
    const nextRoundId = await rpcRead(() => pool.nextRoundId());

    const asset = ASSETS[Number(assetIndex)];
    const direction = DIRECTIONS[Number(directionIndex)];
    const cadence = CADENCES[Number(cadenceIndex)];
    if (!asset || !direction || !cadence) {
      throw new Error('extrema_pool_identity_invalid');
    }
    if (nextRoundId <= 1n) {
      throw new Error('extrema_standard_round_missing');
    }

    const roundId = nextRoundId - 1n;
    const round = await rpcRead(() => pool.getRound(roundId));
    const contractStatus = CONTRACT_STATUSES[Number(round.status)];
    if (!contractStatus) {
      throw new Error('extrema_round_status_invalid');
    }

    const canEnter =
      contractStatus === 'ENTRY_OPEN' &&
      chainTimestamp >= round.entryOpenAt &&
      chainTimestamp < round.entryCloseAt;

    pools.push({
      slug: slugify(asset, cadence, direction),
      poolAddress,
      ticketAddress: ethers.getAddress(ticketAddressRaw),
      asset,
      direction,
      cadence,
      source: 'Binance USDⓈ-M Futures Mark Price',
      sourceSymbol: SOURCE_SYMBOLS[asset],
      round: {
        roundId: Number(roundId),
        contractStatus,
        canEnter,
        entryOpenAt: toIso(round.entryOpenAt),
        entryCloseAt: toIso(round.entryCloseAt),
        observationStartAt: toIso(round.observationStartAt),
        observationEndAt: toIso(round.observationEndAt),
        entryCount: Number(round.entryCount),
        totalStakeRaw: round.totalStake.toString(),
        totalStakeUsdc: ethers.formatUnits(round.totalStake, 6),
        escrowRemainingRaw: round.escrowRemaining.toString(),
        escrowRemainingUsdc: ethers.formatUnits(round.escrowRemaining, 6),
        resolvedPriceCents: round.resolvedPriceCents.toString(),
      },
    });
  }

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      blockNumber,
      timestamp: Number(chainTimestamp),
      timestampIso: toIso(chainTimestamp),
      explorerUrl: 'https://testnet.arcscan.app',
    },
    factory: {
      address: factoryAddress,
      poolCount: pools.length,
    },
    pools,
  };
}

module.exports = {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  readArcWalletState,
  readStandardRounds,
};
