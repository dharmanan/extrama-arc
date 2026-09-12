"use client";

import type { Asset } from "./domain";

const API_URL = "/api/extrema";

export type LiveRoundState = {
  roundId: number;
  contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
  canEnter: boolean;
  scheduleVersion: "V1" | "V2";
  entryOpenAt: string;
  entryCloseAt: string;
  observationStartAt: string;
  observationEndAt: string;
  marketPeriodStartAt: string | null;
  marketPeriodEndAt: string | null;
  settlementEligibleAt: string;
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
  originalEntrant: string;
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
  roundId: number | null;
  contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED" | "NO_ROUND";
  marketPeriodStartAt: string;
  marketPeriodEndAt: string;
  marketResultCents: string;
  marketResult: string;
  marketResultExact: string;
  evidenceSha256: string;
  entryCloseAt: string | null;
  settlementEligibleAt: string;
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

export type RoundEntry = {
  ticketId: string;
  originalEntrant: string;
  predictionPriceCents: string;
  predictionPrice: string;
  entrySequence: number;
};

export type RoundEntriesResponse = {
  chain: {
    id: number;
    name: string;
    explorerUrl: string;
  };
  pool: {
    slug: string;
    poolAddress: string;
    asset: Asset;
    direction: "HIGH" | "LOW";
    cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
    sourceSymbol: string;
  };
  round: {
    roundId: number;
    contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
    entryCount: number;
    readCount: number;
    complete: boolean;
  };
  entries: RoundEntry[];
};

export type RoundVerificationIntegrity = {
  evidenceHashValid: boolean;
  poolIdentityMatches: boolean;
  marketPeriodMatches: boolean;
  resolvedPriceMatchesOnchain: boolean | null;
};

export type RoundVerificationSelected = {
  exact: string;
  resolvedPriceCents: string;
  candleOpenTime: number;
  candleOpenIso: string;
};

export type RoundVerification =
  | { status: "PENDING" }
  | { status: "NOT_APPLICABLE"; reason: string }
  | { status: "EVIDENCE_MISSING"; reason: string }
  | { status: "EVIDENCE_INTEGRITY_FAILED"; reason: string }
  | {
      status: "VERIFIED" | "INTEGRITY_MISMATCH";
      source: string;
      endpoint: string;
      symbol: string;
      cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
      direction: "HIGH" | "LOW";
      interval: string;
      marketPeriod: { startInclusive: string; endExclusive: string };
      candleCount: number;
      sourceDataSha256: string;
      rounding: string;
      selected: RoundVerificationSelected;
      evidenceSha256: string;
      createdAt: string;
      settlementTxHash: string | null;
      integrity: RoundVerificationIntegrity;
    };

export type RoundVerificationResponse = {
  chain: {
    id: number;
    name: string;
    explorerUrl: string;
  };
  pool: {
    slug: string;
    poolAddress: string;
    asset: Asset;
    direction: "HIGH" | "LOW";
    cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
    sourceSymbol: string;
  };
  round: {
    roundId: number;
    contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
    marketPeriodStartAt: string | null;
    marketPeriodEndAt: string | null;
    settlementEligibleAt: string;
    resolvedPriceCents: string;
    resolvedPrice: string | null;
  };
  verification: RoundVerification;
};

export type MarketplaceOnchainStatus = "ACTIVE" | "SOLD" | "CANCELLED" | "INVALIDATED";
export type MarketplaceListingState =
  | "ACTIVE"
  | "ACTION_NEEDED"
  | "EXPIRED"
  | "SOLD"
  | "CANCELLED"
  | "INVALIDATED";
export type MarketplaceUnbuyableReason = "approval_revoked" | "ownership_changed" | null;

export type MarketplaceListing = {
  listingId: string;
  onchainStatus: MarketplaceOnchainStatus | null;
  state: MarketplaceListingState | null;
  unbuyableReason: MarketplaceUnbuyableReason;
  isBuyable: boolean;
  seller: string;
  currentOwner: string | null;
  isApproved: boolean;
  askUsdcRaw: string;
  askUsdc: string;
  createdAt: string;
  asset: Asset;
  direction: "HIGH" | "LOW";
  cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
  slug: string;
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
  roundStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED" | null;
  observationEndAt: string | null;
  tradingCutoffAt: string | null;
  predictionPriceCents: string | null;
  predictionPrice: string | null;
};

export type MarketplaceListingsResponse = {
  chain: {
    id: number;
    name: string;
    blockNumber: number;
    explorerUrl: string;
  };
  marketplace: {
    address: string;
    listingCount: number;
  };
  listings: MarketplaceListing[];
  degradedListings: Array<{ listingId: string; reason: string }>;
};

export type MarketplaceListingResponse = {
  chain: {
    id: number;
    name: string;
    blockNumber: number;
    explorerUrl: string;
  };
  listing: MarketplaceListing;
};

export type MarketplaceApprovalState = {
  ticketAddress: string;
  tokenId: string;
  owner: string;
  marketplaceAddress: string;
  isApproved: boolean;
};

export type MarketplaceUsdcAllowance = {
  owner: string;
  marketplaceAddress: string;
  usdcAddress: string;
  allowanceRaw: string;
};

// The two human execution modes. SYSTEM_SEED_WALLET agents never hold a
// browser session, so they never appear in any client facing type.
export type HumanExecutionMode = "EXTERNAL_WALLET" | "CIRCLE_USER_WALLET";

// Connected wallet refund, claim and marketplace payloads are labelled
// EXTERNAL_OWNER; Circle payloads are labelled CIRCLE_USER_WALLET.
export type MarketplaceExecutionMode = "EXTERNAL_OWNER" | "CIRCLE_USER_WALLET";

export type ExternalActionAuthorization = {
  authorization: "EXTERNAL_WALLET_SESSION";
  executionMode: "EXTERNAL_WALLET";
};

// ---- Circle user controlled wallet actions ---------------------------------

export type CircleActionType =
  | "TRANSFER_TICKET"
  | "REFUND_TICKET"
  | "CLAIM_REWARD"
  | "MARKETPLACE_LIST"
  | "MARKETPLACE_UPDATE_PRICE"
  | "MARKETPLACE_CANCEL"
  | "MARKETPLACE_BUY";

export type CircleApprovalActionType = "MARKETPLACE_LIST" | "MARKETPLACE_BUY";

export type CircleStartCredentials = {
  circleUserToken: string;
  circleRequestId: string;
};

export type CircleActionStartResponse<Payload> = {
  actionId: string;
  action: Payload;
  payloadHash: string;
  expiresInSeconds: number;
  executionMode: "CIRCLE_USER_WALLET";
  step: "APPROVAL_REQUIRED" | "ACTION_READY";
  challengeId: string;
};

export type CircleActionPendingResponse = {
  pending: true;
  actionId: string;
  transactionObserved: boolean;
};

export type CircleActionApprovalVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "CIRCLE_USER_WALLET";
  approvalTxHash: string;
  step: "ACTION_READY";
  challengeId: string;
};

