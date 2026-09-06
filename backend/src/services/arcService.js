'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const { getLiveMarkPrices } = require('./binanceResolverService');

const ARC_TESTNET_CHAIN_ID = 5042002n;
const ARC_TESTNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
const ARCHIVE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

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
  'function nextRoundId() view returns (uint256)',
  'function nextTicketId() view returns (uint256)',
  'function getRoundTicketIds(uint256 roundId) view returns (uint256[])',
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
  'function getTicketMetadata(uint256 ticketId) view returns (tuple(uint256 roundId,uint64 predictionPriceCents,uint64 entrySequence,uint8 roundStatus,uint8 placement,bool isClaimed,bool isRefunded))',
  'function entries(uint256 ticketId) view returns (uint256 ticketId,uint256 roundId,address originalEntrant,uint64 predictionPriceCents,uint64 entrySequence)',
  'function claimableByTicket(uint256 ticketId) view returns (uint256)',
  'function claimed(uint256 ticketId) view returns (bool)',
  'function refunded(uint256 ticketId) view returns (bool)',
  'function STAKE_AMOUNT() view returns (uint256)',
  'function USDC() view returns (address)',
];

const ARC_POOL_TOPOLOGY = [
  { asset: 'BTC', direction: 'HIGH', cadence: 'DAILY', poolAddress: '0xc724050511Df7CC0cb7aFC688cbcc9C2A16dC36d', ticketAddress: '0x3c04c15025731A07772018e8609a8af7212d8801' },
  { asset: 'BTC', direction: 'HIGH', cadence: 'WEEKLY', poolAddress: '0xE7d18196075227F0b264F3612942b02e0FedC1d1', ticketAddress: '0x5e39A234c7654d3f005Ec5d2bEb014c159a9D38d' },
  { asset: 'BTC', direction: 'HIGH', cadence: 'QUARTERLY', poolAddress: '0x7573cD9Ff84afda1e1f46Ab59f6Ff3dc4c0106A0', ticketAddress: '0xD6F2545F00eefaA00c02cEcaFfBb4EC33532c603' },
  { asset: 'BTC', direction: 'LOW', cadence: 'DAILY', poolAddress: '0x18e34fF5527637fdA1C13297DAcbEE7c08e69dad', ticketAddress: '0x9BF5C34B23658a9aC06C0A47B59d9B90350e735E' },
  { asset: 'BTC', direction: 'LOW', cadence: 'WEEKLY', poolAddress: '0x74a1Fc98876C2c7E792eB2F7577a908620F68f89', ticketAddress: '0x468f1485cDfF194114Bd3fC7b126EbdbBa704e0A' },
  { asset: 'BTC', direction: 'LOW', cadence: 'QUARTERLY', poolAddress: '0x842A2F152a9b5aD7E9b7CB651DE59eD53040dBD0', ticketAddress: '0xEa6d00b5E473c5647f1B8CdceD8E56653181Afd3' },
  { asset: 'ETH', direction: 'HIGH', cadence: 'DAILY', poolAddress: '0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f', ticketAddress: '0xF65Cf4a67299ad596e139e3F6a9594E809F05637' },
  { asset: 'ETH', direction: 'HIGH', cadence: 'WEEKLY', poolAddress: '0x7c2e9C3221534F24ecA83949D4f7249c95C35c33', ticketAddress: '0xd20a69DB0A957D6f285b6Af67fed653d65cD7E5d' },
  { asset: 'ETH', direction: 'HIGH', cadence: 'QUARTERLY', poolAddress: '0x6652e6F150e889Be15fbD6608A70e03aB7048d48', ticketAddress: '0x070C0153F1DCa041FdE84C581f12Ef832f3F50B8' },
  { asset: 'ETH', direction: 'LOW', cadence: 'DAILY', poolAddress: '0x490A5CE02E3fd85d51095A69AAE9511552d91095', ticketAddress: '0x6FC6756af39fb520844EdA73D6855990e56049E1' },
  { asset: 'ETH', direction: 'LOW', cadence: 'WEEKLY', poolAddress: '0x8ec016AE0376Bf7d893Be4BeA6Fb1C57AAabf718', ticketAddress: '0xa2F82BE41567D7BE6F7F2Ba435D23068eE2A2212' },
  { asset: 'ETH', direction: 'LOW', cadence: 'QUARTERLY', poolAddress: '0xBD70a2F01F8524C4858A9A26AEdF82dC936da789', ticketAddress: '0xDb6761e9eeD6e52E3bb42FB0157b3818a2BF6b16' },
  { asset: 'SOL', direction: 'HIGH', cadence: 'DAILY', poolAddress: '0xb81C2551cb757Cd51ABfCa3db4e876820634c76c', ticketAddress: '0x7Fb08d5A0d168De4CE479FC21C1E45fF35353F9C' },
  { asset: 'SOL', direction: 'HIGH', cadence: 'WEEKLY', poolAddress: '0x7b24aFccf1f63545A36cd41a30c4846aBFb17CF8', ticketAddress: '0x534d90A4E4314f4A54E3eBd4D0cBe276E7CdD92A' },
  { asset: 'SOL', direction: 'HIGH', cadence: 'QUARTERLY', poolAddress: '0xC5BA26016387e2c041d136779D1dE8d02DEf5c50', ticketAddress: '0x18c6b2c1Aad92321E83a39D92Fc621ffCDD51264' },
  { asset: 'SOL', direction: 'LOW', cadence: 'DAILY', poolAddress: '0xdf1bE0356E5207f8aB96598c289823B488478fF5', ticketAddress: '0x174a3f5C207875f059171f35399869D60F792190' },
  { asset: 'SOL', direction: 'LOW', cadence: 'WEEKLY', poolAddress: '0x5341Ca1e1257555a8bAceF969f3F3e06C6583f48', ticketAddress: '0x4BC109D7347855b5096B84BC6194Fe0d34a17bf4' },
  { asset: 'SOL', direction: 'LOW', cadence: 'QUARTERLY', poolAddress: '0xc3b87D6C96924C107148D3db01dcDFcddFfCF981', ticketAddress: '0xD2b407294F18ec833c6BED915437832cdd235e6d' },
  { asset: 'HYPE', direction: 'HIGH', cadence: 'DAILY', poolAddress: '0x97563B5DE4019311529c405ac78F59D74A001894', ticketAddress: '0x6e40BCedcb29b7E5e509F15d3f4C4380a5C670e2' },
  { asset: 'HYPE', direction: 'HIGH', cadence: 'WEEKLY', poolAddress: '0xc699665f2BB38f7545C6bC1226755046F48A4D63', ticketAddress: '0xa7e359d2dF9E94B1E829f56016A7D879C53C63BC' },
  { asset: 'HYPE', direction: 'HIGH', cadence: 'QUARTERLY', poolAddress: '0x8EFEEdfF439c772dcD040E36F43767F67B229C74', ticketAddress: '0x3cA0498a01c2D2D4a687E68791f77a542AF88d14' },
  { asset: 'HYPE', direction: 'LOW', cadence: 'DAILY', poolAddress: '0x429329Efcd2c20198aB99EbF2459Be649864337C', ticketAddress: '0xAff6f3b5C2947368545B012c9689df2eC55997Bb' },
  { asset: 'HYPE', direction: 'LOW', cadence: 'WEEKLY', poolAddress: '0xE936A4125360562390d8202911d767DAb2FA4852', ticketAddress: '0x0A4C0AA2D0ff801AC774167c69A44b4F1210B404' },
  { asset: 'HYPE', direction: 'LOW', cadence: 'QUARTERLY', poolAddress: '0x8F921fDc4C02D46a02B85dAd0b2F3dF23303505b', ticketAddress: '0x84B9C1AdC20333022064234BaC11A1C786Cf08fC' },
];

