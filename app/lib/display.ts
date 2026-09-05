export function humanRoundStatus(
  status: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED",
) {
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

export function formatLocalDateTime(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatLocalDate(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatTimeUntil(value: string) {
  const diffMs = new Date(value).getTime() - Date.now();

  if (diffMs <= 0) return "closed";

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
  }

  return `${Math.max(minutes, 1)}m left`;
}

export function formatEntryCount(count: number) {
  if (count === 0) return "No predictions yet";
  return count === 1 ? "1 prediction" : `${count} predictions`;
}

export function formatUsdc(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `${value} USDC`;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 6,
  }).format(numeric)} USDC`;
}
