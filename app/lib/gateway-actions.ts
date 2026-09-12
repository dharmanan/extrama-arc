"use client";

// Gateway financial actions for the two human execution modes.
//
//   confirmGatewayBurnSignature   spends an ALREADY existing unified balance
//                                 to a chosen destination network: sign the
//                                 server pinned EIP-712 burn intents, never
//                                 broadcast them.
//   confirmGatewaySourceDeposit   gets USDC INTO that unified balance in the
//                                 first place: USDC.approve(GatewayWallet,
//                                 amount) then GatewayWallet.deposit(token,
//                                 amount) on one funding chain.
//
// Both mirror the rest of this project's financial actions: the server
// pins the exact payload, the wallet (connected EOA or Circle hosted
// challenge) signs exactly that, and the result is checked against what was
// asked for before it is trusted.
//
// Neither entry point takes a Gateway source domain for a transfer. The
// caller chooses a destination and an amount; the server decides which
// deposited balances pay for it.

import {
  backendApi,
  type GatewayDepositResponse,
  type GatewayFundingResponse,
  type HumanExecutionMode,
  type TransactionRequest,
} from "./backend-api";
import { confirmCircleGatewayFunding, ensureCircleFinancialAuth, executeHostedChallenge } from "./circle-actions";
import {
  clearCircleGatewayDepositRecovery,
  clearExternalGatewayDepositRecovery,
  clearExternalGatewayFundingRecovery,
  readCircleGatewayDepositRecovery,
  readExternalGatewayDepositRecovery,
  readExternalGatewayFundingRecovery,
  storeCircleGatewayDepositRecovery,
  storeExternalGatewayDepositRecovery,
  storeExternalGatewayFundingRecovery,
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
// Burn intent signatures (spend an existing unified balance to a destination)
// ---------------------------------------------------------------------------

export async function confirmGatewayBurnSignature(
  input: { destinationDomain: number; valueRaw: string },
  context: GatewayContext,
  onProgress?: (signed: number, total: number) => void,
): Promise<GatewayFundingResponse> {
  const mode = requireMode(context);

  if (mode === "CIRCLE_USER_WALLET") {
    return confirmCircleGatewayFunding(
      { requestId: crypto.randomUUID(), ...input }, onProgress,
    );
  }

  if (!context.signTypedData) {
    throw new Error("Connected wallet signing support is unavailable.");
  }

  let recovery = readExternalGatewayFundingRecovery();
  if (recovery && (
    recovery.destinationDomain !== input.destinationDomain || recovery.valueRaw !== input.valueRaw
  )) {
    throw new Error("gateway_pending_action_for_different_intent");
  }

  // A reload resumes the SAME action under the same request id. start is
  // idempotent by request id, so this never creates a second plan.
  const requestId = recovery?.requestId || crypto.randomUUID();
  const started = await backendApi.wallet.startGatewayFunding({
    requestId,
    destinationDomain: input.destinationDomain,
    valueRaw: input.valueRaw,
  });
  if (started.readyToBroadcast) {
    clearExternalGatewayFundingRecovery();
    return started;
  }
  if (started.executionMode !== "EXTERNAL_WALLET" || !started.typedDataList.length) {
    throw new Error("gateway_signature_challenge_unavailable");
  }
  recovery = {
    requestId,
    actionId: started.actionId,
    destinationDomain: input.destinationDomain,
    valueRaw: input.valueRaw,
    expiresAtMs: Date.parse(started.expiresAt),
  };
  storeExternalGatewayFundingRecovery(recovery);

  // A connected wallet signs locally, so the whole plan can be signed in one
  // pass: one prompt per source allocation, then one verify call. Signing
  // starts at the allocation the server says is still outstanding, so a
  // partly signed plan is continued rather than re-signed from the start.
  const signatures: string[] = [];
  const firstUnsignedIndex = Math.max(0, started.signatureIndex);
  for (let index = firstUnsignedIndex; index < started.typedDataList.length; index += 1) {
    onProgress?.(index, started.typedDataList.length);
    signatures.push(await context.signTypedData(started.typedDataList[index]));
  }

  const verified = await backendApi.wallet.verifyGatewayFunding(started.actionId, { signatures });
  if (!verified.readyToBroadcast) throw new Error("gateway_signature_challenge_unavailable");
  clearExternalGatewayFundingRecovery();
  return verified;
}

// ---------------------------------------------------------------------------
// Source chain deposit (approve then deposit into GatewayWallet)
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
  // The application session can be alive for up to seven days while this
  // tab's Circle credentials are gone (reopened browser, new tab, cleared
  // sessionStorage). Restoring them here, before any financial call, is what
  // let the same click that used to fail with circle_reauthentication_required
  // before ever reaching the backend now continue the SAME requested deposit.
  const auth = await ensureCircleFinancialAuth();

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

// One deposit entry point for every funding chain. The sourceDomain here is a
// real user choice ("add USDC from this wallet"), unlike a transfer, where the
// source allocation is the server's decision.
export async function confirmGatewaySourceDeposit(
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
