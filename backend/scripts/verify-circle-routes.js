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
const config = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
const proxy = fs.readFileSync(path.join(root, '../app/api/extrema/[...path]/route.ts'), 'utf8');
const browserApi = fs.readFileSync(path.join(root, '../app/lib/backend-api.ts'), 'utf8');
const onboarding = fs.readFileSync(path.join(root, '../app/circle-wallet-onboarding.tsx'), 'utf8');
const circleAuth = fs.readFileSync(path.join(root, '../app/lib/circle-auth.ts'), 'utf8');
const sessionService = fs.readFileSync(path.join(root, 'src/services/sessionService.js'), 'utf8');
const authRoutes = fs.readFileSync(path.join(root, 'src/routes/auth.js'), 'utf8');
const circleActions = fs.readFileSync(path.join(root, '../app/lib/circle-actions.ts'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');

assert.match(routes, /router\.post\('\/device-token\/social'/);
assert.match(routes, /router\.post\('\/device-token\/email'/);
assert.match(routes, /emailOtpLimiter/);
assert.match(routes, /circle_email_otp_cooldown/);
assert.match(routes, /router\.post\('\/wallet\/initialize'/);
assert.match(routes, /router\.post\('\/session'/);
assert.match(routes, /router\.post\('\/session\/refresh', walletLimiter, requireAuth/);
assert.match(routes, /circleUserWalletService\.listArcEoa\(token\)/);
assert.match(routes, /executionMode: EXECUTION_MODES\.CIRCLE_USER_WALLET/);
assert.match(routes, /circle_refresh_credentials/);
assert.match(routes, /encrypt\(input\.refreshToken\)/);
assert.match(routes, /decrypt\(stored\.rows\[0\]\.refresh_token_encrypted\)/);
assert.match(routes, /circleUserWalletService\.refreshUserToken/);
assert.match(routes, /circle_session_identity_mismatch/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS circle_refresh_credentials/);
assert.match(schema, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
assert.match(schema, /PRIMARY KEY \(user_id, circle_wallet_id\)/);
assert.match(service, /getClient\(\)\.refreshUserToken\(/);
assert.match(service, /idempotencyKey: crypto\.randomUUID\(\)/);
assert.match(config, /JWT_TTL_SECONDS: z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.default\(604800\)/);
assert.match(proxy, /const SESSION_MAX_AGE = 7 \* 24 \* 60 \* 60/);
assert.match(proxy, /preferredRegion = "hkg1"/);
assert.match(sessionService, /new Date\(Date\.now\(\) \+ config\.JWT_TTL_SECONDS \* 1000\)/);
assert.match(sessionService, /expiresIn: config\.JWT_TTL_SECONDS/);
assert.match(sessionService, /revoked_at IS NULL/);
assert.match(authRoutes, /sessionService\.revokeSession\(req\.auth\.jti\)/);
assert.match(authRoutes, /DELETE FROM circle_refresh_credentials/);
assert.ok(
  authRoutes.indexOf('sessionService.revokeSession(req.auth.jti)') < authRoutes.indexOf('DELETE FROM circle_refresh_credentials'),
  'logout must revoke the application session before deleting the Circle refresh credential',
);
assert.ok(!sessionService.includes('refreshToken'), 'Circle refresh credentials must not enter the EXTREMA JWT/session payload');
assert.match(browserApi, /refreshSession\(deviceId: string\)/);
assert.match(onboarding, /refreshToken\?: string/);
assert.match(onboarding, /auth\.refreshToken \? \{ refreshToken: auth\.refreshToken, deviceId \} : undefined/);
assert.ok(!onboarding.includes('storeCircleTabAuth(auth)'), 'a Circle refresh token must never be written to browser tab storage');
assert.match(circleAuth, /type CircleTabAuth = \{\s+userToken: string;\s+encryptionKey: string;/);
assert.ok(!browserApi.includes('CIRCLE_API_KEY'), 'the Circle API key must never enter browser code');
const refreshRoute = routes.slice(routes.indexOf("router.post('/session/refresh'"), routes.indexOf('\nmodule.exports = router;'));
assert.ok(!/console\.|logger\.|refreshToken[^\n]{0,80}(?:console|logger)/.test(refreshRoute), 'refresh credentials must not be logged');
assert.ok(!refreshRoute.slice(refreshRoute.indexOf('res.json(')).includes('refreshToken'), 'refresh responses must not return the refresh token');
assert.match(circleActions, /getCircleDeviceId\(\)/);
const sessionRefreshHelper = circleActions.slice(
  circleActions.indexOf('async function restoreExtremaCircleSession'),
  circleActions.indexOf('async function withFreshExtremaCircleSession'),
);
assert.ok(!sessionRefreshHelper.includes('executeHostedChallenge'), 'session refresh must not start a Circle challenge');
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
  'circle_reauthentication_required',
  'circle_session_identity_mismatch',
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
