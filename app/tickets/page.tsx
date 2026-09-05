"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AssetMark, ProductHeader } from "../product-components";
import { backendApi, isAuthSessionError, type OwnedTicket, type OwnedTicketsResponse } from "../lib/backend-api";
import { humanRoundStatus } from "../lib/display";
import { authenticatePasskey } from "../lib/passkey-client";
import { useAccount } from "wagmi";

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
  const { address: ownerAddress, isConnected } = useAccount();
  const [state, setState] = useState<OwnedTicketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState("");

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const result = await backendApi.wallet.tickets();
      setState(result);
      setError("");
      setAuthRequired(false);
    } catch (cause) {
      setState(null);
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setAuthRequired(false);
        setError(cause instanceof Error ? cause.message : "Unable to load tickets.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  async function handleAuthenticate() {
    if (!ownerAddress) return;

    setAuthBusy("Authenticating with passkey...");
    setError("");
    try {
      await authenticatePasskey(ownerAddress);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Passkey authentication failed.");
      }
    } finally {
      setAuthBusy("");
    }
  }

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <h1>My NFT Tickets</h1>
        <p>These are the prediction tickets currently owned by your EXTREMA wallet on Arc Testnet.</p>

        {loading && <p>Loading your onchain tickets…</p>}

        {!loading && authRequired && (
          <section className="wf-panel wf-section">
            <h2>Session expired</h2>
            <p>Authenticate with your passkey to load your onchain tickets.</p>
            {isConnected && ownerAddress ? (
              <button
                className="wf-action"
                type="button"
                onClick={handleAuthenticate}
                disabled={Boolean(authBusy)}
              >
                {authBusy || "Authenticate with passkey"}
              </button>
            ) : (
              <Link className="wf-action" href="/wallet">Connect owner wallet</Link>
            )}
          </section>
        )}

        {!loading && !authRequired && error && (
          <section className="wf-panel wf-section">
            <h2>Tickets unavailable</h2>
            <p>We could not read your tickets from Arc Testnet.</p>
            <button className="wf-action" type="button" onClick={() => void loadTickets()}>
              Try again
            </button>
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
