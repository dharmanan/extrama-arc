"use client";

import type { Asset } from "./domain";

const API_URL = "/api/extrema";

export type LiveRoundState = {
  roundId: number;
  contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
  canEnter: boolean;
  entryOpenAt: string;
  entryCloseAt: string;
  observationStartAt: string;
  observationEndAt: string;
  entryCount: number;
  totalStakeRaw: string;
  totalStakeUsdc: string;
  escrowRemainingRaw: string;
  escrowRemainingUsdc: string;
  resolvedPriceCents: string;
  lastPredictionPriceCents: string | null;
  lastPredictionPrice: string | null;
  lastPredictionTicketId: string | null;
  lastPredictionEntrySequence: number | null;
};

export type LivePool = {
  slug: string;
  poolAddress: string;
  ticketAddress: string;
  asset: Asset;
  direction: "HIGH" | "LOW";
  cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
  source: string;
  sourceSymbol: string;
  market: {
    available: boolean;
    markPrice: string | null;
    sourceTimeIso: string | null;
    refreshedAtIso: string;
    refreshIntervalSeconds: 60;
    source: string | null;
    isSettlementSource: boolean;
  };
  round: LiveRoundState;
};

export type LiveRoundsResponse = {
  chain: {
    id: number;
    name: string;
    blockNumber: number;
    timestamp: number;
    timestampIso: string;
    explorerUrl: string;
  };
  factory: {
    address: string;
    poolCount: number;
  };
  pools: LivePool[];
};

export type LiveRoundResponse = {
  chain: LiveRoundsResponse["chain"];
  factory: LiveRoundsResponse["factory"];
  pool: LivePool;
};


export type ArchiveWinner = {
  rank: number;
  tokenId: string;
  currentOwner: string;
  predictionPriceCents: string;
  predictionPrice: string;
  rewardRaw: string;
  rewardUsdc: string;
  claimed: boolean;
};

export type ArchiveRound = {
  slug: string;
  poolAddress: string;
  ticketAddress: string;
  asset: Asset;
  direction: "HIGH" | "LOW";
  cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
  roundId: number;
  contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
  entryCloseAt: string;
  observationEndAt: string;
  resolvedPriceCents: string;
  resolvedPrice: string | null;
  entryCount: number;
  totalStakeRaw: string;
  totalStakeUsdc: string;
  winners: ArchiveWinner[];
};

export type ArchiveResponse = {
  chain: {
    id: number;
    name: string;
    blockNumber: number;
    timestamp: number;
    timestampIso: string;
    explorerUrl: string;
  };
  retentionDays: number;
  rounds: ArchiveRound[];
};

export type OwnedTicket = {
  tokenId: string;
  roundId: number;
  predictionPriceCents: number;
  predictionPrice: string;
  entrySequence: number;
  roundStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
  placement: number;
  isClaimed: boolean;
  isRefunded: boolean;
  claimableRaw: string;
  claimableUsdc: string;
  owner: string;
  asset: Asset;
  direction: "HIGH" | "LOW";
  cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
  slug: string;
  poolAddress: string;
  ticketAddress: string;
  explorerUrl: string;
};

export type WalletTicketsState = {
  chain: {
    id: number;
    name: string;
    blockNumber: number;
    explorerUrl: string;
  };
  wallet: { address: string };
  ticketCount: number;
  tickets: OwnedTicket[];
};

export type OwnedTicketsResponse = {
  backendWallet: WalletTicketsState;
  ownerWallet: WalletTicketsState | null;
};

export type EntryActionPayload = {
  action: "ENTRY";
  chainId: 5042002;
  contract: string;
  roundId: number;
  amountRaw: "1000000";
  predictionPriceCents: number;
  destination: string;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type EntryActionStartResponse = {
  actionId: string;
  action: EntryActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
};

export type EntryExecutionResult = {
  chainId: 5042002;
  walletAddress: string;
  poolAddress: string;
  ticketAddress: string;
  roundId: number;
  predictionPriceCents: number;
  stakeRaw: "1000000";
  stakeUsdc: string;
  approvalTxHash: string | null;
  entryTxHash: string;
  explorerUrl: string;
  ticketId: string;
  entrySequence: string;
  ticketOwner: string;
  before: {
    walletUsdcRaw: string;
    walletUsdc: string;
    poolUsdcRaw: string;
    poolUsdc: string;
    entryCount: number;
    totalStakeRaw: string;
    totalStakeUsdc: string;
  };
  after: {
    walletUsdcRaw: string;
    walletUsdc: string;
    poolUsdcRaw: string;
    poolUsdc: string;
    entryCount: number;
    totalStakeRaw: string;
    totalStakeUsdc: string;
    escrowRemainingRaw: string;
    escrowRemainingUsdc: string;
  };
};

export type EntryActionFinishResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  result: EntryExecutionResult;
};

