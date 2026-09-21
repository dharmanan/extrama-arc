'use strict';

process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://readonly:readonly@127.0.0.1:1/readonly';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'x'.repeat(40);

const { ethers } = require('ethers');
const arcService = require('../src/services/arcService');
const marketplaceService = require('../src/services/marketplaceService');

const WALLET = '0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b';

const POOL_ABI = [
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
];

async function main() {
  const provider = arcService.getArcProvider();
  const latest = await provider.getBlock('latest');
  if (!latest) throw new Error('latest_block_unavailable');
  const now = BigInt(latest.timestamp);
  const owned = await arcService.readOwnedTickets(WALLET);
  const state = await arcService.readArcWalletState(WALLET);

  console.log('WALLET=' + WALLET);
  console.log('CHAIN_BLOCK=' + latest.number);
  console.log('USDC_RAW=' + state.usdc.balanceRaw);
  console.log('OWNED_TICKETS=' + owned.ticketCount);

  let tradableCount = 0;
  for (const ticket of owned.tickets) {
    let tradable = false;
    if (ticket.roundStatus === 'ENTRY_OPEN' || ticket.roundStatus === 'LOCKED') {
      const pool = new ethers.Contract(ticket.poolAddress, POOL_ABI, provider);
      const round = await pool.getRound(ticket.roundId);
      tradable =
        (Number(round.status) === 0 || Number(round.status) === 1) &&
        round.observationEndAt > 3600n &&
        now < round.observationEndAt - 3600n;
    }

    const active = await marketplaceService.readActiveListingForTicket({
      ticketAddress: ticket.ticketAddress,
      tokenId: ticket.tokenId,
    });

    if (tradable) tradableCount += 1;
    console.log('TICKET=' + JSON.stringify({
      slug: ticket.slug,
      roundId: ticket.roundId,
      tokenId: ticket.tokenId,
      roundStatus: ticket.roundStatus,
      predictionPrice: ticket.predictionPrice,
      isClaimed: ticket.isClaimed,
      isRefunded: ticket.isRefunded,
      ticketAddress: ticket.ticketAddress,
      poolAddress: ticket.poolAddress,
      tradable,
      activeListingId: active.activeListingId,
      activeAskUsdcRaw: active.askUsdcRaw,
    }));
  }

  console.log('TRADABLE_TICKETS=' + tradableCount);
  console.log('RESULT=' + (tradableCount ? 'HUMAN_SELLER_CANDIDATE_FOUND' : 'NO_HUMAN_SELLER_CANDIDATE'));
}

main().catch((error) => {
  console.error('HUMAN_WALLET_INVENTORY=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