const TICKET_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) returns ((bool success,bytes returnData)[] returnData)',
];
const POOL_INTERFACE = new ethers.Interface(POOL_ABI);
const TICKET_INTERFACE = new ethers.Interface(TICKET_ABI);
const MULTICALL3_INTERFACE = new ethers.Interface(MULTICALL3_ABI);

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

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

const ARC_WALLET_STATE_CACHE_TTL_MS = 10_000;
const arcWalletStateCache = new Map();
const arcWalletStateRefreshPromises = new Map();
const ARC_OWNED_TICKETS_CACHE_TTL_MS = 5_000;
const arcOwnedTicketsCache = new Map();
const arcOwnedTicketsRefreshPromises = new Map();

async function readArcWalletState(address) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const owner = ethers.getAddress(address);
  const provider = getProvider();

  const [network, blockNumber, code, nativeBalanceRaw] = await Promise.all([
    rpcRead(() => provider.getNetwork()),
    rpcRead(() => provider.getBlockNumber()),
    rpcRead(() => provider.getCode(ARC_TESTNET_USDC_ADDRESS)),
    rpcRead(() => provider.getBalance(owner)),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  if (code === '0x') {
    throw new Error('arc_usdc_contract_not_found');
  }

  const usdc = new ethers.Contract(ARC_TESTNET_USDC_ADDRESS, USDC_ABI, provider);
  const [balanceRaw, decimals, symbol, name] = await Promise.all([
    rpcRead(() => usdc.balanceOf(owner)),
    rpcRead(() => usdc.decimals()),
    rpcRead(() => usdc.symbol()),
    rpcRead(() => usdc.name()),
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
      address: owner,
      explorerUrl: `https://testnet.arcscan.app/address/${owner}`,
    },
  };
}

async function refreshArcWalletStateCache(address) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const key = ethers.getAddress(address).toLowerCase();
  const existing = arcWalletStateRefreshPromises.get(key);
  if (existing) return existing;

  const refreshPromise = readArcWalletState(address)
    .then((state) => {
      arcWalletStateCache.set(key, {
        state,
        cachedAt: Date.now(),
      });
      return state;
    })
    .finally(() => {
      arcWalletStateRefreshPromises.delete(key);
    });

  arcWalletStateRefreshPromises.set(key, refreshPromise);
  return refreshPromise;
}

