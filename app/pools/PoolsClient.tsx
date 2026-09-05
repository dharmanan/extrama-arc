"use client";

import { useEffect, useMemo, useState } from "react";
import { PoolSummary } from "../product-components";
import { backendApi, type LivePool } from "../lib/backend-api";
import type { Asset, Cadence } from "../lib/domain";
import { useCopy, useLocale } from "../i18n";

const assets: ("All" | Asset)[] = ["All", "BTC", "ETH", "SOL", "HYPE"];
const cadences: ("All" | Cadence)[] = ["All", "Daily", "Weekly", "Quarterly"];

function cadenceKey(value: Cadence) {
  return value.toUpperCase() as LivePool["cadence"];
}

export default function PoolsClient() {
  const { locale } = useLocale();
  const t = useCopy();
  const [asset, setAsset] = useState<"All" | Asset>("All");
  const [cadence, setCadence] = useState<"All" | Cadence>("Daily");
  const [pools, setPools] = useState<LivePool[]>([]);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      try {
        const state = await backendApi.rounds.list();
        if (cancelled) return;
        setPools(state.pools);
        setBlockNumber(state.chain.blockNumber);
        setError("");
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unable to read Arc Testnet rounds.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void refresh();
    timer = setInterval(() => {
      void refresh();
    }, 60_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  const filtered = useMemo(
    () =>
      pools.filter(
        (pool) =>
          (asset === "All" || pool.asset === asset) &&
          (cadence === "All" || pool.cadence === cadenceKey(cadence)),
      ),
    [asset, cadence, pools],
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
            {item === "All" ? t.all : item}
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
            {item === "All"
              ? t.all
              : item === "Daily"
                ? t.daily
                : item === "Weekly"
                  ? t.weekly
                  : t.quarterly}
          </button>
        ))}
      </div>

      {loading && <p>{t.readingRounds}</p>}

      {!loading && error && (
        <section className="wf-panel wf-section">
          <h2>{t.roundUnavailable}</h2>
          <p>{error}</p>
          <p>{t.noMockFallback}</p>
        </section>
      )}

      {!loading && !error && (
        <>
          <p>
            {filtered.length} {t.poolsShown} · Arc Testnet block {blockNumber ?? "—"}.
          </p>
          <div className="wf-grid wf-section">
            {filtered.map((pool) => <PoolSummary pool={pool} key={pool.poolAddress} />)}
          </div>
        </>
      )}
    </>
  );
}
