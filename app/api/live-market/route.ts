export const runtime = "edge";
export const preferredRegion = "hkg1";
export const dynamic = "force-dynamic";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT"] as const;
type SymbolName = (typeof SYMBOLS)[number];

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

async function readAllSymbols() {
  const response = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex", {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "user-agent": "EXTREMA-Live-Market/0.2",
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

  const prices: Record<string, {
    available: true;
    markPrice: string;
    sourceTimeIso: string;
    source: "Binance";
  }> = {};

  for (const symbol of SYMBOLS) {
    const item = bySymbol.get(symbol);
    if (!item || !validPrice(item.markPrice) || !validTime(item.time)) {
      throw new Error(`binance_symbol_invalid_${symbol}`);
    }

    prices[symbol] = {
      available: true,
      markPrice: item.markPrice,
      sourceTimeIso: new Date(item.time).toISOString(),
      source: "Binance",
    };
  }

  return prices;
}

async function readPerSymbol() {
  const entries = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      const response = await fetch(
        `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
        {
          cache: "no-store",
          headers: {
            accept: "application/json",
            "user-agent": "EXTREMA-Live-Market/0.2",
          },
        },
      );

      if (!response.ok) throw new Error(`binance_${symbol}_http_${response.status}`);
      const item = (await response.json()) as BinancePremiumIndex;

      if (item.symbol !== symbol || !validPrice(item.markPrice) || !validTime(item.time)) {
        throw new Error(`binance_symbol_invalid_${symbol}`);
      }

      return [
        symbol,
        {
          available: true as const,
          markPrice: item.markPrice,
          sourceTimeIso: new Date(item.time).toISOString(),
          source: "Binance" as const,
        },
      ] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<SymbolName, {
    available: true;
    markPrice: string;
    sourceTimeIso: string;
    source: "Binance";
  }>;
}

export async function GET() {
  try {
    let prices;
    try {
      prices = await readAllSymbols();
    } catch {
      prices = await readPerSymbol();
    }

    const refreshedAtIso = new Date().toISOString();

    return Response.json(
      {
        source: "Binance",
        sourceDetail: "Binance USDⓈ-M Futures Mark Price",
        region: process.env.VERCEL_REGION || "hkg1",
        refreshIntervalSeconds: 60,
        refreshedAtIso,
        prices,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=55, stale-while-revalidate=30",
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error: "binance_live_market_unavailable",
        detail: error instanceof Error ? error.message : String(error),
        region: process.env.VERCEL_REGION || "hkg1",
      },
      { status: 503 },
    );
  }
}
