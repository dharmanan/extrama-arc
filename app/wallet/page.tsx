"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { arcTestnet } from "../lib/web3";
import { shortAddress, useWalletSession } from "../wallet-session";
import { backendApi, isAuthSessionError } from "../lib/backend-api";
import { authenticatePasskey, registerPasskey } from "../lib/passkey-client";
import { useCopy, useLocale } from "../i18n";
import { CircleWalletOnboarding } from "../circle-wallet-onboarding";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { assetConfigs } from "../lib/asset-config";
import { readBinanceLiveMarket } from "../lib/live-market";

type Step = "owner" | "choice" | "create" | "recovery" | "ready";


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
  const [deviceName, setDeviceName] = useState("My Device");
  const [privateKey, setPrivateKey] = useState("");
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [chainState, setChainState] = useState<Awaited<ReturnType<typeof backendApi.wallet.chainState>> | null>(null);
  const [chainBusy, setChainBusy] = useState("");
  const [chainError, setChainError] = useState("");
  const [gateway, setGateway] = useState<Awaited<ReturnType<typeof backendApi.wallet.gatewayBalance>> | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [sessionNeedsAuth, setSessionNeedsAuth] = useState(false);
  const [walletNotice, setWalletNotice] = useState("");

  useEffect(() => {
    if (isConnected && connectedAddress) {
      setOwnerAddress(connectedAddress);
      if (step === "owner") setStep("choice");
    } else if (!isConnected) {
      setOwnerAddress(null);
      if (step !== "recovery" && step !== "ready") setStep("owner");
    }
  }, [isConnected, connectedAddress, step]);


  // Backend session hydration is asynchronous on a full page refresh.
  // If the authenticated session already owns an EXTREMA wallet, promote the
  // wallet page back to the ready surface as soon as WalletSessionProvider
  // confirms it. Recovery is deliberately excluded because a freshly created
  // wallet must still show its one-time private-key disclosure.
  useEffect(() => {
    if (walletStatus === "ready" && walletAddress && step !== "recovery") {
      setStep("ready");
    }
  }, [walletStatus, walletAddress, step]);


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
      setWalletNotice("Connected wallet session ready. Every transaction remains wallet approved.");
      setStep("ready");
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

  async function handleCreate() {
    if (!ownerAddress) return;
    setError("");
    setWalletNotice("");
    setBusy("Waiting for wallet signature...");
    try {
      await registerPasskey(
        ownerAddress,
        deviceName,
        async (message) => {
          setBusy("Waiting for owner wallet signature...");
          await ensureArcTestnet();
          const signature = await signMessageAsync({ message });
          setBusy("Registering passkey...");
          return signature;
        },
      );

      setBusy("Checking EXTREMA wallet...");
      const result = await backendApi.wallet.create();

      if (!result.wallet?.address) {
        throw new Error("Backend did not return an EXTREMA wallet.");
      }

      setWalletReady(result.wallet.address);

      if (result.created && result.privateKey) {
        setPrivateKey(result.privateKey);
        setWalletNotice("");
        setStep("recovery");
      } else {
        setWalletNotice(
          "Existing EXTREMA wallet restored. No new wallet was created. The private key is not re-disclosed.",
        );
        setStep("ready");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EXTREMA wallet creation failed.");
    } finally {
      setBusy("");
    }
  }

  async function handleResumeSession() {
    if (!ownerAddress) {
      setStep("owner");
      return;
    }

    setError("");
    setChainError("");
    setBusy("Authenticating with passkey...");
    try {
      await authenticatePasskey(ownerAddress);
      const result = await backendApi.wallet.get();

      if (!result.wallet?.address) {
        throw new Error("No EXTREMA wallet exists for this owner wallet.");
      }

      setWalletReady(result.wallet.address);
      setSessionNeedsAuth(false);
      await refreshChainState();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setSessionNeedsAuth(true);
        setChainError("");
      } else {
        setChainError(cause instanceof Error ? cause.message : "Passkey authentication failed.");
      }
    } finally {
      setBusy("");
    }
  }

  async function handleReconnect() {
    if (!ownerAddress) return;
    setError("");
    setBusy("Authenticating with passkey...");
    try {
      await authenticatePasskey(ownerAddress);
      const result = await backendApi.wallet.get();

      if (!result.wallet?.address) {
        throw new Error("No EXTREMA wallet exists for this owner wallet.");
      }

      setWalletReady(result.wallet.address);
      setSessionNeedsAuth(false);
      setStep("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconnect failed.");
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
    setPrivateKey("");
    setRecoveryConfirmed(false);
    setWalletNotice("");
    setStep("owner");
  }

  const gatewayFunded = gateway !== null && hasPositiveRawAmount(gateway.totalRaw);

  if (step === "recovery" && walletAddress && privateKey) {
    return (
      <main className="ex-wallet-page">
        <ProductHeader />
        <div className="ex-shell">
          <div className="ex-wallet-hero">
            <p className="ex-eyebrow">{t.wallet.recoveryEyebrow}</p>
            <h1 className="ex-display ex-display--lg">{t.wallet.recoveryTitle}</h1>
            <p className="ex-lede">{t.wallet.recoveryLede}</p>
          </div>

          <div className="ex-wallet-recovery">
            <div className="ex-wallet-recovery__row">
              <span className="ex-wallet-recovery__tag">{t.wallet.addressSafe}</span>
              <span className="ex-wallet-recovery__label">{t.wallet.addressLabel}</span>
              <p className="ex-wallet-recovery__value ex-num">{walletAddress}</p>
            </div>

            <div className="ex-wallet-recovery__row" data-danger="true">
              <span className="ex-wallet-recovery__tag" data-danger="true">{t.wallet.keyNeverShare}</span>
              <span className="ex-wallet-recovery__label">{t.wallet.keyLabel}</span>
              <p className="ex-wallet-recovery__value ex-wallet-recovery__value--key ex-num">{privateKey}</p>
            </div>

            <p className="ex-wallet-recovery__warning">{t.wallet.keyWarning}</p>

            <label className="ex-wallet-recovery__confirm">
              <input
                type="checkbox"
                checked={recoveryConfirmed}
                onChange={(event) => setRecoveryConfirmed(event.target.checked)}
              />
              <span>{t.wallet.confirmSaved}</span>
            </label>

            <button
              className="ex-btn ex-btn--ink"
              type="button"
              disabled={!recoveryConfirmed}
              onClick={() => {
                setPrivateKey("");
                setRecoveryConfirmed(false);
                setStep("ready");
              }}
            >
              {t.wallet.recoveryCta}
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (step === "ready" && walletStatus === "ready" && walletAddress) {
    return (
      <main className="ex-wallet-page">
        <ProductHeader />
        <div className="ex-shell">
          <div className="ex-wallet-hero">
            <p className="ex-eyebrow">{executionMode === "EXTERNAL_WALLET" ? t.wallet.externalReadyEyebrow : t.wallet.readyEyebrow}</p>
            <h1 className="ex-display ex-display--lg">{t.wallet.readyTitle}</h1>
          </div>

          {walletNotice && <p className="ex-entry__msg" data-tone="ok">{walletNotice}</p>}

          <div className="ex-wallet-ready">
            <section className="ex-wallet-ready__main">
              <div className="ex-wallet-ready__marks">
                {ownerAddress && executionMode !== "EXTERNAL_WALLET" && (
                  <div className="ex-wallet-mark">
                    <span className="ex-wallet-mark__key">{t.wallet.ownerWallet}</span>
                    <span className="ex-wallet-mark__val ex-num">{shortAddress(ownerAddress)}</span>
                  </div>
                )}
                <div className="ex-wallet-mark">
                    <span className="ex-wallet-mark__key">{executionMode === "EXTERNAL_WALLET" ? t.wallet.connectedWallet : t.wallet.extremaWallet}</span>
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
                  <p className="ex-wallet-ledger__prompt-body">{executionMode === "EXTERNAL_WALLET" ? t.wallet.externalChoiceBody : t.wallet.sessionExpiredBody}</p>
                  <button
                    className="ex-btn ex-btn--ink"
                    type="button"
                    onClick={executionMode === "EXTERNAL_WALLET" ? handleExternalWalletLogin : handleResumeSession}
                    disabled={Boolean(busy)}
                  >
                    {busy || (executionMode === "EXTERNAL_WALLET" ? t.wallet.externalChoiceCta : t.wallet.authenticateWithPasskey)}
                  </button>
                </div>
              ) : chainState ? (
                <div
                  className="ex-wallet-summary"
                  data-columns={gatewayFunded ? "3" : "2"}
                >
                  <div className="ex-wallet-summary__item">
                    <span>Network</span>
                    <strong className="ex-num">
                      {chainState.chain.name} · {chainState.chain.id}
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
                  : executionMode === "CIRCLE_USER_WALLET"
                    ? t.wallet.circleSessionBody
                    : t.wallet.sessionBody}
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


  if (step === "create" && ownerAddress) {
    return (
      <main className="ex-wallet-page">
        <ProductHeader />
        <div className="ex-shell">
          <div className="ex-wallet-strip">
            <div className="ex-wallet-strip__item">
              <span className="ex-wallet-strip__key">{t.wallet.ownerWallet}</span>
              <span className="ex-wallet-strip__val ex-num">{connectedAddress ? shortAddress(connectedAddress) : t.wallet.notConnected}</span>
            </div>
            <div className="ex-wallet-strip__item">
              <span className="ex-wallet-strip__key">{t.wallet.network}</span>
              <span className="ex-wallet-strip__val ex-num">{chain ? `${chain.name} · ${chain.id}` : "—"}</span>
            </div>
            <div className="ex-wallet-strip__actions">
              {chain?.id !== arcTestnet.id && (
                <button className="ex-btn ex-btn--ghost" type="button" onClick={() => switchChainAsync({ chainId: arcTestnet.id })}>
                  {t.wallet.switchToArc}
                </button>
              )}
              <button className="ex-btn ex-btn--ghost" type="button" onClick={() => disconnect()}>{t.wallet.disconnect}</button>
            </div>
          </div>

          <div className="ex-wallet-hero">
            <p className="ex-eyebrow">{t.wallet.createEyebrow}</p>
            <h1 className="ex-display ex-display--lg">{t.wallet.createTitle}</h1>
          </div>

          <div className="ex-wallet-panel">
            <label className="ex-entry__field">
              <span className="ex-entry__label">{t.wallet.deviceNameLabel}</span>
              <input
                value={deviceName}
                maxLength={100}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder={t.wallet.deviceNamePlaceholder}
              />
            </label>

            <p className="ex-wallet-panel__note">{t.wallet.createFlowNote}</p>

            <div className="ex-wallet-panel__actions">
              <button className="ex-btn ex-btn--ink" type="button" onClick={handleCreate} disabled={Boolean(busy)}>
                {busy || t.wallet.createCta}
              </button>
              <button className="ex-btn ex-btn--ghost" type="button" onClick={() => setStep("choice")} disabled={Boolean(busy)}>
                {t.wallet.back}
              </button>
            </div>

            {error && <p className="ex-entry__msg" data-tone="error">{error}</p>}
          </div>
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