export type TicketTransferActionPayload = {
  action: "TRANSFER_TICKET";
  chainId: 5042002;
  contract: string;
  tokenId: string;
  from: string;
  destination: string;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type TicketTransferActionStartResponse = {
  actionId: string;
  action: TicketTransferActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
};

export type TicketTransferExecutionResult = {
  chainId: 5042002;
  walletAddress: string;
  ticketAddress: string;
  tokenId: string;
  destinationAddress: string;
  ownerBefore: string;
  ownerAfter: string;
  transferTxHash: string;
  explorerUrl: string;
};

export type TicketTransferActionFinishResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  result: TicketTransferExecutionResult;
};

export type RefundExecutionMode = "BACKEND_WALLET" | "EXTERNAL_OWNER";

export type RefundActionPayload = {
  action: "REFUND_TICKET";
  chainId: 5042002;
  contract: string;
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
  amountRaw: "1000000";
  currentOwner: string;
  destination: string;
  executionMode: RefundExecutionMode;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type RefundActionStartResponse = {
  actionId: string;
  action: RefundActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
};

export type RefundAccountingProof =
  | {
      available: true;
      poolUsdcBefore: string;
      poolUsdcAfter: string;
      escrowRemainingBefore: string;
      escrowRemainingAfter: string;
      poolUsdcDeltaExact: boolean;
      escrowDeltaExact: boolean;
    }
  | {
      available: false;
      reason: string;
      detail: string;
    };

export type RefundExecutionResult = {
  chainId: 5042002;
  executionMode: RefundExecutionMode;
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
  currentOwner: string;
  amountRaw: "1000000";
  refundTxHash: string;
  explorerUrl: string;
  accounting?: RefundAccountingProof | {
    poolUsdcBefore: string;
    poolUsdcAfter: string;
    escrowRemainingBefore: string;
    escrowRemainingAfter: string;
  };
};

export type RefundTransactionRequest = {
  chainId: 5042002;
  to: string;
  data: string;
  value: string;
  from: string;
};

export type RefundActionFinishResponse =
  | {
      confirmed: true;
      actionId: string;
      payloadHash: string;
      executionMode: "BACKEND_WALLET";
      result: RefundExecutionResult;
    }
  | {
      confirmed: true;
      actionId: string;
      payloadHash: string;
      executionMode: "EXTERNAL_OWNER";
      transactionRequest: RefundTransactionRequest;
    };

export type RefundVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  result: RefundExecutionResult;
};


export type ClaimExecutionMode = "BACKEND_WALLET" | "EXTERNAL_OWNER";

export type ClaimActionPayload = {
  action: "CLAIM_REWARD";
  chainId: 5042002;
  contract: string;
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
  amountRaw: string;
  currentOwner: string;
  destination: string;
  executionMode: ClaimExecutionMode;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type ClaimActionStartResponse = {
  actionId: string;
  action: ClaimActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
};

export type ClaimAccountingProof =
  | {
      available: true;
      poolUsdcBefore: string;
      poolUsdcAfter: string;
      escrowRemainingBefore: string;
      escrowRemainingAfter: string;
      poolUsdcDeltaExact: boolean;
      escrowDeltaExact: boolean;
    }
  | {
      available: false;
      reason: string;
      detail: string;
    };

export type ClaimExecutionResult = {
  chainId: 5042002;
  executionMode: ClaimExecutionMode;
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
  currentOwner: string;
  amountRaw: string;
  claimTxHash: string;
  explorerUrl: string;
  accounting?: ClaimAccountingProof | {
    poolUsdcBefore: string;
    poolUsdcAfter: string;
    escrowRemainingBefore: string;
    escrowRemainingAfter: string;
  };
};

export type ClaimTransactionRequest = {
  chainId: 5042002;
  to: string;
  data: string;
  value: string;
  from: string;
};

export type ClaimActionFinishResponse =
  | {
      confirmed: true;
      actionId: string;
      payloadHash: string;
      executionMode: "BACKEND_WALLET";
      result: ClaimExecutionResult;
    }
  | {
      confirmed: true;
      actionId: string;
      payloadHash: string;
      executionMode: "EXTERNAL_OWNER";
      transactionRequest: ClaimTransactionRequest;
    };

export type ClaimVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  result: ClaimExecutionResult;
};

