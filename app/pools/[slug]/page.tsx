"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader } from "../../product-components";
import { backendApi, type LiveRoundResponse } from "../../lib/backend-api";

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default function PoolDetailPage() {
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
        setError(err instanceof Error ? err.message : "Unable to read pool.");
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
          <h1>Pool unavailable</h1>
          <p>{error}</p>
          <p>No mock pool data is shown as a fallback.</p>
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
        <Link href="/pools">← Back to pools</Link>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <AssetMark asset={pool.asset} />
            <h1>
              {pool.asset} · {titleCase(pool.cadence)} {titleCase(pool.direction)}
            </h1>

            <p>Round: <b>#{pool.round.roundId}</b></p>
            <p>Status: <b>{pool.round.contractStatus}</b></p>
            <p>Entries accepted now: <b>{pool.round.canEnter ? "YES" : "NO"}</b></p>
            <p>Official source: <b>{pool.source}</b></p>
            <p>Symbol: <b>{pool.sourceSymbol}</b></p>
            <p>Entry opened: {pool.round.entryOpenAt}</p>
            <p>Entry closes: {pool.round.entryCloseAt}</p>
            <p>
              Observation: {pool.round.observationStartAt} → {pool.round.observationEndAt}
            </p>
            <p>
              Current pool: {pool.round.totalStakeUsdc} USDC · {pool.round.entryCount} players
            </p>
            <p>Arc Testnet block: {chain.blockNumber}</p>

            <div className="wf-row">
              <a
                className="wf-action"
                href={`${chain.explorerUrl}/address/${pool.poolAddress}`}
                target="_blank"
                rel="noreferrer"
              >
                Pool contract
              </a>
              <Link href={`/rounds/${pool.slug}`} className="wf-action">View live round</Link>
            </div>
          </section>

          <section className="wf-panel">
            <h2>Make a prediction</h2>
            <p>Every entry costs exactly 1 USDC.</p>
            <p>
              Real entry signing is not enabled on this screen yet. The mock/localStorage
              prediction action has been removed from this pool path.
            </p>
            <p>
              The next implementation gate is fresh passkey step-up authorization followed
              by the real Arc Testnet 1 USDC entry transaction.
            </p>
            <button className="wf-action" type="button" disabled>
              Secure entry flow pending
            </button>
          </section>
        </div>
      </section>
    </main>
  );
}
