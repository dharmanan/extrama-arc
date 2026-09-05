"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader, RoundCountdown } from "../../product-components";
import { backendApi, type LiveRoundResponse } from "../../lib/backend-api";
import { confirmEntryWithPasskey } from "../../lib/passkey-client";
import { useCopy, useLocale } from "../../i18n";
import { applyBinanceLiveMarketToPool, readBinanceLiveMarket } from "../../lib/live-market";
import {
  formatEntryCount,
  formatLocalDateTime,
  formatUsdc,
  humanRoundStatus,
} from "../../lib/display";

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default function PoolDetailPage() {
  const params = useParams<{ slug: string }>();
  const { locale } = useLocale();
  const t = useCopy();
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
    let timer: ReturnType<typeof setInterval> | null = null;
    setLoading(true);

    async function refresh() {
      try {
        const [result, live] = await Promise.all([
          backendApi.rounds.get(params.slug),
          readBinanceLiveMarket(),
        ]);
        if (cancelled) return;
        setState({
          ...result,
          pool: applyBinanceLiveMarketToPool(result.pool, live),
        });
        setError("");
      } catch (err: unknown) {
        if (cancelled) return;
        setState(null);
        setError(err instanceof Error ? err.message : "Unable to read pool.");
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
      } else if (message === "entry_postcondition_failed") {
        setEntryError("The transaction may already have been confirmed on Arc. Do not try again yet; refresh the round state first.");
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
        <section className="wf-main"><p>{t.readingRounds}</p></section>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>{t.poolUnavailable}</h1>
          <p>{t.poolUnavailableBody}</p>
          <Link href="/pools">{t.backToPools}</Link>
        </section>
      </main>
    );
  }

  const { pool, chain } = state;

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <Link href="/pools">← {t.backToPools}</Link>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <AssetMark asset={pool.asset} />
            <h1>
              {pool.asset} · {titleCase(pool.cadence)} {titleCase(pool.direction)}
            </h1>

            <p>{t.round} <b>#{pool.round.roundId}</b></p>
            <p><b>{humanRoundStatus(pool.round.contractStatus, locale)}</b></p>
            <RoundCountdown
              entryOpenAt={pool.round.entryOpenAt}
              entryCloseAt={pool.round.entryCloseAt}
              observationStartAt={pool.round.observationStartAt}
              observationEndAt={pool.round.observationEndAt}
            />

            <p>{formatEntryCount(pool.round.entryCount, locale)}</p>
            <p>{t.prizePool}: <b>{formatUsdc(pool.round.totalStakeUsdc, locale)}</b></p>

            <dl className="wf-stats">
              <div>
                <dt>{pool.market.available && pool.market.markPrice ? `${Number(pool.market.markPrice).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : t.unavailable}</dt>
                <dd>{t.liveMark}</dd>
              </div>
              <div>
                <dt>{pool.round.lastPredictionPrice ? `${Number(pool.round.lastPredictionPrice).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</dt>
                <dd>{t.latestPrediction}</dd>
              </div>
            </dl>

            <h2>{t.roundTiming}</h2>
            <p>{t.predictionsOpenUntil} {formatLocalDateTime(pool.round.entryCloseAt, locale)}</p>
            <p>
              {t.observationRuns} {formatLocalDateTime(pool.round.observationStartAt, locale)}
              {" "}{t.to}{" "}{formatLocalDateTime(pool.round.observationEndAt, locale)}
            </p>

            <h2>{t.priceSource}</h2>
            <p><b>{pool.source}</b> · {pool.sourceSymbol}</p>

            <div className="wf-row">
              <a
                className="wf-action"
                href={`${chain.explorerUrl}/address/${pool.poolAddress}`}
                target="_blank"
                rel="noreferrer"
              >
                {t.verifyOnArc}
              </a>
              <Link href={`/rounds/${pool.slug}`} className="wf-action">{t.viewRound}</Link>
            </div>
          </section>

          <section className="wf-panel">
            <h2>{t.makePrediction}</h2>
            <p>{t.onePredictionCosts}</p>

            <label className="wf-field">
              {pool.direction === "HIGH" ? t.yourPredictedHigh : t.yourPredictedLow}
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

            <p>{t.confirmBiometric}</p>

            <button
              className="wf-action"
              type="button"
              onClick={handleAuthorizeEntry}
              disabled={!pool.round.canEnter || Boolean(entryBusy)}
            >
              {entryBusy || t.confirmPrediction}
            </button>

            {!pool.round.canEnter && (
              <p className="wf-message">{t.roundClosed}</p>
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
