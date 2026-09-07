"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import {
  backendApi,
  isAuthSessionError,
  type MarketplaceExecutionMode,
  type MarketplaceListing,
  type MarketplaceUsdcAllowance,
} from "../lib/backend-api";
import { assetConfigs } from "../lib/asset-config";
import type { Asset } from "../lib/domain";
import { useCopy, useLocale } from "../i18n";
import { formatUsdc } from "../lib/display";
import { useWalletSession } from "../wallet-session";
import {
  confirmExternalMarketplaceBuyReceipt,
  confirmMarketplaceBuyWithPasskey,
} from "../lib/passkey-client";
import {
  getOwnerChainId,
  sendOwnerTransaction,
  waitForOwnerTransactionReceipt,
} from "../lib/owner-wallet";
import { encodeApproveCalldata } from "../lib/erc-approve";

const ARC_TESTNET_CHAIN_ID = 5042002;

const ASSET_ORDER: Asset[] = ["BTC", "ETH", "SOL", "HYPE"];
const assetFilters: ("All" | Asset)[] = ["All", "BTC", "ETH", "SOL", "HYPE"];
const cadenceFilters: ("All" | "Daily" | "Weekly" | "Quarterly")[] = ["All", "Daily", "Weekly", "Quarterly"];

type Copy = ReturnType<typeof useCopy>;
type Locale = "en" | "tr";

function marketplaceErrorCopy(cause: unknown, t: Copy) {
  const message = cause instanceof Error ? cause.message : "";
  const knownCodes: Record<string, string> = {
    marketplace_price_changed: t.marketplacePage.errorPriceChanged,
    marketplace_insufficient_usdc: t.marketplacePage.errorInsufficientUsdc,
    marketplace_insufficient_gas: t.marketplacePage.errorInsufficientGas,
    marketplace_approval_failed: t.marketplacePage.errorApprovalFailed,
    marketplace_listing_not_active: t.marketplacePage.errorListingNotActive,
    marketplace_listing_not_buyable: t.marketplacePage.errorListingNotBuyable,
    marketplace_trading_window_closed: t.marketplacePage.errorTradingWindowClosed,
    marketplace_round_not_tradable: t.marketplacePage.errorRoundNotTradable,
    marketplace_buyer_is_seller: t.marketplacePage.errorBuyerIsSeller,
    marketplace_seller_no_longer_owner: t.marketplacePage.errorSellerNoLongerOwner,
  };

  if (message in knownCodes) return knownCodes[message];
  if (message && !/^[a-z_]+$/.test(message)) return message;
  return t.marketplacePage.errorGeneric;
}

function cadenceKey(value: "Daily" | "Weekly" | "Quarterly") {
  return value.toUpperCase() as MarketplaceListing["cadence"];
}

function localizedCadence(value: MarketplaceListing["cadence"], locale: Locale) {
  if (locale === "tr") {
    if (value === "DAILY") return "Gün";
    if (value === "WEEKLY") return "Hafta";
    return "Çeyrek";
  }
  if (value === "DAILY") return "Daily";
  if (value === "WEEKLY") return "Weekly";
  return "Quarterly";
}

