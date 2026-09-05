'use strict';

const crypto = require('crypto');

const BINANCE_USDM_BASE_URL = 'https://fapi.binance.com';
const MARK_PRICE_KLINES_PATH = '/fapi/v1/markPriceKlines';
const PREMIUM_INDEX_PATH = '/fapi/v1/premiumIndex';
const MAX_LIMIT = 1500;
const LIVE_MARK_CACHE_TTL_MS = 60_000;
const LIVE_MARK_BASE_URLS = Object.freeze([
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
  'https://fapi4.binance.com',
]);
const COINGECKO_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';
const COINGECKO_IDS = Object.freeze({
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  SOLUSDT: 'solana',
  HYPEUSDT: 'hyperliquid',
});

let liveMarkCache = null;
let liveMarkCacheAt = 0;
let liveMarkRefreshPromise = null;

const ALLOWED_SYMBOLS = new Set([
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'HYPEUSDT',
]);

const CADENCE_INTERVALS = Object.freeze({
  DAILY: { interval: '1m', intervalMs: 60_000 },
  WEEKLY: { interval: '15m', intervalMs: 15 * 60_000 },
  QUARTERLY: { interval: '4h', intervalMs: 4 * 60 * 60_000 },
});

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'EXTREMA-Market/0.2',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`http_${response.status}:${body.slice(0, 120)}`);
  }

  return response.json();
}

async function fetchPremiumIndexMark(baseUrl, symbol, fetchImpl) {
  const requestUrl =
    `${baseUrl}${PREMIUM_INDEX_PATH}?symbol=${encodeURIComponent(symbol)}`;
  const payload = await fetchJson(requestUrl, fetchImpl);

  if (!payload || payload.symbol !== symbol) {
    throw new Error('premium_index_response_invalid');
  }

  parsePositiveDecimal(payload.markPrice, 'mark_price');

  const sourceTime = Number(payload.time);
  if (!Number.isSafeInteger(sourceTime) || sourceTime <= 0) {
    throw new Error('premium_index_time_invalid');
  }

  return {
    symbol,
    markPriceRaw: payload.markPrice,
    markPrice: payload.markPrice,
    sourceTime,
    sourceTimeIso: new Date(sourceTime).toISOString(),
    endpoint: requestUrl,
    method: 'premiumIndex',
  };
}

async function fetchLatestMarkKline(baseUrl, symbol, fetchImpl) {
  const requestUrl =
    `${baseUrl}${MARK_PRICE_KLINES_PATH}?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=1`;
  const payload = await fetchJson(requestUrl, fetchImpl);

  if (!Array.isArray(payload) || payload.length !== 1 || !Array.isArray(payload[0])) {
    throw new Error('mark_kline_response_invalid');
  }

  const candle = payload[0];
  const markPrice = candle[4];
  const sourceTime = Number(candle[0]);
  parsePositiveDecimal(markPrice, 'mark_price');

  if (!Number.isSafeInteger(sourceTime) || sourceTime <= 0) {
    throw new Error('mark_kline_time_invalid');
  }

  return {
    symbol,
    markPriceRaw: markPrice,
    markPrice,
    sourceTime,
    sourceTimeIso: new Date(sourceTime).toISOString(),
    endpoint: requestUrl,
    method: 'markPriceKlines-1m',
  };
}

