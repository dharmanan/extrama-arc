"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ProductHeader } from "../../product-components";
import {
  backendApi,
  type LivePool,
  type LiveRoundResponse,
  type RoundEntriesResponse,
} from "../../lib/backend-api";
import { assetConfigs } from "../../lib/asset-config";
import { confirmEntry } from "../../lib/entry-execution";
import {
  clearCircleEntryRecovery,
  matchesCircleEntryRecovery,
  readCircleEntryRecovery,
} from "../../lib/circle-auth";
import { useAccount, usePublicClient, useSendTransaction } from "wagmi";
import { useCopy, useLocale } from "../../i18n";
import { useWalletSession } from "../../wallet-session";
import { applyBinanceLiveMarketToPool, readBinanceLiveMarket } from "../../lib/live-market";
import { formatLocalDateTime, formatUsdc, humanRoundStatus } from "../../lib/display";
import {
  buildPredictionMap,
  parsePredictionCents,
  parsePredictionInput,
} from "../../lib/prediction-distribution";

type Copy = ReturnType<typeof useCopy>;
type Locale = "en" | "tr";

function localeTag(locale: Locale) {
  return locale === "tr" ? "tr-TR" : "en-US";
}

function horizonLabel(cadence: LivePool["cadence"], t: Copy) {
  if (cadence === "DAILY") return t.home.horizonDayKey;
  if (cadence === "WEEKLY") return t.home.horizonWeekKey;
  return t.home.horizonQuarterKey;
}

function directionLabel(direction: LivePool["direction"], t: Copy) {
  return direction === "HIGH" ? t.home.directionHighKey : t.home.directionLowKey;
}

function formatPredictionPrice(value: string | null, locale: Locale) {
  const cents = value === null ? null : parsePredictionCents(value);
  if (cents === null) return "—";
  const whole = cents / BigInt(100);
  const fraction = (cents % BigInt(100)).toString().padStart(2, "0");
  const separator = locale === "tr" ? "," : ".";
  return `$${new Intl.NumberFormat(localeTag(locale)).format(whole)}${separator}${fraction}`;
}

function formatMarketPrice(value: string | null, locale: Locale) {
  if (value === null) return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function formatWindowRange(startIso: string, endIso: string, locale: Locale) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
  const withYear = new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `${day.format(start)} → ${withYear.format(end)} UTC`;
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

/** Phase of the round, derived from real timestamps only. */
function roundPhase(pool: LivePool, now: number) {
  const openAt = new Date(pool.round.entryOpenAt).getTime();
  const closeAt = new Date(pool.round.entryCloseAt).getTime();
  const marketEnd = new Date(pool.round.marketPeriodEndAt ?? pool.round.settlementEligibleAt).getTime();

  if (now < openAt) return { key: "PRE_OPEN" as const, target: openAt };
  if (now < closeAt) return { key: "ENTRY_OPEN" as const, target: closeAt };
  if (now < marketEnd) return { key: "MARKET_LIVE" as const, target: marketEnd };
  return { key: "RESULT_PENDING" as const, target: null };
}

function phaseLabel(key: ReturnType<typeof roundPhase>["key"], t: Copy) {
  if (key === "PRE_OPEN") return t.predictionsStartIn;
  if (key === "ENTRY_OPEN") return t.predictionsCloseIn;
  if (key === "MARKET_LIVE") return t.marketPeriodEndsIn;
  return t.resultPending;
}

/** The direction motif carried over from the homepage and the pool board. */
function DirectionMark({ direction }: { direction: LivePool["direction"] }) {
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

// Floating labels stay inside the plot: near either edge they anchor to that
// edge instead of centering on their mark.
function labelAlign(positionPercent: number, edgePercent: number) {
  if (positionPercent < edgePercent) return "start";
  if (positionPercent > 100 - edgePercent) return "end";
  return "center";
}

const DENSITY_COLUMNS = 48;

// Display only. A smoothed density over the exact numeric positions, so even a
// handful of predictions reads as a distribution. Bar height is relative
// concentration, never a count or a price bucket; every exact price stays on
// its own notch under the baseline.
function densityColumns(positions: number[]) {
  const span = positions[positions.length - 1] - positions[0];
  const bandwidth = Math.max(span / 9, 2);
  const values = Array.from({ length: DENSITY_COLUMNS }, (_, index) => {
    const center = ((index + 0.5) / DENSITY_COLUMNS) * 100;
    return positions.reduce(
      (sum, position) => sum + Math.exp(-0.5 * ((center - position) / bandwidth) ** 2),
      0,
    );
  });
  const peak = Math.max(...values);
  return values.map((value) => {
    const level = peak > 0 ? value / peak : 0;
    return level < 0.03 ? 0 : level;
  });
}

function densityColumnIndex(positionPercent: number) {
  return Math.min(DENSITY_COLUMNS - 1, Math.max(0, Math.floor((positionPercent / 100) * DENSITY_COLUMNS)));
}

const MARKET_SCALE = 100_000_000;

// Round price labels for the scale under the baseline. Display only; the
// numeric axis itself comes from buildPredictionMap.
function scaleLabels(fromScaled: bigint, toScaled: bigint, locale: Locale) {
  const from = Number(fromScaled) / MARKET_SCALE;
  const to = Number(toScaled) / MARKET_SCALE;
  if (!(to > from)) return [];
  const raw = (to - from) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw) ?? raw;
  const formatter = new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits: step >= 1 ? 0 : 2,
    minimumFractionDigits: step >= 1 ? 0 : 2,
  });
  const labels: { key: string; text: string; positionPercent: number }[] = [];
  const first = Math.ceil(from / step);
  for (let index = first; index * step <= to; index += 1) {
    const value = index * step;
    labels.push({
      key: String(index),
      text: `$${formatter.format(value)}`,
      positionPercent: ((value - from) / (to - from)) * 100,
    });
  }
  return labels;
}

