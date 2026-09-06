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

function formatCountdown(ms: number, locale: "en" | "tr") {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(locale === "tr" ? `${days}g` : `${days}d`);
  if (days > 0 || hours > 0) parts.push(locale === "tr" ? `${hours}sa` : `${hours}h`);
  parts.push(locale === "tr" ? `${minutes}dk` : `${minutes}m`);
  parts.push(locale === "tr" ? `${seconds}sn` : `${seconds}s`);
  return parts.join(" ");
}

export function RoundCountdown({
  entryOpenAt,
  entryCloseAt,
  observationStartAt,
  observationEndAt,
}: {
  entryOpenAt: string;
  entryCloseAt: string;
  observationStartAt: string;
  observationEndAt: string;
}) {
  const { locale } = useLocale();
  const t = useCopy();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const openAt = new Date(entryOpenAt).getTime();
  const closeAt = new Date(entryCloseAt).getTime();
  const observationStart = new Date(observationStartAt).getTime();
  const observationEnd = new Date(observationEndAt).getTime();

  let label: string = t.observationEnded;
  let target: number | null = null;

  if (now < openAt) {
    label = t.predictionsStartIn;
    target = openAt;
  } else if (now < closeAt) {
    label = t.predictionsCloseIn;
    target = closeAt;
  } else if (now < observationStart) {
    label = t.observationStartsIn;
    target = observationStart;
  } else if (now < observationEnd) {
    label = t.observationEndsIn;
    target = observationEnd;
  }

  return (
    <p className="wf-message" style={{ fontVariantNumeric: "tabular-nums" }}>
      <b>{label}</b>
      {target !== null ? <> · {formatCountdown(target - now, locale)}</> : null}
    </p>
  );
}

function poolStatusLabel(pool: LivePool, locale: "en" | "tr") {
  if (pool.round.canEnter) {
    return locale === "tr" ? "Tahminler açık" : "Predictions open";
  }

  return locale === "tr" ? "Tahminler kapalı" : "Predictions closed";
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
            {pool.market.available && pool.market.source ? ` · ${pool.market.source}` : ""}
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
      {pool.round.canEnter && (
        <p>{t.closes} {formatLocalDateTime(pool.round.entryCloseAt, locale)}</p>
      )}

      <Link href={`/pools/${pool.slug}`} className="wf-action">
        {pool.round.canEnter ? t.makePrediction : t.viewPool}
      </Link>
    </article>
  );
}
