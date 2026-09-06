import { ResultClient, type LiveResult } from "./ResultClient";

type ServerResult = {
  chain: {
    id: number;
    name: string;
    explorerUrl: string;
  };
  pool: {
    slug: string;
    poolAddress: string;
    ticketAddress: string;
    asset: string;
    direction: "HIGH" | "LOW";
    cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
    source: string;
    sourceSymbol: string;
  };
  round: {
    roundId: number;
    contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
    entryOpenAt: string;
    entryCloseAt: string;
    observationStartAt: string;
    observationEndAt: string;
    entryCount: number;
    totalStakeRaw: string;
    totalStakeUsdc: string;
    escrowRemainingRaw: string;
    escrowRemainingUsdc: string;
    resolvedPriceCents: string;
    resolvedPrice: string | null;
    winnerTicketIds: string[];
  };
  winners: Array<{
    rank: number;
    tokenId: string;
    currentOwner: string;
    originalEntrant: string;
    predictionPriceCents: string;
    predictionPrice: string;
    distanceCents: string;
    distance: string;
    entrySequence: number;
    placement: number;
    isClaimed: boolean;
    claimableRaw: string;
    claimableUsdc: string;
  }>;
};

function backendBaseUrl() {
  return process.env.BACKEND_API_URL || "http://127.0.0.1:3001/api";
}

async function loadResult(slug: string, roundId: number): Promise<ServerResult | null> {
  const response = await fetch(
    `${backendBaseUrl()}/rounds/${encodeURIComponent(slug)}/${roundId}/result`,
    { cache: "no-store" },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`round_result_http_${response.status}`);
  }

  return response.json() as Promise<ServerResult>;
}

export default async function LiveResultPage({
  params,
}: {
  params: Promise<{ slug: string; roundId: string }>;
}) {
  const { slug, roundId: roundIdParam } = await params;
  const roundId = Number(roundIdParam);

  if (!Number.isInteger(roundId) || roundId <= 0) {
    return <ResultClient result={null} invalid />;
  }

  const result = await loadResult(slug, roundId);

  if (!result) {
    return <ResultClient result={null} />;
  }

  return <ResultClient result={result as LiveResult} />;
}
