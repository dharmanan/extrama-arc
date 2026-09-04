# EXTREMA

ETHOnline 2026 Arc hackathon project.

## Current phase

The product structure is being completed first with neutral wireframes, typed domain data, and a shared functional demo state.

Visual design is intentionally deferred until the complete product flow is stable and tested.

## Product loop

1. Choose an asset: BTC, ETH, SOL, or HYPE.
2. Choose a cadence: Daily, Weekly, or Quarterly.
3. Choose High or Low.
4. Enter one unique price prediction.
5. Pay exactly 1 USDC.
6. Receive an NFT ticket.
7. The round resolves from the source locked at round creation.
8. Top 3 predictions receive 54%, 22.5%, and 13.5% of the gross pool.
9. 10% goes to treasury.
10. Winning NFT owners claim USDC.

## Route map

| Route | Purpose |
| --- | --- |
| `/` | Landing / home |
| `/pools` | All 24 standard pools |
| `/pools/[slug]` | Prediction entry |
| `/rounds/[slug]` | Live pool / distribution |
| `/results/[roundId]` | Settled result + winners + claim entry |
| `/verify/[roundId]` | Deterministic settlement verification |
| `/tickets` | User NFT tickets |
| `/leaderboard` | Rankings |
| `/how-it-works` | Product explanation |
| `/wallet` | Create wallet / connect wallet onboarding |

## Domain structure

- `app/lib/domain.ts` — typed domain model
- `app/lib/data.ts` — centralized typed mock data
- `app/product-components.tsx` — shared neutral wireframe components
- `app/wireframe.css` — temporary structural styles only
- `app/home.module.css` — current landing experiment; final visual design will be replaced later

## Pool model

4 assets × 2 directions × 3 cadences = 24 standard pools.

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

## Official result source

MVP resolution source:

**Binance USDⓈ-M Futures Mark Price**

Symbols:
- BTCUSDT
- ETHUSDT
- SOLUSDT
- HYPEUSDT

The source, symbol, observation window, and methodology are locked before the round begins.

## Functional demo state

The current browser demo already supports:
- shared wallet state across routes
- create/connect/lock/unlock/reset wallet flow
- persistent localStorage state
- test USDC funding
- asset/cadence pool filters
- exactly 1 USDC prediction entry
- one wallet per round
- duplicate-price rejection per round
- NFT ticket creation after entry
- My Tickets state
- winner claim with NFT ownership check
- balance update after claim
- deterministic result and verification pages

This demo state is temporary and will be replaced by real Arc contracts and wallet infrastructure before final delivery.

## Wallet plan

Primary:
- Create EXTREMA Wallet
- WebAuthn/passkey
- fresh EOA
- encrypted private key at rest
- recovery information shown once
- Arc Testnet ready

Secondary:
- Connect existing EVM wallet

The current wallet page is only a wireframe. No real wallet/key implementation exists yet.

## Design process

1. Complete product structure and route flow.
2. Confirm every screen and state.
3. Design the full product in Figma.
4. Replace wireframe styles with the approved Figma system.
5. Add real wallet, Arc USDC, contracts, NFT, resolver, and claim logic.
6. Add final motion/animation last.

## Development

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run check
```

## Important

Current content is mock UI data unless explicitly stated otherwise.

Do not treat the current wireframe styles as the final design.


## CI

GitHub Actions runs `npm ci` and `npm run check` on pushes and pull requests to `main`.
