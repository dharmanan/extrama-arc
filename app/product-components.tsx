"use client";

import Link from "next/link";
import { assetConfigs, formatUsd } from "./lib/data";
import type { Asset, Pool, Ticket } from "./lib/domain";
import { shortAddress, useDemoState } from "./demo-state";

export function ProductHeader() {
  const { wallet } = useDemoState();

  return (
    <header className="wf-header">
      <Link href="/" className="wf-brand">EXTREMA</Link>
      <nav>
        <Link href="/pools">Pools</Link>
        <Link href="/leaderboard">Leaderboard</Link>
        <Link href="/how-it-works">How it works</Link>
        <Link href="/tickets">My Tickets</Link>
      </nav>
      <Link href="/wallet" className="wf-action">
        {wallet.status === "ready" && wallet.address
          ? `${shortAddress(wallet.address)} · ${wallet.balanceUsdc.toFixed(2)} USDC`
          : "Create / Connect Wallet"}
      </Link>
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
  const { hasEnteredPool } = useDemoState();
  const entered = hasEnteredPool(pool.slug);

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
      <p>Status: <b>{pool.status}</b>{entered ? " · You entered" : ""}</p>
      <Link href={`/pools/${pool.slug}`} className="wf-action">
        {entered ? "View entry" : "Open pool"}
      </Link>
    </article>
  );
}

export function TicketSummary({ ticket }: { ticket: Ticket }) {
  const { claimTicket } = useDemoState();
  const claimable = ticket.claimableUsdc > 0;

  function handleClaim() {
    const result = claimTicket(ticket.tokenId);
    window.alert(result.message);
  }

  return (
    <article className="wf-card">
      <div className="wf-row">
        <AssetMark asset={ticket.asset} />
        <span>{ticket.status}</span>
      </div>
      <h3>{ticket.asset} · {ticket.cadence} {ticket.direction}</h3>
      <strong>{formatUsd(ticket.prediction)}</strong>
      <p>Ticket #{ticket.tokenId} · Round #{ticket.roundId} · 1 USDC</p>
      {claimable && <p><b>{ticket.claimableUsdc} USDC claimable</b></p>}
      <div className="wf-row">
        <Link href={`/results/${ticket.roundId}`} className="wf-action">View round</Link>
        {claimable && <button className="wf-action" type="button" onClick={handleClaim}>Claim reward</button>}
      </div>
    </article>
  );
}
