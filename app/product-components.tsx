"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { assetConfigs } from "./lib/data";
import type { Asset } from "./lib/domain";
import { shortAddress, useDemoState } from "./demo-state";
import { backendApi, type LivePool } from "./lib/backend-api";
import { useCopy, useLocale } from "./i18n";
import {
  formatEntryCount,
  formatLocalDateTime,
  formatTimeUntil,
  formatUsdc,
  humanRoundStatus,
} from "./lib/display";

function formatHeaderUsdc(value: string, locale: "en" | "tr") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;

  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

export function ProductHeader() {
  const { wallet } = useDemoState();
  const { locale, setLocale } = useLocale();
  const t = useCopy();
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
        <Link href="/pools">{t.pools}</Link>
        <Link href="/leaderboard">{t.leaderboard}</Link>
        <Link href="/how-it-works">{t.howItWorks}</Link>
        <Link href="/tickets">{t.myTickets}</Link>
      </nav>
      <div className="wf-row" style={{ justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
        <div className="wf-row" aria-label="Language" style={{ gap: 4 }}>
          <button
            className="wf-filter"
            data-active={locale === "en"}
            type="button"
            onClick={() => setLocale("en")}
          >
            EN
          </button>
          <button
            className="wf-filter"
            data-active={locale === "tr"}
            type="button"
            onClick={() => setLocale("tr")}
          >
            TR
          </button>
        </div>
        <Link href="/wallet" className="wf-action">
          {wallet.status === "ready" && wallet.address
            ? `${shortAddress(wallet.address)}${onchainUsdc !== null ? ` · ${formatHeaderUsdc(onchainUsdc, locale)} USDC` : ""}`
            : t.createConnectWallet}
        </Link>
      </div>
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

function formatUsdPrice(value: string | null, locale: "en" | "tr") {
  if (value === null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function localizedCadence(value: LivePool["cadence"], locale: "en" | "tr") {
  if (locale === "tr") {
    if (value === "DAILY") return "Gün";
    if (value === "WEEKLY") return "Hafta";
    return "Çeyrek";
  }
  return titleCase(value);
}

function localizedDirection(value: LivePool["direction"], locale: "en" | "tr") {
  if (locale === "tr") return value === "HIGH" ? "Yüksek" : "Düşük";
  return titleCase(value);
}

function poolStatusLabel(pool: LivePool, locale: "en" | "tr") {
  if (pool.round.contractStatus === "ENTRY_OPEN" && !pool.round.canEnter) {
    return locale === "tr"
      ? "Tahminler kapandı · kilit bekleniyor"
      : "Predictions closed · awaiting lock";
  }
  return humanRoundStatus(pool.round.contractStatus, locale);
}

export function PoolSummary({ pool }: { pool: LivePool }) {
  const { locale } = useLocale();
  const t = useCopy();

  return (
    <article className="wf-card">
      <div className="wf-row">
        <AssetMark asset={pool.asset} />
        <span>{localizedCadence(pool.cadence, locale)} · {localizedDirection(pool.direction, locale)}</span>
      </div>

      <p>{t.round} <b>#{pool.round.roundId}</b></p>

      <dl className="wf-stats">
        <div>
          <dt>{pool.market.available ? formatUsdPrice(pool.market.markPrice, locale) : t.unavailable}</dt>
          <dd>
            {t.liveMark}
            {pool.market.available
              ? ` · ${pool.market.isSettlementSource ? t.liveSourceBinance : t.liveSourceFallback}`
              : ""}
          </dd>
        </div>
        <div>
          <dt>{formatUsdPrice(pool.round.lastPredictionPrice, locale)}</dt>
          <dd>{t.latestPrediction}</dd>
        </div>
      </dl>

      <dl className="wf-stats">
        <div><dt>{formatEntryCount(pool.round.entryCount, locale)}</dt><dd>{t.entries}</dd></div>
        <div><dt>{formatUsdc(pool.round.totalStakeUsdc, locale)}</dt><dd>{t.prizePool}</dd></div>
      </dl>

      <p><b>{poolStatusLabel(pool, locale)}</b></p>
      <p>
        {t.closes} {formatLocalDateTime(pool.round.entryCloseAt, locale)}
        {pool.round.canEnter ? ` · ${formatTimeUntil(pool.round.entryCloseAt, locale)}` : ""}
      </p>

      <Link href={`/pools/${pool.slug}`} className="wf-action">
        {pool.round.canEnter ? t.makePrediction : t.viewPool}
      </Link>
    </article>
  );
}
