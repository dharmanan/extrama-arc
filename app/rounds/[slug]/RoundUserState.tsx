"use client";

import Link from "next/link";
import { formatUsd } from "../../lib/data";
import { useDemoState } from "../../demo-state";

export default function RoundUserState({ poolSlug }: { poolSlug: string }) {
  const { wallet, getTicketForPool, hasEnteredPool } = useDemoState();
  const entered = hasEnteredPool(poolSlug);
  const ticket = entered ? getTicketForPool(poolSlug) : undefined;

  if (wallet.status !== "ready") {
    return (
      <section className="wf-card">
        <small>YOUR POSITION</small>
        <p>Wallet is locked or disconnected.</p>
        <Link className="wf-action" href="/wallet">Open wallet</Link>
      </section>
    );
  }

  if (!ticket) {
    return (
      <section className="wf-card">
        <small>YOUR POSITION</small>
        <p>You have not entered this pool.</p>
        <Link className="wf-action" href={`/pools/${poolSlug}`}>Make a prediction</Link>
      </section>
    );
  }

  return (
    <section className="wf-card">
      <small>YOUR POSITION</small>
      <strong>{formatUsd(ticket.prediction)}</strong>
      <p>Ticket #{ticket.tokenId} · {ticket.status}</p>
      <Link className="wf-action" href="/tickets">View ticket</Link>
    </section>
  );
}