async function getArcWalletState(address, { forceFresh = false } = {}) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const key = ethers.getAddress(address).toLowerCase();
  const cached = arcWalletStateCache.get(key);

  if (
    !forceFresh &&
    cached &&
    Date.now() - cached.cachedAt <= ARC_WALLET_STATE_CACHE_TTL_MS
  ) {
    return cached.state;
  }

  return refreshArcWalletStateCache(address);
}

function invalidateArcWalletStateCache(address) {
  if (!ethers.isAddress(address)) return;
  const key = ethers.getAddress(address).toLowerCase();
  arcWalletStateCache.delete(key);
  arcOwnedTicketsCache.delete(key);
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
  const registeredPools = await rpcRead(() => factory.pools());
  if (registeredPools.length !== ARC_POOL_TOPOLOGY.length) {
    throw new Error('extrema_pool_count_mismatch');
  }

  const registered = new Set(
    registeredPools.map((address) => ethers.getAddress(address).toLowerCase()),
  );
  for (const item of ARC_POOL_TOPOLOGY) {
    if (!registered.has(ethers.getAddress(item.poolAddress).toLowerCase())) {
      throw new Error('extrema_topology_mismatch');
    }
  }

  const chainTimestamp = BigInt(latestBlock.timestamp);
  const liveMarks = await getLiveMarkPrices();

  const pools = await mapWithConcurrency(
    ARC_POOL_TOPOLOGY,
    3,
    async (topology) => {
      const poolAddress = ethers.getAddress(topology.poolAddress);
      const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

      const nextRoundId = await rpcRead(() => pool.nextRoundId());
      if (nextRoundId <= 1n) {
        throw new Error('extrema_standard_round_missing');
      }

      const roundId = nextRoundId - 1n;
      const [round, nextTicketId] = await Promise.all([
        rpcRead(() => pool.getRound(roundId)),
        rpcRead(() => pool.nextTicketId()),
      ]);
      const contractStatus = CONTRACT_STATUSES[Number(round.status)];
      if (!contractStatus) {
        throw new Error('extrema_round_status_invalid');
      }

      const canEnter =
        contractStatus === 'ENTRY_OPEN' &&
        chainTimestamp >= round.entryOpenAt &&
        chainTimestamp < round.entryCloseAt;

      let lastPredictionPriceCents = null;
      let lastPredictionTicketId = null;
      let lastPredictionEntrySequence = null;

      if (nextTicketId > 1n) {
        const candidateTicketId = nextTicketId - 1n;
        const candidateEntry = await rpcRead(() => pool.entries(candidateTicketId));
        if (BigInt(candidateEntry.roundId) === roundId) {
          lastPredictionPriceCents = candidateEntry.predictionPriceCents.toString();
          lastPredictionTicketId = candidateTicketId.toString();
          lastPredictionEntrySequence = Number(candidateEntry.entrySequence);
        }
      }

      const liveMark = liveMarks.prices[SOURCE_SYMBOLS[topology.asset]];
      const liveMarkAvailable = Boolean(liveMark && !liveMark.unavailable);

      return {
        slug: slugify(topology.asset, topology.cadence, topology.direction),
        poolAddress,
        ticketAddress: ethers.getAddress(topology.ticketAddress),
        asset: topology.asset,
        direction: topology.direction,
        cadence: topology.cadence,
        source: 'Binance USDⓈ-M Futures Mark Price',
        sourceSymbol: SOURCE_SYMBOLS[topology.asset],
        market: liveMarkAvailable
          ? {
              available: true,
              markPrice: liveMark.markPrice,
              sourceTimeIso: liveMark.sourceTimeIso,
              refreshedAtIso: liveMarks.refreshedAtIso,
              refreshIntervalSeconds: 60,
              source: liveMark.source || 'Binance USDⓈ-M Futures Mark Price',
              isSettlementSource: Boolean(liveMark.isSettlementSource),
            }
          : {
              available: false,
              markPrice: null,
              sourceTimeIso: null,
              refreshedAtIso: liveMarks.refreshedAtIso,
              refreshIntervalSeconds: 60,
              source: null,
              isSettlementSource: false,
            },
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
          lastPredictionPriceCents,
          lastPredictionPrice:
            lastPredictionPriceCents === null
              ? null
              : (Number(lastPredictionPriceCents) / 100).toFixed(2),
          lastPredictionTicketId,
          lastPredictionEntrySequence,
        },
      };
    },
  );

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

let multicall3Availability = null;
let multicall3ProbePromise = null;

async function hasMulticall3(provider) {
  if (multicall3Availability !== null) return multicall3Availability;
  if (!multicall3ProbePromise) {
    multicall3ProbePromise = rpcRead(() => provider.getCode(MULTICALL3_ADDRESS))
      .then((code) => {
        multicall3Availability = code !== '0x';
        return multicall3Availability;
      })
      .finally(() => {
        multicall3ProbePromise = null;
      });
  }
  return multicall3ProbePromise;
}

