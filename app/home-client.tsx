"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProductHeader } from "./product-components";
import { assetConfigs } from "./lib/asset-config";
import { readBinanceLiveMarket } from "./lib/live-market";
import { useCopy, useLocale } from "./i18n";

const HERO_IMAGE = "/images/extrema-mountains-v1.png";
const PENDING_PRICE = "···";

const BAND_ASSETS = [
  { symbol: "BTC", sourceSymbol: "BTCUSDT" },
  { symbol: "ETH", sourceSymbol: "ETHUSDT" },
  { symbol: "SOL", sourceSymbol: "SOLUSDT" },
  { symbol: "HYPE", sourceSymbol: "HYPEUSDT" },
] as const;

type BandPrice = { markPrice: string; source: string };

function formatMarkPrice(value: string, locale: "en" | "tr") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return PENDING_PRICE;

  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: numeric < 100 ? 2 : 0,
    minimumFractionDigits: numeric < 100 ? 2 : 0,
  }).format(numeric);
}

/**
 * Real Binance / CoinGecko mark prices only. When a price is unavailable the
 * slot stays empty. The homepage never substitutes an illustrative number.
 */
function LiveMarketBand() {
  const { locale } = useLocale();
  const t = useCopy();
  const [prices, setPrices] = useState<Record<string, BandPrice>>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const live = await readBinanceLiveMarket();
        if (cancelled) return;

        const next: Record<string, BandPrice> = {};
        for (const asset of BAND_ASSETS) {
          const price = live.prices[asset.sourceSymbol];
          if (price) next[asset.symbol] = { markPrice: price.markPrice, source: price.source };
        }
        setPrices(next);
      } catch {
        if (!cancelled) setPrices({});
      }
    }

    void load();
    const timer = window.setInterval(load, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const sources = Array.from(new Set(Object.values(prices).map((price) => price.source)));

  return (
    <div className="ex-band">
      {BAND_ASSETS.map((asset) => {
        const price = prices[asset.symbol];
        return (
          <div className="ex-band__item" key={asset.symbol}>
            <span className={`ex-band__asset${asset.symbol === "ETH" ? " ex-band__asset--eth-light" : ""}`}>
              <img src={assetConfigs[asset.symbol].brandSrc} alt="" />
              <span className="ex-band__symbol">{asset.symbol}</span>
            </span>
            <span className="ex-band__price" data-pending={price ? "false" : "true"}>
              {price ? formatMarkPrice(price.markPrice, locale) : PENDING_PRICE}
            </span>
          </div>
        );
      })}

      <div className="ex-band__meta">
        <span>
          <b>{t.home.bandEntry}</b> · {t.home.bandPools}
        </span>
        <span>
          {t.home.bandSource}
          {sources.length > 0 ? ` · ${sources.join(" · ")}` : ""}
        </span>
      </div>
    </div>
  );
}

