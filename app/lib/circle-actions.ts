"use client";

// Circle user controlled wallet financial action client.
//
// Every Circle transaction is signed by the user's own Circle wallet inside a
// Circle hosted challenge; EXTREMA never signs for a Circle user. One shared
// machinery covers every action:
//
//   confirmCircleEntry()   ENTRY, the first Circle action proven live
//   confirmCircleAction()  transfer, refund, claim, and the four marketplace
//                          actions, one phase or approval plus action
//
// Both share the same session refresh, hosted challenge execution, polling,
// durable per tab recovery, and the same rule: an uncertain outcome is always
// reconciled against the existing server action and never answered by
// creating a second financial intent.

import {
  backendApi,
  type CircleActionApprovalVerifyResponse,
  type CircleActionPayloadMap,
  type CircleActionPendingResponse,
  type CircleActionResultMap,
  type CircleActionStartResponse,
  type CircleActionType,
  type CircleActionVerifyResponse,
  type CircleApprovalActionType,
  type CircleEntryApprovalVerifyResponse,
  type CircleEntryVerifyResponse,
  type GatewayFundingResponse,
} from "./backend-api";
import {
  clearCircleActionRecovery,
  clearCircleEntryRecovery,
  clearCircleGatewayFundingRecovery,
  matchesCircleEntryRecovery,
  readCircleActionRecovery,
  readCircleEntryRecovery,
  readCircleGatewayFundingRecovery,
  readCircleTabAuth,
  storeCircleActionRecovery,
  storeCircleEntryRecovery,
  storeCircleGatewayFundingRecovery,
  storeCircleTabAuth,
  type CircleActionRecovery,
  type CircleEntryRecovery,
  type CircleGatewayFundingRecovery,
  type CircleTabAuth,
} from "./circle-auth";

type CircleChallengeResult = {
  type?: string;
  status?: string;
  data?: { signature?: string };
};

type CircleSdk = {
  getDeviceId(): Promise<string>;
  setAuthentication(auth: { userToken: string; encryptionKey: string }): void;
  execute(
    challengeId: string,
    onCompleted?: (
      error: { message: string } | undefined,
      result?: CircleChallengeResult,
    ) => void,
  ): void;
};

const CIRCLE_VERIFY_POLL_INTERVAL_MS = 4000;
const CIRCLE_VERIFY_MAX_ATTEMPTS = 45;

const EXTREMA_SESSION_ERRORS = new Set([
  "authentication_required",
  "invalid_session",
  "session_expired",
]);

let circleSessionRefreshPromise: Promise<unknown> | null = null;

// The EXTREMA application session lasts seven days; Circle's userToken and
// encryptionKey are deliberately kept tab-scoped only (sessionStorage), never
// persisted. That split is intentional, but it means the application session
// can legitimately be alive while a tab's Circle credentials are gone -- a
// reopened browser, a new tab, or sessionStorage simply being cleared. Every
// Circle FINANCIAL entry point must go through this helper instead of
// asserting readCircleTabAuth() directly, so that state restores the tab
// credentials via the existing secure refresh (bound to the SAME session
// identity, server-verified) and continues the SAME requested financial
// intent, rather than failing before the request ever reaches the backend.
//
// This performs authentication restoration ONLY: no financial intent, no
// Circle challenge, no approve, no deposit, no transfer, no broadcast.
let circleFinancialAuthBootstrapPromise: Promise<CircleTabAuth> | null = null;

export async function ensureCircleFinancialAuth(): Promise<CircleTabAuth> {
  const existing = readCircleTabAuth();
  if (existing) return existing;

  // Single-flight: if several financial callers discover missing auth at
  // once, exactly one refresh request is made and every caller receives the
  // same restored credentials, never a separate credential rotation each.
  if (!circleFinancialAuthBootstrapPromise) {
    circleFinancialAuthBootstrapPromise = (async (): Promise<CircleTabAuth> => {
      let refreshed: Awaited<ReturnType<typeof backendApi.circle.refreshSession>>;
      try {
        refreshed = await backendApi.circle.refreshSession(await getCircleDeviceId());
      } catch {
        // The backend's own refresh route is already the authority on
        // whether this session may restore Circle credentials: it requires
        // the live EXTREMA session, reads only that session's own encrypted
        // refresh credentials, and re-verifies the rotated token resolves to
        // the SAME wallet id and address before returning anything. Any
        // failure there -- no stored credentials, identity mismatch, Circle
        // itself refusing the rotation -- means this tab cannot safely
        // restore Circle auth, and the only correct outcome is the same
        // reauthentication prompt a cold session would show.
        throw new Error("circle_reauthentication_required");
      }
      if (
        typeof refreshed?.userToken !== "string" || !refreshed.userToken ||
        typeof refreshed?.encryptionKey !== "string" || !refreshed.encryptionKey
      ) {
        throw new Error("circle_reauthentication_required");
      }
      // Store ONLY the credential pair every other Circle tab record already
      // expects; the rest of the refresh response (wallet identity) is not
      // persisted here.
      const auth: CircleTabAuth = {
        userToken: refreshed.userToken,
        encryptionKey: refreshed.encryptionKey,
      };
      storeCircleTabAuth(auth);
      return auth;
    })().finally(() => {
      circleFinancialAuthBootstrapPromise = null;
    });
  }

  return circleFinancialAuthBootstrapPromise;
}

