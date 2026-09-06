"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import { backendApi, type ArchiveRound } from "../lib/backend-api";
import { useLocale } from "../i18n";

function formatUtcDate(value: string, locale: "en" | "tr") {
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatUtcDateTime(value: string, locale: "en" | "tr") {
  return (
    new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value)) + " UTC"
  );
}

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function ArchivePage() {
  const { locale } = useLocale();
  const [rounds, setRounds] = useState<ArchiveRound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    backendApi.rounds.archive(90)
      .then((result) => {
        if (cancelled) return;
        setRounds(result.rounds);
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

  const groups = useMemo(() => {
    const map = new Map<string, ArchiveRound[]>();
    for (const round of rounds) {
      const key = formatUtcDate(round.entryCloseAt, locale);
      const existing = map.get(key) ?? [];
      existing.push(round);
      map.set(key, existing);
    }
    return Array.from(map.entries());
  }, [rounds, locale]);

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>ROUND ARCHIVE</p>
        <h1>{locale === "tr" ? "Son 3 Ay" : "Last 3 Months"}</h1>
        <p>
          {locale === "tr"
            ? "Kapanan turlar 90 gün boyunca burada listelenir."
            : "Closed rounds remain visible here for 90 days."}
        </p>

        {loading && <p>{locale === "tr" ? "Arşiv yükleniyor…" : "Loading archive…"}</p>}

        {!loading && error && (
          <section className="wf-panel wf-section">
            <p>{error}</p>
          </section>
        )}

        {!loading && !error && groups.length === 0 && (
          <section className="wf-panel wf-section">
            <p>{locale === "tr" ? "Henüz arşiv kaydı yok." : "No archived rounds yet."}</p>
          </section>
        )}

        {!loading && !error && groups.map(([date, items]) => (
          <section className="wf-section" key={date}>
            <h2>{date}</h2>
            <div className="wf-table-wrap">
              <table className="wf-table">
                <thead>
                  <tr>
                    <th>{locale === "tr" ? "Parite" : "Market"}</th>
                    <th>{locale === "tr" ? "Kapanış" : "Closed"}</th>
                    <th>{locale === "tr" ? "Durum" : "Status"}</th>
                    <th>{locale === "tr" ? "Sonuç" : "Result"}</th>
                    <th>{locale === "tr" ? "İlk 3" : "Top 3"}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((round) => (
                    <tr key={`${round.slug}:${round.roundId}`}>
                      <td>
                        <b>{round.asset}</b>
                        <br />
                        <small>{titleCase(round.cadence)} · {titleCase(round.direction)} · #{round.roundId}</small>
                      </td>
                      <td>{formatUtcDateTime(round.entryCloseAt, locale)}</td>
                      <td>{round.contractStatus}</td>
                      <td>{round.resolvedPrice ? `$${Number(round.resolvedPrice).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</td>
                      <td>
                        {round.winners.length === 0 ? (
                          "—"
                        ) : (
                          <div className="archive-winners">
                            {round.winners.map((winner) => (
                              <div key={winner.tokenId}>
                                <b>#{winner.rank}</b>{" "}
                                <span title={winner.currentOwner}>{shortAddress(winner.currentOwner)}</span>{" "}
                                <span>{winner.rewardUsdc} USDC</span>{" "}
                                {winner.claimed ? <small>Claimed</small> : <small>Unclaimed</small>}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="archive-actions">
                          <Link className="wf-action" href={`/results/${round.slug}/${round.roundId}`}>
                            {locale === "tr" ? "Sonuç" : "Result"}
                          </Link>
                          {round.winners.some((winner) => !winner.claimed) && (
                            <Link className="wf-action" href="/tickets">
                              {locale === "tr" ? "Claim'e git" : "Go to claim"}
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </section>
    </main>
  );
}
