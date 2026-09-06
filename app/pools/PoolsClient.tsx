"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { backendApi, type LivePool } from "../lib/backend-api";
import { assetConfigs } from "../lib/asset-config";
import type { Asset, Cadence } from "../lib/domain";
import { useCopy, useLocale } from "../i18n";
import { applyBinanceLiveMarket, readBinanceLiveMarket } from "../lib/live-market";
import { formatLocalDateTime, formatUsdc, humanRoundStatus } from "../lib/display";

const assets: ("All" | Asset)[] = ["All", "BTC", "ETH", "SOL", "HYPE"];
const cadences: ("All" | Cadence)[] = ["All", "Daily", "Weekly", "Quarterly"];

// Fixed board order, so the 24-pool architecture always reads the same way.
const ASSET_ORDER: Asset[] = ["BTC", "ETH", "SOL", "HYPE"];
const CADENCE_ORDER: LivePool["cadence"][] = ["DAILY", "WEEKLY", "QUARTERLY"];
const DIRECTIONS: LivePool["direction"][] = ["HIGH", "LOW"];

type Copy = ReturnType<typeof useCopy>;
type Locale = "en" | "tr";

function cadenceKey(value: Cadence) {
  return value.toUpperCase() as LivePool["cadence"];
}

function localizedCadence(value: LivePool["cadence"], locale: Locale) {
  if (locale === "tr") {
    if (value === "DAILY") return "Gün";
    if (value === "WEEKLY") return "Hafta";
    return "Çeyrek";
  }

  if (value === "DAILY") return "Daily";
  if (value === "WEEKLY") return "Weekly";
  return "Quarterly";
}

// Horizon wording on the board matches the homepage horizon language.
function horizonLabel(value: LivePool["cadence"], t: Copy) {
  if (value === "DAILY") return t.home.horizonDayKey;
  if (value === "WEEKLY") return t.home.horizonWeekKey;
  return t.home.horizonQuarterKey;
}

function directionLabel(value: LivePool["direction"], t: Copy) {
  return value === "HIGH" ? t.home.directionHighKey : t.home.directionLowKey;
}

function formatOverviewCountdown(ms: number, locale: Locale) {
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

function formatUtcCompact(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value)) + " UTC";
}

