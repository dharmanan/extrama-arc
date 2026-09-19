'use strict';

// Exact one-shot operator execution for the only outstanding seed refund
// discovered by inventory-cancelled-seed-refunds.js on 2026-09-19.
//
// Safety properties:
// - exact pool / ticket / round / owner lock
// - re-read chain state before signing
// - primary Arc RPC only for broadcast
// - signed raw transaction hash computed before broadcast
// - exactly one broadcast attempt
// - timeout / uncertainty => read-only reconciliation, never blind retry
// - no private key or decrypted key is printed

const { ethers } = require('ethers');
const db = require('../src/db');
const arcService = require('../src/services/arcService');
const walletService = require('../src/services/walletService');
const { getArcWriteProvider } = require('../src/services/arcRpcProviderService');

const TARGET = Object.freeze({
  seed: 'SEED_3',
  owner: '0x7ccafd323A53179863D1839ef97Ee39B6BBCb6e7',
  slug: 'hype-daily-low',
  roundId: 7,
  tokenId: '1',
  poolAddress: '0x429329Efcd2c20198aB99EbF2459Be649864337C',
  ticketAddress: '0xAff6f3b5C2947368545B012c9689df2eC55997Bb',
  amountRaw: '1000000',
});

const REFUND_ABI = [
  'function refund(uint256 tokenId)',
  'event RefundClaimed(uint256 indexed roundId,uint256 indexed ticketId,address indexed owner,uint256 amount)',
];

const iface = new ethers.Interface(REFUND_ABI);

async function readState() {
  return arcService.readRefundAuthorizationState({
    poolAddress: TARGET.poolAddress,
    ticketAddress: TARGET.ticketAddress,
    tokenId: TARGET.tokenId,
    roundId: TARGET.roundId,
  });
}

async function reconcile({ txHash, nonce, readProvider, writeProvider }) {
  const [state, receipt, latestNonce, pendingNonce] = await Promise.all([
    readState().catch(() => null),
    readProvider.getTransactionReceipt(txHash).catch(() => null),
    writeProvider.getTransactionCount(TARGET.owner, 'latest').catch(() => null),
    writeProvider.getTransactionCount(TARGET.owner, 'pending').catch(() => null),
  ]);

  const landed =
    Boolean(receipt && receipt.status === 1) ||
    Boolean(state && state.isRefunded === true);

  console.log('RECONCILE=' + JSON.stringify({
    txHash,
    signedNonce: nonce,
    receiptStatus: receipt ? Number(receipt.status) : null,
    refunded: state?.isRefunded ?? null,
    currentOwner: state?.currentOwner ?? null,
    latestNonce,
    pendingNonce,
    landed,
  }));

  if (landed) {
    console.log('RESULT=REFUND_CONFIRMED_BY_RECONCILIATION');
    return true;
  }

  const hasPendingNonce =
    Number.isInteger(pendingNonce) &&
    Number.isInteger(latestNonce) &&
    pendingNonce > latestNonce;

  console.log(
    'RESULT=' +
      (hasPendingNonce
        ? 'UNCERTAIN_PENDING_TX_DO_NOT_RETRY'
        : 'NOT_LANDED_NO_PENDING_TX_MANUAL_REVIEW_BEFORE_ANY_RETRY'),
  );
  return false;
}

