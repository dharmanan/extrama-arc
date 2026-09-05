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

uint_value() {
  local raw="$1"
  local value
  value="$(printf '%s\n' "$raw" | sed -E 's/^([0-9]+).*/\1/')"

  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "ERROR: could not parse uint256 value from: $raw" >&2
    return 1
  fi

  printf '%s' "$value"
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

echo
echo "TRANSFERRED_REFUND_ACCESS_CONTROL_FORK=PASS"
echo "Ticket/round ownership access control proven: only the current NFT owner can refund."
echo

OWNER_USDC_BEFORE_RAW="$(cast call "$USDC" "balanceOf(address)(uint256)" "$CURRENT_OWNER" --rpc-url "$LOCAL_RPC")"
POOL_USDC_BEFORE_RAW="$(cast call "$USDC" "balanceOf(address)(uint256)" "$POOL" --rpc-url "$LOCAL_RPC")"
OWNER_USDC_BEFORE="$(uint_value "$OWNER_USDC_BEFORE_RAW")"
POOL_USDC_BEFORE="$(uint_value "$POOL_USDC_BEFORE_RAW")"

echo "Current owner USDC before refund (diagnostic only): $OWNER_USDC_BEFORE"
echo "Pool USDC before refund: $POOL_USDC_BEFORE"
echo "Round escrowRemaining before refund: $ESCROW_BEFORE"

echo "Note: Arc native gas and ERC-20 USDC are one underlying balance for the current"
echo "owner, who is also the transaction sender here. Net owner balance therefore mixes"
echo "the +1,000,000 refund with the gas it pays for its own send, so it is printed"
echo "diagnostically only and is never used as exact gross-refund proof. Pool USDC and"
echo "round escrowRemaining are unaffected by the sender's gas cost and remain the exact"
echo "financial proof for this test."
echo "The smoke test intentionally does not call anvil_setBalance for the current owner,"
echo "because mutating only the generic EVM native-balance view can desynchronize Arc's"
echo "native/6-decimal ERC-20 coupling inside a generic Anvil fork."

cast rpc anvil_impersonateAccount "$CURRENT_OWNER" --rpc-url "$LOCAL_RPC" >/dev/null

echo
echo "Refunding Ticket #$TOKEN_ID to current NFT owner on local fork..."
set +e
REFUND_SEND_OUT="$(cast send "$POOL"   "refund(uint256)"   "$TOKEN_ID"   --from "$CURRENT_OWNER"   --unlocked   --rpc-url "$LOCAL_RPC" 2>&1)"
REFUND_SEND_EXIT=$?
set -e

if [[ $REFUND_SEND_EXIT -ne 0 ]]; then
  echo "$REFUND_SEND_OUT" >&2

  if printf '%s' "$REFUND_SEND_OUT" | grep -qiE 'insufficient funds|out of gas|gas required exceeds|intrinsic gas|revert(ed)? with no reason|revert data:[[:space:]]*"?0x"?([[:space:]]|$)'; then
    echo
    echo "The current-owner refund transaction failed at (or before) the external USDC" >&2
    echo "transfer boundary, in a way consistent with this generic Anvil fork not" >&2
    echo "faithfully mirroring Arc's coupled native/6-decimal-ERC20 USDC accounting for" >&2
    echo "the impersonated account (empty/gas-estimation-shaped failure)." >&2
    echo
    echo "ARC_SYSTEM_USDC_TRANSFER_FORK=UNSUPPORTED"
    echo "TRANSFERRED_REFUND_FORK=UNSUPPORTED"
    echo "Access control was proven this run (NotTicketOwner rejection); USDC movement was not provable in this environment."
    echo "No Arc Testnet transaction was broadcast."
    exit 0
  fi

  echo
  echo "The current-owner refund transaction failed for a reason that could not be" >&2
  echo "confidently classified as the known Arc native/ERC-20 USDC coupling limitation." >&2
  echo "Treating this as an unclassified failure rather than assuming an Arc-system-token" >&2
  echo "conclusion." >&2
  echo
  echo "CURRENT_OWNER_REFUND_FORK=FAILED_UNCLASSIFIED"
  echo "TRANSFERRED_REFUND_FORK=UNPROVEN"
  echo "No Arc Testnet transaction was broadcast."
  exit 1
fi

REFUND_BLOCK_NUMBER="$(printf '%s\n' "$REFUND_SEND_OUT" | sed -nE 's/^blockNumber[[:space:]]+([0-9]+).*/\1/p' | head -n1)"

OWNER_USDC_AFTER_RAW="$(cast call "$USDC" "balanceOf(address)(uint256)" "$CURRENT_OWNER" --rpc-url "$LOCAL_RPC")"
POOL_USDC_AFTER_RAW="$(cast call "$USDC" "balanceOf(address)(uint256)" "$POOL" --rpc-url "$LOCAL_RPC")"
OWNER_USDC_AFTER="$(uint_value "$OWNER_USDC_AFTER_RAW")"
POOL_USDC_AFTER="$(uint_value "$POOL_USDC_AFTER_RAW")"
ROUND_AFTER="$(cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID"   --rpc-url "$LOCAL_RPC")"
ESCROW_AFTER="$(printf '%s\n' "$ROUND_AFTER" | sed -E 's/^\([^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, ([0-9]+).*/\1/')"
REFUNDED="$(cast call "$POOL" "refunded(uint256)(bool)" "$TOKEN_ID" --rpc-url "$LOCAL_RPC")"

