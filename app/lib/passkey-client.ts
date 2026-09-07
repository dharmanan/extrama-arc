"use client";

import {
  backendApi,
  type MarketplaceExecutionMode,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "./backend-api";

function base64urlToBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function bufferToBase64url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCreationOptions(
  options: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    user: {
      ...options.user,
      id: base64urlToBuffer(options.user.id),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id),
    })),
  };
}

function decodeRequestOptions(
  options: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: base64urlToBuffer(credential.id),
    })),
  };
}

function encodeCredential(credential: PublicKeyCredential) {
  const response = credential.response;

  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject:
        response instanceof AuthenticatorAttestationResponse
          ? bufferToBase64url(response.attestationObject)
          : undefined,
      authenticatorData:
        response instanceof AuthenticatorAssertionResponse
          ? bufferToBase64url(response.authenticatorData)
          : undefined,
      signature:
        response instanceof AuthenticatorAssertionResponse
          ? bufferToBase64url(response.signature)
          : undefined,
      userHandle:
        response instanceof AuthenticatorAssertionResponse && response.userHandle
          ? bufferToBase64url(response.userHandle)
          : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function ensurePasskeySupport() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("Passkeys require a secure supported browser.");
  }
}

export async function registerPasskey(
  ownerAddress: string,
  deviceName: string,
  signMessage: (message: string) => Promise<string>,
) {
  ensurePasskeySupport();

  const challenge = await backendApi.auth.registerChallenge(ownerAddress);
  const signature = await signMessage(challenge.message);
  const serverOptions = await backendApi.auth.startRegister(
    ownerAddress,
    challenge.challengeId,
    signature,
  );

  const credential = await navigator.credentials.create({
    publicKey: decodeCreationOptions(serverOptions),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey registration was cancelled.");
  }

  const result = await backendApi.auth.finishRegister(
    ownerAddress,
    encodeCredential(credential),
    deviceName,
  );

  return result;
}

export async function authenticatePasskey(ownerAddress: string) {
  ensurePasskeySupport();

  const serverOptions = await backendApi.auth.startLogin(ownerAddress);
  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(serverOptions),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey authentication was cancelled.");
  }

  const result = await backendApi.auth.finishLogin(
    ownerAddress,
    encodeCredential(credential),
  );

  return result;
}

function addressesEqual(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

export async function confirmEntryWithPasskey(input: {
  poolAddress: string;
  roundId: number;
  predictionPriceCents: number;
}) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startEntry(input);

  const actionMatches =
    start.action.action === "ENTRY" &&
    start.action.chainId === 5042002 &&
    addressesEqual(start.action.contract, input.poolAddress) &&
    start.action.roundId === input.roundId &&
    start.action.amountRaw === "1000000" &&
    start.action.predictionPriceCents === input.predictionPriceCents &&
    addressesEqual(start.action.destination, input.poolAddress) &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Entry confirmation details did not match the requested prediction.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishEntry(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.result.chainId !== 5042002 ||
    !addressesEqual(finished.result.poolAddress, input.poolAddress) ||
    finished.result.roundId !== input.roundId ||
    finished.result.predictionPriceCents !== input.predictionPriceCents ||
    finished.result.stakeRaw !== "1000000"
  ) {
    throw new Error("Confirmed transaction did not match the requested prediction.");
  }

  return finished.result;
}

export async function confirmTicketTransferWithPasskey(input: {
  ticketAddress: string;
  tokenId: string;
  destinationAddress: string;
}) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startTicketTransfer(input);

  const actionMatches =
    start.action.action === "TRANSFER_TICKET" &&
    start.action.chainId === 5042002 &&
    addressesEqual(start.action.contract, input.ticketAddress) &&
    start.action.tokenId === input.tokenId &&
    addressesEqual(start.action.from, start.action.walletAddress) &&
    addressesEqual(start.action.destination, input.destinationAddress) &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Transfer confirmation details did not match the requested NFT transfer.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishTicketTransfer(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.result.chainId !== 5042002 ||
    !addressesEqual(finished.result.ticketAddress, input.ticketAddress) ||
    finished.result.tokenId !== input.tokenId ||
    !addressesEqual(finished.result.destinationAddress, input.destinationAddress) ||
    !addressesEqual(finished.result.ownerAfter, input.destinationAddress)
  ) {
    throw new Error("Confirmed transaction did not match the requested NFT transfer.");
  }

  return finished.result;
}

export type RefundStartInput = {
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
};