async function readMulticall3(provider, calls) {
  if (!(await hasMulticall3(provider))) {
    throw new Error('arc_multicall3_not_found');
  }

  const data = MULTICALL3_INTERFACE.encodeFunctionData('aggregate3', [calls]);
  const raw = await rpcRead(() => provider.call({ to: MULTICALL3_ADDRESS, data }));
  const [results] = MULTICALL3_INTERFACE.decodeFunctionResult('aggregate3', raw);
  if (results.length !== calls.length) {
    throw new Error('arc_multicall3_result_mismatch');
  }
  return results;
}

async function readMulticall3InChunks(provider, calls, chunkSize = 100) {
  const results = [];
  for (let index = 0; index < calls.length; index += chunkSize) {
    results.push(...await readMulticall3(provider, calls.slice(index, index + chunkSize)));
  }
  return results;
}

async function readOwnedTicketsViaMulticall(address) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const owner = ethers.getAddress(address);
  const provider = getProvider();
  const [network, blockNumber, multicallAvailable] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    hasMulticall3(provider),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }
  if (!multicallAvailable) {
    throw new Error('arc_multicall3_not_found');
  }

  const nextTicketResults = await readMulticall3(provider, ARC_POOL_TOPOLOGY.map((topology) => ({
    target: topology.poolAddress,
    allowFailure: false,
    callData: POOL_INTERFACE.encodeFunctionData('nextTicketId'),
  })));

  const candidates = [];
  nextTicketResults.forEach((result, index) => {
    if (!result.success) throw new Error('arc_multicall3_next_ticket_failed');
    const nextTicketId = POOL_INTERFACE.decodeFunctionResult('nextTicketId', result.returnData)[0];
    for (let tokenId = 1n; tokenId < nextTicketId; tokenId += 1n) {
      candidates.push({ topology: ARC_POOL_TOPOLOGY[index], tokenId });
    }
  });

  const ownerResults = await readMulticall3InChunks(provider, candidates.map(({ topology, tokenId }) => ({
    target: topology.ticketAddress,
    allowFailure: true,
    callData: TICKET_INTERFACE.encodeFunctionData('ownerOf', [tokenId]),
  })));

  const owned = [];
  candidates.forEach((candidate, index) => {
    const result = ownerResults[index];
    if (!result?.success) return;
    let tokenOwner;
    try {
      tokenOwner = TICKET_INTERFACE.decodeFunctionResult('ownerOf', result.returnData)[0];
    } catch {
      return;
    }
    if (tokenOwner.toLowerCase() === owner.toLowerCase()) {
      owned.push(candidate);
    }
  });

  const detailCalls = owned.flatMap(({ topology, tokenId }) => [
    {
      target: topology.poolAddress,
      allowFailure: false,
      callData: POOL_INTERFACE.encodeFunctionData('getTicketMetadata', [tokenId]),
    },
    {
      target: topology.poolAddress,
      allowFailure: false,
      callData: POOL_INTERFACE.encodeFunctionData('claimableByTicket', [tokenId]),
    },
  ]);
  const detailResults = await readMulticall3InChunks(provider, detailCalls);

  const tickets = owned.map(({ topology, tokenId }, index) => {
    const metadataResult = detailResults[index * 2];
    const claimableResult = detailResults[index * 2 + 1];
    if (!metadataResult?.success || !claimableResult?.success) {
      throw new Error('arc_multicall3_ticket_detail_failed');
    }

    const metadata = POOL_INTERFACE.decodeFunctionResult(
      'getTicketMetadata',
      metadataResult.returnData,
    )[0];
    const claimableRaw = POOL_INTERFACE.decodeFunctionResult(
      'claimableByTicket',
      claimableResult.returnData,
    )[0];
    const roundStatus = CONTRACT_STATUSES[Number(metadata.roundStatus)];
    if (!roundStatus) throw new Error('extrema_ticket_status_invalid');

    return {
      tokenId: tokenId.toString(),
      roundId: Number(metadata.roundId),
      predictionPriceCents: Number(metadata.predictionPriceCents),
      predictionPrice: (Number(metadata.predictionPriceCents) / 100).toFixed(2),
      entrySequence: Number(metadata.entrySequence),
      roundStatus,
      placement: Number(metadata.placement),
      isClaimed: Boolean(metadata.isClaimed),
      isRefunded: Boolean(metadata.isRefunded),
      claimableRaw: claimableRaw.toString(),
      claimableUsdc: ethers.formatUnits(claimableRaw, 6),
      owner,
      asset: topology.asset,
      direction: topology.direction,
      cadence: topology.cadence,
      slug: slugify(topology.asset, topology.cadence, topology.direction),
      poolAddress: ethers.getAddress(topology.poolAddress),
      ticketAddress: ethers.getAddress(topology.ticketAddress),
      explorerUrl: `https://testnet.arcscan.app/address/${ethers.getAddress(topology.ticketAddress)}`,
    };
  });

  tickets.sort((a, b) => {
    if (a.asset !== b.asset) return a.asset.localeCompare(b.asset);
    if (a.cadence !== b.cadence) return a.cadence.localeCompare(b.cadence);
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
    return Number(a.tokenId) - Number(b.tokenId);
  });

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      blockNumber,
      explorerUrl: 'https://testnet.arcscan.app',
    },
    wallet: { address: owner },
    ticketCount: tickets.length,
    tickets,
  };
}

