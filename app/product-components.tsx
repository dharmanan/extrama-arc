"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { assetConfigs } from "./lib/data";
import type { Asset } from "./lib/domain";
import { shortAddress, useDemoState } from "./demo-state";
import { backendApi, type LivePool } from "./lib/backend-api";
import {
  formatEntryCount,
  formatLocalDateTime,
  formatTimeUntil,
  formatUsdc,
  humanRoundStatus,
} from "./lib/display";

function formatHeaderUsdc(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

export function ProductHeader() {
  const { wallet } = useDemoState();
  const [onchainUsdc, setOnchainUsdc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (wallet.status !== "ready" || !wallet.address) {
      setOnchainUsdc(null);
      return;
    }

    backendApi.wallet.chainState()
      .then((state) => {
        if (!cancelled) setOnchainUsdc(state.usdc.balanceFormatted);
      })
      .catch(() => {
        if (!cancelled) setOnchainUsdc(null);
      });

    return () => {
      cancelled = true;
    };
  }, [wallet.status, wallet.address]);

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
          ? `${shortAddress(wallet.address)}${onchainUsdc !== null ? ` · ${formatHeaderUsdc(onchainUsdc)} USDC` : ""}`
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

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatUsdPrice(value: string | null) {
  if (value === null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function poolStatusLabel(pool: LivePool) {
  if (pool.round.contractStatus === "ENTRY_OPEN" && !pool.round.canEnter) {
    return "Predictions closed · awaiting lock";
  }
  return humanRoundStatus(pool.round.contractStatus);
}

export function PoolSummary({ pool }: { pool: LivePool }) {
  return (
    <article className="wf-card">
      <div className="wf-row">
        <AssetMark asset={pool.asset} />
        <span>{titleCase(pool.cadence)} · {titleCase(pool.direction)}</span>
      </div>

      <p>Round <b>#{pool.round.roundId}</b></p>

      <dl className="wf-stats">
        <div>
          <dt>{pool.market.available ? formatUsdPrice(pool.market.markPrice) : "Unavailable"}</dt>
          <dd>Live mark · 1 min</dd>
        </div>
        <div>
          <dt>{formatUsdPrice(pool.round.lastPredictionPrice)}</dt>
          <dd>Latest prediction</dd>
        </div>
      </dl>

      <dl className="wf-stats">
        <div><dt>{formatEntryCount(pool.round.entryCount)}</dt><dd>Entries</dd></div>
        <div><dt>{formatUsdc(pool.round.totalStakeUsdc)}</dt><dd>Prize pool</dd></div>
      </dl>

      <p><b>{poolStatusLabel(pool)}</b></p>
      <p>
        Closes {formatLocalDateTime(pool.round.entryCloseAt)}
        {pool.round.canEnter ? ` · ${formatTimeUntil(pool.round.entryCloseAt)}` : ""}
      </p>

      <Link href={`/pools/${pool.slug}`} className="wf-action">
        {pool.round.canEnter ? "Make a prediction" : "View pool"}
      </Link>
    </article>
  );
}