export type CircleActionVerifyResponse<Result> = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "CIRCLE_USER_WALLET";
  result: Result;
};

export type MarketplaceTransactionRequest = {
  chainId: 5042002;
  to: string;
  data: string;
  value: string;
  from: string;
};

// ---- List --------------------------------------------------------------

export type MarketplaceListActionPayload = {
  action: "MARKETPLACE_LIST";
  chainId: 5042002;
  contract: string;
  ticketAddress: string;
  tokenId: string;
  askUsdcRaw: string;
  executionMode: MarketplaceExecutionMode;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type MarketplaceListActionStartResponse = {
  actionId: string;
  action: MarketplaceListActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
} & ExternalActionAuthorization;

export type MarketplaceListExecutionResult = {
  chainId: 5042002;
  executionMode: MarketplaceExecutionMode;
  marketplaceAddress: string;
  ticketAddress: string;
  tokenId: string;
  seller: string;
  askUsdcRaw: string;
  listingId: string;
  approvalTxHash: string | null;
  listTxHash: string;
  explorerUrl: string;
};

export type MarketplaceListActionFinishResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  transactionRequest: MarketplaceTransactionRequest;
};

export type MarketplaceListVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  result: MarketplaceListExecutionResult;
};

// ---- Update price --------------------------------------------------------

export type MarketplaceUpdatePriceActionPayload = {
  action: "MARKETPLACE_UPDATE_PRICE";
  chainId: 5042002;
  contract: string;
  listingId: string;
  ticketAddress: string;
  tokenId: string;
  newAskUsdcRaw: string;
  executionMode: MarketplaceExecutionMode;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type MarketplaceUpdatePriceActionStartResponse = {
  actionId: string;
  action: MarketplaceUpdatePriceActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
} & ExternalActionAuthorization;

export type MarketplaceUpdatePriceExecutionResult = {
  chainId: 5042002;
  executionMode: MarketplaceExecutionMode;
  marketplaceAddress: string;
  listingId: string;
  ticketAddress: string;
  tokenId: string;
  newAskUsdcRaw: string;
  approvalTxHash?: string | null;
  updateTxHash: string;
  explorerUrl: string;
};

export type MarketplaceUpdatePriceActionFinishResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  transactionRequest: MarketplaceTransactionRequest;
};

export type MarketplaceUpdatePriceVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  result: MarketplaceUpdatePriceExecutionResult;
};

// ---- Cancel ----------------------------------------------------------------