async function readOwnedTicketsLegacy(address) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const owner = ethers.getAddress(address);
  const provider = getProvider();
  const [network, blockNumber] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const groups = await mapWithConcurrency(
    ARC_POOL_TOPOLOGY,
    3,
    async (topology) => {
      const pool = new ethers.Contract(topology.poolAddress, POOL_ABI, provider);
      const ticket = new ethers.Contract(topology.ticketAddress, TICKET_ABI, provider);
      const nextTicketId = await rpcRead(() => pool.nextTicketId());

      if (nextTicketId <= 1n) return [];

      const owned = [];
      for (let tokenId = 1n; tokenId < nextTicketId; tokenId += 1n) {
        let tokenOwner;
        try {
          tokenOwner = await rpcRead(() => ticket.ownerOf(tokenId));
        } catch {
          continue;
        }

        if (tokenOwner.toLowerCase() !== owner.toLowerCase()) continue;

        const [metadata, claimableRaw] = await Promise.all([
          rpcRead(() => pool.getTicketMetadata(tokenId)),
          rpcRead(() => pool.claimableByTicket(tokenId)),
        ]);

        const roundStatus = CONTRACT_STATUSES[Number(metadata.roundStatus)];
        if (!roundStatus) throw new Error('extrema_ticket_status_invalid');

        owned.push({
          tokenId: tokenId.toString(),
          roundId: Number(metadata.roundId),
          predictionPriceCents: Number(metadata.predictionPriceCents),
          predictionPrice: (Number(metadata.predictionPriceCents) / 100).toFixed(2),
          entrySequence: Number(metadata.entrySequence),
          roundStatus,
          placement: Number(metadata.placement),
          isClaimed: Boolean(metadata.isClaimed),
          isRefunded: Boolean(metadata.isRefunded),
          claimableRaw: claimableRaw.toString(),
          claimableUsdc: ethers.formatUnits(claimableRaw, 6),
          owner,
          asset: topology.asset,
          direction: topology.direction,
          cadence: topology.cadence,
          slug: slugify(topology.asset, topology.cadence, topology.direction),
          poolAddress: ethers.getAddress(topology.poolAddress),
          ticketAddress: ethers.getAddress(topology.ticketAddress),
          explorerUrl: `https://testnet.arcscan.app/address/${ethers.getAddress(topology.ticketAddress)}`,
        });
      }

      return owned;
    },
  );

  const tickets = groups.flat().sort((a, b) => {
    if (a.asset !== b.asset) return a.asset.localeCompare(b.asset);
    if (a.cadence !== b.cadence) return a.cadence.localeCompare(b.cadence);
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
    return Number(a.tokenId) - Number(b.tokenId);
  });

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      blockNumber,
      explorerUrl: 'https://testnet.arcscan.app',
    },
    wallet: { address: owner },
    ticketCount: tickets.length,
    tickets,
  };
}

async function refreshOwnedTicketsCache(address) {
  const key = ethers.getAddress(address).toLowerCase();
  const existing = arcOwnedTicketsRefreshPromises.get(key);
  if (existing) return existing;

  const refreshPromise = readOwnedTicketsViaMulticall(address)
    .catch((error) => {
      console.warn('[arc-ticket-multicall] falling back to canonical scan', error.message);
      return readOwnedTicketsLegacy(address);
    })
    .then((state) => {
      arcOwnedTicketsCache.set(key, { state, cachedAt: Date.now() });
      return state;
    })
    .finally(() => {
      arcOwnedTicketsRefreshPromises.delete(key);
    });

  arcOwnedTicketsRefreshPromises.set(key, refreshPromise);
  return refreshPromise;
}

async function readOwnedTickets(address) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const key = ethers.getAddress(address).toLowerCase();
  const cached = arcOwnedTicketsCache.get(key);
  if (cached && Date.now() - cached.cachedAt <= ARC_OWNED_TICKETS_CACHE_TTL_MS) {
    return cached.state;
  }

  return refreshOwnedTicketsCache(address);
}