export async function confirmRefundWithPasskey(input: RefundStartInput) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startRefund(input);

  const actionMatches =
    start.action.action === "REFUND_TICKET" &&
    start.action.chainId === 5042002 &&
    addressesEqual(start.action.poolAddress, input.poolAddress) &&
    addressesEqual(start.action.ticketAddress, input.ticketAddress) &&
    start.action.tokenId === input.tokenId &&
    start.action.roundId === input.roundId &&
    start.action.amountRaw === "1000000" &&
    addressesEqual(start.action.destination, start.action.currentOwner) &&
    (start.action.executionMode === "BACKEND_WALLET" ||
      start.action.executionMode === "EXTERNAL_OWNER") &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Refund confirmation details did not match the requested ticket.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishRefund(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.executionMode !== start.action.executionMode
  ) {
    throw new Error("Confirmed refund authorization did not match the request.");
  }

  if (finished.executionMode === "BACKEND_WALLET") {
    if (
      finished.result.chainId !== 5042002 ||
      !addressesEqual(finished.result.poolAddress, input.poolAddress) ||
      !addressesEqual(finished.result.ticketAddress, input.ticketAddress) ||
      finished.result.tokenId !== input.tokenId ||
      finished.result.amountRaw !== "1000000"
    ) {
      throw new Error("Confirmed refund did not match the requested ticket.");
    }

    return { executionMode: "BACKEND_WALLET" as const, result: finished.result };
  }

  if (
    finished.transactionRequest.chainId !== 5042002 ||
    !addressesEqual(finished.transactionRequest.to, input.poolAddress) ||
    !addressesEqual(finished.transactionRequest.from, start.action.currentOwner)
  ) {
    throw new Error("Refund transaction request did not match the requested ticket.");
  }

  return {
    executionMode: "EXTERNAL_OWNER" as const,
    actionId: start.actionId,
    payloadHash: start.payloadHash,
    transactionRequest: finished.transactionRequest,
    currentOwner: start.action.currentOwner,
  };
}

export async function confirmExternalRefundReceipt(actionId: string, txHash: string) {
  const finished = await backendApi.actions.verifyRefund(actionId, txHash);

  if (
    finished.confirmed !== true ||
    finished.actionId !== actionId ||
    finished.result.chainId !== 5042002 ||
    finished.result.refundTxHash.toLowerCase() !== txHash.toLowerCase()
  ) {
    throw new Error("Refund receipt verification failed.");
  }

  return finished.result;
}

export type ClaimStartInput = {
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
};

export async function confirmClaimWithPasskey(input: ClaimStartInput) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startClaim(input);

  const actionMatches =
    start.action.action === "CLAIM_REWARD" &&
    start.action.chainId === 5042002 &&
    addressesEqual(start.action.poolAddress, input.poolAddress) &&
    addressesEqual(start.action.ticketAddress, input.ticketAddress) &&
    start.action.tokenId === input.tokenId &&
    start.action.roundId === input.roundId &&
    /^[1-9][0-9]*$/.test(start.action.amountRaw) &&
    addressesEqual(start.action.destination, start.action.currentOwner) &&
    (start.action.executionMode === "BACKEND_WALLET" ||
      start.action.executionMode === "EXTERNAL_OWNER") &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Reward confirmation details did not match the requested ticket.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishClaim(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.executionMode !== start.action.executionMode
  ) {
    throw new Error("Confirmed reward authorization did not match the request.");
  }

  if (finished.executionMode === "BACKEND_WALLET") {
    if (
      finished.result.chainId !== 5042002 ||
      !addressesEqual(finished.result.poolAddress, input.poolAddress) ||
      !addressesEqual(finished.result.ticketAddress, input.ticketAddress) ||
      finished.result.tokenId !== input.tokenId ||
      finished.result.roundId !== input.roundId ||
      finished.result.amountRaw !== start.action.amountRaw ||
      !addressesEqual(finished.result.currentOwner, start.action.currentOwner)
    ) {
      throw new Error("Confirmed reward claim did not match the requested ticket.");
    }

    return {
      executionMode: "BACKEND_WALLET" as const,
      amountRaw: start.action.amountRaw,
      currentOwner: start.action.currentOwner,
      result: finished.result,
    };
  }

  if (
    finished.transactionRequest.chainId !== 5042002 ||
    !addressesEqual(finished.transactionRequest.to, input.poolAddress) ||
    !addressesEqual(finished.transactionRequest.from, start.action.currentOwner) ||
    finished.transactionRequest.value !== "0x0"
  ) {
    throw new Error("Reward transaction request did not match the requested ticket.");
  }

  return {
    executionMode: "EXTERNAL_OWNER" as const,
    actionId: start.actionId,
    payloadHash: start.payloadHash,
    amountRaw: start.action.amountRaw,
    transactionRequest: finished.transactionRequest,
    currentOwner: start.action.currentOwner,
  };
}

export async function confirmExternalClaimReceipt(actionId: string, txHash: string) {
  const finished = await backendApi.actions.verifyClaim(actionId, txHash);

  if (
    finished.confirmed !== true ||
    finished.actionId !== actionId ||
    finished.result.chainId !== 5042002 ||
    finished.result.claimTxHash.toLowerCase() !== txHash.toLowerCase()
  ) {
    throw new Error("Reward receipt verification failed.");
  }

  return finished.result;
}


