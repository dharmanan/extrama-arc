'use strict';

const { ethers } = require('ethers');
const arcService = require('./arcService');

const TICKET_TRANSFER_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function safeTransferFrom(address from,address to,uint256 tokenId)',
];
const TICKET_TRANSFER_INTERFACE = new ethers.Interface(TICKET_TRANSFER_ABI);

// Human execution modes only. The user's own wallet (connected, or Circle
// user controlled) signs the transfer; EXTREMA only builds and verifies it.
const EXTERNAL_MODES = ['EXTERNAL_WALLET', 'EXTERNAL_OWNER'];
const CIRCLE_MODES = ['CIRCLE_USER_WALLET'];
const EXECUTION_MODES = [...EXTERNAL_MODES, ...CIRCLE_MODES];

function assertTransferPayload(payload) {
  if (
    !payload ||
    payload.action !== 'TRANSFER_TICKET' ||
    !EXECUTION_MODES.includes(payload.executionMode) ||
    payload.chainId !== 5042002 ||
    !ethers.isAddress(payload.contract) ||
    !ethers.isAddress(payload.walletAddress) ||
    !ethers.isAddress(payload.from) ||
    !ethers.isAddress(payload.destination) ||
    payload.from.toLowerCase() !== payload.walletAddress.toLowerCase() ||
    payload.destination.toLowerCase() === payload.walletAddress.toLowerCase() ||
    typeof payload.tokenId !== 'string' ||
    !/^[1-9][0-9]*$/.test(payload.tokenId) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 16 ||
    !payload.expiresAt ||
    Number.isNaN(Date.parse(payload.expiresAt))
  ) {
    throw new Error('action_authorization_invalid');
  }
}

function assertTransferPayloadFresh(payload) {
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error('action_authorization_expired');
  }
}

function assertMode(payload, allowedModes) {
  if (!allowedModes.includes(payload.executionMode)) {
    throw new Error('transfer_execution_mode_mismatch');
  }
}

function requireSuccessfulReceipt(receipt) {
  if (!receipt || receipt.status !== 1) {
    throw new Error('transfer_transaction_failed');
  }
}

async function buildTransferTransactionRequest(payload, allowedModes) {
  assertTransferPayload(payload);
  assertTransferPayloadFresh(payload);
  assertMode(payload, allowedModes);
  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');
  const walletAddress = ethers.getAddress(payload.walletAddress);
  const ticketAddress = ethers.getAddress(payload.contract);
  const destinationAddress = ethers.getAddress(payload.destination);
  const tokenId = BigInt(payload.tokenId);
  const ticket = new ethers.Contract(ticketAddress, TICKET_TRANSFER_ABI, provider);
  let owner;
  try {
    owner = ethers.getAddress(await ticket.ownerOf(tokenId));
  } catch {
    throw new Error('transfer_ticket_not_found');
  }
  if (owner.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('transfer_not_ticket_owner');
  if (await provider.getBalance(walletAddress) === 0n) throw new Error('transfer_insufficient_gas');
  return {
    chainId: Number(network.chainId),
    from: walletAddress,
    to: ticketAddress,
    data: TICKET_TRANSFER_INTERFACE.encodeFunctionData('safeTransferFrom', [
      walletAddress,
      destinationAddress,
      tokenId,
    ]),
    value: '0x0',
  };
}

async function verifyTransferReceipt(payload, txHash, allowedModes) {
  assertTransferPayload(payload);
  assertMode(payload, allowedModes);
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('transfer_txhash_invalid');
  }
  const provider = arcService.getArcProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) throw new Error('arc_chain_id_mismatch');
  const walletAddress = ethers.getAddress(payload.walletAddress);
  const ticketAddress = ethers.getAddress(payload.contract);
  const destinationAddress = ethers.getAddress(payload.destination);
  const tokenId = BigInt(payload.tokenId);
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!tx || !receipt) throw new Error('transfer_transaction_not_found');
  requireSuccessfulReceipt(receipt);
  if (ethers.getAddress(tx.from).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('transfer_sender_mismatch');
  }
  if (!tx.to || ethers.getAddress(tx.to).toLowerCase() !== ticketAddress.toLowerCase()) {
    throw new Error('transfer_target_mismatch');
  }
  if (tx.value !== 0n) throw new Error('transfer_value_mismatch');
  const expectedData = TICKET_TRANSFER_INTERFACE.encodeFunctionData('safeTransferFrom', [
    walletAddress,
    destinationAddress,
    tokenId,
  ]);
  if (String(tx.data).toLowerCase() !== expectedData.toLowerCase()) {
    throw new Error('transfer_calldata_mismatch');
  }
  const ticket = new ethers.Contract(ticketAddress, TICKET_TRANSFER_ABI, provider);
  const ownerAfter = ethers.getAddress(await ticket.ownerOf(tokenId));
  if (ownerAfter.toLowerCase() !== destinationAddress.toLowerCase()) {
    throw new Error('transfer_postcondition_failed');
  }
  arcService.invalidateArcWalletStateCache(walletAddress);
  arcService.invalidateArcWalletStateCache(destinationAddress);
  return {
    chainId: Number(network.chainId),
    executionMode: CIRCLE_MODES.includes(payload.executionMode) ? 'CIRCLE_USER_WALLET' : 'EXTERNAL_WALLET',
    walletAddress,
    ticketAddress,
    tokenId: tokenId.toString(),
    destinationAddress,
    ownerBefore: walletAddress,
    ownerAfter,
    transferTxHash: txHash,
    explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
  };
}

async function buildExternalTransferTransactionRequest(payload) {
  return buildTransferTransactionRequest(payload, EXTERNAL_MODES);
}

async function verifyExternalTransferReceipt(payload, txHash) {
  return verifyTransferReceipt(payload, txHash, EXTERNAL_MODES);
}

async function buildCircleTransferTransactionRequest(payload) {
  return buildTransferTransactionRequest(payload, CIRCLE_MODES);
}

async function verifyCircleTransferReceipt(payload, txHash) {
  return verifyTransferReceipt(payload, txHash, CIRCLE_MODES);
}

module.exports = {
  buildExternalTransferTransactionRequest,
  assertTransferPayloadFresh,
  verifyExternalTransferReceipt,
  buildCircleTransferTransactionRequest,
  verifyCircleTransferReceipt,
};
