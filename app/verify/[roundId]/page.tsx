import Link from "next/link";
import { ProductHeader } from "../../product-components";
import { formatUsd, getResultByRoundId } from "../../lib/data";

export default async function VerifyPage({ params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params;
  const result = getResultByRoundId(Number(roundId));

  if (!result) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main"><h1>Verification unavailable</h1><Link href="/pools">Back to pools</Link></section>
      </main>
    );
  }

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>SETTLEMENT VERIFICATION</p>
        <h1>Round #{result.roundId}</h1>
        <section className="wf-panel wf-section">
          <p><b>Source:</b> {result.source}</p>
          <p><b>Symbol:</b> {result.sourceSymbol}</p>
          <p><b>Interval:</b> {result.interval}</p>
          <p><b>Resolved price:</b> {formatUsd(result.resolvedPrice)}</p>
          <p><b>Resolved at:</b> {result.resolvedAt}</p>
          <p><b>Evidence hash:</b></p>
          <p className="wf-code">{result.evidenceHash}</p>
        </section>
        <section className="wf-panel">
          <h2>Deterministic method</h2>
          <ol>
            <li>Use the source locked when the round is created.</li>
            <li>Fetch historical Mark Price candles for the complete observation period.</li>
            <li>For a High pool, take the maximum candle high. For a Low pool, take the minimum candle low.</li>
            <li>Rank predictions by absolute distance to the resolved price.</li>
            <li>Use earlier onchain entry order as the deterministic tie breaker.</li>
          </ol>
        </section>
        <div className="wf-section"><Link className="wf-action" href={`/results/${result.roundId}`}>Back to result</Link></div>
      </section>
    </main>
  );
}
