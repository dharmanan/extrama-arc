import { ProductHeader } from "../product-components";
import PoolsClient from "./PoolsClient";

export default function PoolsPage() {
  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>POOL OVERVIEW</p>
        <h1>Active Pools</h1>
        <p>4 assets × 2 directions × 3 cadences = 24 standard pools.</p>
        <PoolsClient />
      </section>
    </main>
  );
}
