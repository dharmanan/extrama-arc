# Arc Testnet deployment procedure

Pool admin is automatically the deployer wallet. You do not set EXTREMA_POOL_ADMIN manually.

Required before simulation:
- EXTREMA_DEPLOYER_PRIVATE_KEY: entered only in your local/Codespace terminal
- EXTREMA_RESOLVER: a separate public wallet address

Never paste the deployer private key into chat and never commit it.

Simulation command:

forge script script/DeployArcTestnet.s.sol:DeployArcTestnet \
  --rpc-url https://rpc.testnet.arc.network \
  -vvv

Do NOT add --broadcast for simulation.

The script hard-checks:
- chain ID 5042002
- Arc Testnet USDC 0x3600000000000000000000000000000000000000
- deployer = pool admin
- resolver differs from deployer and both treasury controllers
- 24 unique pools
- 24 unique ticket collections

Only after simulation succeeds should --broadcast be considered.
