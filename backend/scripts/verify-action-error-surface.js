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

// Gateway SOURCE deposit (Base/OP/Arbitrum/Ethereum Sepolia) and its Circle
// companion-wallet preparation, added with the multichain generalization.
// Every one of these was reachable in production but absent from the
// allow-list, so any real failure on a non-Base source collapsed to a bare
// "internal_server_error" with no distinguishable code at all -- exactly the
// symptom production smoke found for OP Sepolia and Arbitrum Sepolia deposits.
assertPublic(
  [
    'gateway_wallet_session_required',
    'gateway_deposit_source_unsupported',
    'gateway_deposit_request_id_conflict',
    'gateway_deposit_action_not_found',
    'gateway_deposit_insufficient_usdc',
    'gateway_deposit_source_wallet_required',
    'gateway_deposit_source_wallet_mismatch',
    'gateway_deposit_source_review_required',
    'gateway_deposit_approval_failed',
    'gateway_deposit_approval_already_bound',
    'gateway_deposit_approval_transaction_not_found',
    'gateway_deposit_transaction_not_found',
    'gateway_deposit_already_bound',
    'gateway_deposit_failed',
    'gateway_deposit_txhash_invalid',
    'gateway_deposit_sender_mismatch',
    'gateway_deposit_target_mismatch',
    'gateway_deposit_value_mismatch',
    'gateway_deposit_calldata_mismatch',
    'gateway_deposit_chain_mismatch',
    'gateway_deposit_chain_unavailable',
    'gateway_source_wallet_invalid',
    'gateway_source_chain_id_mismatch',
    'gateway_source_rpc_unavailable',
    'circle_source_eoa_ambiguous',
    'circle_source_eoa_not_found',
    'circle_source_address_mismatch',
    'circle_source_arc_address_invalid',
    'circle_source_blockchain_unsupported',
  ],
  'gateway_deposit',
);

// Every error the deposit/source-chain/Circle-source-wallet services can
// actually throw is read directly from their own source text, so a new error
// code introduced later fails this test immediately instead of silently
// falling through to the generic 500 the way the codes above once did.
function collectThrownLiteralCodes(filePath) {
  const text = fs.readFileSync(path.resolve(__dirname, filePath), 'utf8');
  const direct = [...text.matchAll(/throw new Error\('([a-z_0-9]+)'\)/g)].map((m) => m[1]);
  // A few codes are passed as call-site string literals into a shared
  // throw-by-name helper (source.readTransaction(txHash, notFoundError,
  // failureError)) rather than thrown directly; catch those too.
  const viaHelper = [...text.matchAll(/readTransaction\(\s*\n?\s*txHash,\s*'([a-z_0-9]+)',\s*'([a-z_0-9]+)',/g)]
    .flatMap((m) => [m[1], m[2]]);
  return [...direct, ...viaHelper];
}

const depositPathErrorSources = [
  '../src/services/gatewayDepositService.js',
  '../src/services/gatewaySourceChainService.js',
  '../src/services/circleUserWalletService.js',
];
const genericAssertionExemptCodes = new Set([
  // Pre-existing generic codes these modules also throw, verified elsewhere
  // (Circle onboarding/action tests) and deliberately not part of the
  // gateway_deposit assertion above.
  'circle_request_invalid',
  'circle_response_invalid',
  'circle_service_not_configured',
  'circle_arc_eoa_not_found',
  'circle_challenge_mismatch',
  'circle_transaction_ambiguous',
  'circle_transaction_mismatch',
  'circle_wallet_listing_incomplete',
  'circle_arc_eoa_ambiguous',
  'circle_base_sepolia_eoa_ambiguous',
  'circle_base_sepolia_address_mismatch',
  'circle_base_sepolia_arc_address_invalid',
  'circle_base_sepolia_eoa_not_found',
  'gateway_request_id_invalid',
  'gateway_value_invalid',
]);
for (const file of depositPathErrorSources) {
  for (const code of collectThrownLiteralCodes(file)) {
    if (genericAssertionExemptCodes.has(code)) continue;
    assert.equal(
      publicCodes.has(code),
      true,
      `${file} can throw '${code}', which is not in server.js's safeKnownErrors -- ` +
      `it would collapse to a bare internal_server_error at the HTTP boundary`,
    );
  }
}
console.log('GATEWAY_DEPOSIT_ERRORS_SAFE_LISTED=PASS');

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
