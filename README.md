# EXTREMA

ETHOnline 2026 Arc hackathon project.

## Current phase

Core implementation is live on Arc Testnet. EXTREMA is now in final hackathon acceptance, UI polish, and submission packaging.

What is live:

- 24 pool contracts and 24 paired ERC-721 ticket collections on Arc Testnet (chain `5042002`)
- Real Arc Testnet USDC with fixed 1 USDC prediction entries
- Real ERC-721 ticket minting and transferable claim/refund rights
- Two human wallet modes: a connected EVM wallet that signs every transaction itself, or a Circle user controlled wallet whose every transaction is approved in a Circle hosted challenge
- Backend on Railway, frontend on Vercel, PostgreSQL on Railway
- Automated Daily, Weekly, and Quarterly round creation and lifecycle handling
- Resolver-authorized real cancellation and settlement transactions
- Binance USDⓈ-M Futures Mark Price settlement evidence with deterministic hashing
- Real winner calculation, treasury accounting, claim, and refund flows proven on Arc Testnet
- Real leaderboard and settlement verification surfaces backed by production data
- Secondary marketplace contract/backend lifecycle implemented and deterministically verified
- Circle-powered production entry path proven on Arc Testnet
- Circle user controlled wallet support for the full post entry lifecycle (ticket transfer, refund, claim, marketplace list, update price, cancel and buy), deterministically verified; live Arc Testnet proof of these Circle actions is still open
- Nine autonomous seed wallets with gated production scheduling, immutable plans, fresh onchain preflight checks, and fail-closed transaction handling

Final hackathon work:

- Wrong-network detection and switch proof
- Final security acceptance checks
- Submission materials and demo video
- Final browser-level UI polish and official brand/link treatment
- Final single-round Arc Testnet end-to-end proof in Section 15

`EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md` remains the detailed proof record.

## Architecture

### Execution identities

EXTREMA has exactly three participant classes:

| Identity | Who | How transactions are signed |
| --- | --- | --- |
| `EXTERNAL_WALLET` | A person with their own EVM wallet | One login signature creates the session; the connected wallet signs every transaction itself |
| `CIRCLE_USER_WALLET` | A person who signs in with Google or email through Circle | A Circle user controlled Arc EOA; every transaction is approved by the user in a Circle hosted challenge |
| `SYSTEM_SEED_WALLET` | The nine autonomous EXTREMA seed agents | Encrypted seed wallets signed by the backend; they never hold a browser session |

Both human modes support the same lifecycle: entry, ticket transfer, refund, claim, and marketplace list, update price, cancel and buy. EXTREMA never holds or uses a private key for a human user.

### Frontend
- Next.js
- prediction/pool/ticket/result routes
- connected EVM wallet support
- Circle user controlled wallet SDK for hosted challenges
- per tab recovery of in flight Circle actions

### Backend
- Express
- PostgreSQL
- JWT sessions bound to one execution identity
- action authorizations bound to the session wallet, with a durable Circle challenge state machine
- exact transaction builders and receipt verifiers for every action
- encrypted private keys only for the `SYSTEM_SEED_WALLET` agents

### Deployment
- Frontend: Vercel, live
- Backend: Railway, live
- Database: Railway PostgreSQL, live

### Round lifecycle automation

Runs inside the backend process on Railway. Coordinated across instances with PostgreSQL advisory locks so a duplicate instance cannot duplicate a transaction.

- Scans every pool at every cadence and isolates per-pool read failures
- Creates the current canonical V2 Daily, Weekly, and Quarterly rounds from the pool owner wallet
- Locks due rounds. `lockRound` is permissionless, so the owner wallet acts only as a funded sender
- Cancels underfilled rounds and settles eligible rounds from the resolver signer
- Re-reads live `pool.resolver()` before every resolver action and refuses to sign on mismatch
- Never resends a transaction. On an unknown send outcome it re-reads the round to determine whether the transition landed
- Retries transient Arc RPC read failures with bounded backoff. Broadcasts are never retried

## Wallet flow

Connected wallet (`EXTERNAL_WALLET`):

1. Connect an EVM wallet on Arc Testnet.
2. Request a login challenge and sign it once with that wallet.
3. The backend verifies the signature and creates a session bound to that address.
4. For every action the backend returns the exact transaction to sign; the wallet signs and sends it, and the backend verifies the mined receipt.

Circle wallet (`CIRCLE_USER_WALLET`):

1. Continue with Google or email through Circle.
2. Circle provisions or restores the user's Arc EOA; the backend reads the address from Circle and creates a session bound to that wallet.
3. For every action the backend creates a Circle contract execution challenge for the exact calldata; the user approves it in the Circle hosted window.
4. The backend reconciles the Circle transaction and verifies the mined receipt. Actions that need an approval first (entry, marketplace list and buy) run the approval and the action as two separate challenges.

