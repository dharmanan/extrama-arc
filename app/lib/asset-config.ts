import type { Asset } from "./domain";

export type AssetConfig = {
  symbol: Asset;
  name: string;
  sourceSymbol: string;
  brandSrc: string;
};

export const assetConfigs: Record<Asset, AssetConfig> = {
  BTC: { symbol: "BTC", name: "Bitcoin", sourceSymbol: "BTCUSDT", brandSrc: "/brands/bitcoin.svg" },
  ETH: { symbol: "ETH", name: "Ethereum", sourceSymbol: "ETHUSDT", brandSrc: "/brands/ethereum.png" },
  SOL: { symbol: "SOL", name: "Solana", sourceSymbol: "SOLUSDT", brandSrc: "/brands/solana.svg" },
  HYPE: { symbol: "HYPE", name: "Hyperliquid", sourceSymbol: "HYPEUSDT", brandSrc: "/brands/hyperliquid.svg" },
};
