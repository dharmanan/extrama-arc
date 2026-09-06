import Link from "next/link";
import { ProductHeader } from "../../../product-components";

type LiveResult = {
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

async function loadResult(slug: string, roundId: number): Promise<LiveResult | null> {
  const response = await fetch(
    `${backendBaseUrl()}/rounds/${encodeURIComponent(slug)}/${roundId}/result`,
    { cache: "no-store" },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`round_result_http_${response.status}`);
  }

  return response.json() as Promise<LiveResult>;
}

function formatUsd(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default async function LiveResultPage({
  params,
}: {
  params: Promise<{ slug: string; roundId: string }>;
}) {
  const { slug, roundId: roundIdParam } = await params;
  const roundId = Number(roundIdParam);

  if (!Number.isInteger(roundId) || roundId <= 0) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>Result not available</h1>
          <Link href="/pools">Back to pools</Link>
        </section>
      </main>
    );
  }

  const result = await loadResult(slug, roundId);

  if (!result) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>Result not available</h1>
          <p>No onchain round matches this pool and round ID.</p>
          <Link href="/pools">Back to pools</Link>
        </section>
      </main>
    );
  }

  const settled = result.round.contractStatus === "SETTLED";

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>
          {result.pool.asset} · {result.pool.cadence} {result.pool.direction} · ROUND #{result.round.roundId}
        </p>
        <h1>{settled ? "Round Complete" : result.round.contractStatus}</h1>

        <section className="wf-panel wf-section">
          <small>Onchain round state</small>
          {settled && result.round.resolvedPrice ? (
            <h2>{formatUsd(result.round.resolvedPrice)}</h2>
          ) : (
            <h2>Settlement pending</h2>
          )}
          <p>
            {result.pool.source} · {result.pool.sourceSymbol}
          </p>
          <p>
            Entries: {result.round.entryCount} · Stake: {result.round.totalStakeUsdc} USDC
          </p>
          <p>
            Observation: {result.round.observationStartAt} → {result.round.observationEndAt}
          </p>
        </section>

        {settled ? (
          <section className="wf-section">
            <h2>Winners</h2>
            <table className="wf-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Ticket</th>
                  <th>Current owner</th>
                  <th>Prediction</th>
                  <th>Distance</th>
                  <th>Claimable</th>
                </tr>
              </thead>
              <tbody>
                {result.winners.map((winner) => (
                  <tr key={winner.tokenId}>
                    <td>#{winner.rank}</td>
                    <td>#{winner.tokenId}</td>
                    <td title={winner.currentOwner}>{shortAddress(winner.currentOwner)}</td>
                    <td>{formatUsd(winner.predictionPrice)}</td>
                    <td>{formatUsd(winner.distance)}</td>
                    <td>{winner.claimableUsdc} USDC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <section className="wf-section">
            <p>
              Winners and rewards are intentionally unavailable until the contract reaches SETTLED.
            </p>
          </section>
        )}

        <div className="wf-row">
          <a
            className="wf-action"
            href={`${result.chain.explorerUrl}/address/${result.pool.poolAddress}`}
            target="_blank"
            rel="noreferrer"
          >
            View pool on ArcScan
          </a>
          {settled && (
            <Link className="wf-action" href={`/verify/${slug}/${roundId}`}>
              Verify settlement
            </Link>
          )}
          <Link className="wf-action" href="/tickets">
            View my tickets
          </Link>
        </div>
      </section>
    </main>
  );
}
