'use strict';

// Read-only operator diagnostic.
// Enumerates every ticket currently owned by the nine approved seed wallets
// and reports cancelled-round refunds that are still outstanding.
// No signer, encrypted key, database write, transaction signing or broadcast.

process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://readonly:readonly@127.0.0.1:1/readonly';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'x'.repeat(40);

const { readOwnedTickets } = require('../src/services/arcService');

const SEEDS = Object.freeze([
  ['SEED_1', '0x995f659CD0AEd5ac3ac9D238cCeC74AdD5347A97'],
  ['SEED_2', '0x8b309436e4205462328e405F33564dA9DA6cCa38'],
  ['SEED_3', '0x7ccafd323A53179863D1839ef97Ee39B6BBCb6e7'],
  ['SEED_4', '0x4834374779CFEDC8d7BC82dCF64eF9c37397D37F'],
  ['SEED_5', '0xC10d0a64F879b8aBC65bB706Db04428d80Ec2113'],
  ['SEED_6', '0x71162d671d51D03Cc006be6Cbe0517Ca7f86461e'],
  ['SEED_7', '0x112c289ABb742eE3758Db71DB7ADB97ebde48804'],
  ['SEED_8', '0xCea4e9785600DEDEF39BE5bb71531C9De4c97C67'],
  ['SEED_9', '0x146B9657A72faeadc803E258ebeded34Cc91593D'],
]);

async function main() {
  const allCancelled = [];
  const outstanding = [];
  const blocks = [];

  for (const [seed, address] of SEEDS) {
    const state = await readOwnedTickets(address);
    blocks.push(state.chain.blockNumber);

    const cancelled = state.tickets
      .filter((ticket) => ticket.roundStatus === 'CANCELLED')
      .map((ticket) => ({
        seed,
        owner: address,
        slug: ticket.slug,
        roundId: ticket.roundId,
        tokenId: ticket.tokenId,
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        isRefunded: ticket.isRefunded,
      }));

    allCancelled.push(...cancelled);
    outstanding.push(...cancelled.filter((ticket) => !ticket.isRefunded));

    console.log(
      'SEED_SCAN=' +
        JSON.stringify({
          seed,
          address,
          blockNumber: state.chain.blockNumber,
          ownedTickets: state.ticketCount,
          cancelledTickets: cancelled.length,
          refundableTickets: cancelled.filter((ticket) => !ticket.isRefunded).length,
        }),
    );
  }

  allCancelled.sort((a, b) =>
    a.slug.localeCompare(b.slug) ||
    a.roundId - b.roundId ||
    Number(a.tokenId) - Number(b.tokenId) ||
    a.seed.localeCompare(b.seed),
  );
  outstanding.sort((a, b) =>
    a.slug.localeCompare(b.slug) ||
    a.roundId - b.roundId ||
    Number(a.tokenId) - Number(b.tokenId) ||
    a.seed.localeCompare(b.seed),
  );

  console.log('CHAIN_BLOCK_MIN=' + Math.min(...blocks));
  console.log('CHAIN_BLOCK_MAX=' + Math.max(...blocks));
  console.log('CANCELLED_SEED_TICKETS=' + allCancelled.length);
  console.log('OUTSTANDING_REFUNDS=' + outstanding.length);
  console.log('EXPECTED_REFUND_USDC=' + outstanding.length.toFixed(6));

  for (const ticket of outstanding) {
    console.log('REFUNDABLE=' + JSON.stringify(ticket));
  }

  console.log(
    'RESULT=' +
      (outstanding.length === 0
        ? 'NO_OUTSTANDING_SEED_REFUNDS'
        : 'OUTSTANDING_SEED_REFUNDS_FOUND'),
  );
}

main().catch((error) => {
  console.error('REFUND_INVENTORY=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
