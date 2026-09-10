"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { arcTestnet } from "../lib/web3";
import { shortAddress, useWalletSession } from "../wallet-session";
import { backendApi, isAuthSessionError } from "../lib/backend-api";
import { readCircleTabAuth } from "../lib/circle-auth";
import { useCopy, useLocale } from "../i18n";
import { CircleWalletOnboarding } from "../circle-wallet-onboarding";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { assetConfigs } from "../lib/asset-config";
import { readBinanceLiveMarket } from "../lib/live-market";

// Two entry choices only: Circle (Google or email) or a connected EVM
// wallet. "choice" is the connected wallet's single login signature.
type Step = "owner" | "choice" | "ready";


const WALLET_MARKET_ASSETS = ["BTC", "ETH", "SOL", "HYPE"] as const;

type WalletMarketPrice = {
  markPrice: string;
  source: string;
};

function formatWalletMarketPrice(value: string, locale: "en" | "tr") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "···";

  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: numeric < 100 ? 2 : 0,
    minimumFractionDigits: numeric < 100 ? 2 : 0,
  }).format(numeric);
}

// Gateway balances arrive as canonical 6 decimal raw units. The backend already
// validates them, but the wallet page must never crash on an unexpected value,
// so anything that is not a positive integer string counts as no Gateway
// balance. Digit inspection keeps this exact at any size without BigInt, which
// this project's ES2017 target does not allow as a literal.
function hasPositiveRawAmount(value: string) {
  return /^\d+$/.test(value) && !/^0+$/.test(value);
}

function WalletLiveMarket() {
  const { locale } = useLocale();
  const [prices, setPrices] = useState<Record<string, WalletMarketPrice>>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const live = await readBinanceLiveMarket();
        if (cancelled) return;

        const next: Record<string, WalletMarketPrice> = {};

        for (const symbol of WALLET_MARKET_ASSETS) {
          const config = assetConfigs[symbol];
          const price = live.prices[config.sourceSymbol];

          if (price) {
            next[symbol] = {
              markPrice: price.markPrice,
              source: price.source,
            };
          }
        }

        setPrices(next);
      } catch {
        if (!cancelled) setPrices({});
      }
    }

    void load();
    const timer = window.setInterval(load, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const sources = Array.from(
    new Set(Object.values(prices).map((item) => item.source)),
  );

  return (
    <section className="ex-wallet-market" aria-label="Live market prices">
      {WALLET_MARKET_ASSETS.map((symbol) => {
        const price = prices[symbol];

        return (
          <div className="ex-wallet-market__item" key={symbol}>
            <div className="ex-wallet-market__asset">
              <img src={assetConfigs[symbol].brandSrc} alt="" />
              <span>{symbol}</span>
            </div>

            <span
              className="ex-wallet-market__price"
              data-pending={price ? "false" : "true"}
            >
              {price
                ? formatWalletMarketPrice(price.markPrice, locale)
                : "···"}
            </span>
          </div>
        );
      })}

      <div className="ex-wallet-market__meta">
        <span>{locale === "tr" ? "CANLI PİYASA" : "LIVE MARKET"}</span>
        <small>
          {sources.length ? sources.join(" · ") : "—"} · 60s
        </small>
      </div>
    </section>
  );
}

