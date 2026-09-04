import Link from "next/link";
import { assetConfigs, formatUsd } from "./lib/data";
import type { Asset, Pool, Ticket } from "./lib/domain";

export function ProductHeader() {
  return (
    <header className="wf-header">
      <Link href="/" className="wf-brand">EXTREMA</Link>
      <nav>
        <Link href="/pools">Pools</Link>
        <Link href="/leaderboard">Leaderboard</Link>
        <Link href="/how-it-works">How it works</Link>
        <Link href="/tickets">My Tickets</Link>
      </nav>
      <Link href="/wallet" className="wf-action">Wallet</Link>
    </header>
  );
}

export function AssetMark({ asset }: { asset: Asset }) {
  const item = assetConfigs[asset];
  return (
    <span className="wf-asset-mark">
      <img src={item.brandSrc} alt="" />
      <span>{asset}</span>
    </span>
  );
}

export function PoolSummary({ pool }: { pool: Pool }) {
  return (
    <article className="wf-card">
      <div className="wf-row">
        <AssetMark asset={pool.asset} />
        <span>{pool.cadence} · {pool.direction}</span>
      </div>
      <strong>{formatUsd(pool.referencePrice)}</strong>
      <small>Reference price</small>
      <dl className="wf-stats">
        <div><dt>{pool.players}</dt><dd>Players</dd></div>
        <div><dt>{pool.poolSizeUsdc} USDC</dt><dd>Pool</dd></div>
      </dl>
      <Link href={`/pools/${pool.slug}`} className="wf-action">Open pool</Link>
    </article>
  );
}

export function TicketSummary({ ticket }: { ticket: Ticket }) {
  return (
    <article className="wf-card">
      <div className="wf-row">
        <AssetMark asset={ticket.asset} />
        <span>{ticket.status}</span>
      </div>
      <h3>{ticket.asset} · {ticket.cadence} {ticket.direction}</h3>
      <strong>{formatUsd(ticket.prediction)}</strong>
      <p>Ticket #{ticket.tokenId} · Round #{ticket.roundId} · 1 USDC</p>
      {ticket.claimableUsdc > 0 && <p><b>{ticket.claimableUsdc} USDC claimable</b></p>}
      <Link href={`/results/${ticket.roundId}`} className="wf-action">View round</Link>
    </article>
  );
}
