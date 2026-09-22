# EXTREMA

**Predict the extreme. Own the ticket.**

> **TESTNET ONLY**
>
> EXTREMA is deployed and operated only on Arc Testnet. There is no EXTREMA real-money mainnet deployment operated by the project author. Testnet USDC is for testing and has no intended real-world monetary value. Anyone who forks or deploys this code is responsible for their own legal, regulatory, security, and operational requirements.

EXTREMA is an onchain prediction game built on Arc for forecasting the highest or lowest price reached by BTC, ETH, SOL, or HYPE over Daily, Weekly, and Quarterly periods.

Every prediction costs exactly **1 USDC**. Every exact price can be taken only once per round. A successful entry mints a transferable ERC-721 ticket, and the current owner of that ticket owns the right to trade it, receive a refund if the round is cancelled, or claim the reward if it wins.

Instead of locking a prediction to the wallet that created it, EXTREMA turns that prediction into an ownable onchain asset.

Built for **ETHOnline 2026**, Arc track.

## What EXTREMA does

EXTREMA combines four pieces into one market:

- exact price prediction
- fixed 1 USDC participation
- transferable NFT ownership
- secondary trading before settlement

The market set is deliberately simple:

| Dimension | Options |
| --- | --- |
| Assets | BTC, ETH, SOL, HYPE |
| Periods | Daily, Weekly, Quarterly |
| Outcomes | High, Low |
| Total pools | 24 |

Daily, Weekly, and Quarterly High and Low markets are independent. A prediction entered in one pool has no effect on another.

## How a round works

1. Choose an asset, period, and High or Low market.
2. Enter an exact price prediction.
3. Pay exactly 1 USDC.
4. Receive an ERC-721 prediction ticket.
5. Keep the ticket, transfer it, or list it on the marketplace.
6. The round locks when entry closes.
7. EXTREMA resolves the period High or Low from its archived market data.
8. If at least three predictions entered, the round settles and the three closest tickets win.
9. If fewer than three predictions entered, the round is cancelled and each current ticket owner can refund the 1 USDC stake.

Prediction prices are unique inside each round. If a price is already taken, another participant must choose another price.

## Ranking and payouts

Winners are ranked by absolute distance from the resolved price.

If two predictions are equally close, the earlier entry sequence wins the tie. The ticket ID provides the final deterministic fallback.

For a settled round, the gross pool is distributed as:

| Recipient | Share |
| --- | ---: |
| 1st place | 54% |
| 2nd place | 22.5% |
| 3rd place | 13.5% |
| Treasury | 10% |

The contract accounts for the complete pool.

## Transferable prediction tickets

Every entry mints an ERC-721 ticket.

The ticket is not decorative metadata. It carries the economic right attached to the prediction.

The current NFT owner controls:

- transfer rights
- marketplace listing rights
- cancellation refund rights
- winner claim rights

The original entrant remains permanently recorded for attribution, but economic ownership follows the NFT.

This means a winning prediction can change hands before settlement and the buyer, not the original entrant, can later claim the reward.

## Secondary marketplace

EXTREMA includes an onchain marketplace for prediction tickets.

A ticket owner can:

- list a ticket at an arbitrary USDC ask
- update the ask
- cancel the listing
- sell the ticket to another participant

Marketplace prices use exact ERC-20 USDC amounts.

Buying is atomic: the buyer pays the exact ask and receives the NFT in the same transaction.

The marketplace protects against stale state. A purchase is rejected if the expected ask changed, the seller no longer owns the ticket, the listing is no longer active, or trading has passed the configured cutoff.

## Why Arc

EXTREMA is designed around Arc's stablecoin-native execution model.

On Arc, **USDC is both the application currency and the native gas currency**. A participant does not need ETH or a second token just to use the application.

Arc exposes the same underlying USDC through two technical interfaces:

| Interface | Decimals | EXTREMA use |
| --- | ---: | --- |
| Native USDC | 18 | network fees and native EVM execution |
| ERC-20 USDC | 6 | stake, transfers, approvals, marketplace payments, rewards, refunds, and application balance display |

These are two representations of the same underlying economic balance.

EXTREMA never adds them together and never presents them as two assets.

Application accounting uses the 6 decimal ERC-20 interface. Native balance reads are used only where EVM gas semantics require them.

For the user, there is one economic asset:

**USDC.**

## Wallet and execution model

EXTREMA supports three execution identities.

| Identity | Participant | Signing model |
| --- | --- | --- |
| `EXTERNAL_WALLET` | Human using an EVM wallet | The connected wallet signs every financial transaction |
| `CIRCLE_USER_WALLET` | Human using Google onboarding | The user approves every transaction through a Circle hosted challenge |
| `SYSTEM_SEED_WALLET` | Autonomous EXTREMA agent | An approved encrypted seed wallet signs through the controlled backend automation path |

There is no active human backend signer.

There is no active passkey or WebAuthn execution path.

Human private keys are never created, stored, or exposed by EXTREMA.