async function main() {
  const readProvider = arcService.getArcProvider();
  const writeProvider = getArcWriteProvider();

  const network = await readProvider.getNetwork();
  if (network.chainId !== arcService.ARC_TESTNET_CHAIN_ID) {
    throw new Error('arc_chain_id_mismatch');
  }

  const topology = arcService.ARC_POOL_TOPOLOGY.find(
    (item) =>
      item.poolAddress.toLowerCase() === TARGET.poolAddress.toLowerCase() &&
      item.ticketAddress.toLowerCase() === TARGET.ticketAddress.toLowerCase(),
  );
  if (!topology) throw new Error('target_topology_not_found');
  const slug = `${topology.asset.toLowerCase()}-${topology.cadence.toLowerCase()}-${topology.direction.toLowerCase()}`;
  if (slug !== TARGET.slug) throw new Error('target_slug_mismatch');

  const before = await readState();
  console.log('PRECHECK=' + JSON.stringify({
    chainId: Number(network.chainId),
    seed: TARGET.seed,
    slug: TARGET.slug,
    roundId: TARGET.roundId,
    tokenId: TARGET.tokenId,
    currentOwner: before.currentOwner,
    roundStatus: before.roundStatus,
    isRefunded: before.isRefunded,
    amountRaw: before.amountRaw,
  }));

  if (before.roundStatus !== 'CANCELLED') throw new Error('target_round_not_cancelled');
  if (before.isRefunded) {
    console.log('RESULT=ALREADY_REFUNDED_NO_ACTION');
    return;
  }
  if (before.currentOwner.toLowerCase() !== TARGET.owner.toLowerCase()) {
    throw new Error('target_owner_changed');
  }
  if (before.amountRaw !== TARGET.amountRaw) throw new Error('target_amount_mismatch');

  const { rows } = await db.query(
    `SELECT user_id
       FROM extrema_wallets
      WHERE LOWER(wallet_address) = LOWER($1)
      LIMIT 1`,
    [TARGET.owner],
  );
  if (!rows.length) throw new Error('seed_wallet_not_found_in_db');

  const signer = await walletService.getSignerForUser(rows[0].user_id, writeProvider);
  if (signer.address.toLowerCase() !== TARGET.owner.toLowerCase()) {
    throw new Error('seed_signer_mismatch');
  }

  // Re-read immediately before creating the transaction.
  const finalState = await readState();
  if (
    finalState.roundStatus !== 'CANCELLED' ||
    finalState.isRefunded ||
    finalState.currentOwner.toLowerCase() !== TARGET.owner.toLowerCase() ||
    finalState.amountRaw !== TARGET.amountRaw
  ) {
    throw new Error('target_state_changed_before_sign');
  }

  const txRequest = await signer.populateTransaction({
    to: TARGET.poolAddress,
    data: iface.encodeFunctionData('refund', [BigInt(TARGET.tokenId)]),
    value: 0n,
  });

  if (!Number.isInteger(txRequest.nonce)) throw new Error('refund_nonce_missing');
  const rawTx = await signer.signTransaction(txRequest);
  const txHash = ethers.keccak256(rawTx);

  console.log('SIGNED=' + JSON.stringify({
    txHash,
    nonce: txRequest.nonce,
    from: TARGET.owner,
    to: TARGET.poolAddress,
    roundId: TARGET.roundId,
    tokenId: TARGET.tokenId,
    amountRaw: TARGET.amountRaw,
    txHashKnownBeforeBroadcast: true,
  }));

  let response;
  try {
    // Exactly one mutation call in this script.
    response = await writeProvider.broadcastTransaction(rawTx);
    if (response.hash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error('broadcast_hash_mismatch');
    }
    console.log('BROADCAST_ACCEPTED=' + txHash);
  } catch (error) {
    console.error('BROADCAST_OR_SEND_ERROR=' + (error.shortMessage || error.message));
    await reconcile({
      txHash,
      nonce: txRequest.nonce,
      readProvider,
      writeProvider,
    });
    return;
  }

  try {
    const receipt = await response.wait(1, 90_000);
    if (!receipt || receipt.status !== 1) {
      console.error('WAIT_RESULT=FAILED_OR_MISSING_RECEIPT');
      await reconcile({
        txHash,
        nonce: txRequest.nonce,
        readProvider,
        writeProvider,
      });
      return;
    }

    const after = await readState();
    if (!after.isRefunded) throw new Error('refund_postcondition_failed');

    let eventOk = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== TARGET.poolAddress.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(log);
        if (
          parsed?.name === 'RefundClaimed' &&
          Number(parsed.args.roundId) === TARGET.roundId &&
          parsed.args.ticketId === BigInt(TARGET.tokenId) &&
          parsed.args.owner.toLowerCase() === TARGET.owner.toLowerCase() &&
          parsed.args.amount === 1_000_000n
        ) {
          eventOk = true;
          break;
        }
      } catch {}
    }
    if (!eventOk) throw new Error('refund_event_missing');

    console.log('CONFIRMED=' + JSON.stringify({
      txHash,
      blockNumber: receipt.blockNumber,
      receiptStatus: Number(receipt.status),
      refunded: after.isRefunded,
      currentOwner: after.currentOwner,
      amountRaw: after.amountRaw,
    }));
    console.log('RESULT=REFUND_CONFIRMED');
  } catch (error) {
    console.error('WAIT_OR_VERIFY_ERROR=' + (error.shortMessage || error.message));
    await reconcile({
      txHash,
      nonce: txRequest.nonce,
      readProvider,
      writeProvider,
    });
  }
}

main()
  .catch((error) => {
    console.error('REFUND_EXECUTION=FAIL', error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close().catch(() => {});
  });
