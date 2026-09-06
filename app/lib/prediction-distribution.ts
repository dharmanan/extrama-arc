export type PredictionDistributionBin = { count: number };

export type PredictionDistribution = {
  bins: PredictionDistributionBin[];
  fromCents: bigint;
  toCents: bigint;
  minCents: bigint;
  maxCents: bigint;
  peak: number;
};

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

export function buildPredictionDistribution(
  pricesCents: bigint[],
): PredictionDistribution | null {
  if (pricesCents.length === 0) return null;

  let minCents = pricesCents[0];
  let maxCents = pricesCents[0];
  for (const price of pricesCents.slice(1)) {
    if (price < minCents) minCents = price;
    if (price > maxCents) maxCents = price;
  }

  const span = maxCents - minCents;
  const pad = span === BigInt(0)
    ? (maxCents / BigInt(1000) > BigInt(50) ? maxCents / BigInt(1000) : BigInt(50))
    : BigInt(0);
  const fromCents = minCents > pad ? minCents - pad : BigInt(0);
  const toCents = maxCents + pad;
  const range = toCents - fromCents;
  const binCount = Math.min(20, Math.max(6, Math.ceil(Math.sqrt(pricesCents.length)) * 3));
  const bins: PredictionDistributionBin[] = Array.from(
    { length: binCount },
    () => ({ count: 0 }),
  );

  for (const price of pricesCents) {
    const rawIndex = Number(((price - fromCents) * BigInt(binCount)) / range);
    const index = Math.min(binCount - 1, Math.max(0, rawIndex));
    bins[index].count += 1;
  }

  return {
    bins,
    fromCents,
    toCents,
    minCents,
    maxCents,
    peak: Math.max(...bins.map((bin) => bin.count)),
  };
}

export function distributionOffsetPercent(
  priceCents: bigint,
  model: PredictionDistribution,
): number | null {
  if (priceCents < model.fromCents || priceCents > model.toCents) return null;
  const range = model.toCents - model.fromCents;
  const basisPoints = ((priceCents - model.fromCents) * BigInt(10_000)) / range;
  return Number(basisPoints) / 100;
}
