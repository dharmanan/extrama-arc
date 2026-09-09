"use client";

import { confirmCircleEntry } from "./circle-entry";
import { confirmEntryWithPasskey } from "./passkey-client";

export type EntryExecutionMode =
  | "BACKEND_WALLET"
  | "EXTERNAL_WALLET"
  | "CIRCLE_USER_WALLET";

type ExternalTransactionRequest = {
  chainId: 5042002;
  to: string;
  data: string;
  value: string;
  from: string;
};

export async function confirmEntry(input: {
  executionMode: EntryExecutionMode | null;
  poolAddress: string;
  roundId: number;
  predictionPriceCents: number;
  circleRequestId?: string;
  sendExternalTransaction?: (
    request: ExternalTransactionRequest,
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

  return confirmEntryWithPasskey({
    poolAddress: input.poolAddress,
    roundId: input.roundId,
    predictionPriceCents: input.predictionPriceCents,
    sendExternalTransaction: input.sendExternalTransaction,
  });
}
