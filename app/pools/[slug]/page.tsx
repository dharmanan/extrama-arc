"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AssetMark, ProductHeader } from "../../product-components";
import { formatUsd, getPoolBySlug } from "../../lib/data";
import { useDemoState } from "../../demo-state";

export default function PoolDetailPage() {
  const params = useParams<{ slug: string }>();
  const pool = useMemo(() => getPoolBySlug(params.slug), [params.slug]);
  const { wallet, enterPrediction, getTicketForRound, hasEnteredRound, isPredictionTaken } = useDemoState();

  const initialValue = pool ? activePool.referencePrice.toFixed(2) : "0.00";
  const [prediction, setPrediction] = useState(initialValue);
  const [message, setMessage] = useState("");

  if (!pool) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main"><h1>Pool not found</h1><Link href="/pools">Back to pools</Link></section>
      </main>
    );
  }

  const activePool = pool;
  const numericPrediction = Number(prediction);
  const existingTicket = getTicketForRound(activePool.roundId);
  const alreadyEntered = hasEnteredRound(activePool.roundId);

  function nearbyAvailable() {
    const base = Number.isFinite(numericPrediction) ? numericPrediction : activePool.referencePrice;
    const offsets = [-0.02, -0.01, 0.01, 0.02, 0.05, -0.05];
    return offsets
      .map((offset) => Number((base + offset).toFixed(2)))
      .filter((value, index, values) =>
        value >= activePool.predictionMin &&
        value <= activePool.predictionMax &&
        !isPredictionTaken(activePool.roundId, value) &&
        values.indexOf(value) === index,
      )
      .slice(0, 4);
  }

  function handleSubmit() {
    setMessage("");
    const result = enterPrediction(activePool.slug, numericPrediction);
    setMessage(result.message);
  }

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <Link href="/pools">← Back to pools</Link>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <AssetMark asset={activePool.asset} />
            <h1>{activePool.asset} · {activePool.cadence} {activePool.direction}</h1>
            <p>Status: <b>{activePool.status}</b></p>
            <p>Reference price: <b>{formatUsd(activePool.referencePrice)}</b></p>
            <p>Official source: <b>{activePool.source}</b></p>
            <p>Symbol: <b>{activePool.sourceSymbol}</b></p>
            <p>Entry closes: {activePool.entryCloseAt}</p>
            <p>Observation: {activePool.observationStartAt} → {activePool.observationEndAt}</p>
            <p>Current pool: {activePool.poolSizeUsdc} USDC · {activePool.players} players</p>
            <Link href={`/rounds/${activePool.slug}`} className="wf-action">View live round</Link>
          </section>

          <section className="wf-panel">
            <h2>Make a prediction</h2>
            <p>Every entry costs exactly 1 USDC. The same wallet can enter this round once, and the same exact price cannot be taken twice.</p>

            {wallet.status !== "ready" && (
              <p><b>Wallet required.</b> <Link href="/wallet">Create or connect a wallet</Link>.</p>
            )}

            {alreadyEntered && existingTicket ? (
              <div className="wf-card">
                <strong>You already entered this pool.</strong>
                <p>Prediction: {formatUsd(existingTicket.prediction)}</p>
                <p>Ticket #{existingTicket.tokenId}</p>
                <Link className="wf-action" href="/tickets">View my tickets</Link>
              </div>
            ) : (
              <>
                <label className="wf-field">
                  Prediction (USD)
                  <input
                    value={prediction}
                    onChange={(event) => setPrediction(event.target.value)}
                    inputMode="decimal"
                  />
                </label>

                <p>
                  Allowed demo range: {formatUsd(activePool.predictionMin)} – {formatUsd(activePool.predictionMax)}
                </p>

                {Number.isFinite(numericPrediction) && isPredictionTaken(activePool.roundId, Number(numericPrediction.toFixed(2))) && (
                  <p><b>{formatUsd(numericPrediction)} is already taken.</b></p>
                )}

                <div className="wf-tabs">
                  {nearbyAvailable().map((value) => (
                    <button
                      className="wf-filter"
                      key={value}
                      type="button"
                      onClick={() => setPrediction(value.toFixed(2))}
                    >
                      {formatUsd(value)}
                    </button>
                  ))}
                </div>

                <p>NFT ticket: {activePool.asset} · {activePool.cadence} {activePool.direction} · Round #{activePool.roundId}</p>
                <p>Wallet balance: {wallet.status === "ready" ? `${wallet.balanceUsdc.toFixed(2)} USDC` : "—"}</p>

                <button
                  className="wf-action"
                  type="button"
                  onClick={handleSubmit}
                  disabled={activePool.status !== "ENTRY_OPEN" || wallet.status !== "ready"}
                >
                  Confirm prediction · 1 USDC
                </button>

                {message && <p><b>{message}</b></p>}
              </>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
