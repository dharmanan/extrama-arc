"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ProductHeader } from "../../../product-components";
import { humanRoundStatus } from "../../../lib/display";
import { useCopy, useLocale } from "../../../i18n";

type Integrity = { evidenceHashValid: boolean; poolIdentityMatches: boolean; marketPeriodMatches: boolean; resolvedPriceMatchesOnchain: boolean | null };
type Evidence = { status: "VERIFIED" | "INTEGRITY_MISMATCH"; source: string; endpoint: string; symbol: string; cadence: "DAILY" | "WEEKLY" | "QUARTERLY"; direction: "HIGH" | "LOW"; interval: string; marketPeriod: { startInclusive: string; endExclusive: string }; candleCount: number; sourceDataSha256: string; rounding: string; selected: { exact: string; resolvedPriceCents: string; candleOpenTime: number; candleOpenIso: string }; evidenceSha256: string; createdAt: string; settlementTxHash: string | null; integrity: Integrity };
export type VerificationResult = { chain: { id: number; name: string; explorerUrl: string }; pool: { slug: string; poolAddress: string; asset: string; direction: "HIGH" | "LOW"; cadence: "DAILY" | "WEEKLY" | "QUARTERLY"; sourceSymbol: string }; round: { roundId: number; contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED"; marketPeriodStartAt: string | null; marketPeriodEndAt: string | null; settlementEligibleAt: string; resolvedPriceCents: string; resolvedPrice: string | null }; verification: { status: "PENDING" } | { status: "NOT_APPLICABLE"; reason: string } | { status: "EVIDENCE_MISSING" | "EVIDENCE_INTEGRITY_FAILED"; reason: string } | Evidence };

type Copy = ReturnType<typeof useCopy>;
type Locale = "en" | "tr";

function formatUsd(value: string, locale: Locale) { const n = Number(value); return Number.isFinite(n) ? new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) : value; }
function formatUtcDateTime(value: string, locale: Locale) { return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) + " UTC"; }
function cadence(value: "DAILY" | "WEEKLY" | "QUARTERLY", locale: Locale) { return (locale === "tr" ? { DAILY: "Gün", WEEKLY: "Hafta", QUARTERLY: "Çeyrek" } : { DAILY: "Daily", WEEKLY: "Weekly", QUARTERLY: "Quarterly" })[value]; }
function direction(value: "HIGH" | "LOW", locale: Locale) { return (locale === "tr" ? { HIGH: "Yüksek", LOW: "Düşük" } : { HIGH: "High", LOW: "Low" })[value]; }

