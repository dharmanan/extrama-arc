"use client";

// Gateway financial actions for the two human execution modes.
//
//   confirmGatewayBurnSignature  spends an ALREADY existing unified balance
//                                to Arc: sign the server pinned EIP-712 burn
//                                intent, never broadcast it.
//   confirmGatewayBaseDeposit    gets USDC INTO that unified balance in the
//                                first place: USDC.approve(GatewayWallet,
//                                amount) then GatewayWallet.deposit(token,
//                                amount) on Base Sepolia.
//
// Both mirror the rest of this project's financial actions: the server
// pins the exact payload, the wallet (connected EOA or Circle hosted
// challenge) signs exactly that, and the result is checked against what was
// asked for before it is trusted.

import {
  backendApi,
  type GatewayDepositResponse,
  type GatewayFundingResponse,
  type HumanExecutionMode,
  type TransactionRequest,
} from "./backend-api";
import { confirmCircleGatewayFunding, executeHostedChallenge } from "./circle-actions";
import {
  clearCircleGatewayDepositRecovery,
  clearExternalGatewayDepositRecovery,
  readCircleGatewayDepositRecovery,
  readCircleTabAuth,
  readExternalGatewayDepositRecovery,
  storeCircleGatewayDepositRecovery,
  storeExternalGatewayDepositRecovery,
  type CircleGatewayDepositPhase,
  type ExternalGatewayDepositPhase,
} from "./circle-auth";

export type SendExternalTransaction = (request: TransactionRequest) => Promise<string>;
export type GatewayTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};
export type SignTypedData = (typedData: GatewayTypedData) => Promise<string>;

type GatewayContext = {
  executionMode: HumanExecutionMode | null;
  sendExternalTransaction?: SendExternalTransaction;
  signTypedData?: SignTypedData;
};

function requireMode(context: GatewayContext): HumanExecutionMode {
  if (context.executionMode === "EXTERNAL_WALLET" || context.executionMode === "CIRCLE_USER_WALLET") {
    return context.executionMode;
  }
  throw new Error("wallet_session_required");
}

async function pollDeposit(
  read: () => Promise<GatewayDepositResponse>,
  maxAttempts = 45,
  intervalMs = 4000,
): Promise<GatewayDepositResponse> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const result = await read();
    // RECONCILING is not an unobserved financial action. The deposit has
    // already been submitted, so hand it back to the wallet's persistent,
    // read-only finality rail instead of applying the pre-submit retry budget.
    if (!result.pending || result.state === "RECONCILING") return result;
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }
  throw new Error("gateway_deposit_pending_timeout");
}

// ---------------------------------------------------------------------------
// Burn intent signature (spends an existing unified balance to Arc)
// ---------------------------------------------------------------------------

export async function confirmGatewayBurnSignature(
  input: { sourceDomain: number; valueRaw: string },
  context: GatewayContext,
): Promise<GatewayFundingResponse> {
  const mode = requireMode(context);

  if (mode === "CIRCLE_USER_WALLET") {
    return confirmCircleGatewayFunding({ requestId: crypto.randomUUID(), ...input });
  }

  if (!context.signTypedData) {
    throw new Error("Connected wallet signing support is unavailable.");
  }
  const started = await backendApi.wallet.startGatewayFunding({
    requestId: crypto.randomUUID(),
    sourceDomain: input.sourceDomain,
    valueRaw: input.valueRaw,
  });
  if (started.readyToBroadcast) return started;
  if (started.executionMode !== "EXTERNAL_WALLET" || !started.typedData) {
    throw new Error("gateway_signature_challenge_unavailable");
  }
  const signature = await context.signTypedData(started.typedData);
  const verified = await backendApi.wallet.verifyGatewayFunding(started.actionId, { signature });
  if (!verified.readyToBroadcast) throw new Error("gateway_signature_challenge_unavailable");
  return verified;
}

// ---------------------------------------------------------------------------
// Base Sepolia source deposit (approve then deposit into GatewayWallet)
// ---------------------------------------------------------------------------

function isDepositTerminal(state: GatewayDepositResponse["state"]) {
  return state === "COMPLETED" || state === "FAILED" || state === "RECONCILIATION_REQUIRED" || state === "EXPIRED";
}