export type MarketplaceCancelActionPayload = {
  action: "MARKETPLACE_CANCEL";
  chainId: 5042002;
  contract: string;
  listingId: string;
  ticketAddress: string;
  tokenId: string;
  executionMode: MarketplaceExecutionMode;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type MarketplaceCancelActionStartResponse = {
  actionId: string;
  action: MarketplaceCancelActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
} & ExternalActionAuthorization;

export type MarketplaceCancelExecutionResult = {
  chainId: 5042002;
  executionMode: MarketplaceExecutionMode;
  marketplaceAddress: string;
  listingId: string;
  ticketAddress: string;
  tokenId: string;
  cancelTxHash: string;
  explorerUrl: string;
};

export type MarketplaceCancelActionFinishResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  transactionRequest: MarketplaceTransactionRequest;
};

export type MarketplaceCancelVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  result: MarketplaceCancelExecutionResult;
};

// ---- Buy ---------------------------------------------------------------

export type MarketplaceBuyActionPayload = {
  action: "MARKETPLACE_BUY";
  chainId: 5042002;
  contract: string;
  listingId: string;
  ticketAddress: string;
  tokenId: string;
  sellerAddress: string;
  expectedAskUsdcRaw: string;
  executionMode: MarketplaceExecutionMode;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

export type MarketplaceBuyActionStartResponse = {
  actionId: string;
  action: MarketplaceBuyActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
} & ExternalActionAuthorization;

export type MarketplaceBuyExecutionResult = {
  chainId: 5042002;
  executionMode: MarketplaceExecutionMode;
  marketplaceAddress: string;
  listingId: string;
  ticketAddress: string;
  tokenId: string;
  seller: string;
  buyer: string;
  askUsdcRaw: string;
  approvalTxHash?: string | null;
  buyTxHash: string;
  explorerUrl: string;
};

export type MarketplaceBuyActionFinishResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  transactionRequest: MarketplaceTransactionRequest;
};

export type MarketplaceBuyVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_OWNER";
  result: MarketplaceBuyExecutionResult;
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
  wallet: WalletTicketsState;
  executionMode: HumanExecutionMode;
};

// A supported network, as the server presents it: a label to render and a
// domain to send back. Deliberately no token or contract address, so a client
// has nothing address-shaped to supply in the first place.
export type GatewayNetwork = {
  key: string;
  label: string;
  domain: number;
  chainId: number;
};

export type GatewayBalanceResponse = {
  token: "USDC";
  depositor: string;
  totalRaw: string;
  totalUsdc: string;
  // Gateway reports every domain it knows about, including ones that cannot be
  // spent through the burn intent path at all. The transferable totals cover
  // only the domains that can.
  transferableTotalRaw: string;
  transferableTotalUsdc: string;
  balances: Array<{
    domain: number;
    depositor: string;
    balance: string;
    balanceRaw: string;
    transferable: boolean;
  }>;
  // Canonical, server-owned network lists. The UI renders exactly these.
  destinations: GatewayNetwork[];
  depositSources: GatewayNetwork[];
  executionMode: HumanExecutionMode;
};

// The user's real USDC position on each funding chain. This is a source WALLET
// balance and is never the Gateway unified balance: a card that fails to read
// reports "error" and no number rather than a misleading zero.
export type GatewaySourceStateResponse = {
  sources: Array<GatewayNetwork & {
    state: "ready" | "error";
    balanceRaw: string | null;
    allowanceRaw: string | null;
  }>;
  executionMode: HumanExecutionMode;
};

export type GatewayTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type GatewayFundingResponse = {
  actionId: string;
  requestId: string;
  executionMode: HumanExecutionMode;
  // The user's choice: where the unified balance is being sent.
  destinationDomain: number;
  destinationLabel: string | null;
  valueRaw: string;
  // The source allocation the SERVER resolved. Reported for transparency and
  // durable proof only: it is never an input, and the UI does not ask for it.
  sourcePlan: Array<{ sourceDomain: number; valueRaw: string }>;
  intentCount: number;
  payloadHash: string | null;
  // Which allocation still needs a signature, or -1 when every one is signed.
  signatureIndex: number;
  // The Circle challenge that signs the allocation named by signatureIndex.
  challengeId: string | null;
  // The exact EIP-712 messages to sign, one per source allocation. An
  // EXTERNAL_WALLET session signs them locally; a CIRCLE_USER_WALLET session
  // signs each through its own hosted challenge.
  typedDataList: GatewayTypedData[];
  state: "PREPARING" | "SIGN_CHALLENGE_CREATING" | "SIGNATURE_PENDING" | "READY_TO_BROADCAST" | "SUBMITTING" | "SUBMITTED" | "COMPLETED" | "FAILED" | "RECONCILIATION_REQUIRED" | "SIGNATURE_FAILED" | "EXPIRED";
  recovery: "NEW" | "EXISTING" | "CONFLICT" | null;
  terminal: boolean;
  pending: boolean;
  readyToBroadcast: boolean;
  submissionEnabled: boolean;
  broadcast: "NOT_SUBMITTED" | "SUBMITTED" | "COMPLETED";
  transferId: string | null;
  transactionHash: string | null;
  lastError: string | null;
  expiresAt: string;
};

export type GatewayFundingCurrentResponse = {
  status: "NONE" | "ACTIVE" | "DUPLICATE";
  action: GatewayFundingResponse | null;
  actions: GatewayFundingResponse[];
};

