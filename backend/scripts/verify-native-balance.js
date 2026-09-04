'use strict';

const { ethers } = require('ethers');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.network';
const CHAIN_ID = 5042002n;

async function main() {
  const [walletArg] = process.argv.slice(2);
  if (!walletArg) {
    throw new Error('Usage: node scripts/verify-native-balance.js <walletAddress>');
  }

  const wallet = ethers.getAddress(walletArg);
  const provider = new ethers.JsonRpcProvider(
    RPC_URL,
    { chainId: Number(CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );

  const [network, blockNumber, balanceRaw] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getBalance(wallet),
  ]);

  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Expected chain ID ${CHAIN_ID}, got ${network.chainId}`);
  }

  console.log(JSON.stringify({
    verified: true,
    chainId: Number(network.chainId),
    wallet,
    blockNumber,
    nativeCurrency: 'USDC',
    decimals: 18,
    balanceRaw: balanceRaw.toString(),
    balanceFormatted: ethers.formatUnits(balanceRaw, 18),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
