'use strict';

const {
  resolveExtremaWindow,
} = require('../src/services/binanceResolverService');

async function main() {
  const [
    symbol = 'ETHUSDT',
    cadence = 'DAILY',
    observationStartAt = '2026-09-04T00:00:00.000Z',
    observationEndAt = '2026-09-05T00:00:00.000Z',
  ] = process.argv.slice(2);

  const result = await resolveExtremaWindow({
    symbol: symbol.toUpperCase(),
    cadence: cadence.toUpperCase(),
    observationStartAt,
    observationEndAt,
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('RESOLVER_HISTORY_VERIFY=PASS');
}

main().catch((error) => {
  console.error('RESOLVER_HISTORY_VERIFY=FAIL');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
