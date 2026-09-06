"use client";

import Link from "next/link";
import { ProductHeader } from "../../../product-components";
import { assetConfigs } from "../../../lib/asset-config";
import { formatUsdc, humanRoundStatus } from "../../../lib/display";
import { useCopy, useLocale } from "../../../i18n";

export type LiveResult = {
  chain: { id: number; name: string; explorerUrl: string };
  pool: {
    slug: string; poolAddress: string; ticketAddress: string; asset: keyof typeof assetConfigs;
    direction: "HIGH" | "LOW"; cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
    source: string; sourceSymbol: string;
  };
  round: {
    roundId: number; contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
    entryOpenAt: string; entryCloseAt: string; observationStartAt: string; observationEndAt: string;
    entryCount: number; totalStakeRaw: string; totalStakeUsdc: string; escrowRemainingRaw: string;
    escrowRemainingUsdc: string; resolvedPriceCents: string; resolvedPrice: string | null; winnerTicketIds: string[];
  };
  winners: Array<{
    rank: number; tokenId: string; currentOwner: string; originalEntrant: string;
    predictionPriceCents: string; predictionPrice: string; distanceCents: string; distance: string;
    entrySequence: number; placement: number; isClaimed: boolean; claimableRaw: string; claimableUsdc: string;
  }>;
};

function formatUsd(value: string, locale: "en" | "tr") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(parsed);
}

function formatUtcDateTime(value: string, locale: "en" | "tr") {
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value)) + " UTC";
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function cadenceLabel(value: LiveResult["pool"]["cadence"], locale: "en" | "tr") {
  const labels = locale === "tr"
    ? { DAILY: "Gün", WEEKLY: "Hafta", QUARTERLY: "Çeyrek" }
    : { DAILY: "Daily", WEEKLY: "Weekly", QUARTERLY: "Quarterly" };
  return labels[value];
}

function directionLabel(value: LiveResult["pool"]["direction"], locale: "en" | "tr") {
  const labels = locale === "tr" ? { HIGH: "Yüksek", LOW: "Düşük" } : { HIGH: "High", LOW: "Low" };
  return labels[value];
}

function ResultUnavailable({ invalid }: { invalid: boolean }) {
  const t = useCopy();
  return (
    <main className="ex-pools ex-result">
      <ProductHeader />
      <div className="ex-shell ex-result__unavailable">
        <p className="ex-eyebrow">{t.result.eyebrow}</p>
        <h1 className="ex-display ex-display--md">{t.result.unavailable}</h1>
        {!invalid && <p className="ex-lede">{t.result.unavailableBody}</p>}
        <Link href="/pools" className="ex-pool__back">← {t.result.backToPools}</Link>
      </div>
    </main>
  );
}