## Circle integration

Circle is not used only for login.

A Circle user-controlled Arc wallet can participate across the complete EXTREMA lifecycle:

- enter a prediction
- transfer a ticket
- refund a cancelled ticket
- claim a winning ticket
- list a ticket
- update a marketplace price
- cancel a listing
- buy a listed ticket

Every financial action is bound to the authenticated Circle wallet and executed through a Circle hosted challenge.

Actions that require token approval use separate approval and execution phases. EXTREMA stores the challenge state durably, reconciles the resulting transaction, and verifies the mined Arc receipt before considering the action complete.

A real Circle prediction entry has already been executed on Arc Testnet. The complete Circle action lifecycle is also covered by the deterministic verification harness.

## External wallets

Participants can also connect a standard EVM wallet.

One signed login challenge creates a session bound to that address. After login, the backend prepares the exact transaction for each requested action, but the user's wallet signs and sends it.

EXTREMA verifies the resulting mined receipt against the action that was authorized.

The backend cannot spend on behalf of an external wallet.

## Autonomous participants

EXTREMA also includes nine approved autonomous seed participants.

They use the same onchain pools and the same economic rules as human users.

Their execution path is isolated as `SYSTEM_SEED_WALLET` and includes:

- encrypted wallet material
- explicit production enablement
- approved wallet controls
- fresh round and funding checks
- deterministic prediction plans
- duplicate entry protection
- unique price checks
- bounded RPC retry for reads
- no blind transaction retry after an uncertain broadcast outcome

Agents do not receive a special contract path or different payout rules.

## Settlement data

EXTREMA resolves markets from **Binance USDⓈ-M Futures Mark Price** data.

The system archives Daily High and Low observations for every supported asset.

Weekly and Quarterly outcomes are derived from that daily archive rather than using a separate settlement feed.

Quarterly markets use a 91 day period.

Settlement evidence is recorded deterministically, including a SHA-256 evidence hash, so the source data and resolved result can be independently checked.

Round lifecycle automation creates, locks, cancels, and settles canonical rounds according to their schedules.

## Onchain lifecycle

A round moves through an explicit state machine:

```text
ENTRY_OPEN
    |
    v
LOCKED
   / \
  /   \
 v     v
SETTLED   CANCELLED
```

A round with at least three participants can settle.

A round with fewer than three participants is cancelled.

For settled rounds, claim rights follow the winning NFT.

For cancelled rounds, refund rights follow the current NFT owner.

Both claim and refund are single use.

## Security and transaction safety

EXTREMA treats every financial action as a state transition that must be independently verified.

Execution safeguards include:

- session identity binding
- exact action payload binding
- one-time authorization consumption
- replay protection
- exact ERC-20 approval amounts
- no `MaxUint256` marketplace approval
- fresh ownership and listing checks
- mined receipt verification
- post-transaction state verification
- no blind resend after an uncertain broadcast
- encrypted autonomous wallet material
- separate resolver authorization for settlement
- fail-closed behavior on signer or chain mismatch

The repository also includes a committed-secret scanner and CI verification gates.

## Deployed on Arc Testnet

| Component | Value |
| --- | --- |
| Network | Arc Testnet |
| Chain ID | `5042002` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Factory | `0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A` |
| Marketplace | `0x0C50FE3edD739B7268d58E1414F973e9A55dd037` |
| Renderer | `0x1C52E55B8CC91A8E327BDDA8E0FAE33bC41fEe1` |
| Resolver | `0x1EDC4594195fFb134315c3258DE974563Ed9762A` |
| Treasury | `0x1D00C89Ed4AF7227a858D305183B4037f732b87e` |

The factory manages 24 deployed prediction pools and their paired ERC-721 ticket collections.

All current project activity is on Arc Testnet.

## Selected Arc Testnet evidence

The project has recorded real Arc Testnet execution for the core lifecycle.

