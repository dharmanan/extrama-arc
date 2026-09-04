#!/usr/bin/env bash
set -euo pipefail

RPC="${ARC_RPC_URL:-https://rpc.testnet.arc.network}"
FACTORY="${EXTREMA_FACTORY:-0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A}"

assets=(BTC ETH SOL HYPE)
directions=(HIGH LOW)
cadences=(DAILY WEEKLY QUARTERLY)

echo "EXTREMA Arc Testnet topology"
echo "Chain ID: $(cast chain-id --rpc-url "$RPC")"
echo "Factory:  $FACTORY"
echo

printf "%-3s %-5s %-5s %-10s %-42s %-42s\n" "#" "ASSET" "DIR" "CADENCE" "POOL" "TICKET"
printf "%-3s %-5s %-5s %-10s %-42s %-42s\n" "---" "-----" "-----" "----------" "------------------------------------------" "------------------------------------------"

n=1
for asset in 0 1 2 3; do
  for direction in 0 1; do
    for cadence in 0 1 2; do
      pool=$(cast call "$FACTORY"         "poolFor(uint8,uint8,uint8)(address)"         "$asset" "$direction" "$cadence"         --rpc-url "$RPC")

      ticket=$(cast call "$pool"         "TICKET()(address)"         --rpc-url "$RPC")

      onchain_asset=$(cast call "$pool" "ASSET()(uint8)" --rpc-url "$RPC")
      onchain_direction=$(cast call "$pool" "DIRECTION()(uint8)" --rpc-url "$RPC")
      onchain_cadence=$(cast call "$pool" "CADENCE()(uint8)" --rpc-url "$RPC")

      if [[ "$onchain_asset" != "$asset" || "$onchain_direction" != "$direction" || "$onchain_cadence" != "$cadence" ]]; then
        echo "ERROR: identity mismatch at pool $pool" >&2
        exit 1
      fi

      printf "%-3d %-5s %-5s %-10s %-42s %-42s\n"         "$n" "${assets[$asset]}" "${directions[$direction]}" "${cadences[$cadence]}" "$pool" "$ticket"

      n=$((n + 1))
    done
  done
done

echo
echo "POOL_COUNT=$(cast call "$FACTORY" "poolCount()(uint256)" --rpc-url "$RPC")"
echo "TOPOLOGY_PRINT=PASS"
