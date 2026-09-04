import { ProductHeader, TicketSummary } from "../product-components";
import { getTicketsForWallet } from "../lib/data";

export default function TicketsPage() {
  const tickets = getTicketsForWallet();

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>0x3aF...92E1</p>
        <h1>My NFT Tickets</h1>
        <p>Every prediction entry becomes a unique ticket. Winning ticket ownership controls the claim right.</p>
        <div className="wf-grid-3 wf-section">
          {tickets.map((ticket) => <TicketSummary ticket={ticket} key={ticket.tokenId} />)}
        </div>
      </section>
    </main>
  );
}
