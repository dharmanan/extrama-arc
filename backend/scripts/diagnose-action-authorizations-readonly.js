'use strict';

/**
 * EXTREMA historical DB diagnostic.
 *
 * READ-ONLY by construction:
 * - PostgreSQL transaction is READ ONLY.
 * - This file contains no INSERT / UPDATE / DELETE / TRUNCATE / DDL.
 * - Raw payload_json is never printed.
 * - No user_id, session jti, passkey data, authorization hashes,
 *   Circle internal IDs, idempotency keys or encrypted private keys are printed.
 *
 * Run in Railway:
 *   node backend/scripts/diagnose-action-authorizations-readonly.js
 */

const { Client } = require('pg');

const LIFECYCLE_ACTIONS = [
  'ENTRY',
  'TRANSFER_TICKET',
  'MARKETPLACE_LIST',
  'MARKETPLACE_UPDATE_PRICE',
  'MARKETPLACE_CANCEL',
  'MARKETPLACE_BUY',
  'REFUND_TICKET',
  'CLAIM_REWARD',
];

const EXPECTED_DB_TABLES = [
  'action_authorizations',
  'auth_sessions',
  'extrema_wallets',
  'settlement_evidence',
  'market_outcomes',
  'daily_market_archives',
];

const STORAGE_CLASSIFICATION = [
  {
    state: 'action authorization / execution evidence',
    classification: 'DB_PERSISTED',
    source: 'action_authorizations',
  },
  {
    state: 'session execution identity',
    classification: 'DB_PERSISTED',
    source: 'auth_sessions',
  },
  {
    state: 'legacy backend wallet public address',
    classification: 'DB_PERSISTED',
    source: 'extrema_wallets',
  },
  {
    state: 'settlement evidence',
    classification: 'DB_PERSISTED',
    source: 'settlement_evidence',
  },
  {
    state: 'canonical market outcomes',
    classification: 'DB_PERSISTED',
    source: 'market_outcomes',
  },
  {
    state: 'immutable daily market archive',
    classification: 'DB_PERSISTED',
    source: 'daily_market_archives',
  },
  {
    state: 'marketplace listing canonical state',
    classification: 'ONCHAIN_ONLY',
    source: 'ExtremaMarketplace',
  },
  {
    state: 'round / entry / ticket ownership / payout state',
    classification: 'ONCHAIN_ONLY',
    source: 'ExtremaPool + ExtremaTicket',
  },
  {
    state: 'marketplace listings cache',
    classification: 'DERIVED_READ_MODEL',
    source: 'backend in-memory cache',
  },
];

