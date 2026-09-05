"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AssetMark, ProductHeader } from "../product-components";
import {
  backendApi,
  isAuthSessionError,
  type OwnedTicket,
  type OwnedTicketsResponse,
} from "../lib/backend-api";
import { humanRoundStatus } from "../lib/display";
import {
  authenticatePasskey,
  confirmTicketTransferWithPasskey,
} from "../lib/passkey-client";
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

function ticketKey(ticket: OwnedTicket) {
  return `${ticket.ticketAddress}:${ticket.tokenId}`;
}

export default function TicketsPage() {
  const { address: ownerAddress, isConnected } = useAccount();
  const [state, setState] = useState<OwnedTicketsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState("");
  const [transferTicketKey, setTransferTicketKey] = useState<string | null>(null);
  const [transferAddress, setTransferAddress] = useState("");
  const [transferBusy, setTransferBusy] = useState("");
  const [transferSuccess, setTransferSuccess] = useState<{
    destinationAddress: string;
    explorerUrl: string;
  } | null>(null);

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

  function openTransfer(ticket: OwnedTicket) {
    setTransferTicketKey(ticketKey(ticket));
    setTransferAddress(ownerAddress ?? "");
    setTransferSuccess(null);
    setError("");
  }

  function cancelTransfer() {
    setTransferTicketKey(null);
    setTransferAddress("");
    setTransferBusy("");
  }

  async function handleTransfer(ticket: OwnedTicket) {
    const destinationAddress = transferAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
      setError("Enter a valid recipient wallet address.");
      return;
    }

    if (
      state?.wallet.address &&
      destinationAddress.toLowerCase() === state.wallet.address.toLowerCase()
    ) {
      setError("The recipient already owns this NFT.");
      return;
    }

    const key = ticketKey(ticket);
    setTransferBusy(key);
    setError("");

    try {
      const result = await confirmTicketTransferWithPasskey({
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        destinationAddress,
      });

      setTransferSuccess({
        destinationAddress: result.destinationAddress,
        explorerUrl: result.explorerUrl,
      });
      setTransferTicketKey(null);
      setTransferAddress("");
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "NFT transfer failed.");
      }
    } finally {
      setTransferBusy("");
    }
  }

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <h1>My NFT Tickets</h1>
        <p>These are the prediction tickets currently owned by your EXTREMA wallet on Arc Testnet.</p>

        {transferSuccess && (
          <section className="wf-panel wf-section">
            <h2>NFT transferred</h2>
            <p>
              The ticket and its future claim or refund right now belong to{" "}
              <code>{transferSuccess.destinationAddress}</code>.
            </p>
            <a
              className="wf-action"
              href={transferSuccess.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              Verify transaction
            </a>
          </section>
        )}

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
            <h2>Action unavailable</h2>
            <p>{error}</p>
            {state === null && (
              <button className="wf-action" type="button" onClick={() => void loadTickets()}>
                Try again
              </button>
            )}
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
              {state.tickets.map((ticket) => {
                const key = ticketKey(ticket);
                const transferOpen = transferTicketKey === key;

                return (
                  <article className="wf-card" key={key}>
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
                      <button
                        className="wf-action"
                        type="button"
                        onClick={() => openTransfer(ticket)}
                        disabled={Boolean(transferBusy)}
                      >
                        Transfer NFT
                      </button>
                    </div>

                    {transferOpen && (
                      <div className="wf-section">
                        <label className="wf-field">
                          Recipient wallet address
                          <input
                            value={transferAddress}
                            onChange={(event) => setTransferAddress(event.target.value)}
                            placeholder="0x..."
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                        <p>
                          Transferring this NFT also transfers any future claim or refund right.
                        </p>
                        <div className="wf-row">
                          <button
                            className="wf-action"
                            type="button"
                            onClick={() => void handleTransfer(ticket)}
                            disabled={Boolean(transferBusy)}
                          >
                            {transferBusy === key ? "Confirming transfer..." : "Confirm transfer"}
                          </button>
                          <button
                            className="wf-action"
                            type="button"
                            onClick={cancelTransfer}
                            disabled={Boolean(transferBusy)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
