import { NextRequest, NextResponse } from "next/server";

export const preferredRegion = "hkg1";

const COOKIE_NAME = "extrema_session";
// Must match backend/src/config.js's JWT_TTL_SECONDS default: seven days.
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

const BINANCE_MARK_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "HYPEUSDT"] as const;
type BinanceMarkSymbol = (typeof BINANCE_MARK_SYMBOLS)[number];

type LiveMarket = {
  available: boolean;
  markPrice: string | null;
  sourceTimeIso: string | null;
  refreshedAtIso: string;
  refreshIntervalSeconds: 60;
  source: string | null;
  isSettlementSource: boolean;
};

async function readBinanceLiveMarks(): Promise<Record<BinanceMarkSymbol, LiveMarket>> {
  const refreshedAtIso = new Date().toISOString();

  const entries = await Promise.all(
    BINANCE_MARK_SYMBOLS.map(async (symbol) => {
      try {
        const url =
          `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`;
        const response = await fetch(url, {
          next: { revalidate: 60 },
          headers: {
            accept: "application/json",
            "user-agent": "EXTREMA-Vercel-Market/0.1",
          },
        });

        if (!response.ok) {
          throw new Error(`binance_http_${response.status}`);
        }

        const payload = (await response.json()) as {
          symbol?: string;
          markPrice?: string;
          time?: number;
        };

        if (
          payload.symbol !== symbol ||
          typeof payload.markPrice !== "string" ||
          !/^\d+(?:\.\d+)?$/.test(payload.markPrice) ||
          !Number.isSafeInteger(payload.time) ||
          Number(payload.time) <= 0
        ) {
          throw new Error("binance_payload_invalid");
        }

        const market: LiveMarket = {
          available: true,
          markPrice: payload.markPrice,
          sourceTimeIso: new Date(Number(payload.time)).toISOString(),
          refreshedAtIso,
          refreshIntervalSeconds: 60,
          source: "Binance USDⓈ-M Futures Mark Price",
          isSettlementSource: true,
        };

        return [symbol, market] as const;
      } catch {
        const market: LiveMarket = {
          available: false,
          markPrice: null,
          sourceTimeIso: null,
          refreshedAtIso,
          refreshIntervalSeconds: 60,
          source: "Binance USDⓈ-M Futures Mark Price",
          isSettlementSource: true,
        };
        return [symbol, market] as const;
      }
    }),
  );

  return Object.fromEntries(entries) as Record<BinanceMarkSymbol, LiveMarket>;
}

function applyBinanceMarket(
  pool: Record<string, unknown>,
  marks: Record<BinanceMarkSymbol, LiveMarket>,
) {
  const symbol = pool.sourceSymbol;
  if (
    typeof symbol === "string" &&
    BINANCE_MARK_SYMBOLS.includes(symbol as BinanceMarkSymbol)
  ) {
    pool.market = marks[symbol as BinanceMarkSymbol];
  }
}

async function enrichRoundMarket(pathname: string, payload: Record<string, unknown>) {
  if (pathname !== "/rounds" && !/^\/rounds\/[^/]+$/.test(pathname)) {
    return payload;
  }

  const marks = await readBinanceLiveMarks();

  if (pathname === "/rounds" && Array.isArray(payload.pools)) {
    for (const item of payload.pools) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        applyBinanceMarket(item as Record<string, unknown>, marks);
      }
    }
    return payload;
  }

  if (
    payload.pool &&
    typeof payload.pool === "object" &&
    !Array.isArray(payload.pool)
  ) {
    applyBinanceMarket(payload.pool as Record<string, unknown>, marks);
  }

  return payload;
}


function backendBaseUrl() {
  return process.env.BACKEND_API_URL || "http://127.0.0.1:3001/api";
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const pathname = "/" + path.join("/");
  const target =
    backendBaseUrl().replace(/\/$/, "") +
    pathname +
    request.nextUrl.search;

  const headers = new Headers();
  headers.set("content-type", request.headers.get("content-type") || "application/json");
  headers.set(
    "x-extrema-origin",
    request.headers.get("x-extrema-browser-origin") ||
      request.headers.get("origin") ||
      request.nextUrl.origin,
  );

  const session = request.cookies.get(COOKIE_NAME)?.value;
  if (session) headers.set("authorization", `Bearer ${session}`);

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "backend_unreachable" },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  let payload: Record<string, unknown> = {};

  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { error: "invalid_backend_response" };
    }
  }

  if (upstream.ok) {
    payload = await enrichRoundMarket(pathname, payload);
  }

  const isAuthFinish =
    pathname === "/auth/register/finish" ||
    pathname === "/auth/login/finish" ||
    pathname === "/auth/wallet-login/finish" ||
    pathname === "/circle/session";

  let token: string | null = null;
  if (isAuthFinish && upstream.ok && typeof payload.token === "string") {
    token = payload.token;
    delete payload.token;
  }

  const response = NextResponse.json(payload, { status: upstream.status });

  if (token) {
    response.cookies.set({
      name: COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
  }

  if (pathname === "/auth/logout") {
    response.cookies.set({
      name: COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
  }

  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
