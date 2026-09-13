"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";
import { ProductHeader } from "../product-components";
import { assetConfigs } from "../lib/asset-config";
import { backendApi, type ArchiveResponse, type ArchiveRound } from "../lib/backend-api";
import { readCachedArchive, writeCachedArchive } from "../lib/archive-cache";
import { saveResultSnapshot } from "../lib/result-snapshot";
import { humanRoundStatus } from "../lib/display";
import { useLocale } from "../i18n";

const ARCHIVE_DAYS = 90;

// Hydrates from the tab cache before the first paint on the client; the
// server render has no cache and keeps its first load state.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// Immediate feedback on the clicked result link while its route is loading.
function PendingLinkLabel({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return <span className="ex-link-status" data-pending={pending || undefined}>{children}</span>;
}

function utcDateKey(value: string) {
  return new Date(value).toISOString().slice(0, 10);
}

function formatUtcDateKey(value: string, locale: "en" | "tr") {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatUtcDateTime(value: string, locale: "en" | "tr") {
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value)) + " UTC";
}

function formatUsd(value: string, locale: "en" | "tr") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function shortAddress(address: string) {
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function cadenceLabel(value: ArchiveRound["cadence"], locale: "en" | "tr") {
  if (locale === "tr") {
    if (value === "DAILY") return "Gün";
    if (value === "WEEKLY") return "Hafta";
    return "Çeyrek";
  }
  if (value === "DAILY") return "Day";
  if (value === "WEEKLY") return "Week";
  return "Quarter";
}

function directionLabel(value: ArchiveRound["direction"], locale: "en" | "tr") {
  if (locale === "tr") return value === "HIGH" ? "Yüksek" : "Düşük";
  return value === "HIGH" ? "High" : "Low";
}

type ArchiveFreshness = "initial" | "revalidating_cached" | "fresh" | "cached_refresh_failed";

function archiveDatePrefix(freshness: ArchiveFreshness, locale: "en" | "tr") {
  if (freshness === "revalidating_cached") return locale === "tr" ? "Güncelleniyor · " : "Updating · ";
  if (freshness === "cached_refresh_failed") return locale === "tr" ? "Önbellek · " : "Cached · ";
  return locale === "tr" ? "En güncel · " : "Latest · ";
}

export default function ArchivePage() {
  const { locale } = useLocale();
  const [archive, setArchive] = useState<ArchiveResponse | null>(null);
  const [error, setError] = useState("");
  const [selectedDateKey, setSelectedDateKey] = useState("");
  const [freshness, setFreshness] = useState<ArchiveFreshness>("initial");
  const hasArchive = useRef(false);
  // When the archive on screen was read. Clicking a result link hands that
  // known round to the Result page as a snapshot before navigating; nothing
  // is fetched at click time.
  const archiveReadAt = useRef(0);

  // Stale while revalidate: render the last successful archive at once, then
  // refresh silently. Fresh data replaces it only on success; a failed
  // refresh keeps what is on screen and never falls back to an error page.
  useIsomorphicLayoutEffect(() => {
    let cancelled = false;

    function applyArchive(next: ArchiveResponse, readAt: number) {
      hasArchive.current = true;
      archiveReadAt.current = readAt;
      setArchive(next);
      setError("");
      const dates = Array.from(new Set(next.rounds.map((round) => utcDateKey(round.marketPeriodStartAt)))).sort((a, b) => b.localeCompare(a));
      const requested = new URLSearchParams(window.location.search).get("date");
      // No explicit date means "latest". This lets a fresh archive response
      // advance past a stale tab cache instead of preserving yesterday's date.
      setSelectedDateKey(
        requested && dates.includes(requested) ? requested : (dates[0] ?? ""),
      );
    }

    const cached = readCachedArchive(ARCHIVE_DAYS);
    if (cached) {
      applyArchive(cached.archive, cached.cachedAt);
      setFreshness("revalidating_cached");
    }

    // Cancelled on unmount (for example when a result is opened): a slow
    // revalidation must not hold a browser connection and stall navigation.
    const controller = new AbortController();
    backendApi.rounds.archive(ARCHIVE_DAYS, { signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        writeCachedArchive(ARCHIVE_DAYS, result);
        applyArchive(result, Date.now());
        setFreshness("fresh");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (hasArchive.current) {
          setFreshness("cached_refresh_failed");
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to load archive.");
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const rounds = useMemo<ArchiveRound[]>(() => archive?.rounds ?? [], [archive]);
  const blockNumber = archive?.chain.blockNumber ?? null;
  const loading = archive === null && !error;

  const availableDates = useMemo(
    () => Array.from(new Set(rounds.map((round) => utcDateKey(round.marketPeriodStartAt)))).sort((a, b) => b.localeCompare(a)),
    [rounds],
  );

  const selectedRounds = useMemo(
    () => rounds.filter((round) => utcDateKey(round.marketPeriodStartAt) === selectedDateKey),
    [rounds, selectedDateKey],
  );

  useEffect(() => {
    function onPopState() {
      const requested = new URLSearchParams(window.location.search).get("date");
      setSelectedDateKey(requested && availableDates.includes(requested) ? requested : (availableDates[0] ?? ""));
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [availableDates]);

  function selectDate(next: string) {
    setSelectedDateKey(next);
    const url = new URL(window.location.href);
    if (next === availableDates[0]) url.searchParams.delete("date");
    else url.searchParams.set("date", next);
    window.history.pushState({}, "", url);
  }

  const settledCount = rounds.filter((round) => round.contractStatus === "SETTLED").length;
  const cancelledCount = rounds.filter((round) => round.contractStatus === "CANCELLED").length;

  return (
    <main className="ex-archive">
      <ProductHeader />
      <div className="ex-shell">
        <section className="ex-archive__head">
          <div>
            <p className="ex-eyebrow">{locale === "tr" ? "TUR ARŞİVİ" : "ROUND ARCHIVE"}</p>
            <h1 className="ex-display ex-display--lg">
              {locale === "tr" ? "Son 90 gün." : "The last 90 days."}
            </h1>
            <p className="ex-lede">
              {locale === "tr"
                ? "Kapanan turlar burada zincir üstü sonuçları, kazananları ve talep durumlarıyla kalır."
                : "Closed rounds remain here with their onchain outcome, winners, and claim state."}
            </p>
          </div>

          <dl className="ex-archive__summary">
            <div><dt>{locale === "tr" ? "Turlar" : "Rounds"}</dt><dd className="ex-num">{archive ? rounds.length : "—"}</dd></div>
            <div><dt>{locale === "tr" ? "Kesinleşti" : "Settled"}</dt><dd className="ex-num">{archive ? settledCount : "—"}</dd></div>
            <div><dt>{locale === "tr" ? "İptal" : "Cancelled"}</dt><dd className="ex-num">{archive ? cancelledCount : "—"}</dd></div>
            <div><dt>Arc Testnet</dt><dd className="ex-num">{blockNumber ?? "—"}</dd></div>
          </dl>
        </section>

        {loading && (
          <section className="ex-archive__state">
            <p className="ex-eyebrow">{locale === "tr" ? "ZİNCİR OKUNUYOR" : "READING CHAIN"}</p>
            <p>{locale === "tr" ? "Arşiv yükleniyor…" : "Loading archived rounds…"}</p>
            <span className="ex-state-progress" aria-hidden="true" />
          </section>
        )}

        {!loading && error && (
          <section className="ex-archive__state" data-tone="error">
            <p className="ex-eyebrow">{locale === "tr" ? "ARŞİV KULLANILAMIYOR" : "ARCHIVE UNAVAILABLE"}</p>
            <p>{error}</p>
          </section>
        )}

        {!loading && !error && availableDates.length === 0 && (
          <section className="ex-archive__state">
            <p className="ex-eyebrow">{locale === "tr" ? "HENÜZ KAYIT YOK" : "NO RECORDS YET"}</p>
            <h2 className="ex-display ex-display--md">{locale === "tr" ? "Arşiv sessiz." : "The archive is quiet."}</h2>
            <p>{locale === "tr" ? "Kapanan ilk tur burada görünecek." : "The first closed round will appear here."}</p>
          </section>
        )}

        {!loading && !error && availableDates.length > 0 && (
          <>
            <section className="ex-archive__query" aria-label={locale === "tr" ? "Arşiv tarihi" : "Archive date"}>
              <label>
                <span>{locale === "tr" ? "TARİH" : "DATE"}</span>
                <select value={selectedDateKey} onChange={(event) => selectDate(event.target.value)}>
                  {availableDates.map((dateKey, index) => (
                    <option value={dateKey} key={dateKey}>
                      {index === 0 ? archiveDatePrefix(freshness, locale) : ""}
                      {formatUtcDateKey(dateKey, locale)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="ex-num">
                {selectedRounds.length} {locale === "tr" ? "tur gösteriliyor" : selectedRounds.length === 1 ? "round shown" : "rounds shown"}
                {" · "}
                {availableDates.length} {locale === "tr" ? "arşiv günü" : availableDates.length === 1 ? "archive day" : "archive days"}
              </p>
            </section>

            <section className="ex-archive__group" key={selectedDateKey}>
            <header className="ex-archive__date">
              <h2 className="ex-display">{formatUtcDateKey(selectedDateKey, locale)}</h2>
              <span className="ex-num">
                {selectedRounds.length} {locale === "tr" ? "tur" : selectedRounds.length === 1 ? "round" : "rounds"}
              </span>
            </header>

            <div className="ex-archive__ledger">
              {selectedRounds.map((round) => {
                const asset = assetConfigs[round.asset];
                const settled = round.contractStatus === "SETTLED";
                const cancelled = round.contractStatus === "CANCELLED";
                const hasUnclaimedWinner = round.winners.some((winner) => !winner.claimed);

                return (
                  <article className="ex-archive-row" data-status={round.contractStatus} key={round.slug + ":" + round.marketPeriodStartAt}>
                    <div className="ex-archive-row__identity">
                      <span className="ex-archive-row__asset">
                        <img src={asset.brandSrc} alt="" />
                        <strong>{round.asset}</strong>
                      </span>
                      <p>{cadenceLabel(round.cadence, locale)} · {directionLabel(round.direction, locale)}</p>
                      <span className="ex-num">{round.roundId !== null ? "#" + round.roundId : "—"}</span>
                    </div>

                    <div className="ex-archive-row__result">
                      <span>{locale === "tr" ? "SONUÇ" : "OUTCOME"}</span>
                      <strong className={settled ? "ex-num" : undefined}>
                        {formatUsd(round.marketResult, locale)}
                      </strong>
                      <small>{round.contractStatus === "NO_ROUND"
                        ? (locale === "tr" ? "Piyasa sonucu" : "Market result")
                        : humanRoundStatus(round.contractStatus, locale)}</small>
                    </div>

                    <dl className="ex-archive-row__stats">
                      <div><dt>{locale === "tr" ? "KATILIM" : "ENTRIES"}</dt><dd className="ex-num">{round.entryCount}</dd></div>
                      <div><dt>{locale === "tr" ? "HAVUZ" : "POOL"}</dt><dd className="ex-num">{round.totalStakeUsdc} USDC</dd></div>
                      <div><dt>{locale === "tr" ? "DÖNEM" : "PERIOD"}</dt><dd className="ex-num">{formatUtcDateTime(round.marketPeriodStartAt, locale)} → {formatUtcDateTime(round.marketPeriodEndAt, locale)}</dd></div>
                    </dl>

                    <div className="ex-archive-row__winners">
                      <span>{locale === "tr" ? "İLK 3" : "TOP 3"}</span>
                      {round.winners.length === 0 ? (
                        <p>—</p>
                      ) : (
                        <ol>
                          {round.winners.slice(0, 3).map((winner) => (
                            <li key={winner.tokenId}>
                              <b className="ex-num">{String(winner.rank).padStart(2, "0")}</b>
                              <span title={winner.currentOwner} className="ex-num">{shortAddress(winner.currentOwner)}</span>
                              <span className="ex-num">{winner.rewardUsdc} USDC</span>
                              <small>{winner.claimed ? (locale === "tr" ? "Alındı" : "Claimed") : (locale === "tr" ? "Bekliyor" : "Unclaimed")}</small>
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>

                    <div className="ex-archive-row__actions">
                      {round.roundId !== null ? (
                        <Link
                          href={"/results/" + round.slug + "/" + round.roundId}
                          onClick={() => {
                            if (archive) saveResultSnapshot(round, archive.chain.explorerUrl, archiveReadAt.current || Date.now());
                          }}
                        >
                          <PendingLinkLabel>{locale === "tr" ? "Sonucu aç" : "Open result"} →</PendingLinkLabel>
                        </Link>
                      ) : (
                        <span className="ex-num">{locale === "tr" ? "Piyasa sonucu" : "Market result"}</span>
                      )}
                      {hasUnclaimedWinner && (
                        <Link href="/tickets">{locale === "tr" ? "Bilete git" : "Go to ticket"} →</Link>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
