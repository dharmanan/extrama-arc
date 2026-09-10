# Refund & Cancellation Readiness

Status snapshot for the refund/cancellation flow. This document is descriptive
(what exists and what is still blocked) — it is not a checklist substitute for
[`EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md`](../EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md),
which remains the source of truth for PASS/proof records.

## Current runtime status

Refunds are always user-initiated and paid by the pool to the current NFT
owner. The final human runtime has no passkey/WebAuthn ceremony and no human
`BACKEND_WALLET` signer:

- `EXTERNAL_WALLET` receives an exact, session-wallet-bound
  `refund(tokenId)` transaction request, sends it from the connected wallet,
  then has the receipt independently verified.
- `CIRCLE_USER_WALLET` receives a Circle hosted challenge for the exact
  `refund(tokenId)` calldata from its bound Circle Arc EOA, then has the
  Circle transaction and Arc receipt independently verified.
- `SYSTEM_SEED_WALLET` remains an autonomous-agent identity, never a browser
  user refund path.

The deterministic Circle lifecycle suite covers the refund path. A live
Circle refund has not been sent and is not claimed here.

Arc uses one economic USDC asset for this flow. `pool.refund(tokenId)` moves
the exact 6-decimal ERC-20 amount (`1,000,000` raw); the sender's native
18-decimal read is only the technical fee interface for that same USDC and is
never added to the payout or treated as a second balance.

## Legacy readiness record (pre-final human-wallet migration)

The refund action authorization foundation (`REFUND_TICKET` canonical payload,
`arcService.readRefundAuthorizationState()`) was already on `main`. This pass
adds the remaining authorization + execution surface, mirroring the existing
`TRANSFER_TICKET` step-up pattern:

- `POST /actions/refund/start` — re-derives financial truth from Arc
  (`readRefundAuthorizationState`), rejects unless `roundStatus == CANCELLED`
  and `!isRefunded`, determines `executionMode` server-side (never trusts a
  client-supplied value), and only then creates the one-time `REFUND_TICKET`
  authorization and issues a fresh WebAuthn step-up challenge.
- `POST /actions/refund/finish` — consumes the WebAuthn challenge and the
  authorization exactly once, then branches on the server-determined
  `executionMode`:
  - `BACKEND_WALLET`: executes `pool.refund(tokenId)` immediately via
    `refundExecutionService.executeBackendRefund`, signed by the backend's
    encrypted per-user wallet, with pre-flight re-verification and full
    postcondition checks: exact pool USDC balance decrease of `1,000,000`
    raw, exact round `escrowRemaining` decrease of `1,000,000` raw, the
    exact USDC `Transfer` event `pool -> currentOwner` of `1,000,000` raw,
    the contract's own `RefundClaimed(roundId, ticketId, owner, amount)`
    event, and `refunded(tokenId) == true`. The owner's own net balance is
    intentionally never checked — it is also the transaction sender and
    pays Arc gas from the same underlying USDC balance, so a net +1 USDC
    is not a valid signal.
  - `EXTERNAL_OWNER`: does **not** sign anything. It re-verifies Arc state
    fresh and returns a tightly-bound transaction request
    (`to = pool`, `data = refund(tokenId)`, `value = 0`, `chainId = 5042002`)
    for the browser to send from the connected wallet.