export function isAuthSessionError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return (
    message === "authentication_required" ||
    message === "session_expired" ||
    message === "invalid_session"
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (typeof window !== "undefined") {
    headers.set("x-extrema-browser-origin", window.location.origin);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function post<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const backendApi = {
  auth: {
    registerChallenge(ownerAddress: string) {
      return post<{ challengeId: string; message: string; expiresInSeconds: number }>(
        "/auth/register/challenge",
        { ownerAddress },
      );
    },
    startRegister(ownerAddress: string, challengeId: string, signature: string) {
      return post<PublicKeyCredentialCreationOptionsJSON>("/auth/register/start", {
        ownerAddress,
        challengeId,
        signature,
      });
    },
    finishRegister(ownerAddress: string, credential: unknown, deviceName: string) {
      return post<{ ownerAddress: string }>("/auth/register/finish", {
        ownerAddress,
        credential,
        deviceName,
      });
    },
    startLogin(ownerAddress: string) {
      return post<PublicKeyCredentialRequestOptionsJSON>("/auth/login/start", { ownerAddress });
    },
    finishLogin(ownerAddress: string, credential: unknown) {
      return post<{ ownerAddress: string }>("/auth/login/finish", {
        ownerAddress,
        credential,
      });
    },
    logout() {
      return post<{ ok: true }>("/auth/logout", {});
    },
  },
  rounds: {
    list() {
      return request<LiveRoundsResponse>("/rounds");
    },
    get(slug: string) {
      return request<LiveRoundResponse>(`/rounds/${encodeURIComponent(slug)}`);
    },
    archive(days = 90) {
      return request<ArchiveResponse>(`/rounds/archive?days=${days}`);
    },
  },
  actions: {
    startEntry(input: {
      poolAddress: string;
      roundId: number;
      predictionPriceCents: number;
    }) {
      return post<EntryActionStartResponse>("/actions/entry/start", input);
    },
    finishEntry(actionId: string, credential: unknown) {
      return post<EntryActionFinishResponse>("/actions/entry/finish", {
        actionId,
        credential,
      });
    },
    startTicketTransfer(input: {
      ticketAddress: string;
      tokenId: string;
      destinationAddress: string;
    }) {
      return post<TicketTransferActionStartResponse>("/actions/ticket-transfer/start", input);
    },
    finishTicketTransfer(actionId: string, credential: unknown) {
      return post<TicketTransferActionFinishResponse>("/actions/ticket-transfer/finish", {
        actionId,
        credential,
      });
    },
    startRefund(input: {
      poolAddress: string;
      ticketAddress: string;
      tokenId: string;
      roundId: number;
    }) {
      return post<RefundActionStartResponse>("/actions/refund/start", input);
    },
    finishRefund(actionId: string, credential: unknown) {
      return post<RefundActionFinishResponse>("/actions/refund/finish", {
        actionId,
        credential,
      });
    },
    verifyRefund(actionId: string, txHash: string) {
      return post<RefundVerifyResponse>("/actions/refund/verify", {
        actionId,
        txHash,
      });
    },
    startClaim(input: {
      poolAddress: string;
      ticketAddress: string;
      tokenId: string;
      roundId: number;
    }) {
      return post<ClaimActionStartResponse>("/actions/claim/start", input);
    },
    finishClaim(actionId: string, credential: unknown) {
      return post<ClaimActionFinishResponse>("/actions/claim/finish", {
        actionId,
        credential,
      });
    },
    verifyClaim(actionId: string, txHash: string) {
      return post<ClaimVerifyResponse>("/actions/claim/verify", {
        actionId,
        txHash,
      });
    },
  },
  wallet: {
    get() {
      return request<{ wallet: { id: string; address: string; createdAt: string } | null }>("/wallet");
    },
    tickets() {
      return request<OwnedTicketsResponse>("/wallet/tickets");
    },
    chainState() {
      return request<{
        chain: {
          id: number;
          name: string;
          rpcUrl: string;
          explorerUrl: string;
          blockNumber: number;
        };
        native: {
          symbol: string;
          decimals: number;
          balanceRaw: string;
          balanceFormatted: string;
        };
        usdc: {
          address: string;
          name: string;
          symbol: string;
          decimals: number;
          balanceRaw: string;
          balanceFormatted: string;
          contractCodePresent: boolean;
        };
        wallet: {
          address: string;
          explorerUrl: string;
        };
      }>("/wallet/chain-state");
    },
    create() {
      return post<{
        created: boolean;
        wallet: { id: string; address: string; createdAt: string };
        privateKey: string | null;
        privateKeyDisclosure: "one_time_only" | null;
      }>("/wallet/create", {});
    },
  },
};

export type PublicKeyCredentialCreationOptionsJSON = {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: PublicKeyCredentialType; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
};

export type PublicKeyCredentialRequestOptionsJSON = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  userVerification?: UserVerificationRequirement;
};