export type GatewayDepositResponse = {
  actionId: string;
  requestId: string;
  executionMode: HumanExecutionMode;
  sourceDomain: number;
  sourceChainId: number;
  amountRaw: string;
  state: "STARTED" | "BASELINE_READ" | "APPROVAL_REQUIRED" | "APPROVAL_CHALLENGE" | "APPROVAL_PENDING" | "APPROVAL_VERIFIED" | "DEPOSIT_REQUIRED" | "DEPOSIT_CHALLENGE" | "DEPOSIT_PENDING" | "DEPOSIT_VERIFIED" | "RECONCILING" | "COMPLETED" | "FAILED" | "RECONCILIATION_REQUIRED" | "EXPIRED";
  // Authoritative backend recovery classification. The browser must not infer
  // release safety from state strings or sessionStorage contents.
  recoveryDisposition: "CLEAR" | "RESUME" | "RECONCILE";
  approvalTxHash: string | null;
  approvalChallengeId: string | null;
  depositTxHash: string | null;
  depositChallengeId: string | null;
  pending: boolean;
  // Circle only: true once Circle has observed a transaction for the current
  // challenge (even before it has a hash), so the caller never re-executes an
  // already-approved hosted widget while still polling.
  transactionObserved: boolean;
  // Only present for an EXTERNAL_WALLET session: the exact next transaction
  // (approve or deposit) for the connected wallet to sign.
  transactionRequest: TransactionRequest | null;
  lastError: string | null;
  expiresAt: string;
};

export type GatewayDepositActivityStage =
  | "APPROVAL"
  | "DEPOSIT"
  | "FINALITY"
  | "COMPLETED"
  | "REVIEW"
  | "FAILED"
  | "EXPIRED";

export type GatewayDepositActivityPhase =
  | "APPROVAL_PREPARING"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_SUBMITTED"
  | "DEPOSIT_PREPARING"
  | "DEPOSIT_CONFIRMATION_REQUIRED"
  | "DEPOSIT_SUBMITTED"
  | "GATEWAY_FINALITY"
  | "COMPLETED"
  | "NEEDS_REVIEW"
  | "FAILED"
  | "EXPIRED";

export type GatewayDepositActivityItem = {
  actionId: string;
  sourceDomain: number;
  sourceChainId: number;
  sourceLabel: string;
  amountRaw: string;
  state: GatewayDepositResponse["state"];
  recoveryDisposition: "CLEAR" | "RESUME" | "RECONCILE";
  approvalTxHash: string | null;
  depositTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  stage: GatewayDepositActivityStage;
  phase: GatewayDepositActivityPhase;
  actionRequired: boolean;
  interactive: boolean;
  terminal: boolean;
};

export type GatewayDepositActivityResponse = {
  activities: GatewayDepositActivityItem[];
  readState: "ready" | "delayed";
  hasBackgroundActivity: boolean;
};

export type EntryActionPayload = {
  action: "ENTRY";
  chainId: 5042002;
  contract: string;
  roundId: number;
  amountRaw: "1000000";
  predictionPriceCents: number;
  executionMode: HumanExecutionMode;
  destination: string;
  walletAddress: string;
  nonce: string;
  expiresAt: string;
};

// 5042002 (Arc Testnet) for every existing action; 84532 (Base Sepolia) for
// Gateway source approve/deposit transactions.
export type TransactionRequest = {
  chainId: number;
  to: string;
  data: string;
  value: string;
  from: string;
};

export type EntryActionStartResponse = {
  actionId: string;
  action: EntryActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
  executionMode: "EXTERNAL_WALLET";
  authorization: "EXTERNAL_WALLET_SESSION";
  step: "APPROVAL_REQUIRED" | "ENTRY_READY";
  transactionRequest: TransactionRequest;
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
  before?: {
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

export type ExternalEntryApprovalVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_WALLET";
  approvalTxHash: string;
  step: "ENTRY_READY";
  transactionRequest: TransactionRequest;
};

export type ExternalEntryVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_WALLET";
  result: EntryExecutionResult & { executionMode: "EXTERNAL_WALLET" };
};

export type CircleEntryStartResponse = {
  actionId: string;
  payloadHash: string;
  expiresInSeconds: number;
  executionMode: "CIRCLE_USER_WALLET";
  step: "APPROVAL_REQUIRED" | "ENTRY_READY";
  challengeId: string;
};

export type CircleEntryApprovalVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "CIRCLE_USER_WALLET";
  approvalTxHash: string;
  step: "ENTRY_READY";
  challengeId: string;
};

export type CircleEntryVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "CIRCLE_USER_WALLET";
  result: EntryExecutionResult & { executionMode: "CIRCLE_USER_WALLET" };
};

export type TicketTransferActionPayload = {
  action: "TRANSFER_TICKET";
  chainId: 5042002;
  contract: string;
  tokenId: string;
  from: string;
  destination: string;
  walletAddress: string;
  executionMode: "EXTERNAL_WALLET" | "CIRCLE_USER_WALLET";
  nonce: string;
  expiresAt: string;
};

