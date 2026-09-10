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
  expiresAtMs: number;
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

    // Recovery records written before expiresAtMs existed are treated as
    // expired. confirmCircleEntry() still performs one read-only
    // reconciliation probe before discarding them, so an already-submitted
    // transaction is never blindly replaced by a new financial intent.
    const expiresAtMs =
      typeof parsed.expiresAtMs === "number" &&
      Number.isFinite(parsed.expiresAtMs)
        ? parsed.expiresAtMs
        : 0;

    return {
      ...parsed,
      expiresAtMs,
    } as CircleEntryRecovery;
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

// ---------------------------------------------------------------------------
// Durable recovery for every other Circle financial action (transfer, refund,
// claim, and the four marketplace actions). One record per tab, one intent at
// a time: a reload or a lost response resumes the SAME server action and
// challenge instead of ever creating a second financial intent.
// ---------------------------------------------------------------------------

export const CIRCLE_ACTION_RECOVERY_KEY = "extrema-circle-action-recovery-v1";

export type CircleRecoverableActionType =
  | "TRANSFER_TICKET"
  | "REFUND_TICKET"
  | "CLAIM_REWARD"
  | "MARKETPLACE_LIST"
  | "MARKETPLACE_UPDATE_PRICE"
  | "MARKETPLACE_CANCEL"
  | "MARKETPLACE_BUY";

const CIRCLE_RECOVERABLE_ACTION_TYPES: readonly CircleRecoverableActionType[] = [
  "TRANSFER_TICKET",
  "REFUND_TICKET",
  "CLAIM_REWARD",
  "MARKETPLACE_LIST",
  "MARKETPLACE_UPDATE_PRICE",
  "MARKETPLACE_CANCEL",
  "MARKETPLACE_BUY",
];

export type CircleActionRecoveryPhase =
  | "START_PENDING"
  | "APPROVAL_CHALLENGE"
  | "APPROVAL_PENDING"
  | "ACTION_CHALLENGE"
  | "ACTION_PENDING";

const CIRCLE_ACTION_RECOVERY_PHASES: readonly CircleActionRecoveryPhase[] = [
  "START_PENDING",
  "APPROVAL_CHALLENGE",
  "APPROVAL_PENDING",
  "ACTION_CHALLENGE",
  "ACTION_PENDING",
];

export type CircleActionRecovery = {
  actionType: CircleRecoverableActionType;
  intentKey: string;
  requestId: string;
  // Null only while START_PENDING, before the server has named the action.
  actionId: string | null;
  payloadHash: string | null;
  phase: CircleActionRecoveryPhase;
  challengeId: string | null;
  approvalTxHash: string | null;
  expiresAtMs: number;
};

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

export function readCircleActionRecovery(): CircleActionRecovery | null {
  try {
    const value = window.sessionStorage.getItem(CIRCLE_ACTION_RECOVERY_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CircleActionRecovery>;
    if (
      !CIRCLE_RECOVERABLE_ACTION_TYPES.includes(parsed.actionType as CircleRecoverableActionType) ||
      !CIRCLE_ACTION_RECOVERY_PHASES.includes(parsed.phase as CircleActionRecoveryPhase) ||
      typeof parsed.intentKey !== "string" || !parsed.intentKey ||
      typeof parsed.requestId !== "string" || !parsed.requestId ||
      !isStringOrNull(parsed.actionId) || !isStringOrNull(parsed.payloadHash) ||
      !isStringOrNull(parsed.challengeId) || !isStringOrNull(parsed.approvalTxHash) ||
      (parsed.phase !== "START_PENDING" && (!parsed.actionId || !parsed.payloadHash))
    ) return null;
    const expiresAtMs =
      typeof parsed.expiresAtMs === "number" && Number.isFinite(parsed.expiresAtMs)
        ? parsed.expiresAtMs
        : 0;
    return { ...parsed, expiresAtMs } as CircleActionRecovery;
  } catch {
    return null;
  }
}

export function storeCircleActionRecovery(recovery: CircleActionRecovery) {
  window.sessionStorage.setItem(CIRCLE_ACTION_RECOVERY_KEY, JSON.stringify(recovery));
}

export function clearCircleActionRecovery() {
  window.sessionStorage.removeItem(CIRCLE_ACTION_RECOVERY_KEY);
}

export function matchesCircleEntryRecovery(
  recovery: CircleEntryRecovery,
  intent: { poolAddress: string; roundId: number; predictionPriceCents: number },
) {
  return recovery.poolAddress.toLowerCase() === intent.poolAddress.toLowerCase() &&
    recovery.roundId === intent.roundId &&
    recovery.predictionPriceCents === intent.predictionPriceCents;
}