- `POST /actions/refund/verify` — for the `EXTERNAL_OWNER` path only. Takes
  `{ actionId, txHash }`, independently fetches the transaction and receipt
  from Arc. Hard requirements (the actual financial guarantees for this
  path): exact sender, exact target, exact `refund(tokenId)` calldata,
  `tx.value == 0`, successful receipt, the exact USDC `Transfer` event
  `pool -> currentOwner` of `1,000,000` raw, the contract's `RefundClaimed`
  event, and `refunded(tokenId) == true`. This step intentionally does not
  re-check the authorization's `expiresAt` — the 2-minute window was
  already enforced when `/refund/finish` consumed the authorization and
  produced this transaction request; the on-chain confirmation this step
  verifies can legitimately land well after that window closes.
  It additionally reads pool accounting at `receipt.blockNumber - 1` vs
  `receipt.blockNumber` as **block-scoped best-effort accounting
  evidence** — never a hard gate. This is block-scoped, not
  transaction-scoped: another transaction touching the same pool/round in
  the same block (e.g. a different ticket's refund) would shift the
  observed delta without this refund being wrong, so it is reported purely
  as supplementary diagnostic evidence (`accounting.poolUsdcDeltaExact` /
  `escrowDeltaExact`), and when the RPC can't serve that historical block
  state at all the limitation is reported explicitly
  (`accounting.available: false`) rather than a delta being fabricated.
  The browser's reported success is never trusted as financial truth.
- `refundExecutionService.js` — new service, mirrors
  `ticketTransferExecutionService.js`'s structure: payload re-validation,
  live chain-id check, encode-only `pool.refund(tokenId)` (no arbitrary
  target/calldata/amount), pre-flight + postcondition re-reads from Arc.
- `GET /wallet/tickets` now returns `{ backendWallet, ownerWallet }` — the
  authenticated owner wallet's tickets are discovered via the existing
  `arcService.readOwnedTickets()` scanner (no duplicate scanner), kept
  distinct from the backend-managed wallet's tickets rather than merged.
- Legacy frontend record (`app/tickets/page.tsx`): a "Claim refund" action appears only
  when `roundStatus === 'CANCELLED' && !isRefunded`. For backend-owned
  tickets it completes in one passkey step. For externally-owned tickets it
  additionally requires the connected wallet to match the authorized
  `currentOwner` and be on Arc Testnet (chain `5042002`) before sending the
  backend-provided transaction request, then reports only the tx hash back
  for independent server-side verification.

No Arc Testnet transaction has been broadcast as part of this work.
`script/smoke-transferred-refund-fork.sh` (see checklist section 11) has
proven ownership access control on a local fork (the original entrant is
rejected with `NotTicketOwner`). The USDC-movement half of that proof has
**not** been established: the current-owner refund send previously failed
on generic Anvil during gas estimation/execution with an empty `0x` revert,
consistent with Arc's coupled native/ERC-20 USDC accounting not being
faithfully mirrored by a generic fork for the impersonated account. This
session hardened the script's reporting: on any current-owner send failure
it now reports `CURRENT_OWNER_REFUND_FORK=FAILED_UNCLASSIFIED` /
`TRANSFERRED_REFUND_FORK=UNPROVEN` (rather than an opaque failure), and may
*mention* that a gas/empty-revert-shaped failure is consistent with the
known Arc/Anvil coupling limitation without claiming that as proven — this
script has no call-trace mechanism to actually establish that execution
reached the external USDC-transfer boundary inside `pool.refund()`. The
script was not re-executed here (no Foundry in this sandbox), so the
USDC-movement proof remains unestablished either way.

## Resolver signer: gap closed

Deployed resolver address, as reported by the pool contracts' `resolver()`:
`0x1EDC4594195fFb134315c3258DE974563Ed9762A`.

Earlier revisions of this document recorded that no production resolver
signing mechanism existed, that manual keystore signing was the operating
mechanism, and that this repo should not automate resolver signing. **All
three statements are now out of date.** A production signing path exists,
manual signing is no longer the mechanism for any lifecycle action, and
cancellation and settlement are automated.

### What was chosen

Option 3 from the earlier option list, envelope encryption, adapted to reuse
the existing `cryptoService` primitive rather than standing up a separate
microservice. The resolver was **not** rotated and `pool.resolver()` was not
changed, preserving the existing role separation.

### Mechanism

- The resolver private key is stored only as an AES-256-GCM envelope in the
  Railway environment variable `EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED`,
  in the existing `v1.<iv>.<ct>.<tag>` format, encrypted under the existing
  `ENCRYPTION_KEY`.
- `backend/src/config.js` validates the variable against the envelope shape.
  A plaintext private key is structurally rejected, so it cannot be
  configured by mistake.
- `backend/src/services/resolverSignerService.js` decrypts the envelope only
  into an in-memory `ethers.Wallet`. It never logs, returns, or persists the
  key material. When the variable is absent it warns once per process and
  reports the signer as unconfigured.
- `backend/scripts/encrypt-resolver-key.js` builds the envelope locally. It
  accepts the key from a Foundry keystore via `cast`, from a keystore file, or
  from a hidden prompt, and it verifies that the derived address equals the
  deployed resolver before encrypting, aborting on mismatch. The key never
  reaches argv, shell history, disk, or logs.

### Startup verification

`roundAutomationService.verifyResolverConfiguration()` runs once when the
backend process starts. It decrypts the envelope, derives the address, reads
live `pool.resolver()` from a reference pool, and compares them.

Railway startup proof, 2026-09-06:

```
[round-automation] daily scheduler active
[round-automation] resolver signer verified {"resolver":"0x1EDC4594195fFb134315c3258DE974563Ed9762A"}
```

This preflight is informational and fire-and-forget. It does not gate the
automation, so a transient RPC failure at boot cannot stall the lifecycle.
Correctness is guarded separately and unconditionally: `executeResolverAction()`
re-reads live `pool.resolver()` immediately before every cancel or settle and
refuses to sign on `resolver_signer_mismatch`.

### Automation status

- `cancelRound` and `settleRound` are implemented in the lifecycle engine and
  execute from the resolver signer.
- Before acting, the engine re-reads the round and no-ops if it has reached a
  terminal state or is no longer eligible.
- `sendOnceWithReconciliation()` never resends. On an unknown send outcome it
  re-reads the round to determine whether the transition actually landed.
- Settlement evidence is built from Binance mark-price klines and raises
  `resolver_data_incomplete` rather than settling on partial source data.
- **No `cancelRound` or `settleRound` transaction has been broadcast yet.**
  The earliest eligible moment is `2026-09-07T00:00:00Z`. See the section
  below.

### Refunds remain user-initiated

Cancellation is automated. Refunds are not, and this is deliberate.

`pool.refund(tokenId)` pays the **current NFT owner**. The current runtime
keeps it behind a user-initiated `REFUND_TICKET` flow: the server derives the
execution identity from the authenticated session and on-chain ownership, then
the connected external wallet signs its exact request or the Circle wallet
approves its exact hosted challenge. Both paths are independently verified.

The backend-wallet/passkey description in the legacy record above is retained
only to preserve the historical proof, not as a current execution option.

No private key, envelope value, or `ENCRYPTION_KEY` value appears in this
repository, in `.env.example`, or in this document.

## Daily Round #1 — expected outcome, not yet executed

- `observationEndAt` for the ETH Daily High/Low Round #1 pools:
  `2026-09-07T00:00:00Z` (03:00 Türkiye time).
- Both ETH Daily High Round #1 and ETH Daily Low Round #1 currently have
  exactly **1 entry each**, below the `MIN_ENTRIES = 3` threshold. Per
  `contracts/ARCHITECTURE.md` section 7 and `ExtremaPool.sol`'s
  `cancelRound`, both rounds are expected to become eligible for
  **cancellation**, not settlement, once `observationEndAt` passes and
  `lockRound` is called.
- **Locking has now been executed on Arc Testnet.** ETH Daily High Round #1
  was locked in tx
  `0x0b9f2de2fa221a734b7877904c71348bc7eaf16845ed88fe215c93c2d00644a7`
  (block `60637750`), and ETH Daily Low Round #1 was locked in tx
  `0xac32dde62e060f5fadbb5384ee6fcc528c2828d9637b9e7fb700639d20529219`
  (block `60638205`). Both receipts succeeded and both rounds now read
  `LOCKED` onchain.
- No `cancelRound` or `refund` transaction has been sent yet. The resolver
  signing path that previously blocked `cancelRound` now exists and is
  verified, so the remaining blocker is only calendar time: the automation
  becomes eligible to act once `observationEndAt` passes.
- Expected sequence once eligible: the lifecycle engine cancels both rounds,
  each round moves to `CANCELLED` with its `escrowRemaining` preserved, and
  the two ticket owners then claim their refunds through the user-initiated
  flow. Historical pre-migration records may identify ETH Daily Low Ticket
  #1 as `BACKEND_WALLET`; that label is retained only as history. The current
  runtime uses `EXTERNAL_OWNER` or `CIRCLE_USER_WALLET` for every human refund.
- ETH Weekly High Round #1 has 3 entries, meets `MIN_ENTRIES`, and is
  therefore expected to **settle** rather than cancel, after
  `2026-09-14T00:00:00Z`.
- Record the resulting transaction hashes in
  `EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md` sections 7, 8, and 11. Nothing in
  those sections may be marked complete before the transactions actually
  land.