async function readRefundAuthorizationState({
  poolAddress,
  ticketAddress,
  tokenId,
  roundId,
}) {
  if (
    !ethers.isAddress(poolAddress) ||
    !ethers.isAddress(ticketAddress) ||
    typeof tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(tokenId) ||
    !Number.isInteger(roundId) ||
    roundId <= 0
  ) {
    throw new Error('refund_request_invalid');
  }

  const normalizedPool = ethers.getAddress(poolAddress);
  const normalizedTicket = ethers.getAddress(ticketAddress);
  const topology = ARC_POOL_TOPOLOGY.find(
    (item) =>
      item.poolAddress.toLowerCase() === normalizedPool.toLowerCase() &&
      item.ticketAddress.toLowerCase() === normalizedTicket.toLowerCase(),
  );

  if (!topology) {
    throw new Error('refund_ticket_not_supported');
  }

  const provider = getProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const pool = new ethers.Contract(normalizedPool, POOL_ABI, provider);
  const ticket = new ethers.Contract(normalizedTicket, TICKET_ABI, provider);
  const parsedTokenId = BigInt(tokenId);

  let round;
  let metadata;
  let currentOwner;
  let refunded;
  let stakeAmount;
  let usdcAddress;

  try {
    [round, metadata, currentOwner, refunded, stakeAmount, usdcAddress] =
      await Promise.all([
        rpcRead(() => pool.getRound(roundId)),
        rpcRead(() => pool.getTicketMetadata(parsedTokenId)),
        rpcRead(() => ticket.ownerOf(parsedTokenId)),
        rpcRead(() => pool.refunded(parsedTokenId)),
        rpcRead(() => pool.STAKE_AMOUNT()),
        rpcRead(() => pool.USDC()),
      ]);
  } catch {
    throw new Error('refund_ticket_or_round_not_found');
  }

  const contractStatus = CONTRACT_STATUSES[Number(round.status)];
  if (!contractStatus) {
    throw new Error('extrema_round_status_invalid');
  }

  if (Number(metadata.roundId) !== roundId) {
    throw new Error('refund_ticket_round_mismatch');
  }

  if (Number(metadata.roundStatus) !== Number(round.status)) {
    throw new Error('refund_ticket_status_mismatch');
  }

  if (ethers.getAddress(usdcAddress) !== ethers.getAddress(ARC_TESTNET_USDC_ADDRESS)) {
    throw new Error('refund_pool_usdc_mismatch');
  }

  if (stakeAmount !== 1_000_000n) {
    throw new Error('refund_stake_amount_mismatch');
  }

  return {
    chainId: Number(network.chainId),
    asset: topology.asset,
    direction: topology.direction,
    cadence: topology.cadence,
    poolAddress: normalizedPool,
    ticketAddress: normalizedTicket,
    tokenId,
    roundId,
    roundStatus: contractStatus,
    currentOwner: ethers.getAddress(currentOwner),
    isRefunded: Boolean(refunded),
    amountRaw: stakeAmount.toString(),
    usdcAddress: ethers.getAddress(usdcAddress),
  };
}


async function readClaimAuthorizationState({
  poolAddress,
  ticketAddress,
  tokenId,
  roundId,
}) {
  if (
    !ethers.isAddress(poolAddress) ||
    !ethers.isAddress(ticketAddress) ||
    typeof tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(tokenId) ||
    !Number.isInteger(roundId) ||
    roundId <= 0
  ) {
    throw new Error('claim_request_invalid');
  }

  const normalizedPool = ethers.getAddress(poolAddress);
  const normalizedTicket = ethers.getAddress(ticketAddress);
  const topology = ARC_POOL_TOPOLOGY.find(
    (item) =>
      item.poolAddress.toLowerCase() === normalizedPool.toLowerCase() &&
      item.ticketAddress.toLowerCase() === normalizedTicket.toLowerCase(),
  );

  if (!topology) {
    throw new Error('claim_ticket_not_supported');
  }

  const provider = getProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const pool = new ethers.Contract(normalizedPool, POOL_ABI, provider);
  const ticket = new ethers.Contract(normalizedTicket, TICKET_ABI, provider);
  const parsedTokenId = BigInt(tokenId);

  let round;
  let metadata;
  let currentOwner;
  let claimed;
  let claimable;
  let usdcAddress;

  try {
    [round, metadata, currentOwner, claimed, claimable, usdcAddress] =
      await Promise.all([
        rpcRead(() => pool.getRound(roundId)),
        rpcRead(() => pool.getTicketMetadata(parsedTokenId)),
        rpcRead(() => ticket.ownerOf(parsedTokenId)),
        rpcRead(() => pool.claimed(parsedTokenId)),
        rpcRead(() => pool.claimableByTicket(parsedTokenId)),
        rpcRead(() => pool.USDC()),
      ]);
  } catch {
    throw new Error('claim_ticket_or_round_not_found');
  }

  const contractStatus = CONTRACT_STATUSES[Number(round.status)];
  if (!contractStatus) {
    throw new Error('extrema_round_status_invalid');
  }

  if (Number(metadata.roundId) !== roundId) {
    throw new Error('claim_ticket_round_mismatch');
  }

  if (Number(metadata.roundStatus) !== Number(round.status)) {
    throw new Error('claim_ticket_status_mismatch');
  }

  if (Boolean(metadata.isClaimed) !== Boolean(claimed)) {
    throw new Error('claim_ticket_claimed_state_mismatch');
  }

  if (ethers.getAddress(usdcAddress) !== ethers.getAddress(ARC_TESTNET_USDC_ADDRESS)) {
    throw new Error('claim_pool_usdc_mismatch');
  }

  return {
    chainId: Number(network.chainId),
    asset: topology.asset,
    direction: topology.direction,
    cadence: topology.cadence,
    poolAddress: normalizedPool,
    ticketAddress: normalizedTicket,
    tokenId,
    roundId,
    roundStatus: contractStatus,
    currentOwner: ethers.getAddress(currentOwner),
    placement: Number(metadata.placement),
    isClaimed: Boolean(claimed),
    claimableRaw: claimable.toString(),
    usdcAddress: ethers.getAddress(usdcAddress),
  };
}


