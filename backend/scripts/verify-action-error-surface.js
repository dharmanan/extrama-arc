'use strict';

// Static, transaction-free verification of the public action-error surface.
// The backend error boundary owns the allow-list; this script reads that list
// directly so the check cannot drift into a second runtime classification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.resolve(__dirname, '../src/server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const match = source.match(
  /const safeKnownErrors = new Set\(\[([\s\S]*?)\]\);/,
);

assert.ok(match, 'safeKnownErrors allow-list not found in server.js');

const publicCodes = new Set(
  [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]),
);

function assertPublic(codes, label) {
  for (const code of codes) {
    assert.equal(
      publicCodes.has(code),
      true,
      `${label} code is not public/safe: ${code}`,
    );
  }
}

function assertGeneric(codes, label) {
  for (const code of codes) {
    assert.equal(
      publicCodes.has(code),
      false,
      `${label} code must remain generic: ${code}`,
    );
  }
}

assertPublic(
  [
    'entry_round_not_available',
    'entry_already_entered',
    'entry_price_taken',
    'entry_insufficient_usdc',
    'entry_insufficient_gas',
    'entry_postcondition_failed',
  ],
  'entry',
);

assertPublic(
  [
    'transfer_destination_same',
    'transfer_not_ticket_owner',
    'transfer_insufficient_gas',
    'transfer_transaction_failed',
    'transfer_postcondition_failed',
  ],
  'transfer',
);

assertPublic(
  [
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
  ],
  'claim',
);

assertPublic(
  [
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
  ],
  'refund',
);

assertPublic(
  [
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
  ],
  'marketplace',
);

assertGeneric(
  [
    'arc_chain_id_mismatch',
    'Stored wallet integrity check failed',
    'database_error',
    'raw_rpc_error',
    'claim_ticket_claimed_state_mismatch',
    'claim_pool_usdc_mismatch',
    'claim_signer_mismatch',
    'claim_postcondition_failed',
    'refund_pool_usdc_mismatch',
    'refund_stake_amount_mismatch',
    'refund_signer_mismatch',
    'refund_postcondition_failed',
    'private_key_decryption_failed',
    'unknown_exception',
  ],
  'internal/infrastructure',
);

assertGeneric(['an_unrecognized_error'], 'unknown');
assert.match(source, /safeKnownErrors\.has\(error\.message\)/);

console.log('action-error-surface: PASS');