function localizedDirection(value: MarketplaceListing["direction"], t: Copy) {
  return value === "HIGH" ? t.home.directionHighKey : t.home.directionLowKey;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatPrice(value: string | null, locale: Locale) {
  if (value === null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function formatCountdown(ms: number, locale: Locale) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(locale === "tr" ? `${days}g` : `${days}d`);
  if (days > 0 || hours > 0) parts.push(locale === "tr" ? `${hours}sa` : `${hours}h`);
  parts.push(locale === "tr" ? `${minutes}dk` : `${minutes}m`);
  parts.push(locale === "tr" ? `${seconds}sn` : `${seconds}s`);
  return parts.join(" ");
}

/** Same rising/falling motif used across the pool board and pool detail. */
function DirectionMark({ direction }: { direction: MarketplaceListing["direction"] }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      {direction === "HIGH" ? (
        <path d="M4 26 L12 14 L18 20 L28 6 M28 6 H21 M28 6 V13" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4 6 L12 18 L18 12 L28 26 M28 26 H21 M28 26 V19" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function CutoffCell({ listing, locale, t }: { listing: MarketplaceListing; locale: Locale; t: Copy }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!listing.tradingCutoffAt) {
    return <span className="ex-num">—</span>;
  }

  const cutoff = Date.parse(listing.tradingCutoffAt);
  const closed = now >= cutoff;

  return (
    <span className="ex-market-row__cutoff" data-closed={closed}>
      {closed ? t.marketplacePage.tradingClosed : `${t.marketplacePage.tradingClosesIn} ${formatCountdown(cutoff - now, locale)}`}
    </span>
  );
}

function MarketplaceRow({
  listing,
  locale,
  t,
  onBuy,
  buyDisabled,
}: {
  listing: MarketplaceListing;
  locale: Locale;
  t: Copy;
  onBuy: () => void;
  buyDisabled: boolean;
}) {
  const config = assetConfigs[listing.asset];

  return (
    <div className="ex-market-row">
      <Link className="ex-market-row__link" href={`/pools/${listing.slug}`}>
        <span className="ex-market-row__identity">
          <img src={config.brandSrc} alt="" />
          <span className="ex-market-row__identity-text">
            <span className="ex-market-row__symbol">{listing.asset}</span>
            <span className="ex-market-row__meta">
              {localizedCadence(listing.cadence, locale)} ·{" "}
              <span className="ex-market-row__dir">
                <DirectionMark direction={listing.direction} />
                {localizedDirection(listing.direction, t)}
              </span>
            </span>
          </span>
        </span>

        <span className="ex-market-row__stat">
          <span className="ex-num ex-market-row__val">{formatPrice(listing.predictionPrice, locale)}</span>
          <span className="ex-market-row__key">{t.marketplacePage.columnPrediction}</span>
        </span>

        <span className="ex-market-row__stat ex-market-row__stat--ask">
          <span className="ex-num ex-market-row__val ex-market-row__ask">{formatUsdc(listing.askUsdc, locale)}</span>
          <span className="ex-market-row__key">{t.marketplacePage.columnAsk}</span>
        </span>

        <span className="ex-market-row__stat">
          <span className="ex-num ex-market-row__val" title={listing.seller}>{shortAddress(listing.seller)}</span>
          <span className="ex-market-row__key">{t.marketplacePage.columnSeller}</span>
        </span>

        <span className="ex-market-row__stat">
          <span className="ex-num ex-market-row__val">{t.round} #{listing.roundId}</span>
          <CutoffCell listing={listing} locale={locale} t={t} />
        </span>
      </Link>

      <button type="button" className="ex-market-row__buy" onClick={onBuy} disabled={buyDisabled}>
        {t.marketplacePage.buyAction}
      </button>
    </div>
  );
}

export default function MarketplaceClient() {
  const { locale } = useLocale();
  const t = useCopy();
  const walletSession = useWalletSession();
  const { address: ownerAddress, isConnected } = useAccount();

  const [asset, setAsset] = useState<"All" | Asset>("All");
  const [cadence, setCadence] = useState<"All" | "Daily" | "Weekly" | "Quarterly">("All");
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Never surfaced to the user: only whether the read failed, never the
  // underlying message. The fixed, human copy below covers every failure.
  const [error, setError] = useState(false);

  const [buyListing, setBuyListing] = useState<MarketplaceListing | null>(null);
  const [buyRefreshing, setBuyRefreshing] = useState(false);
  const [buyPriceChanged, setBuyPriceChanged] = useState(false);
  const [buyWalletChoice, setBuyWalletChoice] = useState<MarketplaceExecutionMode | null>(null);
  const [buyAllowance, setBuyAllowance] = useState<MarketplaceUsdcAllowance | null>(null);
  const [buyApproveBusy, setBuyApproveBusy] = useState(false);
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyStatusText, setBuyStatusText] = useState("");
  const [buyError, setBuyError] = useState("");
  const [buyAuthRequired, setBuyAuthRequired] = useState(false);
  const [buySuccess, setBuySuccess] = useState<{ explorerUrl: string } | null>(null);

  const refreshListings = useCallback(async () => {
    try {
      const state = await backendApi.marketplace.listings();
      setListings(state.listings);
      setBlockNumber(state.chain.blockNumber);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshListings();
    const timer = setInterval(() => {
      void refreshListings();
    }, 30_000);

    return () => clearInterval(timer);
  }, [refreshListings]);

  async function openBuyDrawer(listing: MarketplaceListing) {
    setBuyListing(listing);
    setBuyWalletChoice(null);
    setBuyAllowance(null);
    setBuyError("");
    setBuyAuthRequired(false);
    setBuyPriceChanged(false);
    setBuySuccess(null);
    await refreshBuyListing(listing.listingId);
  }

  function closeBuyDrawer() {
    setBuyListing(null);
    setBuyWalletChoice(null);
    setBuyAllowance(null);
    setBuyError("");
    setBuyPriceChanged(false);
  }

  // Buy requires a fresh read of the listing immediately before it can be
  // confirmed -- the price (and buyability) shown here must never be a
  // stale value carried over from the last 30-second board refresh.
  async function refreshBuyListing(listingId: string) {
    setBuyRefreshing(true);
    try {
      const result = await backendApi.marketplace.listing(listingId);
      setBuyListing(result.listing);
      setBuyPriceChanged(false);
    } catch {
      // Keep whatever was already shown; the confirm step re-validates
      // server-side regardless, so this failure is not itself blocking.
    } finally {
      setBuyRefreshing(false);
    }
  }

  async function selectBuyWallet(mode: MarketplaceExecutionMode) {
    setBuyWalletChoice(mode);
    setBuyError("");
    if (mode === "EXTERNAL_OWNER" && isConnected && ownerAddress) {
      try {
        const allowance = await backendApi.marketplace.usdcAllowance(ownerAddress);
        setBuyAllowance(allowance);
      } catch {
        setBuyAllowance(null);
      }
    }
  }

  async function handleApproveUsdc() {
    if (!buyListing || !isConnected || !ownerAddress) {
      setBuyError(t.marketplacePage.connectOwnerWalletFirst);
      return;
    }

    setBuyApproveBusy(true);
    setBuyError("");

    try {
      const chainIdHex = await getOwnerChainId();
      if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
        throw new Error(t.marketplacePage.switchToArcTestnet);
      }

      const allowance = buyAllowance ?? (await backendApi.marketplace.usdcAllowance(ownerAddress));
      const data = encodeApproveCalldata(allowance.marketplaceAddress, buyListing.askUsdcRaw);
      const txHash = await sendOwnerTransaction({
        to: allowance.usdcAddress,
        data,
        value: "0x0",
        from: ownerAddress,
      });
      await waitForOwnerTransactionReceipt(txHash);

      const refreshed = await backendApi.marketplace.usdcAllowance(ownerAddress);
      setBuyAllowance(refreshed);
    } catch (cause) {
      setBuyError(marketplaceErrorCopy(cause, t));
    } finally {
      setBuyApproveBusy(false);
    }
  }

  async function handleConfirmPurchase() {
    if (!buyListing || !buyWalletChoice) return;

    setBuyBusy(true);
    setBuyError("");
    setBuyStatusText(t.marketplacePage.confirmingWithPasskey);

    try {
      const outcome = await confirmMarketplaceBuyWithPasskey({
        listingId: buyListing.listingId,
        expectedAskUsdcRaw: buyListing.askUsdcRaw,
        executionMode: buyWalletChoice,
      });

      let explorerUrl: string;
      if (outcome.executionMode === "BACKEND_WALLET") {
        explorerUrl = outcome.result.explorerUrl;
      } else {
        if (!isConnected || !ownerAddress || ownerAddress.toLowerCase() !== outcome.buyerAddress.toLowerCase()) {
          throw new Error(t.marketplacePage.connectMatchingWallet);
        }

        const chainIdHex = await getOwnerChainId();
        if (parseInt(chainIdHex, 16) !== ARC_TESTNET_CHAIN_ID) {
          throw new Error(t.marketplacePage.switchToArcTestnet);
        }

        setBuyStatusText(t.marketplacePage.waitingForWalletTransaction);
        const txHash = await sendOwnerTransaction({
          to: outcome.transactionRequest.to,
          data: outcome.transactionRequest.data,
          value: outcome.transactionRequest.value,
          from: outcome.transactionRequest.from,
        });

        setBuyStatusText(t.marketplacePage.waitingForConfirmation);
        await waitForOwnerTransactionReceipt(txHash);

        setBuyStatusText(t.marketplacePage.verifyingPurchase);
        const result = await confirmExternalMarketplaceBuyReceipt(outcome.actionId, txHash);
        explorerUrl = result.explorerUrl;
      }

      setBuySuccess({ explorerUrl });
      closeBuyDrawer();
      void refreshListings();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setBuyAuthRequired(true);
        setBuyError("");
      } else if (cause instanceof Error && cause.message === "marketplace_price_changed") {
        // Never retried automatically: the listing is refetched and the
        // buyer must press confirm again on the new price.
        setBuyPriceChanged(true);
        setBuyError(t.marketplacePage.errorPriceChanged);
        await refreshBuyListing(buyListing.listingId);
      } else {
        setBuyError(marketplaceErrorCopy(cause, t));
      }
    } finally {
      setBuyBusy(false);
      setBuyStatusText("");
    }
  }

  // Only genuinely buyable listings belong on the public board. A listing
  // that is technically still ACTIVE onchain but has gone stale (approval
  // lost, ownership changed, trading window closed) is not something a
  // buyer can act on, so it stays out of this view entirely rather than
  // being shown as an inert row.
  const buyable = useMemo(() => listings.filter((listing) => listing.state === "ACTIVE"), [listings]);

  const filtered = useMemo(
    () =>
      buyable.filter(
        (listing) =>
          (asset === "All" || listing.asset === asset) &&
          (cadence === "All" || listing.cadence === cadenceKey(cadence)),
      ),
    [asset, cadence, buyable],
  );

  const groups = useMemo(
    () =>
      ASSET_ORDER.map((item) => ({
        asset: item,
        listings: filtered.filter((listing) => listing.asset === item),
      })).filter((group) => group.listings.length > 0),
    [filtered],
  );

  return (
    <>
      <div className="ex-shell ex-marketplace__head">
        <p className="ex-eyebrow">{t.marketplacePage.eyebrow}</p>
        <h1 className="ex-display ex-display--xl">{t.marketplacePage.title}</h1>
        <p className="ex-lede">{t.marketplacePage.lede}</p>
      </div>

      {buySuccess && (
        <div className="ex-shell">
          <section className="ex-ticket-notice">
            <div>
              <p className="ex-eyebrow">{t.marketplacePage.buySuccessEyebrow}</p>
              <h2 className="ex-display ex-display--md">{t.marketplacePage.buySuccessTitle}</h2>
            </div>
            <p>{t.marketplacePage.buySuccessBody}</p>
            <a href={buySuccess.explorerUrl} target="_blank" rel="noreferrer">
              {locale === "tr" ? "İşlemi doğrula" : "Verify transaction"} →
            </a>
          </section>
        </div>
      )}

      <div className="ex-shell">
        <div className="ex-rail">
          <div className="ex-rail__group">
            <span className="ex-rail__label">{t.poolsAssetFilter}</span>
            <div className="ex-rail__set" aria-label="Asset filter" role="group">
              {assetFilters.map((item) => (
                <button
                  className="ex-rail__btn"
                  data-active={asset === item}
                  key={item}
                  type="button"
                  onClick={() => setAsset(item)}
                >
                  {item === "All" ? t.all : item}
                </button>
              ))}
            </div>
          </div>

          <div className="ex-rail__group">
            <span className="ex-rail__label">{t.marketplacePage.periodFilter}</span>
            <div className="ex-rail__set" aria-label="Period filter" role="group">
              {cadenceFilters.map((item) => (
                <button
                  className="ex-rail__btn"
                  data-active={cadence === item}
                  key={item}
                  type="button"
                  onClick={() => setCadence(item)}
                >
                  {item === "All" ? t.all : item === "Daily" ? t.daily : item === "Weekly" ? t.weekly : t.quarterly}
                </button>
              ))}
            </div>
          </div>

          {!loading && !error && (
            <p className="ex-rail__meta">
              {filtered.length} {t.marketplacePage.listingsShown} · {t.poolsBlock} {blockNumber ?? "—"}
            </p>
          )}
        </div>

        {loading && <p className="ex-pools__note">{t.marketplacePage.loading}</p>}

        {!loading && error && (
          <div className="ex-pools__error">
            <h2 className="ex-display ex-display--md">{t.marketplacePage.listingsUnavailable}</h2>
            <p className="ex-lede">{t.marketplacePage.listingsUnavailableBody}</p>
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="ex-pools__error">
            <h2 className="ex-display ex-display--md">{t.marketplacePage.noListings}</h2>
            <p className="ex-lede">{t.marketplacePage.noListingsBody}</p>
          </div>
        )}

        {!loading && !error && groups.length > 0 && (
          <div className="ex-board">
            {groups.map((group) => {
              const config = assetConfigs[group.asset];
              return (
                <section className="ex-asset" key={group.asset}>
                  <div className="ex-asset__head">
                    <span className="ex-asset__id">
                      <img src={config.brandSrc} alt="" />
                      <span className="ex-asset__symbol">{group.asset}</span>
                      <span className="ex-asset__name">{config.name}</span>
                    </span>
                  </div>

                  <div className="ex-market-ledger">
                    {group.listings.map((listing) => (
                      <Fragment key={listing.listingId}>
                        <MarketplaceRow
                          listing={listing}
                          locale={locale}
                          t={t}
                          onBuy={() => void openBuyDrawer(listing)}
                          buyDisabled={buyBusy}
                        />
                        {buyListing?.listingId === listing.listingId && (
                          <div className="ex-market-drawer">
                            <p className="ex-eyebrow">{t.marketplacePage.buyDrawerEyebrow}</p>

                            <div className="ex-market-drawer__price">
                              <span className="ex-market-drawer__price-key">{t.marketplacePage.buyPriceLabel}</span>
                              <span className="ex-market-drawer__price-val ex-num">
                                {buyRefreshing ? t.marketplacePage.buyRefreshing : formatUsdc(buyListing.askUsdc, locale)}
                              </span>
                            </div>

                            {buyPriceChanged && (
                              <p>
                                <b>{t.marketplacePage.buyPriceChangedTitle}</b> {t.marketplacePage.buyPriceChangedBody}
                              </p>
                            )}

                            {buyAuthRequired ? (
                              <p className="ex-market-drawer__msg" data-tone="error">
                                {t.marketplacePage.connectOwnerWalletFirst}{" "}
                                <Link href="/wallet">{locale === "tr" ? "Cüzdanı yeniden bağla" : "Reconnect wallet"}</Link>
                              </p>
                            ) : (
                              <>
                                <div className="ex-market-drawer__wallets">
                                  <button
                                    type="button"
                                    data-active={buyWalletChoice === "BACKEND_WALLET"}
                                    onClick={() => void selectBuyWallet("BACKEND_WALLET")}
                                    disabled={walletSession.status !== "ready"}
                                  >
                                    {t.marketplacePage.buyWalletBackend}
                                  </button>
                                  <button
                                    type="button"
                                    data-active={buyWalletChoice === "EXTERNAL_OWNER"}
                                    onClick={() => void selectBuyWallet("EXTERNAL_OWNER")}
                                    disabled={!isConnected}
                                  >
                                    {t.marketplacePage.buyWalletOwner}
                                  </button>
                                </div>

                                {buyWalletChoice === "EXTERNAL_OWNER" && !isConnected && (
                                  <p className="ex-market-drawer__msg">{t.marketplacePage.connectWalletToBuy}</p>
                                )}

                                {buyWalletChoice === "BACKEND_WALLET" && <p>{t.marketplacePage.buyReadyBackend}</p>}

                                {buyWalletChoice === "EXTERNAL_OWNER" && isConnected && (
                                  <p>
                                    {buyAllowance && BigInt(buyAllowance.allowanceRaw) >= BigInt(buyListing.askUsdcRaw)
                                      ? t.marketplacePage.buyReadyOwner
                                      : t.marketplacePage.buyNeedsUsdcApproval}
                                  </p>
                                )}

                                {buyError && (
                                  <p className="ex-market-drawer__msg" data-tone="error">
                                    {buyError}
                                  </p>
                                )}

                                <div className="ex-market-drawer-actions">
                                  {buyWalletChoice === "EXTERNAL_OWNER" &&
                                  isConnected &&
                                  (!buyAllowance || BigInt(buyAllowance.allowanceRaw) < BigInt(buyListing.askUsdcRaw)) ? (
                                    <button type="button" onClick={() => void handleApproveUsdc()} disabled={buyApproveBusy}>
                                      {buyApproveBusy ? t.marketplacePage.approvingUsdc : t.marketplacePage.approveUsdcAction}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => void handleConfirmPurchase()}
                                      disabled={
                                        !buyWalletChoice ||
                                        buyBusy ||
                                        buyRefreshing ||
                                        (buyWalletChoice === "EXTERNAL_OWNER" && !isConnected)
                                      }
                                    >
                                      {buyBusy ? buyStatusText || t.marketplacePage.confirmingWithPasskey : t.marketplacePage.confirmPurchase}
                                    </button>
                                  )}
                                  <button type="button" onClick={closeBuyDrawer} disabled={buyBusy || buyApproveBusy}>
                                    {t.marketplacePage.cancel}
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </Fragment>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
