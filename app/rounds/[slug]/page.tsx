"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader } from "../../product-components";
import { backendApi, type LiveRoundResponse } from "../../lib/backend-api";

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
        <section className="wf-main"><p>Reading live Arc Testnet round…</p></section>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>Round unavailable</h1>
          <p>{error}</p>
          <p>No mock round data is shown as a fallback.</p>
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
            <p>Round #{pool.round.roundId} · Status: <b>{pool.round.contractStatus}</b></p>
          </div>
          <div>
            <strong>{pool.round.totalStakeUsdc} USDC</strong>
            <p>Onchain pool stake</p>
          </div>
        </div>

        <section className="wf-panel wf-section">
          <h2>Prediction distribution</h2>
          {pool.round.entryCount === 0 ? (
            <p>No onchain entries exist in this round yet.</p>
          ) : (
            <p>
              {pool.round.entryCount} onchain entries exist. Event-backed distribution
              indexing is the next live-round visualization step.
            </p>
          )}
        </section>

        <div className="wf-grid-3">
          <section className="wf-card">
            <small>Players</small>
            <strong>{pool.round.entryCount}</strong>
          </section>
          <section className="wf-card">
            <small>Pool size</small>
            <strong>{pool.round.totalStakeUsdc} USDC</strong>
          </section>
          <section className="wf-card">
            <small>Observation ends</small>
            <strong>{pool.round.observationEndAt}</strong>
          </section>
        </div>

        <section className="wf-panel wf-section">
          <h2>Onchain round state</h2>
          <p>Entry opens: {pool.round.entryOpenAt}</p>
          <p>Entry closes: {pool.round.entryCloseAt}</p>
          <p>Observation starts: {pool.round.observationStartAt}</p>
          <p>Observation ends: {pool.round.observationEndAt}</p>
          <p>Escrow remaining: {pool.round.escrowRemainingUsdc} USDC</p>
          <p>Arc Testnet block: {chain.blockNumber}</p>
        </section>

        <section className="wf-section wf-row">
          <Link className="wf-action" href={`/pools/${pool.slug}`}>Open pool</Link>
          <a
            className="wf-action"
            href={`${chain.explorerUrl}/address/${pool.poolAddress}`}
            target="_blank"
            rel="noreferrer"
          >
            View contract
          </a>
        </section>
      </section>
    </main>
  );
}
