import Link from "next/link";
import { ProductHeader } from "../../../product-components";

type RoundVerificationIntegrity = {
  evidenceHashValid: boolean;
  poolIdentityMatches: boolean;
  observationWindowMatches: boolean;
  resolvedPriceMatchesOnchain: boolean;
};

type RoundVerificationSelected = {
  exact: string;
  resolvedPriceCents: string;
  candleOpenTime: number;
  candleOpenIso: string;
};

type RoundVerification =
  | { status: "PENDING" }
  | { status: "NOT_APPLICABLE"; reason: string }
  | { status: "EVIDENCE_MISSING"; reason: string }
  | { status: "EVIDENCE_INTEGRITY_FAILED"; reason: string }
  | {
      status: "VERIFIED" | "INTEGRITY_MISMATCH";
      source: string;
      endpoint: string;
      symbol: string;
      cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
      direction: "HIGH" | "LOW";
      interval: string;
      observationWindow: { startInclusive: string; endExclusive: string };
      candleCount: number;
      sourceDataSha256: string;
      rounding: string;
      selected: RoundVerificationSelected;
      evidenceSha256: string;
      createdAt: string;
      settlementTxHash: string | null;
      integrity: RoundVerificationIntegrity;
    };

type RoundVerificationResponse = {
  chain: { id: number; name: string; explorerUrl: string };
  pool: {
    slug: string;
    poolAddress: string;
    asset: string;
    direction: "HIGH" | "LOW";
    cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
    sourceSymbol: string;
  };
  round: {
    roundId: number;
    contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
    observationStartAt: string;
    observationEndAt: string;
    resolvedPriceCents: string;
    resolvedPrice: string | null;
  };
  verification: RoundVerification;
};

function backendBaseUrl() {
  return process.env.BACKEND_API_URL || "http://127.0.0.1:3001/api";
}

async function loadVerification(slug: string, roundId: number): Promise<RoundVerificationResponse | null> {
  const response = await fetch(
    `${backendBaseUrl()}/rounds/${encodeURIComponent(slug)}/${roundId}/verification`,
    { cache: "no-store" },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`round_verification_http_${response.status}`);
  }

  return response.json() as Promise<RoundVerificationResponse>;
}

function formatUsd(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
}

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ slug: string; roundId: string }>;
}) {
  const { slug, roundId: roundIdParam } = await params;
  const roundId = Number(roundIdParam);

  if (!Number.isInteger(roundId) || roundId <= 0) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>Verification not available</h1>
          <Link href="/pools">Back to pools</Link>
        </section>
      </main>
    );
  }

  const result = await loadVerification(slug, roundId);

  if (!result) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <h1>Verification not available</h1>
          <p>No onchain round matches this pool and round ID.</p>
          <Link href="/pools">Back to pools</Link>
        </section>
      </main>
    );
  }

  const { pool, round, verification } = result;

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>SETTLEMENT VERIFICATION</p>
        <h1>
          {pool.asset} · {titleCase(pool.cadence)} {titleCase(pool.direction)} · Round #{round.roundId}
        </h1>

        {verification.status === "PENDING" && (
          <section className="wf-panel wf-section">
            <p>Settlement verification will be available after this round settles.</p>
            <p>
              Current status: <b>{round.contractStatus}</b>
            </p>
            <p>Observation ends: {round.observationEndAt}</p>
          </section>
        )}

        {verification.status === "NOT_APPLICABLE" && (
          <section className="wf-panel wf-section">
            <p>This round was cancelled.</p>
            <p>Settlement verification is not applicable.</p>
          </section>
        )}

        {(verification.status === "EVIDENCE_MISSING" || verification.status === "EVIDENCE_INTEGRITY_FAILED") && (
          <section className="wf-panel wf-section">
            <p>This round is settled, but its settlement evidence could not be confirmed.</p>
            <p>
              Reason: <code>{verification.reason}</code>
            </p>
            <p>This is not a verified settlement.</p>
          </section>
        )}

        {verification.status === "VERIFIED" && (
          <section className="wf-panel wf-section">
            <small>Official resolved price</small>
            <h2>{round.resolvedPrice ? formatUsd(round.resolvedPrice) : "Unavailable"}</h2>
          </section>
        )}

        {verification.status === "INTEGRITY_MISMATCH" && (
          <section className="wf-panel wf-section">
            <p>Persisted settlement evidence exists for this round, but it does not fully match onchain state.</p>
            <p>This settlement is not verified.</p>
          </section>
        )}

        {(verification.status === "VERIFIED" || verification.status === "INTEGRITY_MISMATCH") && (
          <>
            <section className="wf-panel wf-section">
              <p>
                <b>Source:</b> {verification.source}
              </p>
              <p>
                <b>Symbol:</b> {verification.symbol}
              </p>
              <p>
                <b>Interval:</b> {verification.interval}
              </p>
              <p>
                <b>Observation starts:</b> {verification.observationWindow.startInclusive}
              </p>
              <p>
                <b>Observation ends:</b> {verification.observationWindow.endExclusive}
              </p>
              <p>
                <b>Candle count:</b> {verification.candleCount}
              </p>
              <p>
                <b>Rounding rule:</b> {verification.rounding}
              </p>
              <p>
                <b>
                  Selected {verification.direction} exact source value:
                </b>{" "}
                {verification.selected.exact}
              </p>
              <p>
                <b>Selected candle timestamp:</b> {verification.selected.candleOpenIso}
              </p>
              <p>
                <b>Source data SHA-256:</b>
              </p>
              <p className="wf-code">{verification.sourceDataSha256}</p>
              <p>
                <b>Evidence SHA-256:</b>
              </p>
              <p className="wf-code">{verification.evidenceSha256}</p>
              {verification.settlementTxHash && (
                <>
                  <p>
                    <b>Settlement transaction:</b>
                  </p>
                  <p className="wf-code">{verification.settlementTxHash}</p>
                </>
              )}
            </section>

            <section className="wf-panel wf-section">
              <h2>Integrity checks</h2>
              {verification.status === "VERIFIED" ? (
                <>
                  <p>Evidence hash: PASS</p>
                  <p>Observation window: PASS</p>
                  <p>Onchain resolved price: PASS</p>
                  <p>Pool identity: PASS</p>
                </>
              ) : (
                <>
                  <p>Evidence hash: {verification.integrity.evidenceHashValid ? "matches" : "does not match"}</p>
                  <p>
                    Observation window:{" "}
                    {verification.integrity.observationWindowMatches ? "matches" : "does not match"}
                  </p>
                  <p>
                    Onchain resolved price:{" "}
                    {verification.integrity.resolvedPriceMatchesOnchain ? "matches" : "does not match"}
                  </p>
                  <p>Pool identity: {verification.integrity.poolIdentityMatches ? "matches" : "does not match"}</p>
                </>
              )}
            </section>
          </>
        )}

        <div className="wf-row">
          <Link className="wf-action" href={`/results/${slug}/${roundId}`}>
            Back to result
          </Link>
        </div>
      </section>
    </main>
  );
}
