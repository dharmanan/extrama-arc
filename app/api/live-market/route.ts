export const runtime = "edge";
export const preferredRegion = "hkg1";
export const dynamic = "force-dynamic";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT"] as const;
type SymbolName = (typeof SYMBOLS)[number];
type PriceSource = "Binance" | "CoinGecko";

const COINGECKO_IDS: Record<SymbolName, string> = {
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  SOLUSDT: "solana",
  HYPEUSDT: "hyperliquid",
};

type LivePrice = {
  available: true;
  markPrice: string;
  sourceTimeIso: string;
  source: PriceSource;
};

type BinancePremiumIndex = {
  symbol?: string;
  markPrice?: string;
  time?: number;
};

function validPrice(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number(value) > 0;
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function readBinanceAll(): Promise<Partial<Record<SymbolName, LivePrice>>> {
  const response = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex", {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "user-agent": "EXTREMA-Live-Market/0.3",
    },
  });

  if (!response.ok) {
    throw new Error(`binance_http_${response.status}`);
  }

  const payload = (await response.json()) as BinancePremiumIndex[];
  if (!Array.isArray(payload)) throw new Error("binance_payload_invalid");

  const bySymbol = new Map(
    payload
      .filter((item) => typeof item?.symbol === "string")
      .map((item) => [item.symbol as string, item]),
  );

  const prices: Partial<Record<SymbolName, LivePrice>> = {};

  for (const symbol of SYMBOLS) {
    const item = bySymbol.get(symbol);
    if (!item || !validPrice(item.markPrice) || !validTime(item.time)) continue;

    prices[symbol] = {
      available: true,
      markPrice: item.markPrice,
      sourceTimeIso: new Date(item.time).toISOString(),
      source: "Binance",
    };
  }

  return prices;
}

async function readBinanceSymbol(symbol: SymbolName): Promise<LivePrice | null> {
  try {
    const response = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
      {
        cache: "no-store",
        headers: {
          accept: "application/json",
          "user-agent": "EXTREMA-Live-Market/0.3",
        },
      },
    );

    if (!response.ok) return null;

    const item = (await response.json()) as BinancePremiumIndex;
    if (item.symbol !== symbol || !validPrice(item.markPrice) || !validTime(item.time)) {
      return null;
    }

    return {
      available: true,
      markPrice: item.markPrice,
      sourceTimeIso: new Date(item.time).toISOString(),
      source: "Binance",
    };
  } catch {
    return null;
  }
}

async function readCoinGecko(
  symbols: SymbolName[],
): Promise<Partial<Record<SymbolName, LivePrice>>> {
  if (symbols.length === 0) return {};

  const ids = symbols.map((symbol) => COINGECKO_IDS[symbol]);
  const query = new URLSearchParams({
    ids: ids.join(","),
    vs_currencies: "usd",
    include_last_updated_at: "true",
    precision: "full",
  });

  const response = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?${query.toString()}`,
    {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": "EXTREMA-Live-Market/0.3",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`coingecko_http_${response.status}`);
  }

  const payload = (await response.json()) as Record<
    string,
    { usd?: number; last_updated_at?: number }
  >;

  const prices: Partial<Record<SymbolName, LivePrice>> = {};

  for (const symbol of symbols) {
    const item = payload[COINGECKO_IDS[symbol]];
    const usd = item?.usd;
    const updated = item?.last_updated_at;

    if (
      typeof usd !== "number" ||
      !Number.isFinite(usd) ||
      usd <= 0 ||
      typeof updated !== "number" ||
      !Number.isSafeInteger(updated) ||
      updated <= 0
    ) {
      continue;
    }

    prices[symbol] = {
      available: true,
      markPrice: String(usd),
      sourceTimeIso: new Date(updated * 1000).toISOString(),
      source: "CoinGecko",
    };
  }

  return prices;
}

export async function GET() {
  const prices: Partial<Record<SymbolName, LivePrice>> = {};

  try {
    Object.assign(prices, await readBinanceAll());
  } catch {
    // Per-symbol Binance retry below.
  }

  const missingAfterBulk = SYMBOLS.filter((symbol) => !prices[symbol]);

  if (missingAfterBulk.length > 0) {
    const retries = await Promise.all(
      missingAfterBulk.map(async (symbol) => [symbol, await readBinanceSymbol(symbol)] as const),
    );
    for (const [symbol, price] of retries) {
      if (price) prices[symbol] = price;
    }
  }

  const missingAfterBinance = SYMBOLS.filter((symbol) => !prices[symbol]);

  if (missingAfterBinance.length > 0) {
    try {
      Object.assign(prices, await readCoinGecko(missingAfterBinance));
    } catch {
      // Unavailable symbols remain absent and are surfaced as unavailable.
    }
  }

  const missing = SYMBOLS.filter((symbol) => !prices[symbol]);
  const refreshedAtIso = new Date().toISOString();

  if (missing.length === SYMBOLS.length) {
    return Response.json(
      {
        error: "live_market_unavailable",
        region: process.env.VERCEL_REGION || "hkg1",
      },
      { status: 503 },
    );
  }

  return Response.json(
    {
      region: process.env.VERCEL_REGION || "hkg1",
      refreshIntervalSeconds: 60,
      refreshedAtIso,
      prices,
      missing,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=55, stale-while-revalidate=30",
      },
    },
  );
}