function explorerLink(explorerUrl: string, kind: "tx" | "address", value: string) {
  if (!/^https:\/\//.test(explorerUrl)) return null;
  return `${explorerUrl.replace(/\/+$/, "")}/${kind}/${value}`;
}

// A long address, hash or endpoint takes its own full row and wraps only
// where it has to, instead of breaking inside a narrow column.
function CodeValue({ value, href, linkLabel }: { value: string; href?: string | null; linkLabel?: string }) {
  if (!href) return <span className="ex-proof__code">{value}</span>;
  return (
    <a className="ex-proof__code ex-proof__code-link" href={href} target="_blank" rel="noreferrer" aria-label={`${linkLabel ?? ""} ${value}`.trim()}>
      {value}
    </a>
  );
}

function Check({ label, valid }: { label: string; valid: boolean }) { const t = useCopy(); return <li data-valid={valid}><span>{label}</span><b>{valid ? t.verify.matches : t.verify.mismatchValue}</b></li>; }

type SummaryState = "pass" | "fail" | "none";

function SummaryRow({ label, detail, state, t }: { label: string; detail: ReactNode; state: SummaryState; t: Copy }) {
  const mark = state === "pass" ? "✓" : state === "fail" ? "✕" : "○";
  return (
    <li className="ex-proof__check" data-state={state}>
      <span className="ex-proof__mark" aria-hidden="true">{mark}</span>
      <div>
        <strong>
          {label}
          {state === "pass" && <span className="ex-proof__sr">: {t.verify.checkPassed}</span>}
        </strong>
        <span>{detail}</span>
      </div>
      {state === "fail" && <small>{t.verify.checkFailed}</small>}
    </li>
  );
}

// The four user facing checks each restate exactly one backend integrity
// boolean; none claims more than that boolean proves.
function VerificationSummary({ evidence, result, locale, t }: { evidence: Evidence; result: VerificationResult; locale: Locale; t: Copy }) {
  const { integrity } = evidence;
  const onchainState: SummaryState = integrity.resolvedPriceMatchesOnchain === null
    ? "none"
    : integrity.resolvedPriceMatchesOnchain ? "pass" : "fail";
  return (
    <section className="ex-proof__summary" aria-labelledby="proof-checks">
      <p id="proof-checks" className="ex-eyebrow">{t.verify.checks}</p>
      <ul>
        <SummaryRow
          t={t}
          label={t.verify.checkMarketData}
          detail={<span className="ex-num">Binance {evidence.symbol}</span>}
          state={integrity.poolIdentityMatches ? "pass" : "fail"}
        />
        <SummaryRow
          t={t}
          label={t.verify.checkMarketPeriod}
          detail={<span className="ex-num" suppressHydrationWarning>{formatUtcDateTime(evidence.marketPeriod.startInclusive, locale)} → {formatUtcDateTime(evidence.marketPeriod.endExclusive, locale)}</span>}
          state={integrity.marketPeriodMatches ? "pass" : "fail"}
        />
        <SummaryRow
          t={t}
          label={t.verify.checkRecordedOnArc}
          detail={onchainState === "none"
            ? t.verify.checkNotRecorded
            : <span className="ex-num">{result.round.resolvedPrice ? formatUsd(result.round.resolvedPrice, locale) : "—"}</span>}
          state={onchainState}
        />
        <SummaryRow
          t={t}
          label={t.verify.checkEvidence}
          detail={integrity.evidenceHashValid ? t.verify.checkPassed : t.verify.evidenceIssue}
          state={integrity.evidenceHashValid ? "pass" : "fail"}
        />
      </ul>
    </section>
  );
}

function TechnicalProof({ children, t }: { children: ReactNode; t: Copy }) {
  return (
    <details className="ex-proof__technical">
      <summary>
        <span>{t.verify.technicalProof}</span>
        <small>{t.verify.technicalProofBody}</small>
      </summary>
      <div className="ex-proof__technical-body">{children}</div>
    </details>
  );
}

function Unavailable({ invalid }: { invalid: boolean }) { const t = useCopy(); return <main className="ex-pools ex-proof"><ProductHeader /><div className="ex-shell ex-result__unavailable"><p className="ex-eyebrow">{t.verify.eyebrow}</p><h1 className="ex-display ex-display--md">{t.verify.unavailable}</h1>{!invalid && <p className="ex-lede">{t.verify.unavailableBody}</p>}<Link href="/pools" className="ex-pool__back">← {t.verify.backToPools}</Link></div></main>; }

export function VerifyClient({ result, invalid = false }: { result: VerificationResult | null; invalid?: boolean }) {
  const { locale } = useLocale(); const t = useCopy();
  if (!result) return <Unavailable invalid={invalid} />;
  const { pool, round, verification } = result;
  const evidence = verification.status === "VERIFIED" || verification.status === "INTEGRITY_MISMATCH" ? verification : null;
  const warning = verification.status === "EVIDENCE_MISSING" || verification.status === "EVIDENCE_INTEGRITY_FAILED" || verification.status === "INTEGRITY_MISMATCH";
  const title = verification.status === "VERIFIED" ? t.verify.verified : verification.status === "PENDING" ? t.verify.pending : verification.status === "NOT_APPLICABLE" ? t.verify.notApplicable : verification.status === "INTEGRITY_MISMATCH" ? t.verify.mismatch : t.verify.evidenceIssue;
  const body = verification.status === "VERIFIED" ? t.verify.verifiedBody : verification.status === "PENDING" ? t.verify.pendingBody : verification.status === "NOT_APPLICABLE" ? t.verify.cancelledBody : verification.status === "INTEGRITY_MISMATCH" ? t.verify.mismatchBody : t.verify.evidenceIssueBody;
  const poolHref = explorerLink(result.chain.explorerUrl, "address", pool.poolAddress);

  return <main className="ex-pools ex-proof"><ProductHeader /><div className="ex-shell">
    <Link href={`/results/${pool.slug}/${round.roundId}`} className="ex-pool__back">← {t.verify.backToResult}</Link>

    {/* Plain language verdict */}
    <section className="ex-proof__head" data-warning={warning} style={{ paddingBottom: "clamp(28px, 3.4vw, 44px)" }}>
      <div>
        <p className="ex-eyebrow">{t.verify.eyebrow}</p>
        <h1 className="ex-display ex-display--lg">{title}</h1>
        <p className="ex-proof__verdict">{body}</p>
        <p className="ex-proof__identity">{pool.asset} · {cadence(pool.cadence, locale)} {direction(pool.direction, locale)} · {t.result.round} #{round.roundId}</p>
      </div>
      <div className="ex-proof__hero">
        {verification.status === "VERIFIED" && evidence && <><span>{t.verify.resolvedPrice}</span><strong className="ex-num">{formatUsd((Number(evidence.selected.resolvedPriceCents) / 100).toFixed(2), locale)}</strong></>}
        {verification.status === "INTEGRITY_MISMATCH" && <><span>{t.verify.onchainPrice}</span><strong className="ex-num">{round.resolvedPrice ? formatUsd(round.resolvedPrice, locale) : "—"}</strong></>}
        {verification.status === "PENDING" && <dl><div><dt>{t.verify.currentStatus}</dt><dd>{humanRoundStatus(round.contractStatus, locale)}</dd></div><div><dt>{t.verify.observationEnds}</dt><dd><span suppressHydrationWarning>{formatUtcDateTime(round.settlementEligibleAt, locale)}</span></dd></div></dl>}
        {(verification.status === "NOT_APPLICABLE" || verification.status === "EVIDENCE_MISSING" || verification.status === "EVIDENCE_INTEGRITY_FAILED") && <dl><div><dt>{t.verify.currentStatus}</dt><dd>{humanRoundStatus(round.contractStatus, locale)}</dd></div></dl>}
      </div>
    </section>

    {evidence && <VerificationSummary evidence={evidence} result={result} locale={locale} t={t} />}

    {verification.status === "PENDING" && <section className="ex-proof__pending" aria-labelledby="proof-readiness" style={{ paddingBlock: "clamp(28px, 3.4vw, 44px)" }}><div className="ex-result__section-head" style={{ gridTemplateColumns: "minmax(220px, 1.7fr) minmax(280px, 4fr)", paddingBottom: "clamp(14px, 1.8vw, 22px)" }}><div><p className="ex-eyebrow">{t.verify.readiness}</p><h2 id="proof-readiness" className="ex-display" style={{ fontSize: "clamp(1.3rem, 1.8vw, 1.65rem)", lineHeight: 1 }}>{t.verify.pending}</h2></div><p>{t.verify.pendingBody}</p></div><ol className="ex-progress-rail"><li><span className="ex-progress-rail__number">01</span><div><h3>{t.verify.readinessRound}</h3><p>{t.verify.readinessRoundBody}</p><small className="ex-num">{pool.asset} · {pool.sourceSymbol} · #{round.roundId}</small></div></li><li><span className="ex-progress-rail__number">02</span><div><h3>{t.verify.readinessObservation}</h3><p className="ex-num">{round.marketPeriodStartAt && round.marketPeriodEndAt ? <>{formatUtcDateTime(round.marketPeriodStartAt, locale)}<br />→ {formatUtcDateTime(round.marketPeriodEndAt, locale)}</> : "Legacy V1"}</p></div></li><li><span className="ex-progress-rail__number">03</span><div><h3>{t.verify.readinessSettlement}</h3><p>{t.verify.readinessSettlementBody}</p><small>{humanRoundStatus(round.contractStatus, locale)}</small></div></li><li><span className="ex-progress-rail__number">04</span><div><h3>{t.verify.readinessVerification}</h3><p>{t.verify.readinessVerificationBody}</p></div></li></ol></section>}

    {/* Technical proof, collapsed by default */}
    {evidence && <TechnicalProof t={t}>
      <ol className="ex-proof__sequence">
        <li><span className="ex-proof__number">01</span><div><h2>{t.verify.source}</h2><dl><div><dt>{t.verify.symbol}</dt><dd className="ex-num">{evidence.symbol}</dd></div><div><dt>{t.verify.interval}</dt><dd className="ex-num">{evidence.interval}</dd></div><div className="ex-proof__wide"><dt>{t.verify.endpoint}</dt><dd><CodeValue value={evidence.endpoint} /></dd></div></dl></div></li>
        <li><span className="ex-proof__number">02</span><div><h2>{t.verify.window}</h2><dl><div><dt>{t.verify.observationWindow}</dt><dd><span suppressHydrationWarning>{formatUtcDateTime(evidence.marketPeriod.startInclusive, locale)} → {formatUtcDateTime(evidence.marketPeriod.endExclusive, locale)}</span></dd></div><div><dt>{t.verify.candles}</dt><dd className="ex-num">{evidence.candleCount}</dd></div></dl></div></li>
        <li><span className="ex-proof__number">03</span><div><h2>{t.verify.extremum}</h2><dl><div><dt>{t.verify.selectedValue}</dt><dd className="ex-num">{evidence.selected.exact}</dd></div><div><dt>{t.verify.selectedCandle}</dt><dd className="ex-num"><span suppressHydrationWarning>{formatUtcDateTime(evidence.selected.candleOpenIso, locale)}</span></dd></div><div><dt>{t.verify.rounding}</dt><dd>{evidence.rounding}</dd></div></dl></div></li>
        <li><span className="ex-proof__number">04</span><div><h2>{t.verify.onchain}</h2><dl><div><dt>{t.verify.onchainPrice}</dt><dd className="ex-num">{round.resolvedPrice ? formatUsd(round.resolvedPrice, locale) : "—"}</dd></div><div className="ex-proof__wide"><dt>{t.verify.pool}</dt><dd><CodeValue value={pool.poolAddress} href={poolHref} linkLabel={t.verify.viewOnExplorer} /></dd></div>{evidence.settlementTxHash && <div className="ex-proof__wide"><dt>{t.verify.settlementTransaction}</dt><dd><CodeValue value={evidence.settlementTxHash} href={explorerLink(result.chain.explorerUrl, "tx", evidence.settlementTxHash)} linkLabel={t.verify.viewOnExplorer} /></dd></div>}</dl></div></li>
        <li><span className="ex-proof__number">05</span><div><h2>{t.verify.hashes}</h2><dl><div className="ex-proof__wide"><dt>{t.verify.sourceHash}</dt><dd><CodeValue value={evidence.sourceDataSha256} /></dd></div><div className="ex-proof__wide"><dt>{t.verify.evidenceHash}</dt><dd><CodeValue value={evidence.evidenceSha256} /></dd></div></dl></div></li>
      </ol>
      <section className="ex-proof__checks" data-warning={verification.status === "INTEGRITY_MISMATCH"}><div><p className="ex-eyebrow">{t.verify.integrity}</p><h2 className="ex-display ex-display--md">{verification.status === "VERIFIED" ? t.verify.verified : t.verify.mismatch}</h2></div><ul><Check label={t.verify.evidenceHash} valid={evidence.integrity.evidenceHashValid} /><Check label={t.verify.pool} valid={evidence.integrity.poolIdentityMatches} /><Check label={t.verify.observationWindow} valid={evidence.integrity.marketPeriodMatches} />{evidence.integrity.resolvedPriceMatchesOnchain !== null && <Check label={t.verify.onchainPrice} valid={evidence.integrity.resolvedPriceMatchesOnchain} />}</ul></section>
    </TechnicalProof>}

    {verification.status === "PENDING" && <TechnicalProof t={t}>
      <dl className="ex-proof__document-meta"><div><dt>{result.chain.name}</dt><dd className="ex-num">{result.chain.id}</dd></div><div><dt>{t.verify.pool}</dt><dd><CodeValue value={pool.poolAddress} href={poolHref} linkLabel={t.verify.viewOnExplorer} /></dd></div><div><dt>{t.verify.currentStatus}</dt><dd>{humanRoundStatus(round.contractStatus, locale)}</dd></div></dl>
    </TechnicalProof>}

    {(verification.status === "EVIDENCE_MISSING" || verification.status === "EVIDENCE_INTEGRITY_FAILED" || verification.status === "NOT_APPLICABLE") && <TechnicalProof t={t}>
      <dl className="ex-proof__document-meta"><div><dt>{t.verify.reason}</dt><dd><span className="ex-proof__reason">{verification.reason}</span></dd></div><div><dt>{t.verify.pool}</dt><dd><CodeValue value={pool.poolAddress} href={poolHref} linkLabel={t.verify.viewOnExplorer} /></dd></div><div><dt>{t.verify.currentStatus}</dt><dd>{humanRoundStatus(round.contractStatus, locale)}</dd></div></dl>
    </TechnicalProof>}
  </div></main>;
}
