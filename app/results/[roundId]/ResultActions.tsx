"use client";

import Link from "next/link";
import { useState } from "react";
import { useDemoState } from "../../demo-state";

export default function ResultActions({ roundId }: { roundId: number }) {
  const { wallet, tickets, claimTicket } = useDemoState();
  const [message, setMessage] = useState("");
  const ticket = tickets.find((item) => item.roundId === roundId && item.claimableUsdc > 0);
  const claimed = tickets.find((item) => item.roundId === roundId && item.status === "Claimed");

  if (wallet.status !== "ready") {
    return <Link className="wf-action" href="/wallet">Open wallet to claim</Link>;
  }

  if (ticket) {
    return (
      <div>
        <button
          className="wf-action"
          type="button"
          onClick={() => {
            const result = claimTicket(ticket.tokenId);
            setMessage(result.message);
          }}
        >
          Claim {ticket.claimableUsdc} USDC with NFT #{ticket.tokenId}
        </button>
        {message && <p className="wf-message">{message}</p>}
      </div>
    );
  }

  if (claimed) {
    return <p className="wf-message">Winning ticket #{claimed.tokenId} has already been claimed.</p>;
  }

  return <Link className="wf-action" href="/tickets">View my tickets</Link>;
}
