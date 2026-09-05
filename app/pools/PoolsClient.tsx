"use client";

import { useEffect, useMemo, useState } from "react";
import { PoolSummary } from "../product-components";
import { backendApi, type LivePool } from "../lib/backend-api";
import type { Asset, Cadence } from "../lib/domain";
import { useCopy, useLocale } from "../i18n";
import { applyBinanceLiveMarket, readBinanceLiveMarket } from "../lib/live-market";

const assets: ("All" | Asset)[] = ["All", "BTC", "ETH", "SOL", "HYPE"];
const cadences: ("All" | Cadence)[] = ["All", "Daily", "Weekly", "Quarterly"];

function cadenceKey(value: Cadence) {
  return value.toUpperCase() as LivePool["cadence"];
}

function localizedCadence(value: LivePool["cadence"], locale: "en" | "tr") {
  if (locale === "tr") {
    if (value === "DAILY") return "Gün";
    if (value === "WEEKLY") return "Hafta";
    return "Çeyrek";
  }

  if (value === "DAILY") return "Daily";
  if (value === "WEEKLY") return "Weekly";
  return "Quarterly";
}

function formatOverviewCountdown(ms: number, locale: "en" | "tr") {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(locale === "tr" ? `${days}g` : `${days}d`);
  if (days > 0 || hours > 0) parts.push(locale === "tr" ? `${hours}sa` : `${hours}h`);
  parts.push(locale === "tr" ? `${minutes}dk` : `${minutes}m`);
  parts.push(locale === "tr" ? `${seconds}sn` : `${seconds}s`);
  return parts.join(" ");
}

function OverviewCountdown({ pools }: { pools: LivePool[] }) {
  const { locale } = useLocale();
  const t = useCopy();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const next = pools
    .map((pool) => {
      const openAt = new Date(pool.round.entryOpenAt).getTime();
      const closeAt = new Date(pool.round.entryCloseAt).getTime();
      const observationStart = new Date(pool.round.observationStartAt).getTime();
      const observationEnd = new Date(pool.round.observationEndAt).getTime();

      if (now < openAt) {
        return { pool, target: openAt, label: t.predictionsStartIn };
      }
      if (now < closeAt) {
        return { pool, target: closeAt, label: t.predictionsCloseIn };
      }
      if (now < observationStart) {
        return { pool, target: observationStart, label: t.observationStartsIn };
      }
      if (now < observationEnd) {
        return { pool, target: observationEnd, label: t.observationEndsIn };
      }
      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.target - b.target)[0];

  if (!next) return null;

  return (
    <div className="wf-next-event">
      <small>{t.nextPhase}</small>
      <div>
        <strong>{localizedCadence(next.pool.cadence, locale)} · {next.label}</strong>
        {" · "}
        <span>{formatOverviewCountdown(next.target - now, locale)}</span>
      </div>
    </div>
  );
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
        const [state, live] = await Promise.all([
          backendApi.rounds.list(),
          readBinanceLiveMarket(),
        ]);
        if (cancelled) return;
        setPools(applyBinanceLiveMarket(state.pools, live));
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
          <div className="wf-pools-meta">
            <p>
              {filtered.length} {t.poolsShown} · Arc Testnet block {blockNumber ?? "—"}.
            </p>
            <OverviewCountdown pools={filtered} />
          </div>
          <div className="wf-grid wf-section">
            {filtered.map((pool) => <PoolSummary pool={pool} key={pool.poolAddress} />)}
          </div>
        </>
      )}
    </>
  );
}
