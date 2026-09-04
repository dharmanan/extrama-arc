# EXTREMA Smart Contract Architecture v2

Status: **LOCKED FOR IMPLEMENTATION**

This document supersedes v1 before any Arc Testnet contract deployment.

## 1. High-level deployment topology

EXTREMA uses exactly 24 standard pool contracts:

- 4 assets: BTC, ETH, SOL, HYPE
- 2 directions: HIGH, LOW
- 3 cadences: DAILY, WEEKLY, QUARTERLY

Therefore:

`4 × 2 × 3 = 24 ExtremaPool contracts`

Each pool contract has a fixed immutable identity.

Example:

- BTC Daily High pool contract
- BTC Daily Low pool contract
- ETH Weekly High pool contract
- HYPE Quarterly Low pool contract

Each pool contract runs its own sequential rounds:

```
ETH Weekly Low Pool
├── Round #1
├── Round #2
├── Round #3
└── ...
```

Asset, direction, and cadence do **not** change between rounds.

## 2. Contract set

### ExtremaFactory / Registry

Responsibilities:

- deploy/register the 24 standard pool instances
- prevent duplicate asset + direction + cadence pools
- expose pool lookup by asset/direction/cadence
- expose the paired ticket collection for every pool
- provide canonical onchain registry for frontend/backend discovery

### 24 × ExtremaPool

Each instance is immutable for:

- asset
- direction
- cadence
- Arc Testnet USDC token
- ExtremaTreasury address
- its paired ExtremaTicket collection

Each pool is the financial source of truth for:

- round creation and lifecycle
- exactly 1 USDC entry escrow
- one-entry-per-wallet-per-round
- exact prediction-price uniqueness
- entry ordering
- settlement
- winner ticket IDs
- cancellation
- refunds
- claims
- per-round escrow accounting

There is no owner/admin function that can withdraw player escrow.

### 24 × ExtremaTicket

Every pool has its **own separate ERC-721 collection**.

Examples:

- BTC Daily High Ticket collection
- BTC Daily Low Ticket collection
- ETH Weekly High Ticket collection
- SOL Quarterly Low Ticket collection

A pool instance deploys or is permanently paired with exactly one ticket collection.

Consequences:

- NFTs from different pools cannot be confused by collection address
- token IDs may safely begin from 1 inside each collection
- asset/direction/cadence identity is fixed at collection level
- every NFT still records its own round and prediction data
- current NFT owner controls claim/refund rights

### ExtremaTreasury

Only the protocol's 10% settlement share is sent here.

Treasury controller addresses:

- Controller A: `0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321`
- Controller B: `0x99677aab4b168c274A34525D526346fC47Fab72c`

Rules:

- either controller may withdraw treasury funds independently
- withdrawals go only to the controller that called withdraw
- controller A cannot redirect controller B's withdrawal to an arbitrary third party
- controller B can still recover treasury funds if controller A is unavailable, and vice versa
- treasury controllers have **no authority over pool escrow**
- pool contracts have no generic admin withdrawal/sweep of player funds

Security tradeoff:

- this is intentionally 1-of-2 availability for treasury funds
- compromise of either controller can expose treasury funds held in ExtremaTreasury
- compromise of a treasury controller cannot expose player escrow held in ExtremaPool

For mainnet, a threshold multisig/timelocked recovery design should be evaluated separately.

### ExtremaRenderer

NFT visuals and JSON/SVG metadata are separated from financial logic.

Responsibilities:

- generate fully onchain SVG
- generate fully onchain JSON metadata
- render different visual variants for:
  - BTC / ETH / SOL / HYPE
  - HIGH / LOW
  - DAILY / WEEKLY / QUARTERLY
- render token-specific data:
  - pool identity
  - round ID
  - prediction price
  - entry sequence
  - ticket ID
  - live/settled/cancelled state
  - winner placement
  - claimed/refunded state

Renderer replacement may be allowed by a narrowly-scoped metadata/admin role so NFT visual design can evolve without changing economic ownership or pool rules.

Renderer authority must never be able to:

- transfer NFTs
- mint unauthorized NFTs
- change predictions
- change round results
- claim funds
- access pool escrow

## 3. Arc Testnet constants

- Chain ID: `5042002`
- USDC token: `0x3600000000000000000000000000000000000000`
- ERC-20 decimals: `6`
- entry stake: `1_000_000` token units = exactly `1 USDC`

## 4. Pool identity

Each ExtremaPool stores immutable:

- `ASSET`
- `DIRECTION`
- `CADENCE`
- `USDC`
- `TREASURY`
- `TICKET`

A round does not repeat those values because they are inherited from the pool contract.

## 5. Round identity

Each pool has its own monotonically increasing `roundId`.

Therefore these are distinct:

- BTC Daily High Pool / Round #1
- BTC Daily Low Pool / Round #1
- ETH Weekly Low Pool / Round #1

Canonical identity is:

`pool contract address + roundId`

## 6. Prediction representation

Prediction prices use integer cents.

Examples:

- `$2,085.43 -> 208543`
- `$73,421.00 -> 7342100`
- `$42.80 -> 4280`

Target type: `uint64`.

Exact-price uniqueness is scoped to:

`pool address + roundId + predictionPriceCents`

## 7. Round state machine

States:

1. `ENTRY_OPEN`
2. `LOCKED`
3. `SETTLED`
4. `CANCELLED`

Transitions:

`ENTRY_OPEN -> LOCKED -> SETTLED`