export default function WalletPage() {
  const t = useCopy();
  const { openConnectModal } = useConnectModal();

  const {
    address: walletAddress,
    executionMode,
    status: walletStatus,
    setWalletReady,
    lockWallet,
  } = useWalletSession();

  const { address: connectedAddress, isConnected, chain } = useAccount();
  const { disconnect } = useDisconnect();

  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(walletStatus === "ready" ? "ready" : "owner");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [chainState, setChainState] = useState<Awaited<ReturnType<typeof backendApi.wallet.chainState>> | null>(null);
  const [chainBusy, setChainBusy] = useState("");
  const [chainError, setChainError] = useState("");
  const [gateway, setGateway] = useState<Awaited<ReturnType<typeof backendApi.wallet.gatewayBalance>> | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [sessionNeedsAuth, setSessionNeedsAuth] = useState(false);
  const [walletNotice, setWalletNotice] = useState("");
  // A Circle session whose stored Circle login can no longer refresh it
  // falls back to the Circle Google or email sign in, never to another method.
  const [circleReauthRequired, setCircleReauthRequired] = useState(false);

  useEffect(() => {
    if (isConnected && connectedAddress) {
      setOwnerAddress(connectedAddress);
      if (step === "owner") setStep("choice");
    } else if (!isConnected) {
      setOwnerAddress(null);
      if (step !== "ready") setStep("owner");
    }
  }, [isConnected, connectedAddress, step]);


  // Backend session hydration is asynchronous on a full page refresh.
  // If the authenticated session already has a wallet, promote the wallet
  // page back to the ready surface as soon as WalletSessionProvider confirms.
  useEffect(() => {
    if (walletStatus === "ready" && walletAddress) {
      setStep("ready");
    }
  }, [walletStatus, walletAddress]);


  async function handleExternalWalletLogin() {
    if (!connectedAddress) return;
    setError("");
    setBusy("Waiting for wallet signature...");
    try {
      await ensureArcTestnet();
      const challenge = await backendApi.auth.walletLoginChallenge(connectedAddress);
      const signature = await signMessageAsync({ message: challenge.message });
      const session = await backendApi.auth.finishWalletLogin(
        connectedAddress,
        challenge.challengeId,
        signature,
      );
      if (
        session.executionMode !== "EXTERNAL_WALLET" ||
        session.walletAddress.toLowerCase() !== connectedAddress.toLowerCase()
      ) {
        throw new Error("Wallet session identity did not match the connected wallet.");
      }
      setWalletReady(session.walletAddress, "EXTERNAL_WALLET");
      setOwnerAddress(session.ownerAddress);
      setSessionNeedsAuth(false);
      setWalletNotice("Connected wallet session ready. Every transaction remains wallet approved.");
      setStep("ready");
      await refreshChainState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet sign in failed.");
    } finally {
      setBusy("");
    }
  }

  async function copyExtremaAddress() {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopiedAddress(true);
      window.setTimeout(() => setCopiedAddress(false), 1500);
    } catch {
      setChainError("Wallet address could not be copied.");
    }
  }

  async function refreshChainState() {
    setChainError("");
    setChainBusy("Reading Arc Testnet...");
    try {
      const state = await backendApi.wallet.chainState();
      setChainState(state);
      setSessionNeedsAuth(false);
    } catch (cause) {
      setChainState(null);
      if (isAuthSessionError(cause)) {
        setSessionNeedsAuth(true);
        setChainError("");
      } else {
        setChainError("Arc Testnet balance could not be refreshed. Try again.");
      }
    } finally {
      setChainBusy("");
    }
  }

  useEffect(() => {
    if (step === "ready" && walletStatus === "ready" && walletAddress) {
      void refreshChainState();
    }
  }, [step, walletStatus, walletAddress]);

  // Gateway is supplemental and Circle only. It is read separately from the Arc
  // chain state so that a Gateway outage can never surface as a wallet error,
  // an Arc balance failure or a broken session. Every failure resolves to null,
  // which simply hides the Gateway figure.
  async function refreshGatewayBalance() {
    try {
      setGateway(await backendApi.wallet.gatewayBalance());
    } catch {
      setGateway(null);
    }
  }

  useEffect(() => {
    if (
      step === "ready" &&
      walletStatus === "ready" &&
      walletAddress &&
      executionMode === "CIRCLE_USER_WALLET"
    ) {
      void refreshGatewayBalance();
      return;
    }

    setGateway(null);
  }, [step, walletStatus, walletAddress, executionMode]);

  async function ensureArcTestnet() {
    if (chain?.id === arcTestnet.id) return;
    await switchChainAsync({ chainId: arcTestnet.id });
  }

  // An expired Circle session is restored through Circle only. The Circle
  // login already held by this tab refreshes the EXTREMA session. If that
  // login is gone or expired, the Circle Google or email sign in is shown.
  async function handleCircleSessionRefresh() {
    setError("");
    setChainError("");
    const auth = readCircleTabAuth();
    if (!auth) {
      setCircleReauthRequired(true);
      return;
    }
    setBusy(t.wallet.restoringCircleSession);
    try {
      const session = await backendApi.circle.session(auth.userToken);
      setWalletReady(session.walletAddress, "CIRCLE_USER_WALLET");
      setOwnerAddress(session.ownerAddress);
      setSessionNeedsAuth(false);
      setCircleReauthRequired(false);
      await refreshChainState();
    } catch {
      setCircleReauthRequired(true);
    } finally {
      setBusy("");
    }
  }

  async function handleLock() {
    try {
      await backendApi.auth.logout();
    } catch {
      // Session may already be expired; local lock must still succeed.
    }
    lockWallet();
    disconnect();
    setOwnerAddress(null);
    setWalletNotice("");
    setCircleReauthRequired(false);
    setStep("owner");
  }

  const gatewayFunded = gateway !== null && hasPositiveRawAmount(gateway.totalRaw);

  if (step === "ready" && walletStatus === "ready" && walletAddress) {
    return (
      <main className="ex-wallet-page">
        <ProductHeader />
        <div className="ex-shell">
          <div className="ex-wallet-hero">
            <p className="ex-eyebrow">{executionMode === "EXTERNAL_WALLET" ? t.wallet.externalReadyEyebrow : t.wallet.circleReadyEyebrow}</p>
            <h1 className="ex-display ex-display--lg">{t.wallet.readyTitle}</h1>
          </div>

          {walletNotice && <p className="ex-entry__msg" data-tone="ok">{walletNotice}</p>}

          <div className="ex-wallet-ready">
            <section className="ex-wallet-ready__main">
              <div className="ex-wallet-ready__marks">
                <div className="ex-wallet-mark">
                    <span className="ex-wallet-mark__key">{executionMode === "EXTERNAL_WALLET" ? t.wallet.connectedWallet : t.wallet.circleWallet}</span>
                  <span className="ex-wallet-mark__val ex-num">{shortAddress(walletAddress)}</span>
                </div>
              </div>

              <div className="ex-wallet-address">
                <p className="ex-wallet-address__value ex-num">{walletAddress}</p>
                <button className="ex-btn ex-btn--ghost" type="button" onClick={copyExtremaAddress}>
                  {copiedAddress ? t.wallet.copied : t.wallet.copyAddress}
                </button>
              </div>

              {sessionNeedsAuth ? (
                <div className="ex-wallet-ledger ex-wallet-ledger--prompt">
                  <p className="ex-wallet-ledger__prompt-title">{t.wallet.sessionExpiredTitle}</p>
                  <p className="ex-wallet-ledger__prompt-body">{executionMode === "EXTERNAL_WALLET" ? t.wallet.externalChoiceBody : t.wallet.circleSessionExpiredBody}</p>
                  {executionMode === "CIRCLE_USER_WALLET" && circleReauthRequired ? (
                    <CircleWalletOnboarding
                      onReady={(session) => {
                        setWalletReady(session.walletAddress, "CIRCLE_USER_WALLET");
                        setOwnerAddress(session.ownerAddress);
                        setSessionNeedsAuth(false);
                        setCircleReauthRequired(false);
                        void refreshChainState();
                      }}
                    />
                  ) : (
                    <button
                      className="ex-btn ex-btn--ink"
                      type="button"
                      onClick={executionMode === "EXTERNAL_WALLET" ? handleExternalWalletLogin : handleCircleSessionRefresh}
                      disabled={Boolean(busy)}
                    >
                      {busy || (executionMode === "EXTERNAL_WALLET" ? t.wallet.externalChoiceCta : t.wallet.restoreCircleSession)}
                    </button>
                  )}
                </div>
              ) : chainState ? (
                <div
                  className="ex-wallet-summary"
                  data-columns={gatewayFunded ? "3" : "2"}
                >
                  <div className="ex-wallet-summary__item">
                    <span>Network</span>
                    <strong className="ex-num">
                      {executionMode === "EXTERNAL_WALLET"
                        ? (chain ? `${chain.name} · ${chain.id}` : t.wallet.notConnected)
                        : `${chainState.chain.name} · ${chainState.chain.id}`}
                    </strong>
                  </div>

                  <div className="ex-wallet-summary__item">
                    <span>USDC balance</span>
                    <strong className="ex-num">
                      {chainState.usdc.balanceFormatted} {chainState.usdc.symbol}
                    </strong>
                  </div>

                  {gateway && gatewayFunded && (
                    <div className="ex-wallet-summary__item">
                      <span>{t.wallet.gatewayBalance}</span>
                      <strong className="ex-num">
                        {gateway.totalUsdc} {gateway.token}
                      </strong>
                    </div>
                  )}
                </div>
              ) : (
                <p className="ex-wallet-ledger__pending">{chainBusy || t.wallet.balanceNotLoaded}</p>
              )}

              {!sessionNeedsAuth && chainError && <p className="ex-entry__msg" data-tone="error">{chainError}</p>}

              <div className="ex-wallet-actions">
                {executionMode === "EXTERNAL_WALLET" && chain?.id !== arcTestnet.id && (
                  <button
                    className="ex-btn ex-btn--ghost"
                    type="button"
                    onClick={() => switchChainAsync({ chainId: arcTestnet.id })}
                  >
                    {t.wallet.switchToArc}
                  </button>
                )}
                <button
                  className="ex-btn ex-btn--ghost"
                  type="button"
                  onClick={() => {
                    void refreshChainState();
                    if (executionMode === "CIRCLE_USER_WALLET") void refreshGatewayBalance();
                  }}
                  disabled={Boolean(chainBusy)}
                >
                  {chainBusy || t.wallet.refreshBalance}
                </button>
                <a
                  className="ex-btn ex-btn--ghost"
                  href="https://faucet.circle.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t.wallet.openFaucet}
                </a>
                {chainState && (
                  <a
                    className="ex-btn ex-btn--ghost"
                    href={chainState.wallet.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t.wallet.viewOnArcScan}
                  </a>
                )}
                <Link className="ex-btn ex-btn--ink" href="/pools">{t.wallet.explorePools}</Link>
              </div>
            </section>

            <section className="ex-entry ex-wallet-session">
              <h3 className="ex-entry__title">{t.wallet.sessionTitle}</h3>
              <p className="ex-entry__note">
                {executionMode === "EXTERNAL_WALLET"
                  ? t.wallet.externalSessionBody
                  : t.wallet.circleSessionBody}
              </p>
              <button className="ex-btn ex-btn--ghost" type="button" onClick={handleLock}>
                {t.wallet.disconnectSession}
              </button>
            </section>
          </div>
        </div>
      </main>
    );
  }


  if (step === "owner") {
    return (
      <main className="ex-wallet-page">
        <ProductHeader />

        <div className="ex-shell">
          <div className="ex-wallet-strip">
            <div className="ex-wallet-strip__item">
              <span className="ex-wallet-strip__key">{t.wallet.ownerWallet}</span>
              <span className="ex-wallet-strip__val ex-num">
                {isConnected && connectedAddress
                  ? shortAddress(connectedAddress)
                  : t.wallet.notConnected}
              </span>
            </div>

            <div className="ex-wallet-strip__item">
              <span className="ex-wallet-strip__key">{t.wallet.network}</span>
              <span className="ex-wallet-strip__val ex-num">
                {chain ? `${chain.name} · ${chain.id}` : "—"}
              </span>
            </div>
          </div>

          <div className="ex-wallet-entry-grid">
            <section className="ex-wallet-hero ex-wallet-hero--entry">
              <p className="ex-eyebrow">{t.wallet.getStarted}</p>

              <h1 className="ex-display ex-display--xl">
                {t.wallet.entranceTitle}
              </h1>

              <p className="ex-lede">
                Continue with Google or email using a Circle user controlled
                wallet, or connect an existing EVM wallet.
              </p>
            </section>

            <section className="ex-wallet-access">
              <p className="ex-eyebrow">Access</p>

              <CircleWalletOnboarding
                onReady={(session) => {
                  setWalletReady(
                    session.walletAddress,
                    "CIRCLE_USER_WALLET",
                  );
                  setOwnerAddress(session.ownerAddress);
                  setWalletNotice(
                    "Circle wallet session ready. Every transaction remains user approved.",
                  );
                  setStep("ready");
                }}
              />

              <div className="ex-wallet-access__divider">
                <span>OR</span>
              </div>

              <button
                className="ex-btn ex-btn--ink ex-wallet-access__wallet"
                type="button"
                disabled={!openConnectModal}
                onClick={() => openConnectModal?.()}
              >
                Connect wallet
              </button>

              <p className="ex-wallet-panel__note">
                MetaMask, Rabby, Phantom, Coinbase Wallet or another detected
                EVM wallet.
              </p>

              {error && (
                <p className="ex-entry__msg" data-tone="error">
                  {error}
                </p>
              )}
            </section>
          </div>

          <WalletLiveMarket />
        </div>
      </main>
    );
  }


  return (
    <main className="ex-wallet-page">
      <ProductHeader />

      <div className="ex-shell">
        <div className="ex-wallet-strip">
          <div className="ex-wallet-strip__item">
            <span className="ex-wallet-strip__key">Wallet</span>
            <span className="ex-wallet-strip__val ex-num">
              {connectedAddress
                ? shortAddress(connectedAddress)
                : t.wallet.notConnected}
            </span>
          </div>

          <div className="ex-wallet-strip__item">
            <span className="ex-wallet-strip__key">{t.wallet.network}</span>
            <span className="ex-wallet-strip__val ex-num">
              {chain ? `${chain.name} · ${chain.id}` : "—"}
            </span>
          </div>

          <div className="ex-wallet-strip__actions">
            <button
              className="ex-btn ex-btn--ghost"
              type="button"
              onClick={() => {
                disconnect();
                setOwnerAddress(null);
                setStep("owner");
              }}
            >
              Disconnect
            </button>
          </div>
        </div>

        <div className="ex-wallet-entry-grid">
          <section className="ex-wallet-hero ex-wallet-hero--entry">
            <p className="ex-eyebrow">{t.wallet.getStarted}</p>

            <h1 className="ex-display ex-display--xl">
              {t.wallet.entranceTitle}
            </h1>

            <p className="ex-lede">
              Continue with Google or email using a Circle user controlled
              wallet, or connect an existing EVM wallet.
            </p>
          </section>

          <section className="ex-wallet-access">
            <p className="ex-eyebrow">Wallet connected</p>

            <div className="ex-wallet-verify">
              <div className="ex-wallet-verify__identity">
                <strong className="ex-num">
                  {connectedAddress
                    ? shortAddress(connectedAddress)
                    : "—"}
                </strong>

                <span className="ex-num">
                  {chain ? `${chain.name} · ${chain.id}` : "—"}
                </span>
              </div>

              <div className="ex-wallet-verify__copy">
                <p>
                  Sign one message to verify this wallet.
                </p>
                <p>
                  This is not a transaction and costs no gas.
                </p>
              </div>

              <button
                className="ex-btn ex-btn--ink ex-wallet-access__wallet"
                type="button"
                onClick={handleExternalWalletLogin}
                disabled={Boolean(busy)}
              >
                {busy || "Sign to continue"}
              </button>

              <button
                className="ex-wallet-change"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => {
                  disconnect();
                  setOwnerAddress(null);
                  setStep("owner");
                  window.setTimeout(() => openConnectModal?.(), 0);
                }}
              >
                Choose another wallet
              </button>

              {error && (
                <p className="ex-entry__msg" data-tone="error">
                  {error}
                </p>
              )}
            </div>
          </section>
        </div>

        <WalletLiveMarket />
      </div>
    </main>
  );

}
