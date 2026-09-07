"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AssetMark, ProductHeader } from "../product-components";
import { useCopy, useLocale } from "../i18n";
import {
  backendApi,
  isAuthSessionError,
  type MarketplaceApprovalState,
  type MarketplaceListing,
  type OwnedTicket,
  type OwnedTicketsResponse,
  type RefundExecutionMode,
  type ClaimExecutionMode,
} from "../lib/backend-api";
import { formatUsdc, humanRoundStatus, parseUsdcToRaw } from "../lib/display";
import {
  authenticatePasskey,
  confirmClaimWithPasskey,
  confirmExternalClaimReceipt,
  confirmExternalMarketplaceCancelReceipt,
  confirmExternalMarketplaceListReceipt,
  confirmExternalMarketplaceUpdatePriceReceipt,
  confirmExternalRefundReceipt,
  confirmMarketplaceCancelWithPasskey,
  confirmMarketplaceListWithPasskey,
  confirmMarketplaceUpdatePriceWithPasskey,
  confirmRefundWithPasskey,
  confirmTicketTransferWithPasskey,
} from "../lib/passkey-client";
import {
  getOwnerChainId,
  sendOwnerTransaction,
  waitForOwnerTransactionReceipt,
} from "../lib/owner-wallet";
import { encodeApproveCalldata } from "../lib/erc-approve";
import { useAccount } from "wagmi";

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatPrediction(value: string, locale: "en" | "tr") {
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function ticketState(ticket: OwnedTicket, locale: "en" | "tr") {
  if (ticket.isClaimed) return locale === "tr" ? "Ödül alındı" : "Reward claimed";
  if (ticket.isRefunded) return locale === "tr" ? "İade alındı" : "Refunded";
  if (ticket.roundStatus === "SETTLED" && ticket.placement > 0) {
    return (locale === "tr" ? "Kazanan · #" : "Winner · #") + ticket.placement;
  }
  return humanRoundStatus(ticket.roundStatus, locale);
}

function ticketKey(ticket: OwnedTicket) {
  return `${ticket.ticketAddress}:${ticket.tokenId}`;
}

function listingLookupKey(ticketAddress: string, tokenId: string) {
  return `${ticketAddress.toLowerCase()}:${tokenId}`;
}

// Read-only projection of a listing onto its owned ticket. No action is
// offered here yet -- this states what is true onchain, nothing more.
function marketplaceLine(
  listing: MarketplaceListing,
  locale: "en" | "tr",
  t: ReturnType<typeof useCopy>,
) {
  const ask = formatUsdc(listing.askUsdc, locale);

  switch (listing.state) {
    case "ACTIVE":
      return { label: t.marketplacePage.stateActive, detail: `${t.marketplacePage.listedFor} ${ask}` };
    case "ACTION_NEEDED":
      return {
        label: t.marketplacePage.stateActionNeeded,
        detail: `${t.marketplacePage.listedFor} ${ask} · ${
          listing.unbuyableReason === "ownership_changed"
            ? t.marketplacePage.reasonOwnershipChanged
            : t.marketplacePage.reasonApprovalRevoked
        }`,
      };
    case "EXPIRED":
      return { label: t.marketplacePage.stateExpired, detail: `${t.marketplacePage.listedFor} ${ask}` };
    case "CANCELLED":
      return { label: t.marketplacePage.stateCancelled, detail: `${t.marketplacePage.listedFor} ${ask}` };
    case "SOLD":
      return {
        label: t.marketplacePage.stateSold,
        detail: listing.currentOwner
          ? `${t.marketplacePage.soldTo} ${listing.currentOwner.slice(0, 6)}…${listing.currentOwner.slice(-4)}`
          : "",
      };
    case "INVALIDATED":
      return { label: t.marketplacePage.stateInvalidated, detail: "" };
    default:
      return null;
  }
}

function isRefundEligible(ticket: OwnedTicket) {
  return ticket.roundStatus === "CANCELLED" && !ticket.isRefunded;
}

function isClaimEligible(ticket: OwnedTicket) {
  return (
    ticket.roundStatus === "SETTLED" &&
    ticket.placement > 0 &&
    !ticket.isClaimed &&
    BigInt(ticket.claimableRaw) > BigInt(0)
  );
}

// Coarse client-side mirror of the contract's tradable window (entry open or
// locked, before the round settles or is cancelled). The server re-checks
// the exact window on every write, so this only decides whether to offer the
// action at all -- it is never the source of truth.
function isTradeEligible(ticket: OwnedTicket) {
  return ticket.roundStatus === "ENTRY_OPEN" || ticket.roundStatus === "LOCKED";
}

type MarketDrawerMode = "list" | "changePrice" | "cancel";

function marketplaceErrorCopy(cause: unknown, t: ReturnType<typeof useCopy>) {
  const message = cause instanceof Error ? cause.message : "";
  const knownCodes: Record<string, string> = {
    marketplace_price_changed: t.marketplacePage.errorPriceChanged,
    marketplace_insufficient_usdc: t.marketplacePage.errorInsufficientUsdc,
    marketplace_insufficient_gas: t.marketplacePage.errorInsufficientGas,
    marketplace_approval_failed: t.marketplacePage.errorApprovalFailed,
    marketplace_not_ticket_owner: t.marketplacePage.errorNotTicketOwner,
    marketplace_token_not_approved: t.marketplacePage.errorTokenNotApproved,
    marketplace_listing_not_active: t.marketplacePage.errorListingNotActive,
    marketplace_listing_not_buyable: t.marketplacePage.errorListingNotBuyable,
    marketplace_trading_window_closed: t.marketplacePage.errorTradingWindowClosed,
    marketplace_round_not_tradable: t.marketplacePage.errorRoundNotTradable,
    marketplace_already_listed: t.marketplacePage.errorAlreadyListed,
    marketplace_buyer_is_seller: t.marketplacePage.errorBuyerIsSeller,
    marketplace_seller_no_longer_owner: t.marketplacePage.errorSellerNoLongerOwner,
  };

  if (message in knownCodes) return knownCodes[message];
  // A message this file threw itself is already human copy, not a raw
  // backend/contract identifier (those are always lowercase snake_case).
  if (message && !/^[a-z_]+$/.test(message)) return message;
  return t.marketplacePage.errorGeneric;
}

const ARC_TESTNET_CHAIN_ID = 5042002;

export default function TicketsPage() {
  const { locale } = useLocale();
  const t = useCopy();
  const { address: ownerAddress, isConnected } = useAccount();
  const [state, setState] = useState<OwnedTicketsResponse | null>(null);
  const [marketplaceListings, setMarketplaceListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState("");
  const [transferTicketKey, setTransferTicketKey] = useState<string | null>(null);
  const [transferAddress, setTransferAddress] = useState("");
  const [transferBusy, setTransferBusy] = useState("");
  const [transferSuccess, setTransferSuccess] = useState<{
    destinationAddress: string;
    explorerUrl: string;
  } | null>(null);
  const [refundTicketKey, setRefundTicketKey] = useState<string | null>(null);
  const [refundBusy, setRefundBusy] = useState("");
  const [refundStatusText, setRefundStatusText] = useState("");
  const [refundSuccess, setRefundSuccess] = useState<{
    executionMode: RefundExecutionMode;
    explorerUrl: string;
  } | null>(null);

  const [claimTicketKey, setClaimTicketKey] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState("");
  const [claimStatusText, setClaimStatusText] = useState("");
  const [claimSuccess, setClaimSuccess] = useState<{
    executionMode: ClaimExecutionMode;
    explorerUrl: string;
    amountRaw: string;
  } | null>(null);

  const [marketDrawer, setMarketDrawer] = useState<{ ticketKey: string; mode: MarketDrawerMode } | null>(null);
  const [askInput, setAskInput] = useState("");
  const [marketApproval, setMarketApproval] = useState<MarketplaceApprovalState | null>(null);
  const [marketApprovalLoading, setMarketApprovalLoading] = useState(false);
  const [marketApproveBusy, setMarketApproveBusy] = useState(false);
  const [marketBusy, setMarketBusy] = useState("");
  const [marketStatusText, setMarketStatusText] = useState("");
  const [marketSuccess, setMarketSuccess] = useState<{ mode: MarketDrawerMode; explorerUrl: string } | null>(null);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const result = await backendApi.wallet.tickets();
      setState(result);
      setError("");
      setAuthRequired(false);
    } catch (cause) {
      setState(null);
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setAuthRequired(false);
        setError(cause instanceof Error ? cause.message : "Unable to load tickets.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  // Independent of loadTickets: a marketplace read failure must never block
  // or degrade the ticket list itself, so it fails silently into an empty
  // lookup rather than surfacing its own error state on this page.
  // forceFresh bypasses the backend's board cache entirely -- used right
  // after this client's own list, price change, or cancel, so the ticket
  // that was just acted on is guaranteed correct on the very next render
  // regardless of the cache's normal refresh timing.
  const loadMarketplaceListings = useCallback(async (forceFresh = false) => {
    try {
      const result = await backendApi.marketplace.listings({ forceFresh });
      setMarketplaceListings(result.listings);
    } catch {
      setMarketplaceListings([]);
    }
  }, []);

  useEffect(() => {
    void loadMarketplaceListings();
  }, [loadMarketplaceListings]);

  // The most recent listing (highest listingId) per ticket is the only one
  // relevant to display -- an older cancelled listing for the same token is
  // superseded history, not current state.
  const listingByTicket = useMemo(() => {
    const map = new Map<string, MarketplaceListing>();
    for (const listing of marketplaceListings) {
      const key = listingLookupKey(listing.ticketAddress, listing.tokenId);
      const existing = map.get(key);
      if (!existing || Number(listing.listingId) > Number(existing.listingId)) {
        map.set(key, listing);
      }
    }
    return map;
  }, [marketplaceListings]);

  async function handleAuthenticate() {
    if (!ownerAddress) return;

    setAuthBusy("Authenticating with passkey...");
    setError("");
    try {
      await authenticatePasskey(ownerAddress);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Passkey authentication failed.");
      }
    } finally {
      setAuthBusy("");
    }
  }

  function openTransfer(ticket: OwnedTicket) {
    setTransferTicketKey(ticketKey(ticket));
    setTransferAddress(ownerAddress ?? "");
    setTransferSuccess(null);
    setError("");
  }

  function cancelTransfer() {
    setTransferTicketKey(null);
    setTransferAddress("");
    setTransferBusy("");
  }

  async function handleTransfer(ticket: OwnedTicket) {
    const destinationAddress = transferAddress.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
      setError("Enter a valid recipient wallet address.");
      return;
    }

    if (
      state?.backendWallet.wallet.address &&
      destinationAddress.toLowerCase() === state.backendWallet.wallet.address.toLowerCase()
    ) {
      setError("The recipient already owns this NFT.");
      return;
    }

    const key = ticketKey(ticket);
    setTransferBusy(key);
    setError("");

    try {
      const result = await confirmTicketTransferWithPasskey({
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        destinationAddress,
      });

      setTransferSuccess({
        destinationAddress: result.destinationAddress,
        explorerUrl: result.explorerUrl,
      });
      setTransferTicketKey(null);
      setTransferAddress("");
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "NFT transfer failed.");
      }
    } finally {
      setTransferBusy("");
    }
  }

  function openRefund(ticket: OwnedTicket) {
    setRefundTicketKey(ticketKey(ticket));
    setRefundSuccess(null);
    setError("");
  }

  function cancelRefund() {
    setRefundTicketKey(null);
    setRefundBusy("");
    setRefundStatusText("");
  }

  async function handleRefund(ticket: OwnedTicket) {
    const key = ticketKey(ticket);
    setRefundBusy(key);
    setError("");
    setRefundStatusText("Confirming with passkey...");

    try {
      const outcome = await confirmRefundWithPasskey({
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        roundId: ticket.roundId,
      });

      if (outcome.executionMode === "BACKEND_WALLET") {
        setRefundSuccess({
          executionMode: "BACKEND_WALLET",
          explorerUrl: outcome.result.explorerUrl,
        });
      } else {
        if (
          !isConnected ||
          !ownerAddress ||
          ownerAddress.toLowerCase() !== outcome.currentOwner.toLowerCase()
        ) {
          throw new Error(
            `Connect wallet ${outcome.currentOwner} in your browser wallet to complete this refund.`,
          );
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error("Switch your connected wallet to Arc Testnet (chain 5042002).");
        }

        setRefundStatusText("Waiting for wallet transaction...");
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setRefundStatusText("Waiting for transaction confirmation...");
        await waitForOwnerTransactionReceipt(txHash);

        setRefundStatusText("Verifying refund receipt...");
        const result = await confirmExternalRefundReceipt(outcome.actionId, txHash);

        setRefundSuccess({
          executionMode: "EXTERNAL_OWNER",
          explorerUrl: result.explorerUrl,
        });
      }

      setRefundTicketKey(null);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Refund failed.");
      }
    } finally {
      setRefundBusy("");
      setRefundStatusText("");
    }
  }


  function openClaim(ticket: OwnedTicket) {
    setClaimTicketKey(ticketKey(ticket));
    setClaimSuccess(null);
    setError("");
  }

  function cancelClaim() {
    setClaimTicketKey(null);
    setClaimBusy("");
    setClaimStatusText("");
  }

  async function handleClaim(ticket: OwnedTicket) {
    const key = ticketKey(ticket);
    setClaimBusy(key);
    setError("");
    setClaimStatusText("Confirming with passkey...");

    try {
      const outcome = await confirmClaimWithPasskey({
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        roundId: ticket.roundId,
      });

      if (outcome.executionMode === "BACKEND_WALLET") {
        setClaimSuccess({
          executionMode: "BACKEND_WALLET",
          explorerUrl: outcome.result.explorerUrl,
          amountRaw: outcome.result.amountRaw,
        });
      } else {
        if (
          !isConnected ||
          !ownerAddress ||
          ownerAddress.toLowerCase() !== outcome.currentOwner.toLowerCase()
        ) {
          throw new Error(
            `Connect wallet ${outcome.currentOwner} in your browser wallet to complete this reward claim.`,
          );
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error("Switch your connected wallet to Arc Testnet (chain 5042002).");
        }

        setClaimStatusText("Waiting for wallet transaction...");
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setClaimStatusText("Waiting for transaction confirmation...");
        await waitForOwnerTransactionReceipt(txHash);

        setClaimStatusText("Verifying reward receipt...");
        const result = await confirmExternalClaimReceipt(outcome.actionId, txHash);

        setClaimSuccess({
          executionMode: "EXTERNAL_OWNER",
          explorerUrl: result.explorerUrl,
          amountRaw: result.amountRaw,
        });
      }

      setClaimTicketKey(null);
      await loadTickets();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(cause instanceof Error ? cause.message : "Reward claim failed.");
      }
    } finally {
      setClaimBusy("");
      setClaimStatusText("");
    }
  }

  function closeMarketDrawer() {
    setMarketDrawer(null);
    setAskInput("");
    setMarketApproval(null);
    setMarketApproveBusy(false);
    setMarketBusy("");
    setMarketStatusText("");
  }

  async function openMarketDrawer(ticket: OwnedTicket, mode: MarketDrawerMode, isBackendWallet: boolean, existingAskUsdc?: string) {
    const key = ticketKey(ticket);
    setMarketDrawer({ ticketKey: key, mode });
    setAskInput(mode === "changePrice" && existingAskUsdc ? existingAskUsdc : "");
    setMarketSuccess(null);
    setMarketApproval(null);
    setError("");

    if (!isBackendWallet && mode !== "cancel") {
      setMarketApprovalLoading(true);
      try {
        const approval = await backendApi.marketplace.approval(ticket.ticketAddress, ticket.tokenId);
        setMarketApproval(approval);
      } catch {
        setMarketApproval(null);
      } finally {
        setMarketApprovalLoading(false);
      }
    }
  }

  async function handleApproveTicket(ticket: OwnedTicket) {
    if (!isConnected || !ownerAddress) {
      setError(t.marketplacePage.connectOwnerWalletFirst);
      return;
    }

    setMarketApproveBusy(true);
    setError("");

    try {
      const chainIdHex = await getOwnerChainId();
      if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
        throw new Error(t.marketplacePage.switchToArcTestnet);
      }

      const approval = marketApproval ?? (await backendApi.marketplace.approval(ticket.ticketAddress, ticket.tokenId));
      const data = encodeApproveCalldata(approval.marketplaceAddress, ticket.tokenId);
      const txHash = await sendOwnerTransaction({
        to: ticket.ticketAddress,
        data,
        value: "0x0",
        from: ownerAddress,
      });
      await waitForOwnerTransactionReceipt(txHash);

      const refreshed = await backendApi.marketplace.approval(ticket.ticketAddress, ticket.tokenId);
      setMarketApproval(refreshed);
    } catch (cause) {
      setError(marketplaceErrorCopy(cause, t));
    } finally {
      setMarketApproveBusy(false);
    }
  }

  async function handleListOrRelist(ticket: OwnedTicket) {
    const key = ticketKey(ticket);
    const askUsdcRaw = parseUsdcToRaw(askInput);
    if (!askUsdcRaw) {
      setError(t.marketplacePage.askPriceInvalid);
      return;
    }

    setMarketBusy(key);
    setError("");
    setMarketStatusText(t.marketplacePage.confirmingWithPasskey);

    try {
      const outcome = await confirmMarketplaceListWithPasskey({
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
        askUsdcRaw,
      });

      let explorerUrl: string;
      if (outcome.executionMode === "BACKEND_WALLET") {
        explorerUrl = outcome.result.explorerUrl;
      } else {
        if (!isConnected || !ownerAddress || ownerAddress.toLowerCase() !== outcome.sellerAddress.toLowerCase()) {
          throw new Error(t.marketplacePage.connectMatchingWallet);
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error(t.marketplacePage.switchToArcTestnet);
        }

        setMarketStatusText(t.marketplacePage.waitingForWalletTransaction);
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setMarketStatusText(t.marketplacePage.waitingForConfirmation);
        await waitForOwnerTransactionReceipt(txHash);

        setMarketStatusText(t.marketplacePage.verifyingListing);
        const result = await confirmExternalMarketplaceListReceipt(outcome.actionId, txHash);
        explorerUrl = result.explorerUrl;
      }

      setMarketSuccess({ mode: "list", explorerUrl });
      closeMarketDrawer();
      await Promise.all([loadTickets(), loadMarketplaceListings(true)]);
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(marketplaceErrorCopy(cause, t));
      }
    } finally {
      setMarketBusy("");
      setMarketStatusText("");
    }
  }

  async function handleChangePrice(ticket: OwnedTicket, listingId: string) {
    const key = ticketKey(ticket);
    const newAskUsdcRaw = parseUsdcToRaw(askInput);
    if (!newAskUsdcRaw) {
      setError(t.marketplacePage.askPriceInvalid);
      return;
    }

    setMarketBusy(key);
    setError("");
    setMarketStatusText(t.marketplacePage.confirmingWithPasskey);

    try {
      const outcome = await confirmMarketplaceUpdatePriceWithPasskey({ listingId, newAskUsdcRaw });

      let explorerUrl: string;
      if (outcome.executionMode === "BACKEND_WALLET") {
        explorerUrl = outcome.result.explorerUrl;
      } else {
        if (!isConnected || !ownerAddress || ownerAddress.toLowerCase() !== outcome.sellerAddress.toLowerCase()) {
          throw new Error(t.marketplacePage.connectMatchingWallet);
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error(t.marketplacePage.switchToArcTestnet);
        }

        setMarketStatusText(t.marketplacePage.waitingForWalletTransaction);
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setMarketStatusText(t.marketplacePage.waitingForConfirmation);
        await waitForOwnerTransactionReceipt(txHash);

        setMarketStatusText(t.marketplacePage.verifyingPriceChange);
        const result = await confirmExternalMarketplaceUpdatePriceReceipt(outcome.actionId, txHash);
        explorerUrl = result.explorerUrl;
      }

      setMarketSuccess({ mode: "changePrice", explorerUrl });
      closeMarketDrawer();
      await Promise.all([loadTickets(), loadMarketplaceListings(true)]);
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(marketplaceErrorCopy(cause, t));
      }
    } finally {
      setMarketBusy("");
      setMarketStatusText("");
    }
  }

  async function handleCancelListing(ticket: OwnedTicket, listingId: string) {
    const key = ticketKey(ticket);
    setMarketBusy(key);
    setError("");
    setMarketStatusText(t.marketplacePage.confirmingWithPasskey);

    try {
      const outcome = await confirmMarketplaceCancelWithPasskey({ listingId });

      let explorerUrl: string;
      if (outcome.executionMode === "BACKEND_WALLET") {
        explorerUrl = outcome.result.explorerUrl;
      } else {
        if (!isConnected || !ownerAddress || ownerAddress.toLowerCase() !== outcome.sellerAddress.toLowerCase()) {
          throw new Error(t.marketplacePage.connectMatchingWallet);
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error(t.marketplacePage.switchToArcTestnet);
        }

        setMarketStatusText(t.marketplacePage.waitingForWalletTransaction);
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setMarketStatusText(t.marketplacePage.waitingForConfirmation);
        await waitForOwnerTransactionReceipt(txHash);

        setMarketStatusText(t.marketplacePage.verifyingCancellation);
        const result = await confirmExternalMarketplaceCancelReceipt(outcome.actionId, txHash);
        explorerUrl = result.explorerUrl;
      }

      setMarketSuccess({ mode: "cancel", explorerUrl });
      closeMarketDrawer();
      await Promise.all([loadTickets(), loadMarketplaceListings(true)]);
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setAuthRequired(true);
        setError("");
      } else {
        setError(marketplaceErrorCopy(cause, t));
      }
    } finally {
      setMarketBusy("");
      setMarketStatusText("");
    }
  }

  function renderTicketCard(ticket: OwnedTicket, options: { showTransfer: boolean; isBackendWallet: boolean }) {
    const key = ticketKey(ticket);
    const transferOpen = transferTicketKey === key;
    const refundOpen = refundTicketKey === key;
    const refundEligible = isRefundEligible(ticket);
    const claimOpen = claimTicketKey === key;
    const claimEligible = isClaimEligible(ticket);
    const listing = listingByTicket.get(listingLookupKey(ticket.ticketAddress, ticket.tokenId));
    const listingLine = listing ? marketplaceLine(listing, locale, t) : null;
    const marketOpen = marketDrawer?.ticketKey === key ? marketDrawer.mode : null;
    const isListed = Boolean(listing) && (listing?.state === "ACTIVE" || listing?.state === "ACTION_NEEDED");
    const canList = isTradeEligible(ticket) && !isListed;
    const hasPriorListing = Boolean(listing);
    const marketApproved = options.isBackendWallet || Boolean(marketApproval?.isApproved);
    const anyOtherBusy = Boolean(transferBusy) || Boolean(refundBusy) || Boolean(claimBusy) || Boolean(marketBusy);

    return (
      <article className="ex-ticket" key={key} data-direction={ticket.direction}>
        <header className="ex-ticket__head">
          <div className="ex-ticket__identity">
            <AssetMark asset={ticket.asset} />
            <div>
              <h3>{ticket.asset} · {titleCase(ticket.cadence)} {titleCase(ticket.direction)}</h3>
              <p className="ex-num">Ticket #{ticket.tokenId} · Round #{ticket.roundId} · Entry #{ticket.entrySequence}</p>
            </div>
          </div>
          <span className="ex-ticket__status">{ticketState(ticket, locale)}</span>
        </header>

        <div className="ex-ticket__body">
          <div className="ex-ticket__prediction">
            <span>{locale === "tr" ? "TAHMİN" : "PREDICTION"}</span>
            <strong className="ex-num">{formatPrediction(ticket.predictionPrice, locale)}</strong>
            <small>1 USDC {locale === "tr" ? "katılım" : "entry"}</small>
          </div>

          <dl className="ex-ticket__meta">
            <div><dt>{locale === "tr" ? "DURUM" : "STATE"}</dt><dd>{ticketState(ticket, locale)}</dd></div>
            <div><dt>{locale === "tr" ? "SAHİP" : "OWNER"}</dt><dd className="ex-num">{ticket.owner.slice(0, 6)}…{ticket.owner.slice(-4)}</dd></div>
            <div>
              <dt>{locale === "tr" ? "HAK" : "CLAIM RIGHT"}</dt>
              <dd className="ex-num">
                {Number(ticket.claimableUsdc) > 0 && !ticket.isClaimed
                  ? ticket.claimableUsdc + " USDC"
                  : refundEligible
                    ? "1 USDC"
                    : "—"}
              </dd>
            </div>
          </dl>
        </div>

        {listing && listingLine && (
          <div className="ex-ticket__market" data-state={listing.state}>
            <span className="ex-ticket__market-eyebrow">{t.marketplacePage.ticketListingEyebrow}</span>
            <span className="ex-ticket__market-label">{listingLine.label}</span>
            {listingLine.detail && <span className="ex-ticket__market-detail">{listingLine.detail}</span>}
          </div>
        )}

        <div className="ex-ticket__actions">
          <Link href={"/results/" + ticket.slug + "/" + ticket.roundId}>{locale === "tr" ? "Turu aç" : "View round"} →</Link>
          <a href={ticket.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "NFT'yi doğrula" : "Verify NFT"} →</a>
          {options.showTransfer && (
            <button type="button" onClick={() => openTransfer(ticket)} disabled={Boolean(transferBusy) || Boolean(refundBusy) || Boolean(claimBusy)}>
              {locale === "tr" ? "NFT'yi aktar" : "Transfer NFT"} →
            </button>
          )}
          {refundEligible && (
            <button type="button" onClick={() => openRefund(ticket)} disabled={Boolean(transferBusy) || Boolean(refundBusy)}>
              {locale === "tr" ? "İadeyi al" : "Claim refund"} →
            </button>
          )}
          {claimEligible && (
            <button type="button" onClick={() => openClaim(ticket)} disabled={Boolean(transferBusy) || Boolean(refundBusy) || Boolean(claimBusy)}>
              {locale === "tr" ? "Ödülü al" : "Claim reward"} →
            </button>
          )}
          {canList && (
            <button type="button" onClick={() => void openMarketDrawer(ticket, "list", options.isBackendWallet)} disabled={anyOtherBusy}>
              {hasPriorListing ? t.marketplacePage.relistAction : t.marketplacePage.listAction} →
            </button>
          )}
          {isListed && listing && (
            <button
              type="button"
              onClick={() => void openMarketDrawer(ticket, "changePrice", options.isBackendWallet, listing.askUsdc)}
              disabled={anyOtherBusy}
            >
              {t.marketplacePage.changePriceAction} →
            </button>
          )}
          {isListed && (
            <button type="button" onClick={() => void openMarketDrawer(ticket, "cancel", options.isBackendWallet)} disabled={anyOtherBusy}>
              {t.marketplacePage.cancelListingAction} →
            </button>
          )}
        </div>

        {transferOpen && (
          <div className="ex-ticket__drawer">
            <p className="ex-eyebrow">{locale === "tr" ? "NFT AKTARIMI" : "NFT TRANSFER"}</p>
            <label className="ex-ticket__field">
              {locale === "tr" ? "Alıcı cüzdan adresi" : "Recipient wallet address"}
              <input value={transferAddress} onChange={(event) => setTransferAddress(event.target.value)} placeholder="0x..." autoComplete="off" spellCheck={false} />
            </label>
            <p>{locale === "tr" ? "NFT aktarımı gelecekteki ödül veya iade hakkını da yeni sahibine geçirir." : "Transferring this NFT also transfers any future claim or refund right."}</p>
            <div className="ex-ticket__drawer-actions">
              <button type="button" onClick={() => void handleTransfer(ticket)} disabled={Boolean(transferBusy)}>
                {transferBusy === key ? "Confirming transfer..." : locale === "tr" ? "Aktarımı onayla" : "Confirm transfer"}
              </button>
              <button type="button" onClick={cancelTransfer} disabled={Boolean(transferBusy)}>{locale === "tr" ? "Vazgeç" : "Cancel"}</button>
            </div>
          </div>
        )}

        {claimOpen && (
          <div className="ex-ticket__drawer">
            <p className="ex-eyebrow">{locale === "tr" ? "ÖDÜL TALEBİ" : "REWARD CLAIM"}</p>
            <p>
              {locale === "tr" ? "Bu bilet kazanan NFT'dir. Güncel sahibi " : "This ticket is a winning NFT. The current owner "}
              (<code>{ticket.owner}</code>)
              {locale === "tr" ? " " + ticket.claimableUsdc + " USDC ödülü bir kez alabilir." : " can claim " + ticket.claimableUsdc + " USDC once."}
            </p>
            <div className="ex-ticket__drawer-actions">
              <button type="button" onClick={() => void handleClaim(ticket)} disabled={Boolean(claimBusy)}>
                {claimBusy === key ? claimStatusText || "Confirming reward..." : locale === "tr" ? "Ödülü onayla" : "Confirm reward"}
              </button>
              <button type="button" onClick={cancelClaim} disabled={Boolean(claimBusy)}>{locale === "tr" ? "Vazgeç" : "Cancel"}</button>
            </div>
          </div>
        )}

        {refundOpen && (
          <div className="ex-ticket__drawer">
            <p className="ex-eyebrow">{locale === "tr" ? "İADE" : "REFUND"}</p>
            <p>
              {locale === "tr" ? "Bu tur iptal edildi. Güncel NFT sahibi " : "This round was cancelled. The current NFT owner "}
              (<code>{ticket.owner}</code>)
              {locale === "tr" ? " 1 USDC iadeyi bir kez alabilir." : " can claim a 1 USDC refund once."}
            </p>
            <div className="ex-ticket__drawer-actions">
              <button type="button" onClick={() => void handleRefund(ticket)} disabled={Boolean(refundBusy)}>
                {refundBusy === key ? refundStatusText || "Confirming refund..." : locale === "tr" ? "İadeyi onayla" : "Confirm refund"}
              </button>
              <button type="button" onClick={cancelRefund} disabled={Boolean(refundBusy)}>{locale === "tr" ? "Vazgeç" : "Cancel"}</button>
            </div>
          </div>
        )}

        {marketOpen && (
          <div className="ex-ticket__drawer">
            <p className="ex-eyebrow">
              {marketOpen === "list"
                ? hasPriorListing
                  ? t.marketplacePage.relistDrawerEyebrow
                  : t.marketplacePage.listDrawerEyebrow
                : marketOpen === "changePrice"
                  ? t.marketplacePage.changePriceDrawerEyebrow
                  : t.marketplacePage.cancelDrawerEyebrow}
            </p>

            {marketOpen === "cancel" ? (
              <p>{t.marketplacePage.cancelListingBody}</p>
            ) : (
              <>
                <p>
                  {options.isBackendWallet
                    ? marketOpen === "list"
                      ? t.marketplacePage.listBodyBackend
                      : t.marketplacePage.changePriceBodyBackend
                    : marketApprovalLoading
                      ? t.marketplacePage.approvingTicket
                      : marketApproved
                        ? marketOpen === "list"
                          ? t.marketplacePage.listBodyOwnerApproved
                          : t.marketplacePage.changePriceBodyOwnerApproved
                        : marketOpen === "list"
                          ? t.marketplacePage.listBodyOwnerNeedsApproval
                          : t.marketplacePage.changePriceBodyOwnerNeedsApproval}
                </p>
                <label className="ex-ticket__field">
                  {t.marketplacePage.askPriceLabel}
                  <input
                    value={askInput}
                    onChange={(event) => setAskInput(event.target.value)}
                    placeholder="1.50"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              </>
            )}

            <div className="ex-ticket__drawer-actions">
              {marketOpen === "cancel" ? (
                <button
                  type="button"
                  onClick={() => listing && void handleCancelListing(ticket, listing.listingId)}
                  disabled={Boolean(marketBusy)}
                >
                  {marketBusy === key ? marketStatusText || t.marketplacePage.confirmingWithPasskey : t.marketplacePage.confirmCancelListing}
                </button>
              ) : !marketApproved ? (
                <button type="button" onClick={() => void handleApproveTicket(ticket)} disabled={marketApproveBusy || marketApprovalLoading}>
                  {marketApproveBusy ? t.marketplacePage.approvingTicket : t.marketplacePage.approveTicketAction}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void (marketOpen === "list"
                      ? handleListOrRelist(ticket)
                      : listing && handleChangePrice(ticket, listing.listingId))
                  }
                  disabled={Boolean(marketBusy)}
                >
                  {marketBusy === key
                    ? marketStatusText || t.marketplacePage.confirmingWithPasskey
                    : marketOpen === "list"
                      ? hasPriorListing
                        ? t.marketplacePage.confirmRelist
                        : t.marketplacePage.confirmListing
                      : t.marketplacePage.confirmPriceChange}
                </button>
              )}
              <button type="button" onClick={closeMarketDrawer} disabled={Boolean(marketBusy) || marketApproveBusy}>
                {t.marketplacePage.cancel}
              </button>
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <main className="ex-tickets">
      <ProductHeader />
      <div className="ex-shell">
        <section className="ex-tickets__head">
          <div>
            <p className="ex-eyebrow">{locale === "tr" ? "SAHİPLİK" : "OWNERSHIP"}</p>
            <h1 className="ex-display ex-display--lg">{locale === "tr" ? "NFT biletlerin." : "Your NFT tickets."}</h1>
            <p className="ex-lede">
              {locale === "tr"
                ? "Tahmin, ödül ve iade hakkı bileti takip eder. Burada yalnızca şu anda sahip olduğun gerçek Arc Testnet biletleri görünür."
                : "Prediction, reward, and refund rights follow the ticket. Only NFTs you currently own on Arc Testnet appear here."}
            </p>
          </div>

          <dl className="ex-tickets__summary">
            <div><dt>{locale === "tr" ? "EXTREMA CÜZDANI" : "EXTREMA WALLET"}</dt><dd className="ex-num">{state?.backendWallet.ticketCount ?? "—"}</dd></div>
            <div><dt>{locale === "tr" ? "BAĞLI CÜZDAN" : "CONNECTED WALLET"}</dt><dd className="ex-num">{state?.ownerWallet?.ticketCount ?? 0}</dd></div>
            <div><dt>Arc Testnet</dt><dd className="ex-num">{state?.backendWallet.chain.blockNumber ?? "—"}</dd></div>
          </dl>
        </section>

        {transferSuccess && (
          <section className="ex-ticket-notice">
            <div><p className="ex-eyebrow">{locale === "tr" ? "AKTARIM TAMAMLANDI" : "TRANSFER COMPLETE"}</p><h2 className="ex-display ex-display--md">{locale === "tr" ? "NFT aktarıldı." : "NFT transferred."}</h2></div>
            <p>{locale === "tr" ? "Bilet ve gelecekteki hakları artık " : "The ticket and its future rights now belong to "}<code>{transferSuccess.destinationAddress}</code>.</p>
            <a href={transferSuccess.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →</a>
          </section>
        )}

        {claimSuccess && (
          <section className="ex-ticket-notice">
            <div>
              <p className="ex-eyebrow">{locale === "tr" ? "ÖDÜL ALINDI" : "REWARD CLAIMED"}</p>
              <h2 className="ex-display ex-display--md">
                {(Number(claimSuccess.amountRaw) / 1_000_000).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", { maximumFractionDigits: 6 })} USDC
              </h2>
            </div>
            <p>{locale === "tr" ? "Ödül biletin güncel sahibine gönderildi." : "The reward was sent to the ticket's current owner."}</p>
            <a href={claimSuccess.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →</a>
          </section>
        )}

        {refundSuccess && (
          <section className="ex-ticket-notice">
            <div><p className="ex-eyebrow">{locale === "tr" ? "İADE ALINDI" : "REFUND CLAIMED"}</p><h2 className="ex-display ex-display--md">1 USDC</h2></div>
            <p>{locale === "tr" ? "İade biletin güncel sahibine gönderildi." : "The refund was sent to the ticket's current owner."}</p>
            <a href={refundSuccess.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →</a>
          </section>
        )}

        {marketSuccess && (
          <section className="ex-ticket-notice">
            <div>
              <p className="ex-eyebrow">
                {marketSuccess.mode === "list"
                  ? t.marketplacePage.listSuccessEyebrow
                  : marketSuccess.mode === "changePrice"
                    ? t.marketplacePage.priceChangeSuccessEyebrow
                    : t.marketplacePage.cancelSuccessEyebrow}
              </p>
              <h2 className="ex-display ex-display--md">
                {marketSuccess.mode === "list"
                  ? t.marketplacePage.listSuccessTitle
                  : marketSuccess.mode === "changePrice"
                    ? t.marketplacePage.priceChangeSuccessTitle
                    : t.marketplacePage.cancelSuccessTitle}
              </h2>
            </div>
            <p>
              {marketSuccess.mode === "list"
                ? t.marketplacePage.listSuccessBody
                : marketSuccess.mode === "changePrice"
                  ? t.marketplacePage.priceChangeSuccessBody
                  : t.marketplacePage.cancelSuccessBody}
            </p>
            <a href={marketSuccess.explorerUrl} target="_blank" rel="noreferrer">{locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →</a>
          </section>
        )}

        {loading && (
          <section className="ex-tickets__state">
            <p className="ex-eyebrow">{locale === "tr" ? "ZİNCİR OKUNUYOR" : "READING CHAIN"}</p>
            <p>{locale === "tr" ? "Biletlerin yükleniyor…" : "Loading your onchain tickets…"}</p>
          </section>
        )}

        {!loading && authRequired && (
          <section className="ex-tickets__state">
            <div>
              <p className="ex-eyebrow">{locale === "tr" ? "OTURUM" : "SESSION"}</p>
              <h2 className="ex-display ex-display--md">{locale === "tr" ? "Oturum süresi doldu." : "Session expired."}</h2>
              <p>{locale === "tr" ? "Zincir üstü biletlerini yüklemek için passkey ile doğrula." : "Authenticate with your passkey to load your onchain tickets."}</p>
            </div>
            {isConnected && ownerAddress ? (
              <button className="ex-btn ex-btn--ink" type="button" onClick={handleAuthenticate} disabled={Boolean(authBusy)}>
                {authBusy || (locale === "tr" ? "Passkey ile doğrula" : "Authenticate with passkey")}
              </button>
            ) : (
              <Link className="ex-btn ex-btn--ghost" href="/wallet">{locale === "tr" ? "Sahip cüzdanını bağla" : "Connect owner wallet"}</Link>
            )}
          </section>
        )}

        {!loading && !authRequired && error && (
          <section className="ex-tickets__state" data-tone="error">
            <div><p className="ex-eyebrow">{locale === "tr" ? "İŞLEM KULLANILAMIYOR" : "ACTION UNAVAILABLE"}</p><p>{error}</p></div>
            {state === null && <button className="ex-btn ex-btn--ghost" type="button" onClick={() => void loadTickets()}>{locale === "tr" ? "Tekrar dene" : "Try again"}</button>}
          </section>
        )}

        {!loading && state && state.backendWallet.ticketCount === 0 && (!state.ownerWallet || state.ownerWallet.ticketCount === 0) && (
          <section className="ex-tickets__empty">
            <p className="ex-eyebrow">{locale === "tr" ? "BİLET YOK" : "NO TICKETS"}</p>
            <h2 className="ex-display ex-display--md">{locale === "tr" ? "Henüz sahip olduğun bir tahmin bileti yok." : "No prediction tickets yet."}</h2>
            <p>{locale === "tr" ? "Bir havuza katıldığında NFT bilet burada görünür." : "Your NFT appears here after you enter a pool."}</p>
            <Link href="/pools">{locale === "tr" ? "Havuzlara git" : "Browse pools"} →</Link>
          </section>
        )}

        {!loading && state && state.backendWallet.ticketCount > 0 && (
          <section className="ex-ticket-group">
            <header className="ex-ticket-group__head">
              <div><p className="ex-eyebrow">{locale === "tr" ? "YÖNETİLEN CÜZDAN" : "MANAGED WALLET"}</p><h2 className="ex-display ex-display--md">{state.backendWallet.ticketCount} {locale === "tr" ? "zincir üstü bilet" : state.backendWallet.ticketCount === 1 ? "onchain ticket" : "onchain tickets"}</h2></div>
              <p className="ex-num">Arc Testnet · {state.backendWallet.chain.blockNumber}</p>
            </header>
            <div className="ex-ticket-list">{state.backendWallet.tickets.map((ticket) => renderTicketCard(ticket, { showTransfer: true, isBackendWallet: true }))}</div>
          </section>
        )}

        {!loading && state?.ownerWallet && state.ownerWallet.ticketCount > 0 && (
          <section className="ex-ticket-group">
            <header className="ex-ticket-group__head">
              <div><p className="ex-eyebrow">{locale === "tr" ? "BAĞLI CÜZDAN" : "CONNECTED WALLET"}</p><h2 className="ex-display ex-display--md">{locale === "tr" ? "Doğrudan sahip olduğun biletler." : "Tickets held directly."}</h2></div>
              <p className="ex-num">{state.ownerWallet.wallet.address}</p>
            </header>
            <p className="ex-ticket-group__note">{locale === "tr" ? "Bu biletler EXTREMA yönetimli cüzdanında değil, bağlı cüzdanında tutulur. Ödül ve iade işlemleri bağlı cüzdandan gönderilir." : "These NFTs are held by your connected wallet, not the EXTREMA-managed wallet. Reward claims and refunds are sent from the connected wallet."}</p>
            <div className="ex-ticket-list">{state.ownerWallet.tickets.map((ticket) => renderTicketCard(ticket, { showTransfer: false, isBackendWallet: false }))}</div>
          </section>
        )}
      </div>
    </main>
  );
}