or

`ENTRY_OPEN -> LOCKED -> CANCELLED`

Rules:

- entries only during ENTRY_OPEN
- entry must occur before entryCloseAt
- settlement/cancellation only after observationEndAt
- fewer than 3 accepted entries => CANCELLED
- 3 or more => settlement eligible
- settled/cancelled are terminal

## 8. Entry

Accepted entry conditions:

- valid round
- ENTRY_OPEN
- before entryCloseAt
- wallet has not entered this round
- exact prediction slot not already taken
- exactly 1 USDC transferred successfully

On success:

1. escrow 1 USDC
2. record entry
3. increment entry sequence
4. mint one NFT from this pool's dedicated ExtremaTicket collection
5. update round entry count
6. update round reserved escrow
7. emit PredictionEntered

## 9. Per-round escrow accounting

Every round records its remaining reserved obligation.

Required state includes:

- `round.totalStake`
- `round.escrowRemaining`
- contract-level `totalReservedUSDC`

Invariant:

`USDC.balanceOf(pool) >= totalReservedUSDC`

Direct accidental USDC transfers to the pool do not become round stake and do not change reserved accounting.

No generic withdrawal function may reduce reserved player funds.

Any future rescue function for accidental excess tokens must be limited to:

`contract balance - totalReservedUSDC`

and must never touch reserved escrow.

## 10. Settlement source

Offchain resolver source:

**Binance USDⓈ-M Futures Mark Price Klines**

Symbols:

- BTCUSDT
- ETHUSDT
- SOLUSDT
- HYPEUSDT

Rules:

- HIGH = maximum candle high in observation window
- LOW = minimum candle low in observation window

The pool identity already determines which asset/direction rule applies.

## 11. Winner ranking

1. smallest absolute distance from resolved price
2. earlier accepted onchain entry sequence
3. transaction/log position for independent audit proof

## 12. Payout accounting

Basis points:

- first: 5400 = 54%
- second: 2250 = 22.5%
- third: 1350 = 13.5%
- treasury: 1000 = 10%

Total = 10000 basis points.

On settlement:

- winner entitlements remain claimable from pool escrow
- protocol share is transferred to ExtremaTreasury
- ExtremaTreasury is the only place the two treasury controllers can withdraw from

No treasury controller can call a pool withdrawal function because no such player-escrow withdrawal function exists.

## 13. Treasury withdrawal behavior

ExtremaTreasury exposes controller-only withdrawal.

Conceptually:

```
controller A -> withdraw(amount) -> USDC goes to controller A
controller B -> withdraw(amount) -> USDC goes to controller B
```

No arbitrary destination parameter is required.

This gives availability redundancy without granting either controller direct pool access.

## 14. NFT collection model

There are 24 separate collections, one per pool.

Collection identity examples:

- `EXTREMA BTC DAILY HIGH`
- `EXTREMA BTC DAILY LOW`
- `EXTREMA ETH WEEKLY HIGH`
- `EXTREMA HYPE QUARTERLY LOW`

Within each collection, each token contains dynamic onchain data:

- ticket ID
- round ID
- prediction
- entry sequence
- current owner
- live/settled/cancelled
- winner placement
- claim/refund state

## 15. NFT visual system

All NFT data and artwork are generated onchain.

Base visual variants:

### Asset layer

- BTC visual family
- ETH visual family
- SOL visual family
- HYPE visual family

### Direction layer

- HIGH: upward directional motif
- LOW: downward directional motif

### Cadence layer

- DAILY
- WEEKLY
- QUARTERLY

This produces 24 recognizable visual families while retaining one EXTREMA brand system.

Example identity:

```
BTC
DAILY · HIGH
↑

Prediction
$73,421.00

Round #28
Ticket #184
Entry #37

LIVE
```

The renderer can later change visual styling while the ticket collection address, ownership, prediction, and economic rights remain unchanged.

## 16. NFT claim/refund right

Current `ownerOf(ticketId)` controls the economic right.

If a ticket is transferred:

- original entrant loses the claim/refund right
- new NFT owner receives the claim/refund right

Settled winner:

- current NFT owner may claim prize once

Cancelled round:

- current NFT owner may claim 1 USDC refund once

## 17. Access control

Roles are isolated:

- Factory admin: pool deployment/registry only
- Pool owner/admin: round creation/configuration only
- Resolver: settlement/cancellation only
- Ticket minter: paired pool only
- Renderer admin: metadata/art renderer only
- Treasury controllers: treasury withdrawal only

No treasury controller is a pool escrow controller.

No renderer authority has financial authority.

## 18. Deployment count

Target architecture:

- 1 ExtremaFactory / Registry
- 1 ExtremaTreasury
- 1 ExtremaRenderer
- 24 ExtremaPool
- 24 ExtremaTicket

Total target addresses: **51 contracts**

The 24 ticket contracts may be created by their paired pool contracts, so pool deployment can atomically establish the pool + its NFT collection.

## 19. Implementation acceptance gate

Before Arc Testnet deployment:

- contracts compile
- all unit tests pass
- treasury isolation tests pass
- either treasury controller can withdraw treasury funds
- neither treasury controller can withdraw pool escrow
- 24 unique pool identities are enforced
- each pool has a distinct ticket collection
- ticket transfer moves economic right
- per-round escrow invariant tests pass
- renderer produces deterministic onchain metadata/SVG
- no deployment occurs until these gates pass
