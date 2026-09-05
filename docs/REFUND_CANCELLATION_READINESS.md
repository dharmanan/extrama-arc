# Refund & Cancellation Readiness

Status snapshot for the refund/cancellation flow. This document is descriptive
(what exists and what is still blocked) — it is not a checklist substitute for
[`EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md`](../EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md),
which remains the source of truth for PASS/proof records.

## Implementation status

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
- Frontend (`app/tickets/page.tsx`): a "Claim refund" action appears only
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

## Resolver signer gap

Deployed resolver address (as reported by the pool contracts' `resolver()`
at the time of writing): `0x1EDC4594195fFb134315c3258DE974563Ed9762A`.

The repo currently reads and displays this **public** resolver address (e.g.
in the fork smoke scripts, via `pool.resolver()`), but there is **no
legitimate production signing mechanism wired up for it**. Concretely:

- `backend/src/services/binanceResolverService.js` computes settlement
  prices from Binance data, but nothing in this repo holds or uses a private
  key capable of signing as the resolver.
- `backend/src/services/walletService.js`'s encrypted-signer pattern exists
  only for **per-user EXTREMA wallets** (random keys generated and encrypted
  at wallet creation). It is not a template that should be reused for the
  resolver, because the resolver is a single shared operational key, not a
  per-user key — a different security posture (see options below).
- No `.env.example`, config schema entry, or code path in this repo accepts
  or expects a resolver private key. This is intentional and should stay
  that way.

**This document does not ask for, request, or store a resolver private key,
and none should be added to the repo, environment examples, or config
schema.** The resolver should also not be rotated as part of closing this
gap — rotating a deployed resolver is a contract-level operational decision
with its own review, independent of this readiness pass.

### Secure operational options (for Koray to decide, not implemented here)

1. **Hardware-backed signer (HSM / cloud KMS)** — e.g. AWS KMS or GCP Cloud
   KMS with a secp256k1 key, signing via a narrow, audited signing service
   that only the settlement/cancellation cron path can call. The private
   key material never leaves the KMS.
2. **Multisig / Safe with a bounded relayer** — the resolver role is held by
   a Safe (or similar) requiring 2-of-N human approval for each
   `settleRound`/`cancelRound` call, with an on-call runbook for daily
   rounds. Slower, but removes any single hot key from the picture.
3. **Dedicated signer microservice with envelope encryption** — analogous to
   `cryptoService.js`'s AES-256-GCM pattern, but deployed as an isolated
   process with its own restricted IAM role, its own secrets store entry
   (not `ENCRYPTION_KEY`, not shared with per-user wallets), and full audit
   logging of every signature it produces.
4. **Manual, air-gapped signing for now** — given this is still a hackathon
   deployment with very low round volume (see below), Koray manually signs
   and broadcasts `cancelRound`/`settleRound` transactions from a wallet he
   controls directly, without any code holding the key. This is the lowest
   engineering effort and matches "no live Arc transaction without an
   explicit, reviewed action" already in effect for this task.

**Until one of these (or an equivalent reviewed mechanism) is intentionally
established, live settlement and live cancellation remain blocked.** The
refund/cancellation code added in this pass is ready to be exercised once a
legitimate cancellation transaction lands on-chain, but nothing in this repo
should attempt to produce that transaction on its own.

## Daily Round #1 — expected outcome, not yet executed

- `observationEndAt` for the ETH Daily High/Low Round #1 pools:
  `2026-09-07T00:00:00Z` (03:00 Türkiye time).
- Both ETH Daily High Round #1 and ETH Daily Low Round #1 currently have
  exactly **1 entry each**, below the `MIN_ENTRIES = 3` threshold. Per
  `contracts/ARCHITECTURE.md` section 7 and `ExtremaPool.sol`'s
  `cancelRound`, both rounds are expected to become eligible for
  **cancellation**, not settlement, once `observationEndAt` passes and
  `lockRound` is called.
- **This has not been executed.** No `lockRound`, `cancelRound`, or `refund`
  transaction has been sent to Arc Testnet as part of this work. Doing so
  requires the resolver signing path above to exist first (for
  `cancelRound`, which is `onlyResolver`), plus an explicit decision to
  proceed with a live transaction.
