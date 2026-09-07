"use client";

import Link from "next/link";
import { ProductHeader } from "../product-components";
import { useCopy } from "../i18n";

export default function HowItWorksPage() {
  const t = useCopy();

  const steps = [
    [t.howItWorksPage.step1Title, t.howItWorksPage.step1Body],
    [t.howItWorksPage.step2Title, t.howItWorksPage.step2Body],
    [t.howItWorksPage.step3Title, t.howItWorksPage.step3Body],
    [t.howItWorksPage.step4Title, t.howItWorksPage.step4Body],
    [t.howItWorksPage.step5Title, t.howItWorksPage.step5Body],
    [t.howItWorksPage.step6Title, t.howItWorksPage.step6Body],
  ];

  return (
    <main className="ex-howitworks">
      <ProductHeader />

      <div className="ex-shell ex-howitworks__head">
        <p className="ex-eyebrow">{t.howItWorksPage.eyebrow}</p>
        <h1 className="ex-display ex-display--xl">{t.howItWorksPage.title}</h1>
        <p className="ex-lede">{t.howItWorksPage.lede}</p>
      </div>

      <section className="ex-section" style={{ paddingTop: 0 }}>
        <div className="ex-shell">
          <ol className="ex-steps">
            {steps.map(([title, body]) => (
              <li key={title}>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="ex-section" style={{ paddingTop: 0 }}>
        <div className="ex-shell ex-payout">
          <div>
            <p className="ex-eyebrow">{t.howItWorksPage.payoutEyebrow}</p>
            <h2 className="ex-display ex-display--lg" style={{ margin: "14px 0 16px" }}>
              {t.howItWorksPage.payoutTitle}
            </h2>
            <p className="ex-lede">{t.howItWorksPage.payoutLede}</p>
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

      <section className="ex-howitworks__close">
        <div className="ex-shell ex-howitworks__close-inner">
          <div>
            <h2 className="ex-display ex-display--md">{t.howItWorksPage.closeTitle}</h2>
            <p className="ex-lede">{t.howItWorksPage.closeLede}</p>
          </div>
          <div className="ex-howitworks__close-actions">
            <Link className="ex-btn ex-btn--ink" href="/pools">
              {t.howItWorksPage.ctaPrimary}
              <span className="ex-btn__arrow" aria-hidden="true">→</span>
            </Link>
            <Link className="ex-btn ex-btn--ghost" href="/leaderboard">
              {t.howItWorksPage.ctaSecondary}
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
