"use client";

import { useEffect, useState } from "react";
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
import { arcTestnet, baseSepolia } from "../lib/web3";
import { shortAddress, useWalletSession } from "../wallet-session";
import { backendApi, isAuthSessionError, type GatewayFundingResponse, type TransactionRequest } from "../lib/backend-api";
import {
  readCircleGatewayFundingRecovery,
  readCircleGatewayDepositRecovery,
  readExternalGatewayDepositRecovery,
  readCircleTabAuth,
  readCircleBaseWalletRecovery,
  storeCircleBaseWalletRecovery,
  clearCircleBaseWalletRecovery,
  type CircleGatewayFundingRecovery,
  type CircleGatewayDepositRecovery,
  type ExternalGatewayDepositRecovery,
  type CircleBaseWalletRecovery,
} from "../lib/circle-auth";
import { confirmGatewayBaseDeposit, confirmGatewayBurnSignature } from "../lib/gateway-actions";
import { executeHostedChallenge } from "../lib/circle-actions";
import { useCopy, useLocale } from "../i18n";
import { CircleWalletOnboarding } from "../circle-wallet-onboarding";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { assetConfigs } from "../lib/asset-config";
import { readBinanceLiveMarket } from "../lib/live-market";

// Two entry choices only: Circle (Google or email) or a connected EVM
// wallet. "choice" is the connected wallet's single login signature.
type Step = "owner" | "choice" | "ready";
type GatewayReadState = "idle" | "loading" | "ready" | "error";

// The single configured Gateway deposit source. Config driven so ETH
// Sepolia / Arbitrum Sepolia / OP Sepolia can be added later as more map
// entries instead of scattering chain magic numbers through this page.
const BASE_SEPOLIA_SOURCE = {
  domain: 6,
  chainId: baseSepolia.id,
  label: "Base Sepolia",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
} as const;

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }],
  },
] as const;

const BASE_WALLET_RECOVERY_TTL_MS = 30 * 60 * 1000;
// Circle's own eventual consistency after a completed challenge, not a
// network retry budget: bounded, read-only, no createWallet call in here.
const BASE_WALLET_RECONCILE_ATTEMPTS = 5;
const BASE_WALLET_RECONCILE_INTERVAL_MS = 3000;

function isCircleBaseWalletRecoveryExpired(recovery: CircleBaseWalletRecovery) {
  return recovery.expiresAtMs <= Date.now();
}

