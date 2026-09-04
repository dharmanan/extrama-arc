"use client";

import { useMemo, useState } from "react";
import { PoolSummary } from "../product-components";
import { pools } from "../lib/data";
import type { Asset, Cadence } from "../lib/domain";

const assets: ("All" | Asset)[] = ["All", "BTC", "ETH", "SOL", "HYPE"];
const cadences: ("All" | Cadence)[] = ["All", "Daily", "Weekly", "Quarterly"];

export default function PoolsClient() {
  const [asset, setAsset] = useState<"All" | Asset>("All");
  const [cadence, setCadence] = useState<"All" | Cadence>("All");

  const filtered = useMemo(
    () =>
      pools.filter(
        (pool) =>
          (asset === "All" || pool.asset === asset) &&
          (cadence === "All" || pool.cadence === cadence),
      ),
    [asset, cadence],
  );

  return (
    <>
      <div className="wf-tabs" aria-label="Asset filter">
        {assets.map((item) => (
          <button
            className="wf-filter"
            data-active={asset === item}
            key={item}
            type="button"
            onClick={() => setAsset(item)}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="wf-tabs" aria-label="Cadence filter">
        {cadences.map((item) => (
          <button
            className="wf-filter"
            data-active={cadence === item}
            key={item}
            type="button"
            onClick={() => setCadence(item)}
          >
            {item}
          </button>
        ))}
      </div>

      <p>{filtered.length} pools shown.</p>

      <div className="wf-grid wf-section">
        {filtered.map((pool) => <PoolSummary pool={pool} key={pool.slug} />)}
      </div>
    </>
  );
}
