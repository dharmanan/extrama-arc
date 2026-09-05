"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader } from "../../product-components";
import { backendApi, type LiveRoundResponse } from "../../lib/backend-api";
import {
  formatEntryCount,
  formatLocalDateTime,
  formatUsdc,
  humanRoundStatus,
} from "../../lib/display";

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default function LiveRoundPage() {
  const params = useParams<{ slug: string }>();
  const [state, setState] = useState<LiveRoundResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    backendApi.rounds.get(params.slug)
      .then((result) => {
        if (cancelled) return;
        setState(result);
        setError("");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(null);
        setError(err instanceof Error ? err.message : "Unable to read live round.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [params.slug]);

  if (loading) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main"><p>Loading round…</p></section>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>Round unavailable</h1>
          <p>We could not load the latest round data. Please try again.</p>
          <Link href="/pools">Back to pools</Link>
        </section>
      </main>
    );
  }

  const { pool, chain } = state;

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <div className="wf-row">
          <div>
            <AssetMark asset={pool.asset} />
            <h1>
              {pool.asset} · {titleCase(pool.cadence)} {titleCase(pool.direction)}
            </h1>
            <p>Round #{pool.round.roundId} · <b>{humanRoundStatus(pool.round.contractStatus)}</b></p>
          </div>
          <div>
            <strong>{formatUsdc(pool.round.totalStakeUsdc)}</strong>
            <p>Prize pool</p>
          </div>
        </div>

        <section className="wf-panel wf-section">
          <h2>Predictions</h2>
          <p>{formatEntryCount(pool.round.entryCount)}</p>
        </section>

        <div className="wf-grid-3">
          <section className="wf-card">
            <small>Entries</small>
            <strong>{pool.round.entryCount}</strong>
          </section>
          <section className="wf-card">
            <small>Prize pool</small>
            <strong>{formatUsdc(pool.round.totalStakeUsdc)}</strong>
          </section>
          <section className="wf-card">
            <small>Round ends</small>
            <strong>{formatLocalDateTime(pool.round.observationEndAt)}</strong>
          </section>
        </div>

        <section className="wf-panel wf-section">
          <h2>Round timeline</h2>
          <p>Predictions close: {formatLocalDateTime(pool.round.entryCloseAt)}</p>
          <p>Price observation starts: {formatLocalDateTime(pool.round.observationStartAt)}</p>
          <p>Price observation ends: {formatLocalDateTime(pool.round.observationEndAt)}</p>
        </section>

        <section className="wf-section wf-row">
          <Link className="wf-action" href={`/pools/${pool.slug}`}>Make a prediction</Link>
          <a
            className="wf-action"
            href={`${chain.explorerUrl}/address/${pool.poolAddress}`}
            target="_blank"
            rel="noreferrer"
          >
            Verify on Arc
          </a>
        </section>
      </section>
    </main>
  );
}