// This creates only the Circle SDK device context needed by the documented
// refresh endpoint. It does not set authentication, create a challenge, or
// execute a transaction.
export async function getCircleDeviceId() {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
  if (!appId) throw new Error("circle_reauthentication_required");
  const module = await import("@circle-fin/w3s-pw-web-sdk");
  const sdk = new module.W3SSdk({ appSettings: { appId } }) as unknown as CircleSdk;
  return sdk.getDeviceId();
}

async function restoreExtremaCircleSession(userToken: string) {
  try {
    await backendApi.circle.session(userToken);
    return;
  } catch (sessionCause) {
    // A persisted EXTREMA session can safely authorize a Circle token refresh.
    // If it has expired too, this call fails closed and the caller shows the
    // ordinary hosted Circle sign-in rather than attempting a challenge.
    const tabAuth = readCircleTabAuth();
    if (!tabAuth) throw sessionCause;
    const refreshed = await backendApi.circle.refreshSession(
      await getCircleDeviceId(),
    );
    storeCircleTabAuth({
      userToken: refreshed.userToken,
      encryptionKey: refreshed.encryptionKey,
    });
  }
}

async function withFreshExtremaCircleSession<T>(
  userToken: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !EXTREMA_SESSION_ERRORS.has(cause.message)
    ) {
      throw cause;
    }

    if (!circleSessionRefreshPromise) {
      circleSessionRefreshPromise = restoreExtremaCircleSession(userToken)
        .finally(() => {
          circleSessionRefreshPromise = null;
        });
    }

    await circleSessionRefreshPromise;

    // Retry the SAME read/start request once. Never create a second
    // financial intent or automatically execute a hosted challenge.
    return operation();
  }
}

async function verifyCircleApprovalOnce(
  actionId: string,
  userToken: string,
) {
  return withFreshExtremaCircleSession(
    userToken,
    () => backendApi.actions.verifyCircleEntryApproval(actionId, userToken),
  );
}

async function verifyCircleEntryOnce(
  actionId: string,
  userToken: string,
) {
  return withFreshExtremaCircleSession(
    userToken,
    () => backendApi.actions.verifyCircleEntry(actionId, userToken),
  );
}

// Exported for gateway-actions.ts's Circle deposit flow, which executes the
// same hosted challenges through the same SDK entry point.
export async function executeHostedChallenge(challengeId: string) {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
  if (!appId) throw new Error("circle_reauthentication_required");
  const auth = await ensureCircleFinancialAuth();
  const module = await import("@circle-fin/w3s-pw-web-sdk");
  const sdk = new module.W3SSdk({ appSettings: { appId } }) as unknown as CircleSdk;
  // The hosted SDK establishes its device context before a challenge executes.
  // The value is intentionally transient and never added to recovery storage.
  await sdk.getDeviceId();
  sdk.setAuthentication(auth);
  const result = await new Promise<CircleChallengeResult | undefined>(
    (resolve, reject) => {
      sdk.execute(
        challengeId,
        (error, challengeResult) =>
          error
            ? reject(new Error(error.message))
            : resolve(challengeResult),
      );
    },
  );

  if (result?.status === "FAILED" || result?.status === "EXPIRED") {
    throw new Error("circle_transaction_failed");
  }

  return result;
}

