#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -z "${EXTREMA_DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo "ERROR: EXTREMA_DEPLOYER_PRIVATE_KEY is not set in this terminal." >&2
  exit 1
fi

./script/prepare-standard-rounds.sh
# shellcheck disable=SC1091
source .extrema-round-plan.env

forge script script/CreateStandardRounds.s.sol:CreateStandardRounds \
  --rpc-url "${ARC_RPC_URL:-https://rpc.testnet.arc.network}" \
  -vvv

echo
echo "STANDARD_ROUND_SIMULATION=PASS"
echo "No transaction was broadcast."
