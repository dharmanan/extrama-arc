'use strict';

const { ethers } = require('ethers');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.network';
const CHAIN_ID = 5042002n;
const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

async function main() {
  const [walletArg, ...txHashes] = process.argv.slice(2);

  if (!walletArg || txHashes.length === 0) {
    throw new Error(
      'Usage: node scripts/verify-funding.js <walletAddress> <txHash1> [txHash2 ...]',
    );
  }

  const wallet = ethers.getAddress(walletArg);
  const provider = new ethers.JsonRpcProvider(
    RPC_URL,
    { chainId: Number(CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );

  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Expected Arc Testnet chain ID ${CHAIN_ID}, got ${network.chainId}`);
  }

  const results = [];

  for (const hash of txHashes) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) {
      results.push({ hash, verified: false, reason: 'receipt_not_found' });
      continue;
    }

    const transfers = receipt.logs
      .filter(
        (log) =>
          log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
          log.topics[0] === TRANSFER_TOPIC &&
          log.topics.length >= 3,
      )
      .map((log) => {
        const from = ethers.getAddress('0x' + log.topics[1].slice(-40));
        const to = ethers.getAddress('0x' + log.topics[2].slice(-40));
        const amountRaw = BigInt(log.data);
        return {
          from,
          to,
          amountRaw: amountRaw.toString(),
          amountUsdc: ethers.formatUnits(amountRaw, 6),
        };
      });

    const matchingTransfers = transfers.filter(
      (item) => item.to.toLowerCase() === wallet.toLowerCase(),
    );

    results.push({
      hash,
      verified: receipt.status === 1 && matchingTransfers.length > 0,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      wallet,
      usdc: USDC_ADDRESS,
      transfersToWallet: matchingTransfers,
    });
  }

  const totalRaw = results
    .flatMap((item) => item.transfersToWallet || [])
    .reduce((sum, item) => sum + BigInt(item.amountRaw), 0n);

  const output = {
    chainId: Number(network.chainId),
    wallet,
    usdc: USDC_ADDRESS,
    allVerified: results.every((item) => item.verified),
    totalUsdcToWallet: ethers.formatUnits(totalRaw, 6),
    transactions: results,
  };

  console.log(JSON.stringify(output, null, 2));

  if (!output.allVerified) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
