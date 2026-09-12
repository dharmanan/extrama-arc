"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import {
  useAccount,
  useDisconnect,
  usePublicClient,
  useSendTransaction,
  useSignMessage,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { arcTestnet, gatewaySourceChains } from "../lib/web3";
import { shortAddress, useWalletSession } from "../wallet-session";
import {
  backendApi,
  isAuthSessionError,
  type GatewayDepositResponse,
  type GatewayDepositActivityItem,
  type GatewayFundingResponse,
  type GatewayNetwork,
  type GatewaySourceStateResponse,
  type TransactionRequest,
} from "../lib/backend-api";
import {
  readCircleGatewayFundingRecovery,
  readExternalGatewayFundingRecovery,
  readCircleGatewayDepositRecovery,
  readExternalGatewayDepositRecovery,
  readCircleTabAuth,
  storeCircleTabAuth,
  readCircleSourceWalletRecovery,
  storeCircleSourceWalletRecovery,
  clearCircleSourceWalletRecovery,
  clearCircleGatewayDepositRecovery,
  clearExternalGatewayDepositRecovery,
  type CircleGatewayFundingRecovery,
  type ExternalGatewayFundingRecovery,
  type CircleGatewayDepositRecovery,
  type ExternalGatewayDepositRecovery,
  type CircleSourceWalletRecovery,
} from "../lib/circle-auth";
import { confirmGatewaySourceDeposit, confirmGatewayBurnSignature } from "../lib/gateway-actions";
import { ensureCircleFinancialAuth, executeHostedChallenge } from "../lib/circle-actions";
import { getCircleDeviceId } from "../lib/circle-actions";
import { useCopy, useLocale } from "../i18n";
import { CircleWalletOnboarding } from "../circle-wallet-onboarding";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { assetConfigs } from "../lib/asset-config";
import { readBinanceLiveMarket } from "../lib/live-market";

// Two entry choices only: Circle (Google or email) or a connected EVM
// wallet. "choice" is the connected wallet's single login signature.
type Step = "owner" | "choice" | "ready";
type GatewayReadState = "idle" | "loading" | "ready" | "error";

// The wallet UI is driven entirely by the canonical network lists the server
// sends (labels and Gateway domains). No token address, no contract address
// and no domain number is ever written here or shown to a user.
const SOURCE_WALLET_RECOVERY_TTL_MS = 30 * 60 * 1000;
// Circle's own eventual consistency after a completed challenge, not a
// network retry budget: bounded, read-only, no createWallet call in here.
const SOURCE_WALLET_RECONCILE_ATTEMPTS = 5;
const SOURCE_WALLET_RECONCILE_INTERVAL_MS = 3000;

function isCircleSourceWalletRecoveryExpired(recovery: CircleSourceWalletRecovery) {
  return recovery.expiresAtMs <= Date.now();
}

type SourceWalletStatus = "idle" | "checking" | "ready" | "missing" | "preparing" | "mismatch" | "error";
type DepositPhaseLabel =
  | ""
  | "reading"
  | "preparingApproval"
  | "confirmApproval"
  | "approvalConfirmed"
  | "confirmDeposit"
  | "depositSubmitted"
  | "waitingFinality"
  | "recovering";

function needsGatewayDepositRecoveryReview(action: GatewayDepositResponse) {
  // The backend, not the browser's copy of recovery or a state name, decides
  // whether it is safe to release a financial action. RECONCILING gets its
  // dedicated finality rail below; every other RECONCILE disposition stays in
  // the locked, status-only review state.
  return action.recoveryDisposition === "RECONCILE" && action.state !== "RECONCILING";
}

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
// so anything that is not a positive integer string counts as no transferable
// Gateway source balance. Digit inspection keeps this exact at any size
// without BigInt, which this project's ES2017 target does not allow as a
// literal.
function hasPositiveRawAmount(value: string) {
  return /^\d+$/.test(value) && !/^0+$/.test(value);
}

