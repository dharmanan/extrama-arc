import { VerifyClient, type VerificationResult } from "./VerifyClient";

function backendBaseUrl() {
  return process.env.BACKEND_API_URL || "http://127.0.0.1:3001/api";
}

async function loadVerification(slug: string, roundId: number): Promise<VerificationResult | null> {
  const response = await fetch(
    `${backendBaseUrl()}/rounds/${encodeURIComponent(slug)}/${roundId}/verification`,
    { cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`round_verification_http_${response.status}`);
  return response.json() as Promise<VerificationResult>;
}

export default async function VerifyPage({ params }: { params: Promise<{ slug: string; roundId: string }> }) {
  const { slug, roundId: roundIdParam } = await params;
  const roundId = Number(roundIdParam);
  if (!Number.isInteger(roundId) || roundId <= 0) return <VerifyClient result={null} invalid />;
  const result = await loadVerification(slug, roundId);
  return <VerifyClient result={result} />;
}
