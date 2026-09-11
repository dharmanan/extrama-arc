"use client";

import Link from "next/link";
import { ProductHeader } from "../../../product-components";
import { assetConfigs } from "../../../lib/asset-config";
import { formatUsdc, humanRoundStatus } from "../../../lib/display";
import { useCopy, useLocale } from "../../../i18n";
import type { HistoricalResultSnapshot } from "../../../lib/result-snapshot";

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
    marketPeriodStartAt: string | null; marketPeriodEndAt: string | null;
    marketResultCents: string | null; marketResult: string | null; marketResultExact: string | null; marketEvidenceSha256: string | null;
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

// One display model for both a full authoritative result and an Archive
// snapshot, so the page keeps the same hierarchy when the fresh result
// replaces the snapshot. A null field is a detail the snapshot does not know;
// it is omitted, never estimated.
type ResultDisplay = {
  explorerUrl: string;
  pool: {
    slug: string;
    poolAddress: string;
    asset: LiveResult["pool"]["asset"];
    direction: LiveResult["pool"]["direction"];
    cadence: LiveResult["pool"]["cadence"];
    source: string | null;
    sourceSymbol: string;
  };
  round: {
    roundId: number;
    contractStatus: LiveResult["round"]["contractStatus"];
    marketPeriodStartAt: string | null;
    marketPeriodEndAt: string | null;
    marketResult: string | null;
    entryCount: number;
    totalStakeUsdc: string;
  };
  winners: Array<{
    rank: number;
    tokenId: string;
    currentOwner: string;
    originalEntrant: string;
    predictionPrice: string;
    distance: string | null;
    isClaimed: boolean;
    claimableUsdc: string | null;
  }>;
};

function displayFromResult(result: LiveResult): ResultDisplay {
  return {
    explorerUrl: result.chain.explorerUrl,
    pool: {
      slug: result.pool.slug,
      poolAddress: result.pool.poolAddress,
      asset: result.pool.asset,
      direction: result.pool.direction,
      cadence: result.pool.cadence,
      source: result.pool.source,
      sourceSymbol: result.pool.sourceSymbol,
    },
    round: {
      roundId: result.round.roundId,
      contractStatus: result.round.contractStatus,
      marketPeriodStartAt: result.round.marketPeriodStartAt,
      marketPeriodEndAt: result.round.marketPeriodEndAt,
      marketResult: result.round.marketResult,
      entryCount: result.round.entryCount,
      totalStakeUsdc: result.round.totalStakeUsdc,
    },
    winners: result.winners.map((winner) => ({
      rank: winner.rank,
      tokenId: winner.tokenId,
      currentOwner: winner.currentOwner,
      originalEntrant: winner.originalEntrant,
      predictionPrice: winner.predictionPrice,
      distance: winner.distance,
      isClaimed: winner.isClaimed,
      claimableUsdc: winner.claimableUsdc,
    })),
  };
}

