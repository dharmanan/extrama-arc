import type { AssetConfig, Pool, Result, Ticket } from "./domain";

export const assetConfigs: Record<string, AssetConfig> = {
  BTC: { symbol: "BTC", name: "Bitcoin", price: 73421, sourceSymbol: "BTCUSDT", brandSrc: "/brands/bitcoin.svg" },
  ETH: { symbol: "ETH", name: "Ethereum", price: 4210, sourceSymbol: "ETHUSDT", brandSrc: "/brands/ethereum.png" },
  SOL: { symbol: "SOL", name: "Solana", price: 186, sourceSymbol: "SOLUSDT", brandSrc: "/brands/solana.svg" },
  HYPE: { symbol: "HYPE", name: "Hyperliquid", price: 42.8, sourceSymbol: "HYPEUSDT", brandSrc: "/brands/hyperliquid.svg" },
};

const assets = ["BTC", "ETH", "SOL", "HYPE"] as const;
const directions = ["High", "Low"] as const;
const cadences = ["Daily", "Weekly", "Quarterly"] as const;

const basePrice: Record<(typeof assets)[number], number> = {
  BTC: 73421,
  ETH: 4210,
  SOL: 186,
  HYPE: 42.8,
};

function slugify(asset: string, cadence: string, direction: string) {
  return `${asset.toLowerCase()}-${cadence.toLowerCase()}-${direction.toLowerCase()}`;
}

export const pools: Pool[] = cadences.flatMap((cadence, cadenceIndex) =>
  assets.flatMap((asset, assetIndex) =>
    directions.map((direction, directionIndex) => {
      const roundId = 160 + cadenceIndex * 8 + assetIndex * 2 + directionIndex;
      const isLiveDemoRound = cadence === "Weekly" && asset === "ETH" && direction === "Low";
      const referencePrice = basePrice[asset];
      const multiplier = cadenceIndex === 0 ? 0.03 : cadenceIndex === 1 ? 0.08 : 0.2;
      const spread = referencePrice * multiplier;
      const nowBase = cadence === "Daily" ? "2026-09-05" : cadence === "Weekly" ? "2026-09-07" : "2026-10-01";
      const endBase = cadence === "Daily" ? "2026-09-05T23:59:59Z" : cadence === "Weekly" ? "2026-09-13T23:59:59Z" : "2026-12-31T23:59:59Z";

      return {
        id: `round-${roundId}`,
        roundId,
        slug: slugify(asset, cadence, direction),
        asset,
        cadence,
        direction,
        status: isLiveDemoRound ? "LIVE" : "ENTRY_OPEN",
        referencePrice,
        players: 160 + cadenceIndex * 120 + assetIndex * 61 + directionIndex * 37,
        poolSizeUsdc: 160 + cadenceIndex * 120 + assetIndex * 61 + directionIndex * 37,
        entryFeeUsdc: 1,
        entryCloseAt: `${nowBase}T00:00:00Z`,
        observationStartAt: `${nowBase}T00:00:00Z`,
        observationEndAt: endBase,
        source: "Binance USDⓈ-M Futures Mark Price",
        sourceSymbol: assetConfigs[asset].sourceSymbol,
        predictionMin: Number((referencePrice - spread).toFixed(2)),
        predictionMax: Number((referencePrice + spread).toFixed(2)),
      };
    })
  )
);

