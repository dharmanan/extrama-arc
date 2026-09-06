"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "en" | "tr";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);
const STORAGE_KEY = "extrema_locale";

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "tr") setLocaleState(saved);
  }, []);

  function setLocale(next: Locale) {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.lang = next;
  }

  const value = useMemo(() => ({ locale, setLocale }), [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used inside LocaleProvider");
  return context;
}

export const copy = {
  en: {
    pools: "Pools",
    leaderboard: "Leaderboard",
    howItWorks: "How it works",
    myTickets: "My Tickets",
    createConnectWallet: "Create / Connect Wallet",
    all: "All",
    daily: "Daily",
    weekly: "Weekly",
    quarterly: "Quarterly",
    poolsShown: "pools shown",
    nextPhase: "Next phase",
    predictionWindow: "Prediction window",
    predictionsOpenIn: "Predictions open in",
    opens: "Opens",
    readingRounds: "Reading live Arc Testnet rounds…",
    roundUnavailable: "Arc round data unavailable",
    noMockFallback: "No mock pool data is shown as a fallback.",
    round: "Round",
    liveMark: "Live mark · 1 min",
    liveSourceBinance: "Binance",
    liveSourceFallback: "CoinGecko fallback",
    latestPrediction: "Latest prediction",
    entries: "Entries",
    prizePool: "Prize pool",
    unavailable: "Unavailable",
    predictionsClosedAwaitingLock: "Predictions closed · awaiting lock",
    observationLive: "Observation live",
    observationPending: "Predictions closed · observation pending",
    observationComplete: "Observation complete · awaiting settlement",
    predictionCutoff: "Prediction cutoff",
    beforeObservation: "before observation",
    closes: "Closes",
    makePrediction: "Make a prediction",
    viewPool: "View pool",
    noPredictions: "No predictions yet",
    onePrediction: "1 prediction",
    predictions: "predictions",
    openForPredictions: "Open for predictions",
    predictionsClosed: "Predictions closed",
    resultsReady: "Results ready",
    cancelled: "Cancelled",
    closed: "closed",
    left: "left",
    backToPools: "Back to pools",
    poolUnavailable: "Pool unavailable",
    poolUnavailableBody: "We could not load the latest round data. Please try again.",
    predictionsClose: "Predictions close",
    predictionsStartIn: "Predictions start in",
    predictionsCloseIn: "Predictions close in",
    observationStartsIn: "Observation starts in",
    observationEndsIn: "Observation ends in",
    observationEnded: "Observation ended",
    roundTiming: "Round timing",
    predictionsOpenUntil: "Predictions open until",
    observationRuns: "Price observation runs from",
    to: "to",
    priceSource: "Price source",
    verifyOnArc: "Verify on Arc",
    viewRound: "View round",
    onePredictionCosts: "One prediction costs exactly 1 USDC.",
    yourPredictedHigh: "Your predicted high price",
    yourPredictedLow: "Your predicted low price",
    confirmBiometric: "Confirm this prediction with Touch ID, Face ID, or your device passcode. Once approved, EXTREMA will submit the 1 USDC entry automatically.",
    confirmPrediction: "Confirm prediction · 1 USDC",
    roundClosed: "Predictions are closed for this round.",
  },
  tr: {
    pools: "Havuzlar",
    leaderboard: "Liderlik",
    howItWorks: "Nasıl çalışır",
    myTickets: "Biletlerim",
    createConnectWallet: "Cüzdan Oluştur / Bağla",
    all: "Tümü",
    daily: "Gün",
    weekly: "Hafta",
    quarterly: "Çeyrek",
    poolsShown: "havuz gösteriliyor",
    nextPhase: "Sıradaki aşama",
    predictionWindow: "Tahmin penceresi",
    predictionsOpenIn: "Tahminler açılıyor",
    opens: "Açılış",
    readingRounds: "Canlı Arc Testnet havuzları okunuyor…",
    roundUnavailable: "Arc havuz verisi kullanılamıyor",
    noMockFallback: "Yedek olarak sahte havuz verisi gösterilmez.",
    round: "Tur",
    liveMark: "Canlı fiyat · 1 dk",
    liveSourceBinance: "Binance",
    liveSourceFallback: "CoinGecko yedek",
    latestPrediction: "Son tahmin",
    entries: "Katılım",
    prizePool: "Ödül havuzu",
    unavailable: "Kullanılamıyor",
    predictionsClosedAwaitingLock: "Tahminler kapandı · kilit bekleniyor",
    observationLive: "Gözlem canlı",
    observationPending: "Tahminler kapandı · gözlem bekleniyor",
    observationComplete: "Gözlem tamamlandı · sonuç bekleniyor",
    predictionCutoff: "Tahmin kapanışı",
    beforeObservation: "gözlemden önce",
    closes: "Kapanış",
    makePrediction: "Tahmin yap",
    viewPool: "Havuzu görüntüle",
    noPredictions: "Henüz tahmin yok",
    onePrediction: "1 tahmin",
    predictions: "tahmin",
    openForPredictions: "Tahminlere açık",
    predictionsClosed: "Tahminler kapandı",
    resultsReady: "Sonuçlar hazır",
    cancelled: "İptal edildi",
    closed: "kapandı",
    left: "kaldı",
    backToPools: "Havuzlara dön",
    poolUnavailable: "Havuz kullanılamıyor",
    poolUnavailableBody: "En güncel havuz verisi yüklenemedi. Lütfen tekrar deneyin.",
    predictionsClose: "Tahmin kapanışı",
    predictionsStartIn: "Tahminlerin başlamasına",
    predictionsCloseIn: "Tahminlerin bitmesine",
    observationStartsIn: "Gözlemin başlamasına",
    observationEndsIn: "Gözlemin bitmesine",
    observationEnded: "Gözlem sona erdi",
    roundTiming: "Tur zamanlaması",
    predictionsOpenUntil: "Tahminler şu zamana kadar açık",
    observationRuns: "Fiyat gözlem aralığı",
    to: "ile",
    priceSource: "Fiyat kaynağı",
    verifyOnArc: "Arc üzerinde doğrula",
    viewRound: "Turu görüntüle",
    onePredictionCosts: "Bir tahminin ücreti tam olarak 1 USDC.",
    yourPredictedHigh: "Tahmin ettiğin en yüksek fiyat",
    yourPredictedLow: "Tahmin ettiğin en düşük fiyat",
    confirmBiometric: "Tahmini Touch ID, Face ID veya cihaz parolanla onayla. Onaydan sonra EXTREMA 1 USDC katılım işlemini otomatik gönderir.",
    confirmPrediction: "Tahmini onayla · 1 USDC",
    roundClosed: "Bu tur için tahminler kapandı.",
  },
} as const;

export function useCopy() {
  const { locale } = useLocale();
  return copy[locale];
}
