"use client";

import { useEffect, useMemo, useState } from "react";
import { ProductHeader } from "../product-components";
import { backendApi, type ArchiveWinner } from "../lib/backend-api";
import { formatUsdc } from "../lib/display";
import { useCopy, useLocale } from "../i18n";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Raw 6-decimal USDC integer -> decimal string, done with BigInt integer
// division so ranking-adjacent values are never rounded through a float.
function rawToDecimalString(raw: bigint) {
  const base = BigInt(1_000_000);
  const whole = raw / base;
  const fraction = raw % base;
  if (fraction === BigInt(0)) return whole.toString();
  const fractionStr = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fractionStr}`;
}

type LeaderboardRow = {
  address: string;
  wins: number;
  podiums: number;
  totalRewardRaw: bigint;
};

// Attribution is by originalEntrant, not currentOwner: winning tickets are
// transferable NFTs, and prediction-performance ranking must not move from
// the entrant who actually made the call just because the ticket changed
// hands afterward. Current ownership still governs claim rights elsewhere,
// just not this ranking.
function buildLeaderboard(winners: ArchiveWinner[]): LeaderboardRow[] {
  const byAddress = new Map<string, LeaderboardRow>();

  for (const winner of winners) {
    const key = winner.originalEntrant.toLowerCase();
    let row = byAddress.get(key);
    if (!row) {
      row = { address: winner.originalEntrant, wins: 0, podiums: 0, totalRewardRaw: BigInt(0) };
      byAddress.set(key, row);
    }

    row.podiums += 1;
    if (winner.rank === 1) row.wins += 1;
    row.totalRewardRaw += BigInt(winner.rewardRaw);
  }

  const rows = Array.from(byAddress.values());

  rows.sort((a, b) => {
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.podiums !== b.podiums) return b.podiums - a.podiums;
    if (a.totalRewardRaw !== b.totalRewardRaw) return a.totalRewardRaw > b.totalRewardRaw ? -1 : 1;
    return a.address.toLowerCase().localeCompare(b.address.toLowerCase());
  });

  return rows;
}

export default function LeaderboardPage() {
  const { locale } = useLocale();
  const t = useCopy();
  const [winners, setWinners] = useState<ArchiveWinner[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    backendApi.rounds.archive(90)
      .then((result) => {
        if (cancelled) return;
        // Only SETTLED rounds carry real winners; LOCKED/ENTRY_OPEN/CANCELLED
        // rounds either have no resolved outcome yet or none at all.
        const settledWinners = result.rounds
          .filter((round) => round.contractStatus === "SETTLED")
          .flatMap((round) => round.winners);
        setWinners(settledWinners);
        setError("");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Unable to load leaderboard.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => (winners ? buildLeaderboard(winners) : []), [winners]);

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>{t.leaderboardWindow}</p>
        <h1>{t.leaderboard}</h1>

        {loading && <p>{t.leaderboardLoading}</p>}

        {!loading && error && (
          <section className="wf-panel wf-section">
            <p>{error}</p>
          </section>
        )}

        {!loading && !error && rows.length === 0 && (
          <section className="wf-panel wf-section">
            <p>{t.leaderboardEmpty}</p>
          </section>
        )}

        {!loading && !error && rows.length > 0 && (
          <table className="wf-table wf-section">
            <thead>
              <tr>
                <th>{t.leaderboardRank}</th>
                <th>{t.leaderboardWallet}</th>
                <th>{t.leaderboardWins}</th>
                <th>{t.leaderboardPodiums}</th>
                <th>{t.leaderboardPrizeValue}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.address}>
                  <td>#{index + 1}</td>
                  <td title={row.address}>{shortAddress(row.address)}</td>
                  <td>{row.wins}</td>
                  <td>{row.podiums}</td>
                  <td>{formatUsdc(rawToDecimalString(row.totalRewardRaw), locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