export type MarketplaceListStartInput = {
  ticketAddress: string;
  tokenId: string;
  askUsdcRaw: string;
};

export async function confirmMarketplaceListWithPasskey(input: MarketplaceListStartInput) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startMarketplaceList(input);

  const actionMatches =
    start.action.action === "MARKETPLACE_LIST" &&
    start.action.chainId === 5042002 &&
    addressesEqual(start.action.ticketAddress, input.ticketAddress) &&
    start.action.tokenId === input.tokenId &&
    start.action.askUsdcRaw === input.askUsdcRaw &&
    (start.action.executionMode === "BACKEND_WALLET" || start.action.executionMode === "EXTERNAL_OWNER") &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Listing confirmation details did not match the requested ticket.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishMarketplaceList(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.executionMode !== start.action.executionMode
  ) {
    throw new Error("Confirmed listing authorization did not match the request.");
  }

  if (finished.executionMode === "BACKEND_WALLET") {
    if (
      finished.result.chainId !== 5042002 ||
      !addressesEqual(finished.result.ticketAddress, input.ticketAddress) ||
      finished.result.tokenId !== input.tokenId ||
      finished.result.askUsdcRaw !== input.askUsdcRaw
    ) {
      throw new Error("Confirmed listing did not match the requested ticket.");
    }

    return { executionMode: "BACKEND_WALLET" as const, result: finished.result };
  }

  if (
    finished.transactionRequest.chainId !== 5042002 ||
    !addressesEqual(finished.transactionRequest.from, start.action.walletAddress)
  ) {
    throw new Error("Listing transaction request did not match the requested ticket.");
  }

  return {
    executionMode: "EXTERNAL_OWNER" as const,
    actionId: start.actionId,
    payloadHash: start.payloadHash,
    transactionRequest: finished.transactionRequest,
    sellerAddress: start.action.walletAddress,
  };
}

export async function confirmExternalMarketplaceListReceipt(actionId: string, txHash: string) {
  const finished = await backendApi.actions.verifyMarketplaceList(actionId, txHash);

  if (
    finished.confirmed !== true ||
    finished.actionId !== actionId ||
    finished.result.chainId !== 5042002 ||
    finished.result.listTxHash.toLowerCase() !== txHash.toLowerCase()
  ) {
    throw new Error("Listing receipt verification failed.");
  }

  return finished.result;
}

export type MarketplaceUpdatePriceStartInput = {
  listingId: string;
  newAskUsdcRaw: string;
};

export async function confirmMarketplaceUpdatePriceWithPasskey(input: MarketplaceUpdatePriceStartInput) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startMarketplaceUpdatePrice(input);

  const actionMatches =
    start.action.action === "MARKETPLACE_UPDATE_PRICE" &&
    start.action.chainId === 5042002 &&
    start.action.listingId === input.listingId &&
    start.action.newAskUsdcRaw === input.newAskUsdcRaw &&
    (start.action.executionMode === "BACKEND_WALLET" || start.action.executionMode === "EXTERNAL_OWNER") &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Price change confirmation details did not match the requested listing.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishMarketplaceUpdatePrice(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.executionMode !== start.action.executionMode
  ) {
    throw new Error("Confirmed price change authorization did not match the request.");
  }

  if (finished.executionMode === "BACKEND_WALLET") {
    if (
      finished.result.chainId !== 5042002 ||
      finished.result.listingId !== input.listingId ||
      finished.result.newAskUsdcRaw !== input.newAskUsdcRaw
    ) {
      throw new Error("Confirmed price change did not match the requested listing.");
    }

    return { executionMode: "BACKEND_WALLET" as const, result: finished.result };
  }

  if (
    finished.transactionRequest.chainId !== 5042002 ||
    !addressesEqual(finished.transactionRequest.from, start.action.walletAddress)
  ) {
    throw new Error("Price change transaction request did not match the requested listing.");
  }

  return {
    executionMode: "EXTERNAL_OWNER" as const,
    actionId: start.actionId,
    payloadHash: start.payloadHash,
    transactionRequest: finished.transactionRequest,
    sellerAddress: start.action.walletAddress,
  };
}

export async function confirmExternalMarketplaceUpdatePriceReceipt(actionId: string, txHash: string) {
  const finished = await backendApi.actions.verifyMarketplaceUpdatePrice(actionId, txHash);

  if (
    finished.confirmed !== true ||
    finished.actionId !== actionId ||
    finished.result.chainId !== 5042002 ||
    finished.result.updateTxHash.toLowerCase() !== txHash.toLowerCase()
  ) {
    throw new Error("Price change receipt verification failed.");
  }

  return finished.result;
}

