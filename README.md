# EXTREMA

ETHOnline 2026 Arc hackathon project.

## Current phase

Product structure and backend infrastructure first. Visual design is intentionally deferred until the full flow is stable.

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
- Frontend: Vercel later
- Backend: Railway
- Database: Railway PostgreSQL

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

Generate secrets:

```bash
openssl rand -hex 32
```

Use separate values for `ENCRYPTION_KEY` and `JWT_SECRET`.

## Official result source

MVP resolution source:

**Binance USDⓈ-M Futures Mark Price**

Symbols:
- BTCUSDT
- ETHUSDT
- SOLUSDT
- HYPEUSDT

## Design

The current UI is only a structural wireframe.

Final visual design begins only after:
1. frontend checks pass,
2. backend checks pass,
3. PostgreSQL migration works,
4. passkey registration/login works end-to-end,
5. EXTREMA wallet creation/reconnect works,
6. Arc contracts and USDC flow are stable.
