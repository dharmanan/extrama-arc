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
    if (saved === "en" || saved === "tr") {
      setLocaleState(saved);
      document.documentElement.lang = saved;
    }
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
    archive: "Archive",
    howItWorks: "How it works",
    myTickets: "My Tickets",
    createConnectWallet: "Create / Connect Wallet",
    walletShort: "Wallet",
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
    home: {
      eyebrow: "Arc Testnet",
      titleLineOne: "Small Predictions.",
      titleLineTwo: "Real Rewards.",
      asideLineOne: "Same markets.",
      asideLineTwo: "Bigger stories.",
      verbPredict: "Predict",
      verbExplore: "Explore",
      verbCompete: "Compete",
      verbOwn: "Own",
      lede: "Predict the next high or low of BTC, ETH, SOL or HYPE. Every entry costs exactly 1 USDC. Every result settles onchain.",
      ctaPrimary: "Start predicting",
      ctaSecondary: "How it works",
      bandSource: "Live mark price",
      bandEntry: "1 USDC entry",
      bandPools: "24 standard pools",

      mechanicEyebrow: "The mechanic",
      mechanicTitle: "One exact price. One ticket.",
      mechanicLede:
        "You name a single price. Not a direction, not a range. When the round settles, the three closest predictions take the pool.",
      step1Title: "Choose a market",
      step1Body: "Four assets, two directions, three time horizons. 24 pools in total.",
      step2Title: "Name one exact price",
      step2Body: "Each exact price can be taken only once per round. Pick it before someone else does.",
      step3Title: "Pay exactly 1 USDC",
      step3Body: "Confirmed with your passkey. No variable stake, so no one can buy a bigger share.",
      step4Title: "Hold the NFT ticket",
      step4Body: "The ticket carries the claim. Whoever owns it when the round settles can claim the reward.",

      gridEyebrow: "The grid",
      gridTitle: "Four assets. Two directions. Three horizons.",
      gridLede: "24 standard pools, always the same shape. Pick the one you have a view on.",
      gridAssetsLabel: "Assets",
      gridDirectionsLabel: "Directions",
      horizonsEyebrow: "Horizons",
      horizonDayKey: "Day",
      horizonDayWindow: "24 hours",
      horizonDayBody: "One trading day of observation. Decided by tomorrow.",
      horizonWeekKey: "Week",
      horizonWeekWindow: "7 days",
      horizonWeekBody: "A full week of price action. Room for a story to develop.",
      horizonQuarterKey: "Quarter",
      horizonQuarterWindow: "3 months",
      horizonQuarterBody: "A long view. The widest range, and the hardest call to make.",

      directionsEyebrow: "Two directions",
      directionHighKey: "High",
      directionHighBody: "The highest price printed in the window.",
      directionLowKey: "Low",
      directionLowBody: "The lowest price printed in the window.",

      verifyEyebrow: "Verifiable result",
      verifyTitle: "Every round leaves evidence.",
      verifyLede:
        "Nothing about the outcome depends on trusting us. The inputs and the payout are both checkable.",
      verifyChainTag: "Chain",
      verifyChainTitle: "Arc Testnet",
      verifyChainBody:
        "Entries, tickets, settlement and payouts are contract state. Every transaction is viewable on ArcScan.",
      verifyPriceTag: "Price",
      verifyPriceTitle: "Binance mark price",
      verifyPriceBody:
        "Settlement reads the Binance USDⓈ-M Futures mark price over the exact observation window.",
      verifyOwnerTag: "Ownership",
      verifyOwnerTitle: "NFT ticket",
      verifyOwnerBody:
        "The claim follows the ticket. Transfer it and the new owner holds the right to claim or refund.",

      payoutEyebrow: "Payout model",
      payoutTitle: "The three closest predictions split the pool.",
      payoutBody:
        "Fixed shares, known before you enter. If a round does not fill, entries are refunded instead.",
      payoutFirst: "Closest",
      payoutSecond: "Second",
      payoutThird: "Third",
      payoutTreasury: "Treasury",

      closeTitle: "Name your price.",
      closeLede:
        "Open a pool, pick the exact number you believe in, and hold the ticket until the round settles.",
      footNote: "EXTREMA · Arc Testnet",
    },
  },
  tr: {
    pools: "Havuzlar",
    leaderboard: "Liderlik",
    archive: "Arşiv",
    howItWorks: "Nasıl çalışır",
    myTickets: "Biletlerim",
    createConnectWallet: "Cüzdan Oluştur / Bağla",
    walletShort: "Cüzdan",
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
    home: {
      eyebrow: "Arc Testnet",
      titleLineOne: "Küçük Tahminler.",
      titleLineTwo: "Gerçek Ödüller.",
      asideLineOne: "Aynı piyasalar.",
      asideLineTwo: "Daha büyük hikâyeler.",
      verbPredict: "Tahmin et",
      verbExplore: "Keşfet",
      verbCompete: "Yarış",
      verbOwn: "Sahip ol",
      lede: "BTC, ETH, SOL veya HYPE'ın sıradaki en yüksek ya da en düşük fiyatını tahmin et. Her katılım tam olarak 1 USDC. Her sonuç zincir üstünde kesinleşir.",
      ctaPrimary: "Tahmine başla",
      ctaSecondary: "Nasıl çalışır",
      bandSource: "Canlı fiyat",
      bandEntry: "1 USDC katılım",
      bandPools: "24 standart havuz",

      mechanicEyebrow: "Mekanik",
      mechanicTitle: "Tek bir fiyat. Tek bir bilet.",
      mechanicLede:
        "Bir yön ya da aralık değil, tek bir fiyat söylersin. Tur kapandığında en yakın üç tahmin havuzu paylaşır.",
      step1Title: "Bir piyasa seç",
      step1Body: "Dört varlık, iki yön, üç zaman aralığı. Toplam 24 havuz.",
      step2Title: "Tek bir fiyat söyle",
      step2Body: "Her fiyat bir turda yalnızca bir kez alınabilir. Başkası almadan seç.",
      step3Title: "Tam olarak 1 USDC öde",
      step3Body: "Passkey ile onaylanır. Değişken katılım yok, kimse daha büyük pay satın alamaz.",
      step4Title: "NFT bileti elinde tut",
      step4Body: "Hak biletin üzerindedir. Tur kapandığında bilet kimdeyse ödülü o talep eder.",

      gridEyebrow: "Yapı",
      gridTitle: "Dört varlık. İki yön. Üç zaman aralığı.",
      gridLede: "Yirmi dört standart havuz, her zaman aynı biçimde. Hakkında fikrin olanı seç.",
      gridAssetsLabel: "Varlıklar",
      gridDirectionsLabel: "Yön",
      horizonsEyebrow: "Zaman aralığı",
      horizonDayKey: "Gün",
      horizonDayWindow: "24 saat",
      horizonDayBody: "Tek bir işlem günü gözlenir. Yarın sonuçlanır.",
      horizonWeekKey: "Hafta",
      horizonWeekWindow: "7 gün",
      horizonWeekBody: "Tam bir haftalık fiyat hareketi. Hikâyenin gelişmesine yer var.",
      horizonQuarterKey: "Çeyrek",
      horizonQuarterWindow: "3 ay",
      horizonQuarterBody: "Uzun vade. En geniş aralık ve en zor karar.",

      directionsEyebrow: "İki yön",
      directionHighKey: "Yüksek",
      directionHighBody: "Aralıkta görülen en yüksek fiyat.",
      directionLowKey: "Düşük",
      directionLowBody: "Aralıkta görülen en düşük fiyat.",

      verifyEyebrow: "Doğrulanabilir sonuç",
      verifyTitle: "Her tur kanıt bırakır.",
      verifyLede:
        "Sonucun hiçbir parçası bize güvenmeni gerektirmez. Girdiler de ödeme de kontrol edilebilir.",
      verifyChainTag: "Zincir",
      verifyChainTitle: "Arc Testnet",
      verifyChainBody:
        "Katılımlar, biletler, kesinleşme ve ödemeler kontrat durumudur. Her işlem ArcScan üzerinde görülebilir.",
      verifyPriceTag: "Fiyat",
      verifyPriceTitle: "Binance mark fiyatı",
      verifyPriceBody:
        "Kesinleşme, tam gözlem aralığı boyunca Binance USDⓈ-M Vadeli mark fiyatını okur.",
      verifyOwnerTag: "Sahiplik",
      verifyOwnerTitle: "NFT bilet",
      verifyOwnerBody:
        "Hak bileti takip eder. Bileti devredersen talep ya da iade hakkı yeni sahibe geçer.",

      payoutEyebrow: "Ödeme modeli",
      payoutTitle: "En yakın üç tahmin havuzu paylaşır.",
      payoutBody:
        "Paylar sabittir ve katılmadan önce bellidir. Tur dolmazsa katılımlar iade edilir.",
      payoutFirst: "En yakın",
      payoutSecond: "İkinci",
      payoutThird: "Üçüncü",
      payoutTreasury: "Hazine",

      closeTitle: "Fiyatını söyle.",
      closeLede:
        "Bir havuz aç, inandığın tam sayıyı seç ve tur kapanana kadar bileti elinde tut.",
      footNote: "EXTREMA · Arc Testnet",
    },
  },
} as const;

export function useCopy() {
  const { locale } = useLocale();
  return copy[locale];
}
