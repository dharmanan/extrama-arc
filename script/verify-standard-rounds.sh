#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
PLAN_FILE="${EXTREMA_ROUND_PLAN_FILE:-.extrema-round-plan.env}"

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: $PLAN_FILE does not exist." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$PLAN_FILE"

forge script script/VerifyStandardRounds.s.sol:VerifyStandardRounds \
  --rpc-url "$RPC" \
  -vvv

echo
echo "STANDARD_ROUND_VERIFICATION=PASS"