function Distribution({
  entriesState,
  entriesError,
  entryCount,
  ownPriceCents,
  liveMarkPrice,
  locale,
  t,
}: {
  entriesState: RoundEntriesResponse | null;
  entriesError: boolean;
  entryCount: number;
  ownPriceCents: bigint | null;
  liveMarkPrice: string | null;
  locale: Locale;
  t: Copy;
}) {
  const predictionInputs = useMemo(
    () => (entriesState?.entries ?? []).flatMap((entry) => {
      const priceCents = parsePredictionCents(entry.predictionPriceCents);
      return priceCents === null ? [] : [{ id: entry.ticketId, priceCents }];
    }),
    [entriesState],
  );
  const model = useMemo(
    () => buildPredictionMap(predictionInputs, liveMarkPrice),
    [liveMarkPrice, predictionInputs],
  );
  const [activePointId, setActivePointId] = useState<string | null>(null);

  // The round read already knows how many entries exist. An empty round is
  // stated as empty even when the entry read failed, because "no predictions
  // yet" is then the fact; only a round that genuinely has entries we could
  // not read is reported as unavailable.
  const knownEntryCount = entriesState?.round.entryCount ?? entryCount;
  if (knownEntryCount === 0) {
    return (
      <div className="ex-dist ex-dist--void">
        <p className="ex-dist__void">{t.noPredictions}</p>
      </div>
    );
  }

  if (entriesError || !entriesState?.round.complete || !model) {
    return (
      <div className="ex-dist ex-dist--void">
        <p className="ex-dist__void">{t.poolDistributionUnavailable}</p>
      </div>
    );
  }

  const livePrice = formatMarketPrice(liveMarkPrice, locale);
  const liveShortLabel = `${locale === "tr" ? "CANLI" : "LIVE"} ${livePrice}`;
  const ownPoint = ownPriceCents === null
    ? null
    : model.points.find((point) => point.priceCents === ownPriceCents) ?? null;
  const hoveredPoint = model.points.find((point) => point.id === activePointId) ?? null;
  // Hover, focus or tap shows that prediction; otherwise the connected
  // user's own prediction stays labelled, as a quiet default.
  const labelledPoint = hoveredPoint ?? ownPoint;
  const labelledIsOwn = labelledPoint !== null && ownPoint !== null && labelledPoint.id === ownPoint.id;
  const density = densityColumns(model.points.map((point) => point.positionPercent));
  const ownColumn = ownPoint ? densityColumnIndex(ownPoint.positionPercent) : null;
  const activeColumn = hoveredPoint ? densityColumnIndex(hoveredPoint.positionPercent) : null;
  const labelledColumn = labelledPoint ? densityColumnIndex(labelledPoint.positionPercent) : null;
  const scale = scaleLabels(model.fromScaled, model.toScaled, locale).filter((label) =>
    label.positionPercent >= 4 &&
    label.positionPercent <= 96 &&
    (model.livePositionPercent === null || Math.abs(label.positionPercent - model.livePositionPercent) > 11) &&
    !(model.offscaleLive === "LEFT" && label.positionPercent < 24) &&
    !(model.offscaleLive === "RIGHT" && label.positionPercent > 76),
  );

  return (
    <div className="ex-dist">
      <div className="ex-dist__plot" role="group" aria-label={t.poolDistribution}>
        <div className="ex-dist__bars" aria-hidden="true">
          {density.map((level, index) => (
            <span
              key={index}
              className="ex-dist__bar"
              data-own={index === ownColumn || undefined}
              data-active={index === activeColumn || undefined}
              style={{ height: `${level * 100}%` }}
            />
          ))}
        </div>
        <span className="ex-dist__rail" aria-hidden="true" />

        {scale.map((label) => (
          <span
            key={label.key}
            className="ex-dist__scale"
            aria-hidden="true"
            style={{ left: `${label.positionPercent}%` }}
          >
            {label.text}
          </span>
        ))}

        {model.points.map((point) => {
          const isOwn = ownPoint !== null && point.id === ownPoint.id;
          const priceLabel = formatPredictionPrice(point.priceCents.toString(), locale);
          return (
            <button
              type="button"
              className="ex-dist__tick"
              key={point.id}
              data-own={isOwn || undefined}
              data-active={hoveredPoint?.id === point.id || undefined}
              style={{ left: `${point.positionPercent}%` }}
              onMouseEnter={() => setActivePointId(point.id)}
              onMouseLeave={() => setActivePointId((current) => current === point.id ? null : current)}
              onFocus={() => setActivePointId(point.id)}
              onBlur={() => setActivePointId((current) => current === point.id ? null : current)}
              onClick={() => setActivePointId(point.id)}
              aria-label={`${isOwn ? `${t.poolYourPrediction}. ` : ""}${priceLabel}. Ticket ${point.id}.`}
            />
          );
        })}

        {model.livePositionPercent !== null && (
          <span
            className="ex-dist__live"
            data-align={labelAlign(model.livePositionPercent, 18)}
            style={{ left: `${model.livePositionPercent}%` }}
            role="img"
            aria-label={`${t.liveMark}: ${livePrice}`}
          >
            <span className="ex-dist__live-label" aria-hidden="true">{liveShortLabel}</span>
          </span>
        )}

        {model.offscaleLive !== null && (
          <span
            className="ex-dist__offscale"
            data-edge={model.offscaleLive}
            role="img"
            aria-label={`${t.liveMark}: ${livePrice}. ${model.offscaleLive === "LEFT" ? "Below" : "Above"} the displayed prediction range.`}
          >
            <span className="ex-dist__live-label" aria-hidden="true">{liveShortLabel}</span>
          </span>
        )}

        {labelledPoint && labelledColumn !== null && (
          <span
            className="ex-dist__detail"
            data-align={labelAlign(labelledPoint.positionPercent, 12)}
            data-own={labelledIsOwn || undefined}
            style={{
              left: `${labelledPoint.positionPercent}%`,
              "--bar-level": density[labelledColumn],
            } as CSSProperties}
            role="status"
          >
            <span className="ex-dist__detail-meta">
              {labelledIsOwn ? `${t.poolYourPrediction} · ` : ""}#{labelledPoint.id}
            </span>
            <span className="ex-dist__detail-price">{formatPredictionPrice(labelledPoint.priceCents.toString(), locale)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function PoolDetailPage() {
  const params = useParams<{ slug: string }>();
  const { locale } = useLocale();
  const t = useCopy();
  const { address, executionMode } = useWalletSession();
  const { address: connectedAddress, connector: connectedConnector } = useAccount();
  const publicClient = usePublicClient({ chainId: 5042002 });
  const { sendTransactionAsync } = useSendTransaction();

  const [state, setState] = useState<LiveRoundResponse | null>(null);
  const [entriesState, setEntriesState] = useState<RoundEntriesResponse | null>(null);
  const [entriesError, setEntriesError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const [prediction, setPrediction] = useState("");
  const [entryBusy, setEntryBusy] = useState("");
  const [entryError, setEntryError] = useState("");
  const entriesRequestId = useRef(0);
  const circleEntryRequestId = useRef<string | null>(null);
  const [authoritativeWalletAddress, setAuthoritativeWalletAddress] = useState<string | null>(null);
  const [entrySuccess, setEntrySuccess] = useState<{
    ticketId: string;
    explorerUrl: string | null;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // The distribution is a separate read from a separate contract call, so a
  // failure there must never take the round view down with it.
  const refreshEntries = useCallback(async (pool: LivePool) => {
    const requestId = ++entriesRequestId.current;

    try {
      const result =
        await backendApi.rounds.entries(
          pool.slug,
          pool.round.roundId,
        );

      if (
        result.pool.slug !== pool.slug ||
        result.pool.poolAddress.toLowerCase() !== pool.poolAddress.toLowerCase() ||
        result.round.roundId !== pool.round.roundId
      ) {
        throw new Error("round_entries_identity_mismatch");
      }

      if (requestId !== entriesRequestId.current) return;

      // Public round entries are authoritative for the distribution view.
      // An authenticated wallet lookup must never make public data unavailable.
      setEntriesState(result);
      setEntriesError(false);

      let authoritativeAddress =
        address ?? null;

      setAuthoritativeWalletAddress(
        authoritativeAddress,
      );

      if (address) {
        try {
          const walletState =
            await backendApi.wallet.get();

          if (
            requestId !==
            entriesRequestId.current
          ) {
            return;
          }

          authoritativeAddress =
            walletState.wallet?.address ??
            address;

          setAuthoritativeWalletAddress(
            authoritativeAddress,
          );
        } catch {
          // Public distribution remains available when wallet/session
          // state is absent, expired, or temporarily unreadable.
          if (
            requestId !==
            entriesRequestId.current
          ) {
            return;
          }
        }
      }

      const ownEntry =
        authoritativeAddress
          ? result.entries.find(
              (entry) =>
                entry.originalEntrant.toLowerCase() ===
                authoritativeAddress.toLowerCase(),
            ) ?? null
          : null;

      if (
        executionMode ===
          "CIRCLE_USER_WALLET" &&
        ownEntry
      ) {
        const recovery =
          readCircleEntryRecovery();

        const predictionPriceCents =
          Number(
            ownEntry.predictionPriceCents,
          );

        if (
          recovery &&
          Number.isSafeInteger(
            predictionPriceCents,
          ) &&
          matchesCircleEntryRecovery(
            recovery,
            {
              poolAddress:
                pool.poolAddress,
              roundId:
                pool.round.roundId,
              predictionPriceCents,
            },
          )
        ) {
          clearCircleEntryRecovery();
          circleEntryRequestId.current =
            null;
        }
      }
    } catch {
      if (
        requestId !==
        entriesRequestId.current
      ) {
        return;
      }

      setEntriesState(null);
      setEntriesError(true);
    }
  }, [address, executionMode]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setLoading(true);

    async function refresh() {
      try {
        const result = await backendApi.rounds.get(params.slug);
        let nextPool = result.pool;

        try {
          const live = await readBinanceLiveMarket();
          nextPool = applyBinanceLiveMarketToPool(result.pool, live);
        } catch {
          // The live mark is a display overlay, not an entry precondition.
          // Keep the real Arc round visible and usable when that overlay fails.
        }

        if (cancelled) return;
        setState({
          ...result,
          pool: nextPool,
        });
        setError("");
        void refreshEntries(result.pool);
      } catch (err: unknown) {
        if (cancelled) return;
        setState(null);
        setError(err instanceof Error ? err.message : "Unable to read pool.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void refresh();
    timer = setInterval(() => {
      void refresh();
    }, 60_000);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [params.slug, refreshEntries]);

  async function handleAuthorizeEntry() {
    if (!state) return;

    setEntryError("");
    setEntrySuccess(null);

    const openAt = new Date(state.pool.round.entryOpenAt).getTime();
    const closeAt = new Date(state.pool.round.entryCloseAt).getTime();
    const currentTime = Date.now();
    if (
      !state.pool.round.canEnter ||
      state.pool.round.contractStatus !== "ENTRY_OPEN" ||
      currentTime < openAt ||
      currentTime >= closeAt
    ) {
      setEntryError("Predictions are no longer available for this round.");
      return;
    }

    const predictionPriceCents = parsePredictionInput(prediction.trim());
    if (predictionPriceCents === null) {
      setEntryError("Enter a valid positive price with up to 2 decimal places.");
      return;
    }

    // External wallets must be on Arc before any backend action is created.
    // Circle user wallets use their own execution path and are intentionally
    // unaffected by this browser-wallet network guard.
    if (executionMode === "EXTERNAL_WALLET") {
      if (!connectedAddress || !connectedConnector) {
        setEntryError("Reconnect the wallet bound to this EXTREMA session.");
        return;
      }

      let activeChainId: number;
      try {
        activeChainId = await connectedConnector.getChainId();
      } catch {
        setEntryError("Reconnect the wallet bound to this EXTREMA session.");
        return;
      }

      if (activeChainId !== 5042002) {
        setEntryError("Switch your connected wallet to Arc Testnet.");
        return;
      }
    }

    setEntryBusy("Confirming…");
    try {
      const result = await confirmEntry({
        executionMode,
        poolAddress: state.pool.poolAddress,
        roundId: state.pool.round.roundId,
        predictionPriceCents,
        circleRequestId:
          executionMode === "CIRCLE_USER_WALLET"
            ? (circleEntryRequestId.current ||= crypto.randomUUID())
            : undefined,
        sendExternalTransaction: async (request) => {
          if (
            !connectedAddress ||
            connectedAddress.toLowerCase() !== request.from.toLowerCase()
          ) {
            throw new Error("Reconnect the wallet bound to this EXTREMA session.");
          }
          if (!connectedConnector) {
            throw new Error("Reconnect the wallet bound to this EXTREMA session.");
          }
          const activeChainId = await connectedConnector.getChainId();
          if (activeChainId !== request.chainId) {
            throw new Error("Switch your connected wallet to Arc Testnet.");
          }
          if (!publicClient) throw new Error("Arc Testnet receipt service is unavailable.");
          const hash = await sendTransactionAsync({
            account: connectedAddress,
            chainId: request.chainId,
            to: request.to as `0x${string}`,
            data: request.data as `0x${string}`,
            value: BigInt(request.value),
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error("Wallet transaction failed.");
          return hash;
        },
      });
      circleEntryRequestId.current = null;

      setState((current) => current ? {
        ...current,
        pool: {
          ...current.pool,
          round: {
            ...current.pool.round,
            entryCount: result.after.entryCount,
            totalStakeRaw: result.after.totalStakeRaw,
            totalStakeUsdc: result.after.totalStakeUsdc,
            escrowRemainingRaw: result.after.escrowRemainingRaw,
            escrowRemainingUsdc: result.after.escrowRemainingUsdc,
          },
        },
      } : current);

      setEntrySuccess({
        ticketId: result.ticketId,
        explorerUrl: result.explorerUrl,
      });

      void refreshEntries(state.pool);
    } catch (cause) {
      const isExternalWallet = executionMode === "EXTERNAL_WALLET";
      const isCircleWallet = executionMode === "CIRCLE_USER_WALLET";
      const message = cause instanceof Error
        ? cause.message
        : isExternalWallet
          ? "Wallet transaction verification failed."
          : isCircleWallet
            ? "Circle transaction verification failed."
            : "Prediction verification failed.";

      const ambiguousCircleResult =
        isCircleWallet &&
        (
          message === "invalid_backend_response" ||
          message === "backend_unreachable" ||
          message === "circle_transaction_pending" ||
          message === "circle_service_unavailable"
        );

      const recoveryAddress = authoritativeWalletAddress ?? address;

      if (ambiguousCircleResult && recoveryAddress) {
        try {
          const [latestRound, latestEntries] = await Promise.all([
            backendApi.rounds.get(state.pool.slug),
            backendApi.rounds.entries(state.pool.slug, state.pool.round.roundId),
          ]);

          const recoveredEntry = latestEntries.entries.find(
            (entry) =>
              entry.originalEntrant.toLowerCase() === recoveryAddress.toLowerCase() &&
              entry.predictionPriceCents === String(predictionPriceCents),
          );

          if (recoveredEntry) {
            clearCircleEntryRecovery();
            circleEntryRequestId.current = null;
            setState(latestRound);
            setEntriesState(latestEntries);
            setEntriesError(false);
            setPrediction("");
            setEntryError("");
            setEntrySuccess({
              ticketId: recoveredEntry.ticketId,
              explorerUrl: null,
            });
            return;
          }
        } catch {
          // Keep the original ambiguous state below. Never resubmit automatically.
        }
      }

      if (message === "authentication_required" || message === "invalid_session" || message === "session_expired") {
        setEntryError("Your EXTREMA session is locked or expired. Reconnect your wallet, then try again.");
      } else if (message === "circle_reauthentication_required" || message === "circle_authentication_invalid") {
        setEntryError("Your Circle authorization is no longer available in this tab. Reconnect your Circle wallet, then try again.");
      } else if (
        message === "circle_transaction_pending" ||
        message === "invalid_backend_response" ||
        message === "backend_unreachable" ||
        message === "circle_service_unavailable"
      ) {
        setEntryError(
          "We could not confirm the final transaction status yet. Do not submit again. Refresh the round in a moment.",
        );
      } else if (message === "circle_entry_authorization_invalid") {
        setEntryError("This prediction session expired. Refresh the page and try again.");
      } else if (message === "circle_pending_action_for_different_intent") {
        setEntryError(
          "Another Circle prediction is still being verified. Please wait before starting a different prediction.",
        );
      } else if (message === "entry_insufficient_usdc") {
        setEntryError(isExternalWallet
          ? "You need at least 1 USDC in your connected wallet to enter."
          : "You need at least 1 USDC in your EXTREMA wallet to enter.");
      } else if (message === "entry_already_entered") {
        setEntryError(isExternalWallet
          ? "This connected wallet has already entered this round."
          : "This EXTREMA wallet has already entered this round.");
      } else if (message === "entry_price_taken") {
        setEntryError("That exact price has already been taken. Choose another price.");
      } else if (message === "entry_round_not_available") {
        setEntryError("Predictions are no longer available for this round.");
      } else if (message === "entry_postcondition_failed") {
        setEntryError("The transaction may already have been confirmed on Arc. Do not try again yet; refresh the round state first.");
      } else {
        setEntryError(message);
      }
    } finally {
      setEntryBusy("");
    }
  }

  if (loading) {
    return (
      <main className="ex-pools ex-pool">
        <ProductHeader />
        <div className="ex-shell">
          <p className="ex-pools__note">{t.readingRounds}</p>
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="ex-pools ex-pool">
        <ProductHeader />
        <div className="ex-shell">
          <div className="ex-pools__error">
            <h1 className="ex-display ex-display--md">{t.poolUnavailable}</h1>
            <p className="ex-lede">{error || t.poolUnavailableBody}</p>
            <p className="ex-pools__note" style={{ marginTop: 0 }}>
              <Link href="/pools" className="ex-pool__back">← {t.backToPools}</Link>
            </p>
          </div>
        </div>
      </main>
    );
  }

  const { pool, chain } = state;
  const config = assetConfigs[pool.asset];
  const phase = roundPhase(pool, now);

  const effectiveWalletAddress = authoritativeWalletAddress ?? address;
  const ownEntry = effectiveWalletAddress
    ? (entriesState?.entries ?? []).find(
        (entry) =>
          entry.originalEntrant.toLowerCase() === effectiveWalletAddress.toLowerCase(),
      ) ?? null
    : null;
  const ownPriceCents = ownEntry ? parsePredictionCents(ownEntry.predictionPriceCents) : null;
  const hasConfirmedEntry = Boolean(ownEntry || entrySuccess);
  const canSubmit =
    pool.round.canEnter &&
    phase.key === "ENTRY_OPEN" &&
    !hasConfirmedEntry;

  const completePrices = entriesState?.round.complete
    ? entriesState.entries
        .map((entry) => parsePredictionCents(entry.predictionPriceCents))
        .filter((price): price is bigint => price !== null)
    : [];
  const lowest = completePrices.length > 0
    ? completePrices.reduce((value, price) => price < value ? price : value)
    : null;
  const highest = completePrices.length > 0
    ? completePrices.reduce((value, price) => price > value ? price : value)
    : null;

  const partialRead =
    entriesState !== null && !entriesState.round.complete && entriesState.round.entryCount > 0;

  return (
    <main className="ex-pools ex-pool">
      <ProductHeader />

      <div className="ex-shell">
        <Link href="/pools" className="ex-pool__back">← {t.backToPools}</Link>

        <div className="ex-pool__grid">
          {/* ---- Market identity -------------------------------------- */}
          <section className="ex-pool__market">
            <span className="ex-pool__id">
              <img src={config.brandSrc} alt="" />
              <span className="ex-pool__symbol">{pool.asset}</span>
              <span className="ex-pool__name">{config.name}</span>
            </span>

            <h1 className="ex-display ex-display--lg ex-pool__title">
              {horizonLabel(pool.cadence, t)} {directionLabel(pool.direction, t)}
            </h1>

            <p className="ex-pool__window">
              <span className="ex-pool__dir" data-direction={pool.direction}>
                <DirectionMark direction={pool.direction} />
                {directionLabel(pool.direction, t)}
              </span>
              <span className="ex-pool__window-range">
                {pool.round.marketPeriodStartAt && pool.round.marketPeriodEndAt
                  ? formatWindowRange(pool.round.marketPeriodStartAt, pool.round.marketPeriodEndAt, locale)
                  : "Legacy V1"}
              </span>
              <span className="ex-pool__state" data-open={pool.round.canEnter}>
                {humanRoundStatus(pool.round.contractStatus, locale)}
              </span>
            </p>

            <p className="ex-pool__price" data-pending={pool.market.available ? "false" : "true"}>
              {pool.market.available && pool.market.markPrice
                ? formatMarketPrice(pool.market.markPrice, locale)
                : t.unavailable}
            </p>
            <p className="ex-pool__price-meta">
              {t.liveMark}
              {pool.market.source ? ` · ${pool.market.source}` : ""} · {pool.sourceSymbol}
            </p>

            <dl className="ex-pool__facts">
              <div>
                <dt>{t.round}</dt>
                <dd className="ex-num">#{pool.round.roundId}</dd>
              </div>
              <div>
                <dt>{t.predictionsOpenUntil}</dt>
                <dd className="ex-num">{formatLocalDateTime(pool.round.entryCloseAt, locale)}</dd>
              </div>
              <div>
                <dt>{t.poolMarketPeriod}</dt>
                <dd className="ex-num">
                  {pool.round.marketPeriodStartAt && pool.round.marketPeriodEndAt
                    ? <>{formatLocalDateTime(pool.round.marketPeriodStartAt, locale)} {t.to}{" "}
                        {formatLocalDateTime(pool.round.marketPeriodEndAt, locale)}</>
                    : "Legacy V1"}
                </dd>
              </div>
              <div>
                <dt>{t.priceSource}</dt>
                <dd>{pool.source} · {pool.sourceSymbol}</dd>
              </div>
            </dl>

            <div className="ex-pool__actions">
              <a
                className="ex-btn ex-btn--ghost"
                href={`${chain.explorerUrl}/address/${pool.poolAddress}`}
                target="_blank"
                rel="noreferrer"
              >
                {t.verifyOnArc}
              </a>
              <Link href={`/results/${pool.slug}/${pool.round.roundId}`} className="ex-btn ex-btn--ghost">
                {t.viewRound}
              </Link>
            </div>
          </section>

          {/* ---- Order book ------------------------------------------- */}
          <section className="ex-pool__book">
            <div className="ex-book__head">
              <h2 className="ex-book__title">{t.poolDistribution}</h2>
              <div className="ex-book__totals">
                <span className="ex-book__total">
                  <span className="ex-book__total-val ex-num">{pool.round.entryCount}</span>
                  <span className="ex-book__total-key">{t.entries}</span>
                </span>
                <span className="ex-book__total">
                  <span className="ex-book__total-val ex-num">
                    {formatUsdc(pool.round.totalStakeUsdc, locale)}
                  </span>
                  <span className="ex-book__total-key">{t.prizePool}</span>
                </span>
              </div>
            </div>

            <Distribution
              entriesState={entriesState}
              entriesError={entriesError}
              entryCount={pool.round.entryCount}
              ownPriceCents={ownPriceCents}
              liveMarkPrice={pool.market.available ? pool.market.markPrice : null}
              locale={locale}
              t={t}
            />

            {partialRead && entriesState && (
              <p className="ex-book__partial">
                {entriesState.round.readCount} / {entriesState.round.entryCount} · {t.poolEntriesRead}
              </p>
            )}

            <div className="ex-book__strip">
              <div className="ex-book__cell">
                <span className="ex-book__cell-key">{t.poolLowest}</span>
                <span className="ex-book__cell-val ex-num">{formatPredictionPrice(lowest?.toString() ?? null, locale)}</span>
              </div>
              <div className="ex-book__cell">
                <span className="ex-book__cell-key">{t.poolHighest}</span>
                <span className="ex-book__cell-val ex-num">{formatPredictionPrice(highest?.toString() ?? null, locale)}</span>
              </div>
              <div className="ex-book__cell" data-live={phase.key === "ENTRY_OPEN"}>
                <span className="ex-book__cell-key">{phaseLabel(phase.key, t)}</span>
                <span className="ex-book__cell-val ex-num">
                  {phase.target === null ? "—" : formatCountdown(phase.target - now, locale)}
                </span>
              </div>
            </div>

            {/* ---- Entry ---------------------------------------------- */}
            <div className="ex-entry">
              {hasConfirmedEntry ? (
                <div className="ex-entry__msg" data-tone="ok">
                  {ownEntry ? (
                    <>
                      <p>
                        <b>Prediction confirmed.</b> Ticket #{ownEntry.ticketId} is entered for this round.
                      </p>
                      <p>
                        Your prediction: {formatPredictionPrice(ownEntry.predictionPriceCents, locale)}
                      </p>
                    </>
                  ) : entrySuccess ? (
                    <p>
                      <b>Prediction confirmed.</b> Ticket #{entrySuccess.ticketId} was minted on Arc Testnet.
                    </p>
                  ) : null}
                </div>
              ) : (
                <>
              <h3 className="ex-entry__title">{t.makePrediction}</h3>
              <p className="ex-entry__note">{t.onePredictionCosts}</p>

              <label className="ex-entry__field">
                <span className="ex-entry__label">
                  {pool.direction === "HIGH" ? t.yourPredictedHigh : t.yourPredictedLow}
                </span>
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={prediction}
                  onChange={(event) => {
                    setPrediction(event.target.value);
                    setEntryError("");
                    setEntrySuccess(null);
                  }}
                  disabled={!canSubmit || Boolean(entryBusy)}
                />
              </label>

              <button
                className="ex-btn ex-btn--ink ex-entry__submit"
                type="button"
                onClick={handleAuthorizeEntry}
                disabled={!canSubmit || Boolean(entryBusy)}
              >
                {entryBusy || t.confirmPrediction}
              </button>

              <p className="ex-entry__note">
                {executionMode === "EXTERNAL_WALLET"
                  ? locale === "tr"
                    ? "Bağlı cüzdanın her gerekli zincir üstü işlemi ayrı olarak onaylar."
                    : "Your connected wallet approves each required onchain transaction separately."
                  : executionMode === "CIRCLE_USER_WALLET"
                    ? locale === "tr"
                      ? "Circle cüzdanın gerekli her zincir üstü adımı ayrı olarak onaylamanı ister."
                      : "Your Circle wallet asks you to approve each required onchain step."
                    : t.confirmNeedsWallet}
              </p>

              {!canSubmit && (
                <p className="ex-entry__msg">{t.roundClosed}</p>
              )}

              {entryError && (
                <p className="ex-entry__msg" data-tone="error">
                  {entryError}{" "}
                  {(entryError.includes("session") || entryError.includes("locked")) && (
                    <Link href="/wallet">Reconnect wallet</Link>
                  )}
                </p>
              )}

                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
