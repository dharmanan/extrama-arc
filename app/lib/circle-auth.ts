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

// Gateway preparation has a distinct recovery record. It deliberately stores
// only public action identity and a challenge id; Circle credentials stay in
// CIRCLE_AUTH_KEY and a completed signature is stored server-side only after
// local signer recovery.
export const CIRCLE_GATEWAY_FUNDING_RECOVERY_KEY = "extrema-circle-gateway-funding-recovery-v1";

export type CircleGatewayFundingRecovery = {
  requestId: string;
  actionId: string;
  payloadHash: string | null;
  sourceDomain: number;
  valueRaw: string;
  challengeId: string | null;
  expiresAtMs: number;
};

export function readCircleGatewayFundingRecovery(): CircleGatewayFundingRecovery | null {
  try {
    const value = window.sessionStorage.getItem(CIRCLE_GATEWAY_FUNDING_RECOVERY_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CircleGatewayFundingRecovery>;
    if (
      typeof parsed.requestId !== "string" || !parsed.requestId ||
      typeof parsed.actionId !== "string" || !parsed.actionId ||
      !(typeof parsed.payloadHash === "string" || parsed.payloadHash === null) ||
      typeof parsed.sourceDomain !== "number" ||
      !Number.isInteger(parsed.sourceDomain) || parsed.sourceDomain < 0 ||
      typeof parsed.valueRaw !== "string" || !/^[1-9][0-9]*$/.test(parsed.valueRaw) ||
      !(typeof parsed.challengeId === "string" || parsed.challengeId === null) ||
      typeof parsed.expiresAtMs !== "number" || !Number.isFinite(parsed.expiresAtMs)
    ) return null;
    return parsed as CircleGatewayFundingRecovery;
  } catch {
    return null;
  }
}

export function storeCircleGatewayFundingRecovery(recovery: CircleGatewayFundingRecovery) {
  window.sessionStorage.setItem(CIRCLE_GATEWAY_FUNDING_RECOVERY_KEY, JSON.stringify(recovery));
}

export function clearCircleGatewayFundingRecovery() {
  window.sessionStorage.removeItem(CIRCLE_GATEWAY_FUNDING_RECOVERY_KEY);
}

// Prepare Base Sepolia (Part C) is a one-shot wallet creation challenge, not a
// financial action, but Circle still dedupes by idempotency key: a reload
// before the challenge completes must reuse the SAME key and challenge id
// rather than asking Circle to create a second, unrelated wallet challenge.
export const CIRCLE_BASE_WALLET_RECOVERY_KEY = "extrema-circle-base-wallet-recovery-v1";

export type CircleBaseWalletRecovery = {
  idempotencyKey: string;
  challengeId: string | null;
  expiresAtMs: number;
};

export function readCircleBaseWalletRecovery(): CircleBaseWalletRecovery | null {
  try {
    const value = window.sessionStorage.getItem(CIRCLE_BASE_WALLET_RECOVERY_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CircleBaseWalletRecovery>;
    if (
      typeof parsed.idempotencyKey !== "string" || !parsed.idempotencyKey ||
      !(typeof parsed.challengeId === "string" || parsed.challengeId === null) ||
      typeof parsed.expiresAtMs !== "number" || !Number.isFinite(parsed.expiresAtMs)
    ) return null;
    return parsed as CircleBaseWalletRecovery;
  } catch {
    return null;
  }
}

export function storeCircleBaseWalletRecovery(recovery: CircleBaseWalletRecovery) {
  window.sessionStorage.setItem(CIRCLE_BASE_WALLET_RECOVERY_KEY, JSON.stringify(recovery));
}

export function clearCircleBaseWalletRecovery() {
  window.sessionStorage.removeItem(CIRCLE_BASE_WALLET_RECOVERY_KEY);
}

// Gateway SOURCE deposit (Part D/E/F) recovery. Distinct from the funding
// recovery above: this covers the approve-then-deposit phases that get USDC
// into the unified balance, not the burn-intent signature that spends it.
export const CIRCLE_GATEWAY_DEPOSIT_RECOVERY_KEY = "extrema-circle-gateway-deposit-recovery-v1";

export type CircleGatewayDepositPhase =
  | "APPROVAL_CHALLENGE"
  | "APPROVAL_PENDING"
  | "DEPOSIT_CHALLENGE"
  | "DEPOSIT_PENDING";

export type CircleGatewayDepositRecovery = {
  requestId: string;
  actionId: string;
  sourceDomain: number;
  amountRaw: string;
  phase: CircleGatewayDepositPhase;
  challengeId: string | null;
  expiresAtMs: number;
};

export function readCircleGatewayDepositRecovery(): CircleGatewayDepositRecovery | null {
  try {
    const value = window.sessionStorage.getItem(CIRCLE_GATEWAY_DEPOSIT_RECOVERY_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CircleGatewayDepositRecovery>;
    const validPhase = parsed.phase === "APPROVAL_CHALLENGE" || parsed.phase === "APPROVAL_PENDING" ||
      parsed.phase === "DEPOSIT_CHALLENGE" || parsed.phase === "DEPOSIT_PENDING";
    if (
      typeof parsed.requestId !== "string" || !parsed.requestId ||
      typeof parsed.actionId !== "string" || !parsed.actionId ||
      typeof parsed.sourceDomain !== "number" || !Number.isInteger(parsed.sourceDomain) || parsed.sourceDomain < 0 ||
      typeof parsed.amountRaw !== "string" || !/^[1-9][0-9]*$/.test(parsed.amountRaw) ||
      !validPhase ||
      !(typeof parsed.challengeId === "string" || parsed.challengeId === null) ||
      typeof parsed.expiresAtMs !== "number" || !Number.isFinite(parsed.expiresAtMs)
    ) return null;
    return parsed as CircleGatewayDepositRecovery;
  } catch {
    return null;
  }
}

export function storeCircleGatewayDepositRecovery(recovery: CircleGatewayDepositRecovery) {
  window.sessionStorage.setItem(CIRCLE_GATEWAY_DEPOSIT_RECOVERY_KEY, JSON.stringify(recovery));
}

export function clearCircleGatewayDepositRecovery() {
  window.sessionStorage.removeItem(CIRCLE_GATEWAY_DEPOSIT_RECOVERY_KEY);
}

// External wallet Gateway deposit/burn recovery holds only public recovery
// identity: request/action ids, phase, source domain, value, and a tx hash or
// expiry when known. The connected wallet itself is never stored here.
export const EXTERNAL_GATEWAY_DEPOSIT_RECOVERY_KEY = "extrema-external-gateway-deposit-recovery-v1";

export type ExternalGatewayDepositPhase = "APPROVAL_REQUIRED" | "DEPOSIT_REQUIRED" | "RECONCILING";

export type ExternalGatewayDepositRecovery = {
  requestId: string;
  actionId: string;
  sourceDomain: number;
  amountRaw: string;
  phase: ExternalGatewayDepositPhase;
  approvalTxHash: string | null;
  depositTxHash: string | null;
  expiresAtMs: number;
};

export function readExternalGatewayDepositRecovery(): ExternalGatewayDepositRecovery | null {
  try {
    const value = window.sessionStorage.getItem(EXTERNAL_GATEWAY_DEPOSIT_RECOVERY_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<ExternalGatewayDepositRecovery>;
    const validPhase = parsed.phase === "APPROVAL_REQUIRED" || parsed.phase === "DEPOSIT_REQUIRED" ||
      parsed.phase === "RECONCILING";
    if (
      typeof parsed.requestId !== "string" || !parsed.requestId ||
      typeof parsed.actionId !== "string" || !parsed.actionId ||
      typeof parsed.sourceDomain !== "number" || !Number.isInteger(parsed.sourceDomain) || parsed.sourceDomain < 0 ||
      typeof parsed.amountRaw !== "string" || !/^[1-9][0-9]*$/.test(parsed.amountRaw) ||
      !validPhase ||
      !(typeof parsed.approvalTxHash === "string" || parsed.approvalTxHash === null) ||
      !(typeof parsed.depositTxHash === "string" || parsed.depositTxHash === null) ||
      typeof parsed.expiresAtMs !== "number" || !Number.isFinite(parsed.expiresAtMs)
    ) return null;
    return parsed as ExternalGatewayDepositRecovery;
  } catch {
    return null;
  }
}

export function storeExternalGatewayDepositRecovery(recovery: ExternalGatewayDepositRecovery) {
  window.sessionStorage.setItem(EXTERNAL_GATEWAY_DEPOSIT_RECOVERY_KEY, JSON.stringify(recovery));
}

export function clearExternalGatewayDepositRecovery() {
  window.sessionStorage.removeItem(EXTERNAL_GATEWAY_DEPOSIT_RECOVERY_KEY);
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
