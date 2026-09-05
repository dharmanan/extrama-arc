"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AssetMark, ProductHeader } from "../product-components";
import {
  backendApi,
  isAuthSessionError,
  type OwnedTicket,
  type OwnedTicketsResponse,
  type RefundExecutionMode,
  type ClaimExecutionMode,
} from "../lib/backend-api";
import { humanRoundStatus } from "../lib/display";
import {
  authenticatePasskey,
  confirmClaimWithPasskey,
  confirmExternalClaimReceipt,
  confirmExternalRefundReceipt,
  confirmRefundWithPasskey,
  confirmTicketTransferWithPasskey,
} from "../lib/passkey-client";
import {
  getOwnerChainId,
  sendOwnerTransaction,
  waitForOwnerTransactionReceipt,
} from "../lib/owner-wallet";
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

function isRefundEligible(ticket: OwnedTicket) {
  return ticket.roundStatus === "CANCELLED" && !ticket.isRefunded;
}

function isClaimEligible(ticket: OwnedTicket) {
  return (
    ticket.roundStatus === "SETTLED" &&
    ticket.placement > 0 &&
    !ticket.isClaimed &&
    BigInt(ticket.claimableRaw) > 0n
  );
}

const ARC_TESTNET_CHAIN_ID = 5042002;

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
  const [refundTicketKey, setRefundTicketKey] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState("");
  const [refundStatusText, setRefundStatusText] = useState("");
  const [refundSuccess, setRefundSuccess] = useState<{
    executionMode: RefundExecutionMode;
    explorerUrl: string;
  } | null>(null);

  const [claimTicketKey, setClaimTicketKey] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState("");
  const [claimStatusText, setClaimStatusText] = useState("");
  const [claimSuccess, setClaimSuccess] = useState<{
    executionMode: ClaimExecutionMode;
    explorerUrl: string;
    amountRaw: string;
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
      state?.backendWallet.wallet.address &&
      destinationAddress.toLowerCase() === state.backendWallet.wallet.address.toLowerCase()
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

  function openRefund(ticket: OwnedTicket) {
    setRefundTicketKey(ticketKey(ticket));
    setRefundSuccess(null);
    setError("");
  }

  function cancelRefund() {
    setRefundTicketKey(null);
    setRefundBusy("");
    setRefundStatusText("");
  }

  async function handleRefund(ticket: OwnedTicket) {
    const key = ticketKey(ticket);
    setRefundBusy(key);
    setError("");
    setRefundStatusText("Confirming with passkey...");

    try {
      const outcome = await confirmRefundWithPasskey({
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        roundId: ticket.roundId,
      });

      if (outcome.executionMode === "BACKEND_WALLET") {
        setRefundSuccess({
          executionMode: "BACKEND_WALLET",
          explorerUrl: outcome.result.explorerUrl,
        });
      } else {
        if (
          !isConnected ||
          !ownerAddress ||
          ownerAddress.toLowerCase() !== outcome.currentOwner.toLowerCase()
        ) {
          throw new Error(
            `Connect wallet ${outcome.currentOwner} in your browser wallet to complete this refund.`,
          );
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error("Switch your connected wallet to Arc Testnet (chain 5042002).");
        }

        setRefundStatusText("Waiting for wallet transaction...");
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setRefundStatusText("Waiting for transaction confirmation...");
        await waitForOwnerTransactionReceipt(txHash);

        setRefundStatusText("Verifying refund receipt...");
        const result = await confirmExternalRefundReceipt(outcome.actionId, txHash);

        setRefundSuccess({
          executionMode: "EXTERNAL_OWNER",
          explorerUrl: result.explorerUrl,
        });
      }

      setRefundTicketKey(null);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Refund failed.");
      }
    } finally {
      setRefundBusy("");
      setRefundStatusText("");
    }
  }


  function openClaim(ticket: OwnedTicket) {
    setClaimTicketKey(ticketKey(ticket));
    setClaimSuccess(null);
    setError("");
  }

  function cancelClaim() {
    setClaimTicketKey(null);
    setClaimBusy("");
    setClaimStatusText("");
  }

  async function handleClaim(ticket: OwnedTicket) {
    const key = ticketKey(ticket);
    setClaimBusy(key);
    setError("");
    setClaimStatusText("Confirming with passkey...");

    try {
      const outcome = await confirmClaimWithPasskey({
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        roundId: ticket.roundId,
      });

      if (outcome.executionMode === "BACKEND_WALLET") {
        setClaimSuccess({
          executionMode: "BACKEND_WALLET",
          explorerUrl: outcome.result.explorerUrl,
          amountRaw: outcome.result.amountRaw,
        });
      } else {
        if (
          !isConnected ||
          !ownerAddress ||
          ownerAddress.toLowerCase() !== outcome.currentOwner.toLowerCase()
        ) {
          throw new Error(
            `Connect wallet ${outcome.currentOwner} in your browser wallet to complete this reward claim.`,
          );
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error("Switch your connected wallet to Arc Testnet (chain 5042002).");
        }

        setClaimStatusText("Waiting for wallet transaction...");
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setClaimStatusText("Waiting for transaction confirmation...");
        await waitForOwnerTransactionReceipt(txHash);

        setClaimStatusText("Verifying reward receipt...");
        const result = await confirmExternalClaimReceipt(outcome.actionId, txHash);

        setClaimSuccess({
          executionMode: "EXTERNAL_OWNER",
          explorerUrl: result.explorerUrl,
          amountRaw: result.amountRaw,
        });
      }

      setClaimTicketKey(null);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Reward claim failed.");
      }
    } finally {
      setClaimBusy("");
      setClaimStatusText("");
    }
  }

  function renderTicketCard(ticket: OwnedTicket, options: { showTransfer: boolean }) {
    const key = ticketKey(ticket);
    const transferOpen = transferTicketKey === key;
    const refundOpen = refundTicketKey === key;
    const refundEligible = isRefundEligible(ticket);
    const claimOpen = claimTicketKey === key;
    const claimEligible = isClaimEligible(ticket);

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
          {options.showTransfer && (
            <button
              className="wf-action"
              type="button"
              onClick={() => openTransfer(ticket)}
              disabled={Boolean(transferBusy) || Boolean(refundBusy) || Boolean(claimBusy)}
            >
              Transfer NFT
            </button>
          )}
          {refundEligible && (
            <button
              className="wf-action"
              type="button"
              onClick={() => openRefund(ticket)}
              disabled={Boolean(transferBusy) || Boolean(refundBusy)}
            >
              Claim refund
            </button>
          )}
          {claimEligible && (
            <button
              className="wf-action"
              type="button"
              onClick={() => openClaim(ticket)}
              disabled={Boolean(transferBusy) || Boolean(refundBusy) || Boolean(claimBusy)}
            >
              Claim reward
            </button>
          )}
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

        {claimOpen && (
          <div className="wf-section">
            <p>
              This ticket is a winning NFT. The current owner (<code>{ticket.owner}</code>) can
              claim <b>{ticket.claimableUsdc} USDC</b> once. This requires a fresh passkey confirmation
              {!options.showTransfer ? " and a transaction from your connected wallet" : ""}.
            </p>
            <div className="wf-row">
              <button
                className="wf-action"
                type="button"
                onClick={() => void handleClaim(ticket)}
                disabled={Boolean(claimBusy)}
              >
                {claimBusy === key ? claimStatusText || "Confirming reward..." : "Confirm reward"}
              </button>
              <button
                className="wf-action"
                type="button"
                onClick={cancelClaim}
                disabled={Boolean(claimBusy)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {refundOpen && (
          <div className="wf-section">
            <p>
              This round was cancelled. The current NFT owner (<code>{ticket.owner}</code>) can
              claim a 1 USDC refund once. This requires a fresh passkey confirmation
              {!options.showTransfer ? " and a transaction from your connected wallet" : ""}.
            </p>
            <div className="wf-row">
              <button
                className="wf-action"
                type="button"
                onClick={() => void handleRefund(ticket)}
                disabled={Boolean(refundBusy)}
              >
                {refundBusy === key ? refundStatusText || "Confirming refund..." : "Confirm refund"}
              </button>
              <button
                className="wf-action"
                type="button"
                onClick={cancelRefund}
                disabled={Boolean(refundBusy)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </article>
    );
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

        {claimSuccess && (
          <section className="wf-panel wf-section">
            <h2>Reward claimed</h2>
            <p>
              {(Number(claimSuccess.amountRaw) / 1_000_000).toLocaleString(undefined, {
                maximumFractionDigits: 6,
              })} USDC has been sent to the ticket&apos;s current owner.
            </p>
            <a
              className="wf-action"
              href={claimSuccess.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              Verify transaction
            </a>
          </section>
        )}

        {refundSuccess && (
          <section className="wf-panel wf-section">
            <h2>Refund claimed</h2>
            <p>1 USDC has been refunded to the ticket&apos;s current owner.</p>
            <a
              className="wf-action"
              href={refundSuccess.explorerUrl}
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

        {!loading &&
          state &&
          state.backendWallet.ticketCount === 0 &&
          (!state.ownerWallet || state.ownerWallet.ticketCount === 0) && (
          <section className="wf-panel wf-section">
            <h2>No tickets yet</h2>
            <p>Your wallet does not currently own an EXTREMA prediction ticket.</p>
            <Link className="wf-action" href="/pools">Browse pools</Link>
          </section>
        )}

        {!loading && state && state.backendWallet.ticketCount > 0 && (
          <>
            <p>
              <b>{state.backendWallet.ticketCount}</b> onchain{" "}
              {state.backendWallet.ticketCount === 1 ? "ticket" : "tickets"} · Arc Testnet block{" "}
              {state.backendWallet.chain.blockNumber}
            </p>
            <div className="wf-grid-3 wf-section">
              {state.backendWallet.tickets.map((ticket) =>
                renderTicketCard(ticket, { showTransfer: true }),
              )}
            </div>
          </>
        )}

        {!loading && state?.ownerWallet && state.ownerWallet.ticketCount > 0 && (
          <>
            <h2>Tickets held by your connected wallet</h2>
            <p>
              These tickets are owned directly by <code>{state.ownerWallet.wallet.address}</code>,
              not your EXTREMA-managed wallet. Reward claims and refunds for these tickets are
              sent from your connected wallet, not the backend.
            </p>
            <div className="wf-grid-3 wf-section">
              {state.ownerWallet.tickets.map((ticket) =>
                renderTicketCard(ticket, { showTransfer: false }),
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
