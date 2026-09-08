'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'src/routes/circle.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/circleUserWalletService.js'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'src/services/executionIdentityService.js'), 'utf8');

assert.match(routes, /router\.post\('\/device-token\/social'/);
assert.match(routes, /router\.post\('\/device-token\/email'/);
assert.match(routes, /router\.post\('\/wallet\/initialize'/);
assert.match(routes, /router\.post\('\/session'/);
assert.match(routes, /circleUserWalletService\.listArcEoa\(token\)/);
assert.match(routes, /executionMode: EXECUTION_MODES\.CIRCLE_USER_WALLET/);
assert.ok(!routes.includes('walletAddress: req.body'), 'Circle address must not come from browser input');
assert.match(service, /blockchains: \[ARC_TESTNET\], accountType: EOA/);
assert.match(service, /blockchain: ARC_TESTNET/);
assert.match(service, /circle_arc_eoa_ambiguous/);
assert.match(service, /MAX_PAGES/);
assert.match(identity, /circle_wallet_session_mismatch/);
console.log('CIRCLE_ROUTES=PASS');
