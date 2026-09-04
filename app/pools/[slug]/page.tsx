"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader } from "../../product-components";
import { formatUsd, getPoolBySlug } from "../../lib/data";

export default function PoolDetailPage() {
  const params = useParams<{ slug: string }>();
  const pool = useMemo(() => getPoolBySlug(params.slug), [params.slug]);
  const [prediction, setPrediction] = useState("2085.00");
  const [reserved, setReserved] = useState(false);

  if (!pool) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main"><h1>Pool not found</h1><Link href="/pools">Back to pools</Link></section>
      </main>
    );
  }

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <Link href="/pools">← Back to pools</Link>
        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <AssetMark asset={pool.asset} />
            <h1>{pool.asset} · {pool.cadence} {pool.direction}</h1>
            <p>Reference price: <b>{formatUsd(pool.referencePrice)}</b></p>
            <p>Official source: <b>{pool.source}</b></p>
            <p>Symbol: <b>{pool.sourceSymbol}</b></p>
            <p>Observation: {pool.observationStartAt} → {pool.observationEndAt}</p>
            <p>Current pool: {pool.poolSizeUsdc} USDC · {pool.players} players</p>
            <Link href={`/rounds/${pool.slug}`} className="wf-action">View live round</Link>
          </section>

          <section className="wf-panel">
            <h2>Make a prediction</h2>
            <p>Every entry costs exactly 1 USDC. The same price cannot be taken twice.</p>
            <label className="wf-field">
              Prediction (USD)
              <input value={prediction} onChange={(event) => setPrediction(event.target.value)} inputMode="decimal" />
            </label>
            <p>Allowed demo range: {formatUsd(pool.predictionMin)} – {formatUsd(pool.predictionMax)}</p>
            <p>NFT ticket: {pool.asset} · {pool.cadence} {pool.direction} · Round #{pool.roundId}</p>
            <button className="wf-action" type="button" onClick={() => setReserved(true)}>
              {reserved ? "Reserved in mock state" : "Confirm prediction · 1 USDC"}
            </button>
          </section>
        </div>
      </section>
    </main>
  );
}
