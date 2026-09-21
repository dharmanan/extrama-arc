'use strict';

// Read-only marketplace proof candidate inventory.
// Finds seed-owned tickets that are currently tradable under the deployed
// marketplace rules and are not already listed. No signer, DB write or tx.

process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||= 'postgresql://readonly:readonly@127.0.0.1:1/readonly';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'x'.repeat(40);

const { ethers } = require('ethers');
const arcService = require('../src/services/arcService');
const marketplaceService = require('../src/services/marketplaceService');

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

const POOL_ABI = [
  'function getRound(uint256 roundId) view returns (tuple(uint64 entryOpenAt,uint64 entryCloseAt,uint64 observationStartAt,uint64 observationEndAt,uint8 status,uint64 entryCount,uint64 nextEntrySequence,uint256 totalStake,uint256 escrowRemaining,uint64 resolvedPriceCents,uint256[3] winnerTicketIds))',
];

async function main() {
  const provider = arcService.getArcProvider();
  const latest = await provider.getBlock('latest');
  if (!latest) throw new Error('latest_block_unavailable');
  const now = BigInt(latest.timestamp);

  const candidates = [];
  for (const [seed, address] of SEEDS) {
    const owned = await arcService.readOwnedTickets(address);
    for (const ticket of owned.tickets) {
      if (ticket.roundStatus !== 'ENTRY_OPEN' && ticket.roundStatus !== 'LOCKED') continue;

      const pool = new ethers.Contract(ticket.poolAddress, POOL_ABI, provider);
      const round = await pool.getRound(ticket.roundId);
      const tradable =
        (Number(round.status) === 0 || Number(round.status) === 1) &&
        round.observationEndAt > 3600n &&
        now < round.observationEndAt - 3600n;
      if (!tradable) continue;

      const active = await marketplaceService.readActiveListingForTicket({
        ticketAddress: ticket.ticketAddress,
        tokenId: ticket.tokenId,
      });
      if (active.activeListingId) continue;

      candidates.push({
        seed,
        owner: address,
        slug: ticket.slug,
        roundId: ticket.roundId,
        tokenId: ticket.tokenId,
        roundStatus: ticket.roundStatus,
        predictionPrice: ticket.predictionPrice,
        poolAddress: ticket.poolAddress,
        ticketAddress: ticket.ticketAddress,
        observationEndAt: Number(round.observationEndAt),
        secondsUntilTradingCutoff: Number(round.observationEndAt - 3600n - now),
      });
    }
  }

  candidates.sort((a, b) =>
    b.secondsUntilTradingCutoff - a.secondsUntilTradingCutoff ||
    a.slug.localeCompare(b.slug) ||
    Number(a.tokenId) - Number(b.tokenId)
  );

  console.log('CHAIN_BLOCK=' + latest.number);
  console.log('CHAIN_TIME=' + new Date(Number(latest.timestamp) * 1000).toISOString());
  console.log('TRADABLE_UNLISTED_SEED_TICKETS=' + candidates.length);
  for (const item of candidates.slice(0, 30)) {
    console.log('CANDIDATE=' + JSON.stringify(item));
  }

  const walletStates = [];
  for (const [seed, address] of SEEDS) {
    const state = await arcService.readArcWalletState(address);
    walletStates.push({
      seed,
      address,
      usdcRaw: state.usdc.balanceRaw,
      usdc: state.usdc.balanceFormatted,
    });
  }
  walletStates.sort((a,b)=>BigInt(b.usdcRaw) > BigInt(a.usdcRaw) ? 1 : BigInt(b.usdcRaw) < BigInt(a.usdcRaw) ? -1 : 0);
  for (const item of walletStates) {
    console.log('BUYER_BALANCE=' + JSON.stringify(item));
  }

  if (!candidates.length) {
    console.log('RESULT=NO_SAFE_MARKETPLACE_CANDIDATE');
    return;
  }

  const seller = candidates[0];
  const buyer = walletStates.find((x) => x.address.toLowerCase() !== seller.owner.toLowerCase() && BigInt(x.usdcRaw) >= 1_000_000n);
  console.log('RECOMMENDED_SELLER=' + JSON.stringify(seller));
  console.log('RECOMMENDED_BUYER=' + JSON.stringify(buyer || null));
  console.log('RESULT=' + (buyer ? 'SAFE_CANDIDATE_FOUND' : 'NO_FUNDED_BUYER_FOUND'));
}

main().catch((error) => {
  console.error('MARKETPLACE_CANDIDATE_INVENTORY=FAIL', error.stack || error.message);
  process.exitCode = 1;
});
