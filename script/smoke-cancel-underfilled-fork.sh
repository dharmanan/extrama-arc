#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
LOCAL_RPC="http://127.0.0.1:8550"
PORT=8550
POOL="0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f"
ROUND_ID=1
SMOKE_CALLER="0x1111111111111111111111111111111111111111"

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
    wait "$ANVIL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "EXTREMA underfilled-cancellation fork smoke test"
echo "Upstream Arc RPC: $UPSTREAM_RPC"
echo "Pool: $POOL"
echo "Round: $ROUND_ID"
echo

ROUND_STATE="$(cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID"   --rpc-url "$UPSTREAM_RPC")"

OBS_END="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
ENTRY_COUNT="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
ESCROW_BEFORE="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
RESOLVER="$(cast call "$POOL" "resolver()(address)" --rpc-url "$UPSTREAM_RPC")"

if ! [[ "$OBS_END" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse observationEndAt" >&2
  echo "$ROUND_STATE" >&2
  exit 1
fi

if ! [[ "$ENTRY_COUNT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse entryCount" >&2
  echo "$ROUND_STATE" >&2
  exit 1
fi

if ! [[ "$ESCROW_BEFORE" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse escrowRemaining" >&2
  echo "$ROUND_STATE" >&2
  exit 1
fi

if (( ENTRY_COUNT >= 3 )); then
  echo "ERROR: source round is no longer underfilled; found $ENTRY_COUNT entries" >&2
  exit 1
fi

TARGET_TS=$((OBS_END + 1))

echo "Onchain observationEndAt: $OBS_END"
echo "Onchain entryCount: $ENTRY_COUNT"
echo "Onchain escrowRemaining: $ESCROW_BEFORE"
echo "Onchain resolver: $RESOLVER"
echo "Fork target timestamp: $TARGET_TS"
echo

anvil   --fork-url "$UPSTREAM_RPC"   --port "$PORT"   --chain-id 5042002   --silent   > /tmp/extrema-underfilled-cancel-anvil.log 2>&1 &
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

cast rpc anvil_impersonateAccount "$SMOKE_CALLER" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$SMOKE_CALLER" 0x8AC7230489E80000 --rpc-url "$LOCAL_RPC" >/dev/null

echo "Locking Round #$ROUND_ID on local fork only..."
cast send "$POOL"   "lockRound(uint256)"   "$ROUND_ID"   --from "$SMOKE_CALLER"   --unlocked   --rpc-url "$LOCAL_RPC"   >/dev/null

cast rpc anvil_impersonateAccount "$RESOLVER" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$RESOLVER" 0x8AC7230489E80000 --rpc-url "$LOCAL_RPC" >/dev/null

echo "Cancelling underfilled Round #$ROUND_ID on local fork only..."
cast send "$POOL"   "cancelRound(uint256)"   "$ROUND_ID"   --from "$RESOLVER"   --unlocked   --rpc-url "$LOCAL_RPC"   >/dev/null

ROUND_AFTER="$(cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID"   --rpc-url "$LOCAL_RPC")"

STATUS_AFTER="$(printf '%s\n' "$ROUND_AFTER" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
ESCROW_AFTER="$(printf '%s\n' "$ROUND_AFTER" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"

echo
echo "Local fork round state after cancellation:"
echo "$ROUND_AFTER"

if [[ "$STATUS_AFTER" != "3" ]]; then
  echo "ERROR: expected CANCELLED status enum 3, got $STATUS_AFTER" >&2
  exit 1
fi

if [[ "$ESCROW_AFTER" != "$ESCROW_BEFORE" ]]; then
  echo "ERROR: cancellation changed escrowRemaining: before=$ESCROW_BEFORE after=$ESCROW_AFTER" >&2
  exit 1
fi

echo
echo "CANCEL_UNDERFILLED_FORK_SMOKE=PASS"
echo "Status: CANCELLED"
echo "Escrow preserved for refund: $ESCROW_AFTER"
echo "No Arc Testnet transaction was broadcast."
