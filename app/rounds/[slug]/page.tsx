import Link from "next/link";
import { AssetMark, ProductHeader } from "../../product-components";
import { formatUsd, getPoolBySlug } from "../../lib/data";
import RoundUserState from "./RoundUserState";

export default async function LiveRoundPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const pool = getPoolBySlug(slug);

  if (!pool) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main"><h1>Round not found</h1><Link href="/pools">Back to pools</Link></section>
      </main>
    );
  }

  const resultHref = pool.roundId === 184 ? `/results/${pool.roundId}` : undefined;

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <div className="wf-row">
          <div>
            <AssetMark asset={pool.asset} />
            <h1>{pool.asset} · {pool.cadence} {pool.direction}</h1>
            <p>Status: <b>{pool.status}</b></p>
          </div>
          <div>
            <strong>{formatUsd(pool.referencePrice)}</strong>
            <p>Reference price</p>
          </div>
        </div>

        <section className="wf-panel wf-section">
          <h2>Prediction distribution</h2>
          <p>This is the structural placeholder for the final histogram / density visualization.</p>
          <div style={{height:240,border:"1px dashed #aaa",display:"grid",placeItems:"center"}}>
            Distribution chart goes here
          </div>
        </section>

        <div className="wf-grid-3">
          <section className="wf-card"><small>Players</small><strong>{pool.players}</strong></section>
          <section className="wf-card"><small>Pool size</small><strong>{pool.poolSizeUsdc} USDC</strong></section>
          <section className="wf-card"><small>Observation ends</small><strong>{pool.observationEndAt}</strong></section>
        </div>

        <div className="wf-section">
          <RoundUserState poolSlug={pool.slug} />
        </div>

        <section className="wf-section wf-row">
          <Link className="wf-action" href={`/pools/${pool.slug}`}>Make / view prediction</Link>
          {resultHref && <Link className="wf-action" href={resultHref}>View settled result</Link>}
        </section>
      </section>
    </main>
  );
}
