"use client";

import Link from "next/link";
import { ProductHeader, TicketSummary } from "../product-components";
import { shortAddress, useDemoState } from "../demo-state";

export default function TicketsPage() {
  const { wallet, tickets } = useDemoState();

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>{wallet.address ? shortAddress(wallet.address) : "NO WALLET"}</p>
        <h1>My NFT Tickets</h1>

        {wallet.status !== "ready" ? (
          <section className="wf-panel wf-section">
            <p>Create or connect a wallet to use ticket ownership and claim actions.</p>
            <Link className="wf-action" href="/wallet">Open wallet</Link>
          </section>
        ) : (
          <>
            <p>Every prediction entry becomes a unique ticket. Winning ticket ownership controls the claim right.</p>
            <p>{tickets.length} tickets in demo wallet.</p>
            <div className="wf-grid-3 wf-section">
              {tickets.map((ticket) => <TicketSummary ticket={ticket} key={ticket.tokenId} />)}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
