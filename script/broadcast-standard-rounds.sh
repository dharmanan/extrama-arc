#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
PLAN_FILE="${EXTREMA_ROUND_PLAN_FILE:-.extrema-round-plan.env}"

if [[ -z "${EXTREMA_DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo "ERROR: EXTREMA_DEPLOYER_PRIVATE_KEY is not set in this terminal." >&2
  exit 1
fi

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: $PLAN_FILE does not exist. Run ./script/simulate-standard-rounds.sh first." >&2
  exit 1
fi

# Reuse the exact plan that passed simulation. Do not regenerate it here.
# shellcheck disable=SC1090
source "$PLAN_FILE"

NOW_RAW="$(cast block latest --rpc-url "$RPC" --field timestamp)"
NOW_DEC=$((NOW_RAW))

for var in   EXTREMA_DAILY_ENTRY_CLOSE_AT   EXTREMA_WEEKLY_ENTRY_CLOSE_AT   EXTREMA_QUARTERLY_ENTRY_CLOSE_AT
do
  value="${!var}"
  if (( NOW_DEC >= value )); then
    echo "ERROR: saved plan is already past an entry cutoff ($var=$value)." >&2
    echo "Run ./script/simulate-standard-rounds.sh again to generate a fresh plan." >&2
    exit 1
  fi
done

echo "Broadcasting the exact Round #1 plan that passed simulation."
echo "Chain ID: $(cast chain-id --rpc-url "$RPC")"

forge script script/CreateStandardRounds.s.sol:CreateStandardRounds \
  --rpc-url "$RPC" \
  --broadcast \
  -vvv

echo
echo "STANDARD_ROUND_BROADCAST=COMPLETE"
echo "Broadcast artifact: broadcast/CreateStandardRounds.s.sol/5042002/run-latest.json"