export type TicketTransferActionStartResponse = {
  actionId: string;
  action: TicketTransferActionPayload;
  payloadHash: string;
  expiresInSeconds: number;
} & ExternalActionAuthorization;

export type TicketTransferExecutionResult = {
  chainId: 5042002;
  executionMode?: "EXTERNAL_WALLET" | "CIRCLE_USER_WALLET";
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
  executionMode: "EXTERNAL_WALLET";
  transactionRequest: TransactionRequest;
};

export type TicketTransferVerifyResponse = {
  confirmed: true;
  actionId: string;
  payloadHash: string;
  executionMode: "EXTERNAL_WALLET";
  result: TicketTransferExecutionResult;
};

export type RefundExecutionMode = "EXTERNAL_OWNER" | "CIRCLE_USER_WALLET";

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
} & ExternalActionAuthorization;

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
  accounting?: RefundAccountingProof;
};

export type RefundTransactionRequest = {
  chainId: 5042002;
  to: string;
  data: string;
  value: string;
  from: string;
};

export type RefundActionFinishResponse = {
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


export type ClaimExecutionMode = "EXTERNAL_OWNER" | "CIRCLE_USER_WALLET";

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
} & ExternalActionAuthorization;

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
  accounting?: ClaimAccountingProof;
};

export type ClaimTransactionRequest = {
  chainId: 5042002;
  to: string;
  data: string;
  value: string;
  from: string;
};

