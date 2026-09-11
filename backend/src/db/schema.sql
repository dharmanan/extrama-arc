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
  circle_wallet_id UUID,
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

ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS circle_wallet_id UUID;

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

-- Circle-hosted entry execution is deliberately separate from the legacy
-- external-wallet state machine. These identifiers are durable evidence only;
-- Circle user tokens and browser encryption keys are never stored here.
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_wallet_id UUID;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_state VARCHAR(32);
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_request_id UUID;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_approval_challenge_id TEXT;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_approval_idempotency_key UUID;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_approval_ref_id TEXT;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_approval_transaction_id UUID;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_approval_tx_hash VARCHAR(66);
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_entry_challenge_id TEXT;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_entry_idempotency_key UUID;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_entry_ref_id TEXT;
ALTER TABLE action_authorizations
  ADD COLUMN IF NOT EXISTS circle_entry_transaction_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS action_authorizations_circle_entry_request_idx
  ON action_authorizations(user_id, action_type, circle_request_id)
  WHERE circle_request_id IS NOT NULL;

-- Gateway funding never stores a Circle user token or encryption key. It is a
-- durable record for one user-signed burn intent and its one-shot forwarding
-- lifecycle. The server-side broadcast gate is disabled by default; SUBMITTING
-- is persisted before any forwarding-service mutation so ambiguous outcomes
-- reconcile instead of silently retrying.
CREATE TABLE IF NOT EXISTS gateway_funding_actions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  circle_wallet_id UUID NOT NULL,
  wallet_address VARCHAR(42) NOT NULL,
  request_id UUID NOT NULL,
  source_domain INTEGER NOT NULL,
  value_raw TEXT NOT NULL,
  payload_hash CHAR(64),
  burn_intent_json JSONB,
  burn_intent_json_text TEXT,
  typed_data_json JSONB,
  max_fee_raw TEXT,
  max_block_height TEXT,
  estimate_fees_json JSONB,
  circle_sign_challenge_id TEXT,
  circle_sign_request_id UUID NOT NULL,
  signature TEXT,
  gateway_transfer_id UUID,
  gateway_transaction_hash VARCHAR(66),
  state VARCHAR(40) NOT NULL,
  last_error VARCHAR(80),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gateway_funding_actions_value_raw_check
    CHECK (value_raw ~ '^[1-9][0-9]*$'),
  CONSTRAINT gateway_funding_actions_state_check
    CHECK (state IN (
      'PREPARING', 'SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING',
      'READY_TO_BROADCAST', 'SUBMITTING', 'SUBMITTED', 'COMPLETED',
      'FAILED', 'RECONCILIATION_REQUIRED', 'SIGNATURE_FAILED', 'EXPIRED'
    )),
  UNIQUE (user_id, request_id)
);

-- The table was introduced during the preparation-only phase. Keep upgrades
-- safe for an installation that already ran that schema: the forwarding
-- columns and the expanded state set must exist before the service can resume
-- an operation after restart.
ALTER TABLE gateway_funding_actions
  ADD COLUMN IF NOT EXISTS burn_intent_json_text TEXT;
ALTER TABLE gateway_funding_actions
  ADD COLUMN IF NOT EXISTS gateway_transfer_id UUID;
ALTER TABLE gateway_funding_actions
  ADD COLUMN IF NOT EXISTS gateway_transaction_hash VARCHAR(66);
ALTER TABLE gateway_funding_actions
  DROP CONSTRAINT IF EXISTS gateway_funding_actions_state_check;
ALTER TABLE gateway_funding_actions
  ADD CONSTRAINT gateway_funding_actions_state_check
  CHECK (state IN (
    'PREPARING', 'SIGN_CHALLENGE_CREATING', 'SIGNATURE_PENDING',
    'READY_TO_BROADCAST', 'SUBMITTING', 'SUBMITTED', 'COMPLETED',
    'FAILED', 'RECONCILIATION_REQUIRED', 'SIGNATURE_FAILED', 'EXPIRED'
  ));

CREATE INDEX IF NOT EXISTS gateway_funding_actions_user_created_idx
  ON gateway_funding_actions(user_id, created_at DESC);

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

-- Durable seed-agent scheduler state. These rows contain public scheduling
-- metadata only; no private key material or signer secrets are stored here.
CREATE TABLE IF NOT EXISTS seed_bot_dispatches (
  plan_key TEXT PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seed_bot_dispatches_status_check
    CHECK (status IN ('IN_FLIGHT', 'COMPLETED'))
);

CREATE INDEX IF NOT EXISTS seed_bot_dispatches_status_idx
  ON seed_bot_dispatches (status, updated_at);

CREATE TABLE IF NOT EXISTS seed_bot_scheduler_state (
  singleton_id SMALLINT PRIMARY KEY DEFAULT 1,
  last_dispatch_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seed_bot_scheduler_state_singleton_check
    CHECK (singleton_id = 1)
);

INSERT INTO seed_bot_scheduler_state (singleton_id)
VALUES (1)
ON CONFLICT (singleton_id) DO NOTHING;

-- Immutable seed-agent plan for one wallet/pool/round. Once generated, the
-- prediction and scheduled execution time survive Railway deploys/restarts
-- instead of being recalculated from a later market reference.
CREATE TABLE IF NOT EXISTS seed_bot_plans (
  plan_key TEXT PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL,
  pool_address VARCHAR(42) NOT NULL,
  pool_slug VARCHAR(64) NOT NULL,
  round_id BIGINT NOT NULL,
  planner_version TEXT NOT NULL,
  prediction_price_cents NUMERIC(20,0) NOT NULL,
  planned_execution_at TIMESTAMPTZ NOT NULL,
  entry_close_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_address, pool_address, round_id)
);

CREATE INDEX IF NOT EXISTS seed_bot_plans_due_idx
  ON seed_bot_plans (planned_execution_at, entry_close_at);

-- Last successful public round archive response per `days` window. It lets
-- GET /rounds/archive answer immediately after a deploy or restart while a
-- fresh Arc read refreshes it in the background. It holds exactly the payload
-- that endpoint already returns publicly: no private or financial state. JSON
-- (not JSONB) keeps the response byte for byte, including key order.
CREATE TABLE IF NOT EXISTS round_archive_snapshots (
  days SMALLINT PRIMARY KEY,
  payload JSON NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT round_archive_snapshots_days_check
    CHECK (days BETWEEN 1 AND 90)
);