| Proof | Transaction |
| --- | --- |
| Circle prediction entry | `0x9ef2fcbc33b7195517e2e3b323fce34b96e87550e9ce9d6222b3a6769d633d52` |
| Settled round with at least three entries | `0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9` |
| Refund with USDC movement | `0x04183e238f8e2e2a29e733119b5262e2ffc74b8c492542d73febce04117cb8cf` |
| Winner claim with USDC movement | `0xc7913e802e228549cfb564e60eba6f6f57afbbc1e8e4e8fe33ee0f11e59cf2ff` |
| Secondary marketplace listing | `0x7b1137330f1bd1d34374998a5e7c1d8b1d80adeeddd3309ea48af127fce7557de` |
| Secondary marketplace purchase (Listing #3, 2.5 USDC) | `0x76ee63cdd5d010ceb662be4fe00e9a59645d16e044d7a9e3108757b4a2486846` |

The detailed evidence record, including round state, balances, ownership transitions, and acceptance gates, is maintained in [EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md](./EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md).

## Verification

EXTREMA includes complementary verification layers across contracts, backend execution, application behavior, and security.

### Smart contracts

Foundry tests cover:

- pool entry
- round lifecycle
- cancellation and refunds
- ranking and settlement
- reward claims
- transferred winner claims
- treasury accounting
- ticket ownership
- marketplace listing
- marketplace price updates
- marketplace cancellation
- marketplace purchases
- stale ownership
- trading cutoff
- reentrancy protection
- Arc deployment compatibility

The contract suite contains **67 deterministic tests**.

### Backend and execution state machines

The backend verification harness covers:

- External Wallet execution
- Circle User Wallet execution
- System Seed Wallet execution
- action authorization and replay
- Circle challenge recovery
- entry approval
- ticket transfer
- refund
- claim
- marketplace lifecycle
- transaction reconciliation
- scheduler behavior
- market archive behavior
- canonical schedules
- One USDC accounting invariants

### Application gates

The repository provides repeatable checks for:

- frontend type safety and production build
- backend checks
- deterministic E2E readiness
- committed-secret scanning
- dependency vulnerabilities
- Foundry contract tests

Primary commands:

```bash
npm run check
npm --prefix backend run check
npm --prefix backend run verify:e2e
node backend/scripts/verify-no-committed-secrets.js
forge test
```

The current deterministic CI baseline is Forge **67/67**, backend Layer 3 **28/28**, and the E2E matrix **51 PASS / 0 FAIL**, ending in `EXTREMA_E2E=PASS`.

The recorded final live single-round proof is ETH Daily High Round #4 and ends in `RESULT=FINAL_SINGLE_ROUND_PROOF_COMPLETE`. Live proofs are intentionally kept separate from required deterministic CI because public RPC or hosted-service availability must not make ordinary source-code checks flaky.

Detailed readiness documentation is available in:

- [EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md](./EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md)
- [docs/EXTREMA_E2E_READINESS.md](./docs/EXTREMA_E2E_READINESS.md)
- [docs/REFUND_CANCELLATION_READINESS.md](./docs/REFUND_CANCELLATION_READINESS.md)

## Architecture

```text
Browser
  |
  | External Wallet
  | or Circle User Wallet
  v
Next.js application
  |
  v
Express backend
  |
  +--> PostgreSQL
  |
  +--> Circle User Controlled Wallet APIs
  |
  +--> Binance Mark Price archive
  |
  +--> Arc RPC
         |
         +--> ExtremaFactory
         +--> 24 ExtremaPool contracts
         +--> 24 ERC-721 ticket collections
         +--> ExtremaMarketplace
         +--> ExtremaRenderer
         +--> USDC
```

The frontend is deployed on Vercel.

The backend and PostgreSQL database run on Railway.

Round automation runs inside the backend and coordinates across instances with PostgreSQL advisory locks.

## Repository structure

```text
app/                 Next.js application
backend/             Express API, automation, Circle execution and persistence
contracts/           Solidity contracts
contracts/test/      Foundry contract tests
script/              Solidity and acceptance scripts
docs/                Technical readiness and proof documentation
```

## Local development

Install frontend dependencies:

```bash
npm install
```

Install backend dependencies:

```bash
npm --prefix backend install
```

Run the frontend:

```bash
npm run dev
```

Run the backend:

```bash
npm run backend:dev
```

Run the application checks:

```bash
npm run check
npm run backend:check
```

## Configuration

Core backend configuration includes:

```text
DATABASE_URL
ENCRYPTION_KEY
JWT_SECRET
CORS_ORIGINS
```

Circle wallet support additionally requires:

```text
CIRCLE_API_KEY
NEXT_PUBLIC_CIRCLE_APP_ID
NEXT_PUBLIC_CIRCLE_GOOGLE_CLIENT_ID
NEXT_PUBLIC_CIRCLE_GOOGLE_REDIRECT_URI
```

`CIRCLE_API_KEY` is a backend-only secret and must never be exposed to browser code or committed to the repository. The Google OAuth client ID is public browser configuration; EXTREMA does not require a Google client secret in the frontend.

Resolver-authorized settlement requires the encrypted resolver credential configured by the deployment environment.

No `WEBAUTHN_*` configuration is used by the active runtime.

## Open-source testnet release

This repository is released as a testnet reference implementation. It is not an operated mainnet real-money service.

Before running your own deployment:

- create your own deployment credentials and never reuse the project's credentials
- keep round creation, seed-agent execution, and Gateway broadcasting disabled unless you intentionally configure those paths
- review the deployed contract addresses and network configuration
- follow the secret-rotation guidance in [docs/SECURITY_OPERATIONS.md](./docs/SECURITY_OPERATIONS.md)
- run the deterministic CI/E2E checks before enabling any write path

The code is licensed under the **MIT License**. See [LICENSE](./LICENSE).

## Built by

**Koray Çifci**

koraycifci.com

GitHub: `@dharmanan`

Repository: `dharmanan/extrama-arc`

Built for ETHOnline 2026 on Arc.
