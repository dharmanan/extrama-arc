import type { LivePool } from "./backend-api";

type LivePriceSource = "Binance" | "CoinGecko";

export type BinanceLiveMarketResponse = {
  region: string;
  refreshIntervalSeconds: 60;
  refreshedAtIso: string;
  prices: Record<string, {
    available: true;
    markPrice: string;
    sourceTimeIso: string;
    source: LivePriceSource;
  }>;
  missing?: string[];
};

export async function readBinanceLiveMarket(): Promise<BinanceLiveMarketResponse> {
  const response = await fetch("/api/live-market", {
    cache: "no-store",
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string" ? body.error : `live_market_http_${response.status}`,
    );
  }

  return body as BinanceLiveMarketResponse;
}

export function applyBinanceLiveMarket(
  pools: LivePool[],
  live: BinanceLiveMarketResponse,
): LivePool[] {
  return pools.map((pool) => {
    const price = live.prices[pool.sourceSymbol];

    if (!price) {
      return {
        ...pool,
        market: {
          available: false,
          markPrice: null,
          sourceTimeIso: null,
          refreshedAtIso: live.refreshedAtIso,
          refreshIntervalSeconds: 60,
          source: null,
          isSettlementSource: false,
        },
      };
    }

    return {
      ...pool,
      market: {
        available: true,
        markPrice: price.markPrice,
        sourceTimeIso: price.sourceTimeIso,
        refreshedAtIso: live.refreshedAtIso,
        refreshIntervalSeconds: 60,
        source: price.source,
        isSettlementSource: price.source === "Binance",
      },
    };
  });
}

export function applyBinanceLiveMarketToPool(
  pool: LivePool,
  live: BinanceLiveMarketResponse,
): LivePool {
  return applyBinanceLiveMarket([pool], live)[0];
}