async function runExternalDeposit(
  input: { sourceDomain: number; amountRaw: string },
  context: GatewayContext,
  onStatus?: (phase: ExternalGatewayDepositPhase) => void,
): Promise<GatewayDepositResponse> {
  const send = context.sendExternalTransaction;
  if (!send) throw new Error("Connected wallet transaction support is unavailable.");

  let recovery = readExternalGatewayDepositRecovery();
  if (recovery && (recovery.sourceDomain !== input.sourceDomain || recovery.amountRaw !== input.amountRaw)) {
    throw new Error("gateway_pending_action_for_different_intent");
  }

  // A bare status read never carries a transactionRequest (there is nothing
  // new to sign yet); resuming a not-yet-reconciling recovery must re-call
  // start, which is idempotent by requestId and re-derives the exact next
  // transaction from live chain state instead of a possibly stale local one.
  let current: GatewayDepositResponse;
  if (recovery && recovery.phase === "RECONCILING") {
    current = await backendApi.wallet.gatewayDeposit(recovery.actionId);
  } else if (recovery) {
    current = await backendApi.wallet.startGatewayDeposit({
      requestId: recovery.requestId, sourceDomain: input.sourceDomain, amountRaw: input.amountRaw,
    });
  } else {
    const requestId = crypto.randomUUID();
    current = await backendApi.wallet.startGatewayDeposit({
      requestId, sourceDomain: input.sourceDomain, amountRaw: input.amountRaw,
    });
    recovery = {
      requestId, actionId: current.actionId, sourceDomain: input.sourceDomain, amountRaw: input.amountRaw,
      phase: current.state === "DEPOSIT_REQUIRED" ? "DEPOSIT_REQUIRED" : "APPROVAL_REQUIRED",
      approvalTxHash: null, depositTxHash: null,
      expiresAtMs: Date.parse(current.expiresAt),
    };
    storeExternalGatewayDepositRecovery(recovery);
  }

  while (!isDepositTerminal(current.state)) {
    if (current.state === "RECONCILING") {
      onStatus?.("RECONCILING");
      return current;
    }
    if (current.state === "APPROVAL_REQUIRED") {
      onStatus?.("APPROVAL_REQUIRED");
      let approvalTxHash: string | null = recovery.approvalTxHash;
      if (!approvalTxHash) {
        if (!current.transactionRequest) throw new Error("gateway_deposit_transaction_missing");
        approvalTxHash = await send(current.transactionRequest);
        recovery = { ...recovery, approvalTxHash };
        storeExternalGatewayDepositRecovery(recovery);
      }
      current = await backendApi.wallet.verifyGatewayDepositApproval(recovery.actionId, { txHash: approvalTxHash });
      recovery = { ...recovery, phase: "DEPOSIT_REQUIRED", approvalTxHash: null };
      storeExternalGatewayDepositRecovery(recovery);
      continue;
    }
    if (current.state === "DEPOSIT_REQUIRED") {
      onStatus?.("DEPOSIT_REQUIRED");
      let depositTxHash: string | null = recovery.depositTxHash;
      if (!depositTxHash) {
        if (!current.transactionRequest) throw new Error("gateway_deposit_transaction_missing");
        depositTxHash = await send(current.transactionRequest);
        recovery = { ...recovery, depositTxHash };
        storeExternalGatewayDepositRecovery(recovery);
      }
      current = await backendApi.wallet.verifyGatewayDeposit(recovery.actionId, { txHash: depositTxHash });
      recovery = { ...recovery, phase: "RECONCILING" };
      storeExternalGatewayDepositRecovery(recovery);
      continue;
    }
    onStatus?.("RECONCILING");
    current = await pollDeposit(() => backendApi.wallet.gatewayDeposit(recovery!.actionId));
  }

  if (current.state === "COMPLETED") clearExternalGatewayDepositRecovery();
  return current;
}

