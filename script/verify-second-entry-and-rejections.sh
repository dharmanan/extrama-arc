#!/usr/bin/env bash
set -euo pipefail

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
POOL="0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f"
WALLET="0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b"
OTHER="0x1111111111111111111111111111111111111111"
USDC="0x3600000000000000000000000000000000000000"
ROUND_ID=1
PREDICTION_CENTS=236587
DUPLICATE_WALLET_TEST_CENTS=236588
TICKET_ID=1
FROM_BLOCK=60500000
CHUNK_SIZE=5000

pad_topic_address() {
  local value="${1#0x}"
  printf '0x%064s' "$value" | tr ' ' '0'
}

uint_topic() {
  local value="$1"
  printf '0x%064x' "$value"
}

hex_block() {
  printf '0x%x' "$1"
}

rpc_logs() {
  local address="$1"
  local from="$2"
  local to="$3"
  shift 3

  local topics_json
  topics_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"

  cast rpc eth_getLogs     "$(jq -nc       --arg address "$address"       --arg fromBlock "$(hex_block "$from")"       --arg toBlock "$(hex_block "$to")"       --argjson topics "$topics_json"       '{address:$address,fromBlock:$fromBlock,toBlock:$toBlock,topics:$topics}')"     --rpc-url "$RPC"
}

echo "EXTREMA ETH Daily High entry + rejection proof"
echo "Chain ID: $(cast chain-id --rpc-url "$RPC")"
echo

echo "Round state:"
cast call "$POOL"   "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))"   "$ROUND_ID" --rpc-url "$RPC"

echo
echo "hasEntered(wallet):"
cast call "$POOL" "hasEntered(uint256,address)(bool)" "$ROUND_ID" "$WALLET" --rpc-url "$RPC"

echo "predictionTaken(236587):"
cast call "$POOL" "predictionTaken(uint256,uint64)(bool)" "$ROUND_ID" "$PREDICTION_CENTS" --rpc-url "$RPC"

echo
echo "nextTicketId:"
cast call "$POOL" "nextTicketId()(uint256)" --rpc-url "$RPC"

echo
echo "entry #1:"
cast call "$POOL"   "entries(uint256)(uint256,uint256,address,uint64,uint64)"   "$TICKET_ID" --rpc-url "$RPC"

TICKET="$(cast call "$POOL" "TICKET()(address)" --rpc-url "$RPC")"
echo
echo "ticket contract: $TICKET"
echo "ticket owner #1:"
cast call "$TICKET" "ownerOf(uint256)(address)" "$TICKET_ID" --rpc-url "$RPC"

echo
echo "pool USDC balance:"
cast call "$USDC" "balanceOf(address)(uint256)" "$POOL" --rpc-url "$RPC"

LATEST_RAW="$(cast block latest --field number --rpc-url "$RPC")"
LATEST=$((LATEST_RAW))

ENTRY_TOPIC0="$(cast keccak "PredictionEntered(uint256,uint256,address,uint64,uint64)")"
ENTRY_TOPIC1="$(uint_topic "$ROUND_ID")"
ENTRY_TOPIC2="$(uint_topic "$TICKET_ID")"
ENTRY_TOPIC3="$(pad_topic_address "$WALLET")"

echo
echo "PredictionEntered event:"
ENTRY_LOGS='[]'
START=$FROM_BLOCK
while (( START <= LATEST )); do
  END=$((START + CHUNK_SIZE - 1))
  if (( END > LATEST )); then END=$LATEST; fi

  OUT="$(rpc_logs "$POOL" "$START" "$END"     "$ENTRY_TOPIC0" "$ENTRY_TOPIC1" "$ENTRY_TOPIC2" "$ENTRY_TOPIC3")"

  ENTRY_LOGS="$(jq -nc --argjson a "$ENTRY_LOGS" --argjson b "$OUT" '$a + $b')"
  START=$((END + 1))
done

ENTRY_COUNT="$(jq 'length' <<<"$ENTRY_LOGS")"
if [[ "$ENTRY_COUNT" -ne 1 ]]; then
  echo "ERROR: expected exactly 1 PredictionEntered log, got $ENTRY_COUNT" >&2
  exit 1
fi

ENTRY_TX="$(jq -r '.[0].transactionHash' <<<"$ENTRY_LOGS")"
ENTRY_BLOCK_HEX="$(jq -r '.[0].blockNumber' <<<"$ENTRY_LOGS")"
ENTRY_BLOCK="$(cast to-dec "$ENTRY_BLOCK_HEX")"
ENTRY_DATA="$(jq -r '.[0].data' <<<"$ENTRY_LOGS")"

echo "  tx: $ENTRY_TX"
echo "  block: $ENTRY_BLOCK"
echo "  data: $ENTRY_DATA"
echo "  explorer: https://testnet.arcscan.app/tx/$ENTRY_TX"

echo
echo "Duplicate-wallet eth_call simulation (expected revert AlreadyEntered):"
set +e
DUP_WALLET_OUT="$(cast call "$POOL"   "enterPrediction(uint256,uint64)(uint256)"   "$ROUND_ID" "$DUPLICATE_WALLET_TEST_CENTS"   --from "$WALLET" --rpc-url "$RPC" 2>&1)"
DUP_WALLET_EXIT=$?
set -e
echo "$DUP_WALLET_OUT"
if [[ $DUP_WALLET_EXIT -eq 0 ]]; then
  echo "ERROR: duplicate-wallet simulation unexpectedly succeeded" >&2
  exit 1
fi

echo
echo "Duplicate-price eth_call simulation from a different address (expected revert PriceAlreadyTaken):"
set +e
DUP_PRICE_OUT="$(cast call "$POOL"   "enterPrediction(uint256,uint64)(uint256)"   "$ROUND_ID" "$PREDICTION_CENTS"   --from "$OTHER" --rpc-url "$RPC" 2>&1)"
DUP_PRICE_EXIT=$?
set -e
echo "$DUP_PRICE_OUT"
if [[ $DUP_PRICE_EXIT -eq 0 ]]; then
  echo "ERROR: duplicate-price simulation unexpectedly succeeded" >&2
  exit 1
fi

APPROVAL_TOPIC0="$(cast keccak "Approval(address,address,uint256)")"
APPROVAL_TOPIC1="$(pad_topic_address "$WALLET")"
APPROVAL_TOPIC2="$(pad_topic_address "$POOL")"

echo
echo "Approval from EXTREMA wallet to this pool:"
APPROVAL_LOGS='[]'
START=$FROM_BLOCK
while (( START <= LATEST )); do
  END=$((START + CHUNK_SIZE - 1))
  if (( END > LATEST )); then END=$LATEST; fi

  OUT="$(rpc_logs "$USDC" "$START" "$END"     "$APPROVAL_TOPIC0" "$APPROVAL_TOPIC1" "$APPROVAL_TOPIC2")"

  APPROVAL_LOGS="$(jq -nc --argjson a "$APPROVAL_LOGS" --argjson b "$OUT" '$a + $b')"
  START=$((END + 1))
done

APPROVAL_COUNT="$(jq 'length' <<<"$APPROVAL_LOGS")"
if [[ "$APPROVAL_COUNT" -eq 0 ]]; then
  echo "  no matching Approval log found in scanned range"
else
  jq -r '.[] | "  tx: \(.transactionHash)\n  block: \(.blockNumber)\n  amountRaw: \(.data)"' <<<"$APPROVAL_LOGS"
fi

echo
echo "SECOND_ENTRY_AND_REJECTIONS_READS_COMPLETE=PASS"