async function fetchCurrentMarkPrice(symbol, fetchImpl = globalThis.fetch) {
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    throw new Error('resolver_symbol_not_supported');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('resolver_fetch_unavailable');
  }

  const failures = [];

  for (const baseUrl of LIVE_MARK_BASE_URLS) {
    try {
      return await fetchPremiumIndexMark(baseUrl, symbol, fetchImpl);
    } catch (error) {
      failures.push(
        `${baseUrl}:premiumIndex:${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return await fetchLatestMarkKline(baseUrl, symbol, fetchImpl);
    } catch (error) {
      failures.push(
        `${baseUrl}:markPriceKlines:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(`market_source_unavailable:${failures.join('|').slice(0, 1000)}`);
}

async function fetchCoinGeckoFallback(symbols, fetchImpl = globalThis.fetch) {
  if (!Array.isArray(symbols) || symbols.length === 0) return {};

  const ids = symbols.map((symbol) => COINGECKO_IDS[symbol]).filter(Boolean);
  if (ids.length !== symbols.length) {
    throw new Error('coingecko_symbol_mapping_missing');
  }

  const query = new URLSearchParams({
    ids: ids.join(','),
    vs_currencies: 'usd',
    include_last_updated_at: 'true',
    precision: 'full',
  });
  const requestUrl = `${COINGECKO_SIMPLE_PRICE_URL}?${query.toString()}`;
  const payload = await fetchJson(requestUrl, fetchImpl);

  const results = {};
  for (const symbol of symbols) {
    const id = COINGECKO_IDS[symbol];
    const item = payload?.[id];
    const usd = item?.usd;
    const lastUpdatedAt = Number(item?.last_updated_at);

    if (
      typeof usd !== 'number' ||
      !Number.isFinite(usd) ||
      usd <= 0 ||
      !Number.isSafeInteger(lastUpdatedAt) ||
      lastUpdatedAt <= 0
    ) {
      continue;
    }

    const price = String(usd);
    parsePositiveDecimal(price, 'coingecko_price');

    results[symbol] = {
      symbol,
      markPriceRaw: price,
      markPrice: price,
      sourceTime: lastUpdatedAt * 1000,
      sourceTimeIso: new Date(lastUpdatedAt * 1000).toISOString(),
      endpoint: requestUrl,
      method: 'coingecko-simple-price',
      source: 'CoinGecko aggregated spot price',
      isSettlementSource: false,
    };
  }

  return results;
}

async function refreshLiveMarkPrices(fetchImpl = globalThis.fetch) {
  const symbols = Array.from(ALLOWED_SYMBOLS);
  const prices = {};
  const failedSymbols = [];

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const result = await fetchCurrentMarkPrice(symbol, fetchImpl);
        prices[symbol] = {
          ...result,
          source: 'Binance USDⓈ-M Futures Mark Price',
          isSettlementSource: true,
        };
      } catch (error) {
        failedSymbols.push(symbol);
        prices[symbol] = {
          symbol,
          unavailable: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  if (failedSymbols.length > 0) {
    try {
      const fallback = await fetchCoinGeckoFallback(failedSymbols, fetchImpl);
      for (const symbol of failedSymbols) {
        if (fallback[symbol]) prices[symbol] = fallback[symbol];
      }
    } catch (error) {
      for (const symbol of failedSymbols) {
        prices[symbol] = {
          ...prices[symbol],
          fallbackError: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const refreshedAt = Date.now();
  liveMarkCache = {
    source: 'EXTREMA live display price',
    refreshedAt,
    refreshedAtIso: new Date(refreshedAt).toISOString(),
    prices,
  };
  liveMarkCacheAt = refreshedAt;
  return liveMarkCache;
}

async function getLiveMarkPrices({ forceFresh = false, fetchImpl = globalThis.fetch } = {}) {
  const ageMs = Date.now() - liveMarkCacheAt;
  if (!forceFresh && liveMarkCache && ageMs < LIVE_MARK_CACHE_TTL_MS) {
    return liveMarkCache;
  }

  if (!liveMarkRefreshPromise) {
    liveMarkRefreshPromise = refreshLiveMarkPrices(fetchImpl)
      .finally(() => {
        liveMarkRefreshPromise = null;
      });
  }

  return liveMarkRefreshPromise;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseUtcIso(value, name) {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    throw new Error(`${name}_must_be_utc_iso`);
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${name}_invalid`);
  }

  return timestamp;
}

function parsePositiveDecimal(value, name) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) {
    throw new Error(`${name}_invalid_decimal`);
  }

  const [whole, fraction = ''] = value.split('.');
  if (whole === '0' && /^0*$/.test(fraction)) {
    throw new Error(`${name}_must_be_positive`);
  }

  return { whole, fraction };
}

function decimalToScaledInteger(value, scaleDigits = 18) {
  const { whole, fraction } = parsePositiveDecimal(value, 'price');
  if (fraction.length > scaleDigits) {
    throw new Error('price_precision_too_large');
  }

  const paddedFraction = fraction.padEnd(scaleDigits, '0');
  return BigInt(whole) * (10n ** BigInt(scaleDigits)) + BigInt(paddedFraction || '0');
}

function compareDecimalStrings(a, b) {
  const aScaled = decimalToScaledInteger(a);
  const bScaled = decimalToScaledInteger(b);
  return aScaled === bScaled ? 0 : aScaled > bScaled ? 1 : -1;
}

function decimalToCentsHalfUp(value) {
  const { whole, fraction } = parsePositiveDecimal(value, 'resolved_price');
  const centsDigits = fraction.padEnd(3, '0');
  let cents = BigInt(whole) * 100n + BigInt(centsDigits.slice(0, 2));
  if (Number(centsDigits[2]) >= 5) cents += 1n;

  if (cents > 18_446_744_073_709_551_615n) {
    throw new Error('resolved_price_exceeds_uint64');
  }

  return cents;
}

function validateWindow({ cadence, startTimeMs, endTimeExclusiveMs }) {
  const cadenceConfig = CADENCE_INTERVALS[cadence];
  if (!cadenceConfig) throw new Error('resolver_cadence_not_supported');

  if (
    !Number.isSafeInteger(startTimeMs) ||
    !Number.isSafeInteger(endTimeExclusiveMs) ||
    endTimeExclusiveMs <= startTimeMs
  ) {
    throw new Error('resolver_window_invalid');
  }

  const durationMs = endTimeExclusiveMs - startTimeMs;
  if (
    startTimeMs % cadenceConfig.intervalMs !== 0 ||
    endTimeExclusiveMs % cadenceConfig.intervalMs !== 0 ||
    durationMs % cadenceConfig.intervalMs !== 0
  ) {
    throw new Error('resolver_window_not_interval_aligned');
  }

  const expectedCandleCount = durationMs / cadenceConfig.intervalMs;
  if (expectedCandleCount <= 0 || expectedCandleCount > MAX_LIMIT) {
    throw new Error('resolver_window_exceeds_single_request_limit');
  }

  return {
    ...cadenceConfig,
    expectedCandleCount,
  };
}

function validateRawCandle(candle, expectedOpenTime, intervalMs) {
  if (!Array.isArray(candle) || candle.length < 7) {
    throw new Error('resolver_candle_shape_invalid');
  }

  const openTime = Number(candle[0]);
  const open = candle[1];
  const high = candle[2];
  const low = candle[3];
  const close = candle[4];
  const closeTime = Number(candle[6]);

  if (
    !Number.isSafeInteger(openTime) ||
    !Number.isSafeInteger(closeTime) ||
    openTime !== expectedOpenTime ||
    closeTime !== expectedOpenTime + intervalMs - 1
  ) {
    throw new Error('resolver_candle_time_sequence_invalid');
  }

  parsePositiveDecimal(open, 'open');
  parsePositiveDecimal(high, 'high');
  parsePositiveDecimal(low, 'low');
  parsePositiveDecimal(close, 'close');

  if (
    compareDecimalStrings(high, low) < 0 ||
    compareDecimalStrings(high, open) < 0 ||
    compareDecimalStrings(high, close) < 0 ||
    compareDecimalStrings(low, open) > 0 ||
    compareDecimalStrings(low, close) > 0
  ) {
    throw new Error('resolver_candle_price_invariant_invalid');
  }
}

async function fetchMarkPriceWindow({
  symbol,
  cadence,
  observationStartAt,
  observationEndAt,
  fetchImpl = globalThis.fetch,
}) {
  if (!ALLOWED_SYMBOLS.has(symbol)) {
    throw new Error('resolver_symbol_not_supported');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('resolver_fetch_unavailable');
  }

  const startTimeMs = parseUtcIso(observationStartAt, 'observation_start');
  const endTimeExclusiveMs = parseUtcIso(observationEndAt, 'observation_end');
  const {
    interval,
    intervalMs,
    expectedCandleCount,
  } = validateWindow({ cadence, startTimeMs, endTimeExclusiveMs });

  const query = new URLSearchParams({
    symbol,
    interval,
    startTime: String(startTimeMs),
    // Binance endTime is inclusive. EXTREMA windows are [start, end),
    // so request the final millisecond immediately before observationEndAt.
    endTime: String(endTimeExclusiveMs - 1),
    limit: String(expectedCandleCount),
  });

  const requestUrl =
    `${BINANCE_USDM_BASE_URL}${MARK_PRICE_KLINES_PATH}?${query.toString()}`;

  const response = await fetchImpl(requestUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'user-agent': 'EXTREMA-Resolver/0.1',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `resolver_source_http_${response.status}:${body.slice(0, 160)}`,
    );
  }

  const candles = await response.json();
  if (!Array.isArray(candles)) {
    throw new Error('resolver_source_response_invalid');
  }

  if (candles.length !== expectedCandleCount) {
    throw new Error(
      `resolver_candle_count_mismatch:expected_${expectedCandleCount}:received_${candles.length}`,
    );
  }

  for (let index = 0; index < candles.length; index += 1) {
    validateRawCandle(
      candles[index],
      startTimeMs + index * intervalMs,
      intervalMs,
    );
  }

  return {
    source: 'Binance USDⓈ-M Futures Mark Price Klines',
    endpoint: `${BINANCE_USDM_BASE_URL}${MARK_PRICE_KLINES_PATH}`,
    requestUrl,
    symbol,
    cadence,
    interval,
    observationStartAt,
    observationEndAt,
    startTimeMs,
    endTimeExclusiveMs,
    expectedCandleCount,
    candles,
    sourceDataSha256: sha256Hex(JSON.stringify(candles)),
  };
}

function calculateExtrema(windowData) {
  const { candles } = windowData;
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error('resolver_no_candles');
  }

  let high = candles[0][2];
  let low = candles[0][3];
  let highOpenTime = Number(candles[0][0]);
  let lowOpenTime = Number(candles[0][0]);

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const candleHigh = candle[2];
    const candleLow = candle[3];

    if (compareDecimalStrings(candleHigh, high) > 0) {
      high = candleHigh;
      highOpenTime = Number(candle[0]);
    }

    if (compareDecimalStrings(candleLow, low) < 0) {
      low = candleLow;
      lowOpenTime = Number(candle[0]);
    }
  }

  return {
    high: {
      exact: high,
      resolvedPriceCents: decimalToCentsHalfUp(high).toString(),
      candleOpenTime: highOpenTime,
      candleOpenIso: new Date(highOpenTime).toISOString(),
    },
    low: {
      exact: low,
      resolvedPriceCents: decimalToCentsHalfUp(low).toString(),
      candleOpenTime: lowOpenTime,
      candleOpenIso: new Date(lowOpenTime).toISOString(),
    },
  };
}

async function resolveExtremaWindow(input) {
  const windowData = await fetchMarkPriceWindow(input);
  const extrema = calculateExtrema(windowData);

  const evidence = {
    source: windowData.source,
    endpoint: windowData.endpoint,
    symbol: windowData.symbol,
    cadence: windowData.cadence,
    interval: windowData.interval,
    observationWindow: {
      startInclusive: windowData.observationStartAt,
      endExclusive: windowData.observationEndAt,
    },
    candleCount: windowData.candles.length,
    sourceDataSha256: windowData.sourceDataSha256,
    rounding: 'nearest cent, half up',
    high: extrema.high,
    low: extrema.low,
  };

  return {
    ...evidence,
    evidenceSha256: sha256Hex(JSON.stringify(evidence)),
  };
}

module.exports = {
  BINANCE_USDM_BASE_URL,
  MARK_PRICE_KLINES_PATH,
  PREMIUM_INDEX_PATH,
  LIVE_MARK_CACHE_TTL_MS,
  LIVE_MARK_BASE_URLS,
  COINGECKO_SIMPLE_PRICE_URL,
  COINGECKO_IDS,
  fetchCurrentMarkPrice,
  fetchCoinGeckoFallback,
  getLiveMarkPrices,
  CADENCE_INTERVALS,
  fetchMarkPriceWindow,
  calculateExtrema,
  resolveExtremaWindow,
  decimalToCentsHalfUp,
};
