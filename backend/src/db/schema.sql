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
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions(user_id);

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
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_authorizations_user_idx
  ON action_authorizations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS action_authorizations_token_idx
  ON action_authorizations(authorization_token_hash)
  WHERE authorization_token_hash IS NOT NULL;
