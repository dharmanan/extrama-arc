'use strict';

// A transaction send is attempted exactly once. If the send/wait result is
// uncertain, the caller's onchain postcondition decides whether it already
// landed. Nothing is ever re-broadcast from this helper.
async function sendOnceWithReconciliation({ send, hasLanded, label }) {
  try {
    const tx = await send();
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${label}_transaction_failed`);
    }
    return { txHash: tx.hash, reconciled: false };
  } catch (error) {
    const landed = await hasLanded().catch(() => false);
    if (landed) return { txHash: null, reconciled: true };
    throw error;
  }
}

module.exports = { sendOnceWithReconciliation };
