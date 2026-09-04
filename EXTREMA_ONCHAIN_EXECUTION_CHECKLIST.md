# EXTREMA — Arc Testnet Onchain Execution Checklist

> This file is the single execution checklist for EXTREMA.
> We progress **one item at a time**.
> A task is not marked complete until its acceptance criteria are satisfied and its proof is recorded here.

## Non-negotiable rules

- Production-path financial state must not come from mocks, localStorage, hardcoded balances, fake player counts, fake pool sizes, fake tickets, or fake claims.
- All financial actions must be executed on **Arc Testnet** before an item is marked complete.
- Every onchain completion must include evidence:
  - chain ID
  - contract/address involved
  - transaction hash
  - explorer link when available
  - expected state before
  - expected state after
  - verification result
- For read-only onchain items, record the RPC call / contract read and the returned value.
- For resolver/settlement items, record the exact source data, period, calculation, submitted settlement transaction, and resulting contract state.
- Never mark an item complete because the UI appears to work.
- Never replace a failed real integration with mock data in the normal application path.
- Critical signing actions must require a fresh passkey step-up authorization before the backend uses the EXTREMA wallet private key.
- Design work is last. Functionality and proof come first.

---

# 0. Infrastructure baseline

These items are real infrastructure, but they are **not substitutes for onchain proof**.

- [x] Railway backend deployed and reachable
  - Proof:
    - `/readyz -> {"ok":true,"service":"extrema-backend"}`
    - `/health -> {"ok":true,"database":"connected"}`
- [x] PostgreSQL connected on Railway
- [x] Backend runs on Node 22 Docker image
- [x] Frontend dependency audit clean
  - Proof: `npm audit -> found 0 vulnerabilities`
- [x] Frontend build/typecheck passes
  - Proof: `npm run check:all -> PASS`
- [x] Owner-wallet signature flow works
- [x] Passkey registration flow works in current Codespace environment
- [x] Backend creates a real EVM EXTREMA wallet
- [x] Private key is disclosed once to the user at wallet creation
- [ ] Reconnect flow verified end-to-end with owner wallet + passkey
- [ ] Fresh passkey step-up authorization implemented for critical transaction signing

---

# 1. Arc Testnet wallet state

## 1.1 Real chain identity

- [x] Frontend and backend both verify Arc Testnet chain ID `5042002`
- [x] EXTREMA wallet address is shown with Arc Testnet explorer link
- [ ] Wrong-network state is detected and blocked for transaction actions
- [ ] Switch-to-Arc-Testnet action is verified

### Proof record

- Chain ID: `5042002`
- Wallet address: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Explorer: `https://testnet.arcscan.app/address/0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Verification date: 2026-09-04
- Notes: Backend RPC state read and wallet UI both reported Arc Testnet / chain ID 5042002. Wrong-network rejection/switch still requires explicit test.

## 1.2 Real native balance

Implementation status: verified on Arc Testnet.

- [x] Read EXTREMA wallet native Arc Testnet balance through RPC
- [x] Remove any mock/native demo balance from the product path
- [x] UI displays the real RPC result only

### Proof record

- Wallet: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- RPC: `https://rpc.testnet.arc.network`
- Balance: `40.0 USDC`
- Native decimals: `18`
- Balance raw: `40000000000000000000`
- Block number: `60464221`
- Verification: `backend/scripts/verify-native-balance.js` returned `verified: true`, chain ID `5042002`, native currency `USDC`, and formatted balance `40.0`.

## 1.3 Real Arc Testnet USDC balance

Implementation status: real Arc RPC/USDC balance reader and wallet UI are wired; **proof is still pending**, so no checkbox below is marked complete yet.

Target token:

`0x3600000000000000000000000000000000000000`

- [x] Verify token contract exists on Arc Testnet
- [x] Verify token metadata/decimals from chain
- [x] Read EXTREMA wallet `balanceOf` from the token contract
- [x] Remove `Demo USDC balance`
- [x] Remove `Get 10 demo USDC`
- [x] UI displays only the real onchain USDC balance
- [x] Real testnet funding path established
- [x] Funding transaction verified onchain

### Proof record

- Token address: `0x3600000000000000000000000000000000000000`
- Decimals: `6`
- Wallet: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Balance before recorded faucet funding: `0 USDC`
- Funding tx #1: `0x0e50444ff84050f6f32efe9d6d8a84e8c435d4c8bcc251556f27e695f11dd699`
  - Status: success (`1`)
  - Block: `60461373`
  - Amount: `20.0 USDC`
  - From: `0x3C3380cdFb94dFEEaA41cAD9F58254AE380d752D`
  - To: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Funding tx #2: `0x9264cc9b2cda96b132fa053751b034fadf6f53d60b4a05d8d6c102d6d4d99b8a`
  - Status: success (`1`)
  - Block: `60461361`
  - Amount: `20.0 USDC`
  - From: `0x319dd63E0AC72e7Ac74443029d074032c043460F`
  - To: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Explorer tx #1: `https://testnet.arcscan.app/tx/0x0e50444ff84050f6f32efe9d6d8a84e8c435d4c8bcc251556f27e695f11dd699`
