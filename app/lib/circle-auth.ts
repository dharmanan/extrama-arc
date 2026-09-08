"use client";

export type CircleTabAuth = {
  userToken: string;
  encryptionKey: string;
};

export const CIRCLE_AUTH_KEY = "extrema-circle-auth-v1";
export const CIRCLE_ENTRY_RECOVERY_KEY = "extrema-circle-entry-recovery-v1";

export type CircleEntryRecoveryPhase =
  | "APPROVAL_CHALLENGE"
  | "APPROVAL_PENDING"
  | "ENTRY_CHALLENGE"
  | "ENTRY_PENDING";

export type CircleEntryRecovery = {
  requestId: string;
  actionId: string;
  payloadHash: string;
  poolAddress: string;
  roundId: number;
  predictionPriceCents: number;
  phase: CircleEntryRecoveryPhase;
  challengeId: string | null;
  approvalTxHash: string | null;
};

export function readCircleTabAuth(): CircleTabAuth | null {
  try {
    const value = window.sessionStorage.getItem(CIRCLE_AUTH_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CircleTabAuth>;
    return typeof parsed.userToken === "string" && parsed.userToken &&
      typeof parsed.encryptionKey === "string" && parsed.encryptionKey
      ? { userToken: parsed.userToken, encryptionKey: parsed.encryptionKey }
      : null;
  } catch {
    return null;
  }
}

export function storeCircleTabAuth(auth: CircleTabAuth) {
  window.sessionStorage.setItem(CIRCLE_AUTH_KEY, JSON.stringify(auth));
}

export function readCircleEntryRecovery(): CircleEntryRecovery | null {
  try {
    const value = window.sessionStorage.getItem(CIRCLE_ENTRY_RECOVERY_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CircleEntryRecovery>;
    const validPhase = parsed.phase === "APPROVAL_CHALLENGE" || parsed.phase === "APPROVAL_PENDING" ||
      parsed.phase === "ENTRY_CHALLENGE" || parsed.phase === "ENTRY_PENDING";
    if (
      typeof parsed.requestId !== "string" || typeof parsed.actionId !== "string" ||
      typeof parsed.payloadHash !== "string" || typeof parsed.poolAddress !== "string" ||
      !Number.isInteger(parsed.roundId) || !Number.isInteger(parsed.predictionPriceCents) || !validPhase ||
      !(typeof parsed.challengeId === "string" || parsed.challengeId === null) ||
      !(typeof parsed.approvalTxHash === "string" || parsed.approvalTxHash === null)
    ) return null;
    return parsed as CircleEntryRecovery;
  } catch {
    return null;
  }
}

export function storeCircleEntryRecovery(recovery: CircleEntryRecovery) {
  window.sessionStorage.setItem(CIRCLE_ENTRY_RECOVERY_KEY, JSON.stringify(recovery));
}

export function clearCircleEntryRecovery() {
  window.sessionStorage.removeItem(CIRCLE_ENTRY_RECOVERY_KEY);
}

export function matchesCircleEntryRecovery(
  recovery: CircleEntryRecovery,
  intent: { poolAddress: string; roundId: number; predictionPriceCents: number },
) {
  return recovery.poolAddress.toLowerCase() === intent.poolAddress.toLowerCase() &&
    recovery.roundId === intent.roundId &&
    recovery.predictionPriceCents === intent.predictionPriceCents;
}
