'use strict';

const assert = require('node:assert/strict');
const { sendOnceWithReconciliation } = require('../src/services/transactionReconciliation');

(async () => {
  let sends = 0;

  const confirmed = await sendOnceWithReconciliation({
    label: 'confirmed',
    send: async () => {
      sends += 1;
      return {
        hash: '0xconfirmed',
        wait: async () => ({ status: 1 }),
      };
    },
    hasLanded: async () => false,
  });

  assert.deepEqual(confirmed, {
    txHash: '0xconfirmed',
    reconciled: false,
  });
  assert.equal(sends, 1);

  const reconciled = await sendOnceWithReconciliation({
    label: 'uncertain',
    send: async () => {
      sends += 1;
      throw new Error('transport_unknown');
    },
    hasLanded: async () => true,
  });

  assert.deepEqual(reconciled, {
    txHash: null,
    reconciled: true,
  });
  assert.equal(sends, 2);

  await assert.rejects(
    sendOnceWithReconciliation({
      label: 'failed',
      send: async () => {
        sends += 1;
        throw new Error('send_failed');
      },
      hasLanded: async () => false,
    }),
    /send_failed/,
  );
  assert.equal(sends, 3);

  await assert.rejects(
    sendOnceWithReconciliation({
      label: 'badreceipt',
      send: async () => {
        sends += 1;
        return {
          hash: '0xbad',
          wait: async () => ({ status: 0 }),
        };
      },
      hasLanded: async () => false,
    }),
    /badreceipt_transaction_failed/,
  );
  assert.equal(sends, 4);

  console.log('TRANSACTION_RECONCILIATION=PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
