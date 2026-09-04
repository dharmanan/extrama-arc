import Link from "next/link";
import { ProductHeader } from "./product-components";

export default function HomePage() {
  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>EXTREMA · ETHONLINE 2026</p>
        <h1>Fixed-entry crypto forecasting pools.</h1>
        <p>
          Predict the Daily, Weekly or Quarterly High or Low of BTC, ETH, SOL or HYPE.
          Every entry costs exactly 1 USDC and every exact prediction is unique within its pool.
        </p>

        <div className="wf-grid-3 wf-section">
          <article className="wf-card">
            <small>MARKETS</small>
            <strong>24 standard pools</strong>
            <p>4 assets × 2 directions × 3 cadences.</p>
            <Link className="wf-action" href="/pools">Explore pools</Link>
          </article>
          <article className="wf-card">
            <small>WALLET</small>
            <strong>Create or connect</strong>
            <p>Functional demo wallet state is shared across every route.</p>
            <Link className="wf-action" href="/wallet">Open wallet</Link>
          </article>
          <article className="wf-card">
            <small>SETTLEMENT</small>
            <strong>Deterministic result</strong>
            <p>Review the settled demo round and its evidence trail.</p>
            <Link className="wf-action" href="/results/184">View demo result</Link>
          </article>
        </div>

        <section className="wf-panel wf-section">
          <h2>End-to-end demo path</h2>
          <ol>
            <li>Create or connect wallet.</li>
            <li>Get test USDC.</li>
            <li>Open an ENTRY_OPEN pool.</li>
            <li>Enter one unique price for exactly 1 USDC.</li>
            <li>Receive a ticket in My Tickets.</li>
            <li>Inspect live round state.</li>
            <li>Review settled results and verification evidence.</li>
            <li>Claim a winning NFT reward.</li>
          </ol>
        </section>
      </section>
    </main>
  );
}