- Explorer tx #2: `https://testnet.arcscan.app/tx/0x9264cc9b2cda96b132fa053751b034fadf6f53d60b4a05d8d6c102d6d4d99b8a`
- Balance after: `40.0 USDC`
- Verification: `backend/scripts/verify-funding.js` returned `allVerified: true`, chain ID `5042002`, and `totalUsdcToWallet: 40.0`.

---

# 2. Smart contract foundation

No pool entry, NFT, settlement, refund, or claim is considered real until this section is complete.

Architecture specification: `contracts/ARCHITECTURE.md`

## 2.1 Contract architecture locked

- [x] Define final contract responsibilities
- [x] Define immutable/constants:
  - Arc Testnet chain ID
  - USDC token address
  - treasury address
  - stake amount = exactly 1 USDC
  - payout percentages
- [x] Define round state machine
  - `ENTRY_OPEN`
  - `LOCKED`
  - `SETTLED`
  - `CANCELLED`
- [x] Define round identity by `roundId`, not market slug
- [x] Define one-entry-per-wallet-per-round rule
- [x] Define one-exact-price-per-round rule
- [x] Define minimum 3 entries or cancel/refund
- [x] Define winner ordering:
  1. absolute distance
  2. earlier onchain entry
  3. transaction/log index
- [x] Define payout split:
  - 1st: 54%
  - 2nd: 22.5%
  - 3rd: 13.5%
  - treasury: 10%
- [x] Define ERC-721 ticket ownership as claim-right ownership

## 2.2 Contract tests

- [x] Unit tests for round creation
- [x] Unit tests for entry
- [x] Unit tests for duplicate-wallet rejection
- [x] Unit tests for duplicate-price rejection
- [x] Unit tests for entry close
- [x] Unit tests for settlement
- [x] Unit tests for winner ranking
- [x] Unit tests for payout accounting
- [x] Unit tests for cancellation
- [x] Unit tests for refunds
- [x] Unit tests for NFT transfer and claim-right transfer
- [x] Unit tests for double-claim prevention

### Proof record

- Verification date: 2026-09-05
- Commands:
  - `forge test -vv`
  - `forge build --sizes`
- Test result: `31 passed; 0 failed; 0 skipped`
- Test exit: `0`
- Size exit: `0`
- Suites:
  - `ExtremaPoolLifecycleTest`: 8/8 PASS
  - `ExtremaFactoryTest`: 5/5 PASS
  - `ExtremaPoolEntryTest`: 5/5 PASS
  - `ExtremaTreasuryTest`: 3/3 PASS
  - `ExtremaRendererTest`: 2/2 PASS
  - `ExtremaTicketTest`: 8/8 PASS
- Production contract sizes:
  - `ExtremaFactory`: runtime 20,609 B; margin 3,967 B
  - `ExtremaPool`: runtime 10,567 B; margin 14,009 B
  - `ExtremaRenderer`: runtime 8,115 B; margin 16,461 B
  - `ExtremaTicket`: runtime 3,865 B; margin 20,711 B
  - `ExtremaTreasury`: runtime 1,368 B; margin 23,208 B
- Covered additionally:
  - all 24 unique pool identities
  - separate NFT collection per pool
  - dual treasury controller withdrawals
  - treasury isolation from player escrow
  - resolver rotation without escrow authority
  - renderer rotation
  - per-round escrow accounting and invariant
  - accidental excess USDC rescue only
  - fully onchain tokenURI
  - HIGH/LOW artwork separation
- Local contract gate passed. Remaining Foundry warnings are documented in `contracts/SECURITY_NOTES.md`; test-only style warnings do not block deployment.
- Next gate: Arc Testnet deployment simulation and onchain deployment proof.

## 2.3 Arc Testnet deployment

- [x] Full Arc Testnet deployment simulation completed without broadcast
- [x] Deploy 24 pool contracts to Arc Testnet
- [x] Deploy 24 paired ERC-721 ticket collections through pool deployment
- [x] Configure treasury contract
- [x] Configure Arc Testnet USDC
- [x] Verify deployed bytecode/contracts and complete topology reads
- [x] Record deployment transactions

### Simulation proof

