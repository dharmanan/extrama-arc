"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader } from "../../product-components";
import { backendApi, type LiveRoundResponse } from "../../lib/backend-api";
import {
  formatEntryCount,
  formatLocalDateTime,
  formatTimeUntil,
  formatUsdc,
  humanRoundStatus,
} from "../../lib/display";

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
        <section className="wf-main"><p>Loading pool…</p></section>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>Pool unavailable</h1>
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
        <Link href="/pools">← Back to pools</Link>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <AssetMark asset={pool.asset} />
            <h1>
              {pool.asset} · {titleCase(pool.cadence)} {titleCase(pool.direction)}
            </h1>

            <p>Round <b>#{pool.round.roundId}</b></p>
            <p><b>{humanRoundStatus(pool.round.contractStatus)}</b></p>
            {pool.round.canEnter && (
              <p>
                Predictions close {formatLocalDateTime(pool.round.entryCloseAt)}
                {" · "}{formatTimeUntil(pool.round.entryCloseAt)}
              </p>
            )}

            <p>{formatEntryCount(pool.round.entryCount)}</p>
            <p>Prize pool: <b>{formatUsdc(pool.round.totalStakeUsdc)}</b></p>

            <h2>Round timing</h2>
            <p>Predictions open until {formatLocalDateTime(pool.round.entryCloseAt)}</p>
            <p>
              Price observation runs from {formatLocalDateTime(pool.round.observationStartAt)}
              {" to "}{formatLocalDateTime(pool.round.observationEndAt)}
            </p>

            <h2>Price source</h2>
            <p><b>{pool.source}</b> · {pool.sourceSymbol}</p>

            <div className="wf-row">
              <a
                className="wf-action"
                href={`${chain.explorerUrl}/address/${pool.poolAddress}`}
                target="_blank"
                rel="noreferrer"
              >
                Verify on Arc
              </a>
              <Link href={`/rounds/${pool.slug}`} className="wf-action">View round</Link>
            </div>
          </section>

          <section className="wf-panel">
            <h2>Make a prediction</h2>
            <p>One prediction costs exactly 1 USDC.</p>
            <p>
              Secure entry is being enabled next. Until then, this button stays disabled so
              no fake or local-only prediction can be created.
            </p>
            <button className="wf-action" type="button" disabled>
              Prediction entry coming next
            </button>
          </section>
        </div>
      </section>
    </main>
  );
}
