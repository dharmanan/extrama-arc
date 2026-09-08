'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ZodError } = require('zod');

const config = require('./config');
const db = require('./db');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const roundRoutes = require('./routes/rounds');
const actionRoutes = require('./routes/actions');
const marketplaceRoutes = require('./routes/marketplace');
const circleRoutes = require('./routes/circle');
const arcService = require('./services/arcService');
const roundAutomationService = require('./services/roundAutomationService');
const settlementEvidenceService = require('./services/settlementEvidenceService');
const marketOutcomeService = require('./services/marketOutcomeService');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (config.corsOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (config.NODE_ENV !== 'production') {
      try {
        const host = new URL(origin).hostname;
        if (host.endsWith('.app.github.dev') || host === 'localhost' || host === '127.0.0.1') {
          return callback(null, true);
        }
      } catch {}
    }

    callback(new Error('cors_origin_not_allowed'));
  },
  credentials: false,
}));

app.use(express.json({ limit: '64kb' }));

app.get('/readyz', (req, res) => {
  res.json({ ok: true, service: 'extrema-backend' });
});

app.get('/health', async (req, res) => {
  try {
    await db.ping();
    res.json({ ok: true, database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/rounds', roundRoutes);
app.use('/api/actions', actionRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/circle', circleRoutes);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: 'invalid_request',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const safeKnownErrors = new Set([
    'webauthn_origin_not_allowed',
    'challenge_expired',
    'passkey_registration_failed',
    'passkey_not_registered',
    'passkey_not_found',
    'passkey_authentication_failed',
    'action_challenge_expired',
    'action_authorization_invalid',
    'entry_round_not_available',
    'entry_already_entered',
    'entry_price_taken',
    'entry_insufficient_usdc',
    'entry_insufficient_gas',
    'entry_wallet_mismatch',
    'entry_approval_failed',
    'entry_transaction_failed',
    'entry_event_missing',
    'entry_postcondition_failed',
    'entry_execution_mode_mismatch',
    'entry_txhash_invalid',
    'entry_approval_transaction_not_found',
    'entry_transaction_not_found',
    'entry_sender_mismatch',
    'entry_target_mismatch',
    'entry_value_mismatch',
    'entry_calldata_mismatch',
    'transfer_destination_same',
    'transfer_ticket_not_supported',
    'transfer_ticket_not_found',
    'transfer_not_ticket_owner',
    'transfer_insufficient_gas',
    'transfer_wallet_mismatch',
    'transfer_transaction_failed',
    'transfer_postcondition_failed',
    'transfer_execution_mode_mismatch',
    'transfer_txhash_invalid',
    'transfer_transaction_not_found',
    'transfer_sender_mismatch',
    'transfer_target_mismatch',
    'transfer_value_mismatch',
    'transfer_calldata_mismatch',
    'wallet_execution_mode_invalid',
    'wallet_execution_mode_mismatch',
    'external_wallet_session_required',
    'external_wallet_session_mismatch',
    'circle_wallet_not_configured',
    'system_seed_wallet_forbidden',
    'action_authorization_expired',
    'claim_request_invalid',
    'claim_ticket_not_supported',
    'claim_ticket_or_round_not_found',
    'claim_ticket_round_mismatch',
    'claim_ticket_status_mismatch',
    'claim_round_not_settled',
    'claim_already_claimed',
    'claim_nothing_to_claim',
    'claim_owner_mismatch',
    'claim_amount_mismatch',
    'claim_execution_mode_mismatch',
    'claim_wallet_mismatch',
    'claim_insufficient_gas',
    'claim_transaction_failed',
    'claim_txhash_invalid',
    'claim_transaction_not_found',
    'claim_sender_mismatch',
    'claim_target_mismatch',
    'claim_value_mismatch',
    'claim_calldata_mismatch',
    'refund_request_invalid',
    'refund_ticket_not_supported',
    'refund_ticket_or_round_not_found',
    'refund_ticket_round_mismatch',
    'refund_ticket_status_mismatch',
    'refund_round_not_cancelled',
    'refund_already_refunded',
    'refund_owner_mismatch',
    'refund_amount_mismatch',
    'refund_execution_mode_mismatch',
    'refund_wallet_mismatch',
    'refund_insufficient_gas',
    'refund_transaction_failed',
    'refund_txhash_invalid',
    'refund_transaction_not_found',
    'refund_sender_mismatch',
    'refund_target_mismatch',
    'refund_value_mismatch',
    'refund_calldata_mismatch',
    'marketplace_execution_mode_mismatch',
    'marketplace_contract_mismatch',
    'marketplace_wallet_mismatch',
    'marketplace_unsupported_ticket',
    'marketplace_ticket_not_found',
    'marketplace_round_not_tradable',
    'marketplace_trading_window_closed',
    'marketplace_not_ticket_owner',
    'marketplace_insufficient_gas',
    'marketplace_approval_failed',
    'marketplace_transaction_failed',
    'marketplace_listed_event_missing',
    'marketplace_token_not_approved',
    'marketplace_txhash_invalid',
    'marketplace_transaction_not_found',
    'marketplace_sender_mismatch',
    'marketplace_target_mismatch',
    'marketplace_calldata_mismatch',
    'marketplace_listing_not_active',
    'marketplace_not_listing_seller',
    'marketplace_seller_no_longer_owner',
    'marketplace_price_updated_event_missing',
    'marketplace_cancelled_event_missing',
    'marketplace_buyer_is_seller',
    'marketplace_listing_not_buyable',
    'marketplace_price_changed',
    'marketplace_insufficient_usdc',
    'marketplace_usdc_allowance_insufficient',
    'marketplace_sold_event_missing',
    'marketplace_invalid_request',
    'marketplace_invalid_ask_price',
    'marketplace_already_listed',
    'marketplace_listing_not_found',
    'marketplace_usdc_transfer_failed',
    'marketplace_nft_transfer_failed',
  ]);

  if (safeKnownErrors.has(error.message)) {
    return res.status(400).json({ error: error.message });
  }

  console.error('[api]', error);
  res.status(500).json({ error: 'internal_server_error' });
});

const server = app.listen(config.PORT, () => {
  console.log(`[extrema-backend] listening on :${config.PORT}`);
  arcService.warmStandardRoundsCache();
  roundAutomationService.startRoundAutomation();

  // PHASE A readiness check only: confirms Railway PostgreSQL actually
  // exposes the settlement_evidence relation and its critical columns
  // after migrate.js has run. Read-only, never creates or alters schema.
  // Deliberately non-blocking and non-fatal -- this table is not yet
  // load-bearing for any live path (settlement still runs entirely
  // in-memory, see roundAutomationService), so a failure here must not
  // affect auth/wallet/entry/claim/refund or any other already-proven
  // functionality. It exists purely to surface schema drift loudly in
  // logs before Phase B ever makes this table load-bearing.
  marketOutcomeService
    .verifyMarketOutcomeStorage()
    .then(() => console.log('[market-outcome] storage verified'))
    .catch((error) => {
      console.error('[market-outcome] storage check failed', JSON.stringify({ reason: error.message }));
    });

  settlementEvidenceService
    .verifySettlementEvidenceStorage()
    .then((result) => {
      if (!result.primaryKeyMatches) {
        console.warn(
          '[settlement-evidence] storage verified, but primary key is unexpected',
          JSON.stringify({ primaryKeyColumns: result.primaryKeyColumns }),
        );
        return;
      }
      console.log('[settlement-evidence] storage verified');
    })
    .catch((error) => {
      console.error(
        '[settlement-evidence] storage check failed',
        JSON.stringify({ reason: error.message, detail: error.detail }),
      );
    });
});

async function shutdown(signal) {
  console.log(`[extrema-backend] ${signal}, shutting down`);
  roundAutomationService.stopRoundAutomation();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