async function readRoundResult({ slug, roundId }) {
  if (
    typeof slug !== 'string' ||
    !Number.isInteger(roundId) ||
    roundId <= 0
  ) {
    throw new Error('round_result_request_invalid');
  }

  const topology = ARC_POOL_TOPOLOGY.find(
    (item) => slugify(item.asset, item.cadence, item.direction) === slug,
  );
  if (!topology) throw new Error('round_result_not_supported');

  const provider = getProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const poolAddress = ethers.getAddress(topology.poolAddress);
  const ticketAddress = ethers.getAddress(topology.ticketAddress);
  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const ticket = new ethers.Contract(ticketAddress, TICKET_ABI, provider);

  let round;
  try {
    round = await rpcRead(() => pool.getRound(roundId));
  } catch {
    throw new Error('round_result_not_found');
  }

  if (Number(round.entryOpenAt) === 0) {
    throw new Error('round_result_not_found');
  }

  const contractStatus = CONTRACT_STATUSES[Number(round.status)];
  if (!contractStatus) throw new Error('extrema_round_status_invalid');

  const resolvedPriceCents = BigInt(round.resolvedPriceCents);
  const winnerTicketIds = Array.from(round.winnerTicketIds, (id) => BigInt(id));

  const winners = [];
  if (contractStatus === 'SETTLED') {
    for (let index = 0; index < winnerTicketIds.length; index += 1) {
      const tokenId = winnerTicketIds[index];
      if (tokenId === 0n) continue;

      const [entry, currentOwner, claimableRaw, metadata] = await Promise.all([
        rpcRead(() => pool.entries(tokenId)),
        rpcRead(() => ticket.ownerOf(tokenId)),
        rpcRead(() => pool.claimableByTicket(tokenId)),
        rpcRead(() => pool.getTicketMetadata(tokenId)),
      ]);

      if (Number(entry.roundId) !== roundId || Number(metadata.roundId) !== roundId) {
        throw new Error('round_result_winner_round_mismatch');
      }

      const predictionPriceCents = BigInt(entry.predictionPriceCents);
      const distanceCents =
        predictionPriceCents >= resolvedPriceCents
          ? predictionPriceCents - resolvedPriceCents
          : resolvedPriceCents - predictionPriceCents;

      winners.push({
        rank: index + 1,
        tokenId: tokenId.toString(),
        currentOwner: ethers.getAddress(currentOwner),
        originalEntrant: ethers.getAddress(entry.originalEntrant),
        predictionPriceCents: predictionPriceCents.toString(),
        predictionPrice: (Number(predictionPriceCents) / 100).toFixed(2),
        distanceCents: distanceCents.toString(),
        distance: (Number(distanceCents) / 100).toFixed(2),
        entrySequence: Number(entry.entrySequence),
        placement: Number(metadata.placement),
        isClaimed: Boolean(metadata.isClaimed),
        claimableRaw: claimableRaw.toString(),
        claimableUsdc: ethers.formatUnits(claimableRaw, 6),
      });
    }
  }

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      explorerUrl: 'https://testnet.arcscan.app',
    },
    pool: {
      slug,
      poolAddress,
      ticketAddress,
      asset: topology.asset,
      direction: topology.direction,
      cadence: topology.cadence,
      source: 'Binance USDⓈ-M Futures Mark Price',
      sourceSymbol: SOURCE_SYMBOLS[topology.asset],
    },
    round: {
      roundId,
      contractStatus,
      entryOpenAt: toIso(round.entryOpenAt),
      entryCloseAt: toIso(round.entryCloseAt),
      observationStartAt: toIso(round.observationStartAt),
      observationEndAt: toIso(round.observationEndAt),
      entryCount: Number(round.entryCount),
      totalStakeRaw: round.totalStake.toString(),
      totalStakeUsdc: ethers.formatUnits(round.totalStake, 6),
      escrowRemainingRaw: round.escrowRemaining.toString(),
      escrowRemainingUsdc: ethers.formatUnits(round.escrowRemaining, 6),
      resolvedPriceCents: resolvedPriceCents.toString(),
      resolvedPrice:
        resolvedPriceCents > 0n
          ? (Number(resolvedPriceCents) / 100).toFixed(2)
          : null,
      winnerTicketIds: winnerTicketIds.map((id) => id.toString()),
    },
    winners,
  };
}


