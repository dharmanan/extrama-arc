#!/usr/bin/env bash
set -euo pipefail

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
POOL="0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f"
WALLET="0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b"
OTHER="0x1111111111111111111111111111111111111111"
USDC="0x3600000000000000000000000000000000000000"
ROUND_ID=1
PREDICTION_CENTS=265476
FROM_BLOCK=60500000

echo "EXTREMA ETH Daily High entry + rejection proof"
echo "Chain ID: $(cast chain-id --rpc-url "$RPC")"
echo

echo "Round state:"
cast call "$POOL" "getRound(uint256)((uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256,uint256,uint64,uint256[3]))" "$ROUND_ID" --rpc-url "$RPC"

echo
echo "hasEntered(wallet):"
cast call "$POOL" "hasEntered(uint256,address)(bool)" "$ROUND_ID" "$WALLET" --rpc-url "$RPC"

echo "predictionTaken(265476):"
cast call "$POOL" "predictionTaken(uint256,uint64)(bool)" "$ROUND_ID" "$PREDICTION_CENTS" --rpc-url "$RPC"

echo
echo "nextTicketId:"
cast call "$POOL" "nextTicketId()(uint256)" --rpc-url "$RPC"

echo
echo "entry #1:"
cast call "$POOL" "entries(uint256)(uint256,uint256,address,uint64,uint64)" 1 --rpc-url "$RPC"

TICKET="$(cast call "$POOL" "TICKET()(address)" --rpc-url "$RPC")"
echo
echo "ticket contract: $TICKET"
echo "ticket owner #1:"
cast call "$TICKET" "ownerOf(uint256)(address)" 1 --rpc-url "$RPC"

echo
echo "pool USDC balance:"
cast call "$USDC" "balanceOf(address)(uint256)" "$POOL" --rpc-url "$RPC"

echo
echo "PredictionEntered logs:"
cast logs   --rpc-url "$RPC"   --address "$POOL"   --from-block "$FROM_BLOCK"   --to-block latest   "PredictionEntered(uint256,uint256,address,uint64,uint64)"

echo
echo "Duplicate-wallet eth_call simulation (expected revert AlreadyEntered):"
set +e
DUP_WALLET_OUT="$(cast call "$POOL" "enterPrediction(uint256,uint64)(uint256)" "$ROUND_ID" 265477 --from "$WALLET" --rpc-url "$RPC" 2>&1)"
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
DUP_PRICE_OUT="$(cast call "$POOL" "enterPrediction(uint256,uint64)(uint256)" "$ROUND_ID" "$PREDICTION_CENTS" --from "$OTHER" --rpc-url "$RPC" 2>&1)"
DUP_PRICE_EXIT=$?
set -e
echo "$DUP_PRICE_OUT"
if [[ $DUP_PRICE_EXIT -eq 0 ]]; then
  echo "ERROR: duplicate-price simulation unexpectedly succeeded" >&2
  exit 1
fi

echo
echo "Approval logs from wallet to this pool:"
cast logs   --rpc-url "$RPC"   --address "$USDC"   --from-block "$FROM_BLOCK"   --to-block latest   "Approval(address,address,uint256)" "$WALLET" "$POOL" || true

echo
echo "SECOND_ENTRY_AND_REJECTIONS_READS_COMPLETE=PASS"
