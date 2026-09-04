# Arc Testnet deployment procedure

This procedure deploys the final EXTREMA topology:

- 1 ExtremaTreasury
- 1 ExtremaRenderer
- 1 ExtremaFactory
- 24 ExtremaPool contracts
- 24 ExtremaTicket contracts created by their paired pools

Total: 51 deployed contracts.

## Safety rules

- Never paste a private key into chat.
- Never commit a private key or .env file.
- Simulation must pass before broadcast.
- Chain ID is hard-checked to Arc Testnet 5042002.
- Arc Testnet USDC is hard-checked at 0x3600000000000000000000000000000000000000.
- Treasury controllers are hard-coded to the two approved addresses.
- Resolver must be a different address from pool admin and treasury controllers.

## Required environment variables

- EXTREMA_DEPLOYER_PRIVATE_KEY
- EXTREMA_POOL_ADMIN
- EXTREMA_RESOLVER

After deployment verification also requires:

- EXTREMA_FACTORY
- EXTREMA_TREASURY
- EXTREMA_RENDERER

## Step 1: compile only

forge build

## Step 2: simulate only

Run the deploy script against the Arc Testnet RPC without --broadcast.

forge script script/DeployArcTestnet.s.sol:DeployArcTestnet \
  --rpc-url https://rpc.testnet.arc.network \
  -vvv

No transaction is broadcast in this step.

## Step 3: broadcast

Only after simulation succeeds:

forge script script/DeployArcTestnet.s.sol:DeployArcTestnet \
  --rpc-url https://rpc.testnet.arc.network \
  --broadcast \
  -vvv

Foundry writes broadcast transaction artifacts under broadcast/.

## Step 4: verify topology

Set EXTREMA_FACTORY, EXTREMA_TREASURY and EXTREMA_RENDERER from the broadcast output, then run:

forge script script/VerifyArcDeployment.s.sol:VerifyArcDeployment \
  --rpc-url https://rpc.testnet.arc.network \
  -vvv

Verification must complete without revert.

## Step 5: proof record

Record:

- deployer
- pool admin
- resolver
- treasury
- renderer
- factory
- all 24 pool addresses
- all 24 ticket addresses
- all broadcast transaction hashes
- ArcScan links
- verification result
