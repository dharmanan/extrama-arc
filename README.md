# EXTREMA

ETHOnline 2026 Arc hackathon project.

## Current phase

Core implementation is in production. The project is now in production hardening plus final UI and proof work.

What is live:

- 24 pool contracts and 24 paired ERC-721 ticket collections on Arc Testnet (chain `5042002`)
- Real Arc Testnet USDC, real 1 USDC prediction entry, real ticket minting and transfer
- Passkey authentication and passkey step-up for critical signing
- Backend on Railway, frontend on Vercel, PostgreSQL on Railway
- Round lifecycle automation: scan, Daily round creation, permissionless locking, and resolver-authorized cancellation and settlement
- Binance mark-price settlement source with deterministic evidence hashing

What is still open:

- Weekly and Quarterly round creation are not yet automated
- Demo state still exists on some routes and is being removed
- Leaderboard and settlement verification pages are not yet backed by real data
- Cancellation, settlement, winners, payouts, and claim are implemented but not yet proven by a live Arc transaction
- Visual design is partially complete

`EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md` is the source of truth for what is proven versus what is merely implemented. This README is a summary and does not claim a complete product.

## Architecture

### Frontend
- Next.js
- prediction/pool/ticket/result routes
- owner wallet connection
- WebAuthn client
- one-time recovery disclosure UI

### Backend
- Express
- PostgreSQL
- WebAuthn challenge and credential storage
- JWT sessions
- encrypted EXTREMA EVM private keys
- one EXTREMA wallet per owner account

### Deployment
- Frontend: Vercel, live
- Backend: Railway, live
- Database: Railway PostgreSQL, live

### Round lifecycle automation

Runs inside the backend process on Railway. Coordinated across instances with PostgreSQL advisory locks so a duplicate instance cannot duplicate a transaction.

- Scans every pool at every cadence and isolates per-pool read failures
- Creates the current Daily round from the pool owner wallet. Weekly and Quarterly creation are not implemented yet
- Locks due rounds. `lockRound` is permissionless, so the owner wallet acts only as a funded sender
- Cancels underfilled rounds and settles eligible rounds from the resolver signer
- Re-reads live `pool.resolver()` before every resolver action and refuses to sign on mismatch
- Never resends a transaction. On an unknown send outcome it re-reads the round to determine whether the transition landed
- Retries transient Arc RPC read failures with bounded backoff. Broadcasts are never retried

## Wallet flow

New user:

1. Connect owner EVM wallet.
2. Request EXTREMA registration challenge.
3. Sign the challenge with the owner wallet.
4. Register a platform passkey.
5. Backend verifies the passkey and creates an authenticated session.
6. Backend creates a fresh EXTREMA EVM wallet.
7. Private key is encrypted at rest in PostgreSQL.
8. Plaintext private key is returned only in the wallet creation response.
9. User must save the key before continuing.

Returning user:

1. Connect the same owner wallet.
2. Authenticate with the registered passkey.
3. Backend restores the authenticated session.
4. Existing EXTREMA wallet is loaded. No new private key is created or revealed.

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
| `/results/[roundId]` | Result and claim |
| `/verify/[roundId]` | Settlement verification |
| `/tickets` | NFT tickets |
| `/leaderboard` | Rankings |
| `/how-it-works` | Product explanation |
| `/wallet` | Owner wallet + passkey + EXTREMA wallet |

## Backend endpoints

### Health
- `GET /readyz`
- `GET /health`

### Authentication
- `POST /api/auth/register/challenge`
- `POST /api/auth/register/start`
- `POST /api/auth/register/finish`
- `POST /api/auth/login/start`
- `POST /api/auth/login/finish`
- `GET /api/auth/session`
- `POST /api/auth/logout`

### EXTREMA wallet
- `GET /api/wallet`
- `POST /api/wallet/create`

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
- `WEBAUTHN_ORIGINS`
- `WEBAUTHN_RP_ID` in production

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

Visual design has begun. The prerequisites that originally gated it are met: frontend and backend checks pass, migrations run, passkey registration and login work end to end, EXTREMA wallet creation and reconnect work, and the Arc contract and USDC flows are stable in production.

Current state:

- Complete: the global design token foundation in `app/globals.css`, and the homepage
- Not started: the remaining routes, which still render the structural wireframe

The redesign is presentation only. It has not modified any backend, contract, schedule, or signer path, and the live data routes continue to read real Arc state.