function formatUsdPrice(value: string | null, locale: Locale) {
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

// A round whose entry window has closed but which has not been locked yet is
// neither "open" nor plainly "locked". That distinction stays visible.
function poolStatusLabel(pool: LivePool, locale: Locale, t: Copy) {
  if (pool.round.contractStatus === "ENTRY_OPEN" && !pool.round.canEnter) {
    return t.predictionsClosedAwaitingLock;
  }
  return humanRoundStatus(pool.round.contractStatus, locale);
}

/** Same rising/falling motif the homepage uses to separate High from Low. */
function DirectionMark({ direction }: { direction: LivePool["direction"] }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      {direction === "HIGH" ? (
        <path d="M4 26 L12 14 L18 20 L28 6 M28 6 H21 M28 6 V13" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4 6 L12 18 L18 12 L28 26 M28 26 H21 M28 26 V19" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/**
 * The single overview countdown. Prediction window only: observation timing
 * belongs to the round and pool views, not to market discovery.
 */
function OverviewCountdown({ pools }: { pools: LivePool[] }) {
  const { locale } = useLocale();
  const t = useCopy();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const openRounds = pools
    .filter((pool) => {
      const openAt = new Date(pool.round.entryOpenAt).getTime();
      const closeAt = new Date(pool.round.entryCloseAt).getTime();
      return now >= openAt && now < closeAt && pool.round.canEnter;
    })
    .sort(
      (a, b) =>
        new Date(a.round.entryCloseAt).getTime() -
        new Date(b.round.entryCloseAt).getTime(),
    );

  const nextRounds = pools
    .filter((pool) => now < new Date(pool.round.entryOpenAt).getTime())
    .sort(
      (a, b) =>
        new Date(a.round.entryOpenAt).getTime() -
        new Date(b.round.entryOpenAt).getTime(),
    );

  const active = openRounds[0];
  const upcoming = nextRounds[0];

  if (active) {
    const target = new Date(active.round.entryCloseAt).getTime();

    return (
      <div className="ex-window">
        <p className="ex-window__label">{t.predictionWindow}</p>
        <p className="ex-window__context">
          {localizedCadence(active.cadence, locale)} · {t.predictionsCloseIn}
        </p>
        <p className="ex-window__value">{formatOverviewCountdown(target - now, locale)}</p>
        <p className="ex-window__meta">
          {t.closes} · {formatUtcCompact(active.round.entryCloseAt, locale)}
        </p>
      </div>
    );
  }

  if (upcoming) {
    const target = new Date(upcoming.round.entryOpenAt).getTime();

    return (
      <div className="ex-window">
        <p className="ex-window__label">{t.predictionWindow}</p>
        <p className="ex-window__context">
          {localizedCadence(upcoming.cadence, locale)} · {t.predictionsOpenIn}
        </p>
        <p className="ex-window__value">{formatOverviewCountdown(target - now, locale)}</p>
        <p className="ex-window__meta">
          {t.opens} · {formatUtcCompact(upcoming.round.entryOpenAt, locale)}
        </p>
      </div>
    );
  }

  // Neither an open nor an upcoming entry window exists for this selection.
  // The daily cadence, for instance, closes entry at 20:00 UTC and the next
  // round only appears after 00:00 UTC, so this gap is real. Say so plainly
  // rather than leaving a hole in the composition, and never invent a
  // target: the next round genuinely does not exist in the data yet.
  return (
    <div className="ex-window ex-window--empty">
      <p className="ex-window__label">{t.predictionWindow}</p>
      <p className="ex-window__context">{t.poolsNoWindow}</p>
    </div>
  );
}

/** One instrument in the matrix. Every value here is live chain state. */
function PoolCell({
  pool,
  direction,
  locale,
  t,
}: {
  pool: LivePool | undefined;
  direction: LivePool["direction"];
  locale: Locale;
  t: Copy;
}) {
  if (!pool) {
    return (
      <div className="ex-cell ex-cell--empty">
        <span className="ex-cell__status">{t.unavailable}</span>
      </div>
    );
  }

  const open = pool.round.canEnter;

  return (
    <Link className="ex-cell" data-open={open} href={`/pools/${pool.slug}`}>
      <span className="ex-cell__dir">
        <DirectionMark direction={direction} />
        {directionLabel(direction, t)}
      </span>

      <span className="ex-cell__top">
        <span className="ex-cell__round">
          {t.round} #{pool.round.roundId}
        </span>
        <span className="ex-cell__status">{poolStatusLabel(pool, locale, t)}</span>
      </span>

      <span className="ex-cell__stats">
        <span className="ex-cell__stat">
          <span className="ex-cell__val">{pool.round.entryCount}</span>
          <span className="ex-cell__key">{t.entries}</span>
        </span>
        <span className="ex-cell__stat">
          <span className="ex-cell__val">{formatUsdc(pool.round.totalStakeUsdc, locale)}</span>
          <span className="ex-cell__key">{t.prizePool}</span>
        </span>
        <span className="ex-cell__stat">
          <span className="ex-cell__val">{formatUsdPrice(pool.round.lastPredictionPrice, locale)}</span>
          <span className="ex-cell__key">{t.latestPrediction}</span>
        </span>
      </span>

      <span className="ex-cell__foot">
        <span className="ex-cell__time">
          {t.closes} {formatLocalDateTime(pool.round.entryCloseAt, locale)}
        </span>
        <span className="ex-cell__cta">
          {open ? t.makePrediction : t.viewPool}
          <span aria-hidden="true">→</span>
        </span>
      </span>
    </Link>
  );
}

/** One asset section: identity and live mark once, then its horizon rows. */
function AssetSection({
  asset,
  pools,
  locale,
  t,
}: {
  asset: Asset;
  pools: LivePool[];
  locale: Locale;
  t: Copy;
}) {
  const config = assetConfigs[asset];
  // Every pool of one asset shares a source symbol, so the first live quote
  // is the asset's quote. When none is available the slot says so.
  const market = pools.find((pool) => pool.market.available)?.market ?? null;
  const rows = CADENCE_ORDER.filter((cadence) => pools.some((pool) => pool.cadence === cadence));

  return (
    <section className="ex-asset">
      <div className="ex-asset__head">
        <span className="ex-asset__id">
          <img src={config.brandSrc} alt="" />
          <span className="ex-asset__symbol">{asset}</span>
          <span className="ex-asset__name">{config.name}</span>
        </span>
        <span className="ex-asset__mark">
          <span className="ex-asset__price" data-pending={market ? "false" : "true"}>
            {market ? formatUsdPrice(market.markPrice, locale) : t.unavailable}
          </span>
          <span className="ex-asset__source">
            {t.liveMark}
            {market?.source ? ` · ${market.source}` : ""}
          </span>
        </span>
      </div>

      <div className="ex-matrix">
        <span className="ex-matrix__head ex-matrix__head--spacer" aria-hidden="true" />
        {DIRECTIONS.map((direction) => (
          <span className="ex-matrix__head" key={direction}>
            <DirectionMark direction={direction} />
            {directionLabel(direction, t)}
          </span>
        ))}

        {rows.map((cadence) => (
          <Fragment key={cadence}>
            <span className="ex-cadence">{horizonLabel(cadence, t)}</span>
            {DIRECTIONS.map((direction) => (
              <PoolCell
                key={direction}
                pool={pools.find((pool) => pool.cadence === cadence && pool.direction === direction)}
                direction={direction}
                locale={locale}
                t={t}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

export default function PoolsClient() {
  const { locale } = useLocale();
  const t = useCopy();
  const [asset, setAsset] = useState<"All" | Asset>("All");
  const [cadence, setCadence] = useState<"All" | Cadence>("All");
  const [pools, setPools] = useState<LivePool[]>([]);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      try {
        const [state, live] = await Promise.all([
          backendApi.rounds.list(),
          readBinanceLiveMarket(),
        ]);
        if (cancelled) return;
        setPools(applyBinanceLiveMarket(state.pools, live));
        setBlockNumber(state.chain.blockNumber);
        setError("");
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unable to read Arc Testnet rounds.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void refresh();
    timer = setInterval(() => {
      void refresh();
    }, 60_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  const filtered = useMemo(
    () =>
      pools.filter(
        (pool) =>
          (asset === "All" || pool.asset === asset) &&
          (cadence === "All" || pool.cadence === cadenceKey(cadence)),
      ),
    [asset, cadence, pools],
  );

  const groups = useMemo(
    () =>
      ASSET_ORDER.map((item) => ({
        asset: item,
        pools: filtered.filter((pool) => pool.asset === item),
      })).filter((group) => group.pools.length > 0),
    [filtered],
  );

  return (
    <>
      <div className="ex-shell ex-pools__head">
        <div className="ex-pools__intro">
          <p className="ex-eyebrow">{t.poolsEyebrow}</p>
          <h1 className="ex-display ex-display--lg">{t.poolsTitle}</h1>
          <p className="ex-lede">{t.poolsLede}</p>
        </div>

        <OverviewCountdown pools={filtered} />
      </div>

      <div className="ex-shell">
        <div className="ex-rail">
          <div className="ex-rail__group">
            <span className="ex-rail__label">{t.poolsAssetFilter}</span>
            <div className="ex-rail__set" aria-label="Asset filter" role="group">
              {assets.map((item) => (
                <button
                  className="ex-rail__btn"
                  data-active={asset === item}
                  key={item}
                  type="button"
                  onClick={() => setAsset(item)}
                >
                  {item === "All" ? t.all : item}
                </button>
              ))}
            </div>
          </div>

          <div className="ex-rail__group">
            <span className="ex-rail__label">{t.poolsHorizonFilter}</span>
            <div className="ex-rail__set" aria-label="Cadence filter" role="group">
              {cadences.map((item) => (
                <button
                  className="ex-rail__btn"
                  data-active={cadence === item}
                  key={item}
                  type="button"
                  onClick={() => setCadence(item)}
                >
                  {item === "All"
                    ? t.all
                    : item === "Daily"
                      ? t.daily
                      : item === "Weekly"
                        ? t.weekly
                        : t.quarterly}
                </button>
              ))}
            </div>
          </div>

          {!loading && !error && (
            <p className="ex-rail__meta">
              {filtered.length} {t.poolsShown} · {t.poolsBlock} {blockNumber ?? "—"}
            </p>
          )}
        </div>

        {loading && <p className="ex-pools__note">{t.readingRounds}</p>}

        {!loading && error && (
          <div className="ex-pools__error">
            <h2 className="ex-display ex-display--md">{t.roundUnavailable}</h2>
            <p className="ex-lede">{error}</p>
            <p className="ex-pools__note" style={{ marginTop: 0 }}>{t.noMockFallback}</p>
          </div>
        )}

        {!loading && !error && (
          <div className="ex-board">
            {groups.map((group) => (
              <AssetSection
                key={group.asset}
                asset={group.asset}
                pools={group.pools}
                locale={locale}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
