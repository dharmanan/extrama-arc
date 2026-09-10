'use strict';

// Transaction free verification of the Circle execution mode support
// boundary. Under the final architecture CIRCLE_USER_WALLET supports the
// whole post entry lifecycle, exactly like EXTERNAL_WALLET: ENTRY, ticket
// transfer, refund, claim, and marketplace list, update price, cancel and
// buy. Every Circle operation must be wired through all five layers, or this
// check fails:
//
//   execution service   a Circle only build and verify pair (CIRCLE_MODES)
//   state machine       the action type and its phases in actionAuthorization
//   Circle adapter      an adapter in circleActionExecutionService
//   HTTP routes         start dispatches to Circle, verify dispatches to Circle
//   client              backend API route map and a confirmCircleAction call
//
// The behavioral proof of these paths lives in verify-circle-actions.js and
// verify-circle-action-behavior.js; this file guards the wiring so no layer
// can silently regress. It needs no database, RPC connection, or key.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

const OPERATIONS = [
  {
    action: 'TRANSFER_TICKET',
    route: 'ticket-transfer',
    service: 'src/services/ticketTransferExecutionService.js',
    functions: ['buildCircleTransferTransactionRequest', 'verifyCircleTransferReceipt'],
    phases: "['ACTION']",
  },
  {
    action: 'REFUND_TICKET',
    route: 'refund',
    service: 'src/services/refundExecutionService.js',
    functions: ['buildCircleRefundTransactionRequest', 'verifyCircleRefundReceipt'],
    phases: "['ACTION']",
  },
  {
    action: 'CLAIM_REWARD',
    route: 'claim',
    service: 'src/services/claimExecutionService.js',
    functions: ['buildCircleClaimTransactionRequest', 'verifyCircleClaimReceipt'],
    phases: "['ACTION']",
  },
  {
    action: 'MARKETPLACE_LIST',
    route: 'marketplace-list',
    service: 'src/services/marketplaceExecutionService.js',
    functions: [
      'prepareCircleListApproval', 'verifyCircleListApprovalReceipt',
      'buildCircleListTransactionRequest', 'verifyCircleListReceipt',
    ],
    phases: "['APPROVAL', 'ACTION']",
    approvalRoute: true,
  },
  {
    action: 'MARKETPLACE_UPDATE_PRICE',
    route: 'marketplace-update-price',
    service: 'src/services/marketplaceExecutionService.js',
    functions: ['buildCircleUpdatePriceTransactionRequest', 'verifyCircleUpdatePriceReceipt'],
    phases: "['ACTION']",
  },
  {
    action: 'MARKETPLACE_CANCEL',
    route: 'marketplace-cancel',
    service: 'src/services/marketplaceExecutionService.js',
    functions: ['buildCircleCancelTransactionRequest', 'verifyCircleCancelReceipt'],
    phases: "['ACTION']",
  },
  {
    action: 'MARKETPLACE_BUY',
    route: 'marketplace-buy',
    service: 'src/services/marketplaceExecutionService.js',
    functions: [
      'prepareCircleBuyApproval', 'verifyCircleBuyApprovalReceipt',
      'buildCircleBuyTransactionRequest', 'verifyCircleBuyReceipt',
    ],
    phases: "['APPROVAL', 'ACTION']",
    approvalRoute: true,
  },
];

function routeBlock(actions, route, suffix) {
  const marker = `router.post('/${route}/${suffix}'`;
  const start = actions.indexOf(marker);
  assert.ok(start >= 0, `missing route ${marker}`);
  const next = actions.indexOf('router.post(', start + marker.length);
  return actions.slice(start, next < 0 ? undefined : next);
}

function main() {
  const identity = read('src/services/executionIdentityService.js');
  assert.match(
    identity,
    /HUMAN_EXECUTION_MODES = new Set\(\[\s*EXECUTION_MODES\.EXTERNAL_WALLET,\s*EXECUTION_MODES\.CIRCLE_USER_WALLET,?\s*\]\)/,
    'exactly two human session modes: the connected wallet and the Circle wallet',
  );

  const entry = read('src/services/externalEntryExecutionService.js');
  assert.match(entry, /'CIRCLE_USER_WALLET'/, 'ENTRY must keep supporting CIRCLE_USER_WALLET');
  assert.match(entry, /payload\.action !== 'ENTRY'/, 'the entry service must only ever authorize ENTRY payloads');
  console.log('CIRCLE_SUPPORT_MATRIX[ENTRY]=SUPPORTED');

  const actionAuthorization = read('src/services/actionAuthorizationService.js');
  const adapters = read('src/services/circleActionExecutionService.js');
  const actions = read('src/routes/actions.js');
  const backendApi = read('../app/lib/backend-api.ts');
  const walletActions = read('../app/lib/wallet-actions.ts');

  for (const operation of OPERATIONS) {
    const service = read(operation.service);
    assert.match(service, /const CIRCLE_MODES = \['CIRCLE_USER_WALLET'\];/, `${operation.service}: Circle mode allow list`);
    for (const name of operation.functions) {
      assert.match(service, new RegExp(`async function ${name}\\(`), `${operation.action}: ${name} is implemented`);
      assert.match(service, new RegExp(`^\\s+${name},$`, 'm'), `${operation.action}: ${name} is exported`);
      assert.match(adapters, new RegExp(`\\.${name}\\(payload`), `${operation.action}: the Circle adapter calls ${name}`);
    }

    assert.match(
      actionAuthorization,
      new RegExp(`${operation.action}: ${operation.phases.replace(/[[\]]/g, '\\$&')},`),
      `${operation.action}: Circle phases`,
    );
    assert.match(
      actionAuthorization,
      new RegExp(`${operation.action}: \\(params\\) => canonical`),
      `${operation.action}: canonical Circle payload builder`,
    );
    assert.match(adapters, new RegExp(`^    ${operation.action}: \\{$`, 'm'), `${operation.action}: Circle adapter`);

    const start = routeBlock(actions, operation.route, 'start');
    assert.match(start, new RegExp(`startCircleFinancialAction\\(req, res, input, '${operation.action}'`),
      `${operation.route}/start dispatches Circle sessions to the Circle action`);
    assert.match(start, /requireCircleStartCredentials\(input, res\)/, `${operation.route}/start requires Circle credentials`);
    const verify = routeBlock(actions, operation.route, 'verify');
    assert.match(verify, new RegExp(`verifyCircleFinancialAction\\(req, res, '${operation.action}'\\)`),
      `${operation.route}/verify dispatches Circle sessions`);
    if (operation.approvalRoute) {
      const approval = routeBlock(actions, operation.route, 'approval/verify');
      assert.match(approval, new RegExp(`verifyCircleFinancialApproval\\(req, res, '${operation.action}'\\)`));
    }
    const finish = routeBlock(actions, operation.route, 'finish');
    assert.match(finish, /consumeExternalAuthorization\(req, actionId, '/, `${operation.route}/finish is connected wallet only`);

    assert.match(backendApi, new RegExp(`${operation.action}: "${operation.route}",`), `${operation.action}: client route map`);
    assert.match(walletActions, new RegExp(`confirmCircleAction\\(\\{\\s+actionType: "${operation.action}",`),
      `${operation.action}: client Circle runner`);

    console.log(`CIRCLE_SUPPORT_MATRIX[${operation.action}]=SUPPORTED`);
  }

  console.log('CIRCLE_SUPPORT_MATRIX=PASS');
}

main();
