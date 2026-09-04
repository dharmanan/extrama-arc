import Link from "next/link";
import { ProductHeader } from "../../product-components";
import { formatUsd, getPoolBySlug, getResultByRoundId } from "../../lib/data";

export default async function ResultPage({ params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params;
  const result = getResultByRoundId(Number(roundId));

  if (!result) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main"><h1>Result not available</h1><Link href="/pools">Back to pools</Link></section>
      </main>
    );
  }

  const pool = getPoolBySlug(result.poolSlug);

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>ROUND #{result.roundId}</p>
        <h1>Round Complete</h1>
        <p>{pool ? `${pool.asset} · ${pool.cadence} ${pool.direction}` : result.poolSlug}</p>

        <section className="wf-panel wf-section">
          <small>Official result</small>
          <h2>{formatUsd(result.resolvedPrice)}</h2>
          <p>{result.source} · {result.sourceSymbol} · {result.interval}</p>
        </section>

        <section className="wf-section">
          <h2>Winners</h2>
          <table className="wf-table">
            <thead><tr><th>Rank</th><th>Wallet</th><th>Prediction</th><th>Distance</th><th>Reward</th></tr></thead>
            <tbody>
              {result.winners.map((winner) => (
                <tr key={winner.rank}>
                  <td>#{winner.rank}</td>
                  <td>{winner.wallet}</td>
                  <td>{formatUsd(winner.prediction)}</td>
                  <td>{formatUsd(winner.distance)}</td>
                  <td>{winner.rewardUsdc} USDC</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <div className="wf-row">
          <Link className="wf-action" href={`/verify/${result.roundId}`}>Verify settlement</Link>
          <Link className="wf-action" href="/tickets">Claim with NFT</Link>
        </div>
      </section>
    </main>
  );
}
