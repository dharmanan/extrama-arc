CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  owner_address VARCHAR(42) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  purpose VARCHAR(40) NOT NULL,
  rp_id TEXT,
  origin TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_challenges_user_purpose_idx
  ON auth_challenges(user_id, purpose);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  device_name VARCHAR(100) NOT NULL DEFAULT 'My Device',
  rp_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS passkey_credentials_user_rp_idx
  ON passkey_credentials(user_id, rp_id);

CREATE TABLE IF NOT EXISTS extrema_wallets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  wallet_address VARCHAR(42) NOT NULL UNIQUE,
  private_key_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  jti UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_address VARCHAR(42) NOT NULL,
  execution_mode VARCHAR(32) NOT NULL DEFAULT 'BACKEND_WALLET',
  wallet_address VARCHAR(42),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions(user_id);

-- Migration-safe execution identity. Existing rows remain legacy backend
-- wallet sessions; new external-wallet sessions persist their economic wallet
-- address explicitly instead of overloading owner_address.
ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(32) NOT NULL DEFAULT 'BACKEND_WALLET';

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);

DO $$
BEGIN
  ALTER TABLE auth_sessions
    ADD CONSTRAINT auth_sessions_execution_mode_check CHECK (
      execution_mode IN ('BACKEND_WALLET', 'EXTERNAL_WALLET', 'CIRCLE_USER_WALLET')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS action_authorizations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type VARCHAR(32) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  payload_json JSONB NOT NULL,
  challenge TEXT,
  rp_id TEXT,
  origin TEXT,
  challenge_consumed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  authorization_token_hash CHAR(64),
  authorization_expires_at TIMESTAMPTZ,
  external_state VARCHAR(32),
  verified_tx_hash VARCHAR(66),
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_authorizations_user_idx
  ON action_authorizations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS action_authorizations_token_idx
  ON action_authorizations(authorization_token_hash)
  WHERE authorization_token_hash IS NOT NULL;

ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS external_state VARCHAR(32);

ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS verified_tx_hash VARCHAR(66);

-- Durable settlement evidence, written before settleRound is broadcast.
-- canonical_evidence_json is TEXT, not JSONB, deliberately: PostgreSQL JSONB
-- does not guarantee key ordering is preserved on storage/reload, and
-- evidence_sha256 must always be reproducible from the exact string that
-- was originally hashed. Re-verification hashes this TEXT column directly,
-- never a JSON.stringify of a reloaded JSONB value.
CREATE TABLE IF NOT EXISTS settlement_evidence (
  pool_address VARCHAR(42) NOT NULL,
  round_id BIGINT NOT NULL,
  slug VARCHAR(64) NOT NULL,
  asset VARCHAR(16) NOT NULL,
  direction VARCHAR(8) NOT NULL,
  cadence VARCHAR(16) NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  interval VARCHAR(8) NOT NULL,
  observation_start_at TIMESTAMPTZ NOT NULL,
  observation_end_at TIMESTAMPTZ NOT NULL,
  resolved_price_cents TEXT NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL,
  source_data_sha256 CHAR(64) NOT NULL,
  canonical_evidence_json TEXT NOT NULL,
  settlement_tx_hash VARCHAR(66),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pool_address, round_id)
);


-- Canonical market outcome for a completed Binance market period.
-- Independent from participation and from contract SETTLED/CANCELLED state.
CREATE TABLE IF NOT EXISTS market_outcomes (
  asset VARCHAR(8) NOT NULL,
  cadence VARCHAR(16) NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  interval VARCHAR(8) NOT NULL,
  market_period_start_at TIMESTAMPTZ NOT NULL,
  market_period_end_at TIMESTAMPTZ NOT NULL,
  high_exact TEXT NOT NULL,
  high_price_cents NUMERIC(20,0) NOT NULL,
  high_candle_open_at TIMESTAMPTZ NOT NULL,
  low_exact TEXT NOT NULL,
  low_price_cents NUMERIC(20,0) NOT NULL,
  low_candle_open_at TIMESTAMPTZ NOT NULL,
  candle_count INTEGER NOT NULL,
  source VARCHAR(128) NOT NULL,
  endpoint TEXT NOT NULL,
  source_data_sha256 CHAR(64) NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL,
  canonical_evidence_json TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  PRIMARY KEY (asset, cadence, market_period_start_at, market_period_end_at)
);

CREATE INDEX IF NOT EXISTS market_outcomes_period_idx
  ON market_outcomes (market_period_end_at DESC, cadence, asset);


-- One immutable Binance daily Mark Price candle archive per asset and completed
-- UTC day. New rows use one 1d candle. Existing validated 1m/1440 rows remain
-- readable historical evidence. WEEKLY and QUARTERLY are DB-only derivations.
CREATE TABLE IF NOT EXISTS daily_market_archives (
  asset VARCHAR(8) NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  market_period_start_at TIMESTAMPTZ NOT NULL,
  market_period_end_at TIMESTAMPTZ NOT NULL,
  interval VARCHAR(8) NOT NULL DEFAULT '1d',
  candle_count INTEGER NOT NULL,
  candles_json TEXT NOT NULL,
  source VARCHAR(128) NOT NULL,
  endpoint TEXT NOT NULL,
  source_data_sha256 CHAR(64) NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asset, market_period_start_at, market_period_end_at)
);

CREATE INDEX IF NOT EXISTS daily_market_archives_period_idx
  ON daily_market_archives (market_period_end_at DESC, asset);


-- CREATE TABLE IF NOT EXISTS does not update defaults on an existing Railway
-- table, so make the new daily archive default explicit without rewriting rows.
ALTER TABLE daily_market_archives
  ALTER COLUMN interval SET DEFAULT '1d';
