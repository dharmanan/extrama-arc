export type Asset = "BTC" | "ETH" | "SOL" | "HYPE";
export type Cadence = "Daily" | "Weekly" | "Quarterly";

export const assets: Record<Asset, { symbol: string; color: string; price: string }> = {
  BTC: { symbol: "₿", color: "#f69b38", price: "$73,421" },
  ETH: { symbol: "♦", color: "#8672ff", price: "$4,210" },
  SOL: { symbol: "≋", color: "#27cbb3", price: "$186" },
  HYPE: { symbol: "H", color: "#3dbb9c", price: "$42.8" }
};

export const pools = [
  { asset: "BTC", cadence: "Weekly", direction: "High", players: 342, pool: "342 USDC", price: "$73,421", closes: "3d 12h", trend: "up" },
  { asset: "ETH", cadence: "Weekly", direction: "Low", players: 521, pool: "521 USDC", price: "$4,210", closes: "3d 12h", trend: "down" },
  { asset: "SOL", cadence: "Weekly", direction: "High", players: 284, pool: "284 USDC", price: "$186", closes: "3d 12h", trend: "up" },
  { asset: "HYPE", cadence: "Weekly", direction: "High", players: 198, pool: "198 USDC", price: "$42.8", closes: "3d 12h", trend: "up" },
  { asset: "BTC", cadence: "Weekly", direction: "Low", players: 298, pool: "298 USDC", price: "$52,901", closes: "3d 12h", trend: "down" },
  { asset: "ETH", cadence: "Weekly", direction: "High", players: 487, pool: "487 USDC", price: "$3,142", closes: "3d 12h", trend: "down" },
  { asset: "SOL", cadence: "Weekly", direction: "Low", players: 276, pool: "276 USDC", price: "$121", closes: "3d 12h", trend: "down" },
  { asset: "HYPE", cadence: "Weekly", direction: "Low", players: 163, pool: "163 USDC", price: "$28.4", closes: "3d 12h", trend: "down" }
] as const;

export const ethRound = {
  title: "ETH · Weekly Low", number: "#184", current: "$2,186.42", prediction: "$2,085.00",
  official: "$2,086.43", period: "Oct 6 – Oct 12, 2025", source: "Binance Futures (ETHUSDT Mark Price)",
  players: "1,932", pool: "1,932 USDC", low: "$1,860.00", high: "$2,420.00"
};

export const distribution = [2, 4, 7, 14, 22, 35, 48, 64, 82, 102, 127, 148, 165, 182, 202, 221, 244, 271, 303, 330, 298, 261, 224, 183, 145, 109, 79, 54, 35, 21, 13, 7, 4, 2];
