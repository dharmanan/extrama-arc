# EXTREMA Smart Contract Architecture v1

Status: **LOCKED FOR IMPLEMENTATION**

This document defines the v1 Arc Testnet contract architecture. Any change to these rules after implementation begins must be recorded explicitly in this file and in `EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md`.

## 1. Contracts

### ExtremaPool

Single source of truth for:

- round creation and lifecycle
- 1 USDC entry escrow
- prediction uniqueness
- one-entry-per-wallet-per-round
- entry ordering
- settlement result
- winner ticket IDs
- cancellation
- refunds
- claims
- treasury accounting

### ExtremaTicket

ERC-721 prediction ticket.

Responsibilities:

- mint exactly one ticket for every accepted prediction
- expose standard ERC-721 ownership and transfer behavior
- allow `ExtremaPool` to query current `ownerOf(ticketId)`
- ticket ownership is the claim/refund ownership right wherever the round rules require a ticket holder

The ticket contract does not hold pool funds.

## 2. Arc Testnet constants

- Chain ID: `5042002`
- USDC token: `0x3600000000000000000000000000000000000000`
- USDC decimals: `6`
- Entry stake: `1_000_000` token units = exactly `1 USDC`

Treasury is an immutable constructor/configuration address supplied at deployment and recorded in the deployment proof.

## 3. Prediction price representation

Prediction values are stored as integer cents.

Examples:

- `$2,085.43 -> 208543`
- `$73,421.00 -> 7342100`
- `$42.80 -> 4280`

Type target: `uint64`.

Consequences:

- exact-price uniqueness is deterministic
- no floating-point arithmetic exists onchain
- adjacent available slots differ by exactly `$0.01`
- UI must normalize user input to exactly two decimal places before transaction construction

Settlement prices submitted by the resolver must use the same cents representation.

## 4. Round identity

Every actual contest instance has a unique monotonically increasing `roundId`.

Market slug/template is not round identity.

A round records at minimum:

- `roundId`
- asset
- direction
- cadence
- entryOpenAt
- entryCloseAt
- observationStartAt
- observationEndAt
- status
- entryCount
- totalStake
- resolvedPriceCents
- winner ticket IDs after settlement

Assets:

- BTC
- ETH
- SOL
- HYPE

Directions:

- HIGH
- LOW

Cadences:

- DAILY
- WEEKLY
- QUARTERLY

## 5. Round state machine

Allowed states:

1. `ENTRY_OPEN`
2. `LOCKED`
3. `SETTLED`
4. `CANCELLED`

Allowed transitions:

`ENTRY_OPEN -> LOCKED -> SETTLED`

or

`ENTRY_OPEN -> LOCKED -> CANCELLED`

Rules:

- entries accepted only while state is `ENTRY_OPEN`
- entry transaction must also require `block.timestamp < entryCloseAt`
- settlement/cancellation cannot happen before observation end
- fewer than 3 accepted entries results in `CANCELLED`
- 3 or more accepted entries are eligible for settlement
- settled/cancelled rounds are terminal

## 6. Entry rules

An accepted entry must satisfy all of the following:

- round exists
- round is `ENTRY_OPEN`
- current time is before `entryCloseAt`
- entrant has not previously entered this `roundId`
- prediction price is not already taken in this `roundId`
- stake transferred successfully: exactly `1_000_000` USDC units

On success:

1. mark wallet as entered for the round
2. mark prediction cents as taken for the round
3. increment deterministic entry sequence
4. mint one ERC-721 ticket
5. store entry record
6. increment round entry count
7. increment round stake accounting
8. emit entry event

Entry record contains at minimum:

- ticketId
- roundId
- original entrant
- predictionPriceCents
- entrySequence

The transaction/log position remains independently available from chain history for audit proof.

## 7. Entry ordering and tie breaking

Winner ordering is:

1. smallest absolute distance from resolved price
2. earlier accepted onchain entry
3. transaction/log index as final audit tie break

