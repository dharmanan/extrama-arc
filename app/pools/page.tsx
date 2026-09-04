import { PoolSummary, ProductHeader } from "../product-components";
import { pools } from "../lib/data";
import type { Asset, Cadence } from "../lib/domain";

const assets: ("All" | Asset)[] = ["All", "BTC", "ETH", "SOL", "HYPE"];
const cadences: Cadence[] = ["Daily", "Weekly", "Quarterly"];

export default function PoolsPage() {
  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>POOL OVERVIEW</p>
        <h1>Active Pools</h1>
        <p>4 assets × 2 directions × 3 cadences = 24 standard pools.</p>

        <div className="wf-tabs">{assets.map((item) => <span key={item}>{item}</span>)}</div>
        <div className="wf-tabs">{cadences.map((item) => <span key={item}>{item}</span>)}</div>

        {cadences.map((cadence) => (
          <section className="wf-section" key={cadence}>
            <h2>{cadence}</h2>
            <div className="wf-grid">
              {pools.filter((pool) => pool.cadence === cadence).map((pool) => (
                <PoolSummary pool={pool} key={pool.slug} />
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  );
}
