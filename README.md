# EXTREMA

ETHOnline 2026 Arc hackathon project.

## Current phase

Core implementation is live on Arc Testnet. EXTREMA is now in final hackathon acceptance, UI polish, and submission packaging.

What is live:

- 24 pool contracts and 24 paired ERC-721 ticket collections on Arc Testnet (chain `5042002`)
- Real Arc Testnet USDC with fixed 1 USDC prediction entries
- Real ERC-721 ticket minting and transferable claim/refund rights
- Passkey authentication and fresh passkey step-up for critical signing
- Backend on Railway, frontend on Vercel, PostgreSQL on Railway
- Automated Daily, Weekly, and Quarterly round creation and lifecycle handling
- Resolver-authorized real cancellation and settlement transactions
- Binance USDⓈ-M Futures Mark Price settlement evidence with deterministic hashing
- Real winner calculation, treasury accounting, claim, and refund flows proven on Arc Testnet
- Real leaderboard and settlement verification surfaces backed by production data
- Secondary marketplace contract/backend lifecycle implemented and deterministically verified
- Circle-powered production entry path proven on Arc Testnet
- Nine autonomous seed wallets with gated production scheduling, immutable plans, fresh onchain preflight checks, and fail-closed transaction handling

Final hackathon work:

- Wrong-network detection and switch proof
- Final security acceptance checks
- Submission materials and demo video
- Final browser-level UI polish and official brand/link treatment
- Final single-round Arc Testnet end-to-end proof in Section 15

`EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md` remains the detailed proof record.

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
- Creates the current canonical V2 Daily, Weekly, and Quarterly rounds from the pool owner wallet
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
| `/results/[slug]/[roundId]` | Result and claim |
| `/verify/[slug]/[roundId]` | Settlement verification |
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

The global EXTREMA visual system is active across the canonical product routes. The obsolete structural wireframe runtime layer has been removed.

Final browser-level polish remains:

- spacing, alignment, overflow, and responsive checks
- Koray Çifci identity/logo and `koraycifci.com`
- GitHub mark and `dharmanan/extrama-arc` repository link
- official Arc branding
- official Circle branding

This final polish is presentation only. It does not modify backend, contract, schedule, signer, settlement, or financial execution paths.