async function runCircleDeposit(
  input: { sourceDomain: number; amountRaw: string },
  onStatus?: (phase: CircleGatewayDepositPhase) => void,
): Promise<GatewayDepositResponse> {
  const auth = readCircleTabAuth();
  if (!auth) throw new Error("circle_reauthentication_required");

  let recovery = readCircleGatewayDepositRecovery();
  if (recovery && (recovery.sourceDomain !== input.sourceDomain || recovery.amountRaw !== input.amountRaw)) {
    throw new Error("gateway_pending_action_for_different_intent");
  }

  // Resuming re-probes the SAME phase's real Circle status instead of a bare
  // read, so an already-observed transaction is recognized (transactionObserved)
  // and the hosted widget is never re-executed for a challenge already approved.
  let current: GatewayDepositResponse;
  if (recovery && (recovery.phase === "APPROVAL_CHALLENGE" || recovery.phase === "APPROVAL_PENDING")) {
    current = await backendApi.wallet.verifyGatewayDepositApproval(recovery.actionId, { circleUserToken: auth.userToken });
  } else if (recovery && (recovery.phase === "DEPOSIT_CHALLENGE" || recovery.phase === "DEPOSIT_PENDING")) {
    current = await backendApi.wallet.verifyGatewayDeposit(recovery.actionId, { circleUserToken: auth.userToken });
  } else if (recovery) {
    current = await backendApi.wallet.gatewayDeposit(recovery.actionId);
  } else {
    const requestId = crypto.randomUUID();
    current = await backendApi.wallet.startGatewayDeposit({
      requestId, sourceDomain: input.sourceDomain, amountRaw: input.amountRaw,
      circleUserToken: auth.userToken,
    });
    recovery = {
      requestId, actionId: current.actionId, sourceDomain: input.sourceDomain, amountRaw: input.amountRaw,
      phase: current.state === "DEPOSIT_CHALLENGE" ? "DEPOSIT_CHALLENGE" : "APPROVAL_CHALLENGE",
      challengeId: current.approvalChallengeId || current.depositChallengeId,
      expiresAtMs: Date.parse(current.expiresAt),
    };
    storeCircleGatewayDepositRecovery(recovery);
  }

  while (!isDepositTerminal(current.state)) {
    if (current.state === "RECONCILING") {
      onStatus?.("RECONCILING");
      return current;
    }
    if (current.state === "APPROVAL_CHALLENGE") {
      onStatus?.("APPROVAL_CHALLENGE");
      if (!current.transactionObserved && current.approvalChallengeId) {
        await executeHostedChallenge(current.approvalChallengeId);
      }
      recovery = { ...recovery, phase: "APPROVAL_PENDING", challengeId: current.approvalChallengeId };
      storeCircleGatewayDepositRecovery(recovery);
      onStatus?.("APPROVAL_PENDING");
      current = await pollDeposit(
        () => backendApi.wallet.verifyGatewayDepositApproval(recovery!.actionId, { circleUserToken: auth.userToken }),
      );
      continue;
    }
    if (current.state === "DEPOSIT_CHALLENGE") {
      onStatus?.("DEPOSIT_CHALLENGE");
      if (!current.transactionObserved && current.depositChallengeId) {
        await executeHostedChallenge(current.depositChallengeId);
      }
      recovery = { ...recovery, phase: "DEPOSIT_PENDING", challengeId: current.depositChallengeId };
      storeCircleGatewayDepositRecovery(recovery);
      onStatus?.("DEPOSIT_PENDING");
      current = await pollDeposit(
        () => backendApi.wallet.verifyGatewayDeposit(recovery!.actionId, { circleUserToken: auth.userToken }),
      );
      continue;
    }
    current = await pollDeposit(() => backendApi.wallet.gatewayDeposit(recovery!.actionId));
  }

  if (current.state === "COMPLETED") clearCircleGatewayDepositRecovery();
  return current;
}

export async function confirmGatewayBaseDeposit(
  input: { sourceDomain: number; amountRaw: string },
  context: GatewayContext,
  onStatus?: (phase: ExternalGatewayDepositPhase | CircleGatewayDepositPhase) => void,
): Promise<GatewayDepositResponse> {
  const mode = requireMode(context);
  if (mode === "CIRCLE_USER_WALLET") {
    return runCircleDeposit(input, onStatus);
  }
  return runExternalDeposit(input, context, onStatus);
}
