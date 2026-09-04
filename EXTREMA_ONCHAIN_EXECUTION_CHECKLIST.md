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

- [ ] Frontend and backend both verify Arc Testnet chain ID `5042002`
- [ ] EXTREMA wallet address is shown with Arc Testnet explorer link
- [ ] Wrong-network state is detected and blocked for transaction actions
- [ ] Switch-to-Arc-Testnet action is verified

### Proof record

- Chain ID:
- Wallet address:
- Explorer:
- Verification date:
- Notes:

## 1.2 Real native balance

- [ ] Read EXTREMA wallet native Arc Testnet balance through RPC
- [ ] Remove any mock/native demo balance from the product path
- [ ] UI displays the real RPC result only

### Proof record

- Wallet:
- RPC:
- Balance before:
- Balance after:
- Block number:
- Verification:

## 1.3 Real Arc Testnet USDC balance

Target token:

`0x3600000000000000000000000000000000000000`

- [ ] Verify token contract exists on Arc Testnet
- [ ] Verify token metadata/decimals from chain
- [ ] Read EXTREMA wallet `balanceOf` from the token contract
- [ ] Remove `Demo USDC balance`
- [ ] Remove `Get 10 demo USDC`
- [ ] UI displays only the real onchain USDC balance
- [ ] Real testnet funding path established
- [ ] Funding transaction verified onchain

### Proof record

- Token address:
- Decimals:
- Wallet:
- Balance before:
- Funding tx hash:
- Explorer:
- Balance after:
- Verification:

---

# 2. Smart contract foundation

No pool entry, NFT, settlement, refund, or claim is considered real until this section is complete.

## 2.1 Contract architecture locked

- [ ] Define final contract responsibilities
- [ ] Define immutable/constants:
  - Arc Testnet chain ID
  - USDC token address
  - treasury address
  - stake amount = exactly 1 USDC
  - payout percentages
- [ ] Define round state machine
  - `ENTRY_OPEN`
  - `LOCKED`
  - `SETTLED`
  - `CANCELLED`
- [ ] Define round identity by `roundId`, not market slug
- [ ] Define one-entry-per-wallet-per-round rule
- [ ] Define one-exact-price-per-round rule
- [ ] Define minimum 3 entries or cancel/refund
- [ ] Define winner ordering:
  1. absolute distance
  2. earlier onchain entry
  3. transaction/log index
- [ ] Define payout split:
  - 1st: 54%
  - 2nd: 22.5%
  - 3rd: 13.5%
  - treasury: 10%
- [ ] Define ERC-721 ticket ownership as claim-right ownership

## 2.2 Contract tests

- [ ] Unit tests for round creation
- [ ] Unit tests for entry
- [ ] Unit tests for duplicate-wallet rejection
- [ ] Unit tests for duplicate-price rejection
- [ ] Unit tests for entry close
- [ ] Unit tests for settlement
- [ ] Unit tests for winner ranking
- [ ] Unit tests for payout accounting
- [ ] Unit tests for cancellation
- [ ] Unit tests for refunds
- [ ] Unit tests for NFT transfer and claim-right transfer
- [ ] Unit tests for double-claim prevention

## 2.3 Arc Testnet deployment

- [ ] Deploy pool/round contract(s) to Arc Testnet
- [ ] Deploy ERC-721 ticket contract if separate
- [ ] Configure treasury
- [ ] Configure Arc Testnet USDC
- [ ] Verify deployed bytecode/contracts
- [ ] Record deployment transactions

### Proof record

- Pool contract:
- Ticket contract:
- Deployment tx:
- Explorer:
- Treasury:
- USDC:
- Verification:

---

# 3. Real round creation

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
- [ ] Observation start/end stored or deterministically represented
- [ ] UI reads real round state from chain/backend indexer
- [ ] Remove hardcoded `Players`, `Pool`, and `ENTRY_OPEN` values

### Proof record

- Example Daily roundId:
- Example Weekly roundId:
- Example Quarterly roundId:
- Creation tx hashes:
- Explorer:
- Contract reads:
- Verification:

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

**Section 1.3 — Real Arc Testnet USDC balance and real funding path.**

Do not advance to pool contracts until the EXTREMA wallet can:

1. read its real Arc Testnet USDC balance,
2. receive real testnet USDC,
3. prove the balance change onchain.
