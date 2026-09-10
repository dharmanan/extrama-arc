'use strict';

const assert = require('node:assert/strict');
const {
  createSeedBotLiveStateService,
} = require('../src/services/seedBotLiveStateService');

async function main() {
  const poolAddress = '0x0000000000000000000000000000000000000001';
  const ticketAddress = '0x0000000000000000000000000000000000000002';
  const usdcAddress = '0x3600000000000000000000000000000000000000';
  const wallet = '0x0000000000000000000000000000000000000003';

  const provider = {
    async getNetwork() {
      return { chainId: 5042002n };
    },
    async getBlock(tag) {
      assert.equal(tag, 'latest');
      return { timestamp: 1_800_000_500 };
    },
    async getBalance(address) {
      assert.equal(address, wallet);
      return 500000000000000000n;
    },
  };

  class FakeContract {
    constructor(address) {
      this.address = address;
    }

    async getRound(roundId) {
      assert.equal(this.address, poolAddress);
      assert.equal(roundId, 8);
      return {
        entryOpenAt: 1_800_000_000n,
        entryCloseAt: 1_800_010_000n,
        status: 0n,
      };
    }

    async hasEntered(roundId, address) {
      assert.equal(this.address, poolAddress);
      assert.equal(roundId, 8);
      assert.equal(address, wallet);
      return false;
    }

    async predictionTaken(roundId, prediction) {
      assert.equal(this.address, poolAddress);
      assert.equal(roundId, 8);
      assert.equal(prediction, 12345);
      return false;
    }

    async balanceOf(address) {
      assert.equal(this.address, usdcAddress);
      assert.equal(address, wallet);
      return 99000000n;
    }
  }

  const service = createSeedBotLiveStateService({
    arc: {
      ARC_POOL_TOPOLOGY: [{
        asset: 'SOL',
        direction: 'HIGH',
        cadence: 'DAILY',
        poolAddress,
        ticketAddress,
      }],
      ARC_TESTNET_USDC_ADDRESS: usdcAddress,
      getArcProvider() {
        return provider;
      },
    },
    ethersLib: {
      isAddress(value) {
        return /^0x[0-9a-fA-F]{40}$/.test(value);
      },
      Contract: FakeContract,
    },
    timeoutMs: 1000,
  });

  const result = await service.readFreshSeedEntryState({
    wallet,
    pool: 'sol-daily-high',
    poolAddress,
    roundId: '8',
    predictionPriceCents: '12345',
  });

  assert.equal(result.liveState.chainId, 5042002);
  assert.equal(result.liveState.chainTimestamp, 1_800_000_500);
  assert.equal(result.liveState.roundStatus, 0);
  assert.equal(result.liveState.hasEntered, false);
  assert.equal(result.liveState.predictionTaken, false);
  assert.equal(result.liveState.usdcRaw, '99000000');
  assert.equal(result.liveState.nativeRaw, '500000000000000000');
  assert.equal(result.liveState.ticketAddress, ticketAddress);

  await assert.rejects(
    () => service.readFreshSeedEntryState({
      wallet,
      poolAddress: '0x0000000000000000000000000000000000000099',
      roundId: '8',
      predictionPriceCents: '12345',
    }),
    /seed_live_pool_not_canonical/,
  );

  console.log('seed-bot-live-state: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