No private key is ever created, shown, or stored for a human user.

## Product loop

1. Choose BTC, ETH, SOL, or HYPE.
2. Choose Daily, Weekly, or Quarterly.
3. Choose High or Low.
4. Enter one unique prediction.
5. Pay exactly 1 USDC.
6. Receive an NFT ticket.
7. Round resolves using the locked official price source.
8. Top 3 receive 54%, 22.5%, and 13.5% of the gross pool.
9. 10% goes to treasury.
10. Current owner of a winning NFT claims the reward.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing |
| `/pools` | 24 standard pools |
| `/pools/[slug]` | Prediction entry |
| `/rounds/[slug]` | Live pool |
| `/results/[slug]/[roundId]` | Result and claim |
| `/verify/[slug]/[roundId]` | Settlement verification |
| `/tickets` | NFT tickets |
| `/leaderboard` | Rankings |
| `/how-it-works` | Product explanation |
| `/wallet` | Connect a wallet or continue with Circle |

## Backend endpoints

### Health
- `GET /readyz`
- `GET /health`

### Authentication
- `POST /api/auth/wallet-login/challenge`
- `POST /api/auth/wallet-login/finish`
- `GET /api/auth/session`
- `POST /api/auth/logout`

### Circle wallet
- `GET /api/circle/readiness`
- `POST /api/circle/device-token/social`
- `POST /api/circle/device-token/email`
- `POST /api/circle/wallet/initialize`
- `POST /api/circle/wallet`
- `POST /api/circle/session`

### Session wallet
- `GET /api/wallet`
- `GET /api/wallet/chain-state`
- `GET /api/wallet/gateway-balance`
- `GET /api/wallet/tickets`

### Actions

Every action has `start` and `verify`. `finish` exists only for the connected wallet: it returns the exact transaction the wallet signs. Circle sessions receive a Circle challenge from `start` and poll `verify`. Entry, marketplace list and marketplace buy also expose `approval/verify` for their approval phase.

- `/api/actions/entry/*`
- `/api/actions/ticket-transfer/*`
- `/api/actions/refund/*`
- `/api/actions/claim/*`
- `/api/actions/marketplace-list/*`
- `/api/actions/marketplace-update-price/*`
- `/api/actions/marketplace-cancel/*`
- `/api/actions/marketplace-buy/*`

## Local development

Frontend:

```bash
cp .env.example .env.local
npm install
npm run dev
```

Backend:

```bash
cp backend/.env.example backend/.env
cd backend
npm install
npm run db:migrate
npm run dev
```

Checks:

```bash
npm run check
npm run backend:check
npm run check:all
```

## Required backend secrets

- `DATABASE_URL`
- `ENCRYPTION_KEY`
- `JWT_SECRET`
- `CORS_ORIGINS`

Optional, required only for the Circle wallet mode:

- `CIRCLE_API_KEY` on the backend
- `NEXT_PUBLIC_CIRCLE_APP_ID` on the frontend

The backend no longer reads any `WEBAUTHN_*` variable; existing deployments can remove them.

Optional, required only for resolver-authorized cancellation and settlement:

- `EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED`

Generate secrets:

```bash
openssl rand -hex 32
```

Use separate values for `ENCRYPTION_KEY` and `JWT_SECRET`.

### Resolver signer

`EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED` holds the resolver key as an AES-256-GCM envelope in the `v1.<iv>.<ct>.<tag>` format produced by `cryptoService`, encrypted under the same `ENCRYPTION_KEY`. The config schema accepts only that shape, so a plaintext private key cannot be configured.

Build the envelope with `backend/scripts/encrypt-resolver-key.js`. It reads the key from a Foundry keystore, a keystore file, or a hidden prompt, verifies the derived address against the deployed resolver, and prints only the envelope. The key never reaches argv, shell history, disk, or logs.

At startup the backend decrypts the envelope, derives the address, and compares it to the live `pool.resolver()`. The result is logged and does not gate automation. Correctness is enforced independently before every cancel or settle.

If the variable is absent, the backend still runs. Scanning, Daily round creation, and locking continue, and cancellation and settlement are skipped.

## Official result source

MVP resolution source:

**Binance USDⓈ-M Futures Mark Price**

Symbols:
- BTCUSDT
- ETHUSDT
- SOLUSDT
- HYPEUSDT

## Design

The global EXTREMA visual system is active across the canonical product routes. The obsolete structural wireframe runtime layer has been removed.

Final browser-level polish remains:

- spacing, alignment, overflow, and responsive checks
- Koray Çifci identity/logo and `koraycifci.com`
- GitHub mark and `dharmanan/extrama-arc` repository link
- official Arc branding
- official Circle branding

This final polish is presentation only. It does not modify backend, contract, schedule, signer, settlement, or financial execution paths.