- Verification date: 2026-09-05
- Chain ID: `5042002`
- Result: `SIMULATION COMPLETE`
- Broadcast: **NO**
- Predicted addresses matched the subsequent broadcast addresses.
- Estimated amount required: `5.44726989 USDC`

### Broadcast proof

- Verification date: 2026-09-05
- Chain ID: `5042002`
- Result: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`
- Successful transactions: `27`
  - 3 core deployments
  - 24 `deployPool(asset,direction,cadence)` calls
- Deployer / Pool Admin: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Resolver: `0x1EDC4594195fFb134315c3258DE974563Ed9762A`
- Arc Testnet USDC: `0x3600000000000000000000000000000000000000`
- Factory: `0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A`
  - deployment tx: `0xf8422d3282092cd8e3dd770dbbb3e2c529442705b51816b860badfb77f3be836`
- Treasury: `0x1D00C89Ed4AF7227a858D305183B4037f732b87e`
  - deployment tx: `0x7cf1791378a54820620f5b9c66e9e00be755b99127708dd230aa7f79ede4ce61`
- Renderer: `0x1C52E55B8CC91A8E327BDDA8E0FAE33bC41fEe1c`
  - deployment tx: `0x7956c50122db1b611013982004b36cba7d25f499d569a444aa1c3c4abc53cf94`
- 24 pool deployment transactions:
  - `0xf3d15fc1758f39c7e04e9a0c3c2d899564e32b33920c9c1ab851d0ff1debc9ae`
  - `0x76a47a49163970d9f113322ec67f37e07da61612977e98d766b894016143df98`
  - `0x2178f2f1fd9dfbf73a71c8f241bcc677448c417b53df6ceca172d039c035f84c`
  - `0xe15e60077c9fe4071b5ef1064bc489ef73fcb4c3f252654aa23e8b2699a89def`
  - `0xd34f316d442992653ad6dda5597ea0d1bf31dfd57d1baf0767452e6bdf90b68b`
  - `0x3c59dea1a1d24b0d750353a5314854396ef230cc02b3b00d940413faa5a47723`
  - `0x4722ab3cf0ffb2a3efe08c5248b05067826768eb32e31e0cc865bf0c026eb57e`
  - `0x81b6dc2fe572123daea73d58108b2a7a7720f661ab6c55c90e2291d35cac6130`
  - `0x818e6a95c5dea7461d79aaa2764b77c1b65a3bf257d4f825977f143f39e37789`
  - `0x55adbfc44345ff15b7627793af9c22cfea3fa870ac644fef2534d5d458d661bb`
  - `0x86fc896efd7f27eb34858b2f2dfb62d367dc9db023e47a40442308af399dd446`
  - `0x34fe0301c7fdb16008cd261c84f1998c06a668a96a04906a337a791a6850f30d`
  - `0x4935fcbd43616df0a7b9a64a1031ad2752348c6a6ce7ed028ca5ab50e2987fc2`
  - `0x2284351decfdb33fc381cf8c191097944097c55b6814ee2bddffd8d98ec91e18`
  - `0x71df3baecbe5bf138c56d8ece64057879c40f8e14862158a01d7e7db13b727b4`
  - `0x9bb148e22934fc36107bcb08d21b6dfb248e646a8760329be0b39d11029c7a48`
  - `0x2f31f107104ee7df8b8b6dffa364707d21c5227ed1d1c8637fcb3f8bcacf9dbf`
  - `0x44d4b396d40165ef8f4d31ee88b404b57194478def85652d43bd8ef80e4bf8ee`
  - `0x4009437117710cdd7801f0f62b71ad39dbd0b93b3e253c1d8989afd185e9b613`
  - `0x21bd4c2743e03f3e0f7a8399fc697b2773d0c065e332d03379837d271eb8c231`
  - `0x0f862d192336b27a1952bf3796c597da61bb234e30831163505fb24dcef32cab`
  - `0x40dc046ba52773323fd75ae923f8bb2716ae9b0ad03de2c3c5c0a1120d6669f3`
  - `0x93b58f220c6ef6e0405fde3f19787c5fd8cd3b2520bfbfe63a1bf860d38a4d50`
  - `0x1fe9e906d9543d994ae698b33f84676cb641e8bb3f4d6a6ad3c3846f47301c9a`
- Total paid: `2.119636575 USDC`
- Broadcast artifact: `broadcast/DeployArcTestnet.s.sol/5042002/run-latest.json`
- Note: each pool deployment creates its paired ExtremaTicket internally; ticket addresses still require explicit topology verification/readout.

### Verification proof

- Verification date: 2026-09-05
- Command: `forge script script/VerifyArcDeployment.s.sol:VerifyArcDeployment --rpc-url https://rpc.testnet.arc.network -vvv`
- Result: `Script ran successfully.`
- The verification script checked onchain:
  - factory pool count = 24
  - Arc Testnet USDC address
  - treasury address
  - pool admin
  - resolver
  - renderer
  - all 24 pool identities
  - all 24 pools use the expected treasury/USDC/admin/resolver
  - every pool has a nonzero ticket collection
  - all 24 ticket collection addresses are distinct
  - every ticket collection uses the expected renderer
