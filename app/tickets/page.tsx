"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AssetMark, ProductHeader } from "../product-components";
import { backendApi, type OwnedTicket, type OwnedTicketsResponse } from "../lib/backend-api";
import { humanRoundStatus } from "../lib/display";

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatPrediction(value: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function ticketState(ticket: OwnedTicket) {
  if (ticket.isClaimed) return "Reward claimed";
  if (ticket.isRefunded) return "Refunded";
  if (ticket.roundStatus === "SETTLED" && ticket.placement > 0) {
    return `Winner · #${ticket.placement}`;
  }
  return humanRoundStatus(ticket.roundStatus);
}

export default function TicketsPage() {
  const [state, setState] = useState<OwnedTicketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    backendApi.wallet.tickets()
      .then((result) => {
        if (cancelled) return;
        setState(result);
        setError("");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState(null);
        const message = cause instanceof Error ? cause.message : "Unable to load tickets.";
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <h1>My NFT Tickets</h1>
        <p>These are the prediction tickets currently owned by your EXTREMA wallet on Arc Testnet.</p>

        {loading && <p>Loading your onchain tickets…</p>}

        {!loading && error && (
          <section className="wf-panel wf-section">
            <h2>Wallet access required</h2>
            <p>
              {error === "authentication_required" || error === "session_expired"
                ? "Reconnect your EXTREMA wallet to read ticket ownership."
                : "We could not read your tickets from Arc Testnet."}
            </p>
            <Link className="wf-action" href="/wallet">Open wallet</Link>
          </section>
        )}

        {!loading && state && state.ticketCount === 0 && (
          <section className="wf-panel wf-section">
            <h2>No tickets yet</h2>
            <p>Your wallet does not currently own an EXTREMA prediction ticket.</p>
            <Link className="wf-action" href="/pools">Browse pools</Link>
          </section>
        )}

        {!loading && state && state.ticketCount > 0 && (
          <>
            <p>
              <b>{state.ticketCount}</b> onchain {state.ticketCount === 1 ? "ticket" : "tickets"} ·
              Arc Testnet block {state.chain.blockNumber}
            </p>
            <div className="wf-grid-3 wf-section">
              {state.tickets.map((ticket) => (
                <article className="wf-card" key={`${ticket.ticketAddress}:${ticket.tokenId}`}>
                  <div className="wf-row">
                    <AssetMark asset={ticket.asset} />
                    <span>{ticketState(ticket)}</span>
                  </div>

                  <h3>
                    {ticket.asset} · {titleCase(ticket.cadence)} {titleCase(ticket.direction)}
                  </h3>

                  <strong>{formatPrediction(ticket.predictionPrice)}</strong>
                  <p>
                    Ticket #{ticket.tokenId} · Round #{ticket.roundId} · Entry #{ticket.entrySequence}
                  </p>
                  <p>Stake: 1 USDC</p>

                  {Number(ticket.claimableUsdc) > 0 && !ticket.isClaimed && (
                    <p><b>{ticket.claimableUsdc} USDC claimable</b></p>
                  )}

                  <div className="wf-row">
                    <Link className="wf-action" href={`/rounds/${ticket.slug}`}>
                      View round
                    </Link>
                    <a
                      className="wf-action"
                      href={ticket.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Verify NFT
                    </a>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
