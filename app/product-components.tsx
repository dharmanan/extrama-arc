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
          ? `${shortAddress(wallet.address)}${onchainUsdc !== null ? ` · ${onchainUsdc} USDC` : ""}`
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

export function PoolSummary({ pool }: { pool: LivePool }) {
  return (
    <article className="wf-card">
      <div className="wf-row">
        <AssetMark asset={pool.asset} />
        <span>{titleCase(pool.cadence)} · {titleCase(pool.direction)}</span>
      </div>

      <p>Round <b>#{pool.round.roundId}</b></p>

      <dl className="wf-stats">
        <div><dt>{formatEntryCount(pool.round.entryCount)}</dt><dd>Entries</dd></div>
        <div><dt>{formatUsdc(pool.round.totalStakeUsdc)}</dt><dd>Prize pool</dd></div>
      </dl>

      <p><b>{humanRoundStatus(pool.round.contractStatus)}</b></p>
      <p>
        Closes {formatLocalDateTime(pool.round.entryCloseAt)}
        {pool.round.canEnter ? ` · ${formatTimeUntil(pool.round.entryCloseAt)}` : ""}
      </p>

      <Link href={`/pools/${pool.slug}`} className="wf-action">
        Make a prediction
      </Link>
    </article>
  );
}