function centsToDollars(cents: bigint) {
  const whole = cents / BigInt(100);
  const fraction = (cents % BigInt(100)).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

function parseCents(value: string | null | undefined) {
  return typeof value === "string" && /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

function displayFromSnapshot(snapshot: HistoricalResultSnapshot): ResultDisplay | null {
  const round = snapshot.round;
  if (round.contractStatus === "NO_ROUND" || !assetConfigs[round.asset]) return null;
  const marketResultCents = parseCents(round.marketResultCents);
  return {
    explorerUrl: snapshot.explorerUrl,
    pool: {
      slug: round.slug,
      poolAddress: round.poolAddress,
      asset: round.asset,
      direction: round.direction,
      cadence: round.cadence,
      // The source name arrives with the fresh result; the symbol is the
      // asset's own configured Binance symbol.
      source: null,
      sourceSymbol: assetConfigs[round.asset].sourceSymbol,
    },
    round: {
      roundId: round.roundId,
      contractStatus: round.contractStatus,
      marketPeriodStartAt: round.marketPeriodStartAt || null,
      marketPeriodEndAt: round.marketPeriodEndAt || null,
      marketResult: marketResultCents !== null && round.marketResult ? round.marketResult : null,
      entryCount: round.entryCount,
      totalStakeUsdc: round.totalStakeUsdc,
    },
    winners: round.winners.map((winner) => {
      const prediction = parseCents(winner.predictionPriceCents);
      // Distance only when both exact cent values are known.
      const distance = prediction !== null && marketResultCents !== null
        ? centsToDollars(prediction >= marketResultCents ? prediction - marketResultCents : marketResultCents - prediction)
        : null;
      return {
        rank: winner.rank,
        tokenId: winner.tokenId,
        currentOwner: winner.currentOwner,
        originalEntrant: winner.originalEntrant,
        predictionPrice: winner.predictionPrice,
        distance,
        isClaimed: winner.claimed,
        // The claimable amount needs the authoritative read.
        claimableUsdc: null,
      };
    }),
  };
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
        <Link href="/archive" className="ex-pool__back">← {t.result.backToArchive}</Link>
      </div>
    </main>
  );
}

export function ResultClient({
  result,
  snapshot = null,
  invalid = false,
  refreshing = false,
  refreshFailed = false,
}: {
  result: LiveResult | null;
  snapshot?: HistoricalResultSnapshot | null;
  invalid?: boolean;
  refreshing?: boolean;
  refreshFailed?: boolean;
}) {
  const { locale } = useLocale();
  const t = useCopy();
  const view = result ? displayFromResult(result) : snapshot ? displayFromSnapshot(snapshot) : null;
  if (!view) return <ResultUnavailable invalid={invalid} />;

  const { pool, round } = view;
  const settled = round.contractStatus === "SETTLED";
  const cancelled = round.contractStatus === "CANCELLED";
  const settledEvidenceMissing = settled && !round.marketResult;
  const asset = assetConfigs[pool.asset];
  const title = settled ? t.result.complete : cancelled ? t.result.cancelled : t.result.pending;

  return (
    <main className="ex-pools ex-result">
      <ProductHeader />
      <div className="ex-shell">
        {refreshing && <span className="ex-route-progress" aria-hidden="true" />}
        <Link href="/archive" className="ex-pool__back">← {t.result.backToArchive}</Link>
        {(refreshing || refreshFailed) && (
          <p className="ex-result__refresh" data-failed={refreshFailed || undefined} role="status">
            {refreshFailed ? t.result.refreshFailed : t.result.refreshingFromArc}
          </p>
        )}

        <section className="ex-result__head" style={{ paddingBottom: "clamp(30px, 3.6vw, 48px)" }}>
          <div className="ex-result__identity">
            <p className="ex-eyebrow">{t.result.eyebrow}</p>
            <span className="ex-pool__id">
              <img src={asset.brandSrc} alt="" />
              <span className="ex-pool__symbol">{pool.asset}</span>
              <span className="ex-pool__name">{asset.name}</span>
            </span>
            <h1 className="ex-display ex-display--xl">{title}</h1>
            <p className="ex-result__market">{cadenceLabel(pool.cadence, locale)} · {directionLabel(pool.direction, locale)} · {pool.sourceSymbol}</p>
            {round.marketResult ? (
              <div className="ex-result__price">
                <span>{t.result.resolvedPrice}</span>
                <strong className="ex-num">{formatUsd(round.marketResult, locale)}</strong>
                <small>{directionLabel(pool.direction, locale)} · Binance</small>
              </div>
            ) : (
              <p className="ex-result__state" data-cancelled={cancelled}>
                {cancelled
                  ? t.result.cancelledBody
                  : settledEvidenceMissing
                    ? (locale === "tr"
                        ? "Tur zincir üzerinde sonuçlandı, ancak kanonik piyasa kanıtı şu anda kullanılamıyor."
                        : "The round settled onchain, but canonical market evidence is currently unavailable.")
                    : t.result.pendingBody}
              </p>
            )}
          </div>

          <dl className="ex-result__facts">
            <div><dt>{t.result.round}</dt><dd className="ex-num">#{round.roundId}</dd></div>
            <div><dt>{t.result.entries}</dt><dd className="ex-num">{round.entryCount}</dd></div>
            <div><dt>{t.result.stake}</dt><dd className="ex-num">{formatUsdc(round.totalStakeUsdc, locale)}</dd></div>
            <div><dt>{t.result.window}</dt><dd><span suppressHydrationWarning>{round.marketPeriodStartAt && round.marketPeriodEndAt ? `${formatUtcDateTime(round.marketPeriodStartAt, locale)} → ${formatUtcDateTime(round.marketPeriodEndAt, locale)}` : "Legacy V1"}</span></dd></div>
            <div><dt>{t.result.source}</dt><dd>{pool.source ? `${pool.source} · ${pool.sourceSymbol}` : pool.sourceSymbol}</dd></div>
            <div><dt>{t.result.status}</dt><dd>{humanRoundStatus(round.contractStatus, locale)}</dd></div>
          </dl>
        </section>

        {settled && view.winners.length > 0 && (
          <section className="ex-result__winners" aria-labelledby="result-winners">
            <div className="ex-result__section-head">
              <div><p className="ex-eyebrow">{t.result.winner}</p><h2 id="result-winners" className="ex-display ex-display--md">{t.result.winners}</h2></div>
              <p>{t.result.ticketCarriesClaim}</p>
            </div>
            <ol className="ex-winners">
              {view.winners.slice(0, 3).map((winner) => (
                <li key={winner.tokenId} className="ex-winner">
                  <span className="ex-winner__rank ex-num">{String(winner.rank).padStart(2, "0")}</span>
                  <div className="ex-winner__price"><span>{t.result.prediction}</span><strong className="ex-num">{formatUsd(winner.predictionPrice, locale)}</strong>{winner.distance !== null && <small>{t.result.distance} · {formatUsd(winner.distance, locale)}</small>}</div>
                  <dl className="ex-winner__meta">
                    <div><dt>{t.result.ticket}</dt><dd className="ex-num">#{winner.tokenId}</dd></div>
                    <div><dt>{t.result.claimHolder}</dt><dd title={winner.currentOwner} className="ex-num">{shortAddress(winner.currentOwner)}</dd></div>
                    <div><dt>{t.result.entrant}</dt><dd title={winner.originalEntrant} className="ex-num">{shortAddress(winner.originalEntrant)}</dd></div>
                  </dl>
                  <div className="ex-winner__claim" data-claimed={winner.isClaimed}>
                    <span>{winner.isClaimed ? t.result.claimed : winner.claimableUsdc !== null ? t.result.claimable : t.result.unclaimed}</span>
                    {!winner.isClaimed && winner.claimableUsdc !== null && <strong className="ex-num">{formatUsdc(winner.claimableUsdc, locale)}</strong>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {!settled && !cancelled && (
          <section className="ex-result__progress" aria-labelledby="result-progress" style={{ paddingBlock: "clamp(30px, 3.6vw, 46px)" }}>
            <div className="ex-result__section-head" style={{ gridTemplateColumns: "minmax(220px, 1.7fr) minmax(280px, 4fr)", paddingBottom: "clamp(14px, 1.8vw, 22px)" }}>
              <div>
                <p className="ex-eyebrow">{t.result.progress}</p>
                <h2 id="result-progress" className="ex-display" style={{ fontSize: "clamp(1.3rem, 1.8vw, 1.65rem)", lineHeight: 1 }}>{t.result.pending}</h2>
              </div>
              <p>{t.result.pendingBody}</p>
            </div>
            <ol className="ex-progress-rail">
              <li><span className="ex-progress-rail__number">01</span><div><h3>{t.result.progressEntry}</h3><p>{t.result.progressEntryBody}</p></div></li>
              <li><span className="ex-progress-rail__number">02</span><div><h3>{t.result.progressObservation}</h3><p className="ex-num">{round.marketPeriodStartAt && round.marketPeriodEndAt ? <>{formatUtcDateTime(round.marketPeriodStartAt, locale)}<br />→ {formatUtcDateTime(round.marketPeriodEndAt, locale)}</> : "Legacy V1"}</p></div></li>
              <li><span className="ex-progress-rail__number">03</span><div><h3>{t.result.progressSettlement}</h3><p>{t.result.progressSettlementBody}</p></div></li>
              <li><span className="ex-progress-rail__number">04</span><div><h3>{t.result.progressResult}</h3><p>{t.result.progressResultBody}</p></div></li>
            </ol>
          </section>
        )}

        <div className="ex-result__actions">
          <a className="ex-btn ex-btn--ghost" href={`${view.explorerUrl}/address/${pool.poolAddress}`} target="_blank" rel="noreferrer">{t.result.viewPoolOnArc}</a>
          {(settled || cancelled) && round.marketPeriodStartAt && round.marketPeriodEndAt && <Link className="ex-btn ex-btn--ink" href={`/verify/${pool.slug}/${round.roundId}`}>{t.result.verifySettlement}</Link>}
          {cancelled ? <Link className="ex-btn ex-btn--ghost" href="/tickets">{t.result.refunds}</Link> : <Link className="ex-btn ex-btn--ghost" href="/tickets">{t.result.viewTickets}</Link>}
        </div>
      </div>
    </main>
  );
}