- Treasury controller direct reads:
  - `CONTROLLER_A() -> 0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321`
  - `CONTROLLER_B() -> 0x99677aab4b168c274A34525D526346fC47Fab72c`
- Explicit topology readout:
  - Command: `./script/print-arc-topology.sh`
  - Chain ID: `5042002`
  - Factory: `0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A`
  - Result: `POOL_COUNT=24`, `TOPOLOGY_PRINT=PASS`

| # | Asset | Direction | Cadence | Pool | Ticket |
|---:|---|---|---|---|---|
| 1 | BTC | HIGH | DAILY | `0xc724050511Df7CC0cb7aFC688cbcc9C2A16dC36d` | `0x3c04c15025731A07772018e8609a8af7212d8801` |
| 2 | BTC | HIGH | WEEKLY | `0xE7d18196075227F0b264F3612942b02e0FedC1d1` | `0x5e39A234c7654d3f005Ec5d2bEb014c159a9D38d` |
| 3 | BTC | HIGH | QUARTERLY | `0x7573cD9Ff84afda1e1f46Ab59f6Ff3dc4c0106A0` | `0xD6F2545F00eefaA00c02cEcaFfBb4EC33532c603` |
| 4 | BTC | LOW | DAILY | `0x18e34fF5527637fdA1C13297DAcbEE7c08e69dad` | `0x9BF5C34B23658a9aC06C0A47B59d9B90350e735E` |
| 5 | BTC | LOW | WEEKLY | `0x74a1Fc98876C2c7E792eB2F7577a908620F68f89` | `0x468f1485cDfF194114Bd3fC7b126EbdbBa704e0A` |
| 6 | BTC | LOW | QUARTERLY | `0x842A2F152a9b5aD7E9b7CB651DE59eD53040dBD0` | `0xEa6d00b5E473c5647f1B8CdceD8E56653181Afd3` |
| 7 | ETH | HIGH | DAILY | `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f` | `0xF65Cf4a67299ad596e139e3F6a9594E809F05637` |
| 8 | ETH | HIGH | WEEKLY | `0x7c2e9C3221534F24ecA83949D4f7249c95C35c33` | `0xd20a69DB0A957D6f285b6Af67fed653d65cD7E5d` |
| 9 | ETH | HIGH | QUARTERLY | `0x6652e6F150e889Be15fbD6608A70e03aB7048d48` | `0x070C0153F1DCa041FdE84C581f12Ef832f3F50B8` |
| 10 | ETH | LOW | DAILY | `0x490A5CE02E3fd85d51095A69AAE9511552d91095` | `0x6FC6756af39fb520844EdA73D6855990e56049E1` |
| 11 | ETH | LOW | WEEKLY | `0x8ec016AE0376Bf7d893Be4BeA6Fb1C57AAabf718` | `0xa2F82BE41567D7BE6F7F2Ba435D23068eE2A2212` |
| 12 | ETH | LOW | QUARTERLY | `0xBD70a2F01F8524C4858A9A26AEdF82dC936da789` | `0xDb6761e9eeD6e52E3bb42FB0157b3818a2BF6b16` |
| 13 | SOL | HIGH | DAILY | `0xb81C2551cb757Cd51ABfCa3db4e876820634c76c` | `0x7Fb08d5A0d168De4CE479FC21C1E45fF35353F9C` |
| 14 | SOL | HIGH | WEEKLY | `0x7b24aFccf1f63545A36cd41a30c4846aBFb17CF8` | `0x534d90A4E4314f4A54E3eBd4D0cBe276E7CdD92A` |
| 15 | SOL | HIGH | QUARTERLY | `0xC5BA26016387e2c041d136779D1dE8d02DEf5c50` | `0x18c6b2c1Aad92321E83a39D92Fc621ffCDD51264` |
| 16 | SOL | LOW | DAILY | `0xdf1bE0356E5207f8aB96598c289823B488478fF5` | `0x174a3f5C207875f059171f35399869D60F792190` |
| 17 | SOL | LOW | WEEKLY | `0x5341Ca1e1257555a8bAceF969f3F3e06C6583f48` | `0x4BC109D7347855b5096B84BC6194Fe0d34a17bf4` |
| 18 | SOL | LOW | QUARTERLY | `0xc3b87D6C96924C107148D3db01dcDFcddFfCF981` | `0xD2b407294F18ec833c6BED915437832cdd235e6d` |
| 19 | HYPE | HIGH | DAILY | `0x97563B5DE4019311529c405ac78F59D74A001894` | `0x6e40BCedcb29b7E5e509F15d3f4C4380a5C670e2` |
| 20 | HYPE | HIGH | WEEKLY | `0xc699665f2BB38f7545C6bC1226755046F48A4D63` | `0xa7e359d2dF9E94B1E829f56016A7D879C53C63BC` |
| 21 | HYPE | HIGH | QUARTERLY | `0x8EFEEdfF439c772dcD040E36F43767F67B229C74` | `0x3cA0498a01c2D2D4a687E68791f77a542AF88d14` |
| 22 | HYPE | LOW | DAILY | `0x429329Efcd2c20198aB99EbF2459Be649864337C` | `0xAff6f3b5C2947368545B012c9689df2eC55997Bb` |
| 23 | HYPE | LOW | WEEKLY | `0xE936A4125360562390d8202911d767DAb2FA4852` | `0x0A4C0AA2D0ff801AC774167c69A44b4F1210B404` |
| 24 | HYPE | LOW | QUARTERLY | `0x8F921fDc4C02D46a02B85dAd0b2F3dF23303505b` | `0x84B9C1AdC20333022064234BaC11A1C786Cf08fC` |

