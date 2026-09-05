#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
LOCAL_RPC="http://127.0.0.1:8551"
PORT=8551

POOL="0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f"
TICKET="0xF65Cf4a67299ad596e139e3F6a9594E809F05637"
USDC="0x3600000000000000000000000000000000000000"
ROUND_ID=1
TOKEN_ID=1

ORIGINAL_ENTRANT="0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b"
EXPECTED_CURRENT_OWNER="0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321"
SMOKE_LOCK_CALLER="0x1111111111111111111111111111111111111111"
STAKE_RAW=1000000

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    kill "$ANVIL_PID" >/dev/null 2>&1 || true
    wait "$ANVIL_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

echo "EXTREMA transferred-ticket refund fork smoke test"
echo "Upstream Arc RPC: $UPSTREAM_RPC"
echo "Pool: $POOL"
echo "Ticket: $TICKET #$TOKEN_ID"
echo "Round: $ROUND_ID"
echo

ROUND_STATE="$(cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID"   --rpc-url "$UPSTREAM_RPC")"

OBS_END="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
ENTRY_COUNT="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
ESCROW_BEFORE="$(printf '%s\n' "$ROUND_STATE" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
RESOLVER="$(cast call "$POOL" "resolver()(address)" --rpc-url "$UPSTREAM_RPC")"
CURRENT_OWNER="$(cast call "$TICKET" "ownerOf(uint256)(address)" "$TOKEN_ID" --rpc-url "$UPSTREAM_RPC")"