export function ResultClient({ result, invalid = false }: { result: LiveResult | null; invalid?: boolean }) {
  const { locale } = useLocale();
  const t = useCopy();
  if (!result) return <ResultUnavailable invalid={invalid} />;

  const { pool, round, chain } = result;
  const settled = round.contractStatus === "SETTLED";
  const cancelled = round.contractStatus === "CANCELLED";
  const asset = assetConfigs[pool.asset];
  const title = settled ? t.result.complete : cancelled ? t.result.cancelled : t.result.pending;

  return (
    <main className="ex-pools ex-result">
      <ProductHeader />
      <div className="ex-shell">
        <Link href="/pools" className="ex-pool__back">← {t.result.backToPools}</Link>

        <section className="ex-result__head">
          <div className="ex-result__identity">
            <p className="ex-eyebrow">{t.result.eyebrow}</p>
            <span className="ex-pool__id">
              <img src={asset.brandSrc} alt="" />
              <span className="ex-pool__symbol">{pool.asset}</span>
              <span className="ex-pool__name">{asset.name}</span>
            </span>
            <h1 className="ex-display ex-display--xl">{title}</h1>
            <p className="ex-result__market">{cadenceLabel(pool.cadence, locale)} · {directionLabel(pool.direction, locale)} · {pool.sourceSymbol}</p>
            {settled && round.resolvedPrice ? (
              <div className="ex-result__price">
                <span>{t.result.resolvedPrice}</span>
                <strong className="ex-num">{formatUsd(round.resolvedPrice, locale)}</strong>
                <small>{directionLabel(pool.direction, locale)}</small>
              </div>
            ) : (
              <p className="ex-result__state" data-cancelled={cancelled}>{cancelled ? t.result.cancelledBody : t.result.pendingBody}</p>
            )}
          </div>

          <dl className="ex-result__facts">
            <div><dt>{t.result.round}</dt><dd className="ex-num">#{round.roundId}</dd></div>
            <div><dt>{t.result.entries}</dt><dd className="ex-num">{round.entryCount}</dd></div>
            <div><dt>{t.result.stake}</dt><dd className="ex-num">{formatUsdc(round.totalStakeUsdc, locale)}</dd></div>
            <div><dt>{t.result.window}</dt><dd><span suppressHydrationWarning>{formatUtcDateTime(round.observationStartAt, locale)} → {formatUtcDateTime(round.observationEndAt, locale)}</span></dd></div>
            <div><dt>{t.result.source}</dt><dd>{pool.source} · {pool.sourceSymbol}</dd></div>
            <div><dt>{t.result.status}</dt><dd>{humanRoundStatus(round.contractStatus, locale)}</dd></div>
          </dl>
        </section>

        {settled && result.winners.length > 0 && (
          <section className="ex-result__winners" aria-labelledby="result-winners">
            <div className="ex-result__section-head">
              <div><p className="ex-eyebrow">{t.result.winner}</p><h2 id="result-winners" className="ex-display ex-display--md">{t.result.winners}</h2></div>
              <p>{t.result.ticketCarriesClaim}</p>
            </div>
            <ol className="ex-winners">
              {result.winners.slice(0, 3).map((winner) => (
                <li key={winner.tokenId} className="ex-winner">
                  <span className="ex-winner__rank ex-num">{String(winner.rank).padStart(2, "0")}</span>
                  <div className="ex-winner__price"><span>{t.result.prediction}</span><strong className="ex-num">{formatUsd(winner.predictionPrice, locale)}</strong><small>{t.result.distance} · {formatUsd(winner.distance, locale)}</small></div>
                  <dl className="ex-winner__meta">
                    <div><dt>{t.result.ticket}</dt><dd className="ex-num">#{winner.tokenId}</dd></div>
                    <div><dt>{t.result.claimHolder}</dt><dd title={winner.currentOwner} className="ex-num">{shortAddress(winner.currentOwner)}</dd></div>
                    <div><dt>{t.result.entrant}</dt><dd title={winner.originalEntrant} className="ex-num">{shortAddress(winner.originalEntrant)}</dd></div>
                  </dl>
                  <div className="ex-winner__claim" data-claimed={winner.isClaimed}>
                    <span>{winner.isClaimed ? t.result.claimed : t.result.claimable}</span>
                    {!winner.isClaimed && <strong className="ex-num">{formatUsdc(winner.claimableUsdc, locale)}</strong>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {!settled && !cancelled && (
          <section className="ex-result__progress" aria-labelledby="result-progress">
            <div className="ex-result__section-head">
              <div>
                <p className="ex-eyebrow">{t.result.progress}</p>
                <h2 id="result-progress" className="ex-display ex-display--md">{t.result.pending}</h2>
              </div>
              <p>{t.result.pendingBody}</p>
            </div>
            <ol className="ex-progress-rail">
              <li><span className="ex-progress-rail__number">01</span><div><h3>{t.result.progressEntry}</h3><p>{t.result.progressEntryBody}</p></div></li>
              <li><span className="ex-progress-rail__number">02</span><div><h3>{t.result.progressObservation}</h3><p className="ex-num">{formatUtcDateTime(round.observationStartAt, locale)}<br />→ {formatUtcDateTime(round.observationEndAt, locale)}</p></div></li>
              <li><span className="ex-progress-rail__number">03</span><div><h3>{t.result.progressSettlement}</h3><p>{t.result.progressSettlementBody}</p></div></li>
              <li><span className="ex-progress-rail__number">04</span><div><h3>{t.result.progressResult}</h3><p>{t.result.progressResultBody}</p></div></li>
            </ol>
          </section>
        )}

        <div className="ex-result__actions">
          <a className="ex-btn ex-btn--ghost" href={`${chain.explorerUrl}/address/${pool.poolAddress}`} target="_blank" rel="noreferrer">{t.result.viewPoolOnArc}</a>
          {settled && <Link className="ex-btn ex-btn--ink" href={`/verify/${pool.slug}/${round.roundId}`}>{t.result.verifySettlement}</Link>}
          {cancelled ? <Link className="ex-btn ex-btn--ghost" href="/tickets">{t.result.refunds}</Link> : <Link className="ex-btn ex-btn--ghost" href="/tickets">{t.result.viewTickets}</Link>}
        </div>
      </div>
    </main>
  );
}
