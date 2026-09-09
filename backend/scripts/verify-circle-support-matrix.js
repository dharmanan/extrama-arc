'use strict';

// Static, transaction-free verification of the Circle execution-mode support
// boundary. CIRCLE_USER_WALLET is a legitimate session mode (it authenticates
// real users), but only ENTRY execution actually supports it today. Every
// other action's execution service must keep CIRCLE_USER_WALLET out of its
// own allow-list, so that boundary can never silently regress. This never
// requires a database, an RPC connection, or a key -- every check here reads
// source text directly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function main() {
  const identity = read('src/services/executionIdentityService.js');
  assert.match(
    identity,
    /HUMAN_EXECUTION_MODES = new Set\(\[\s*EXECUTION_MODES\.BACKEND_WALLET,\s*EXECUTION_MODES\.EXTERNAL_WALLET,\s*EXECUTION_MODES\.CIRCLE_USER_WALLET,?\s*\]\)/,
    'CIRCLE_USER_WALLET must remain a recognised human session mode at the identity layer',
  );

  const entry = read('src/services/externalEntryExecutionService.js');
  assert.match(entry, /'CIRCLE_USER_WALLET'/, 'ENTRY must keep supporting CIRCLE_USER_WALLET');
  assert.match(entry, /payload\.action !== 'ENTRY'/, 'the entry service must only ever authorize ENTRY payloads');

  const unsupportedServices = [
    { file: 'src/services/ticketTransferExecutionService.js', action: 'TRANSFER_TICKET' },
    { file: 'src/services/refundExecutionService.js', action: 'REFUND_TICKET' },
    { file: 'src/services/claimExecutionService.js', action: 'CLAIM_REWARD' },
    { file: 'src/services/marketplaceExecutionService.js', action: 'MARKETPLACE_LIST / UPDATE_PRICE / CANCEL / BUY' },
  ];

  for (const { file, action } of unsupportedServices) {
    const source = read(file);
    assert.ok(
      !/CIRCLE_USER_WALLET/.test(source),
      `${file}: ${action} must not list CIRCLE_USER_WALLET as a supported execution mode (UNSUPPORTED_BY_DESIGN)`,
    );
    console.log(`CIRCLE_SUPPORT_MATRIX[${action}]=UNSUPPORTED_BY_DESIGN (${file})`);
  }

  console.log('CIRCLE_SUPPORT_MATRIX[ENTRY]=SUPPORTED');
  console.log('CIRCLE_SUPPORT_MATRIX=PASS');
}

main();
