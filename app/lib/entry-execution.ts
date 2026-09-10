"use client";

import type { HumanExecutionMode, TransactionRequest } from "./backend-api";
import { confirmCircleEntry } from "./circle-actions";
import { confirmExternalEntry } from "./wallet-actions";

export type EntryExecutionMode = HumanExecutionMode;

export async function confirmEntry(input: {
  executionMode: EntryExecutionMode | null;
  poolAddress: string;
  roundId: number;
  predictionPriceCents: number;
  circleRequestId?: string;
  sendExternalTransaction?: (
    request: TransactionRequest,
  ) => Promise<string>;
}) {
  if (input.executionMode === "CIRCLE_USER_WALLET") {
    if (!input.circleRequestId) {
      throw new Error("circle_entry_request_id_required");
    }

    return confirmCircleEntry({
      poolAddress: input.poolAddress,
      roundId: input.roundId,
      predictionPriceCents: input.predictionPriceCents,
      requestId: input.circleRequestId,
    });
  }

  if (input.executionMode === "EXTERNAL_WALLET") {
    return confirmExternalEntry({
      poolAddress: input.poolAddress,
      roundId: input.roundId,
      predictionPriceCents: input.predictionPriceCents,
      sendExternalTransaction: input.sendExternalTransaction,
    });
  }

  throw new Error("wallet_session_required");
}