The contract stores a monotonically increasing `entrySequence` for every accepted entry.

Because contract execution is sequential, `entrySequence` provides deterministic onchain ordering. Transaction/log index remains part of the external verification record.

## 8. Settlement

Resolver submits one final `resolvedPriceCents` after the observation period.

Offchain source:

**Binance USDⓈ-M Futures Mark Price Klines**

Resolution rule:

- HIGH = maximum candle high during the defined observation period
- LOW = minimum candle low during the defined observation period

The resolver proof pipeline remains separate from the contract. The contract receives the final integer-cent result.

Settlement requirements:

- round is `LOCKED`
- observation period has ended
- entry count >= 3
- round has never been settled
- resolver caller is authorized

Settlement stores:

- resolved price
- winner #1 ticketId
- winner #2 ticketId
- winner #3 ticketId
- terminal `SETTLED` status

Winner selection must be deterministic from accepted onchain entries.

## 9. Payout accounting

Basis points:

- first: `5400` = 54%
- second: `2250` = 22.5%
- third: `1350` = 13.5%
- treasury: `1000` = 10%

Total: `10000` basis points.

For a standard pool of N entries:

`grossPool = N * 1_000_000 USDC units`

Entitlements are calculated from the gross pool.

Integer rounding policy:

- first, second, and third entitlements use integer division
- treasury receives the remainder after the three winner entitlements

Therefore all escrowed USDC is accounted for exactly and no dust is stranded by payout rounding.

## 10. NFT ownership and claim right

The prediction ticket is transferable.

At claim time:

- contract queries `ExtremaTicket.ownerOf(ticketId)`
- claimant must be the current NFT owner
- original entrant identity does not override current NFT ownership
- if ticket changed hands after entry, claim right moved with the NFT

A ticket can only be claimed once.

Claim state is stored by ticket ID.

## 11. Cancellation and refunds

If a round reaches its observation end with fewer than 3 accepted entries:

- round becomes `CANCELLED`
- no treasury allocation exists
- no winners exist
- each accepted ticket represents exactly 1 USDC refundable principal

Refund ownership follows current NFT ownership:

- current `ownerOf(ticketId)` may refund
- original entrant cannot refund after transferring the NFT
- each ticket may refund once
- refund transfers exactly `1_000_000` USDC units

This keeps ownership semantics consistent between settled and cancelled rounds.

## 12. Double-spend protections

Required mappings/state:

- wallet entered by `roundId + wallet`
- prediction taken by `roundId + priceCents`
- claimed by `ticketId`
- refunded by `ticketId`
- round terminal status prevents repeated settlement/cancellation

Checks-effects-interactions order must be used for claim/refund.

Reentrancy protection is required for state-changing fund-transfer methods.

## 13. Access control

At minimum:

- admin/owner role: deployment configuration and round creation
- resolver role: settlement/cancellation result finalization
- ticket minter: only `ExtremaPool`

No user-facing entry/claim/refund endpoint may depend solely on backend JWT authorization.

Backend signer actions must later be protected by the separately specified fresh passkey step-up flow.

## 14. Events

Minimum event set:

- `RoundCreated`
- `RoundLocked`
- `PredictionEntered`
- `RoundSettled`
- `RoundCancelled`
- `RewardClaimed`
- `RefundClaimed`
- `TreasuryAllocated`

ERC-721 standard `Transfer` events remain the ticket ownership history.

## 15. Onchain truth vs indexer

Contract state and events are financial truth.

Backend/Postgres may index chain state for fast UI reads, but it must never become an independent financial source of truth.

If indexed state disagrees with chain state, chain state wins.

## 16. Implementation acceptance gate

Architecture is considered implemented only after:

- Solidity contracts compile
- unit tests cover all checklist cases
- Arc Testnet deployment succeeds
- deployment transaction hashes are recorded
- contract addresses are recorded
- at least one real round is created onchain
- subsequent entry/NFT/settlement/claim/refund steps pass their own proof gates
