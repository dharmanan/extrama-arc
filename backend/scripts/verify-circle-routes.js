'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'src/routes/circle.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/circleUserWalletService.js'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'src/services/executionIdentityService.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const actions = fs.readFileSync(path.join(root, 'src/routes/actions.js'), 'utf8');
const entryService = fs.readFileSync(path.join(root, 'src/services/circleEntryExecutionService.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'src/services/circleExecutionEngine.js'), 'utf8');
const actionService = fs.readFileSync(path.join(root, 'src/services/circleActionExecutionService.js'), 'utf8');

assert.match(routes, /router\.post\('\/device-token\/social'/);
assert.match(routes, /router\.post\('\/device-token\/email'/);
assert.match(routes, /emailOtpLimiter/);
assert.match(routes, /circle_email_otp_cooldown/);
assert.match(routes, /router\.post\('\/wallet\/initialize'/);
assert.match(routes, /router\.post\('\/session'/);
assert.match(routes, /circleUserWalletService\.listArcEoa\(token\)/);
assert.match(routes, /executionMode: EXECUTION_MODES\.CIRCLE_USER_WALLET/);
assert.ok(!routes.includes('walletAddress: req.body'), 'Circle address must not come from browser input');
assert.match(service, /blockchains: \[ARC_TESTNET\], accountType: EOA/);
assert.match(service, /pickEoaForBlockchain\(wallets, ARC_TESTNET,/);
assert.match(service, /circle_arc_eoa_ambiguous/);
assert.match(service, /MAX_PAGES/);
assert.match(identity, /circle_wallet_session_mismatch/);
console.log('CIRCLE_ROUTES=PASS');

for (const error of [
  'circle_email_otp_send_limit',
  'circle_email_otp_attempt_limit',
  'circle_rate_limited',
  'circle_entry_authorization_invalid',
  'circle_transaction_failed',
  'circle_transaction_mismatch',
  'circle_transaction_listing_incomplete',
  'circle_transaction_ambiguous',
  'circle_request_invalid',
  'circle_response_invalid',
  'circle_entry_action_expired_after_approval',
  'circle_action_authorization_invalid',
  'circle_action_expired_after_approval',
  'circle_wallet_session_mismatch',
  'circle_wallet_session_required',
  'circle_request_id_conflict',
  'circle_service_not_configured',
]) assert.match(server, new RegExp(`'${error}'`));
assert.match(server, /internal_server_error/);
assert.match(server, /safeKnownErrors\.has\(error\.message\)/);
assert.match(server, /res\.status\(400\)\.json\(\{ error: error\.message \}\)/);
assert.match(server, /circle_transaction_failed/);
assert.match(server, /circle_rate_limited/);
assert.doesNotMatch(server, /res\.status\(500\)\.json\(\{ error: error\.message \}\)/);
assert.match(actions, /circleEntryExecutionService\.verifyCircleApproval/);
assert.match(actions, /circleEntryExecutionService\.verifyCircleEntry/);
// ENTRY and every other Circle action share one engine, so a failed,
// denied, cancelled, or expired Circle outcome is terminal for all of them.
assert.match(engine, /CIRCLE_TERMINAL_FAILURE_STATES = new Set\(\['FAILED', 'DENIED', 'CANCELLED'\]\)/);
assert.match(engine, /CIRCLE_TERMINAL_CHALLENGE_STATES = new Set\(\['FAILED', 'EXPIRED'\]\)/);
assert.match(engine, /throw new Error\('circle_transaction_failed'\)/);
assert.match(entryService, /require\('\.\/circleExecutionEngine'\)/);
assert.match(actionService, /require\('\.\/circleExecutionEngine'\)/);
assert.match(actions, /circleActionExecutionService\.verifyCircleAction\(/);
assert.match(actions, /circleActionExecutionService\.verifyCircleActionApproval\(/);
console.log('CIRCLE_HTTP_ERRORS=PASS');