type BaseWalletStatus = "idle" | "checking" | "ready" | "missing" | "preparing" | "mismatch" | "error";
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
  const baseSepoliaPublicClient = usePublicClient({ chainId: baseSepolia.id });

  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(walletStatus === "ready" ? "ready" : "owner");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [chainState, setChainState] = useState<Awaited<ReturnType<typeof backendApi.wallet.chainState>> | null>(null);
  const [chainBusy, setChainBusy] = useState("");
  const [chainError, setChainError] = useState("");
  const [gateway, setGateway] = useState<Awaited<ReturnType<typeof backendApi.wallet.gatewayBalance>> | null>(null);
  const [gatewayReadState, setGatewayReadState] = useState<GatewayReadState>("idle");
  const [gatewaySourceDomain, setGatewaySourceDomain] = useState("");
  const [gatewayAmount, setGatewayAmount] = useState("");
  const [gatewayFundingBusy, setGatewayFundingBusy] = useState(false);
  const [gatewayFundingNotice, setGatewayFundingNotice] = useState("");
  const [gatewayFundingError, setGatewayFundingError] = useState("");
  const [gatewayFundingRecovery, setGatewayFundingRecovery] = useState<CircleGatewayFundingRecovery | null>(null);
  const [gatewayFundingStatus, setGatewayFundingStatus] = useState<GatewayFundingResponse | null>(null);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [sessionNeedsAuth, setSessionNeedsAuth] = useState(false);
  const [walletNotice, setWalletNotice] = useState("");
  // A Circle session whose stored Circle login can no longer refresh it
  // falls back to the Circle Google or email sign in, never to another method.
  const [circleReauthRequired, setCircleReauthRequired] = useState(false);

  // Base Sepolia source deposit (Circle wallet readiness, source balance, and
  // the approve/deposit action itself). Distinct from the Gateway funding
  // signature above: this is what gets USDC into the unified balance.
  const [baseWalletStatus, setBaseWalletStatus] = useState<BaseWalletStatus>("idle");
  const [baseUsdcRaw, setBaseUsdcRaw] = useState<string | null>(null);
  const [baseReadError, setBaseReadError] = useState("");
  const [baseWalletNotice, setBaseWalletNotice] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositPhase, setDepositPhase] = useState<DepositPhaseLabel>("");
  const [depositError, setDepositError] = useState("");
  const [depositNotice, setDepositNotice] = useState("");
  const [depositRecovery, setDepositRecovery] = useState<
    CircleGatewayDepositRecovery | ExternalGatewayDepositRecovery | null
  >(null);

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

  useEffect(() => {
    if (executionMode !== "CIRCLE_USER_WALLET") {
      setGatewayFundingRecovery(null);
      setGatewayFundingStatus(null);
      return;
    }
    const recovery = readCircleGatewayFundingRecovery();
    if (!recovery) return;
    setGatewayFundingRecovery(recovery);
    setGatewaySourceDomain(String(recovery.sourceDomain));
    setGatewayAmount(formatGatewayUsdcRaw(recovery.valueRaw));
  }, [executionMode]);

  useEffect(() => {
    const actionId = gatewayFundingRecovery?.actionId;
    if (executionMode !== "CIRCLE_USER_WALLET" || !actionId) return;
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

  // Base Sepolia source balance is a public read for the session's own
  // address, so it works identically for both execution modes and needs no
  // wallet connection: it uses the read-only Base Sepolia transport wagmi
  // already carries for this chain.
  async function refreshBaseSourceState() {
    if (!walletAddress || !baseSepoliaPublicClient) return;
    setBaseReadError("");
    try {
      const balanceRaw = await baseSepoliaPublicClient.readContract({
        address: BASE_SEPOLIA_SOURCE.usdc as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [walletAddress as `0x${string}`],
      });
      setBaseUsdcRaw(balanceRaw.toString());
    } catch {
      setBaseUsdcRaw(null);
      setBaseReadError(t.wallet.gatewayBaseUnavailable);
    }
  }

  // Single read-only check. Safe to call on page load: it never touches
  // recovery storage and never calls createWallet.
  async function refreshCircleBaseWalletStatus(userToken: string): Promise<BaseWalletStatus> {
    setBaseWalletStatus("checking");
    try {
      const result = await backendApi.circle.baseSepoliaWallet(userToken);
      if (!result.wallet) {
        setBaseWalletStatus("missing");
        return "missing";
      }
      if (result.wallet.address.toLowerCase() !== result.arcAddress.toLowerCase()) {
        setBaseWalletStatus("mismatch");
        return "mismatch";
      }
      // The Base EOA already exists and matches the Arc session: any earlier
      // recovery attempt is stale.
      clearCircleBaseWalletRecovery();
      setBaseWalletStatus("ready");
      return "ready";
    } catch {
      setBaseWalletStatus("error");
      return "error";
    }
  }

  // Circle can briefly lag between a challenge completing and the wallet
  // showing up in a listing. Bounded, read-only retries only: no createWallet
  // call is ever made from here. Returns "missing" only once a read
  // definitively reported no wallet; "error" if every read attempt failed
  // transiently, so a genuinely uncertain outcome is never treated as a
  // confirmed non-landing.
  async function reconcileBaseWalletReadOnly(
    userToken: string,
  ): Promise<"ready" | "mismatch" | "missing" | "error"> {
    let sawDefinitiveMissing = false;
    for (let attempt = 0; attempt < BASE_WALLET_RECONCILE_ATTEMPTS; attempt += 1) {
      try {
        const result = await backendApi.circle.baseSepoliaWallet(userToken);
        if (result.wallet) {
          return result.wallet.address.toLowerCase() === result.arcAddress.toLowerCase()
            ? "ready"
            : "mismatch";
        }
        sawDefinitiveMissing = true;
      } catch {
        // Transient read failure; keep retrying within the bounded window.
      }
      if (attempt < BASE_WALLET_RECONCILE_ATTEMPTS - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, BASE_WALLET_RECONCILE_INTERVAL_MS));
      }
    }
    return sawDefinitiveMissing ? "missing" : "error";
  }

  useEffect(() => {
    if (step !== "ready" || walletStatus !== "ready" || !walletAddress) return;
    if (executionMode !== "CIRCLE_USER_WALLET" && executionMode !== "EXTERNAL_WALLET") return;
    void refreshBaseSourceState();
    if (executionMode === "EXTERNAL_WALLET") setBaseWalletStatus("ready");
  }, [step, walletStatus, walletAddress, executionMode]);

  useEffect(() => {
    if (executionMode !== "CIRCLE_USER_WALLET" || baseWalletStatus !== "idle") return;
    const auth = readCircleTabAuth();
    if (!auth) return;
    void refreshCircleBaseWalletStatus(auth.userToken);
  }, [executionMode, baseWalletStatus]);

  // Durable, idempotent Base Sepolia wallet preparation. Never mints a new
  // Circle idempotency key while a non-expired recovery already has one, and
  // never re-executes a hosted challenge once it exists: only an explicit
  // user click ever reaches executeHostedChallenge.
  // Shared tail for both the ERROR-with-live-recovery path and the MISSING
  // path: resolve (or reuse) a challenge id for the GIVEN recovery, execute
  // it, and reconcile. Never mints an idempotency key itself, so a caller
  // that hands it an existing recovery can never trigger a new one here.
  async function runBaseWalletChallenge(userToken: string, initialRecovery: CircleBaseWalletRecovery) {
    let recovery = initialRecovery;
    let challengeId = recovery.challengeId;
    if (!challengeId) {
      // The same idempotencyKey survives a lost HTTP response: a retry
      // reaches the SAME Circle challenge instead of creating another one.
      const prepared = await backendApi.circle.prepareBaseSepoliaWallet(
        userToken,
        recovery.idempotencyKey,
      );
      if (prepared.status === "EXISTING") {
        clearCircleBaseWalletRecovery();
        setBaseWalletStatus("ready");
        return;
      }
      if (typeof prepared.challengeId !== "string" || !prepared.challengeId) {
        throw new Error("circle_base_sepolia_challenge_missing");
      }
      challengeId = prepared.challengeId;
      // D: persist the challenge id BEFORE executing it, so a page reload
      // between this write and hosted-challenge completion resumes the
      // SAME challenge rather than creating a second one.
      recovery = { ...recovery, challengeId };
      storeCircleBaseWalletRecovery(recovery);
    }

    // D: exactly the shared hosted challenge executor; never a second
    // implementation.
    try {
      await executeHostedChallenge(challengeId);
    } catch (challengeError) {
      // H: a reported failure/expiry might still have landed just before
      // it; check read-only before ever deciding it definitely did not.
      const reconciled = await reconcileBaseWalletReadOnly(userToken);
      if (reconciled === "ready") {
        clearCircleBaseWalletRecovery();
        setBaseWalletStatus("ready");
        return;
      }
      if (reconciled === "mismatch") {
        clearCircleBaseWalletRecovery();
        setBaseWalletStatus("mismatch");
        return;
      }
      const message = challengeError instanceof Error ? challengeError.message : "";
      if (message === "circle_transaction_failed" && reconciled === "missing") {
        // Definitely did not land: safe to let the user explicitly restart.
        clearCircleBaseWalletRecovery();
        setBaseWalletStatus("missing");
        setBaseWalletNotice(t.wallet.gatewayBasePrepareFailed);
        return;
      }
      // Uncertain outcome (transient reads, or a non-terminal SDK error):
      // keep the SAME recovery so the next explicit click resumes it.
      setBaseWalletStatus("missing");
      setBaseWalletNotice(t.wallet.gatewayBasePrepareUncertain);
      return;
    }

    // E: hosted challenge reported success; reconcile read-only, bounded,
    // no additional createWallet call.
    const reconciled = await reconcileBaseWalletReadOnly(userToken);
    if (reconciled === "ready") {
      // F
      clearCircleBaseWalletRecovery();
      setBaseWalletStatus("ready");
      return;
    }
    if (reconciled === "mismatch") {
      // G: fail closed, never allow Gateway deposit from here.
      clearCircleBaseWalletRecovery();
      setBaseWalletStatus("mismatch");
      return;
    }
    // Circle eventual consistency: keep the recovery, let the user retry.
    setBaseWalletStatus("missing");
    setBaseWalletNotice(t.wallet.gatewayBasePrepareUncertain);
  }

  async function handlePrepareBaseWallet() {
    const auth = readCircleTabAuth();
    if (!auth) {
      setCircleReauthRequired(true);
      return;
    }
    setDepositError("");
    setBaseWalletNotice("");
    setBaseWalletStatus("preparing");

    try {
      // Step 1: read current status. refreshCircleBaseWalletStatus already
      // sets the UI state and, on "ready", clears any stale recovery itself.
      const initial = await refreshCircleBaseWalletStatus(auth.userToken);

      // READY is terminal: nothing left to prepare.
      if (initial === "ready") return;

      // MISMATCH is terminal and fail-closed: never proceed toward a wallet
      // creation attempt.
      if (initial === "mismatch") return;

      // Step 2: read recovery WITHOUT discarding it yet. Whether an expired
      // recovery may ever be cleared depends on what `initial` is, decided
      // in the branches below, never here.
      const storedRecovery = readCircleBaseWalletRecovery();
      const recoveryExpired = Boolean(storedRecovery && isCircleBaseWalletRecoveryExpired(storedRecovery));

      // Step 5: ERROR. The prerequisite status read itself failed, so this
      // branch has NO evidence about whether a Base wallet exists. It must
      // never mint a new idempotency key, never discard an expired recovery,
      // and never start a brand-new prepare call.
      if (initial === "error") {
        if (storedRecovery && !recoveryExpired) {
          // A live recovery survives an unrelated read failure: resume it
          // exactly (same challenge if one exists, same idempotencyKey
          // otherwise), never a new one.
          await runBaseWalletChallenge(auth.userToken, storedRecovery);
          return;
        }
        // No recovery, or the one that exists is expired: an errored read
        // proves nothing either way, so neither may be treated as safe to
        // start fresh. Surface a retry notice; no mutation of any kind.
        setBaseWalletStatus("error");
        setBaseWalletNotice(t.wallet.gatewayBasePrepareUncertain);
        return;
      }

      // Step 6: MISSING. Only a definitive, successful "no Base wallet
      // exists" read may ever start a brand-new attempt or discard an
      // expired recovery.
      let recovery: CircleBaseWalletRecovery;
      if (storedRecovery && !recoveryExpired) {
        recovery = storedRecovery;
      } else {
        if (storedRecovery && recoveryExpired) {
          // Safe only because `initial === "missing"` just proved, via a
          // successful read, that no Base wallet exists: the expired
          // recovery cannot correspond to a wallet that actually landed.
          clearCircleBaseWalletRecovery();
        }
        recovery = {
          idempotencyKey: crypto.randomUUID(),
          challengeId: null,
          expiresAtMs: Date.now() + BASE_WALLET_RECOVERY_TTL_MS,
        };
        storeCircleBaseWalletRecovery(recovery);
      }
      await runBaseWalletChallenge(auth.userToken, recovery);
    } catch {
      // A genuine transport/API error before or during preparation: the
      // recovery (if any) is preserved so a retry resumes the same attempt.
      setBaseWalletStatus("error");
    }
  }

  useEffect(() => {
    if (executionMode !== "CIRCLE_USER_WALLET") {
      setDepositRecovery(null);
      return;
    }
    const recovery = readCircleGatewayDepositRecovery();
    if (!recovery) return;
    setDepositRecovery(recovery);
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
    setDepositRecovery(recovery);
    setDepositAmount(formatGatewayUsdcRaw(recovery.amountRaw));
  }, [executionMode]);

  async function ensureBaseSepolia() {
    if (chain?.id === baseSepolia.id) return;
    await switchChainAsync({ chainId: baseSepolia.id });
  }

  async function sendBaseSepoliaTransaction(request: TransactionRequest): Promise<string> {
    if (!connectedAddress || connectedAddress.toLowerCase() !== request.from.toLowerCase()) {
      throw new Error("Reconnect the wallet bound to this EXTREMA session.");
    }
    if (!connectedConnector) {
      throw new Error("Reconnect the wallet bound to this EXTREMA session.");
    }
    await ensureBaseSepolia();
    const activeChainId = await connectedConnector.getChainId();
    if (activeChainId !== request.chainId) {
      throw new Error(t.wallet.gatewaySwitchToBaseSepolia);
    }
    if (!baseSepoliaPublicClient) throw new Error(t.wallet.gatewayBaseUnavailable);
    const hash = await sendTransactionAsync({
      account: connectedAddress,
      chainId: request.chainId,
      to: request.to as `0x${string}`,
      data: request.data as `0x${string}`,
      value: BigInt(request.value),
    });
    const receipt = await baseSepoliaPublicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Wallet transaction failed.");
    return hash;
  }

  async function handleGatewayBaseDeposit() {
    // A live durable recovery is the authoritative financial intent: the
    // input is disabled and may be empty/stale while it exists, so the
    // amount (and source domain) must come from the recovery record itself,
    // never re-derived from the editable field. This also means clicking
    // "continue" resumes the SAME action (via confirmGatewayBaseDeposit's
    // own recovery lookup) rather than starting a new one.
    let sourceDomain: number;
    let amountRaw: string;
    if (depositRecovery) {
      if (depositRecovery.sourceDomain !== BASE_SEPOLIA_SOURCE.domain) {
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
      const parsed = parseGatewayUsdcRaw(depositAmount);
      if (!parsed) {
        setDepositError(locale === "tr" ? "6 ondalığa kadar geçerli bir USDC tutarı gir." : "Enter a valid USDC amount with up to 6 decimals.");
        return;
      }
      sourceDomain = BASE_SEPOLIA_SOURCE.domain;
      amountRaw = parsed;
    }

    setDepositBusy(true);
    setDepositError("");
    setDepositNotice("");
    try {
      const result = await confirmGatewayBaseDeposit(
        { sourceDomain, amountRaw },
        {
          executionMode,
          sendExternalTransaction: sendBaseSepoliaTransaction,
        },
        (phase) => {
          if (phase === "APPROVAL_REQUIRED" || phase === "APPROVAL_CHALLENGE") setDepositPhase("preparingApproval");
          else if (phase === "APPROVAL_PENDING") setDepositPhase("confirmApproval");
          else if (phase === "DEPOSIT_REQUIRED" || phase === "DEPOSIT_CHALLENGE") setDepositPhase("confirmDeposit");
          else if (phase === "DEPOSIT_PENDING") setDepositPhase("depositSubmitted");
          else if (phase === "RECONCILING") setDepositPhase("waitingFinality");
        },
      );
      if (result.state === "COMPLETED") {
        setDepositNotice(
          locale === "tr"
            ? "Yatırma tamamlandı. Gateway bakiyeni yenile."
            : "Deposit complete. Refresh your Gateway balance.",
        );
        setDepositRecovery(null);
        setDepositAmount("");
        void refreshGatewayBalance();
        void refreshBaseSourceState();
      } else {
        setDepositNotice(
          locale === "tr"
            ? `Durum: ${result.state}`
            : `Status: ${result.state}`,
        );
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (message === "gateway_deposit_expired") {
        // Fail closed: an expired report is never treated as license to
        // clear recovery or start a replacement deposit automatically. The
        // recovery record is left exactly as it is for read-only
        // investigation and an explicit, deliberate decision.
        setDepositError(t.wallet.gatewayDepositExpired);
      } else {
        setDepositError(
          message || (locale === "tr" ? "Gateway yatırması tamamlanamadı." : "Gateway deposit could not be completed."),
        );
      }
    } finally {
      setDepositBusy(false);
      setDepositPhase("");
    }
  }

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

  const gatewaySources = gateway?.balances.filter(
    (item) => item.transferable && hasPositiveRawAmount(item.balanceRaw),
  ) || [];
  const gatewayCanPrepare = Boolean(gatewayFundingRecovery) || (
    gatewayReadState === "ready" && gatewaySources.length > 0
  );
  const selectedGatewaySource = gatewaySources.find(
    (item) => String(item.domain) === gatewaySourceDomain,
  ) || gatewaySources[0] || null;

  async function handleGatewayFunding() {
    if (!selectedGatewaySource && !gatewayFundingRecovery) return;
    const valueRaw = gatewayFundingRecovery?.valueRaw || parseGatewayUsdcRaw(gatewayAmount);
    if (!valueRaw) {
      setGatewayFundingError(locale === "tr" ? "6 ondalığa kadar geçerli bir USDC tutarı gir." : "Enter a valid USDC amount with up to 6 decimals.");
      return;
    }
    const sourceDomain = gatewayFundingRecovery?.sourceDomain ?? selectedGatewaySource!.domain;
    if (
      !gatewayFundingRecovery &&
      BigInt(valueRaw) > BigInt(selectedGatewaySource!.balanceRaw)
    ) {
      setGatewayFundingError(locale === "tr" ? "Tutar seçili kaynak bakiyesini aşıyor." : "Amount exceeds the selected source balance.");
      return;
    }

    setGatewayFundingBusy(true);
    setGatewayFundingError("");
    setGatewayFundingNotice("");
    try {
      const result = await confirmGatewayBurnSignature(
        { sourceDomain, valueRaw },
        { executionMode, signTypedData: (typedData) => signTypedDataAsync(typedData) },
      );
      setGatewayFundingStatus(result);
      if (!result.readyToBroadcast || result.broadcast !== "NOT_SUBMITTED") {
        throw new Error("gateway_signature_challenge_unavailable");
      }
      setGatewayFundingNotice(
        locale === "tr"
          ? "İmza doğrulandı. Transfer gönderilmedi; yayınlama için ayrı onay gerekir."
          : "Signature verified. No transfer was submitted; broadcasting requires separate approval.",
      );
    } catch (cause) {
      setGatewayFundingError(
        cause instanceof Error
          ? cause.message
          : (locale === "tr" ? "Gateway hazırlığı tamamlanamadı." : "Gateway preparation could not be completed."),
      );
    } finally {
      setGatewayFundingBusy(false);
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
                  data-columns="3"
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
                    <span>{t.wallet.usdcBalance}</span>
                    <strong className="ex-num">
                      {chainState.usdc.balanceFormatted} {chainState.usdc.symbol}
                    </strong>
                  </div>

                  <div className="ex-wallet-summary__item">
                    <span>{t.wallet.gatewayBalance}</span>
                    <strong className="ex-num">
                      {gatewayReadState === "ready" && gateway
                        ? `${gateway.totalUsdc} ${gateway.token}`
                        : gatewayReadState === "loading" || gatewayReadState === "idle"
                          ? t.wallet.gatewayReading
                          : t.wallet.gatewayBalanceUnavailable}
                    </strong>
                  </div>
                </div>
              ) : (
                <p className="ex-wallet-ledger__pending">{chainBusy || t.wallet.balanceNotLoaded}</p>
              )}

              {!sessionNeedsAuth && chainError && <p className="ex-entry__msg" data-tone="error">{chainError}</p>}

              <section className="ex-wallet-gateway" aria-label={t.wallet.gatewayFundingAriaLabel}>
                  <div>
                    <p className="ex-eyebrow">{t.wallet.gateway}</p>
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
                        <span>{t.wallet.gatewaySource}</span>
                        <select
                          value={selectedGatewaySource ? String(selectedGatewaySource.domain) : ""}
                          onChange={(event) => setGatewaySourceDomain(event.target.value)}
                          disabled={gatewayFundingBusy || Boolean(gatewayFundingRecovery)}
                        >
                          {gatewaySources.map((item) => (
                            <option key={item.domain} value={item.domain}>
                              {`Domain ${item.domain} · ${item.balance} USDC`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>{t.wallet.gatewayAmount}</span>
                        <input
                          inputMode="decimal"
                          placeholder="0.000000"
                          value={gatewayAmount}
                          onChange={(event) => setGatewayAmount(event.target.value)}
                          disabled={gatewayFundingBusy || Boolean(gatewayFundingRecovery)}
                        />
                      </label>
                      <button
                        className="ex-btn ex-btn--ink"
                        type="button"
                        onClick={handleGatewayFunding}
                        disabled={gatewayFundingBusy || Boolean(gatewayFundingStatus && gatewayFundingStatus.state !== "SIGNATURE_PENDING")}
                      >
                        {gatewayFundingBusy
                          ? t.wallet.gatewayPreparingSignature
                          : gatewayFundingStatus && gatewayFundingStatus.state !== "SIGNATURE_PENDING"
                            ? `${t.wallet.gatewayStatus}: ${gatewayFundingStatus.state}`
                          : gatewayFundingRecovery
                            ? t.wallet.gatewayResumeSignature
                            : t.wallet.gatewayPrepareSignature}
                      </button>
                    </div>
                  )}
                  {gatewayFundingNotice && <p className="ex-entry__msg" data-tone="ok">{gatewayFundingNotice}</p>}
                  {gatewayFundingError && <p className="ex-entry__msg" data-tone="error">{gatewayFundingError}</p>}
                  {gatewayFundingStatus && (
                    <p className="ex-entry__msg" aria-live="polite">
                      {`${t.wallet.gatewayStatus}: ${gatewayFundingStatus.state}`}
                      {gatewayFundingStatus.transferId ? ` · ${gatewayFundingStatus.transferId}` : ""}
                    </p>
                  )}
                </section>

                <section className="ex-wallet-gateway" aria-label={t.wallet.gatewayDepositAriaLabel}>
                  <div>
                    <p className="ex-eyebrow">{BASE_SEPOLIA_SOURCE.label}</p>
                    <h3>{t.wallet.gatewayBaseSourceTitle}</h3>
                    <p>
                      {t.wallet.gatewayBaseUsdcBalance}
                      {": "}
                      <strong className="ex-num">
                        {baseUsdcRaw !== null ? formatGatewayUsdcRaw(baseUsdcRaw) : baseReadError ? "—" : t.wallet.gatewayBaseReading}
                      </strong>
                    </p>
                    {baseReadError && <p className="ex-entry__msg" data-tone="error">{baseReadError}</p>}
                  </div>

                  {executionMode === "CIRCLE_USER_WALLET" && baseWalletStatus === "missing" && (
                    <div>
                      <p>{t.wallet.gatewayPrepareBaseWalletBody}</p>
                      {baseWalletNotice && <p className="ex-entry__msg" aria-live="polite">{baseWalletNotice}</p>}
                      <button className="ex-btn ex-btn--ink" type="button" onClick={handlePrepareBaseWallet}>
                        {baseWalletNotice ? t.wallet.gatewayResumeBaseWallet : t.wallet.gatewayPrepareBaseWallet}
                      </button>
                    </div>
                  )}
                  {executionMode === "CIRCLE_USER_WALLET" && baseWalletStatus === "preparing" && (
                    <p>{t.wallet.gatewayPreparingBaseWallet}</p>
                  )}
                  {executionMode === "CIRCLE_USER_WALLET" && baseWalletStatus === "mismatch" && (
                    <p className="ex-entry__msg" data-tone="error">{t.wallet.gatewayBaseWalletMismatch}</p>
                  )}
                  {executionMode === "CIRCLE_USER_WALLET" && baseWalletStatus === "error" && (
                    <div>
                      <p className="ex-entry__msg" data-tone="error">{t.wallet.gatewayBaseUnavailable}</p>
                      <button className="ex-btn ex-btn--ghost" type="button" onClick={handlePrepareBaseWallet}>
                        {t.wallet.gatewayRetry}
                      </button>
                    </div>
                  )}

                  {baseWalletStatus === "ready" && (
                    <div className="ex-wallet-gateway__controls">
                      <label>
                        <span>{t.wallet.gatewayDepositAmount}</span>
                        <input
                          inputMode="decimal"
                          placeholder="0.000000"
                          value={depositAmount}
                          onChange={(event) => setDepositAmount(event.target.value)}
                          disabled={depositBusy || Boolean(depositRecovery)}
                        />
                      </label>
                      <button
                        className="ex-btn ex-btn--ink"
                        type="button"
                        onClick={handleGatewayBaseDeposit}
                        disabled={depositBusy}
                      >
                        {depositBusy
                          ? (depositPhase === "preparingApproval" ? t.wallet.gatewayPreparingApproval
                            : depositPhase === "confirmApproval" ? (executionMode === "CIRCLE_USER_WALLET" ? t.wallet.gatewayConfirmApprovalCircle : t.wallet.gatewayConfirmApprovalWallet)
                            : depositPhase === "confirmDeposit" ? t.wallet.gatewayConfirmDeposit
                            : depositPhase === "depositSubmitted" ? t.wallet.gatewayDepositSubmitted
                            : depositPhase === "waitingFinality" ? t.wallet.gatewayWaitingFinality
                            // No specific phase reported yet: if this click is
                            // resuming a recovery, "Recovering..." is the
                            // honest busy label; otherwise it's a fresh read.
                            : depositRecovery ? t.wallet.gatewayRecoveringOperation
                            : t.wallet.gatewayReading)
                          : depositRecovery
                            // Idle: nothing happens until the user explicitly
                            // clicks, so the label must say "continue", never
                            // "recovering" (which implies it is already in
                            // progress).
                            ? t.wallet.gatewayResumeDeposit
                            : t.wallet.gatewayConfirmDeposit}
                      </button>
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
                    void refreshBaseSourceState();
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