if ! [[ "$OBS_END" =~ ^[0-9]+$ && "$ENTRY_COUNT" =~ ^[0-9]+$ && "$ESCROW_BEFORE" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse source round state" >&2
  echo "$ROUND_STATE" >&2
  exit 1
fi

if (( ENTRY_COUNT != 1 )); then
  echo "ERROR: expected exactly 1 entry in source round, found $ENTRY_COUNT" >&2
  exit 1
fi

if [[ "$(lower "$CURRENT_OWNER")" != "$(lower "$EXPECTED_CURRENT_OWNER")" ]]; then
  echo "ERROR: Ticket #$TOKEN_ID current owner changed." >&2
  echo "Expected: $EXPECTED_CURRENT_OWNER" >&2
  echo "Actual:   $CURRENT_OWNER" >&2
  exit 1
fi

if [[ "$(lower "$CURRENT_OWNER")" == "$(lower "$ORIGINAL_ENTRANT")" ]]; then
  echo "ERROR: source ticket is no longer transferred" >&2
  exit 1
fi

TARGET_TS=$((OBS_END + 1))

echo "Onchain observationEndAt: $OBS_END"
echo "Onchain entryCount: $ENTRY_COUNT"
echo "Onchain escrowRemaining: $ESCROW_BEFORE"
echo "Onchain resolver: $RESOLVER"
echo "Original entrant: $ORIGINAL_ENTRANT"
echo "Current NFT owner: $CURRENT_OWNER"
echo "Fork target timestamp: $TARGET_TS"
echo

anvil   --fork-url "$UPSTREAM_RPC"   --port "$PORT"   --chain-id 5042002   --silent   > /tmp/extrema-transferred-refund-anvil.log 2>&1 &
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

# Lock permissionlessly after entry close.
cast rpc anvil_impersonateAccount "$SMOKE_LOCK_CALLER" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$SMOKE_LOCK_CALLER" 0x8AC7230489E80000 --rpc-url "$LOCAL_RPC" >/dev/null

echo "Locking Round #$ROUND_ID on local fork only..."
cast send "$POOL"   "lockRound(uint256)"   "$ROUND_ID"   --from "$SMOKE_LOCK_CALLER"   --unlocked   --rpc-url "$LOCAL_RPC"   >/dev/null

# Cancel as the deployed resolver.
cast rpc anvil_impersonateAccount "$RESOLVER" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$RESOLVER" 0x8AC7230489E80000 --rpc-url "$LOCAL_RPC" >/dev/null

echo "Cancelling Round #$ROUND_ID on local fork only..."
cast send "$POOL"   "cancelRound(uint256)"   "$ROUND_ID"   --from "$RESOLVER"   --unlocked   --rpc-url "$LOCAL_RPC"   >/dev/null

echo
echo "Original entrant refund attempt (expected NotTicketOwner):"
set +e
ORIGINAL_OUT="$(cast call "$POOL"   "refund(uint256)"   "$TOKEN_ID"   --from "$ORIGINAL_ENTRANT"   --rpc-url "$LOCAL_RPC" 2>&1)"
ORIGINAL_EXIT=$?
set -e

echo "$ORIGINAL_OUT"

if [[ $ORIGINAL_EXIT -eq 0 || "$ORIGINAL_OUT" != *"NotTicketOwner"* ]]; then
  echo "ERROR: original entrant was not rejected with NotTicketOwner" >&2
  exit 1
fi

OWNER_USDC_BEFORE="$(cast call "$USDC" "balanceOf(address)(uint256)" "$CURRENT_OWNER" --rpc-url "$LOCAL_RPC")"
POOL_USDC_BEFORE="$(cast call "$USDC" "balanceOf(address)(uint256)" "$POOL" --rpc-url "$LOCAL_RPC")"

if ! [[ "$OWNER_USDC_BEFORE" =~ ^[0-9]+$ && "$POOL_USDC_BEFORE" =~ ^[0-9]+$ ]]; then
  echo "ERROR: failed to read pre-refund USDC balances" >&2
  exit 1
fi

cast rpc anvil_impersonateAccount "$CURRENT_OWNER" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$CURRENT_OWNER" 0x8AC7230489E80000 --rpc-url "$LOCAL_RPC" >/dev/null

echo
echo "Refunding Ticket #$TOKEN_ID to current NFT owner on local fork..."
cast send "$POOL"   "refund(uint256)"   "$TOKEN_ID"   --from "$CURRENT_OWNER"   --unlocked   --rpc-url "$LOCAL_RPC"   >/dev/null

OWNER_USDC_AFTER="$(cast call "$USDC" "balanceOf(address)(uint256)" "$CURRENT_OWNER" --rpc-url "$LOCAL_RPC")"
POOL_USDC_AFTER="$(cast call "$USDC" "balanceOf(address)(uint256)" "$POOL" --rpc-url "$LOCAL_RPC")"
ROUND_AFTER="$(cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID"   --rpc-url "$LOCAL_RPC")"
ESCROW_AFTER="$(printf '%s\n' "$ROUND_AFTER" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
REFUNDED="$(cast call "$POOL" "refunded(uint256)(bool)" "$TOKEN_ID" --rpc-url "$LOCAL_RPC")"

if ! [[ "$OWNER_USDC_AFTER" =~ ^[0-9]+$ && "$POOL_USDC_AFTER" =~ ^[0-9]+$ && "$ESCROW_AFTER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: failed to parse post-refund state" >&2
  exit 1
fi

OWNER_DELTA=$((OWNER_USDC_AFTER - OWNER_USDC_BEFORE))
POOL_DELTA=$((POOL_USDC_BEFORE - POOL_USDC_AFTER))

if (( OWNER_DELTA != STAKE_RAW )); then
  echo "ERROR: current owner did not receive exactly 1 USDC; delta=$OWNER_DELTA" >&2
  exit 1
fi

if (( POOL_DELTA != STAKE_RAW )); then
  echo "ERROR: pool USDC did not decrease by exactly 1 USDC; delta=$POOL_DELTA" >&2
  exit 1
fi

if [[ "$ESCROW_AFTER" != "0" ]]; then
  echo "ERROR: expected round escrowRemaining=0 after refund, got $ESCROW_AFTER" >&2
  exit 1
fi

if [[ "$REFUNDED" != "true" ]]; then
  echo "ERROR: refunded flag is not true" >&2
  exit 1
fi

echo
echo "Second refund attempt (expected AlreadyRefunded):"
set +e
SECOND_OUT="$(cast call "$POOL"   "refund(uint256)"   "$TOKEN_ID"   --from "$CURRENT_OWNER"   --rpc-url "$LOCAL_RPC" 2>&1)"
SECOND_EXIT=$?
set -e

echo "$SECOND_OUT"

if [[ $SECOND_EXIT -eq 0 || "$SECOND_OUT" != *"AlreadyRefunded"* ]]; then
  echo "ERROR: second refund was not rejected with AlreadyRefunded" >&2
  exit 1
fi

echo
echo "TRANSFERRED_REFUND_FORK_SMOKE=PASS"
echo "Original entrant rejection: NotTicketOwner"
echo "Current owner refund received: $OWNER_DELTA raw USDC"
echo "Pool USDC decrease: $POOL_DELTA raw USDC"
echo "Round escrowRemaining after refund: $ESCROW_AFTER"
echo "Double refund rejection: AlreadyRefunded"
echo "No Arc Testnet transaction was broadcast."