export type ClaimActionFinishResponse = {
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

export type TicketTransferStartInput = {
  ticketAddress: string;
  tokenId: string;
  destinationAddress: string;
};

export type TicketRoundStartInput = {
  poolAddress: string;
  ticketAddress: string;
  tokenId: string;
  roundId: number;
};

export type MarketplaceListStartInput = {
  ticketAddress: string;
  tokenId: string;
  askUsdcRaw: string;
};

export type MarketplaceUpdatePriceStartInput = {
  listingId: string;
  newAskUsdcRaw: string;
};

export type MarketplaceCancelStartInput = {
  listingId: string;
};

export type MarketplaceBuyStartInput = {
  listingId: string;
  expectedAskUsdcRaw: string;
};

export type CircleActionPayloadMap = {
  TRANSFER_TICKET: TicketTransferActionPayload;
  REFUND_TICKET: RefundActionPayload;
  CLAIM_REWARD: ClaimActionPayload;
  MARKETPLACE_LIST: MarketplaceListActionPayload;
  MARKETPLACE_UPDATE_PRICE: MarketplaceUpdatePriceActionPayload;
  MARKETPLACE_CANCEL: MarketplaceCancelActionPayload;
  MARKETPLACE_BUY: MarketplaceBuyActionPayload;
};

export type CircleActionResultMap = {
  TRANSFER_TICKET: TicketTransferExecutionResult;
  REFUND_TICKET: RefundExecutionResult;
  CLAIM_REWARD: ClaimExecutionResult;
  MARKETPLACE_LIST: MarketplaceListExecutionResult;
  MARKETPLACE_UPDATE_PRICE: MarketplaceUpdatePriceExecutionResult;
  MARKETPLACE_CANCEL: MarketplaceCancelExecutionResult;
  MARKETPLACE_BUY: MarketplaceBuyExecutionResult;
};

const CIRCLE_ACTION_ROUTES: Record<CircleActionType, string> = {
  TRANSFER_TICKET: "ticket-transfer",
  REFUND_TICKET: "refund",
  CLAIM_REWARD: "claim",
  MARKETPLACE_LIST: "marketplace-list",
  MARKETPLACE_UPDATE_PRICE: "marketplace-update-price",
  MARKETPLACE_CANCEL: "marketplace-cancel",
  MARKETPLACE_BUY: "marketplace-buy",
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
    walletLoginChallenge(ownerAddress: string) {
      return post<{ challengeId: string; message: string; expiresInSeconds: number }>(
        "/auth/wallet-login/challenge",
        { ownerAddress },
      );
    },
    finishWalletLogin(ownerAddress: string, challengeId: string, signature: string) {
      return post<{
        ownerAddress: string;
        walletAddress: string;
        executionMode: "EXTERNAL_WALLET";
      }>("/auth/wallet-login/finish", { ownerAddress, challengeId, signature });
    },
    logout() {
      return post<{ ok: true }>("/auth/logout", {});
    },
  },
  circle: {
    readiness() {
      return request<{
        ok: boolean;
        provider: "circle";
        mode: "USER_CONTROLLED";
        configured: boolean;
        reachable: boolean;
      }>("/circle/readiness");
    },
    socialDeviceToken(deviceId: string, idempotencyKey: string) {
      return post<{ deviceToken: string; deviceEncryptionKey: string }>(
        "/circle/device-token/social", { deviceId, idempotencyKey },
      );
    },
    emailDeviceToken(deviceId: string, email: string, idempotencyKey: string) {
      return post<{ deviceToken: string; deviceEncryptionKey: string; otpToken: string }>(
        "/circle/device-token/email", { deviceId, email, idempotencyKey },
      );
    },
    initializeWallet(userToken: string, idempotencyKey: string) {
      return post<{
        status: "EXISTING" | "CHALLENGE_REQUIRED";
        wallet: { id: string; address: string; blockchain: "ARC-TESTNET"; accountType: "EOA" } | null;
        challengeId: string | null;
      }>("/circle/wallet/initialize", { userToken, idempotencyKey });
    },
    session(
      userToken: string,
      refresh?: { refreshToken: string; deviceId: string },
    ) {
      return post<{
        ownerAddress: string;
        walletAddress: string;
        circleWalletId: string;
        executionMode: "CIRCLE_USER_WALLET";
      }>("/circle/session", { userToken, ...refresh });
    },
    refreshSession(deviceId: string) {
      return post<{
        userToken: string;
        encryptionKey: string;
        ownerAddress: string;
        walletAddress: string;
        circleWalletId: string;
        executionMode: "CIRCLE_USER_WALLET";
      }>("/circle/session/refresh", { deviceId });
    },
    // Both require an authenticated EXTREMA session (the proxy attaches it
    // from the session cookie); the comparison target is always that
    // session's own Arc address, never anything the browser supplies here.
    //
    // A funding source is addressed by its Gateway DOMAIN. The browser never
    // sends a Circle blockchain identifier: the server maps the domain to one.
    sourceWallet(domain: number, userToken: string) {
      return post<{
        wallet: { id: string; address: string; blockchain: string; accountType: "EOA" } | null;
        domain: number;
        arcAddress: string;
      }>(`/circle/wallet/source/${domain}`, { userToken });
    },
    prepareSourceWallet(domain: number, userToken: string, idempotencyKey: string) {
      return post<{
        status: "EXISTING" | "CHALLENGE_REQUIRED";
        wallet: { id: string; address: string; blockchain: string; accountType: "EOA" } | null;
        challengeId: string | null;
        domain: number;
      }>(`/circle/wallet/source/${domain}/prepare`, { userToken, idempotencyKey });
    },
  },
  rounds: {
    list() {
      return request<LiveRoundsResponse>("/rounds");
    },
    get(slug: string) {
      return request<LiveRoundResponse>(`/rounds/${encodeURIComponent(slug)}`);
    },
    // Both reads can take tens of seconds when Arc RPC is slow. Callers pass
    // an abort signal and cancel on unmount, so an abandoned read never keeps
    // one of the browser's few connections to this origin busy and never
    // queues the next page navigation behind it.
    archive(days = 90, init: RequestInit = {}) {
      return request<ArchiveResponse>(`/rounds/archive?days=${days}`, init);
    },
    // Authoritative round result. The Result page types the payload itself.
    result<T>(slug: string, roundId: number, init: RequestInit = {}) {
      return request<T>(`/rounds/${encodeURIComponent(slug)}/${roundId}/result`, init);
    },
    entries(slug: string, roundId: number) {
      return request<RoundEntriesResponse>(
        `/rounds/${encodeURIComponent(slug)}/${roundId}/entries`,
      );
    },
    verification(slug: string, roundId: number) {
      return request<RoundVerificationResponse>(
        `/rounds/${encodeURIComponent(slug)}/${roundId}/verification`,
      );
    },
  },
  marketplace: {
    listings(options?: { forceFresh?: boolean }) {
      const query = options?.forceFresh ? "?fresh=1" : "";
      return request<MarketplaceListingsResponse>(`/marketplace/listings${query}`);
    },
    listing(listingId: string | number) {
      return request<MarketplaceListingResponse>(
        `/marketplace/listings/${encodeURIComponent(String(listingId))}`,
      );
    },
    approval(ticketAddress: string, tokenId: string) {
      return request<MarketplaceApprovalState>(
        `/marketplace/tickets/${encodeURIComponent(ticketAddress)}/${encodeURIComponent(tokenId)}/approval`,
      );
    },
    usdcAllowance(ownerAddress: string) {
      return request<MarketplaceUsdcAllowance>(
        `/marketplace/usdc-allowance/${encodeURIComponent(ownerAddress)}`,
      );
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
    startCircleEntry(input: {
      poolAddress: string;
      roundId: number;
      predictionPriceCents: number;
      circleUserToken: string;
      circleRequestId: string;
    }) {
      return post<CircleEntryStartResponse>("/actions/entry/start", input);
    },
    verifyEntryApproval(actionId: string, txHash: string) {
      return post<ExternalEntryApprovalVerifyResponse>("/actions/entry/approval/verify", {
        actionId,
        txHash,
      });
    },
    verifyEntry(actionId: string, txHash: string) {
      return post<ExternalEntryVerifyResponse>("/actions/entry/verify", { actionId, txHash });
    },
    verifyCircleEntryApproval(actionId: string, circleUserToken: string) {
      return post<CircleEntryApprovalVerifyResponse | { pending: true; actionId: string; transactionObserved: boolean }>(
        "/actions/entry/approval/verify", { actionId, circleUserToken },
      );
    },
    verifyCircleEntry(actionId: string, circleUserToken: string) {
      return post<CircleEntryVerifyResponse | { pending: true; actionId: string; transactionObserved: boolean }>(
        "/actions/entry/verify", { actionId, circleUserToken },
      );
    },

    // Connected wallet: start then finish returns the exact transaction request
    // for the wallet to sign then verify checks the mined receipt.
    startTicketTransfer(input: TicketTransferStartInput) {
      return post<TicketTransferActionStartResponse>("/actions/ticket-transfer/start", input);
    },
    finishTicketTransfer(actionId: string) {
      return post<TicketTransferActionFinishResponse>("/actions/ticket-transfer/finish", { actionId });
    },
    verifyTicketTransfer(actionId: string, txHash: string) {
      return post<TicketTransferVerifyResponse>("/actions/ticket-transfer/verify", { actionId, txHash });
    },
    startRefund(input: TicketRoundStartInput) {
      return post<RefundActionStartResponse>("/actions/refund/start", input);
    },
    finishRefund(actionId: string) {
      return post<RefundActionFinishResponse>("/actions/refund/finish", { actionId });
    },
    verifyRefund(actionId: string, txHash: string) {
      return post<RefundVerifyResponse>("/actions/refund/verify", { actionId, txHash });
    },
    startClaim(input: TicketRoundStartInput) {
      return post<ClaimActionStartResponse>("/actions/claim/start", input);
    },
    finishClaim(actionId: string) {
      return post<ClaimActionFinishResponse>("/actions/claim/finish", { actionId });
    },
    verifyClaim(actionId: string, txHash: string) {
      return post<ClaimVerifyResponse>("/actions/claim/verify", { actionId, txHash });
    },
    startMarketplaceList(input: MarketplaceListStartInput) {
      return post<MarketplaceListActionStartResponse>("/actions/marketplace-list/start", input);
    },
    finishMarketplaceList(actionId: string) {
      return post<MarketplaceListActionFinishResponse>("/actions/marketplace-list/finish", { actionId });
    },
    verifyMarketplaceList(actionId: string, txHash: string) {
      return post<MarketplaceListVerifyResponse>("/actions/marketplace-list/verify", { actionId, txHash });
    },
    startMarketplaceUpdatePrice(input: MarketplaceUpdatePriceStartInput) {
      return post<MarketplaceUpdatePriceActionStartResponse>("/actions/marketplace-update-price/start", input);
    },
    finishMarketplaceUpdatePrice(actionId: string) {
      return post<MarketplaceUpdatePriceActionFinishResponse>("/actions/marketplace-update-price/finish", { actionId });
    },
    verifyMarketplaceUpdatePrice(actionId: string, txHash: string) {
      return post<MarketplaceUpdatePriceVerifyResponse>("/actions/marketplace-update-price/verify", { actionId, txHash });
    },
    startMarketplaceCancel(input: MarketplaceCancelStartInput) {
      return post<MarketplaceCancelActionStartResponse>("/actions/marketplace-cancel/start", input);
    },
    finishMarketplaceCancel(actionId: string) {
      return post<MarketplaceCancelActionFinishResponse>("/actions/marketplace-cancel/finish", { actionId });
    },
    verifyMarketplaceCancel(actionId: string, txHash: string) {
      return post<MarketplaceCancelVerifyResponse>("/actions/marketplace-cancel/verify", { actionId, txHash });
    },
    startMarketplaceBuy(input: MarketplaceBuyStartInput) {
      return post<MarketplaceBuyActionStartResponse>("/actions/marketplace-buy/start", input);
    },
    finishMarketplaceBuy(actionId: string) {
      return post<MarketplaceBuyActionFinishResponse>("/actions/marketplace-buy/finish", { actionId });
    },
    verifyMarketplaceBuy(actionId: string, txHash: string) {
      return post<MarketplaceBuyVerifyResponse>("/actions/marketplace-buy/verify", { actionId, txHash });
    },

    // Circle user controlled wallet: start returns a hosted Circle challenge
    // for the same session wallet; approval/verify and verify reconcile the
    // Circle transaction for that one bound action.
    startCircleTicketTransfer(input: TicketTransferStartInput & CircleStartCredentials) {
      return post<CircleActionStartResponse<TicketTransferActionPayload>>("/actions/ticket-transfer/start", input);
    },
    startCircleRefund(input: TicketRoundStartInput & CircleStartCredentials) {
      return post<CircleActionStartResponse<RefundActionPayload>>("/actions/refund/start", input);
    },
    startCircleClaim(input: TicketRoundStartInput & CircleStartCredentials) {
      return post<CircleActionStartResponse<ClaimActionPayload>>("/actions/claim/start", input);
    },
    startCircleMarketplaceList(input: MarketplaceListStartInput & CircleStartCredentials) {
      return post<CircleActionStartResponse<MarketplaceListActionPayload>>("/actions/marketplace-list/start", input);
    },
    startCircleMarketplaceUpdatePrice(input: MarketplaceUpdatePriceStartInput & CircleStartCredentials) {
      return post<CircleActionStartResponse<MarketplaceUpdatePriceActionPayload>>("/actions/marketplace-update-price/start", input);
    },
    startCircleMarketplaceCancel(input: MarketplaceCancelStartInput & CircleStartCredentials) {
      return post<CircleActionStartResponse<MarketplaceCancelActionPayload>>("/actions/marketplace-cancel/start", input);
    },
    startCircleMarketplaceBuy(input: MarketplaceBuyStartInput & CircleStartCredentials) {
      return post<CircleActionStartResponse<MarketplaceBuyActionPayload>>("/actions/marketplace-buy/start", input);
    },
    verifyCircleActionApproval(actionType: CircleApprovalActionType, actionId: string, circleUserToken: string) {
      return post<CircleActionApprovalVerifyResponse | CircleActionPendingResponse>(
        `/actions/${CIRCLE_ACTION_ROUTES[actionType]}/approval/verify`, { actionId, circleUserToken },
      );
    },
    verifyCircleAction<T extends CircleActionType>(actionType: T, actionId: string, circleUserToken: string) {
      return post<CircleActionVerifyResponse<CircleActionResultMap[T]> | CircleActionPendingResponse>(
        `/actions/${CIRCLE_ACTION_ROUTES[actionType]}/verify`, { actionId, circleUserToken },
      );
    },
  },
  wallet: {
    get() {
      return request<{
        executionMode: HumanExecutionMode;
        wallet: {
          id: string | null;
          address: string;
          createdAt: string | null;
          executionMode: HumanExecutionMode;
        } | null;
      }>("/wallet");
    },
    tickets() {
      return request<OwnedTicketsResponse>("/wallet/tickets");
    },
    gatewayBalance() {
      return request<GatewayBalanceResponse>("/wallet/gateway-balance");
    },
    gatewaySourceState() {
      return request<GatewaySourceStateResponse>("/wallet/gateway-source-state");
    },
    // A transfer names a destination and an amount. There is deliberately no
    // sourceDomain field: the server resolves the source allocation.
    startGatewayFunding(input: {
      requestId: string;
      destinationDomain: number;
      valueRaw: string;
      circleUserToken?: string;
    }) {
      return post<GatewayFundingResponse>("/wallet/gateway-funding/start", input);
    },
    gatewayFunding(actionId: string) {
      return request<GatewayFundingResponse>(`/wallet/gateway-funding/${actionId}`);
    },
    currentGatewayFunding() {
      return request<GatewayFundingCurrentResponse>('/wallet/gateway-funding/current');
    },
    submitGatewayFunding(actionId: string) {
      return post<GatewayFundingResponse>(`/wallet/gateway-funding/${actionId}/submit`, {});
    },
    discardGatewayFunding(actionId: string) {
      return post<GatewayFundingResponse>(`/wallet/gateway-funding/${actionId}/discard`, {});
    },
    verifyGatewayFunding(actionId: string, input: {
      circleUserToken?: string;
      // One signature for the allocation the server named, or the whole set at
      // once (external wallets only, which sign locally with no challenge).
      signature?: string;
      signatures?: string[];
    }) {
      return post<GatewayFundingResponse>(`/wallet/gateway-funding/${actionId}/verify`, input);
    },
    startGatewayDeposit(input: {
      requestId: string;
      sourceDomain: number;
      amountRaw: string;
      circleUserToken?: string;
    }) {
      return post<GatewayDepositResponse>("/wallet/gateway-deposit/start", input);
    },
    gatewayDeposit(actionId: string) {
      return request<GatewayDepositResponse>(`/wallet/gateway-deposit/${actionId}`);
    },
    gatewayDepositActivity() {
      return request<GatewayDepositActivityResponse>("/wallet/gateway-deposit/activity");
    },
    verifyGatewayDepositApproval(actionId: string, input: {
      circleUserToken?: string;
      txHash?: string;
    }) {
      return post<GatewayDepositResponse>(`/wallet/gateway-deposit/${actionId}/verify-approval`, input);
    },
    verifyGatewayDeposit(actionId: string, input: {
      circleUserToken?: string;
      txHash?: string;
    }) {
      return post<GatewayDepositResponse>(`/wallet/gateway-deposit/${actionId}/verify`, input);
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
        nativeUsdcGasInterface: {
          asset: "USDC";
          interface: "native";
          sameUnderlyingAsset: boolean;
          symbol: string;
          decimals: number;
          balanceRaw: string;
          balanceFormatted: string;
        };
        usdc: {
          asset: "USDC";
          interface: "erc20";
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
  },
};
