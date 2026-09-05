#!/usr/bin/env bash
set -euo pipefail

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
POOL="0x490A5CE02E3fd85d51095A69AAE9511552d91095"
WALLET="0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b"
USDC="0x3600000000000000000000000000000000000000"
ROUND_ID=1
PREDICTION_CENTS=197698
TICKET_ID=1
FROM_BLOCK=60484925

echo "EXTREMA first-entry read-only verification"
echo "Chain ID: $(cast chain-id --rpc-url "$RPC")"
echo "Pool: $POOL"
echo "Wallet: $WALLET"
echo "Round: $ROUND_ID"
echo "Prediction cents: $PREDICTION_CENTS"
echo

echo "hasEntered:"
cast call "$POOL" "hasEntered(uint256,address)(bool)" "$ROUND_ID" "$WALLET" --rpc-url "$RPC"

echo "predictionTaken:"
cast call "$POOL" "predictionTaken(uint256,uint64)(bool)" "$ROUND_ID" "$PREDICTION_CENTS" --rpc-url "$RPC"

echo "nextTicketId:"
cast call "$POOL" "nextTicketId()(uint256)" --rpc-url "$RPC"

echo "entry #1:"
cast call "$POOL" "entries(uint256)(uint256,uint256,address,uint64,uint64)" "$TICKET_ID" --rpc-url "$RPC"

TICKET="$(cast call "$POOL" "TICKET()(address)" --rpc-url "$RPC")"
echo "ticket contract: $TICKET"

echo "ticket owner #1:"
cast call "$TICKET" "ownerOf(uint256)(address)" "$TICKET_ID" --rpc-url "$RPC"

echo "pool USDC balance raw:"
cast call "$USDC" "balanceOf(address)(uint256)" "$POOL" --rpc-url "$RPC"

echo "wallet USDC balance raw:"
cast call "$USDC" "balanceOf(address)(uint256)" "$WALLET" --rpc-url "$RPC"

echo
echo "PredictionEntered logs:"
cast logs \
  --rpc-url "$RPC" \
  --address "$POOL" \
  --from-block "$FROM_BLOCK" \
  --to-block latest \
  "PredictionEntered(uint256,uint256,address,uint64,uint64)" || true

echo
echo "FIRST_ENTRY_READS_COMPLETE=PASS"
