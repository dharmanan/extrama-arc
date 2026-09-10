"use client";

// Financial lifecycle actions for the two human execution modes.
//
//   EXTERNAL_WALLET     EXTREMA returns the exact transaction request; the
//                       user's connected wallet (MetaMask, Rabby, ...) signs
//                       it; the backend verifies the mined receipt.
//   CIRCLE_USER_WALLET  EXTREMA issues a Circle hosted challenge; the user
//                       approves it in Circle; the backend reconciles and
//                       verifies the Circle transaction.
//
// Each executor checks the server's canonical payload against what the user
// asked for before anything is signed, and checks the verified result
// afterwards. EXTREMA never signs for the user in either mode.

import {
  backendApi,
  type ClaimExecutionResult,
  type HumanExecutionMode,
  type MarketplaceBuyExecutionResult,
  type MarketplaceCancelExecutionResult,
  type MarketplaceListExecutionResult,
  type MarketplaceUpdatePriceExecutionResult,
  type RefundExecutionResult,
  type TicketTransferExecutionResult,
  type TransactionRequest,
} from "./backend-api";
import { confirmCircleAction } from "./circle-actions";

export type SendExternalTransaction = (request: TransactionRequest) => Promise<string>;

export type WalletActionStatus =
  | "PREPARING"
  | "WAITING_FOR_WALLET"
  | "WAITING_FOR_CIRCLE"
  | "VERIFYING";

type ExecutionContext = {
  executionMode: HumanExecutionMode | null;
  sendExternalTransaction?: SendExternalTransaction;
  onStatus?: (status: WalletActionStatus) => void;
};

