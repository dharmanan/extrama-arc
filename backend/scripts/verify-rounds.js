'use strict';

// Read-only verification script. Supply harmless placeholders only for config
// fields that are irrelevant to Arc RPC reads when local shell env is absent.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@localhost:5432/unused';
process.env.ENCRYPTION_KEY ||= '00'.repeat(32);
process.env.JWT_SECRET ||= 'extrema-round-read-verification-placeholder-secret';

const arcService = require('../src/services/arcService');

async function main() {
  const state = await arcService.readStandardRounds();

  if (state.chain.id !== 5042002) throw new Error('wrong_chain');
  if (state.factory.poolCount !== 24) throw new Error('wrong_pool_count');
  if (state.pools.length !== 24) throw new Error('wrong_pool_length');

  const cadences = new Set();
  const directions = new Set();
  const assets = new Set();

  for (const pool of state.pools) {
    assets.add(pool.asset);
    directions.add(pool.direction);
    cadences.add(pool.cadence);

    if (pool.round.roundId !== 1) throw new Error(`wrong_round_id:${pool.slug}`);
    if (pool.round.contractStatus !== 'ENTRY_OPEN') throw new Error(`wrong_status:${pool.slug}`);
    if (pool.round.entryCount !== 0) throw new Error(`wrong_entry_count:${pool.slug}`);
    if (pool.round.totalStakeRaw !== '0') throw new Error(`wrong_total_stake:${pool.slug}`);
    if (pool.round.escrowRemainingRaw !== '0') throw new Error(`wrong_escrow:${pool.slug}`);
  }

  const sample = state.pools.find((pool) => pool.slug === 'btc-daily-high') || state.pools[0];

  console.log(JSON.stringify({
    verified: true,
    chainId: state.chain.id,
    blockNumber: state.chain.blockNumber,
    factory: state.factory.address,
    poolCount: state.factory.poolCount,
    assets: [...assets],
    directions: [...directions],
    cadences: [...cadences],
    sample: {
      slug: sample.slug,
      poolAddress: sample.poolAddress,
      ticketAddress: sample.ticketAddress,
      round: sample.round,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
