export type Asset = "BTC" | "ETH" | "SOL" | "HYPE";
export type Cadence = "Daily" | "Weekly" | "Quarterly";
export type Direction = "High" | "Low";
export type RoundStatus = "ENTRY_OPEN" | "LIVE" | "RESOLVABLE" | "SETTLED" | "CANCELLED";
export type TicketStatus = "Live" | "Settled" | "Winner #1" | "Winner #2" | "Winner #3" | "Claimed";
export type WalletMode = "extrema" | "external";
export type WalletStatus = "disconnected" | "ready";

export type AssetConfig = {
  symbol: Asset;
  name: string;
  price: number;
  sourceSymbol: string;
  brandSrc: string;
};

export type Pool = {
  id: string;
  roundId: number;
  slug: string;
  asset: Asset;
  cadence: Cadence;
  direction: Direction;
  status: RoundStatus;
  referencePrice: number;
  players: number;
  poolSizeUsdc: number;
  entryFeeUsdc: 1;
  entryCloseAt: string;
  observationStartAt: string;
  observationEndAt: string;
  source: string;
  sourceSymbol: string;
  predictionMin: number;
  predictionMax: number;
};

export type Winner = {
  rank: 1 | 2 | 3;
  wallet: string;
  prediction: number;
  distance: number;
  rewardUsdc: number;
  sharePercent: number;
  ticketId: number;
};

export type Result = {
  roundId: number;
  poolSlug: string;
  asset: Asset;
  cadence: Cadence;
  direction: Direction;
  observationStartAt: string;
  observationEndAt: string;
  resolvedPrice: number;
  resolvedAt: string;
  evidenceHash: string;
  source: string;
  sourceSymbol: string;
  interval: string;
  winners: Winner[];
};

export type Ticket = {
  tokenId: number;
  roundId: number;
  owner: string;
  poolSlug: string;
  asset: Asset;
  cadence: Cadence;
  direction: Direction;
  prediction: number;
  entryUsdc: 1;
  status: TicketStatus;
  claimableUsdc: number;
  enteredAt?: string;
};

export type PredictionEntry = {
  ticketId: number;
  roundId: number;
  poolSlug: string;
  wallet: string;
  prediction: number;
  enteredAt: string;
};

export type DemoWallet = {
  status: WalletStatus;
  mode: WalletMode | null;
  address: string | null;
  balanceUsdc: number;
};

export type EnterPredictionResult =
  | { ok: true; ticketId: number; message: string }
  | { ok: false; message: string };

export type ClaimResult =
  | { ok: true; amountUsdc: number; message: string }
  | { ok: false; message: string };
