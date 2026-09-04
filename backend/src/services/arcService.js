'use strict';

const { ethers } = require('ethers');
const config = require('../config');

const ARC_TESTNET_CHAIN_ID = 5042002n;
const ARC_TESTNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

const USDC_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

function getProvider() {
  return new ethers.JsonRpcProvider(
    config.ARC_TESTNET_RPC_URL,
    { chainId: Number(ARC_TESTNET_CHAIN_ID), name: 'Arc Testnet' },
    { staticNetwork: true },
  );
}

async function readArcWalletState(address) {
  if (!ethers.isAddress(address)) {
    throw new Error('invalid_wallet_address');
  }

  const provider = getProvider();
  const [network, blockNumber, code] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
    provider.getCode(ARC_TESTNET_USDC_ADDRESS),
  ]);

  if (network.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  if (code === '0x') {
    throw new Error('arc_usdc_contract_not_found');
  }

  const usdc = new ethers.Contract(ARC_TESTNET_USDC_ADDRESS, USDC_ABI, provider);
  const [balanceRaw, decimals, symbol, name] = await Promise.all([
    usdc.balanceOf(address),
    usdc.decimals(),
    usdc.symbol(),
    usdc.name(),
  ]);

  return {
    chain: {
      id: Number(network.chainId),
      name: 'Arc Testnet',
      rpcUrl: config.ARC_TESTNET_RPC_URL,
      explorerUrl: 'https://testnet.arcscan.app',
      blockNumber,
    },
    usdc: {
      address: ARC_TESTNET_USDC_ADDRESS,
      name,
      symbol,
      decimals: Number(decimals),
      balanceRaw: balanceRaw.toString(),
      balanceFormatted: ethers.formatUnits(balanceRaw, decimals),
      contractCodePresent: true,
    },
    wallet: {
      address: ethers.getAddress(address),
      explorerUrl: `https://testnet.arcscan.app/address/${ethers.getAddress(address)}`,
    },
  };
}

module.exports = {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_USDC_ADDRESS,
  readArcWalletState,
};
