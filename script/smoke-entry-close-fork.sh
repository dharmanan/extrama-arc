#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
LOCAL_RPC="http://127.0.0.1:8547"
PORT=8547
POOL="0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f"
ROUND_ID=1
SMOKE_WALLET="0x1111111111111111111111111111111111111111"
SMOKE_PRICE_CENTS=99999999

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
    wait "$ANVIL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "EXTREMA entry-close fork smoke test"
echo "Upstream Arc RPC: $UPSTREAM_RPC"
echo "Pool: $POOL"
echo "Round: $ROUND_ID"
echo

ROUND_STATE="$(cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID"   --rpc-url "$UPSTREAM_RPC")"

ENTRY_CLOSE="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, ([0-9]+).*/\1/')"

if ! [[ "$ENTRY_CLOSE" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse entryCloseAt from onchain round state" >&2
  echo "$ROUND_STATE" >&2
  exit 1
fi

TARGET_TS=$((ENTRY_CLOSE + 1))

echo "Onchain entryCloseAt: $ENTRY_CLOSE"
echo "Fork target timestamp: $TARGET_TS"
echo

anvil   --fork-url "$UPSTREAM_RPC"   --port "$PORT"   --chain-id 5042002   --silent   > /tmp/extrema-entry-close-anvil.log 2>&1 &
ANVIL_PID=$!

for _ in $(seq 1 50); do
  if cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

CHAIN_ID="$(cast chain-id --rpc-url "$LOCAL_RPC")"
if [[ "$CHAIN_ID" != "5042002" ]]; then
  echo "ERROR: fork chain id mismatch: $CHAIN_ID" >&2
  exit 1
fi

cast rpc anvil_setNextBlockTimestamp "$TARGET_TS" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc evm_mine --rpc-url "$LOCAL_RPC" >/dev/null

BLOCK_TS_HEX="$(cast block latest --field timestamp --rpc-url "$LOCAL_RPC")"
BLOCK_TS="$(cast to-dec "$BLOCK_TS_HEX")"

echo "Fork chain ID: $CHAIN_ID"
echo "Fork block timestamp: $BLOCK_TS"

if (( BLOCK_TS <= ENTRY_CLOSE )); then
  echo "ERROR: fork timestamp did not move past entry close" >&2
  exit 1
fi

echo
echo "Read-only eth_call after close (expected EntryClosed):"
set +e
OUT="$(cast call "$POOL"   "enterPrediction(uint256,uint64)(uint256)"   "$ROUND_ID" "$SMOKE_PRICE_CENTS"   --from "$SMOKE_WALLET"   --rpc-url "$LOCAL_RPC" 2>&1)"
EXIT_CODE=$?
set -e

echo "$OUT"

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "ERROR: post-close entry unexpectedly succeeded on fork" >&2
  exit 1
fi

if [[ "$OUT" != *"EntryClosed"* ]]; then
  echo "ERROR: expected EntryClosed revert, got a different failure" >&2
  exit 1
fi

echo
echo "ENTRY_CLOSE_FORK_SMOKE=PASS"
echo "No Arc Testnet transaction was broadcast."