export const results: Result[] = [
  {
    roundId: 184,
    poolSlug: "eth-weekly-low",
    asset: "ETH",
    cadence: "Weekly",
    direction: "Low",
    observationStartAt: "2026-09-07T00:00:00Z",
    observationEndAt: "2026-09-13T23:59:59Z",
    resolvedPrice: 2086.43,
    resolvedAt: "2026-09-13T00:03:21Z",
    evidenceHash: "0x7d219f4eab87c3384d91bdaea3a90b1d7f1a91ce0c6b10d38dd35e55a2a9a184",
    source: "Binance USDⓈ-M Futures Mark Price",
    sourceSymbol: "ETHUSDT",
    interval: "15m",
    winners: [
      { rank: 1, wallet: "0x3aF...92E1", prediction: 2085, distance: 1.43, rewardUsdc: 5400, sharePercent: 54, ticketId: 1842 },
      { rank: 2, wallet: "0x9cD...8A21", prediction: 2090, distance: 3.57, rewardUsdc: 2250, sharePercent: 22.5, ticketId: 1921 },
      { rank: 3, wallet: "0x4ef...7D2c", prediction: 2078, distance: 8.43, rewardUsdc: 1350, sharePercent: 13.5, ticketId: 1902 },
    ],
  },
  {
    roundId: 128,
    poolSlug: "btc-daily-high",
    asset: "BTC",
    cadence: "Daily",
    direction: "High",
    observationStartAt: "2026-08-28T00:00:00Z",
    observationEndAt: "2026-08-28T23:59:59Z",
    resolvedPrice: 73410.25,
    resolvedAt: "2026-08-29T00:02:11Z",
    evidenceHash: "0x1280000000000000000000000000000000000000000000000000000000000128",
    source: "Binance USDⓈ-M Futures Mark Price",
    sourceSymbol: "BTCUSDT",
    interval: "1m",
    winners: [
      { rank: 1, wallet: "0xabc...0128", prediction: 73401, distance: 9.25, rewardUsdc: 216, sharePercent: 54, ticketId: 1281 },
      { rank: 2, wallet: "0xabc...0129", prediction: 73420, distance: 9.75, rewardUsdc: 90, sharePercent: 22.5, ticketId: 1282 },
      { rank: 3, wallet: "0xabc...0130", prediction: 73390, distance: 20.25, rewardUsdc: 54, sharePercent: 13.5, ticketId: 1283 },
    ],
  },
  {
    roundId: 96,
    poolSlug: "sol-weekly-high",
    asset: "SOL",
    cadence: "Weekly",
    direction: "High",
    observationStartAt: "2026-08-17T00:00:00Z",
    observationEndAt: "2026-08-23T23:59:59Z",
    resolvedPrice: 243.18,
    resolvedAt: "2026-08-24T00:04:31Z",
    evidenceHash: "0x9600000000000000000000000000000000000000000000000000000000000096",
    source: "Binance USDⓈ-M Futures Mark Price",
    sourceSymbol: "SOLUSDT",
    interval: "15m",
    winners: [
      { rank: 1, wallet: "0x3aF...92E1", prediction: 243.2, distance: 0.02, rewardUsdc: 540, sharePercent: 54, ticketId: 961 },
      { rank: 2, wallet: "0xdef...0962", prediction: 243.1, distance: 0.08, rewardUsdc: 225, sharePercent: 22.5, ticketId: 962 },
      { rank: 3, wallet: "0xdef...0963", prediction: 243.3, distance: 0.12, rewardUsdc: 135, sharePercent: 13.5, ticketId: 963 },
    ],
  },
];

export const tickets: Ticket[] = [
  { tokenId: 1842, roundId: 184, poolSlug: "eth-weekly-low", asset: "ETH", cadence: "Weekly", direction: "Low", prediction: 2085, entryUsdc: 1, status: "Winner #1", claimableUsdc: 5400 },
  { tokenId: 1281, roundId: 128, poolSlug: "btc-daily-high", asset: "BTC", cadence: "Daily", direction: "High", prediction: 73401, entryUsdc: 1, status: "Settled", claimableUsdc: 0 },
  { tokenId: 961, roundId: 96, poolSlug: "sol-weekly-high", asset: "SOL", cadence: "Weekly", direction: "High", prediction: 243.2, entryUsdc: 1, status: "Claimed", claimableUsdc: 0 },
];

export function getPoolBySlug(slug: string) {
  return pools.find((pool) => pool.slug === slug);
}

export function getResultByRoundId(roundId: number) {
  return results.find((result) => result.roundId === roundId);
}

export function getTicketsForWallet() {
  return tickets;
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 100 ? 2 : 0 }).format(value);
}
