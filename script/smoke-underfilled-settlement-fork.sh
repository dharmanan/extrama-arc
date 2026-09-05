#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
LOCAL_RPC="http://127.0.0.1:8549"
PORT=8549
POOL="0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f"
ROUND_ID=1
SMOKE_CALLER="0x1111111111111111111111111111111111111111"
SMOKE_RESOLVED_PRICE_CENTS=250000

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
    wait "$ANVIL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "EXTREMA underfilled-settlement fork smoke test"
echo "Upstream Arc RPC: $UPSTREAM_RPC"
echo "Pool: $POOL"
echo "Round: $ROUND_ID"
echo

ROUND_STATE="$(cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID"   --rpc-url "$UPSTREAM_RPC")"

OBS_END="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
ENTRY_COUNT="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
RESOLVER="$(cast call "$POOL" "resolver()(address)" --rpc-url "$UPSTREAM_RPC")"

if ! [[ "$OBS_END" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse observationEndAt from onchain round state" >&2
  echo "$ROUND_STATE" >&2
  exit 1
fi

if ! [[ "$ENTRY_COUNT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse entryCount from onchain round state" >&2
  echo "$ROUND_STATE" >&2
  exit 1
fi

if (( ENTRY_COUNT >= 3 )); then
  echo "ERROR: source round is no longer underfilled; expected fewer than 3 entries, found $ENTRY_COUNT" >&2
  exit 1
fi

TARGET_TS=$((OBS_END + 1))

echo "Onchain observationEndAt: $OBS_END"
echo "Onchain entryCount: $ENTRY_COUNT"
echo "Onchain resolver: $RESOLVER"
echo "Fork target timestamp: $TARGET_TS"
echo

anvil   --fork-url "$UPSTREAM_RPC"   --port "$PORT"   --chain-id 5042002   --silent   > /tmp/extrema-underfilled-settlement-anvil.log 2>&1 &
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

if (( BLOCK_TS <= OBS_END )); then
  echo "ERROR: fork timestamp did not advance past observation end" >&2
  exit 1
fi

cast rpc anvil_impersonateAccount "$SMOKE_CALLER" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$SMOKE_CALLER" 0x8AC7230489E80000 --rpc-url "$LOCAL_RPC" >/dev/null

echo
echo "Locking Round #$ROUND_ID on local fork only..."
cast send "$POOL"   "lockRound(uint256)"   "$ROUND_ID"   --from "$SMOKE_CALLER"   --unlocked   --rpc-url "$LOCAL_RPC"   >/dev/null

echo
echo "Read-only resolver settle call on underfilled round (expected NotEnoughEntries):"
set +e
OUT="$(cast call "$POOL"   "settleRound(uint256,uint64)"   "$ROUND_ID" "$SMOKE_RESOLVED_PRICE_CENTS"   --from "$RESOLVER"   --rpc-url "$LOCAL_RPC" 2>&1)"
EXIT_CODE=$?
set -e

echo "$OUT"

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "ERROR: underfilled settlement unexpectedly succeeded on fork" >&2
  exit 1
fi

if [[ "$OUT" != *"NotEnoughEntries"* ]]; then
  echo "ERROR: expected NotEnoughEntries revert, got a different failure" >&2
  exit 1
fi

echo
echo "UNDERFILLED_SETTLEMENT_FORK_SMOKE=PASS"
echo "No Arc Testnet transaction was broadcast."