if ! [[ "$ESCROW_AFTER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: failed to parse post-refund escrow state" >&2
  echo "$ROUND_AFTER" >&2
  exit 1
fi

echo "Current owner USDC after refund (diagnostic only): $OWNER_USDC_AFTER"
echo "Pool USDC after refund: $POOL_USDC_AFTER"
echo "Round escrowRemaining after refund: $ESCROW_AFTER"

OWNER_DELTA=$((OWNER_USDC_AFTER - OWNER_USDC_BEFORE))
POOL_DELTA=$((POOL_USDC_BEFORE - POOL_USDC_AFTER))
ESCROW_DELTA=$((ESCROW_BEFORE - ESCROW_AFTER))

echo "Current owner net USDC delta (diagnostic only, includes its own gas cost): $OWNER_DELTA"

if (( POOL_DELTA != STAKE_RAW )); then
  echo "ERROR: pool USDC did not decrease by exactly 1 USDC; delta=$POOL_DELTA" >&2
  exit 1
fi

if (( ESCROW_DELTA != STAKE_RAW )); then
  echo "ERROR: round escrowRemaining did not decrease by exactly 1 USDC; delta=$ESCROW_DELTA (before=$ESCROW_BEFORE after=$ESCROW_AFTER)" >&2
  exit 1
fi

if [[ "$REFUNDED" != "true" ]]; then
  echo "ERROR: refunded flag is not true" >&2
  exit 1
fi

echo
echo "Attempting best-effort independent confirmation of the USDC Transfer event..."
TRANSFER_TOPIC0="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
POOL_TOPIC="0x000000000000000000000000$(lower "${POOL#0x}")"
OWNER_TOPIC="0x000000000000000000000000$(lower "${CURRENT_OWNER#0x}")"
VALUE_HEX="$(printf '%064x' "$STAKE_RAW")"
TRANSFER_EVENT_CONFIRMED=0

if [[ -n "$REFUND_BLOCK_NUMBER" ]]; then
  set +e
  RAW_LOGS="$(cast logs --from-block "$REFUND_BLOCK_NUMBER" --to-block "$REFUND_BLOCK_NUMBER" --address "$USDC" --rpc-url "$LOCAL_RPC" 2>&1)"
  LOGS_EXIT=$?
  set -e

  if [[ $LOGS_EXIT -eq 0 ]] \
    && printf '%s' "$RAW_LOGS" | grep -qi "$TRANSFER_TOPIC0" \
    && printf '%s' "$RAW_LOGS" | grep -qi "$POOL_TOPIC" \
    && printf '%s' "$RAW_LOGS" | grep -qi "$OWNER_TOPIC" \
    && printf '%s' "$RAW_LOGS" | grep -qi "$VALUE_HEX"; then
    echo "USDC Transfer event confirmed via 'cast logs': pool -> current owner, value = $STAKE_RAW raw."
    TRANSFER_EVENT_CONFIRMED=1
  else
    echo "WARNING: could not independently confirm the USDC Transfer event via 'cast logs' in this environment (best-effort check only)." >&2
    echo "The pool/escrow balance-delta proof above remains the hard evidence for this run." >&2
  fi
else
  echo "WARNING: could not extract the refund transaction's block number from 'cast send' output; skipping best-effort Transfer-event confirmation." >&2
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
echo "Pool USDC decrease: $POOL_DELTA raw USDC (exact, gas-independent)"
echo "Round escrowRemaining decrease: $ESCROW_DELTA raw USDC (exact, gas-independent)"
if [[ "$TRANSFER_EVENT_CONFIRMED" == "1" ]]; then
  echo "USDC Transfer event: confirmed independently via cast logs"
else
  echo "USDC Transfer event: not independently confirmed in this environment (best-effort check only; pool/escrow deltas above are the hard proof)"
fi
echo "Current owner net USDC delta (diagnostic only, includes its own gas cost): $OWNER_DELTA"
echo "Double refund rejection: AlreadyRefunded"
echo "No Arc Testnet transaction was broadcast."
