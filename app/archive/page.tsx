"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import { assetConfigs } from "../lib/asset-config";
import { backendApi, type ArchiveRound } from "../lib/backend-api";
import { humanRoundStatus } from "../lib/display";
import { useLocale } from "../i18n";

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

export default function ArchivePage() {
  const { locale } = useLocale();
  const [rounds, setRounds] = useState<ArchiveRound[]>([]);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedDateKey, setSelectedDateKey] = useState("");

  useEffect(() => {
    let cancelled = false;

    backendApi.rounds.archive(90)
      .then((result) => {
        if (cancelled) return;
        setRounds(result.rounds);
        setBlockNumber(result.chain.blockNumber);
        const dates = Array.from(new Set(result.rounds.map((round) => utcDateKey(round.entryCloseAt)))).sort((a, b) => b.localeCompare(a));
        const requested = typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("date")
          : null;
        setSelectedDateKey(requested && dates.includes(requested) ? requested : (dates[0] ?? ""));
        setError("");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Unable to load archive.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const availableDates = useMemo(
    () => Array.from(new Set(rounds.map((round) => utcDateKey(round.entryCloseAt)))).sort((a, b) => b.localeCompare(a)),
    [rounds],
  );

  const selectedRounds = useMemo(
    () => rounds.filter((round) => utcDateKey(round.entryCloseAt) === selectedDateKey),
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
            <div><dt>{locale === "tr" ? "Turlar" : "Rounds"}</dt><dd className="ex-num">{rounds.length}</dd></div>
            <div><dt>{locale === "tr" ? "Kesinleşti" : "Settled"}</dt><dd className="ex-num">{settledCount}</dd></div>
            <div><dt>{locale === "tr" ? "İptal" : "Cancelled"}</dt><dd className="ex-num">{cancelledCount}</dd></div>
            <div><dt>Arc Testnet</dt><dd className="ex-num">{blockNumber ?? "—"}</dd></div>
          </dl>
        </section>

        {loading && (
          <section className="ex-archive__state">
            <p className="ex-eyebrow">{locale === "tr" ? "ZİNCİR OKUNUYOR" : "READING CHAIN"}</p>
            <p>{locale === "tr" ? "Arşiv yükleniyor…" : "Loading archived rounds…"}</p>
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
                      {index === 0 ? (locale === "tr" ? "En güncel · " : "Latest · ") : ""}
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
                  <article className="ex-archive-row" data-status={round.contractStatus} key={round.slug + ":" + round.roundId}>
                    <div className="ex-archive-row__identity">
                      <span className="ex-archive-row__asset">
                        <img src={asset.brandSrc} alt="" />
                        <strong>{round.asset}</strong>
                      </span>
                      <p>{cadenceLabel(round.cadence, locale)} · {directionLabel(round.direction, locale)}</p>
                      <span className="ex-num">#{round.roundId}</span>
                    </div>

                    <div className="ex-archive-row__result">
                      <span>{locale === "tr" ? "SONUÇ" : "OUTCOME"}</span>
                      <strong className={settled ? "ex-num" : undefined}>
                        {settled && round.resolvedPrice
                          ? formatUsd(round.resolvedPrice, locale)
                          : cancelled
                            ? (locale === "tr" ? "İptal edildi" : "Cancelled")
                            : humanRoundStatus(round.contractStatus, locale)}
                      </strong>
                      <small>{humanRoundStatus(round.contractStatus, locale)}</small>
                    </div>

                    <dl className="ex-archive-row__stats">
                      <div><dt>{locale === "tr" ? "KATILIM" : "ENTRIES"}</dt><dd className="ex-num">{round.entryCount}</dd></div>
                      <div><dt>{locale === "tr" ? "HAVUZ" : "POOL"}</dt><dd className="ex-num">{round.totalStakeUsdc} USDC</dd></div>
                      <div><dt>{locale === "tr" ? "KAPANIŞ" : "CLOSED"}</dt><dd className="ex-num">{formatUtcDateTime(round.entryCloseAt, locale)}</dd></div>
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
                      <Link href={"/results/" + round.slug + "/" + round.roundId}>
                        {locale === "tr" ? "Sonucu aç" : "Open result"} →
                      </Link>
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
