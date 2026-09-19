"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProductHeader } from "../product-components";
import { backendApi, type ArchiveResponse, type ArchiveWinner } from "../lib/backend-api";
import { readCachedArchive, writeCachedArchive } from "../lib/archive-cache";
import { formatUsdc } from "../lib/display";
import { useCopy, useLocale } from "../i18n";
import { useWalletSession } from "../wallet-session";

// The leaderboard is derived entirely from the archive, so it shares the
// Archive page's tab cache: known standings render before the first paint on
// the client, and one archive revalidation refreshes both.
const ARCHIVE_DAYS = 90;
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
  const { address: ownAddress } = useWalletSession();
  const [archive, setArchive] = useState<ArchiveResponse | null>(null);
  const [error, setError] = useState("");
  const hasArchive = useRef(false);

  // Stale while revalidate on the shared archive cache: render known
  // standings at once, refresh silently, keep them if the refresh fails.
  useIsomorphicLayoutEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const cached = readCachedArchive(ARCHIVE_DAYS);
    if (cached) {
      hasArchive.current = true;
      setArchive(cached.archive);
    }

    const controller = new AbortController();

    async function waitForRetry() {
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, 3_000);
      });
    }

    async function revalidate() {
      try {
        for (let attempt = 0; attempt < 40 && !cancelled; attempt += 1) {
          const result = await backendApi.rounds.archive(ARCHIVE_DAYS, { signal: controller.signal });
          if (cancelled) return;

          writeCachedArchive(ARCHIVE_DAYS, result);
          hasArchive.current = true;
          setArchive(result);
          setError("");

          if (!result.snapshot?.stale && !result.snapshot?.refreshing) return;
          await waitForRetry();
        }
      } catch (cause: unknown) {
        if (cancelled || hasArchive.current) return;
        setError(cause instanceof Error ? cause.message : "Unable to load leaderboard.");
      }
    }

    void revalidate();

    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  // Only SETTLED rounds carry real winners; LOCKED/ENTRY_OPEN/CANCELLED
  // rounds either have no resolved outcome yet or none at all.
  const winners = useMemo<ArchiveWinner[] | null>(
    () => archive
      ? archive.rounds
          .filter((round) => round.contractStatus === "SETTLED")
          .flatMap((round) => round.winners)
      : null,
    [archive],
  );
  const blockNumber = archive?.chain.blockNumber ?? null;
  const loading = archive === null && !error;

  const rows = useMemo(() => (winners ? buildLeaderboard(winners) : []), [winners]);

  // Derived purely from the already-correct BigInt rows above; buildLeaderboard()
  // itself is untouched.
  const totalPrizeRaw = useMemo(
    () => rows.reduce((total, row) => total + row.totalRewardRaw, BigInt(0)),
    [rows],
  );

  return (
    <main className="ex-leaderboard">
      <ProductHeader />
      <div className="ex-shell">
        <section className="ex-leaderboard__head">
          <div>
            <p className="ex-eyebrow">{t.leaderboardWindow}</p>
            <h1 className="ex-display ex-display--lg">{t.leaderboard}</h1>
            <p className="ex-lede">{t.leaderboardLede}</p>
          </div>

          <dl className="ex-leaderboard__summary">
            <div><dt>{t.leaderboardEntrants}</dt><dd className="ex-num">{archive ? rows.length : "—"}</dd></div>
            <div><dt>{t.leaderboardTotalPrize}</dt><dd className="ex-num">{archive ? formatUsdc(rawToDecimalString(totalPrizeRaw), locale) : "—"}</dd></div>
            <div><dt>Arc Testnet</dt><dd className="ex-num">{blockNumber ?? "—"}</dd></div>
          </dl>
        </section>

        {loading && (
          <section className="ex-leaderboard__state">
            <p className="ex-eyebrow">{t.leaderboardWindow}</p>
            <p>{t.leaderboardLoading}</p>
            <span className="ex-state-progress" aria-hidden="true" />
          </section>
        )}

        {!loading && error && (
          <section className="ex-leaderboard__state" data-tone="error">
            <p className="ex-eyebrow">{t.leaderboardUnavailable}</p>
            <p>{error}</p>
          </section>
        )}

        {!loading && !error && rows.length === 0 && (
          <section className="ex-leaderboard__state">
            <p className="ex-eyebrow">{t.leaderboardWindow}</p>
            <p>{t.leaderboardEmpty}</p>
          </section>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="ex-leaderboard__ledger">
            <div className="ex-leaderboard-row ex-leaderboard-row--head" aria-hidden="true">
              <span>{t.leaderboardRank}</span>
              <span>{t.leaderboardWallet}</span>
              <span>{t.leaderboardWins}</span>
              <span>{t.leaderboardPodiums}</span>
              <span>{t.leaderboardPrizeValue}</span>
            </div>

            {rows.map((row, index) => {
              const isYou = Boolean(ownAddress) && row.address.toLowerCase() === ownAddress?.toLowerCase();
              return (
                <div className="ex-leaderboard-row" data-podium={index < 3} data-you={isYou} key={row.address}>
                  <span className="ex-leaderboard-row__rank ex-num">{String(index + 1).padStart(2, "0")}</span>
                  <span className="ex-leaderboard-row__wallet">
                    <span className="ex-num" title={row.address}>{shortAddress(row.address)}</span>
                    {isYou && <b className="ex-leaderboard-row__you">{t.leaderboardYou}</b>}
                  </span>
                  <span className="ex-leaderboard-row__stats">
                    <span className="ex-leaderboard-row__stat" data-label={t.leaderboardWins}>
                      <span className="ex-num">{row.wins}</span>
                    </span>
                    <span className="ex-leaderboard-row__stat" data-label={t.leaderboardPodiums}>
                      <span className="ex-num">{row.podiums}</span>
                    </span>
                  </span>
                  <span className="ex-leaderboard-row__prize ex-num">{formatUsdc(rawToDecimalString(row.totalRewardRaw), locale)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