async function readRoundArchive({ days = 90 } = {}) {
  if (!Number.isInteger(days) || days <= 0 || days > 90) {
    throw new Error('archive_days_invalid');
  }

  const provider = getProvider();
  const [network, latestBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock('latest'),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }
  if (!latestBlock) throw new Error('arc_latest_block_unavailable');

  const now = Number(latestBlock.timestamp);
  const cutoff = now - Math.min(days * 24 * 60 * 60, ARCHIVE_RETENTION_SECONDS);
  const rounds = [];

  await mapWithConcurrency(ARC_POOL_TOPOLOGY, 4, async (topology) => {
    const poolAddress = ethers.getAddress(topology.poolAddress);
    const ticketAddress = ethers.getAddress(topology.ticketAddress);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const ticket = new ethers.Contract(ticketAddress, TICKET_ABI, provider);

    const nextRoundId = await rpcRead(() => pool.nextRoundId());
    if (nextRoundId <= 1n) return;

    for (let roundId = nextRoundId - 1n; roundId >= 1n; roundId -= 1n) {
      const round = await rpcRead(() => pool.getRound(roundId));
      const entryCloseAt = Number(round.entryCloseAt);

      if (entryCloseAt === 0) continue;
      if (entryCloseAt > now) continue;
      if (entryCloseAt < cutoff) break;

      const contractStatus = CONTRACT_STATUSES[Number(round.status)];
      if (!contractStatus) throw new Error('extrema_round_status_invalid');

      const totalStake = BigInt(round.totalStake);
      const rewardRawByRank = [
        (totalStake * 5400n) / 10000n,
        (totalStake * 2250n) / 10000n,
        (totalStake * 1350n) / 10000n,
      ];

      const winnerIds = Array.from(round.winnerTicketIds, (id) => BigInt(id));
      const winners = [];

      if (contractStatus === 'SETTLED') {
        for (let index = 0; index < winnerIds.length; index += 1) {
          const tokenId = winnerIds[index];
          if (tokenId === 0n) continue;

          const [entry, currentOwner, claimed] = await Promise.all([
            rpcRead(() => pool.entries(tokenId)),
            rpcRead(() => ticket.ownerOf(tokenId)),
            rpcRead(() => pool.claimed(tokenId)),
          ]);

          winners.push({
            rank: index + 1,
            tokenId: tokenId.toString(),
            currentOwner: ethers.getAddress(currentOwner),
            predictionPriceCents: entry.predictionPriceCents.toString(),
            predictionPrice: (Number(entry.predictionPriceCents) / 100).toFixed(2),
            rewardRaw: rewardRawByRank[index].toString(),
            rewardUsdc: ethers.formatUnits(rewardRawByRank[index], 6),
            claimed: Boolean(claimed),
          });
        }
      }

      rounds.push({
        slug: slugify(topology.asset, topology.cadence, topology.direction),
        poolAddress,
        ticketAddress,
        asset: topology.asset,
        direction: topology.direction,
        cadence: topology.cadence,
        roundId: Number(roundId),
        contractStatus,
        entryCloseAt: toIso(round.entryCloseAt),
        observationEndAt: toIso(round.observationEndAt),
        resolvedPriceCents: round.resolvedPriceCents.toString(),
        resolvedPrice:
          BigInt(round.resolvedPriceCents) > 0n
            ? (Number(round.resolvedPriceCents) / 100).toFixed(2)
            : null,
        entryCount: Number(round.entryCount),
        totalStakeRaw: round.totalStake.toString(),
        totalStakeUsdc: ethers.formatUnits(round.totalStake, 6),
        winners,
      });

      if (roundId === 1n) break;
    }
  });

  rounds.sort((left, right) => {
    const closeDiff =
      new Date(right.entryCloseAt).getTime() - new Date(left.entryCloseAt).getTime();
    if (closeDiff !== 0) return closeDiff;
    if (left.asset !== right.asset) return left.asset.localeCompare(right.asset);
    if (left.cadence !== right.cadence) return left.cadence.localeCompare(right.cadence);
    return left.direction.localeCompare(right.direction);
  });

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      blockNumber: latestBlock.number,
      timestamp: now,
      timestampIso: toIso(now),
      explorerUrl: 'https://testnet.arcscan.app',
    },
    retentionDays: days,
    rounds,
  };
}

const STANDARD_ROUNDS_CACHE_TTL_MS = 15_000;
let standardRoundsCache = null;
let standardRoundsCacheAt = 0;
let standardRoundsRefreshPromise = null;

async function refreshStandardRoundsCache() {
  if (standardRoundsRefreshPromise) return standardRoundsRefreshPromise;

  standardRoundsRefreshPromise = readStandardRounds()
    .then((state) => {
      standardRoundsCache = state;
      standardRoundsCacheAt = Date.now();
      return state;
    })
    .finally(() => {
      standardRoundsRefreshPromise = null;
    });

  return standardRoundsRefreshPromise;
}

async function getStandardRoundsState({ forceFresh = false } = {}) {
  const ageMs = Date.now() - standardRoundsCacheAt;

  if (!forceFresh && standardRoundsCache) {
    if (ageMs > STANDARD_ROUNDS_CACHE_TTL_MS && !standardRoundsRefreshPromise) {
      refreshStandardRoundsCache().catch((error) => {
        console.error('[arc-round-cache] background refresh failed', error.message);
      });
    }
    return standardRoundsCache;
  }

  return refreshStandardRoundsCache();
}

function warmStandardRoundsCache() {
  refreshStandardRoundsCache().catch((error) => {
    console.error('[arc-round-cache] warmup failed', error.message);
  });
}

module.exports = {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  getArcProvider: getProvider,
  readArcWalletState,
  getArcWalletState,
  invalidateArcWalletStateCache,
  readOwnedTickets,
  readClaimAuthorizationState,
  readRefundAuthorizationState,
  readRoundResult,
  readRoundArchive,
  readStandardRounds,
  getStandardRoundsState,
  refreshStandardRoundsCache,
  warmStandardRoundsCache,
};
