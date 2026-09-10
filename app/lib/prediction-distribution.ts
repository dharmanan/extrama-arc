// The contract records predictions as exact integer cents. The map keeps that
// identity as bigint until the final CSS percentage is derived; it never turns
// a price into a display bucket.

export type PredictionMapInput = {
  id: string;
  priceCents: bigint;
};

export type PredictionMapPoint = PredictionMapInput & {
  positionPercent: number;
  lane: number;
};

export type PredictionMap = {
  points: PredictionMapPoint[];
  fromScaled: bigint;
  toScaled: bigint;
  minCents: bigint;
  maxCents: bigint;
  livePositionPercent: number | null;
  offscaleLive: "LEFT" | "RIGHT" | null;
  laneCount: number;
};

// Binance returns a decimal mark rather than a cents value. Eight decimal
// places preserve its display precision while prediction cents scale exactly
// into the same integer coordinate system.
const MARKET_SCALE_DECIMALS = 8;
const CENT_TO_MARKET_SCALE = BigInt(10) ** BigInt(MARKET_SCALE_DECIMALS - 2);
const PERCENT_SCALE = BigInt(100_000);
const COLLISION_GAP_PERCENT = 6;
const OFF_SCALE_MINIMUM_DISTANCE = CENT_TO_MARKET_SCALE * BigInt(100); // $1.00
const OFF_SCALE_PREDICTION_SPAN_MULTIPLIER = BigInt(4);

export function parsePredictionCents(value: string): bigint | null {
  if (!/^[0-9]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function parsePredictionInput(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;

  const cents = BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents <= BigInt(0) || cents > BigInt(1_000_000_000_000)) return null;
  return Number(cents);
}

export function parseMarketPriceScaled(value: string | null): bigint | null {
  if (!value) return null;
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) return null;
  try {
    return BigInt(match[1]) * (BigInt(10) ** BigInt(MARKET_SCALE_DECIMALS)) +
      BigInt((match[2] ?? "").slice(0, MARKET_SCALE_DECIMALS).padEnd(MARKET_SCALE_DECIMALS, "0"));
  } catch {
    return null;
  }
}

function centsToScaled(cents: bigint) {
  return cents * CENT_TO_MARKET_SCALE;
}

function positionPercent(value: bigint, from: bigint, to: bigint) {
  const range = to - from;
  if (range <= BigInt(0)) return 50;
  return Number(((value - from) * PERCENT_SCALE) / range) / 1000;
}

/**
 * Builds a true numeric axis for exact prediction markers. A normal live
 * Binance mark joins that axis and shares its proportional distance. A mark
 * far outside a tight prediction range becomes an explicit edge indicator:
 * this avoids compressing the prediction axis while never pretending the mark
 * sits at an in-range numeric position.
 */
export function buildPredictionMap(
  inputs: PredictionMapInput[],
  liveMarkPrice: string | null,
): PredictionMap | null {
  if (inputs.length === 0) return null;

  const sorted = [...inputs].sort((a, b) =>
    a.priceCents < b.priceCents ? -1 : a.priceCents > b.priceCents ? 1 : a.id.localeCompare(b.id),
  );
  const scaledPredictions = sorted.map((point) => centsToScaled(point.priceCents));
  const liveScaled = parseMarketPriceScaled(liveMarkPrice);
  let predictionLow = scaledPredictions[0];
  let predictionHigh = scaledPredictions[0];
  for (const value of scaledPredictions.slice(1)) {
    if (value < predictionLow) predictionLow = value;
    if (value > predictionHigh) predictionHigh = value;
  }

  const predictionSpan = predictionHigh - predictionLow;
  const normalLiveDistance = predictionSpan * OFF_SCALE_PREDICTION_SPAN_MULTIPLIER > OFF_SCALE_MINIMUM_DISTANCE
    ? predictionSpan * OFF_SCALE_PREDICTION_SPAN_MULTIPLIER
    : OFF_SCALE_MINIMUM_DISTANCE;
  const offscaleLive = liveScaled === null ||
    (liveScaled >= predictionLow && liveScaled <= predictionHigh) ||
    (liveScaled < predictionLow && predictionLow - liveScaled <= normalLiveDistance) ||
    (liveScaled > predictionHigh && liveScaled - predictionHigh <= normalLiveDistance)
    ? null
    : liveScaled < predictionLow ? "LEFT" : "RIGHT";
  const axisValues = offscaleLive || liveScaled === null
    ? scaledPredictions
    : [...scaledPredictions, liveScaled];
  let low = axisValues[0];
  let high = axisValues[0];
  for (const value of axisValues.slice(1)) {
    if (value < low) low = value;
    if (value > high) high = value;
  }

  const span = high - low;
  const minimumPad = CENT_TO_MARKET_SCALE;
  const pad = span === BigInt(0)
    ? (high / BigInt(1000) > minimumPad * BigInt(50) ? high / BigInt(1000) : minimumPad * BigInt(50))
    : (span / BigInt(12) > minimumPad ? span / BigInt(12) : minimumPad);
  const fromScaled = low > pad ? low - pad : BigInt(0);
  const toScaled = high + pad;

  // Give close markers the first available deterministic lane. Horizontal
  // placement remains untouched, and no exact prediction is hidden.
  const lastPositionByLane: number[] = [];
  const points = sorted.map((point) => {
    const position = positionPercent(centsToScaled(point.priceCents), fromScaled, toScaled);
    let lane = lastPositionByLane.findIndex((last) => position - last >= COLLISION_GAP_PERCENT);
    if (lane < 0) lane = lastPositionByLane.length;
    lastPositionByLane[lane] = position;
    return { ...point, positionPercent: position, lane };
  });

  return {
    points,
    fromScaled,
    toScaled,
    minCents: sorted[0].priceCents,
    maxCents: sorted[sorted.length - 1].priceCents,
    livePositionPercent: liveScaled === null || offscaleLive !== null
      ? null
      : positionPercent(liveScaled, fromScaled, toScaled),
    offscaleLive,
    laneCount: Math.max(1, lastPositionByLane.length),
  };
}

export function formatAxisScaled(scaled: bigint, locale: "en" | "tr") {
  const cents = scaled / CENT_TO_MARKET_SCALE;
  const whole = cents / BigInt(100);
  const fraction = (cents % BigInt(100)).toString().padStart(2, "0");
  const separator = locale === "tr" ? "," : ".";
  return `${new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US").format(whole)}${separator}${fraction}`;
}
