import type { Locale } from "../i18n";

const localeTag = (locale: Locale) => locale === "tr" ? "tr-TR" : "en-US";

export function humanRoundStatus(
  status: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED",
  locale: Locale = "en",
) {
  if (locale === "tr") {
    switch (status) {
      case "ENTRY_OPEN":
        return "Tahminlere açık";
      case "LOCKED":
        return "Tahminler kapandı";
      case "SETTLED":
        return "Sonuçlar hazır";
      case "CANCELLED":
        return "İptal edildi";
    }
  }

  switch (status) {
    case "ENTRY_OPEN":
      return "Open for predictions";
    case "LOCKED":
      return "Predictions closed";
    case "SETTLED":
      return "Results ready";
    case "CANCELLED":
      return "Cancelled";
  }
}

export function formatLocalDateTime(value: string, locale: Locale = "en") {
  const date = new Date(value);
  const formatted = new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  return `${formatted} UTC`;
}

export function formatLocalDate(value: string, locale: Locale = "en") {
  const date = new Date(value);
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatTimeUntil(value: string, locale: Locale = "en") {
  const diffMs = new Date(value).getTime() - Date.now();

  if (diffMs <= 0) return locale === "tr" ? "kapandı" : "closed";

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (locale === "tr") {
    if (days > 0) {
      return hours > 0 ? `${days}g ${hours}sa kaldı` : `${days}g kaldı`;
    }
    if (hours > 0) {
      return minutes > 0 ? `${hours}sa ${minutes}dk kaldı` : `${hours}sa kaldı`;
    }
    return `${Math.max(minutes, 1)}dk kaldı`;
  }

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
  }

  return `${Math.max(minutes, 1)}m left`;
}

export function formatEntryCount(count: number, locale: Locale = "en") {
  if (locale === "tr") {
    if (count === 0) return "Henüz tahmin yok";
    return count === 1 ? "1 tahmin" : `${count} tahmin`;
  }

  if (count === 0) return "No predictions yet";
  return count === 1 ? "1 prediction" : `${count} predictions`;
}

export function formatUsdc(value: string, locale: Locale = "en") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `${value} USDC`;
  return `${new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits: 6,
  }).format(numeric)} USDC`;
}
