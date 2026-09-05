export const runtime = "edge";
export const preferredRegion = "hkg1";
export const dynamic = "force-dynamic";

const endpoints = [
  "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=ETHUSDT",
  "https://fapi.binance.com/fapi/v1/markPriceKlines?symbol=ETHUSDT&interval=1m&limit=1",
];

export async function GET() {
  const results = [];

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          "user-agent": "EXTREMA-Binance-Probe/0.1",
        },
      });
      const body = await response.text();
      results.push({
        url,
        status: response.status,
        ok: response.ok,
        bodyPreview: body.slice(0, 240),
      });
    } catch (error) {
      results.push({
        url,
        status: null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Response.json({
    vercelRegion: process.env.VERCEL_REGION || "unknown",
    intendedRegion: "hkg1",
    results,
  });
}