function DirectionMark({ direction }: { direction: "high" | "low" }) {
  return (
    <svg
      className="ex-direction__mark"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {direction === "high" ? (
        <path d="M4 26 L12 14 L18 20 L28 6 M28 6 H21 M28 6 V13" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4 6 L12 18 L18 12 L28 26 M28 26 H21 M28 26 V19" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export default function HomeClient() {
  const t = useCopy();

  return (
    <main>
      {/* ---------------------------------------------------------------
          Hero. The artwork is the spatial structure, not a backdrop.
          Headline holds the dark left sky, the brand line holds the upper
          right, the peaks are left uncovered, and a full-width live data
          band anchors the bottom edge.
         --------------------------------------------------------------- */}
      <section className="ex-hero">
        <div className="ex-hero__media">
          <img src={HERO_IMAGE} alt="" />
        </div>
        <div className="ex-hero__scrim ex-hero__scrim--side" />
        <div className="ex-hero__scrim ex-hero__scrim--top" />
        <div className="ex-hero__scrim ex-hero__scrim--bottom" />

        <ProductHeader variant="overlay" />

        <div className="ex-hero__body ex-shell">
          <div className="ex-hero__lead">
            <p className="ex-eyebrow ex-eyebrow--dark">{t.home.eyebrow}</p>
            <h1 className="ex-display ex-display--xl ex-hero__title">
              {t.home.titleLineOne}
              <br />
              <em>{t.home.titleLineTwo}</em>
            </h1>
            <p className="ex-lede ex-lede--dark">{t.home.lede}</p>
            <div className="ex-hero__actions">
              <Link className="ex-btn ex-btn--primary" href="/pools">
                {t.home.ctaPrimary}
                <span className="ex-btn__arrow" aria-hidden="true">→</span>
              </Link>
              <Link className="ex-btn ex-btn--ghost-dark" href="/how-it-works">
                {t.home.ctaSecondary}
              </Link>
            </div>
          </div>

          <div className="ex-hero__aside">
            <p className="ex-hero__aside-line">
              {[t.home.asideLineOne, t.home.asideLineTwo].flatMap((line) => {
                const words = line.split(" ");
                return words.map((word, index) => (
                  <span key={`${line}-${word}`} data-strong={index === words.length - 1}>
                    {word}
                  </span>
                ));
              })}
            </p>

            <div className="ex-hero__verbs">
              <ul>
                <li>{t.home.verbPredict}</li>
                <li>{t.home.verbExplore}</li>
                <li>{t.home.verbCompete}</li>
                <li>{t.home.verbOwn}</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="ex-hero__band">
          <div className="ex-shell">
            <LiveMarketBand />
          </div>
        </div>
      </section>

      {/* --------------------------- Core mechanic --------------------------- */}
      <section className="ex-section">
        <div className="ex-shell">
          <div className="ex-mechanic__head">
            <div>
              <p className="ex-eyebrow">{t.home.mechanicEyebrow}</p>
              <h2 className="ex-display ex-display--lg">{t.home.mechanicTitle}</h2>
            </div>
            <p className="ex-lede">{t.home.mechanicLede}</p>
          </div>

          <ol className="ex-steps">
            <li>
              <div>
                <h3>{t.home.step1Title}</h3>
                <p>{t.home.step1Body}</p>
              </div>
            </li>
            <li>
              <div>
                <h3>{t.home.step2Title}</h3>
                <p>{t.home.step2Body}</p>
              </div>
            </li>
            <li>
              <div>
                <h3>{t.home.step3Title}</h3>
                <p>{t.home.step3Body}</p>
              </div>
            </li>
            <li>
              <div>
                <h3>{t.home.step4Title}</h3>
                <p>{t.home.step4Body}</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* ------------------------------ Market spec ------------------------------
          Assets, directions and horizons in one dense band. The 24 pools
          stated as a spec sheet rather than two sparse card rows.
         ------------------------------------------------------------------- */}
      <section className="ex-section" style={{ paddingTop: 0 }}>
        <div className="ex-shell">
          <div className="ex-mechanic__head">
            <div>
              <p className="ex-eyebrow">{t.home.gridEyebrow}</p>
              <h2 className="ex-display ex-display--lg">{t.home.gridTitle}</h2>
            </div>
            <p className="ex-lede">{t.home.gridLede}</p>
          </div>

          <div className="ex-spec">
            <div className="ex-spec__row">
              <span className="ex-spec__label">{t.home.gridAssetsLabel}</span>
              <div className="ex-spec__items">
                {BAND_ASSETS.map((asset) => (
                  <span className="ex-spec__asset" key={asset.symbol}>
                    <img src={assetConfigs[asset.symbol].brandSrc} alt="" />
                    {asset.symbol}
                  </span>
                ))}
              </div>
            </div>

            <div className="ex-spec__row">
              <span className="ex-spec__label">{t.home.gridDirectionsLabel}</span>
              <div className="ex-spec__items">
                <span className="ex-spec__item">
                  <span className="ex-spec__key">
                    <DirectionMark direction="high" />
                    {t.home.directionHighKey}
                  </span>
                  <span className="ex-spec__note">{t.home.directionHighBody}</span>
                </span>
                <span className="ex-spec__item">
                  <span className="ex-spec__key">
                    <DirectionMark direction="low" />
                    {t.home.directionLowKey}
                  </span>
                  <span className="ex-spec__note">{t.home.directionLowBody}</span>
                </span>
              </div>
            </div>

            <div className="ex-spec__row">
              <span className="ex-spec__label">{t.home.horizonsEyebrow}</span>
              <div className="ex-spec__items">
                <span className="ex-spec__item">
                  <span className="ex-spec__key">{t.home.horizonDayKey}</span>
                  <span className="ex-spec__meta">{t.home.horizonDayWindow}</span>
                </span>
                <span className="ex-spec__item">
                  <span className="ex-spec__key">{t.home.horizonWeekKey}</span>
                  <span className="ex-spec__meta">{t.home.horizonWeekWindow}</span>
                </span>
                <span className="ex-spec__item">
                  <span className="ex-spec__key">{t.home.horizonQuarterKey}</span>
                  <span className="ex-spec__meta">{t.home.horizonQuarterWindow}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------- Verifiable result --------------------------- */}
      <section className="ex-verify ex-section">
        <div className="ex-shell">
          <div className="ex-verify__head">
            <div>
              <p className="ex-eyebrow ex-eyebrow--dark">{t.home.verifyEyebrow}</p>
              <h2 className="ex-display ex-display--lg" style={{ color: "var(--on-dark)" }}>
                {t.home.verifyTitle}
              </h2>
            </div>
            <p className="ex-lede ex-lede--dark">{t.home.verifyLede}</p>
          </div>

          <ul className="ex-evidence">
            <li>
              <span className="ex-evidence__tag">{t.home.verifyChainTag}</span>
              <h3>{t.home.verifyChainTitle}</h3>
              <p>{t.home.verifyChainBody}</p>
            </li>
            <li>
              <span className="ex-evidence__tag">{t.home.verifyPriceTag}</span>
              <h3>{t.home.verifyPriceTitle}</h3>
              <p>{t.home.verifyPriceBody}</p>
            </li>
            <li>
              <span className="ex-evidence__tag">{t.home.verifyOwnerTag}</span>
              <h3>{t.home.verifyOwnerTitle}</h3>
              <p>{t.home.verifyOwnerBody}</p>
            </li>
          </ul>
        </div>
      </section>

      {/* ------------------------------ Payout model ------------------------------ */}
      <section className="ex-section">
        <div className="ex-shell ex-payout">
          <div>
            <p className="ex-eyebrow">{t.home.payoutEyebrow}</p>
            <h2 className="ex-display ex-display--lg" style={{ margin: "14px 0 16px" }}>
              {t.home.payoutTitle}
            </h2>
            <p className="ex-lede">{t.home.payoutBody}</p>
          </div>

          <div className="ex-split">
            <div className="ex-split__bar" role="img" aria-label="54% / 22.5% / 13.5% / 10%">
              <span className="ex-split__seg ex-split__seg--1" style={{ width: "54%" }} />
              <span className="ex-split__seg ex-split__seg--2" style={{ width: "22.5%" }} />
              <span className="ex-split__seg ex-split__seg--3" style={{ width: "13.5%" }} />
              <span className="ex-split__seg ex-split__seg--treasury" style={{ width: "10%" }} />
            </div>

            <div className="ex-split__legend">
              <div className="ex-split__item">
                <span className="ex-split__pct">54%</span>
                <span className="ex-split__label">{t.home.payoutFirst}</span>
              </div>
              <div className="ex-split__item">
                <span className="ex-split__pct">22.5%</span>
                <span className="ex-split__label">{t.home.payoutSecond}</span>
              </div>
              <div className="ex-split__item">
                <span className="ex-split__pct">13.5%</span>
                <span className="ex-split__label">{t.home.payoutThird}</span>
              </div>
              <div className="ex-split__item">
                <span className="ex-split__pct">10%</span>
                <span className="ex-split__label">{t.home.payoutTreasury}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------ Closing ------------------------------ */}
      <section className="ex-close">
        <div className="ex-close__media">
          <img src={HERO_IMAGE} alt="" />
        </div>
        <div className="ex-close__scrim" />
        <div className="ex-shell ex-close__inner">
          <div className="ex-close__copy">
            <h2 className="ex-display ex-display--lg" style={{ color: "var(--on-dark)" }}>
              {t.home.closeTitle}
            </h2>
            <p className="ex-lede ex-lede--dark">{t.home.closeLede}</p>
            <div className="ex-hero__actions">
              <Link className="ex-btn ex-btn--primary" href="/pools">
                {t.home.ctaPrimary}
                <span className="ex-btn__arrow" aria-hidden="true">→</span>
              </Link>
              <Link className="ex-btn ex-btn--ghost-dark" href="/how-it-works">
                {t.home.ctaSecondary}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="ex-foot">
        <div className="ex-shell ex-foot__inner">
          <small>{t.home.footNote}</small>
          <nav className="ex-foot__links">
            <Link href="/pools">{t.pools}</Link>
            <Link href="/leaderboard">{t.leaderboard}</Link>
            <Link href="/how-it-works">{t.howItWorks}</Link>
            <Link href="/tickets">{t.myTickets}</Link>
            <Link href="/wallet">{t.createConnectWallet}</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