export type MarketplaceCancelStartInput = {
  listingId: string;
};

export async function confirmMarketplaceCancelWithPasskey(input: MarketplaceCancelStartInput) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startMarketplaceCancel(input);

  const actionMatches =
    start.action.action === "MARKETPLACE_CANCEL" &&
    start.action.chainId === 5042002 &&
    start.action.listingId === input.listingId &&
    (start.action.executionMode === "BACKEND_WALLET" || start.action.executionMode === "EXTERNAL_OWNER") &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Cancellation confirmation details did not match the requested listing.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishMarketplaceCancel(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.executionMode !== start.action.executionMode
  ) {
    throw new Error("Confirmed cancellation authorization did not match the request.");
  }

  if (finished.executionMode === "BACKEND_WALLET") {
    if (finished.result.chainId !== 5042002 || finished.result.listingId !== input.listingId) {
      throw new Error("Confirmed cancellation did not match the requested listing.");
    }

    return { executionMode: "BACKEND_WALLET" as const, result: finished.result };
  }

  if (
    finished.transactionRequest.chainId !== 5042002 ||
    !addressesEqual(finished.transactionRequest.from, start.action.walletAddress)
  ) {
    throw new Error("Cancellation transaction request did not match the requested listing.");
  }

  return {
    executionMode: "EXTERNAL_OWNER" as const,
    actionId: start.actionId,
    payloadHash: start.payloadHash,
    transactionRequest: finished.transactionRequest,
    sellerAddress: start.action.walletAddress,
  };
}

export async function confirmExternalMarketplaceCancelReceipt(actionId: string, txHash: string) {
  const finished = await backendApi.actions.verifyMarketplaceCancel(actionId, txHash);

  if (
    finished.confirmed !== true ||
    finished.actionId !== actionId ||
    finished.result.chainId !== 5042002 ||
    finished.result.cancelTxHash.toLowerCase() !== txHash.toLowerCase()
  ) {
    throw new Error("Cancellation receipt verification failed.");
  }

  return finished.result;
}

export type MarketplaceBuyStartInput = {
  listingId: string;
  expectedAskUsdcRaw: string;
  executionMode: MarketplaceExecutionMode;
};

export async function confirmMarketplaceBuyWithPasskey(input: MarketplaceBuyStartInput) {
  ensurePasskeySupport();

  const start = await backendApi.actions.startMarketplaceBuy(input);

  const actionMatches =
    start.action.action === "MARKETPLACE_BUY" &&
    start.action.chainId === 5042002 &&
    start.action.listingId === input.listingId &&
    start.action.expectedAskUsdcRaw === input.expectedAskUsdcRaw &&
    start.action.executionMode === input.executionMode &&
    typeof start.action.nonce === "string" &&
    start.action.nonce.length >= 16 &&
    Date.parse(start.action.expiresAt) > Date.now();

  if (!actionMatches) {
    throw new Error("Purchase confirmation details did not match the requested listing.");
  }

  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(start.publicKey),
  });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Confirmation was cancelled.");
  }

  const finished = await backendApi.actions.finishMarketplaceBuy(
    start.actionId,
    encodeCredential(credential),
  );

  if (
    finished.confirmed !== true ||
    finished.actionId !== start.actionId ||
    finished.payloadHash !== start.payloadHash ||
    finished.executionMode !== start.action.executionMode
  ) {
    throw new Error("Confirmed purchase authorization did not match the request.");
  }

  if (finished.executionMode === "BACKEND_WALLET") {
    if (
      finished.result.chainId !== 5042002 ||
      finished.result.listingId !== input.listingId ||
      finished.result.askUsdcRaw !== input.expectedAskUsdcRaw
    ) {
      throw new Error("Confirmed purchase did not match the requested listing.");
    }

    return { executionMode: "BACKEND_WALLET" as const, result: finished.result };
  }

  if (
    finished.transactionRequest.chainId !== 5042002 ||
    !addressesEqual(finished.transactionRequest.from, start.action.walletAddress)
  ) {
    throw new Error("Purchase transaction request did not match the requested listing.");
  }

  return {
    executionMode: "EXTERNAL_OWNER" as const,
    actionId: start.actionId,
    payloadHash: start.payloadHash,
    transactionRequest: finished.transactionRequest,
    buyerAddress: start.action.walletAddress,
  };
}

export async function confirmExternalMarketplaceBuyReceipt(actionId: string, txHash: string) {
  const finished = await backendApi.actions.verifyMarketplaceBuy(actionId, txHash);

  if (
    finished.confirmed !== true ||
    finished.actionId !== actionId ||
    finished.result.chainId !== 5042002 ||
    finished.result.buyTxHash.toLowerCase() !== txHash.toLowerCase()
  ) {
    throw new Error("Purchase receipt verification failed.");
  }

  return finished.result;
}