**Section 2.3 status: COMPLETE.** Deployment, role wiring, treasury controllers, 24 pool identities, and 24 distinct ticket collections are all proven on Arc Testnet.

---

# 3. Real round creation

Locked UTC cadence boundaries:

- DAILY: observation 00:00 UTC → next day 00:00 UTC; entry closes exactly 4 hours before observation start
- WEEKLY: Monday 00:00 UTC → next Monday 00:00 UTC; entry closes exactly 24 hours before observation start
- QUARTERLY: first day of quarter 00:00 UTC → first day of next quarter 00:00 UTC; entry closes exactly 24 hours before observation start
- MONTHLY is not part of the current 24-pool architecture

Assets:

- BTC
- ETH
- SOL
- HYPE

Directions:

- High
- Low

Cadences:

- Daily
- Weekly
- Quarterly

Target: **24 standard pool templates**, each creating distinct onchain rounds.

- [ ] Backend round model connected to onchain `roundId`
- [ ] Daily round creation verified
- [ ] Weekly round creation verified
- [ ] Quarterly round creation verified
- [ ] High direction verified
- [ ] Low direction verified
- [ ] BTC verified
- [ ] ETH verified
- [ ] SOL verified
- [ ] HYPE verified
- [ ] Entry-open timestamp stored onchain
- [ ] Entry-close timestamp stored onchain
- [x] Daily entry-close offset locked at 4 hours before observation start
- [x] Weekly entry-close offset locked at 24 hours before observation start
- [x] Quarterly entry-close offset locked at 24 hours before observation start
- [x] Standard UTC observation boundaries locked
- [ ] Observation start/end stored or deterministically represented
- [ ] UI reads real round state from chain/backend indexer
- [ ] Remove hardcoded `Players`, `Pool`, and `ENTRY_OPEN` values

### Proof record

#### No-broadcast Round #1 simulation

- Verification date: 2026-09-05
- Arc block time used for plan: `2026-09-04T23:00:46Z`
- Chain ID: `5042002`
- Result: `createdRounds: 24`
- Result: `SIMULATION COMPLETE`
- Result: `STANDARD_ROUND_SIMULATION=PASS`
- Broadcast: **NO**
- Estimated gas: `2,650,904`
- Estimated native gas cost: `0.131219748 USDC`
- Daily Round #1 plan:
  - entry close: `2026-09-05T20:00:00Z`
  - observation: `2026-09-06T00:00:00Z -> 2026-09-07T00:00:00Z`
- Weekly Round #1 plan:
  - entry close: `2026-09-06T00:00:00Z`
  - observation: `2026-09-07T00:00:00Z -> 2026-09-14T00:00:00Z`
- Quarterly Round #1 plan:
  - entry close: `2026-09-30T00:00:00Z`
  - observation: `2026-10-01T00:00:00Z -> 2027-01-01T00:00:00Z`
- Dry-run artifact: `broadcast/CreateStandardRounds.s.sol/5042002/dry-run/run-latest.json`

#### Arc Testnet Round #1 broadcast proof

