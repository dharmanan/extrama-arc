"use client";

import { backendApi, type CircleEntryApprovalVerifyResponse, type CircleEntryVerifyResponse } from "./backend-api";
import {
  clearCircleEntryRecovery,
  matchesCircleEntryRecovery,
  readCircleEntryRecovery,
  readCircleTabAuth,
  storeCircleEntryRecovery,
  type CircleEntryRecovery,
} from "./circle-auth";

type CircleSdk = {
  getDeviceId(): Promise<string>;
  setAuthentication(auth: { userToken: string; encryptionKey: string }): void;
  execute(challengeId: string, onCompleted?: (error: { message: string } | undefined) => void): void;
};

async function executeHostedChallenge(challengeId: string) {
  const auth = readCircleTabAuth();
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
  if (!auth || !appId) throw new Error("circle_reauthentication_required");
  const module = await import("@circle-fin/w3s-pw-web-sdk");
  const sdk = new module.W3SSdk({ appSettings: { appId } }) as unknown as CircleSdk;
  // The hosted SDK establishes its device context before a challenge executes.
  // The value is intentionally transient and never added to recovery storage.
  await sdk.getDeviceId();
  sdk.setAuthentication(auth);
  await new Promise<void>((resolve, reject) => {
    sdk.execute(challengeId, (error) => error ? reject(new Error(error.message)) : resolve());
  });
  return auth.userToken;
}

function recoveryFor(
  input: { poolAddress: string; roundId: number; predictionPriceCents: number },
  requestId: string,
  started: { actionId: string; payloadHash: string },
  phase: CircleEntryRecovery["phase"],
  challengeId: string | null,
): CircleEntryRecovery {
  return {
    ...input, requestId, actionId: started.actionId, payloadHash: started.payloadHash,
    phase, challengeId, approvalTxHash: null,
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
    const probe = await backendApi.actions.verifyCircleEntryApproval(recovery.actionId, userToken);
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
      () => backendApi.actions.verifyCircleEntryApproval(recovery.actionId, userToken),
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
    const probe = await backendApi.actions.verifyCircleEntry(recovery.actionId, userToken);
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
    () => backendApi.actions.verifyCircleEntry(recovery.actionId, userToken),
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await read();
    if (!(typeof result === "object" && result !== null && "pending" in result && result.pending === true)) {
      return result;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error("circle_transaction_pending");
}

export async function confirmCircleEntry(input: {
  poolAddress: string;
  roundId: number;
  predictionPriceCents: number;
  requestId: string;
}) {
  let pending = readCircleEntryRecovery();

  if (pending && !matchesCircleEntryRecovery(pending, input)) {
    try {
      const [walletState, rounds] = await Promise.all([
        backendApi.wallet.get(),
        backendApi.rounds.list(),
      ]);

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

  const auth = readCircleTabAuth();
  if (!auth) throw new Error("circle_reauthentication_required");
  if (pending) {
    try {
      return await resumeCircleEntry(pending, auth.userToken);
    } catch (error) {
      clearRecoveryForTerminalError(error);
      throw error;
    }
  }
  const started = await backendApi.actions.startCircleEntry({
    poolAddress: input.poolAddress,
    roundId: input.roundId,
    predictionPriceCents: input.predictionPriceCents,
    circleUserToken: auth.userToken,
    circleRequestId: input.requestId,
  });
  const recovery = recoveryFor(
    input,
    input.requestId,
    started,
    started.step === "APPROVAL_REQUIRED" ? "APPROVAL_CHALLENGE" : "ENTRY_CHALLENGE",
    started.challengeId,
  );
  storeCircleEntryRecovery(recovery);
  try {
    return await resumeCircleEntry(recovery, auth.userToken);
  } catch (error) {
    clearRecoveryForTerminalError(error);
    throw error;
  }
}
