"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader } from "../../product-components";
import { backendApi, type LiveRoundResponse } from "../../lib/backend-api";
import { confirmEntryWithPasskey } from "../../lib/passkey-client";
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
  const [prediction, setPrediction] = useState("");
  const [entryBusy, setEntryBusy] = useState("");
  const [entryError, setEntryError] = useState("");
  const [entrySuccess, setEntrySuccess] = useState<{
    ticketId: string;
    entryTxHash: string;
    explorerUrl: string;
    approvalTxHash: string | null;
  } | null>(null);

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

  async function handleAuthorizeEntry() {
    if (!state) return;

    setEntryError("");
    setEntrySuccess(null);

    const trimmed = prediction.trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
      setEntryError("Enter a price with up to 2 decimal places.");
      return;
    }

    const price = Number(trimmed);
    if (!Number.isFinite(price) || price <= 0) {
      setEntryError("Enter a valid positive price.");
      return;
    }

    const predictionPriceCents = Math.round(price * 100);

    setEntryBusy("Confirming…");
    try {
      const result = await confirmEntryWithPasskey({
        poolAddress: state.pool.poolAddress,
        roundId: state.pool.round.roundId,
        predictionPriceCents,
      });

      setState((current) => current ? {
        ...current,
        pool: {
          ...current.pool,
          round: {
            ...current.pool.round,
            entryCount: result.after.entryCount,
            totalStakeRaw: result.after.totalStakeRaw,
            totalStakeUsdc: result.after.totalStakeUsdc,
            escrowRemainingRaw: result.after.escrowRemainingRaw,
            escrowRemainingUsdc: result.after.escrowRemainingUsdc,
          },
        },
      } : current);

      setEntrySuccess({
        ticketId: result.ticketId,
        entryTxHash: result.entryTxHash,
        explorerUrl: result.explorerUrl,
        approvalTxHash: result.approvalTxHash,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Passkey verification failed.";
      if (message === "authentication_required" || message === "invalid_session" || message === "session_expired") {
        setEntryError("Your EXTREMA session is locked or expired. Reconnect your wallet, then try again.");
      } else if (message === "entry_insufficient_usdc") {
        setEntryError("You need at least 1 USDC in your EXTREMA wallet to enter.");
      } else if (message === "entry_already_entered") {
        setEntryError("This EXTREMA wallet has already entered this round.");
      } else if (message === "entry_price_taken") {
        setEntryError("That exact price has already been taken. Choose another price.");
      } else if (message === "entry_round_not_available") {
        setEntryError("Predictions are no longer available for this round.");
      } else {
        setEntryError(message);
      }
    } finally {
      setEntryBusy("");
    }
  }

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

            <label className="wf-field">
              Your predicted {pool.direction === "HIGH" ? "high" : "low"} price
              <input
                inputMode="decimal"
                placeholder="e.g. 68420.50"
                value={prediction}
                onChange={(event) => {
                  setPrediction(event.target.value);
                  setEntryError("");
                  setEntrySuccess(null);
                }}
                disabled={!pool.round.canEnter || Boolean(entryBusy)}
              />
            </label>

            <p>
              Confirm this prediction with Touch ID, Face ID, or your device passcode.
              Once approved, EXTREMA will submit the 1 USDC entry automatically.
            </p>

            <button
              className="wf-action"
              type="button"
              onClick={handleAuthorizeEntry}
              disabled={!pool.round.canEnter || Boolean(entryBusy)}
            >
              {entryBusy || "Confirm prediction · 1 USDC"}
            </button>

            {!pool.round.canEnter && (
              <p className="wf-message">Predictions are closed for this round.</p>
            )}

            {entryError && (
              <p className="wf-message">
                {entryError}{" "}
                {(entryError.includes("session") || entryError.includes("locked")) && (
                  <Link href="/wallet">Reconnect wallet</Link>
                )}
              </p>
            )}

            {entrySuccess && (
              <div className="wf-message">
                <p><b>Prediction confirmed.</b> Ticket #{entrySuccess.ticketId} was minted on Arc Testnet.</p>
                <p>
                  <a href={entrySuccess.explorerUrl} target="_blank" rel="noreferrer">
                    View transaction on ArcScan
                  </a>
                </p>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