function addressesEqual(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function isFreshNonce(payload: { nonce: string; expiresAt: string }) {
  return typeof payload.nonce === "string" &&
    payload.nonce.length >= 16 &&
    Date.parse(payload.expiresAt) > Date.now();
}

function requireMode(context: ExecutionContext): HumanExecutionMode {
  if (context.executionMode === "EXTERNAL_WALLET" || context.executionMode === "CIRCLE_USER_WALLET") {
    return context.executionMode;
  }
  throw new Error("wallet_session_required");
}

function requireSender(context: ExecutionContext): SendExternalTransaction {
  if (!context.sendExternalTransaction) {
    throw new Error("Connected wallet transaction support is unavailable.");
  }
  return context.sendExternalTransaction;
}

function assertExternalRequest(
  request: TransactionRequest,
  expected: { from: string; to?: string },
  message: string,
) {
  if (
    request.chainId !== 5042002 ||
    request.value !== "0x0" ||
    !addressesEqual(request.from, expected.from) ||
    (expected.to !== undefined && !addressesEqual(request.to, expected.to))
  ) {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Entry (connected wallet). Circle entry lives in circle-actions.ts.
// ---------------------------------------------------------------------------

export async function confirmExternalEntry(input: {
  poolAddress: string;
  roundId: number;
  predictionPriceCents: number;
  sendExternalTransaction?: SendExternalTransaction;
}) {
  const start = await backendApi.actions.startEntry({
    poolAddress: input.poolAddress,
    roundId: input.roundId,
    predictionPriceCents: input.predictionPriceCents,
  });

  const actionMatches =
    start.executionMode === "EXTERNAL_WALLET" &&
    start.authorization === "EXTERNAL_WALLET_SESSION" &&
    start.action.action === "ENTRY" &&
    start.action.chainId === 5042002 &&
    addressesEqual(start.action.contract, input.poolAddress) &&
    start.action.roundId === input.roundId &&
    start.action.amountRaw === "1000000" &&
    start.action.predictionPriceCents === input.predictionPriceCents &&
    addressesEqual(start.action.destination, input.poolAddress) &&
    isFreshNonce(start.action);

  if (!actionMatches) {
    throw new Error("Entry confirmation details did not match the requested prediction.");
  }
  if (!input.sendExternalTransaction) {
    throw new Error("Connected wallet transaction support is unavailable.");
  }

  let entryRequest = start.transactionRequest;
  let approvalTxHash: string | null = null;
  if (start.step === "APPROVAL_REQUIRED") {
    approvalTxHash = await input.sendExternalTransaction(start.transactionRequest);
    const approval = await backendApi.actions.verifyEntryApproval(start.actionId, approvalTxHash);
    if (
      approval.confirmed !== true ||
      approval.actionId !== start.actionId ||
      approval.payloadHash !== start.payloadHash ||
      approval.step !== "ENTRY_READY"
    ) {
      throw new Error("Approval receipt verification failed.");
    }
    entryRequest = approval.transactionRequest;
  }
  const entryTxHash = await input.sendExternalTransaction(entryRequest);
  const verified = await backendApi.actions.verifyEntry(start.actionId, entryTxHash);
  if (
    verified.confirmed !== true ||
    verified.actionId !== start.actionId ||
    verified.payloadHash !== start.payloadHash ||
    verified.result.entryTxHash.toLowerCase() !== entryTxHash.toLowerCase() ||
    verified.result.ticketOwner.toLowerCase() !== start.action.walletAddress.toLowerCase()
  ) {
    throw new Error("Entry receipt verification failed.");
  }
  return { ...verified.result, approvalTxHash };
}

// ---------------------------------------------------------------------------
// Ticket transfer
// ---------------------------------------------------------------------------

export async function executeTicketTransfer(
  input: { ticketAddress: string; tokenId: string; destinationAddress: string },
  context: ExecutionContext,
): Promise<TicketTransferExecutionResult> {
  const mode = requireMode(context);
  const matches = (payload: {
    action: string; chainId: number; contract: string; tokenId: string;
    from: string; walletAddress: string; destination: string; nonce: string; expiresAt: string;
  }) =>
    payload.action === "TRANSFER_TICKET" &&
    payload.chainId === 5042002 &&
    addressesEqual(payload.contract, input.ticketAddress) &&
    payload.tokenId === input.tokenId &&
    addressesEqual(payload.from, payload.walletAddress) &&
    addressesEqual(payload.destination, input.destinationAddress) &&
    isFreshNonce(payload);

  let result: TicketTransferExecutionResult;
  if (mode === "CIRCLE_USER_WALLET") {
    context.onStatus?.("WAITING_FOR_CIRCLE");
    result = await confirmCircleAction({
      actionType: "TRANSFER_TICKET",
      intentKey: `TRANSFER_TICKET:${input.ticketAddress.toLowerCase()}:${input.tokenId}:${input.destinationAddress.toLowerCase()}`,
      start: (credentials) => backendApi.actions.startCircleTicketTransfer({ ...input, ...credentials }),
      matchesIntent: matches,
    });
  } else {
    const send = requireSender(context);
    context.onStatus?.("PREPARING");
    const start = await backendApi.actions.startTicketTransfer(input);
    if (start.executionMode !== "EXTERNAL_WALLET" || !matches(start.action)) {
      throw new Error("Transfer confirmation details did not match the requested NFT transfer.");
    }
    const finished = await backendApi.actions.finishTicketTransfer(start.actionId);
    if (finished.confirmed !== true || finished.actionId !== start.actionId || finished.payloadHash !== start.payloadHash) {
      throw new Error("Transfer authorization did not match the request.");
    }
    assertExternalRequest(
      finished.transactionRequest,
      { from: start.action.walletAddress, to: input.ticketAddress },
      "Transfer transaction request did not match the requested NFT transfer.",
    );
    context.onStatus?.("WAITING_FOR_WALLET");
    const txHash = await send(finished.transactionRequest);
    context.onStatus?.("VERIFYING");
    result = (await backendApi.actions.verifyTicketTransfer(start.actionId, txHash)).result;
    if (result.transferTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Transfer receipt verification failed.");
    }
  }

  if (
    result.chainId !== 5042002 ||
    !addressesEqual(result.ticketAddress, input.ticketAddress) ||
    result.tokenId !== input.tokenId ||
    !addressesEqual(result.destinationAddress, input.destinationAddress) ||
    !addressesEqual(result.ownerAfter, input.destinationAddress)
  ) {
    throw new Error("Confirmed transaction did not match the requested NFT transfer.");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Refund and claim
// ---------------------------------------------------------------------------

type TicketRoundInput = {
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
};

type TicketRoundPayload = {
  action: string; chainId: number; poolAddress: string; ticketAddress: string;
  tokenId: string; roundId: number; amountRaw: string; destination: string;
  currentOwner: string; nonce: string; expiresAt: string;
};

function matchesTicketRound(input: TicketRoundInput, action: "REFUND_TICKET" | "CLAIM_REWARD") {
  return (payload: TicketRoundPayload) =>
    payload.action === action &&
    payload.chainId === 5042002 &&
    addressesEqual(payload.poolAddress, input.poolAddress) &&
    addressesEqual(payload.ticketAddress, input.ticketAddress) &&
    payload.tokenId === input.tokenId &&
    payload.roundId === input.roundId &&
    (action === "REFUND_TICKET" ? payload.amountRaw === "1000000" : /^[1-9][0-9]*$/.test(payload.amountRaw)) &&
    addressesEqual(payload.destination, payload.currentOwner) &&
    isFreshNonce(payload);
}

export async function executeRefund(
  input: TicketRoundInput,
  context: ExecutionContext,
): Promise<RefundExecutionResult> {
  const mode = requireMode(context);
  const matches = matchesTicketRound(input, "REFUND_TICKET");

  let result: RefundExecutionResult;
  if (mode === "CIRCLE_USER_WALLET") {
    context.onStatus?.("WAITING_FOR_CIRCLE");
    result = await confirmCircleAction({
      actionType: "REFUND_TICKET",
      intentKey: `REFUND_TICKET:${input.ticketAddress.toLowerCase()}:${input.tokenId}:${input.roundId}`,
      start: (credentials) => backendApi.actions.startCircleRefund({ ...input, ...credentials }),
      matchesIntent: matches,
    });
  } else {
    const send = requireSender(context);
    context.onStatus?.("PREPARING");
    const start = await backendApi.actions.startRefund(input);
    if (start.executionMode !== "EXTERNAL_WALLET" || start.action.executionMode !== "EXTERNAL_OWNER" || !matches(start.action)) {
      throw new Error("Refund confirmation details did not match the requested ticket.");
    }
    const finished = await backendApi.actions.finishRefund(start.actionId);
    if (finished.confirmed !== true || finished.actionId !== start.actionId || finished.payloadHash !== start.payloadHash) {
      throw new Error("Refund authorization did not match the request.");
    }
    assertExternalRequest(
      finished.transactionRequest,
      { from: start.action.currentOwner, to: input.poolAddress },
      "Refund transaction request did not match the requested ticket.",
    );
    context.onStatus?.("WAITING_FOR_WALLET");
    const txHash = await send(finished.transactionRequest);
    context.onStatus?.("VERIFYING");
    const verified = await backendApi.actions.verifyRefund(start.actionId, txHash);
    if (verified.confirmed !== true || verified.actionId !== start.actionId || verified.result.refundTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Refund receipt verification failed.");
    }
    result = verified.result;
  }

  if (
    result.chainId !== 5042002 ||
    !addressesEqual(result.poolAddress, input.poolAddress) ||
    !addressesEqual(result.ticketAddress, input.ticketAddress) ||
    result.tokenId !== input.tokenId ||
    result.amountRaw !== "1000000"
  ) {
    throw new Error("Confirmed refund did not match the requested ticket.");
  }
  return result;
}

export async function executeClaim(
  input: TicketRoundInput,
  context: ExecutionContext,
): Promise<ClaimExecutionResult> {
  const mode = requireMode(context);
  const matches = matchesTicketRound(input, "CLAIM_REWARD");

  let result: ClaimExecutionResult;
  if (mode === "CIRCLE_USER_WALLET") {
    context.onStatus?.("WAITING_FOR_CIRCLE");
    result = await confirmCircleAction({
      actionType: "CLAIM_REWARD",
      intentKey: `CLAIM_REWARD:${input.ticketAddress.toLowerCase()}:${input.tokenId}:${input.roundId}`,
      start: (credentials) => backendApi.actions.startCircleClaim({ ...input, ...credentials }),
      matchesIntent: matches,
    });
  } else {
    const send = requireSender(context);
    context.onStatus?.("PREPARING");
    const start = await backendApi.actions.startClaim(input);
    if (start.executionMode !== "EXTERNAL_WALLET" || start.action.executionMode !== "EXTERNAL_OWNER" || !matches(start.action)) {
      throw new Error("Reward confirmation details did not match the requested ticket.");
    }
    const finished = await backendApi.actions.finishClaim(start.actionId);
    if (finished.confirmed !== true || finished.actionId !== start.actionId || finished.payloadHash !== start.payloadHash) {
      throw new Error("Reward authorization did not match the request.");
    }
    assertExternalRequest(
      finished.transactionRequest,
      { from: start.action.currentOwner, to: input.poolAddress },
      "Reward transaction request did not match the requested ticket.",
    );
    context.onStatus?.("WAITING_FOR_WALLET");
    const txHash = await send(finished.transactionRequest);
    context.onStatus?.("VERIFYING");
    const verified = await backendApi.actions.verifyClaim(start.actionId, txHash);
    if (verified.confirmed !== true || verified.actionId !== start.actionId || verified.result.claimTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Reward receipt verification failed.");
    }
    result = verified.result;
  }

  if (
    result.chainId !== 5042002 ||
    !addressesEqual(result.poolAddress, input.poolAddress) ||
    !addressesEqual(result.ticketAddress, input.ticketAddress) ||
    result.tokenId !== input.tokenId ||
    result.roundId !== input.roundId
  ) {
    throw new Error("Confirmed reward claim did not match the requested ticket.");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

export async function executeMarketplaceList(
  input: { ticketAddress: string; tokenId: string; askUsdcRaw: string },
  context: ExecutionContext,
): Promise<MarketplaceListExecutionResult> {
  const mode = requireMode(context);
  const matches = (payload: {
    action: string; chainId: number; ticketAddress: string; tokenId: string;
    askUsdcRaw: string; nonce: string; expiresAt: string;
  }) =>
    payload.action === "MARKETPLACE_LIST" &&
    payload.chainId === 5042002 &&
    addressesEqual(payload.ticketAddress, input.ticketAddress) &&
    payload.tokenId === input.tokenId &&
    payload.askUsdcRaw === input.askUsdcRaw &&
    isFreshNonce(payload);

  let result: MarketplaceListExecutionResult;
  if (mode === "CIRCLE_USER_WALLET") {
    // Circle runs the exact per token approval as its own verified phase
    // when it is missing, then the listing, both inside Circle.
    context.onStatus?.("WAITING_FOR_CIRCLE");
    result = await confirmCircleAction({
      actionType: "MARKETPLACE_LIST",
      intentKey: `MARKETPLACE_LIST:${input.ticketAddress.toLowerCase()}:${input.tokenId}:${input.askUsdcRaw}`,
      start: (credentials) => backendApi.actions.startCircleMarketplaceList({ ...input, ...credentials }),
      matchesIntent: matches,
    });
  } else {
    // The connected wallet sends its per token approval as a separate step
    // on the tickets page before this is called.
    const send = requireSender(context);
    context.onStatus?.("PREPARING");
    const start = await backendApi.actions.startMarketplaceList(input);
    if (start.executionMode !== "EXTERNAL_WALLET" || start.action.executionMode !== "EXTERNAL_OWNER" || !matches(start.action)) {
      throw new Error("Listing confirmation details did not match the requested ticket.");
    }
    const finished = await backendApi.actions.finishMarketplaceList(start.actionId);
    if (finished.confirmed !== true || finished.actionId !== start.actionId || finished.payloadHash !== start.payloadHash) {
      throw new Error("Listing authorization did not match the request.");
    }
    assertExternalRequest(
      finished.transactionRequest,
      { from: start.action.walletAddress },
      "Listing transaction request did not match the requested ticket.",
    );
    context.onStatus?.("WAITING_FOR_WALLET");
    const txHash = await send(finished.transactionRequest);
    context.onStatus?.("VERIFYING");
    const verified = await backendApi.actions.verifyMarketplaceList(start.actionId, txHash);
    if (verified.confirmed !== true || verified.actionId !== start.actionId || verified.result.listTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Listing receipt verification failed.");
    }
    result = verified.result;
  }

  if (
    result.chainId !== 5042002 ||
    !addressesEqual(result.ticketAddress, input.ticketAddress) ||
    result.tokenId !== input.tokenId ||
    result.askUsdcRaw !== input.askUsdcRaw
  ) {
    throw new Error("Confirmed listing did not match the requested ticket.");
  }
  return result;
}

export async function executeMarketplaceUpdatePrice(
  input: { listingId: string; newAskUsdcRaw: string },
  context: ExecutionContext,
): Promise<MarketplaceUpdatePriceExecutionResult> {
  const mode = requireMode(context);
  const matches = (payload: {
    action: string; chainId: number; listingId: string; newAskUsdcRaw: string; nonce: string; expiresAt: string;
  }) =>
    payload.action === "MARKETPLACE_UPDATE_PRICE" &&
    payload.chainId === 5042002 &&
    payload.listingId === input.listingId &&
    payload.newAskUsdcRaw === input.newAskUsdcRaw &&
    isFreshNonce(payload);

  let result: MarketplaceUpdatePriceExecutionResult;
  if (mode === "CIRCLE_USER_WALLET") {
    context.onStatus?.("WAITING_FOR_CIRCLE");
    result = await confirmCircleAction({
      actionType: "MARKETPLACE_UPDATE_PRICE",
      intentKey: `MARKETPLACE_UPDATE_PRICE:${input.listingId}:${input.newAskUsdcRaw}`,
      start: (credentials) => backendApi.actions.startCircleMarketplaceUpdatePrice({ ...input, ...credentials }),
      matchesIntent: matches,
    });
  } else {
    const send = requireSender(context);
    context.onStatus?.("PREPARING");
    const start = await backendApi.actions.startMarketplaceUpdatePrice(input);
    if (start.executionMode !== "EXTERNAL_WALLET" || start.action.executionMode !== "EXTERNAL_OWNER" || !matches(start.action)) {
      throw new Error("Price change confirmation details did not match the requested listing.");
    }
    const finished = await backendApi.actions.finishMarketplaceUpdatePrice(start.actionId);
    if (finished.confirmed !== true || finished.actionId !== start.actionId || finished.payloadHash !== start.payloadHash) {
      throw new Error("Price change authorization did not match the request.");
    }
    assertExternalRequest(
      finished.transactionRequest,
      { from: start.action.walletAddress },
      "Price change transaction request did not match the requested listing.",
    );
    context.onStatus?.("WAITING_FOR_WALLET");
    const txHash = await send(finished.transactionRequest);
    context.onStatus?.("VERIFYING");
    const verified = await backendApi.actions.verifyMarketplaceUpdatePrice(start.actionId, txHash);
    if (verified.confirmed !== true || verified.actionId !== start.actionId || verified.result.updateTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Price change receipt verification failed.");
    }
    result = verified.result;
  }

  if (
    result.chainId !== 5042002 ||
    result.listingId !== input.listingId ||
    result.newAskUsdcRaw !== input.newAskUsdcRaw
  ) {
    throw new Error("Confirmed price change did not match the requested listing.");
  }
  return result;
}

export async function executeMarketplaceCancel(
  input: { listingId: string },
  context: ExecutionContext,
): Promise<MarketplaceCancelExecutionResult> {
  const mode = requireMode(context);
  const matches = (payload: {
    action: string; chainId: number; listingId: string; nonce: string; expiresAt: string;
  }) =>
    payload.action === "MARKETPLACE_CANCEL" &&
    payload.chainId === 5042002 &&
    payload.listingId === input.listingId &&
    isFreshNonce(payload);

  let result: MarketplaceCancelExecutionResult;
  if (mode === "CIRCLE_USER_WALLET") {
    context.onStatus?.("WAITING_FOR_CIRCLE");
    result = await confirmCircleAction({
      actionType: "MARKETPLACE_CANCEL",
      intentKey: `MARKETPLACE_CANCEL:${input.listingId}`,
      start: (credentials) => backendApi.actions.startCircleMarketplaceCancel({ ...input, ...credentials }),
      matchesIntent: matches,
    });
  } else {
    const send = requireSender(context);
    context.onStatus?.("PREPARING");
    const start = await backendApi.actions.startMarketplaceCancel(input);
    if (start.executionMode !== "EXTERNAL_WALLET" || start.action.executionMode !== "EXTERNAL_OWNER" || !matches(start.action)) {
      throw new Error("Cancellation confirmation details did not match the requested listing.");
    }
    const finished = await backendApi.actions.finishMarketplaceCancel(start.actionId);
    if (finished.confirmed !== true || finished.actionId !== start.actionId || finished.payloadHash !== start.payloadHash) {
      throw new Error("Cancellation authorization did not match the request.");
    }
    assertExternalRequest(
      finished.transactionRequest,
      { from: start.action.walletAddress },
      "Cancellation transaction request did not match the requested listing.",
    );
    context.onStatus?.("WAITING_FOR_WALLET");
    const txHash = await send(finished.transactionRequest);
    context.onStatus?.("VERIFYING");
    const verified = await backendApi.actions.verifyMarketplaceCancel(start.actionId, txHash);
    if (verified.confirmed !== true || verified.actionId !== start.actionId || verified.result.cancelTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Cancellation receipt verification failed.");
    }
    result = verified.result;
  }

  if (result.chainId !== 5042002 || result.listingId !== input.listingId) {
    throw new Error("Confirmed cancellation did not match the requested listing.");
  }
  return result;
}

export async function executeMarketplaceBuy(
  input: { listingId: string; expectedAskUsdcRaw: string },
  context: ExecutionContext,
): Promise<MarketplaceBuyExecutionResult> {
  const mode = requireMode(context);
  const matches = (payload: {
    action: string; chainId: number; listingId: string; expectedAskUsdcRaw: string; nonce: string; expiresAt: string;
  }) =>
    payload.action === "MARKETPLACE_BUY" &&
    payload.chainId === 5042002 &&
    payload.listingId === input.listingId &&
    payload.expectedAskUsdcRaw === input.expectedAskUsdcRaw &&
    isFreshNonce(payload);

  let result: MarketplaceBuyExecutionResult;
  if (mode === "CIRCLE_USER_WALLET") {
    // Circle approves exactly the expected ask when the allowance is short,
    // then buys only after the listing is read again at that same ask.
    context.onStatus?.("WAITING_FOR_CIRCLE");
    result = await confirmCircleAction({
      actionType: "MARKETPLACE_BUY",
      intentKey: `MARKETPLACE_BUY:${input.listingId}:${input.expectedAskUsdcRaw}`,
      start: (credentials) => backendApi.actions.startCircleMarketplaceBuy({ ...input, ...credentials }),
      matchesIntent: matches,
    });
  } else {
    // The connected wallet approves the exact USDC ask as a separate step on
    // the marketplace page before this is called.
    const send = requireSender(context);
    context.onStatus?.("PREPARING");
    const start = await backendApi.actions.startMarketplaceBuy(input);
    if (start.executionMode !== "EXTERNAL_WALLET" || start.action.executionMode !== "EXTERNAL_OWNER" || !matches(start.action)) {
      throw new Error("Purchase confirmation details did not match the requested listing.");
    }
    const finished = await backendApi.actions.finishMarketplaceBuy(start.actionId);
    if (finished.confirmed !== true || finished.actionId !== start.actionId || finished.payloadHash !== start.payloadHash) {
      throw new Error("Purchase authorization did not match the request.");
    }
    assertExternalRequest(
      finished.transactionRequest,
      { from: start.action.walletAddress },
      "Purchase transaction request did not match the requested listing.",
    );
    context.onStatus?.("WAITING_FOR_WALLET");
    const txHash = await send(finished.transactionRequest);
    context.onStatus?.("VERIFYING");
    const verified = await backendApi.actions.verifyMarketplaceBuy(start.actionId, txHash);
    if (verified.confirmed !== true || verified.actionId !== start.actionId || verified.result.buyTxHash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Purchase receipt verification failed.");
    }
    result = verified.result;
  }

  if (
    result.chainId !== 5042002 ||
    result.listingId !== input.listingId ||
    result.askUsdcRaw !== input.expectedAskUsdcRaw
  ) {
    throw new Error("Confirmed purchase did not match the requested listing.");
  }
  return result;
}