- Verification date: 2026-09-05
- Chain ID: `5042002`
- Result: `createdRounds: 24`
- Result: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`
- Result: `STANDARD_ROUND_BROADCAST=COMPLETE`
- Successful transactions: `24`
- Blocks: `60484923` and `60484925`
- Total paid: `0.04617 USDC`
- Total gas: `1,846,800`
- Average gas price: `25 gwei`
- Broadcast artifact: `broadcast/CreateStandardRounds.s.sol/5042002/run-latest.json`
- Creation transaction hashes:
  - #1: `0x6c0898099e77944c80d62c65513d464d497b6e659faa9e1aa9577b201858ed8b`
  - #2: `0x02a0ad77a71148be589489618914e65a9948390761a841a703fc6be2ace98591`
  - #3: `0xc000170d9b2968099b20d768431664e64940581fac284d59d444f663aa41c7b7`
  - #4: `0xd51d13d5674b6c71418ed36516ccda1f49c821ad6a2595d089899170fc1433e2`
  - #5: `0xd3bcca15e0157b226f7d1b633bc1111e2598b3f780c1d05dc3d03f1bec7e72b3`
  - #6: `0x28ea47c6349433fca2ce56d3c63b99c53c6c1e203fd0e9f4266070ba06667112`
  - #7: `0x3732fe8c82b8816ff663fd1a4acb32b038702ba0562db22106dd5841b69d8314`
  - #8: `0x1a9353677d96a08cb616f9dad519ee12719151a732eabe338dff19a7ebeb3b08`
  - #9: `0x69f979904850ed7efce36571f1eb70124601d8f10e642e61e3fa259ec85d38a7`
  - #10: `0x7732b5af116e7fd96cc27fbc59777f08390551aa18e9a2d5ef8656c298a47aad`
  - #11: `0x64e680a5605e5aa9c71195fb79f59fee432b5b23921c8262663bb65272987117`
  - #12: `0x9b245c3a1df6048b513977a7516c463d57686ce386ebc2ee57085ddbdaf3f76c`
  - #13: `0xf10a70683319f0fcb9ba26777b8bbc299e8f5da8ce2f4d8026570c0a438f9fee`
  - #14: `0x0c23365722ccbe0ea2d9852e0d5a39eb9c686b0f4ff14105cb9969d1622f5ecd`
  - #15: `0xf783f4d09f4281b68334d0dfa21f51dd8a49ba62c87a6340f520194c810cd86c`
  - #16: `0xf9e8bb35439bb3df14eb0688018c8876957f10474792a8e04d0ad28445065ac6`
  - #17: `0x30f87f390e11173fecbd88b8706288a089db8ea75fa788335adfc567103f1da2`
  - #18: `0x006bf8665adb4e9afc55af544e25c29658de5c99138834fb11d0fe2e8b8d30e0`
  - #19: `0xa426ce6f1bf98cfbe2837e61dba1a99e484e016fd1983849c70d9349f6984614`
  - #20: `0xa07584119ab36328e955db484f3b9b4cbc9115c5b9d7817e98587a730d967909`
  - #21: `0xf747ba14ce4aa6199e8969c39afeb3a275f69b7bf9871be078dd73869cb2cf8c`
  - #22: `0xadbe77a1c2a88aaf118487b4039acfbf1346fb970658d8379dad6c0888f6e965`
  - #23: `0x2ab6a455a49fcacd4ed7ad217ad7ad683c46b88b4dba267c80bce273d46608b0`
  - #24: `0x5b39ca15a7a4d74d95ef1d1896af5fe71cf083931a9750108dfcac1acd3f8d50`

#### Onchain verification pending

- Run `./script/verify-standard-rounds.sh` against Arc Testnet.
- Confirm all 24 pools now report `nextRoundId() == 2`.
- Confirm Round #1 timestamps/status/entryCount/totalStake/escrow match the exact saved plan.
- Only after that verification passes mark Daily/Weekly/Quarterly and all asset/direction creation checks complete.

---

# 4. Real 1 USDC prediction entry

- [ ] Entry amount is exactly 1 USDC
- [ ] User must have sufficient real Arc Testnet USDC
- [ ] Approval/permit/transfer flow finalized
- [ ] Fresh passkey step-up required before backend signs
- [ ] Prediction is submitted in a real Arc Testnet transaction
- [ ] Contract stores:
  - `roundId`
  - entrant wallet
  - exact prediction price
  - onchain entry ordering data
  - ticket ID
  - 1 USDC stake
- [ ] Pool balance increases by exactly 1 USDC
- [ ] Player count increases by exactly 1
- [ ] Same wallet cannot enter same round twice
- [ ] Same exact prediction price cannot be taken twice in same round
- [ ] Entry after close is rejected
- [ ] UI reflects confirmed onchain state only

### Proof record

- Round ID:
- EXTREMA wallet:
- Prediction:
- USDC balance before:
- Pool USDC before:
- Entry tx:
- Explorer:
- USDC balance after:
- Pool USDC after:
- Player count after:
- Verification:

---

# 5. Real ERC-721 prediction ticket

- [ ] Successful entry mints a real ERC-721 ticket
- [ ] NFT token ID linked to `roundId`
- [ ] NFT linked to prediction value
- [ ] NFT ownership readable onchain
- [ ] `My Tickets` reads real NFT ownership
- [ ] No localStorage/mock tickets in production path
- [ ] NFT transfer tested on Arc Testnet
- [ ] After transfer, new owner becomes claim-right holder
- [ ] Original entrant loses claim right after transfer

### Proof record

- Entry tx:
- Mint tx/event:
- Token ID:
- Owner before transfer:
- Transfer tx:
- Owner after transfer:
- Explorer:
- Verification:

---

# 6. Real live pool state

- [ ] Real player count from chain/indexed events
- [ ] Real pool USDC from contract/token balance/accounting
- [ ] Real user entry status
- [ ] Real user prediction
- [ ] Real ticket ID
- [ ] Real entry timestamp/order
- [ ] Real round status
- [ ] No mock live distribution
- [ ] UI updates after confirmed transactions

### Proof record

- Round ID:
- Contract reads/events:
- Pool USDC:
- Players:
- User ticket:
- Block:
- Verification:

---

# 7. Real settlement source and resolver

Official EXTREMA resolution source:

**Binance USDⓈ-M Futures Mark Price Klines**

Symbols:

- BTCUSDT
- ETHUSDT
- SOLUSDT
- HYPEUSDT

Resolution rule:

- High = maximum candle high in the observation period
- Low = minimum candle low in the observation period

Planned intervals:

- Daily: 1m
- Weekly: 15m
- Quarterly: 4h

## 7.1 Resolver data proof

- [ ] Exact Binance endpoint/spec locked
- [ ] Exact time-boundary convention locked
- [ ] Daily resolver calculation verified
- [ ] Weekly resolver calculation verified
- [ ] Quarterly resolver calculation verified
- [ ] High calculation verified
- [ ] Low calculation verified
- [ ] Raw source response can be archived/hash-recorded
- [ ] Deterministic calculation output recorded

## 7.2 Settlement transaction

- [ ] Resolver cannot settle before observation period ends
- [ ] Resolver submits resolved price to Arc Testnet contract
- [ ] Contract transitions to `SETTLED`
- [ ] Settlement cannot be repeated
- [ ] Settled price readable onchain
- [ ] Settlement tx recorded
- [ ] Verification page shows source proof + onchain result

### Proof record

- Round ID:
- Symbol:
- Direction:
- Observation start:
- Observation end:
- Binance interval:
- Source data hash/archive:
- Calculated value:
- Settlement tx:
- Explorer:
- Onchain resolved value:
- Verification:

---

# 8. Real winner determination

- [ ] Winner #1 calculated from actual entries
- [ ] Winner #2 calculated from actual entries
- [ ] Winner #3 calculated from actual entries
- [ ] Distance calculation verified
- [ ] Earlier-entry tie break verified
- [ ] Tx/log-index final tie break verified
- [ ] Winner ticket IDs stored or deterministically derivable
- [ ] Results page reads real settled result

### Proof record

- Round ID:
- Resolved price:
- Entry set:
- Winner 1:
- Winner 2:
- Winner 3:
- Tie-break evidence:
- Contract result:
- Verification:

---

# 9. Real payouts

Gross pool distribution:

- 54% first
- 22.5% second
- 13.5% third
- 10% treasury

- [ ] Payout math verified with token decimals
- [ ] Total allocation equals 100%
- [ ] Treasury amount verified
- [ ] Winner entitlements linked to NFT ownership
- [ ] No payout to original entrant if ticket was transferred
- [ ] Double claim prevented
- [ ] Claim state readable onchain

---

# 10. Real claim flow

- [ ] Claim requires settled round
- [ ] Claim requires current ownership of winning NFT
- [ ] Critical claim signing requires fresh passkey step-up
- [ ] Real Arc Testnet claim transaction submitted
- [ ] USDC leaves pool/contract
- [ ] USDC arrives in rightful wallet
- [ ] Claim state changes onchain
- [ ] Second claim attempt fails

### Proof record

- Round ID:
- Ticket ID:
- NFT owner:
- Claimable before:
- Wallet USDC before:
- Claim tx:
- Explorer:
- Wallet USDC after:
- Claimable after:
- Second-claim rejection:
- Verification:

---

# 11. Cancellation and real refunds

Rule: fewer than 3 valid entries → round cancelled/refundable.

- [ ] Round with 0 entries cancels correctly
- [ ] Round with 1 entry cancels correctly
- [ ] Round with 2 entries cancels correctly
- [ ] Round with 3 entries does not cancel for minimum-participant rule
- [ ] Refund entitlement linked to ticket/current ownership rule as finalized
- [ ] Fresh passkey step-up required for refund transaction
- [ ] Real Arc Testnet refund transaction verified
- [ ] Double refund prevented

### Proof record

- Round ID:
- Entry count:
- Cancellation tx:
- Refund tx:
- USDC before:
- USDC after:
- Explorer:
- Verification:

---

# 12. Real leaderboard

- [ ] Leaderboard source defined from settled onchain rounds/indexed events
- [ ] No seeded/mock users
- [ ] No seeded/mock scores
- [ ] Ranking formula documented
- [ ] Wallet identities derived from real participation
- [ ] Historical settled rounds rebuild leaderboard deterministically

### Proof record

- Source rounds:
- Indexed events:
- Calculated leaderboard:
- Rebuild verification:

---

# 13. Remove all mock product state

This section is not complete until every normal user path is backed by real testnet state.

- [ ] Remove mock USDC balance
- [ ] Remove mock faucet
- [ ] Remove mock player counts
- [ ] Remove mock pool balances
- [ ] Remove mock prediction entries
- [ ] Remove mock tickets
- [ ] Remove mock live position
- [ ] Remove mock settlement/result fixture from normal product path
- [ ] Remove mock claim balance updates
- [ ] Remove localStorage as source of financial truth
- [ ] Remove seeded leaderboard data
- [ ] Keep any fixtures only inside explicit tests/dev fixtures, never normal product runtime

### Verification

- [ ] Search repository for mock/demo financial state
- [ ] Confirm normal app can be rebuilt from chain + backend/indexer state only

---

# 14. Security gate before final UI

- [ ] Fresh passkey step-up implemented for entry
- [ ] Fresh passkey step-up implemented for claim
- [ ] Fresh passkey step-up implemented for refund
- [ ] Action challenge bound to:
  - action type
  - chain ID
  - contract
  - round/ticket
  - amount
  - destination
  - expiry
  - one-time nonce
- [ ] Replay prevention verified
- [ ] JWT alone cannot trigger signer endpoints
- [ ] Rate limits verified
- [ ] Session expiry verified
- [ ] `npm audit` remains 0
- [ ] Backend dependency audit remains 0
- [ ] Secret rotation procedure documented
- [ ] No private key, JWT secret, encryption key, or credentials committed to Git

---

# 15. Final end-to-end Arc Testnet proof

This is the final functional acceptance test before visual polish.

One complete round must be demonstrated from start to finish:

- [ ] Create real round
- [ ] Fund real EXTREMA wallets with testnet USDC
- [ ] Enter at least 3 real predictions
- [ ] Confirm 1 USDC per entry transferred onchain
- [ ] Confirm 3+ real ERC-721 tickets minted
- [ ] Transfer at least one ticket before settlement
- [ ] Close entry
- [ ] Resolve using Binance Mark Price Klines
- [ ] Submit settlement on Arc Testnet
- [ ] Verify winners
- [ ] Verify transferred NFT ownership controls claim
- [ ] Claim real testnet USDC
- [ ] Verify treasury share
- [ ] Verify no double claim
- [ ] Verify all UI screens reflect real state
- [ ] Record all transaction hashes and explorer links

### Final proof record

- Chain ID:
- Contracts:
- Round ID:
- Entry transactions:
- NFT mint events:
- NFT transfer:
- Settlement source:
- Settlement transaction:
- Winners:
- Claim transactions:
- Treasury transfer/accounting:
- Explorer links:
- Final verification result:

---

# 16. Design phase

Only begin after Sections 1–15 are functionally complete and proven.

- [ ] Replace structural wireframe with final EXTREMA visual design
- [ ] Preserve all verified real onchain flows
- [ ] Re-run complete Arc Testnet end-to-end test after design integration

---

## Current next action

**Section 3 — Real round creation.**

Section 2.3 is complete on Arc Testnet.

UTC cadence boundaries are locked. Deterministic Round #1 planning and dry-run scripts are implemented:
- `script/prepare-standard-rounds.sh`
- `script/simulate-standard-rounds.sh`
- `script/CreateStandardRounds.s.sol`

The exact saved Round #1 plan was broadcast successfully to all 24 pools on Arc Testnet. Next: run the dedicated onchain verification script and record the reads before marking round-creation items complete.