function printRows(label, rows) {
  console.log(`\n=== ${label} (${rows.length} rows) ===`);
  if (rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  console.table(rows);
}

async function tableExists(client, tableName) {
  const { rows } = await client.query(
    'SELECT to_regclass($1) AS relation',
    [`public.${tableName}`],
  );
  return Boolean(rows[0]?.relation);
}

async function queryIfTableExists(client, tableName, label, sql, params = []) {
  if (!(await tableExists(client, tableName))) {
    console.log(`\n=== ${label} ===`);
    console.log(`SKIPPED: public.${tableName} does not exist`);
    return [];
  }

  const { rows } = await client.query(sql, params);
  printRows(label, rows);
  return rows;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const client = new Client({
    connectionString,
    ssl:
      process.env.PGSSLMODE === 'disable'
        ? undefined
        : process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : undefined,
  });

  await client.connect();

  let transactionOpen = false;

  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    transactionOpen = true;

    await client.query("SET LOCAL statement_timeout = '15000ms'");

    console.log('EXTREMA_HISTORICAL_DB_DIAGNOSTIC');
    console.log('MODE=READ_ONLY');
    console.log(`DATABASE_TABLE_SCOPE=${EXPECTED_DB_TABLES.join(',')}`);

    printRows('0. storage classification', STORAGE_CLASSIFICATION);

    const { rows: tableRows } = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [EXPECTED_DB_TABLES],
    );

    const present = new Set(tableRows.map((row) => row.table_name));

    printRows(
      '1. expected DB table presence',
      EXPECTED_DB_TABLES.map((tableName) => ({
        table_name: tableName,
        exists: present.has(tableName),
      })),
    );

    await queryIfTableExists(
      client,
      'action_authorizations',
      '2. action counts by type + execution mode',
      `SELECT
         action_type,
         COALESCE(payload_json->>'executionMode', 'UNKNOWN') AS execution_mode,
         COUNT(*)::int AS total_rows,
         COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified_rows,
         COUNT(*) FILTER (WHERE verified_tx_hash IS NOT NULL)::int AS tx_hash_rows,
         COUNT(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed_rows,
         MIN(created_at) AS earliest_created_at,
         MAX(created_at) AS latest_created_at
       FROM action_authorizations
       WHERE action_type = ANY($1::text[])
       GROUP BY
         action_type,
         COALESCE(payload_json->>'executionMode', 'UNKNOWN')
       ORDER BY action_type, execution_mode`,
      [LIFECYCLE_ACTIONS],
    );

    await queryIfTableExists(
      client,
      'action_authorizations',
      '3. recent historical lifecycle actions',
      `WITH ranked AS (
         SELECT
           action_type,
           COALESCE(payload_json->>'executionMode', 'UNKNOWN') AS execution_mode,

           CASE
             WHEN action_type IN ('ENTRY', 'REFUND_TICKET', 'CLAIM_REWARD')
             THEN COALESCE(
               payload_json->>'poolAddress',
               payload_json->>'contract'
             )
             ELSE payload_json->>'poolAddress'
           END AS pool_address,

           payload_json->>'contract' AS contract_address,
           payload_json->>'ticketAddress' AS ticket_address,
           payload_json->>'tokenId' AS token_id,
           payload_json->>'roundId' AS round_id,
           payload_json->>'listingId' AS listing_id,
           payload_json->>'walletAddress' AS wallet_address,

           COALESCE(
             payload_json->>'currentOwner',
             payload_json->>'sellerAddress',
             payload_json->>'destination'
           ) AS counterparty_address,

           verified_tx_hash AS tx_hash,
           circle_approval_tx_hash AS circle_approval_tx_hash,

           CASE
             WHEN circle_state IS NOT NULL THEN circle_state
             WHEN external_state IS NOT NULL THEN external_state
             WHEN verified_tx_hash IS NOT NULL THEN 'VERIFIED_TX'
             WHEN consumed_at IS NOT NULL THEN 'CONSUMED'
             WHEN verified_at IS NOT NULL THEN 'VERIFIED'
             ELSE 'CREATED'
           END AS status,

           verified_at,
           consumed_at,
           expires_at,
           created_at,

           ROW_NUMBER() OVER (
             PARTITION BY action_type
             ORDER BY created_at DESC
           ) AS rn
         FROM action_authorizations
         WHERE action_type = ANY($1::text[])
       )
       SELECT
         action_type,
         execution_mode,
         pool_address,
         contract_address,
         ticket_address,
         token_id,
         round_id,
         listing_id,
         wallet_address,
         counterparty_address,
         tx_hash,
         circle_approval_tx_hash,
         status,
         verified_at,
         consumed_at,
         expires_at,
         created_at
       FROM ranked
       WHERE rn <= 10
       ORDER BY action_type, created_at DESC`,
      [LIFECYCLE_ACTIONS],
    );

    await queryIfTableExists(
      client,
      'settlement_evidence',
      '4. recent persisted settlement evidence',
      `SELECT
         pool_address,
         round_id,
         slug,
         asset,
         direction,
         cadence,
         symbol,
         interval,
         observation_start_at,
         observation_end_at,
         resolved_price_cents,
         evidence_sha256,
         source_data_sha256,
         settlement_tx_hash,
         created_at
       FROM settlement_evidence
       ORDER BY created_at DESC
       LIMIT 30`,
    );

    await queryIfTableExists(
      client,
      'market_outcomes',
      '5. recent canonical market outcomes',
      `SELECT
         asset,
         cadence,
         symbol,
         interval,
         market_period_start_at,
         market_period_end_at,
         high_price_cents,
         low_price_cents,
         high_candle_open_at,
         low_candle_open_at,
         candle_count,
         source_data_sha256,
         evidence_sha256,
         computed_at,
         published_at
       FROM market_outcomes
       ORDER BY market_period_end_at DESC, asset, cadence
       LIMIT 40`,
    );

    await queryIfTableExists(
      client,
      'daily_market_archives',
      '6. recent immutable daily market archives',
      `SELECT
         asset,
         symbol,
         market_period_start_at,
         market_period_end_at,
         interval,
         candle_count,
         source,
         source_data_sha256,
         fetched_at
       FROM daily_market_archives
       ORDER BY market_period_end_at DESC, asset
       LIMIT 40`,
    );

    await queryIfTableExists(
      client,
      'auth_sessions',
      '7. recent public execution identities',
      `SELECT
         execution_mode,
         owner_address,
         wallet_address,
         expires_at,
         revoked_at,
         created_at
       FROM auth_sessions
       ORDER BY created_at DESC
       LIMIT 20`,
    );

    await queryIfTableExists(
      client,
      'extrema_wallets',
      '8. legacy backend wallet public addresses',
      `SELECT
         wallet_address,
         created_at
       FROM extrema_wallets
       ORDER BY created_at DESC
       LIMIT 20`,
    );

    console.log('\nEXTREMA_HISTORICAL_DB_DIAGNOSTIC=PASS');
  } finally {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => {});
    }
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    'EXTREMA_HISTORICAL_DB_DIAGNOSTIC=FAIL',
    error?.message || error,
  );
  process.exitCode = 1;
});