function parseGatewayUsdcRaw(value: string): string | null {
  const match = /^(?:0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  const [whole] = value.trim().split(".");
  const fraction = (match[1] || "").padEnd(6, "0");
  const raw = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  return hasPositiveRawAmount(raw) ? raw : null;
}

function formatGatewayUsdcRaw(valueRaw: string) {
  const padded = valueRaw.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function incrementDecimalString(value: string) {
  let carry = 1;
  let result = "";

  for (let index = value.length - 1; index >= 0; index -= 1) {
    const next = Number(value[index]) + carry;
    result = `${next % 10}${result}`;
    carry = next >= 10 ? 1 : 0;
  }

  return carry ? `1${result}` : result;
}

// Amounts stay exact for requests and recoveries. This is presentation only:
// normal wallet balances are rounded to familiar cents without converting the
// canonical raw value through a floating-point number.
function formatGatewayUsdcDisplay(value: string, locale: "en" | "tr") {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return locale === "tr" ? "0,00" : "0.00";

  let whole = match[1].replace(/^0+(?=\d)/, "") || "0";
  const fraction = (match[2] || "").padEnd(3, "0");
  let cents = fraction.slice(0, 2).padEnd(2, "0");

  if (Number(fraction[2]) >= 5) {
    const rounded = incrementDecimalString(`${whole}${cents}`.replace(/^0+(?=\d)/, "") || "0").padStart(3, "0");
    whole = rounded.slice(0, -2).replace(/^0+(?=\d)/, "") || "0";
    cents = rounded.slice(-2);
  }

  return `${whole}${locale === "tr" ? "," : "."}${cents}`;
}

function withGatewayAmount(template: string, amount: string) {
  return template.replace("{amount}", amount);
}

function withGatewayNetwork(template: string, network: string) {
  return template.replace("{network}", network);
}

function withGatewayStep(template: string, step: number, total: number) {
  return template.replace("{step}", String(step)).replace("{total}", String(total));
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
  const { locale } = useLocale();
  const { openConnectModal } = useConnectModal();

  const {
    address: walletAddress,
    executionMode,
    status: walletStatus,
    setWalletReady,
    lockWallet,
  } = useWalletSession();

  const { address: connectedAddress, connector: connectedConnector, isConnected, chain } = useAccount();
  const { disconnect } = useDisconnect();

  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  // One read-only client per funding chain, so a source deposit can wait for
  // its own receipt on its own chain. Fixed hook order: four chains, four
  // calls, never conditional.
  const sourcePublicClients = {
    [gatewaySourceChains[0].id]: usePublicClient({ chainId: gatewaySourceChains[0].id }),
    [gatewaySourceChains[1].id]: usePublicClient({ chainId: gatewaySourceChains[1].id }),
    [gatewaySourceChains[2].id]: usePublicClient({ chainId: gatewaySourceChains[2].id }),
    [gatewaySourceChains[3].id]: usePublicClient({ chainId: gatewaySourceChains[3].id }),
  };

  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(walletStatus === "ready" ? "ready" : "owner");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [chainState, setChainState] = useState<Awaited<ReturnType<typeof backendApi.wallet.chainState>> | null>(null);
  const [chainBusy, setChainBusy] = useState("");
  const [chainError, setChainError] = useState("");
  const [gateway, setGateway] = useState<Awaited<ReturnType<typeof backendApi.wallet.gatewayBalance>> | null>(null);
  const [gatewayReadState, setGatewayReadState] = useState<GatewayReadState>("idle");
  // The user's destination choice, as a domain string for the select element.
  // There is deliberately no source selector: the server allocates sources.
  const [gatewayDestinationDomain, setGatewayDestinationDomain] = useState("");
  const [gatewayAmount, setGatewayAmount] = useState("");
  const [gatewayFundingBusy, setGatewayFundingBusy] = useState(false);
  const [gatewaySignStep, setGatewaySignStep] = useState<{ step: number; total: number } | null>(null);
  const [gatewayFundingNotice, setGatewayFundingNotice] = useState("");
  const [gatewayFundingError, setGatewayFundingError] = useState("");
  const [gatewayFundingRecovery, setGatewayFundingRecovery] = useState<
    CircleGatewayFundingRecovery | ExternalGatewayFundingRecovery | null
  >(null);
  const [gatewayFundingStatus, setGatewayFundingStatus] = useState<GatewayFundingResponse | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [sessionNeedsAuth, setSessionNeedsAuth] = useState(false);
  const [walletNotice, setWalletNotice] = useState("");
  // A Circle session whose stored Circle login can no longer refresh it
  // falls back to the Circle Google or email sign in, never to another method.
  const [circleReauthRequired, setCircleReauthRequired] = useState(false);

  // The selected funding source controls one compact form. Its source-wallet
  // USDC stays distinct from the unified Gateway balance above.
  const [sourceState, setSourceState] = useState<GatewaySourceStateResponse | null>(null);
  const [sourceReadState, setSourceReadState] = useState<GatewayReadState>("idle");
  const [sourceWalletStatus, setSourceWalletStatus] = useState<Record<number, SourceWalletStatus>>({});
  const [sourceWalletNotice, setSourceWalletNotice] = useState<Record<number, string>>({});
  const [selectedSourceDomain, setSelectedSourceDomain] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositPhase, setDepositPhase] = useState<DepositPhaseLabel>("");
  const [depositError, setDepositError] = useState("");
  const [depositNotice, setDepositNotice] = useState("");
  const [depositStatus, setDepositStatus] = useState<GatewayDepositResponse | null>(null);
  const [depositRecovery, setDepositRecovery] = useState<
    CircleGatewayDepositRecovery | ExternalGatewayDepositRecovery | null
  >(null);
  const [activityItems, setActivityItems] = useState<GatewayDepositActivityItem[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityReadState, setActivityReadState] = useState<"idle" | "ready" | "delayed">("idle");
  const [activityStatusWarning, setActivityStatusWarning] = useState("");
  const activityRequestInFlight = useRef(false);
  const activityRecoveryRef = useRef<CircleGatewayDepositRecovery | ExternalGatewayDepositRecovery | null>(null);
  activityRecoveryRef.current = depositRecovery;

  const clearInteractiveDepositRecovery = useCallback(() => {
    if (executionMode === "CIRCLE_USER_WALLET") clearCircleGatewayDepositRecovery();
    else if (executionMode === "EXTERNAL_WALLET") clearExternalGatewayDepositRecovery();
    setDepositRecovery(null);
    setDepositAmount("");
    setDepositStatus(null);
    setDepositPhase("");
  }, [executionMode]);

  const refreshActivity = useCallback(async () => {
    if (walletStatus !== "ready" || !walletAddress || !executionMode) {
      setActivityItems([]);
      setActivityReadState("idle");
      setActivityStatusWarning("");
      return;
    }
    if (activityRequestInFlight.current) return;
    activityRequestInFlight.current = true;
    try {
      const result = await backendApi.wallet.gatewayDepositActivity();
      setActivityItems(result.activities);
      setActivityReadState(result.readState);
      setActivityStatusWarning(result.readState === "delayed" ? t.wallet.gatewayFinalityStatusDelayed : "");
      const recovery = activityRecoveryRef.current;
      const matching = recovery && result.activities.find((item) => item.actionId === recovery.actionId);
      if (matching && (matching.state === "RECONCILING" || matching.terminal)) {
        // Once the server has moved a submitted action into background Activity
        // (or has authoritatively completed/cleared it), release only the local
        // interactive lock. The durable backend row is never deleted here.
        clearInteractiveDepositRecovery();
      }
    } catch {
      setActivityReadState("delayed");
      setActivityStatusWarning(t.wallet.gatewayFinalityStatusDelayed);
    } finally {
      activityRequestInFlight.current = false;
    }
  }, [clearInteractiveDepositRecovery, executionMode, t.wallet, walletAddress, walletStatus]);

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

  // Native <select> focus handling for pointer users.
  //
  // A native select owns its own option list, and pointer-up can fire while
  // that list is still open, BEFORE the user has committed a choice. Blurring
  // on pointer-up therefore closes the dropdown out from under them and no
  // other option can ever be picked, which is exactly the regression this
  // replaces. Pointer-down is worse still for the same reason.
  //
  // The only safe lifecycle is: remember that this interaction began with a
  // pointer, then drop focus after a real selection change has been committed.
  // Keyboard interaction never sets the flag, so Tab focus, arrow-key
  // selection and the :focus-visible ring are all left untouched.
  //
  // Each select carries its own flag, so one select's interaction can never
  // blur the other.
  const destinationPointerIntent = useRef(false);
  const sourcePointerIntent = useRef(false);

  function markSelectPointerIntent(
    intent: MutableRefObject<boolean>,
    event: PointerEvent<HTMLSelectElement>,
  ) {
    if (event.pointerType !== "mouse" && event.pointerType !== "touch" && event.pointerType !== "pen") return;
    intent.current = true;
  }

  // Called only from a change handler, and only after that handler has already
  // applied its own state. Never bound to a pointer event.
  function blurAfterPointerSelectChange(
    intent: MutableRefObject<boolean>,
    select: HTMLSelectElement,
  ) {
    if (!intent.current) return;
    intent.current = false;
    window.requestAnimationFrame(() => select.blur());
  }

  // A dropdown dismissed without a choice (Escape, click away), or an
  // interaction that continues on the keyboard, must not leave a stale flag
  // that would later blur a keyboard-driven change.
  function clearSelectPointerIntent(intent: MutableRefObject<boolean>) {
    intent.current = false;
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

  // Gateway is supplemental and now available to both human execution modes.
  // It is read separately from the Arc chain state so that a Gateway outage
  // can never surface as a wallet error, an Arc balance failure or a broken
  // session. The explicit read state keeps a failed read distinct from a
  // successful zero balance.
  async function refreshGatewayBalance() {
    setGatewayReadState("loading");
    try {
      const result = await backendApi.wallet.gatewayBalance();
      setGateway(result);
      setGatewayReadState("ready");
    } catch {
      setGateway(null);
      setGatewayReadState("error");
    }
  }

  useEffect(() => {
    if (
      step === "ready" &&
      walletStatus === "ready" &&
      walletAddress &&
      (executionMode === "CIRCLE_USER_WALLET" || executionMode === "EXTERNAL_WALLET")
    ) {
      void refreshGatewayBalance();
      return;
    }

    setGateway(null);
    setGatewayReadState("idle");
  }, [step, walletStatus, walletAddress, executionMode]);

  // A reload restores the destination and the amount the user chose and
  // resumes the SAME action. The source plan is never restored from here: it
  // belongs to the server and the action reports it back.
  useEffect(() => {
    if (executionMode !== "CIRCLE_USER_WALLET" && executionMode !== "EXTERNAL_WALLET") {
      setGatewayFundingRecovery(null);
      setGatewayFundingStatus(null);
      return;
    }
    const recovery = executionMode === "CIRCLE_USER_WALLET"
      ? readCircleGatewayFundingRecovery()
      : readExternalGatewayFundingRecovery();
    if (!recovery) return;
    setGatewayFundingRecovery(recovery);
    setGatewayDestinationDomain(String(recovery.destinationDomain));
    setGatewayAmount(formatGatewayUsdcRaw(recovery.valueRaw));
  }, [executionMode]);

  useEffect(() => {
    const actionId = gatewayFundingRecovery?.actionId;
    if (!actionId) return;
    const recoveredActionId = actionId;
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const current = await backendApi.wallet.gatewayFunding(recoveredActionId);
        if (cancelled) return;
        setGatewayFundingStatus(current);
        if (["SUBMITTING", "SUBMITTED", "RECONCILIATION_REQUIRED"].includes(current.state)) {
          timer = window.setTimeout(poll, 5000);
        }
      } catch {
        // Recovery remains durable locally; a transient status read must not
        // clear it or create a new funding request.
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [executionMode, gatewayFundingRecovery?.actionId]);

  // Every funding chain's SOURCE WALLET balance in one server-side read. Each
  // chain is read independently there, so one unreachable endpoint degrades
  // exactly one card. This is never the Gateway unified balance: the two are
  // separate quantities and are rendered separately.
  async function refreshSourceState() {
    if (!walletAddress) return;
    setSourceReadState("loading");
    try {
      const result = await backendApi.wallet.gatewaySourceState();
      setSourceState(result);
      setSourceReadState("ready");
    } catch {
      setSourceState(null);
      setSourceReadState("error");
    }
  }

  // A domain is only usable if the server itself listed it as a funding
  // source. A recovery naming anything else is refused rather than trusted.
  function isConfiguredSourceDomain(domain: number) {
    return Boolean(sourceState?.sources.some((source) => source.domain === domain));
  }

  useEffect(() => {
    if (!sourceState || depositRecovery) return;
    setSelectedSourceDomain((current) => (
      sourceState.sources.some((source) => String(source.domain) === current)
        ? current
        : String(sourceState.sources[0]?.domain || "")
    ));
  }, [sourceState, depositRecovery]);

  function setStatusFor(domain: number, status: SourceWalletStatus) {
    setSourceWalletStatus((current) => ({ ...current, [domain]: status }));
  }

  function setNoticeFor(domain: number, notice: string) {
    setSourceWalletNotice((current) => ({ ...current, [domain]: notice }));
  }

  // Single read-only check for one funding chain. Safe to call on page load:
  // it never touches recovery storage and never calls createWallet.
  async function refreshCircleSourceWalletStatus(
    domain: number, userToken: string,
  ): Promise<SourceWalletStatus> {
    setStatusFor(domain, "checking");
    try {
      const result = await backendApi.circle.sourceWallet(domain, userToken);
      if (!result.wallet) {
        setStatusFor(domain, "missing");
        return "missing";
      }
      if (result.wallet.address.toLowerCase() !== result.arcAddress.toLowerCase()) {
        setStatusFor(domain, "mismatch");
        return "mismatch";
      }
      // The companion EOA already exists and matches the Arc session: any
      // earlier recovery attempt for this chain is stale.
      clearCircleSourceWalletRecovery(domain);
      setStatusFor(domain, "ready");
      return "ready";
    } catch {
      setStatusFor(domain, "error");
      return "error";
    }
  }

  // Circle can briefly lag between a challenge completing and the wallet
  // showing up in a listing. Bounded, read-only retries only: no createWallet
  // call is ever made from here. Returns "missing" only once a read
  // definitively reported no wallet; "error" if every read attempt failed
  // transiently, so a genuinely uncertain outcome is never treated as a
  // confirmed non-landing.
  async function reconcileSourceWalletReadOnly(
    domain: number, userToken: string,
  ): Promise<"ready" | "mismatch" | "missing" | "error"> {
    let sawDefinitiveMissing = false;
    for (let attempt = 0; attempt < SOURCE_WALLET_RECONCILE_ATTEMPTS; attempt += 1) {
      try {
        const result = await backendApi.circle.sourceWallet(domain, userToken);
        if (result.wallet) {
          return result.wallet.address.toLowerCase() === result.arcAddress.toLowerCase()
            ? "ready"
            : "mismatch";
        }
        sawDefinitiveMissing = true;
      } catch {
        // Transient read failure; keep retrying within the bounded window.
      }
      if (attempt < SOURCE_WALLET_RECONCILE_ATTEMPTS - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, SOURCE_WALLET_RECONCILE_INTERVAL_MS));
      }
    }
    return sawDefinitiveMissing ? "missing" : "error";
  }

  useEffect(() => {
    if (step !== "ready" || walletStatus !== "ready" || !walletAddress) return;
    if (executionMode !== "CIRCLE_USER_WALLET" && executionMode !== "EXTERNAL_WALLET") return;
    void refreshSourceState();
  }, [step, walletStatus, walletAddress, executionMode]);

  // A connected wallet needs no companion wallet preparation at all: the same
  // address already exists on every EVM chain it can switch to.
  useEffect(() => {
    if (executionMode !== "EXTERNAL_WALLET" || !sourceState) return;
    setSourceWalletStatus(Object.fromEntries(
      sourceState.sources.map((source) => [source.domain, "ready" as SourceWalletStatus]),
    ));
  }, [executionMode, sourceState]);

  // One read-only Circle readiness check per funding chain, once each. The
  // application session can be ready while this tab's Circle credentials are
  // gone (reopened browser, new tab, cleared sessionStorage); restoring them
  // once here, non-financially, is what keeps Gateway controls from looking
  // ready while every Circle financial action would fail before it even
  // reaches the backend. A restore failure falls back to the same Circle
  // reauthentication UI the rest of the page already uses.
  useEffect(() => {
    if (executionMode !== "CIRCLE_USER_WALLET" || !sourceState) return;
    let cancelled = false;
    void ensureCircleFinancialAuth()
      .then((auth) => {
        if (cancelled) return;
        for (const source of sourceState.sources) {
          if (sourceWalletStatus[source.domain]) continue;
          void refreshCircleSourceWalletStatus(source.domain, auth.userToken);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setCircleReauthRequired(true);
      });
    return () => {
      cancelled = true;
    };
  }, [executionMode, sourceState, sourceWalletStatus]);

  // Durable, idempotent Base Sepolia wallet preparation. Never mints a new
  // Circle idempotency key while a non-expired recovery already has one, and
  // never re-executes a hosted challenge once it exists: only an explicit
  // user click ever reaches executeHostedChallenge.
  // Shared tail for both the ERROR-with-live-recovery path and the MISSING
  // path: resolve (or reuse) a challenge id for the GIVEN recovery, execute
  // it, and reconcile. Never mints an idempotency key itself, so a caller
  // that hands it an existing recovery can never trigger a new one here.
  async function runSourceWalletChallenge(
    domain: number, userToken: string, initialRecovery: CircleSourceWalletRecovery,
  ) {
    let recovery = initialRecovery;
    let challengeId = recovery.challengeId;
    if (!challengeId) {
      // The same idempotencyKey survives a lost HTTP response: a retry
      // reaches the SAME Circle challenge instead of creating another one.
      const prepared = await backendApi.circle.prepareSourceWallet(
        domain,
        userToken,
        recovery.idempotencyKey,
      );
      if (prepared.status === "EXISTING") {
        clearCircleSourceWalletRecovery(domain);
        setStatusFor(domain, "ready");
        return;
      }
      if (typeof prepared.challengeId !== "string" || !prepared.challengeId) {
        throw new Error("circle_source_challenge_missing");
      }
      challengeId = prepared.challengeId;
      // D: persist the challenge id BEFORE executing it, so a page reload
      // between this write and hosted-challenge completion resumes the
      // SAME challenge rather than creating a second one.
      recovery = { ...recovery, challengeId };
      storeCircleSourceWalletRecovery(recovery);
    }

    // D: exactly the shared hosted challenge executor; never a second
    // implementation.
    try {
      await executeHostedChallenge(challengeId);
    } catch (challengeError) {
      // H: a reported failure/expiry might still have landed just before
      // it; check read-only before ever deciding it definitely did not.
      const reconciled = await reconcileSourceWalletReadOnly(domain, userToken);
      if (reconciled === "ready") {
        clearCircleSourceWalletRecovery(domain);
        setStatusFor(domain, "ready");
        return;
      }
      if (reconciled === "mismatch") {
        clearCircleSourceWalletRecovery(domain);
        setStatusFor(domain, "mismatch");
        return;
      }
      const message = challengeError instanceof Error ? challengeError.message : "";
      if (message === "circle_transaction_failed" && reconciled === "missing") {
        // Definitely did not land: safe to let the user explicitly restart.
        clearCircleSourceWalletRecovery(domain);
        setStatusFor(domain, "missing");
        setNoticeFor(domain, t.wallet.gatewaySourcePrepareFailed);
        return;
      }
      // Uncertain outcome (transient reads, or a non-terminal SDK error):
      // keep the SAME recovery so the next explicit click resumes it.
      setStatusFor(domain, "missing");
      setNoticeFor(domain, t.wallet.gatewaySourcePrepareUncertain);
      return;
    }

    // E: hosted challenge reported success; reconcile read-only, bounded,
    // no additional createWallet call.
    const reconciled = await reconcileSourceWalletReadOnly(domain, userToken);
    if (reconciled === "ready") {
      // F
      clearCircleSourceWalletRecovery(domain);
      setStatusFor(domain, "ready");
      void refreshSourceState();
      return;
    }
    if (reconciled === "mismatch") {
      // G: fail closed, never allow a Gateway deposit from here.
      clearCircleSourceWalletRecovery(domain);
      setStatusFor(domain, "mismatch");
      return;
    }
    // Circle eventual consistency: keep the recovery, let the user retry.
    setStatusFor(domain, "missing");
    setNoticeFor(domain, t.wallet.gatewaySourcePrepareUncertain);
  }

  // Preparing a companion wallet creates a wallet and nothing else. It never
  // approves, deposits or transfers, for any chain.
  async function handlePrepareSourceWallet(domain: number) {
    let auth;
    try {
      auth = await ensureCircleFinancialAuth();
    } catch {
      setCircleReauthRequired(true);
      return;
    }
    setDepositError("");
    setNoticeFor(domain, "");
    setStatusFor(domain, "preparing");

    try {
      // Step 1: read current status. refreshCircleSourceWalletStatus already
      // sets the UI state and, on "ready", clears any stale recovery itself.
      const initial = await refreshCircleSourceWalletStatus(domain, auth.userToken);

      // READY is terminal: nothing left to prepare.
      if (initial === "ready") return;

      // MISMATCH is terminal and fail-closed: never proceed toward a wallet
      // creation attempt.
      if (initial === "mismatch") return;

      // Step 2: read recovery WITHOUT discarding it yet. Whether an expired
      // recovery may ever be cleared depends on what `initial` is, decided
      // in the branches below, never here.
      const storedRecovery = readCircleSourceWalletRecovery(domain);
      const recoveryExpired = Boolean(storedRecovery && isCircleSourceWalletRecoveryExpired(storedRecovery));

      // Step 5: ERROR. The prerequisite status read itself failed, so this
      // branch has NO evidence about whether the wallet exists. It must
      // never mint a new idempotency key, never discard an expired recovery,
      // and never start a brand-new prepare call.
      if (initial === "error") {
        if (storedRecovery && !recoveryExpired) {
          // A live recovery survives an unrelated read failure: resume it
          // exactly (same challenge if one exists, same idempotencyKey
          // otherwise), never a new one.
          await runSourceWalletChallenge(domain, auth.userToken, storedRecovery);
          return;
        }
        // No recovery, or the one that exists is expired: an errored read
        // proves nothing either way, so neither may be treated as safe to
        // start fresh. Surface a retry notice; no mutation of any kind.
        setStatusFor(domain, "error");
        setNoticeFor(domain, t.wallet.gatewaySourcePrepareUncertain);
        return;
      }

      // Step 6: MISSING. Only a definitive, successful "no wallet exists"
      // read may ever start a brand-new attempt or discard an expired
      // recovery.
      let recovery: CircleSourceWalletRecovery;
      if (storedRecovery && !recoveryExpired) {
        recovery = storedRecovery;
      } else {
        if (storedRecovery && recoveryExpired) {
          // Safe only because `initial === "missing"` just proved, via a
          // successful read, that no wallet exists on this chain: the
          // expired recovery cannot correspond to one that actually landed.
          clearCircleSourceWalletRecovery(domain);
        }
        recovery = {
          domain,
          idempotencyKey: crypto.randomUUID(),
          challengeId: null,
          expiresAtMs: Date.now() + SOURCE_WALLET_RECOVERY_TTL_MS,
        };
        storeCircleSourceWalletRecovery(recovery);
      }
      await runSourceWalletChallenge(domain, auth.userToken, recovery);
    } catch {
      // A genuine transport/API error before or during preparation: the
      // recovery (if any) is preserved so a retry resumes the same attempt.
      setStatusFor(domain, "error");
    }
  }

  useEffect(() => {
    if (executionMode !== "CIRCLE_USER_WALLET") {
      setDepositRecovery(null);
      return;
    }
    const recovery = readCircleGatewayDepositRecovery();
    if (!recovery) return;
    if (recovery.phase === "RECONCILING") {
      clearCircleGatewayDepositRecovery();
      setDepositRecovery(null);
      setDepositAmount("");
      return;
    }
    setDepositRecovery(recovery);
    setSelectedSourceDomain(String(recovery.sourceDomain));
    // The durable recovery amount is authoritative; seed the (disabled)
    // display field with it so it never shows empty/0.000000 while a real
    // recovery amount exists, matching the burn-signing recovery convention
    // above.
    setDepositAmount(formatGatewayUsdcRaw(recovery.amountRaw));
  }, [executionMode]);

  useEffect(() => {
    if (executionMode !== "EXTERNAL_WALLET") return;
    const recovery = readExternalGatewayDepositRecovery();
    if (!recovery) return;
    if (recovery.phase === "RECONCILING") {
      clearExternalGatewayDepositRecovery();
      setDepositRecovery(null);
      setDepositAmount("");
      return;
    }
    setDepositRecovery(recovery);
    setSelectedSourceDomain(String(recovery.sourceDomain));
    setDepositAmount(formatGatewayUsdcRaw(recovery.amountRaw));
  }, [executionMode]);

  useEffect(() => {
    if (walletStatus !== "ready" || !walletAddress || !executionMode) {
      setActivityItems([]);
      setActivityReadState("idle");
      setActivityStatusWarning("");
      return;
    }
    void refreshActivity();
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") void refreshActivity();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [executionMode, refreshActivity, walletAddress, walletStatus]);

  useEffect(() => {
    const hasBackgroundActivity = activityItems.some((item) => !item.terminal && !item.interactive);
    if (walletStatus !== "ready" || !walletAddress || !executionMode || !hasBackgroundActivity) return;
    if (document.visibilityState !== "visible") return;
    const timer = window.setTimeout(() => void refreshActivity(), 12_000);
    return () => window.clearTimeout(timer);
  }, [activityItems, executionMode, refreshActivity, walletAddress, walletStatus]);

  // A source transaction must be signed on its OWN chain. The request's chain
  // id is the authority: the wallet is switched to it and then re-read, so a
  // refused, ignored or partially applied switch fails closed instead of
  // signing a Base payload on Arc (or on any other chain).
  async function sendSourceChainTransaction(request: TransactionRequest): Promise<string> {
    if (!connectedAddress || connectedAddress.toLowerCase() !== request.from.toLowerCase()) {
      throw new Error("Reconnect the wallet bound to this EXTREMA session.");
    }
    if (!connectedConnector) {
      throw new Error("Reconnect the wallet bound to this EXTREMA session.");
    }
    const target = gatewaySourceChains.find((candidate) => candidate.id === request.chainId);
    if (!target) throw new Error("gateway_deposit_source_unsupported");

    if (chain?.id !== request.chainId) {
      await switchChainAsync({ chainId: request.chainId });
    }
    // Re-check the live connector, not React state: a chain switch is a wallet
    // side effect and may not have happened at all.
    const activeChainId = await connectedConnector.getChainId();
    if (activeChainId !== request.chainId) {
      throw new Error(withGatewayNetwork(t.wallet.gatewaySwitchNetwork, target.name));
    }
    // After a switch, the account may also have changed. Re-bind the session
    // identity before signing anything.
    const activeAccounts = await connectedConnector.getAccounts();
    if (!activeAccounts.some((account) => account.toLowerCase() === request.from.toLowerCase())) {
      throw new Error("Reconnect the wallet bound to this EXTREMA session.");
    }

    const sourceClient = sourcePublicClients[request.chainId];
    if (!sourceClient) throw new Error(t.wallet.gatewaySourceUnavailable);

    const hash = await sendTransactionAsync({
      account: connectedAddress,
      chainId: request.chainId,
      to: request.to as `0x${string}`,
      data: request.data as `0x${string}`,
      value: BigInt(request.value),
    });
    // Wait on the SOURCE chain, not Arc: the backend verifies this receipt.
    const receipt = await sourceClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Wallet transaction failed.");
    return hash;
  }

  async function handleGatewaySourceDeposit(selectedDomain: number) {
    // A live durable recovery is the authoritative financial intent: the
    // input is disabled and may be empty/stale while it exists, so the
    // amount (and source domain) must come from the recovery record itself,
    // never re-derived from the editable field. This also means clicking
    // "continue" resumes the SAME action (via confirmGatewaySourceDeposit's
    // own recovery lookup) rather than starting a new one.
    let sourceDomain: number;
    let amountRaw: string;
    if (depositRecovery) {
      // A recovery belongs to exactly one funding chain. Continuing it from a
      // different selected source would send the stored amount to the wrong source, so
      // that fails closed rather than being silently retargeted.
      if (depositRecovery.sourceDomain !== selectedDomain) {
        setDepositError(
          locale === "tr"
            ? "Kayıtlı işlem başka bir ağa ait. Güvenlik nedeniyle devam edilemiyor."
            : "The stored operation belongs to another network. Refusing to continue for safety.",
        );
        return;
      }
      if (!isConfiguredSourceDomain(depositRecovery.sourceDomain)) {
        setDepositError(
          locale === "tr"
            ? "Kayıtlı işlem beklenmeyen bir kaynağa ait. Güvenlik nedeniyle devam edilemiyor."
            : "The stored recovery targets an unexpected source. Refusing to continue for safety.",
        );
        return;
      }
      sourceDomain = depositRecovery.sourceDomain;
      amountRaw = depositRecovery.amountRaw;
    } else {
      if (!isConfiguredSourceDomain(selectedDomain)) {
        setDepositError(t.wallet.gatewaySourceUnavailable);
        return;
      }
      const parsed = parseGatewayUsdcRaw(depositAmount);
      if (!parsed) {
        setDepositError(t.wallet.gatewayAmountInvalid);
        return;
      }
      sourceDomain = selectedDomain;
      amountRaw = parsed;
    }

    setDepositBusy(true);
    setDepositError("");
    setDepositNotice("");
    setDepositStatus(null);
    function clearTerminalBrowserRecovery() {
      if (executionMode === "CIRCLE_USER_WALLET") clearCircleGatewayDepositRecovery();
      else clearExternalGatewayDepositRecovery();
      setDepositRecovery(null);
      setDepositAmount("");
    }
    function restoreBrowserRecovery() {
      const recovery = executionMode === "CIRCLE_USER_WALLET"
        ? readCircleGatewayDepositRecovery()
        : readExternalGatewayDepositRecovery();
      if (!recovery) return;
      setDepositRecovery(recovery);
      setSelectedSourceDomain(String(recovery.sourceDomain));
      setDepositAmount(formatGatewayUsdcRaw(recovery.amountRaw));
    }
    try {
      const result = await confirmGatewaySourceDeposit(
        { sourceDomain, amountRaw },
        {
          executionMode,
          sendExternalTransaction: sendSourceChainTransaction,
        },
        (phase) => {
          if (phase === "APPROVAL_REQUIRED" || phase === "APPROVAL_CHALLENGE") setDepositPhase("preparingApproval");
          else if (phase === "APPROVAL_PENDING") setDepositPhase("confirmApproval");
          else if (phase === "DEPOSIT_REQUIRED" || phase === "DEPOSIT_CHALLENGE") setDepositPhase("confirmDeposit");
          else if (phase === "DEPOSIT_PENDING") setDepositPhase("depositSubmitted");
          else if (phase === "RECONCILING") setDepositPhase("waitingFinality");
        },
      );
      if (result.recoveryDisposition === "CLEAR") {
        setDepositStatus(result);
        clearTerminalBrowserRecovery();
        if (result.state === "COMPLETED") {
          setDepositNotice(
            withGatewayAmount(
              t.wallet.gatewayDepositAddedToGateway,
              formatGatewayUsdcDisplay(formatGatewayUsdcRaw(result.amountRaw), locale),
            ),
          );
          void refreshGatewayBalance();
          void refreshSourceState();
        } else {
          setDepositError(
            result.state === "EXPIRED"
              ? t.wallet.gatewayDepositExpired
              : t.wallet.gatewayDepositStatusNeedsReview,
          );
        }
      } else if (result.state === "RECONCILING") {
        // Submission has crossed the interactive boundary. Activity now owns
        // read-only finality observation; release only this browser's form
        // lock and retain the durable backend action.
        clearInteractiveDepositRecovery();
        void refreshActivity();
      } else if (needsGatewayDepositRecoveryReview(result)) {
        restoreBrowserRecovery();
        setDepositStatus(result);
        // The ACTION column owns the single review message. Do not duplicate
        // it in the full-width error banner after a status-only response.
        setDepositError("");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (message === "circle_reauthentication_required") {
        // The application session is still ready, but the shared Circle auth
        // bootstrap could not restore this tab's credentials (no stored
        // refresh, or the restored identity no longer matches the session).
        // This is not a Gateway deposit failure at all: no financial start
        // call was ever made. Route to the same Circle reauthentication UI
        // the rest of the page already uses, never the generic message.
        setCircleReauthRequired(true);
      } else if (message === "gateway_deposit_expired") {
        // Expiry is not a proof that a source-chain or Circle action did not
        // land. Preserve the same durable recovery and require a later
        // read-only status reconciliation rather than opening a new deposit.
        setDepositError(t.wallet.gatewayDepositExpired);
      } else if (message === "gateway_deposit_pending_timeout") {
        setDepositError(t.wallet.gatewayDepositStatusNeedsReview);
      } else if (message === "gateway_deposit_approval_status_pending") {
        restoreBrowserRecovery();
        setDepositError(t.wallet.gatewayApprovalStatusPending);
      } else if (message === "gateway_deposit_source_review_required") {
        // A lost browser recovery must never be read as license to start a
        // second concurrent action for the same source domain: the backend
        // already refused before creating anything. This is a distinct,
        // explicit message, never the generic deposit-failed one.
        setDepositError(t.wallet.gatewayDepositSourceReviewRequired);
      } else {
        setDepositError(
          t.wallet.gatewayDepositCouldNotComplete,
        );
      }
    } finally {
      setDepositBusy(false);
      setDepositPhase("");
    }
  }

  // A backend disposition is authoritative. Interactive recovery remains
  // locked until the same action is resumed or a clean CLEAR response arrives.
  // RECONCILING is intentionally absent here: it belongs to Activity and must
  // not globally lock a fresh deposit from another source.
  const depositRecoveryNeedsReview = Boolean(
    depositRecovery && depositStatus && needsGatewayDepositRecoveryReview(depositStatus),
  );
  const selectedGatewaySource = sourceState?.sources.find(
    (source) => String(source.domain) === selectedSourceDomain,
  ) || null;
  const backgroundFinalityItem = activityItems.find(
    (item) => item.state === "RECONCILING" && !item.terminal,
  ) || null;
  const selectedSourceFinalityItem = selectedSourceDomain
    ? activityItems.find(
      (item) => item.state === "RECONCILING" && !item.terminal &&
        String(item.sourceDomain) === selectedSourceDomain,
    ) || null
    : null;

  function activityPhaseCopy(phase: GatewayDepositActivityItem["phase"]) {
    switch (phase) {
      case "APPROVAL_PREPARING": return t.wallet.gatewayActivityApprovalPreparing;
      case "APPROVAL_REQUIRED": return t.wallet.gatewayActivityApprovalRequired;
      case "APPROVAL_SUBMITTED": return t.wallet.gatewayActivityApprovalSubmitted;
      case "DEPOSIT_PREPARING": return t.wallet.gatewayActivityDepositPreparing;
      case "DEPOSIT_CONFIRMATION_REQUIRED": return t.wallet.gatewayActivityDepositConfirmationRequired;
      case "DEPOSIT_SUBMITTED": return t.wallet.gatewayActivityDepositSubmitted;
      case "GATEWAY_FINALITY": return t.wallet.gatewayActivityWaitingFinality;
      case "COMPLETED": return t.wallet.gatewayActivityCompleted;
      case "NEEDS_REVIEW": return t.wallet.gatewayActivityNeedsReview;
      case "FAILED": return t.wallet.gatewayActivityFailed;
      case "EXPIRED": return t.wallet.gatewayActivityExpired;
    }
  }

  function activityStageState(item: GatewayDepositActivityItem, stage: "APPROVAL" | "DEPOSIT" | "FINALITY" | "COMPLETED") {
    if (item.terminal || item.stage === "COMPLETED") return "complete";
    if (item.stage === "REVIEW" || item.stage === "FAILED" || item.stage === "EXPIRED") {
      return stage === "DEPOSIT" ? "attention" : "pending";
    }
    const order = { APPROVAL: 0, DEPOSIT: 1, FINALITY: 2, COMPLETED: 3 };
    const active = item.stage === "FINALITY" ? order.FINALITY : order[item.stage as "APPROVAL" | "DEPOSIT"];
    if (order[stage] < active) return "complete";
    if (order[stage] === active) return "active";
    return "pending";
  }

  const activityOpenCount = activityItems.filter((item) => !item.terminal).length;

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
    setBusy(t.wallet.restoringCircleSession);
    try {
      let session: Awaited<ReturnType<typeof backendApi.circle.session>>;
      if (auth) {
        try {
          session = await backendApi.circle.session(auth.userToken);
        } catch {
          const refreshed = await backendApi.circle.refreshSession(
            await getCircleDeviceId(),
          );
          storeCircleTabAuth({
            userToken: refreshed.userToken,
            encryptionKey: refreshed.encryptionKey,
          });
          session = refreshed;
        }
      } else {
        const refreshed = await backendApi.circle.refreshSession(
          await getCircleDeviceId(),
        );
        storeCircleTabAuth({
          userToken: refreshed.userToken,
          encryptionKey: refreshed.encryptionKey,
        });
        session = refreshed;
      }
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

  // The destination list is server owned. Until it arrives there is nothing to
  // choose from, which is also why the UI never hardcodes a network.
  const gatewayDestinations: GatewayNetwork[] = gateway?.destinations || [];
  const selectedDestination = gatewayDestinations.find(
    (item) => String(item.domain) === gatewayDestinationDomain,
  ) || gatewayDestinations[0] || null;

  // Spendable unified balance, summed by the server across every domain it can
  // actually burn from. One number: the product model is one balance, so the
  // UI never breaks it down per source.
  const gatewaySpendableRaw = gateway?.transferableTotalRaw || "0";
  const gatewayCanPrepare = Boolean(gatewayFundingRecovery) || (
    gatewayReadState === "ready" && hasPositiveRawAmount(gatewaySpendableRaw)
  );

  async function handleGatewayTransfer() {
    if (!selectedDestination && !gatewayFundingRecovery) return;
    // A live recovery is the authoritative intent, exactly as for a deposit:
    // the inputs are disabled while it exists, so both the amount and the
    // destination come from the record rather than the editable fields.
    const valueRaw = gatewayFundingRecovery?.valueRaw || parseGatewayUsdcRaw(gatewayAmount);
    if (!valueRaw) {
      setGatewayFundingError(t.wallet.gatewayAmountInvalid);
      return;
    }
    const destinationDomain = gatewayFundingRecovery?.destinationDomain
      ?? selectedDestination!.domain;
    // A restored destination must still be one the server offers, or the
    // stored intent is not something this session can safely continue.
    if (
      gatewayFundingRecovery &&
      gatewayDestinations.length > 0 &&
      !gatewayDestinations.some((item) => item.domain === destinationDomain)
    ) {
      setGatewayFundingError(t.wallet.gatewayTransferPreparationFailed);
      return;
    }
    // Only the total spendable balance is checked here, because the server
    // decides which sources are drawn. A local per source check would
    // reintroduce exactly the single source assumption the unified balance
    // model removes. The server is the authority either way.
    if (!gatewayFundingRecovery && BigInt(valueRaw) > BigInt(gatewaySpendableRaw)) {
      setGatewayFundingError(
        locale === "tr"
          ? "Tutar kullanılabilir Gateway bakiyeni aşıyor."
          : "Amount exceeds your available Gateway balance.",
      );
      return;
    }

    setGatewayFundingBusy(true);
    setGatewaySignStep(null);
    setGatewayFundingError("");
    setGatewayFundingNotice("");
    try {
      const result = await confirmGatewayBurnSignature(
        { destinationDomain, valueRaw },
        { executionMode, signTypedData: (typedData) => signTypedDataAsync(typedData) },
        // A multi-source plan asks for one approval per source draw. Report
        // progress honestly rather than showing one indeterminate spinner.
        (signed, total) => setGatewaySignStep({ step: signed + 1, total }),
      );
      setGatewayFundingStatus(result);
      if (!result.readyToBroadcast || result.broadcast !== "NOT_SUBMITTED") {
        throw new Error("gateway_signature_challenge_unavailable");
      }
      setGatewayFundingRecovery(null);
      setGatewayFundingNotice(t.wallet.gatewayTransferPrepared);
    } catch (cause) {
      // Same rule as the source deposit path: a Circle auth restore failure
      // is not a transfer preparation failure at all, and no financial start
      // call was ever made. Route to the existing reauthentication UI.
      if (cause instanceof Error && cause.message === "circle_reauthentication_required") {
        setCircleReauthRequired(true);
      } else {
        setGatewayFundingError(t.wallet.gatewayTransferPreparationFailed);
      }
    } finally {
      setGatewayFundingBusy(false);
      setGatewaySignStep(null);
    }
  }

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
                <div className="ex-wallet-address__actions">
                  <button className="ex-btn ex-btn--ghost" type="button" onClick={copyExtremaAddress}>
                    {copiedAddress ? t.wallet.copied : t.wallet.copyAddress}
                  </button>
                  <button className="ex-btn ex-btn--ghost" type="button" onClick={handleLock}>
                    {executionMode === "CIRCLE_USER_WALLET" ? t.wallet.endSession : t.wallet.disconnectWallet}
                  </button>
                </div>
              </div>

              <div className="ex-wallet-activity">
                <button
                  className="ex-wallet-activity__toggle ex-btn ex-btn--ghost"
                  type="button"
                  aria-expanded={activityOpen}
                  aria-controls="wallet-activity"
                  onClick={() => setActivityOpen((open) => !open)}
                >
                  {t.wallet.gatewayActivity} · {activityOpenCount}
                </button>
                {activityOpen && (
                  <section id="wallet-activity" className="ex-wallet-activity__panel" aria-label={t.wallet.gatewayActivityAriaLabel}>
                    <div className="ex-wallet-activity__heading">
                      <h2>{t.wallet.gatewayActivity}</h2>
                      <button
                        className="ex-wallet-activity__close"
                        type="button"
                        onClick={() => setActivityOpen(false)}
                      >
                        {t.wallet.gatewayActivityClose}
                      </button>
                    </div>
                    {activityReadState === "delayed" && (
                      <p className="ex-entry__msg" data-tone="error" aria-live="polite">
                        {activityStatusWarning || t.wallet.gatewayFinalityStatusDelayed}
                      </p>
                    )}
                    {activityItems.length === 0 ? (
                      <p className="ex-wallet-activity__empty">{t.wallet.gatewayActivityNoRecent}</p>
                    ) : (
                      <ol className="ex-wallet-activity__list">
                        {activityItems.map((item) => (
                          <li className="ex-wallet-activity__item" key={item.actionId}>
                            <div className="ex-wallet-activity__top">
                              <span className="ex-wallet-activity__network">{item.sourceLabel}</span>
                              <span className="ex-wallet-activity__amount ex-num">
                                {formatGatewayUsdcDisplay(formatGatewayUsdcRaw(item.amountRaw), locale)} USDC
                              </span>
                            </div>
                            <div className="ex-wallet-activity__meta">
                              <span>{activityPhaseCopy(item.phase)}</span>
                              <span data-tone={item.actionRequired ? "error" : "muted"}>
                                {item.actionRequired ? t.wallet.gatewayActivityActionRequired : t.wallet.gatewayActivityNoAction}
                              </span>
                            </div>
                            <ol className="ex-wallet-activity__stages" aria-label={t.wallet.gatewayActivityAriaLabel}>
                              <li data-state={activityStageState(item, "APPROVAL")}>{t.wallet.gatewayActivityApproval}</li>
                              <li data-state={activityStageState(item, "DEPOSIT")}>{t.wallet.gatewayActivityDeposit}</li>
                              <li data-state={activityStageState(item, "FINALITY")}>{t.wallet.gatewayActivityFinality}</li>
                              <li data-state={activityStageState(item, "COMPLETED")}>{t.wallet.gatewayActivityCompleted}</li>
                            </ol>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                )}
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
                  data-columns="2"
                >
                  <div className="ex-wallet-summary__item">
                    <span>{t.wallet.chainNetwork}</span>
                    <strong className="ex-num">
                      {executionMode === "EXTERNAL_WALLET"
                        ? (chain ? chain.name : t.wallet.notConnected)
                        : chainState.chain.name}
                    </strong>
                  </div>

                  <div className="ex-wallet-summary__item">
                    <span>{t.wallet.usdcBalance}</span>
                    <strong className="ex-num">
                      {chainState.usdc.balanceFormatted} {chainState.usdc.symbol}
                    </strong>
                  </div>

                </div>
              ) : (
                <p className="ex-wallet-ledger__pending">{chainBusy || t.wallet.balanceNotLoaded}</p>
              )}

              {!sessionNeedsAuth && chainError && <p className="ex-entry__msg" data-tone="error">{chainError}</p>}

              {/* A: the unified balance and where to send it. There is no
                  source selector here on purpose: Gateway is one balance and
                  the server decides which deposited balances pay for a
                  transfer. */}
              <section className="ex-wallet-gateway" aria-label={t.wallet.gatewayFundingAriaLabel}>
                  <div>
                    <p className="ex-eyebrow">{t.wallet.gateway}</p>
                    {gatewayReadState === "ready" && gateway && (
                      <p className="ex-gateway-unified">
                        <strong className="ex-num">
                          {formatGatewayUsdcDisplay(gateway.transferableTotalUsdc, locale)} {gateway.token}
                        </strong>
                        <span>{t.wallet.gatewayUnifiedBalance}</span>
                      </p>
                    )}
                    <h3>{t.wallet.gatewayPrepareTitle}</h3>
                    {gatewayReadState === "loading" || gatewayReadState === "idle" ? (
                      <p>{t.wallet.gatewayReading}</p>
                    ) : gatewayReadState === "error" ? (
                      <>
                        <p className="ex-entry__msg" data-tone="error" aria-live="polite">
                          {t.wallet.gatewayBalanceUnavailable}
                        </p>
                        <button
                          className="ex-btn ex-btn--ghost"
                          type="button"
                          onClick={() => void refreshGatewayBalance()}
                        >
                          {t.wallet.gatewayRetry}
                        </button>
                      </>
                    ) : gatewayCanPrepare ? (
                      <p>{t.wallet.gatewayPrepareBody}</p>
                    ) : (
                      <p>{t.wallet.gatewayNoTransferableBalance}</p>
                    )}
                  </div>
                  {gatewayCanPrepare && (
                    <div className="ex-wallet-gateway__controls">
                      <label>
                        <span>{t.wallet.gatewayDestination}</span>
                        <select
                          value={selectedDestination ? String(selectedDestination.domain) : ""}
                          onPointerDown={(event) => markSelectPointerIntent(destinationPointerIntent, event)}
                          onKeyDown={() => clearSelectPointerIntent(destinationPointerIntent)}
                          onChange={(event) => {
                            const select = event.currentTarget;
                            // Product state first; focus handling never
                            // precedes or replaces the destination update.
                            setGatewayDestinationDomain(event.target.value);
                            blurAfterPointerSelectChange(destinationPointerIntent, select);
                          }}
                          onBlur={() => clearSelectPointerIntent(destinationPointerIntent)}
                          disabled={gatewayFundingBusy || Boolean(gatewayFundingRecovery)}
                        >
                          {gatewayDestinations.map((item) => (
                            <option key={item.domain} value={item.domain}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>{t.wallet.gatewayAmount}</span>
                        <input
                          inputMode="decimal"
                          placeholder="0.00"
                          value={gatewayAmount}
                          onChange={(event) => setGatewayAmount(event.target.value)}
                          disabled={gatewayFundingBusy || Boolean(gatewayFundingRecovery)}
                        />
                      </label>
                      <button
                        className="ex-btn ex-btn--ink"
                        type="button"
                        onClick={handleGatewayTransfer}
                        disabled={gatewayFundingBusy || Boolean(gatewayFundingStatus && gatewayFundingStatus.state !== "SIGNATURE_PENDING")}
                      >
                        {gatewayFundingBusy
                          ? (gatewaySignStep && gatewaySignStep.total > 1
                            ? withGatewayStep(t.wallet.gatewaySigningStep, gatewaySignStep.step, gatewaySignStep.total)
                            : t.wallet.gatewayPreparingSignature)
                          : gatewayFundingStatus?.readyToBroadcast === true
                            ? t.wallet.gatewayTransferPrepared
                          : gatewayFundingRecovery
                            ? t.wallet.gatewayResumeSignature
                            : t.wallet.gatewayPrepareSignature}
                      </button>
                    </div>
                  )}
                  {gatewayFundingNotice && <p className="ex-entry__msg" data-tone="ok">{gatewayFundingNotice}</p>}
                  {gatewayFundingError && <p className="ex-entry__msg" data-tone="error">{gatewayFundingError}</p>}
                </section>

                {/* B: fund the unified balance from one selected source wallet.
                    Its available amount is never the Gateway unified balance above. */}
                <section className="ex-wallet-gateway" aria-label={t.wallet.gatewayDepositAriaLabel}>
                  <div>
                    <p className="ex-eyebrow">{t.wallet.gatewayAddTitle}</p>
                    <p>{t.wallet.gatewayAddBody}</p>
                  </div>

                  {backgroundFinalityItem && (
                    <p className="ex-entry__msg" data-tone="ok" aria-live="polite">
                      {withGatewayNetwork(
                        withGatewayAmount(
                          t.wallet.gatewayFinalityFormNotice,
                          formatGatewayUsdcDisplay(
                            formatGatewayUsdcRaw(backgroundFinalityItem.amountRaw), locale,
                          ),
                        ),
                        backgroundFinalityItem.sourceLabel,
                      )}
                    </p>
                  )}

                  {sourceReadState === "error" ? (
                    <div>
                      <p className="ex-entry__msg" data-tone="error" aria-live="polite">
                        {t.wallet.gatewaySourceUnavailable}
                      </p>
                      <button
                        className="ex-btn ex-btn--ghost"
                        type="button"
                        onClick={() => void refreshSourceState()}
                      >
                        {t.wallet.gatewayRetry}
                      </button>
                    </div>
                  ) : sourceReadState !== "ready" || !sourceState ? (
                    <p>{t.wallet.gatewaySourceReading}</p>
                  ) : (
                    <div className="ex-gateway-deposit-form">
                      <label>
                        <span>{t.wallet.gatewaySource}</span>
                        <select
                          value={selectedGatewaySource ? String(selectedGatewaySource.domain) : ""}
                          onPointerDown={(event) => markSelectPointerIntent(sourcePointerIntent, event)}
                          onKeyDown={() => clearSelectPointerIntent(sourcePointerIntent)}
                          onChange={(event) => {
                            const select = event.currentTarget;
                            // Funding state first, unchanged: switch source,
                            // then clear the editable amount and the local
                            // deposit status so nothing carries across chains.
                            setSelectedSourceDomain(event.target.value);
                            setDepositAmount("");
                            setDepositStatus(null);
                            setDepositError("");
                            setDepositNotice("");
                            // Focus handling last, and only for a committed
                            // pointer selection.
                            blurAfterPointerSelectChange(sourcePointerIntent, select);
                          }}
                          onBlur={() => clearSelectPointerIntent(sourcePointerIntent)}
                          disabled={depositBusy || Boolean(depositRecovery)}
                        >
                          {sourceState.sources.map((source) => (
                            <option key={source.domain} value={source.domain}>{source.label}</option>
                          ))}
                        </select>
                      </label>

                      <div className="ex-gateway-deposit-form__available">
                        <span>{t.wallet.gatewayAvailable}</span>
                        {selectedGatewaySource?.state === "error" ? (
                          <p>{t.wallet.gatewaySourceUnavailable}</p>
                        ) : selectedGatewaySource?.balanceRaw !== null && selectedGatewaySource ? (
                          <p className="ex-num">
                            {withGatewayAmount(
                              t.wallet.gatewaySourceAvailable,
                              formatGatewayUsdcDisplay(formatGatewayUsdcRaw(selectedGatewaySource.balanceRaw), locale),
                            )}
                          </p>
                        ) : (
                          <p>{t.wallet.gatewaySourceReading}</p>
                        )}
                      </div>

                      <label>
                        <span>{t.wallet.gatewayDepositAmount}</span>
                        <input
                          inputMode="decimal"
                          placeholder="0.00"
                          value={depositAmount}
                          onChange={(event) => setDepositAmount(event.target.value)}
                          disabled={
                            depositBusy || Boolean(depositRecovery) ||
                            !selectedGatewaySource || selectedGatewaySource.state === "error"
                          }
                        />
                      </label>

                      <div className="ex-gateway-deposit-form__action">
                        <span>{t.wallet.gatewayAction}</span>
                        {!selectedGatewaySource ? null : selectedGatewaySource.state === "error" ? (
                          <button className="ex-btn ex-btn--ghost" type="button" onClick={() => void refreshSourceState()}>
                            {t.wallet.gatewayRetry}
                          </button>
                        ) : selectedSourceFinalityItem ? (
                          <p className="ex-gateway-deposit-form__hint">
                            {t.wallet.gatewayFinalitySourceHint}
                          </p>
                        ) : executionMode === "CIRCLE_USER_WALLET" && (
                          sourceWalletStatus[selectedGatewaySource.domain] === "idle" ||
                          sourceWalletStatus[selectedGatewaySource.domain] === "checking" ||
                          sourceWalletStatus[selectedGatewaySource.domain] === "preparing"
                        ) ? (
                          <p className="ex-gateway-deposit-form__hint">{t.wallet.gatewayPreparingWallet}</p>
                        ) : executionMode === "CIRCLE_USER_WALLET" && sourceWalletStatus[selectedGatewaySource.domain] === "missing" ? (
                          <>
                            <p className="ex-gateway-deposit-form__hint">{t.wallet.gatewayWalletNotPrepared}</p>
                            {sourceWalletNotice[selectedGatewaySource.domain] && (
                              <p className="ex-entry__msg" aria-live="polite">{sourceWalletNotice[selectedGatewaySource.domain]}</p>
                            )}
                            <button
                              className="ex-btn ex-btn--ink"
                              type="button"
                              onClick={() => void handlePrepareSourceWallet(selectedGatewaySource.domain)}
                            >
                              {sourceWalletNotice[selectedGatewaySource.domain]
                                ? t.wallet.gatewayResumeSourceWallet
                                : t.wallet.gatewayPrepareWallet}
                            </button>
                          </>
                        ) : executionMode === "CIRCLE_USER_WALLET" && sourceWalletStatus[selectedGatewaySource.domain] === "mismatch" ? (
                          <p className="ex-entry__msg" data-tone="error">{t.wallet.gatewaySourceWalletMismatch}</p>
                        ) : executionMode === "CIRCLE_USER_WALLET" && sourceWalletStatus[selectedGatewaySource.domain] === "error" ? (
                          <>
                            <p className="ex-entry__msg" data-tone="error">{t.wallet.gatewaySourcePrepareUncertain}</p>
                            <button
                              className="ex-btn ex-btn--ghost"
                              type="button"
                              onClick={() => void handlePrepareSourceWallet(selectedGatewaySource.domain)}
                            >
                              {t.wallet.gatewayRetry}
                            </button>
                          </>
                        ) : depositRecoveryNeedsReview ? (
                          <p className="ex-gateway-deposit-form__hint">
                            {depositStatus?.state === "EXPIRED"
                              ? t.wallet.gatewayDepositExpired
                              : t.wallet.gatewayDepositStatusNeedsReview}
                          </p>
                        ) : (
                          <button
                            className="ex-btn ex-btn--ink"
                            type="button"
                            onClick={() => void handleGatewaySourceDeposit(selectedGatewaySource.domain)}
                            disabled={depositBusy}
                          >
                            {depositBusy
                              ? (depositPhase === "preparingApproval" ? t.wallet.gatewayPreparingApproval
                                : depositPhase === "confirmApproval" ? (executionMode === "CIRCLE_USER_WALLET" ? t.wallet.gatewayConfirmApprovalCircle : t.wallet.gatewayConfirmApprovalWallet)
                                : depositPhase === "confirmDeposit" ? t.wallet.gatewayConfirmDeposit
                                : depositPhase === "depositSubmitted" ? t.wallet.gatewayDepositSubmitted
                                : depositPhase === "waitingFinality" ? t.wallet.gatewayWaitingFinality
                                : depositRecovery ? t.wallet.gatewayRecoveringOperation
                                : t.wallet.gatewayReading)
                              : depositRecovery
                                ? t.wallet.gatewayResumeDeposit
                                : t.wallet.gatewayAddToGateway}
                          </button>
                        )}
                      </div>

                    </div>
                  )}

                  {depositNotice && <p className="ex-entry__msg" data-tone="ok">{depositNotice}</p>}
                  {depositError && <p className="ex-entry__msg" data-tone="error">{depositError}</p>}
                </section>

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
                    void refreshGatewayBalance();
                    void refreshSourceState();
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