function recoveryFor(
  input: { poolAddress: string; roundId: number; predictionPriceCents: number },
  requestId: string,
  started: { actionId: string; payloadHash: string },
  phase: CircleEntryRecovery["phase"],
  challengeId: string | null,
  expiresInSeconds: number,
): CircleEntryRecovery {
  return {
    ...input,
    requestId,
    actionId: started.actionId,
    payloadHash: started.payloadHash,
    phase,
    challengeId,
    approvalTxHash: null,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
}

function clearRecoveryForTerminalError(error: unknown) {
  if (error instanceof Error && (
    error.message === "circle_transaction_failed" ||
    error.message === "circle_entry_action_expired_after_approval"
  )) {
    clearCircleEntryRecovery();
  }
}

async function resumeCircleEntry(recovery: CircleEntryRecovery, userToken: string) {
  if (recovery.phase === "APPROVAL_CHALLENGE") {
    if (!recovery.challengeId) throw new Error("circle_entry_recovery_invalid");
    const probe = await verifyCircleApprovalOnce(
      recovery.actionId,
      userToken,
    );
    if ("pending" in probe && probe.pending && probe.transactionObserved) {
      const pending = { ...recovery, phase: "APPROVAL_PENDING" as const, challengeId: null };
      storeCircleEntryRecovery(pending);
      return resumeCircleEntry(pending, userToken);
    }
    if (!("pending" in probe) && probe.confirmed) {
      const entryRecovery = {
        ...recovery,
        phase: "ENTRY_CHALLENGE" as const,
        challengeId: probe.challengeId,
        approvalTxHash: probe.approvalTxHash,
      };
      storeCircleEntryRecovery(entryRecovery);
      return resumeCircleEntry(entryRecovery, userToken);
    }
    await executeHostedChallenge(recovery.challengeId);
    storeCircleEntryRecovery({ ...recovery, phase: "APPROVAL_PENDING", challengeId: null });
    return resumeCircleEntry({ ...recovery, phase: "APPROVAL_PENDING", challengeId: null }, userToken);
  }
  if (recovery.phase === "APPROVAL_PENDING") {
    const approval = await waitForCircleResult(
      () => verifyCircleApprovalOnce(recovery.actionId, userToken),
    ) as CircleEntryApprovalVerifyResponse;
    if (approval.actionId !== recovery.actionId || approval.payloadHash !== recovery.payloadHash) {
      throw new Error("circle_approval_verification_failed");
    }
    const entryRecovery = {
      ...recovery,
      phase: "ENTRY_CHALLENGE" as const,
      challengeId: approval.challengeId,
      approvalTxHash: approval.approvalTxHash,
    };
    storeCircleEntryRecovery(entryRecovery);
    return resumeCircleEntry(entryRecovery, userToken);
  }
  if (recovery.phase === "ENTRY_CHALLENGE") {
    if (!recovery.challengeId) throw new Error("circle_entry_recovery_invalid");
    const probe = await verifyCircleEntryOnce(
      recovery.actionId,
      userToken,
    );
    if ("pending" in probe && probe.pending && probe.transactionObserved) {
      const pending = { ...recovery, phase: "ENTRY_PENDING" as const, challengeId: null };
      storeCircleEntryRecovery(pending);
      return resumeCircleEntry(pending, userToken);
    }
    if (!("pending" in probe) && probe.confirmed) {
      if (
        probe.actionId !== recovery.actionId || probe.payloadHash !== recovery.payloadHash ||
        probe.result.roundId !== recovery.roundId ||
        probe.result.predictionPriceCents !== recovery.predictionPriceCents ||
        probe.result.poolAddress.toLowerCase() !== recovery.poolAddress.toLowerCase()
      ) throw new Error("circle_entry_verification_failed");
      clearCircleEntryRecovery();
      return { ...probe.result, approvalTxHash: recovery.approvalTxHash ?? probe.result.approvalTxHash };
    }
    await executeHostedChallenge(recovery.challengeId);
    const pending = { ...recovery, phase: "ENTRY_PENDING" as const, challengeId: null };
    storeCircleEntryRecovery(pending);
    return resumeCircleEntry(pending, userToken);
  }
  const verified = await waitForCircleResult(
    () => verifyCircleEntryOnce(recovery.actionId, userToken),
  ) as CircleEntryVerifyResponse;
  if (
    verified.actionId !== recovery.actionId || verified.payloadHash !== recovery.payloadHash ||
    verified.result.roundId !== recovery.roundId ||
    verified.result.predictionPriceCents !== recovery.predictionPriceCents ||
    verified.result.poolAddress.toLowerCase() !== recovery.poolAddress.toLowerCase()
  ) throw new Error("circle_entry_verification_failed");
  clearCircleEntryRecovery();
  return { ...verified.result, approvalTxHash: recovery.approvalTxHash ?? verified.result.approvalTxHash };
}

async function waitForCircleResult<T>(read: () => Promise<T>) {
  for (
    let attempt = 0;
    attempt < CIRCLE_VERIFY_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const result = await read();

    if (
      !(
        typeof result === "object" &&
        result !== null &&
        "pending" in result &&
        result.pending === true
      )
    ) {
      return result;
    }

    await new Promise((resolve) =>
      window.setTimeout(resolve, CIRCLE_VERIFY_POLL_INTERVAL_MS),
    );
  }

  throw new Error("circle_transaction_pending");
}

export async function confirmCircleEntry(input: {
  poolAddress: string;
  roundId: number;
  predictionPriceCents: number;
  requestId: string;
}) {
  const auth = await ensureCircleFinancialAuth();

  let pending = readCircleEntryRecovery();

  if (pending && !matchesCircleEntryRecovery(pending, input)) {
    try {
      const [walletState, rounds] = await withFreshExtremaCircleSession(
        auth.userToken,
        () => Promise.all([
          backendApi.wallet.get(),
          backendApi.rounds.list(),
        ]),
      );

      const walletAddress = walletState.wallet?.address ?? null;
      const recoveryPool = rounds.pools.find(
        (pool) => pool.poolAddress.toLowerCase() === pending!.poolAddress.toLowerCase(),
      );

      if (walletAddress && recoveryPool) {
        const entries = await backendApi.rounds.entries(
          recoveryPool.slug,
          pending.roundId,
        );

        const completed = entries.entries.some(
          (entry) =>
            entry.originalEntrant.toLowerCase() === walletAddress.toLowerCase() &&
            entry.predictionPriceCents === String(pending!.predictionPriceCents),
        );

        if (completed) {
          clearCircleEntryRecovery();
          pending = null;
        }
      }
    } catch {
      // A failed read must never discard a genuinely pending action.
    }
  }

  if (pending && !matchesCircleEntryRecovery(pending, input)) {
    throw new Error("circle_pending_action_for_different_intent");
  }

  if (pending && pending.expiresAtMs <= Date.now()) {
    const probe = pending.phase === "APPROVAL_CHALLENGE" ||
        pending.phase === "APPROVAL_PENDING"
      ? await verifyCircleApprovalOnce(pending.actionId, auth.userToken)
      : await verifyCircleEntryOnce(pending.actionId, auth.userToken);

    if (
      "pending" in probe &&
      probe.pending &&
      !probe.transactionObserved
    ) {
      clearCircleEntryRecovery();
      throw new Error("circle_entry_recovery_expired");
    }

    // If Circle already sees a transaction, do not discard recovery merely
    // because the local action TTL elapsed. Resume the existing action and
    // reconcile that single financial intent to its terminal state.
  }

  if (pending) {
    try {
      return await resumeCircleEntry(pending, auth.userToken);
    } catch (error) {
      clearRecoveryForTerminalError(error);
      throw error;
    }
  }
  const started = await withFreshExtremaCircleSession(
    auth.userToken,
    () => backendApi.actions.startCircleEntry({
      poolAddress: input.poolAddress,
      roundId: input.roundId,
      predictionPriceCents: input.predictionPriceCents,
      circleUserToken: auth.userToken,
      circleRequestId: input.requestId,
    }),
  );
  const recovery = recoveryFor(
    input,
    input.requestId,
    started,
    started.step === "APPROVAL_REQUIRED" ? "APPROVAL_CHALLENGE" : "ENTRY_CHALLENGE",
    started.challengeId,
    started.expiresInSeconds,
  );
  storeCircleEntryRecovery(recovery);
  try {
    return await resumeCircleEntry(recovery, auth.userToken);
  } catch (error) {
    clearRecoveryForTerminalError(error);
    throw error;
  }
}

function isGatewayFundingRecoveryFor(
  recovery: CircleGatewayFundingRecovery,
  input: { destinationDomain: number; valueRaw: string },
) {
  return recovery.destinationDomain === input.destinationDomain &&
    recovery.valueRaw === input.valueRaw;
}

function gatewayRecoveryFrom(
  input: { requestId: string; destinationDomain: number; valueRaw: string },
  started: {
    actionId: string;
    payloadHash: string | null;
    challengeId: string | null;
    signatureIndex: number;
    expiresAt: string;
  },
): CircleGatewayFundingRecovery {
  return {
    ...input,
    actionId: started.actionId,
    payloadHash: started.payloadHash,
    challengeId: started.challengeId,
    signatureIndex: started.signatureIndex,
    expiresAtMs: Date.parse(started.expiresAt),
  };
}

export const GATEWAY_FUNDING_TERMINAL_NO_SUBMISSION = "gateway_funding_terminal_no_submission";

// This is deliberately evidence-aware. A state name alone cannot release a
// browser recovery record: a transfer id or transaction hash means there is a
// durable financial outcome to reconcile, even when the row is failed.
export function isGatewayFundingTerminalWithoutSubmission(
  action: GatewayFundingResponse,
) {
  return action.terminal === true &&
    (action.state === "SIGNATURE_FAILED" || action.state === "FAILED" || action.state === "EXPIRED") &&
    action.readyToBroadcast === false &&
    action.broadcast === "NOT_SUBMITTED" &&
    action.transferId === null &&
    action.transactionHash === null;
}

function releaseCircleGatewayFundingRecovery(action: GatewayFundingResponse): never {
  if (isGatewayFundingTerminalWithoutSubmission(action)) {
    clearCircleGatewayFundingRecovery();
    throw new Error(GATEWAY_FUNDING_TERMINAL_NO_SUBMISSION);
  }
  throw new Error("gateway_signature_challenge_unavailable");
}

// The browser prepares and verifies the exact Gateway signatures, then stops at
// READY_TO_BROADCAST. Submission is a server-side gated operation; the client
// never gets a broadcast control and refreshes only recover the same action.
//
// The server may resolve the requested amount across several source balances,
// in which case it asks for one signature per allocation and names which one
// it wants next. This loop signs exactly the allocation the server asks for,
// in the order it asks, and stores the resumable position after each step.
export async function prepareCircleGatewayFundingReview(
  input: {
    requestId: string;
    destinationDomain: number;
    valueRaw: string;
  },
) {
  const auth = await ensureCircleFinancialAuth();

  let recovery = readCircleGatewayFundingRecovery();
  if (recovery && !isGatewayFundingRecoveryFor(recovery, input)) {
    throw new Error("circle_pending_action_for_different_intent");
  }

  let current: GatewayFundingResponse;
  if (!recovery) {
    const started = await withFreshExtremaCircleSession(
      auth.userToken,
      () => backendApi.wallet.startGatewayFunding({
        ...input,
        circleUserToken: auth.userToken,
      }),
    );
    recovery = gatewayRecoveryFrom(input, started);
    storeCircleGatewayFundingRecovery(recovery);
    current = started;
  } else {
    // Preparation after reload reads the SAME durable action. It never signs
    // or executes the hosted challenge.
    current = await withFreshExtremaCircleSession(
      auth.userToken,
      () => backendApi.wallet.gatewayFunding(recovery!.actionId),
    );
  }

  if (isGatewayFundingTerminalWithoutSubmission(current)) {
    releaseCircleGatewayFundingRecovery(current);
  }
  if (current.recovery === "CONFLICT") {
    recovery = gatewayRecoveryFrom(input, current);
    storeCircleGatewayFundingRecovery(recovery);
    return current;
  }
  if (current.terminal) throw new Error("gateway_signature_challenge_uncertain");
  if (!current.readyToBroadcast && !current.costReview) {
    throw new Error("gateway_cost_review_unavailable");
  }
  return current;
}

export async function confirmPreparedCircleGatewayFunding(
  input: {
    destinationDomain: number;
    valueRaw: string;
  },
  onProgress?: (signed: number, total: number) => void,
) {
  const auth = await ensureCircleFinancialAuth();

  let recovery = readCircleGatewayFundingRecovery();
  if (!recovery) throw new Error("gateway_review_required");
  if (!isGatewayFundingRecoveryFor(recovery, input)) {
    throw new Error("circle_pending_action_for_different_intent");
  }

  // Hydration is a read-only probe of the SAME durable action. In particular,
  // it must observe a terminal failed challenge before any attempt could
  // execute the old Circle challenge again.
  let current = await withFreshExtremaCircleSession(
    auth.userToken,
    () => backendApi.wallet.gatewayFunding(recovery!.actionId),
  );

  if (isGatewayFundingTerminalWithoutSubmission(current)) {
    releaseCircleGatewayFundingRecovery(current);
  }
  if (current.recovery === "CONFLICT") {
    // The server found another unresolved same-wallet action. Persist only a
    // pointer to that authoritative action so the Wallet can recover it; do
    // not create a challenge or sign anything for the fresh request.
    recovery = gatewayRecoveryFrom({ requestId: recovery.requestId, ...input }, current);
    storeCircleGatewayFundingRecovery(recovery);
    return current;
  }
  if (current.terminal) {
    throw new Error("gateway_signature_challenge_uncertain");
  }
  if (!current.costReview) throw new Error("gateway_cost_review_unavailable");

  // One pass per allocation, bounded by Circle's own 16 intent cap so a
  // misbehaving response can never spin here.
  for (let pass = 0; pass <= 16; pass += 1) {
    if (current.readyToBroadcast) {
      // Keep the same durable action recoverable through submission and finality.
      // The Wallet clears this record only after COMPLETED or a proven clean
      // pre-submission terminal response.
      return current;
    }
    if (!current.pending || current.signatureIndex < 0 || !current.challengeId) {
      throw new Error("gateway_signature_challenge_unavailable");
    }

    // Track the position BEFORE executing, so a reload resumes this exact
    // allocation and its exact challenge rather than restarting the plan.
    recovery = {
      ...recovery,
      signatureIndex: current.signatureIndex,
      challengeId: current.challengeId,
    };
    storeCircleGatewayFundingRecovery(recovery);
    onProgress?.(current.signatureIndex, current.intentCount);

    let result: CircleChallengeResult | undefined;
    try {
      result = await executeHostedChallenge(current.challengeId);
    } catch (error) {
      // The hosted widget can report failure before the browser receives a
      // signature. Probe the same backend action once, read-only from the
      // financial perspective, so the server can persist SIGNATURE_FAILED
      // and its typed-data diagnostic. If the server still says pending, keep
      // recovery and fail closed rather than re-executing the old challenge.
      if (error instanceof Error && error.message === "circle_transaction_failed") {
        try {
          const failed = await withFreshExtremaCircleSession(
            auth.userToken,
            () => backendApi.wallet.verifyGatewayFunding(recovery!.actionId, {
              circleUserToken: auth.userToken,
            }),
          );
          if (isGatewayFundingTerminalWithoutSubmission(failed)) {
            releaseCircleGatewayFundingRecovery(failed);
          }
          throw new Error("gateway_signature_challenge_uncertain");
        } catch (probeError) {
          if (probeError instanceof Error && (
            probeError.message === GATEWAY_FUNDING_TERMINAL_NO_SUBMISSION ||
            probeError.message === "gateway_signature_challenge_uncertain"
          )) throw probeError;
        }
      }
      throw error;
    }
    const signature = result?.data?.signature;
    if (typeof signature !== "string") throw new Error("gateway_signature_required");
    current = await withFreshExtremaCircleSession(
      auth.userToken,
      () => backendApi.wallet.verifyGatewayFunding(recovery!.actionId, {
        circleUserToken: auth.userToken,
        signature,
      }),
    );
    if (isGatewayFundingTerminalWithoutSubmission(current)) {
      releaseCircleGatewayFundingRecovery(current);
    }
    if (current.terminal) throw new Error("gateway_signature_challenge_uncertain");
  }

  throw new Error("gateway_signature_challenge_unavailable");
}

// Compatibility name for existing integrations. New Wallet code uses the
// explicit prepare/confirm pair so this name cannot accidentally collapse the
// review boundary again.
export async function confirmCircleGatewayFunding(
  input: {
    requestId: string;
    destinationDomain: number;
    valueRaw: string;
  },
) {
  return prepareCircleGatewayFundingReview(input);
}

// ---------------------------------------------------------------------------
// Generic Circle financial actions
// ---------------------------------------------------------------------------

const CIRCLE_ACTION_RECOVERY_TTL_MS = 30 * 60 * 1000;

// Errors after which the bound action can never complete, so its recovery
// record is cleared. Anything else keeps the record so a later attempt
// resumes (and reconciles) the same action.
const CIRCLE_ACTION_TERMINAL_ERRORS = new Set([
  "circle_transaction_failed",
  "circle_action_expired_after_approval",
  "circle_action_recovery_invalid",
  "circle_action_verification_failed",
]);

// Transient failures of the start request itself. The request ID is kept so
// the retry is idempotent on the server and returns the same challenge.
const CIRCLE_START_RETRYABLE_ERRORS = new Set([
  "circle_service_unavailable",
  "circle_rate_limited",
  "circle_transaction_pending",
]);

function isCircleActionPending(
  value: unknown,
): value is CircleActionPendingResponse {
  return typeof value === "object" && value !== null && "pending" in value &&
    (value as { pending?: unknown }).pending === true;
}

function hasApprovalPhase(actionType: CircleActionType): actionType is CircleApprovalActionType {
  return actionType === "MARKETPLACE_LIST" || actionType === "MARKETPLACE_BUY";
}

async function verifyCircleActionApprovalOnce(
  actionType: CircleActionType,
  actionId: string,
  userToken: string,
) {
  if (!hasApprovalPhase(actionType)) throw new Error("circle_action_recovery_invalid");
  return withFreshExtremaCircleSession(
    userToken,
    () => backendApi.actions.verifyCircleActionApproval(actionType, actionId, userToken),
  );
}

async function verifyCircleActionOnce<T extends CircleActionType>(
  actionType: T,
  actionId: string,
  userToken: string,
) {
  return withFreshExtremaCircleSession(
    userToken,
    () => backendApi.actions.verifyCircleAction(actionType, actionId, userToken),
  );
}

function storeCircleActionPhase(
  record: CircleActionRecovery,
  update: Partial<CircleActionRecovery>,
): CircleActionRecovery {
  const next = { ...record, ...update };
  storeCircleActionRecovery(next);
  return next;
}

function completeCircleAction<T extends CircleActionType>(
  record: CircleActionRecovery,
  verified: CircleActionVerifyResponse<CircleActionResultMap[T]>,
): CircleActionResultMap[T] {
  if (
    verified.confirmed !== true ||
    verified.executionMode !== "CIRCLE_USER_WALLET" ||
    verified.actionId !== record.actionId ||
    verified.payloadHash !== record.payloadHash
  ) {
    throw new Error("circle_action_verification_failed");
  }
  clearCircleActionRecovery();
  return verified.result;
}

async function continueAfterCircleApproval<T extends CircleActionType>(
  record: CircleActionRecovery,
  approval: CircleActionApprovalVerifyResponse,
  userToken: string,
): Promise<CircleActionResultMap[T]> {
  if (
    approval.confirmed !== true ||
    approval.actionId !== record.actionId ||
    approval.payloadHash !== record.payloadHash ||
    approval.step !== "ACTION_READY" ||
    !approval.challengeId
  ) {
    throw new Error("circle_action_verification_failed");
  }
  const next = storeCircleActionPhase(record, {
    phase: "ACTION_CHALLENGE",
    challengeId: approval.challengeId,
    approvalTxHash: approval.approvalTxHash,
  });
  return resumeCircleAction<T>(next, userToken);
}

async function resumeCircleAction<T extends CircleActionType>(
  record: CircleActionRecovery,
  userToken: string,
): Promise<CircleActionResultMap[T]> {
  const actionType = record.actionType as T;
  const actionId = record.actionId;
  if (!actionId || !record.payloadHash) throw new Error("circle_action_recovery_invalid");

  if (record.phase === "APPROVAL_CHALLENGE") {
    if (!record.challengeId) throw new Error("circle_action_recovery_invalid");
    // Probe before executing: a challenge that was already approved in a
    // previous tab or before a reload is reconciled, never shown again.
    const probe = await verifyCircleActionApprovalOnce(actionType, actionId, userToken);
    if (isCircleActionPending(probe)) {
      if (!probe.transactionObserved) await executeHostedChallenge(record.challengeId);
      const next = storeCircleActionPhase(record, { phase: "APPROVAL_PENDING", challengeId: null });
      return resumeCircleAction<T>(next, userToken);
    }
    return continueAfterCircleApproval<T>(record, probe, userToken);
  }

  if (record.phase === "APPROVAL_PENDING") {
    const approval = await waitForCircleResult(
      () => verifyCircleActionApprovalOnce(actionType, actionId, userToken),
    ) as CircleActionApprovalVerifyResponse;
    return continueAfterCircleApproval<T>(record, approval, userToken);
  }

  if (record.phase === "ACTION_CHALLENGE") {
    if (!record.challengeId) throw new Error("circle_action_recovery_invalid");
    const probe = await verifyCircleActionOnce(actionType, actionId, userToken);
    if (isCircleActionPending(probe)) {
      if (!probe.transactionObserved) await executeHostedChallenge(record.challengeId);
      const next = storeCircleActionPhase(record, { phase: "ACTION_PENDING", challengeId: null });
      return resumeCircleAction<T>(next, userToken);
    }
    return completeCircleAction<T>(record, probe);
  }

  if (record.phase === "ACTION_PENDING") {
    const verified = await waitForCircleResult(
      () => verifyCircleActionOnce(actionType, actionId, userToken),
    ) as CircleActionVerifyResponse<CircleActionResultMap[T]>;
    return completeCircleAction<T>(record, verified);
  }

  throw new Error("circle_action_recovery_invalid");
}

// A recovery record for a different intent may only be dropped once it can
// no longer lead to a transaction: its start never returned (so no challenge
// was ever shown), its action verified, or it expired with no transaction.
async function settleForeignCircleAction(
  record: CircleActionRecovery,
  userToken: string,
): Promise<boolean> {
  if (record.phase === "START_PENDING") return true;
  if (!record.actionId) return true;
  try {
    const probe = record.phase === "APPROVAL_CHALLENGE" || record.phase === "APPROVAL_PENDING"
      ? await verifyCircleActionApprovalOnce(record.actionType, record.actionId, userToken)
      : await verifyCircleActionOnce(record.actionType, record.actionId, userToken);
    if (!isCircleActionPending(probe)) {
      return !(record.phase === "APPROVAL_CHALLENGE" || record.phase === "APPROVAL_PENDING");
    }
    return !probe.transactionObserved && record.expiresAtMs <= Date.now();
  } catch (error) {
    return error instanceof Error && error.message === "circle_transaction_failed";
  }
}

function clearCircleActionRecoveryForTerminalError(error: unknown) {
  if (error instanceof Error && CIRCLE_ACTION_TERMINAL_ERRORS.has(error.message)) {
    clearCircleActionRecovery();
  }
}

export type CircleActionIntent<T extends CircleActionType> = {
  actionType: T;
  // Stable identity of the financial intent, e.g. the ticket, destination and
  // ask. The same intent always resumes; a different one never overwrites it.
  intentKey: string;
  start: (credentials: {
    circleUserToken: string;
    circleRequestId: string;
  }) => Promise<CircleActionStartResponse<CircleActionPayloadMap[T]>>;
  // Client side binding check of the server's canonical payload against what
  // the user asked for, before any Circle challenge is shown.
  matchesIntent: (payload: CircleActionPayloadMap[T]) => boolean;
};

export async function confirmCircleAction<T extends CircleActionType>(
  intent: CircleActionIntent<T>,
): Promise<CircleActionResultMap[T]> {
  const auth = await ensureCircleFinancialAuth();

  let pending = readCircleActionRecovery();

  if (pending && (pending.intentKey !== intent.intentKey || pending.actionType !== intent.actionType)) {
    if (await settleForeignCircleAction(pending, auth.userToken)) {
      clearCircleActionRecovery();
      pending = null;
    } else {
      throw new Error("circle_pending_action_for_different_intent");
    }
  }

  if (pending && pending.expiresAtMs <= Date.now()) {
    if (pending.phase === "START_PENDING" || !pending.actionId) {
      clearCircleActionRecovery();
      pending = null;
    } else {
      const probe = pending.phase === "APPROVAL_CHALLENGE" || pending.phase === "APPROVAL_PENDING"
        ? await verifyCircleActionApprovalOnce(pending.actionType, pending.actionId, auth.userToken)
        : await verifyCircleActionOnce(pending.actionType, pending.actionId, auth.userToken);
      if (isCircleActionPending(probe) && !probe.transactionObserved) {
        clearCircleActionRecovery();
        throw new Error("circle_action_recovery_expired");
      }
      // Circle already sees a transaction: reconcile it to its terminal
      // state rather than discarding it because the local TTL elapsed.
    }
  }

  if (pending && pending.phase !== "START_PENDING") {
    try {
      return await resumeCircleAction<T>(pending, auth.userToken);
    } catch (error) {
      clearCircleActionRecoveryForTerminalError(error);
      throw error;
    }
  }

  // The request ID is persisted BEFORE the start request, so a lost response
  // or a reload retries with the same ID and the server returns the same
  // action and challenge instead of a second one.
  const requestId = pending?.requestId ?? crypto.randomUUID();
  storeCircleActionRecovery({
    actionType: intent.actionType,
    intentKey: intent.intentKey,
    requestId,
    actionId: null,
    payloadHash: null,
    phase: "START_PENDING",
    challengeId: null,
    approvalTxHash: null,
    expiresAtMs: Date.now() + CIRCLE_ACTION_RECOVERY_TTL_MS,
  });

  let started: CircleActionStartResponse<CircleActionPayloadMap[T]>;
  try {
    started = await withFreshExtremaCircleSession(
      auth.userToken,
      () => intent.start({ circleUserToken: auth.userToken, circleRequestId: requestId }),
    );
  } catch (error) {
    // A definitive refusal happened before any challenge existed, so nothing
    // can have been signed. Transport failures keep the request ID for an
    // idempotent retry.
    const message = error instanceof Error ? error.message : "";
    if (/^[a-z_]+$/.test(message) && !CIRCLE_START_RETRYABLE_ERRORS.has(message)) {
      clearCircleActionRecovery();
    }
    throw error;
  }

  if (
    started.executionMode !== "CIRCLE_USER_WALLET" ||
    !started.actionId || !started.payloadHash || !started.challengeId ||
    (started.step !== "APPROVAL_REQUIRED" && started.step !== "ACTION_READY") ||
    (started.step === "APPROVAL_REQUIRED" && !hasApprovalPhase(intent.actionType)) ||
    !started.action ||
    started.action.action !== intent.actionType ||
    started.action.executionMode !== "CIRCLE_USER_WALLET" ||
    started.action.chainId !== 5042002 ||
    !intent.matchesIntent(started.action)
  ) {
    clearCircleActionRecovery();
    throw new Error("circle_action_verification_failed");
  }

  const record: CircleActionRecovery = {
    actionType: intent.actionType,
    intentKey: intent.intentKey,
    requestId,
    actionId: started.actionId,
    payloadHash: started.payloadHash,
    phase: started.step === "APPROVAL_REQUIRED" ? "APPROVAL_CHALLENGE" : "ACTION_CHALLENGE",
    challengeId: started.challengeId,
    approvalTxHash: null,
    expiresAtMs: Date.now() + started.expiresInSeconds * 1000,
  };
  storeCircleActionRecovery(record);

  try {
    return await resumeCircleAction<T>(record, auth.userToken);
  } catch (error) {
    clearCircleActionRecoveryForTerminalError(error);
    throw error;
  }
}
