"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { backendApi, type MarketplaceListing } from "../lib/backend-api";
import { assetConfigs } from "../lib/asset-config";
import type { Asset } from "../lib/domain";
import { useCopy, useLocale } from "../i18n";
import { formatUsdc } from "../lib/display";

const ASSET_ORDER: Asset[] = ["BTC", "ETH", "SOL", "HYPE"];
const assetFilters: ("All" | Asset)[] = ["All", "BTC", "ETH", "SOL", "HYPE"];
const cadenceFilters: ("All" | "Daily" | "Weekly" | "Quarterly")[] = ["All", "Daily", "Weekly", "Quarterly"];

type Copy = ReturnType<typeof useCopy>;
type Locale = "en" | "tr";

function cadenceKey(value: "Daily" | "Weekly" | "Quarterly") {
  return value.toUpperCase() as MarketplaceListing["cadence"];
}

function localizedCadence(value: MarketplaceListing["cadence"], locale: Locale) {
  if (locale === "tr") {
    if (value === "DAILY") return "Gün";
    if (value === "WEEKLY") return "Hafta";
    return "Çeyrek";
  }
  if (value === "DAILY") return "Daily";
  if (value === "WEEKLY") return "Weekly";
  return "Quarterly";
}

function localizedDirection(value: MarketplaceListing["direction"], t: Copy) {
  return value === "HIGH" ? t.home.directionHighKey : t.home.directionLowKey;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatPrice(value: string | null, locale: Locale) {
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

function formatCountdown(ms: number, locale: Locale) {
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

/** Same rising/falling motif used across the pool board and pool detail. */
function DirectionMark({ direction }: { direction: MarketplaceListing["direction"] }) {
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

function CutoffCell({ listing, locale, t }: { listing: MarketplaceListing; locale: Locale; t: Copy }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!listing.tradingCutoffAt) {
    return <span className="ex-num">—</span>;
  }

  const cutoff = Date.parse(listing.tradingCutoffAt);
  const closed = now >= cutoff;

  return (
    <span className="ex-market-row__cutoff" data-closed={closed}>
      {closed ? t.marketplacePage.tradingClosed : `${t.marketplacePage.tradingClosesIn} ${formatCountdown(cutoff - now, locale)}`}
    </span>
  );
}

function MarketplaceRow({ listing, locale, t }: { listing: MarketplaceListing; locale: Locale; t: Copy }) {
  const config = assetConfigs[listing.asset];

  return (
    <Link className="ex-market-row" href={`/pools/${listing.slug}`}>
      <span className="ex-market-row__identity">
        <img src={config.brandSrc} alt="" />
        <span className="ex-market-row__identity-text">
          <span className="ex-market-row__symbol">{listing.asset}</span>
          <span className="ex-market-row__meta">
            {localizedCadence(listing.cadence, locale)} ·{" "}
            <span className="ex-market-row__dir">
              <DirectionMark direction={listing.direction} />
              {localizedDirection(listing.direction, t)}
            </span>
          </span>
        </span>
      </span>

      <span className="ex-market-row__stat">
        <span className="ex-num ex-market-row__val">{formatPrice(listing.predictionPrice, locale)}</span>
        <span className="ex-market-row__key">{t.marketplacePage.columnPrediction}</span>
      </span>

      <span className="ex-market-row__stat ex-market-row__stat--ask">
        <span className="ex-num ex-market-row__val ex-market-row__ask">{formatUsdc(listing.askUsdc, locale)}</span>
        <span className="ex-market-row__key">{t.marketplacePage.columnAsk}</span>
      </span>

      <span className="ex-market-row__stat">
        <span className="ex-num ex-market-row__val" title={listing.seller}>{shortAddress(listing.seller)}</span>
        <span className="ex-market-row__key">{t.marketplacePage.columnSeller}</span>
      </span>

      <span className="ex-market-row__stat">
        <span className="ex-num ex-market-row__val">{t.round} #{listing.roundId}</span>
        <CutoffCell listing={listing} locale={locale} t={t} />
      </span>
    </Link>
  );
}

export default function MarketplaceClient() {
  const { locale } = useLocale();
  const t = useCopy();
  const [asset, setAsset] = useState<"All" | Asset>("All");
  const [cadence, setCadence] = useState<"All" | "Daily" | "Weekly" | "Quarterly">("All");
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      try {
        const state = await backendApi.marketplace.listings();
        if (cancelled) return;
        setListings(state.listings);
        setBlockNumber(state.chain.blockNumber);
        setError("");
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unable to read Arc Testnet marketplace listings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void refresh();
    timer = setInterval(() => {
      void refresh();
    }, 30_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Only genuinely buyable listings belong on the public board. A listing
  // that is technically still ACTIVE onchain but has gone stale (approval
  // lost, ownership changed, trading window closed) is not something a
  // buyer can act on, so it stays out of this view entirely rather than
  // being shown as an inert row.
  const buyable = useMemo(() => listings.filter((listing) => listing.state === "ACTIVE"), [listings]);

  const filtered = useMemo(
    () =>
      buyable.filter(
        (listing) =>
          (asset === "All" || listing.asset === asset) &&
          (cadence === "All" || listing.cadence === cadenceKey(cadence)),
      ),
    [asset, cadence, buyable],
  );

  const groups = useMemo(
    () =>
      ASSET_ORDER.map((item) => ({
        asset: item,
        listings: filtered.filter((listing) => listing.asset === item),
      })).filter((group) => group.listings.length > 0),
    [filtered],
  );

  return (
    <>
      <div className="ex-shell ex-marketplace__head">
        <p className="ex-eyebrow">{t.marketplacePage.eyebrow}</p>
        <h1 className="ex-display ex-display--xl">{t.marketplacePage.title}</h1>
        <p className="ex-lede">{t.marketplacePage.lede}</p>
      </div>

      <div className="ex-shell">
        <div className="ex-rail">
          <div className="ex-rail__group">
            <span className="ex-rail__label">{t.poolsAssetFilter}</span>
            <div className="ex-rail__set" aria-label="Asset filter" role="group">
              {assetFilters.map((item) => (
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
              {cadenceFilters.map((item) => (
                <button
                  className="ex-rail__btn"
                  data-active={cadence === item}
                  key={item}
                  type="button"
                  onClick={() => setCadence(item)}
                >
                  {item === "All" ? t.all : item === "Daily" ? t.daily : item === "Weekly" ? t.weekly : t.quarterly}
                </button>
              ))}
            </div>
          </div>

          {!loading && !error && (
            <p className="ex-rail__meta">
              {filtered.length} {t.marketplacePage.listingsShown} · {t.poolsBlock} {blockNumber ?? "—"}
            </p>
          )}
        </div>

        {loading && <p className="ex-pools__note">{t.readingRounds}</p>}

        {!loading && error && (
          <div className="ex-pools__error">
            <h2 className="ex-display ex-display--md">{t.marketplacePage.listingsUnavailable}</h2>
            <p className="ex-lede">{error}</p>
            <p className="ex-pools__note" style={{ marginTop: 0 }}>{t.noMockFallback}</p>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="ex-pools__error">
            <h2 className="ex-display ex-display--md">{t.marketplacePage.noListings}</h2>
            <p className="ex-lede">{t.marketplacePage.noListingsBody}</p>
          </div>
        )}

        {!loading && !error && groups.length > 0 && (
          <div className="ex-board">
            {groups.map((group) => {
              const config = assetConfigs[group.asset];
              return (
                <section className="ex-asset" key={group.asset}>
                  <div className="ex-asset__head">
                    <span className="ex-asset__id">
                      <img src={config.brandSrc} alt="" />
                      <span className="ex-asset__symbol">{group.asset}</span>
                      <span className="ex-asset__name">{config.name}</span>
                    </span>
                  </div>

                  <div className="ex-market-ledger">
                    {group.listings.map((listing) => (
                      <MarketplaceRow key={listing.listingId} listing={listing} locale={locale} t={t} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
