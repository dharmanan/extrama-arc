#!/usr/bin/env bash
set -euo pipefail

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
PLAN_FILE="${EXTREMA_ROUND_PLAN_FILE:-.extrema-round-plan.env}"

NOW_RAW="$(cast block latest --rpc-url "$RPC" --field timestamp)"

python3 - "$NOW_RAW" "$PLAN_FILE" <<'PY'
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from pathlib import Path
import sys

raw = sys.argv[1].strip()
plan_path = Path(sys.argv[2])

now_ts = int(raw, 0)
now = datetime.fromtimestamp(now_ts, tz=timezone.utc)

def midnight(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)

def next_daily(now: datetime):
    start = midnight(now) + timedelta(days=1)
    close = start - timedelta(hours=4)
    if now >= close:
        start += timedelta(days=1)
        close = start - timedelta(hours=4)
    end = start + timedelta(days=1)
    return close, start, end

def next_weekly(now: datetime):
    base = midnight(now)
    days_until_monday = (7 - base.weekday()) % 7
    start = base + timedelta(days=days_until_monday)
    close = start - timedelta(days=1)
    if now >= close:
        start += timedelta(days=7)
        close = start - timedelta(days=1)
    end = start + timedelta(days=7)
    return close, start, end

def add_months_start(dt: datetime, months: int) -> datetime:
    total = (dt.year * 12 + (dt.month - 1)) + months
    year, month0 = divmod(total, 12)
    return datetime(year, month0 + 1, 1, tzinfo=timezone.utc)

def next_quarterly(now: datetime):
    current_q_month = ((now.month - 1) // 3) * 3 + 1
    current_q_start = datetime(now.year, current_q_month, 1, tzinfo=timezone.utc)
    start = add_months_start(current_q_start, 3)
    close = start - timedelta(days=1)
    if now >= close:
        start = add_months_start(start, 3)
        close = start - timedelta(days=1)
    end = add_months_start(start, 3)
    return close, start, end

daily = next_daily(now)
weekly = next_weekly(now)
quarterly = next_quarterly(now)

def ts(dt: datetime) -> int:
    return int(dt.timestamp())

lines = [
    f"export EXTREMA_DAILY_ENTRY_CLOSE_AT={ts(daily[0])}",
    f"export EXTREMA_DAILY_OBSERVATION_START_AT={ts(daily[1])}",
    f"export EXTREMA_DAILY_OBSERVATION_END_AT={ts(daily[2])}",
    f"export EXTREMA_WEEKLY_ENTRY_CLOSE_AT={ts(weekly[0])}",
    f"export EXTREMA_WEEKLY_OBSERVATION_START_AT={ts(weekly[1])}",
    f"export EXTREMA_WEEKLY_OBSERVATION_END_AT={ts(weekly[2])}",
    f"export EXTREMA_QUARTERLY_ENTRY_CLOSE_AT={ts(quarterly[0])}",
    f"export EXTREMA_QUARTERLY_OBSERVATION_START_AT={ts(quarterly[1])}",
    f"export EXTREMA_QUARTERLY_OBSERVATION_END_AT={ts(quarterly[2])}",
]
plan_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

print("EXTREMA standard Round #1 plan")
print(f"Arc block time: {now.isoformat().replace('+00:00', 'Z')}")
print()
for label, values in (
    ("DAILY", daily),
    ("WEEKLY", weekly),
    ("QUARTERLY", quarterly),
):
    close, start, end = values
    print(label)
    print(f"  Entry close:       {close.isoformat().replace('+00:00', 'Z')}  ({ts(close)})")
    print(f"  Observation start: {start.isoformat().replace('+00:00', 'Z')}  ({ts(start)})")
    print(f"  Observation end:   {end.isoformat().replace('+00:00', 'Z')}  ({ts(end)})")
    print()

print(f"Plan saved to: {plan_path}")
print("No transaction has been sent.")
PY
