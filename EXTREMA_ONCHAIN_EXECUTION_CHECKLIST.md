# EXTREMA — Arc Testnet Onchain Execution Checklist

> This file is the single execution checklist for EXTREMA.
> We progress **one item at a time**.
> A task is not marked complete until its acceptance criteria are satisfied and its proof is recorded here.

## Non-negotiable rules

- Production-path financial state must not come from mocks, localStorage, hardcoded balances, fake player counts, fake pool sizes, fake tickets, or fake claims.
- All financial actions must be executed on **Arc Testnet** before an item is marked complete.
- Every onchain completion must include evidence:
  - chain ID
  - contract/address involved
  - transaction hash
  - explorer link when available
  - expected state before
  - expected state after
  - verification result
- For read-only onchain items, record the RPC call / contract read and the returned value.
- For resolver/settlement items, record the exact source data, period, calculation, submitted settlement transaction, and resulting contract state.
- Never mark an item complete because the UI appears to work.
- Never replace a failed real integration with mock data in the normal application path.
- Human financial actions must be signed by the authenticated user's own execution identity: a connected external wallet or a Circle hosted challenge. The backend only signs for the autonomous `SYSTEM_SEED_WALLET` agents.
- Design work is last. Functionality and proof come first.

---

## Current runtime architecture — final human-wallet migration

The current runtime has exactly three execution identities:

- `EXTERNAL_WALLET`: a human signs one login message, then signs every financial transaction with the connected EVM wallet.
- `CIRCLE_USER_WALLET`: a human signs in through Circle and approves every financial transaction in a Circle hosted challenge for their Circle-controlled Arc EOA.
- `SYSTEM_SEED_WALLET`: the nine autonomous agents, using their existing encrypted backend-held wallets and safeguards; this is never a browser human session.

There is no active human `BACKEND_WALLET` path and no active passkey/WebAuthn runtime. References below to passkeys, WebAuthn, `BACKEND_WALLET`, per-user EXTREMA wallets, or a backend signer are retained only as **legacy historical proof records** for transactions and tests executed before this migration. They do not describe the current human product.

### One economic USDC asset

Arc Testnet uses one underlying USDC balance. The native currency interface
uses 18 decimals for network fees and the ERC-20 interface uses 6 decimals for
application amounts. The interfaces are technical views of the same asset;
native and ERC-20 values are never summed. The API's canonical application
balance is `usdc`; `nativeUsdcGasInterface` is a diagnostic-only native read
explicitly marked `sameUnderlyingAsset: true`, and the UI renders only the
single Arc USDC balance.

---

## Status legend

Every item in this document resolves to exactly one of three states.

| State | Meaning |
|---|---|
| **COMPLETE / LIVE PROVEN** | Executed against real Arc Testnet state and evidenced here with the transaction hash, contract read, or recorded output. Marked `[x]`. |
| **IMPLEMENTED / WAITING FOR LIVE PROOF** | Code exists, is deployed, and is verified as far as it can be without a real transaction. The blocking factor is calendar time or an unreached chain state, not missing work. Marked `[ ]` with an explicit label. |
| **NOT IMPLEMENTED / REMAINING** | Work still to be done. Marked `[ ]`. |

Code existing is never sufficient to mark an item `[x]`. A checkbox is only ticked when its proof is recorded in this file.

---

## Production state snapshot

Snapshot date: 2026-09-12. Reference: current local working tree on `main`; this update is not a deployment or a commit proof.

Previous snapshot: 2026-09-09, commit `f09ca39742d47206af18a2f255895d42b4ba1c02`. Everything recorded under that snapshot remains valid historical proof and is kept unchanged below.

This section is a summary. The authoritative per-item status remains in the numbered sections below and in the [Current roadmap](#current-roadmap).

### Live in production

- 24 pool contracts and 24 paired ERC-721 ticket collections deployed on Arc Testnet (`5042002`)
- Real Arc Testnet USDC (`0x3600000000000000000000000000000000000000`), no mock token
- Real prediction entry at a fixed 1 USDC stake
- ERC-721 ticket minting, ticket transfer, and current-NFT-owner claim/refund rights enforced onchain
- `EXTERNAL_WALLET` sessions with client-signed financial transactions
- `CIRCLE_USER_WALLET` sessions with Circle hosted-challenge transactions
- Encrypted system seed wallets for autonomous agents only
- Backend on Railway, frontend on Vercel, PostgreSQL on Railway
- Binance USDⓈ-M Futures mark-price klines as the settlement source, with deterministic evidence hashing
- Live result API reading real round state
- Backend claim flow and backend refund flow
- 90-day onchain archive read path
- Round lifecycle automation running in Railway: DAILY/WEEKLY/QUARTERLY round creation, lifecycle scan, permissionless `lockRound`, and resolver-authorized `cancelRound` / `settleRound`
- Arc RPC hardening: bounded retry for transient reads plus correct ethers v6 rate-limit shape detection
- Resolver signer provisioned to Railway as an encrypted envelope and verified against `pool.resolver()` at backend startup
- Resolver funded for gas on Arc Testnet

### Live production proofs completed

The previous calendar-gated lifecycle proof is no longer pending. Real Arc Testnet and Railway evidence now exists for the core C6 paths.

| Proof | Live evidence | Result |
|---|---|---|
| Resolver `cancelRound` | ETH Daily Low Round #1, tx `0xa6119ad38927e96095930e8270d4f21b0b1f4f3a478de58c4a0066d54158a4a3` | PASS |
| Resolver `settleRound` | ETH Daily High Round #4, tx `0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9` | PASS |
| Real refund + USDC movement | ETH Daily Low Round #1, Ticket #1, tx `0x04183e238f8e2e2a29e733119b5262e2ffc74b8c492542d73febce04117cb8cf`, 1.0 USDC | PASS |
| Real claim + USDC movement | ETH Daily High Round #4, Ticket #2, tx `0xc7913e802e228549cfb564e60eba6f6f57afbbc1e8e4e8fe33ee0f11e59cf2ff`, 0.405 USDC | PASS |
| Real Circle production entry | SOL Daily Low Round #6, Ticket #1, tx `0x9ef2fcbc33b7195517e2e3b323fce34b96e87550e9ce9d6222b3a6769d633d52` | PASS |
| Marketplace cache refresh | Railway live read: cached block `61265957` refreshed in background to `61265977`, zero degraded listings | PASS |

The deterministic suite separately proves replay rejection, double claim prevention, double refund prevention, transferred-ticket ownership semantics, payout math, and marketplace lifecycle behavior. A duplicate live claim/refund transaction was deliberately not broadcast merely to reproduce those negative cases.

Section 15 remains open: the evidence above spans multiple real rounds and therefore does not yet satisfy the stricter requirement for one single round demonstrated from creation through final claim.

### Updates since the 2026-09-09 snapshot (as of 2026-09-11)

#### System seed agents v3

IMPLEMENTED / DEPLOYED:

- 9 approved autonomous `SYSTEM_SEED_WALLET` agents
- 8 DAILY pools × 9 agents = target of 72 plans per daily round
- Prediction planning from the Binance settlement source only
- Observed HIGH and LOW extrema as the anchor
- Elapsed and remaining time model, with the projected time scale clamped to 0.25x..2.5x
- Nine risk profiles
- Unique exact cent predictions; a taken slot only moves outward (HIGH higher, LOW lower)
- Fresh v3 recalculation from current observed extrema immediately before execution
- A stale planner version fails closed
- At most one dispatch per scheduler tick
- About 5 minutes of global dispatch spacing
- Partial round replanning every 15 minutes
- Existing same version plans are never rewritten
- Missing plans can be filled after a partial planning pass
- Deterministic v3 prediction safety verification added

LIVE STATUS:

- Round 7 did **not** reach 72/72 before entry close: 49 seed entries completed, 23 missing.
- Round 8 72/72 production result is **NOT YET VERIFIED** after the new deployment.
- Daily 72/72 is therefore **not** LIVE PROVEN.

#### Round 7 real settlement

- All 8 DAILY Round 7 pools reached a final state: 6 SETTLED, 2 CANCELLED.
- BTC, ETH and SOL HIGH and LOW pools settled; HYPE HIGH and HYPE LOW were cancelled.
- 16 winning seed tickets were claimed, for a total of 44.01 USDC in seed winner claims.
- Human winning claims were executed separately by their holders.
- HYPE Round 7 cancelled ticket refunds remain a separate open operation if not yet executed (see the roadmap).

Earlier settlement, refund and claim proofs recorded in this document are unchanged.

#### Archive, Result and Verify UX

IMPLEMENTED / DEPLOYED:

- Archive browser stale while revalidate session cache
- Result historical snapshot handoff from the Archive
- The Result route renders a known historical result without waiting for Arc
- Result backend winner reads run concurrently
- Result backend 15 second cache with in flight deduplication
- Slow Result requests are aborted on unmount
- Archive requests are aborted on unmount
- Leaderboard archive request is aborted on unmount
- Result page "Back to archive" navigation
- Verify Result shows a user first verdict
- The technical verification proof sits behind a disclosure

STILL OPEN: Archive and Leaderboard **first load**. A fresh browser with no session cache still waits for the expensive 90 day chain archive read.

CURRENT ACTIVE TASK (implemented in the working tree, not yet deployed):

- PostgreSQL backed durable last successful Archive snapshot (`round_archive_snapshots`)
- Backend stale while revalidate: a known snapshot is served immediately and refreshed in the background, one refresh at a time; a failed refresh never replaces it
- Leaderboard derives its standings from the same shared Archive data and browser cache
- Real loading feedback when no snapshot exists yet
- Production verification still required

Archive and Leaderboard first load performance is **not** complete until this is deployed and verified in production.

#### Arc RPC and retry safety

IMPLEMENTED / VERIFIED IN CODE:

- Primary Arc read RPC plus a fallback read RPC
- ethers `batchMaxCount: 1`
- Read concurrency gate of 8
- Read timeout
- Read retry only for transient failures and rate limits
- Exponential backoff with jitter
- Primary only write provider; the fallback is never used for broadcast
- An uncertain send or wait is reconciled read only
- No blind transaction rebroadcast

This does not claim support for 100 simultaneous financial transactions.

#### Circle status

LIVE PROVEN:

- Circle user controlled Arc EOA session
- Real Circle ENTRY executed on Arc Testnet (SOL Daily Low Round #6, see the proof table above)

IMPLEMENTED:

- Circle human lifecycle architecture for entry, transfer, refund, claim and marketplace actions

NOT YET FULLY LIVE PROVEN:

- The complete post entry Circle lifecycle across those actions

Circle live proof and Circle Gateway live proof are separate gates.

#### Marketplace status

- Marketplace contract and deterministic lifecycle coverage are complete.
- Listing grouping UI is complete.
- A real historical listing exists and has been exercised on Arc Testnet (Listing #2).
- A secondary full live buy or trade proof remains optional and pending, only if required for final acceptance. No new live trade is claimed here.

### Circle Gateway

Circle Gateway is its own roadmap item and is not part of the Circle wallet or wallet notes.

Gateway now supports both human execution modes, `CIRCLE_USER_WALLET` and `EXTERNAL_WALLET`, on one canonical set of state machines. The earlier Circle only scope is superseded; it is kept below only as historical proof record for what was already validated before the dual mode generalization.

ARCHITECTURE CORRECTION (2026-09-12): the product model is now a UNIFIED balance.

- OLD: the user selected a Gateway SOURCE domain, and the destination was always Arc.
- NEW: the user selects a DESTINATION, and the backend resolves a deterministic source allocation plan across the deposited balances. That transfer-source selection is protocol execution detail and has been removed from the transfer UI entirely; the separate Add USDC flow still asks which source wallet the user intends to fund from.

Four funding source networks (add USDC to Gateway):

- Base Sepolia (domain 6, chain 84532)
- OP Sepolia (domain 2, chain 11155420)
- Arbitrum Sepolia (domain 3, chain 421614)
- Ethereum Sepolia (domain 0, chain 11155111)

Five transfer destination networks (send the unified balance):

- Arc Testnet (domain 26, chain 5042002)
- Base Sepolia (domain 6, chain 84532)
- OP Sepolia (domain 2, chain 11155420)
- Arbitrum Sepolia (domain 3, chain 421614)
- Ethereum Sepolia (domain 0, chain 11155111)

Everything newly generalized in this correction is **IMPLEMENTED / DETERMINISTICALLY VALIDATED, NOT LIVE PROVEN** except the controlled Circle Arbitrum source deposit recorded below, whose approval, deposit submission, Gateway credit/finality and source flow are now live proven.

IMPLEMENTED:

- One canonical server-side Gateway network configuration (`gatewayNetworks.js`): chain ids, Gateway domains, USDC addresses, Circle blockchain identifiers and user-facing labels live in exactly one table. The frontend consumes labels and domains through the wallet API and never holds a token or contract address.
- Circle blockchain identifiers taken from the installed `@circle-fin/user-controlled-wallets@10.8.0` enum strings and asserted against the package at verification time, never guessed
- Generic source chain service (`gatewaySourceChainService.js`, superseding the Base-only `baseSepoliaService.js`): one implementation, four configurations, with per chain provider, balance/allowance reads, exact `approve`/`deposit` calldata, and a receipt assertion that binds the chain id so a receipt from one funding chain can never satisfy a deposit on another
- Automatic server-side fee-aware source allocation: deterministic candidate search, per-source `maxFee` headroom, exact selected-plan estimate, replay-identical canonical salts, skips empty and unspendable domains, never signs without allocation-plus-fee coverage, and fails closed at Circle's 16-intent cap
- Multi-source transfers: an amount larger than any single chain's balance is spent as one transfer drawing on several source domains, rather than being rejected
- Destination generalization: five canonical destinations, with the destination token and minter always read from server config and never accepted from a browser; an unsupported destination fails closed
- Same-chain withdrawal permitted: `sourceDomain === destinationDomain` is valid Gateway behavior and is no longer rejected. Arc is now also a spendable source domain, so an Arc-held unified balance is not stranded.
- Circle companion source-wallet preparation action when needed, generalized to all four funding chains, same-address verified against the session's own Arc address, fail closed on mismatch, ambiguity or an unsupported blockchain; preparation creates a wallet and performs no approval, deposit or transfer
- External wallet source deposits on all four funding chains, with a required switch to that exact chain, the active chain and account re-read from the connector after the switch, and the receipt awaited on the source chain rather than Arc
- Circle Gateway testnet service integration
- Gateway balance read, shared by both execution modes, depositor always the authenticated session wallet
- Circle user controlled same address Base Sepolia wallet preparation, verified against the session's own Arc address, fail closed on mismatch or ambiguity
- Circle Base Sepolia Gateway deposit path (`USDC.approve` then `GatewayWallet.deposit`, hosted Circle challenges)
- External Base Sepolia Gateway deposit path (server pinned transaction requests, receipt verified server side, plain ERC-20 `transfer` never used)
- External wallet EIP-712 Gateway burn intent signing (server returns the exact typed data, the connected wallet signs locally, the backend recovers and compares the signer before trusting it)
- Durable `gateway_funding_actions` database state, generalized additively: an `execution_mode` column, plus `destination_domain`, `source_plan_json`, `burn_intents_json`, `typed_data_list_json`, `signatures_json` and `circle_sign_challenges_json` for the destination-selected, multi-source model. `source_domain` is now nullable, every historical row is backfilled as `destination_domain = 26` (Arc, which those rows always targeted), and its original `source_domain` is left exactly as written. Historical rows still read, verify and reconcile: proved by `GATEWAY_FUNDING_LEGACY_ROW_COMPATIBLE=PASS`, which reconstructs a pre-correction row and submits it.
- Durable `gateway_deposit_actions` database state (new), baseline plus delta Gateway balance reconciliation for completion, never the source chain receipt alone
- Burn intent and signature preparation
- Recovery state for both the funding (burn intent) and deposit (approve/deposit) flows
- Reconciliation state
- An uncertain outcome is handled by read only reconciliation, never a blind retry, for both deposit and funding
- Phase-aware Circle Gateway deposit progression: approval polling returns immediately when the same backend action advances to `DEPOSIT_CHALLENGE`, deposit polling returns immediately when it advances to `RECONCILING`, and browser recovery is written as `DEPOSIT_CHALLENGE`, `DEPOSIT_PENDING`, then `RECONCILING` at each financial boundary
- Server-backed Gateway Activity projection for unresolved actions plus the ten newest terminal actions; it keeps durable post-submission work visible without treating it as interactive recovery
- One bounded Activity read and, only when needed, one shared Gateway balance read reconciles all `RECONCILING` rows against each row's own source-domain baseline plus amount; unmatched or failed reads remain durable and delayed
- Interactive recovery remains for pre-submission phases only. `RECONCILING` releases the local form lock into Activity, while the same-source backend guard still blocks a fresh action and a different source remains independently selectable
- Seven-day human application-session default, separate from every financial approval lifetime
- Circle official refresh-token rotation through encrypted, server-only credentials bound to the authenticated Circle wallet; refresh failure remains fail-closed to explicit Circle reauthentication
- Server side broadcast safety gate
- Payload binding covers the COMPLETE plan and the destination, not one intent: a swapped, dropped, reordered or retargeted allocation, an altered amount, an altered recipient or an altered destination all fail closed before submission. Canonical serialization keeps the same hash across JSONB key reordering.
- Fee-aware preparation reserves each returned `maxFee` against its source balance, rejects insufficient headroom before signature, chooses the lowest-fee valid one-source candidate when possible, and exact-estimates the deterministic multi-source fallback.
- Automatic source planning is bounded to canonical `TRANSFER_SOURCE_NETWORKS` domains `26, 6, 2, 3, 0`: it prices one-source candidates first, then advances source-count levels only when the prior level has no fee-safe plan, with a maximum of 31 candidate estimates and no unsupported-domain spendability in `transferableTotalRaw`.
- Multi-source signing model: one EIP-712 `BurnIntent` signature per source allocation, submitted as one array of `{ burnIntent, signature }` entries to `/v1/transfer?enableForwarder=true`. This is Circle's documented multi-source shape for this forwarding path. Circle's `BurnIntentSet` type definition is recorded and verified against the exact typehash string in Circle's own `evm-gateway-contracts` source, but is deliberately NOT signed: a set signature would require a set-shaped request body, and that body shape is not confirmed for this path, so signing one would mean inventing it.
- External partial-signature recovery is tail-only: the browser signs only the server-reported unsigned suffix, the API accepts no empty placeholders, and the durable server cursor persists each batch item at the next unsigned allocation in order.
- Source-wallet identity is checked server-side against the authenticated Arc EOA before a Circle companion wallet can be reported ready; mismatch, malformed address, unsupported domain and browser-supplied identity fields fail closed.
- Deterministic verification: `GATEWAY_DB_PREPARING_ROW_VALID=PASS`, `GATEWAY_FEE_SAFE_PLANNER=PASS`, `GATEWAY_FEE_AWARE_SOURCE_SELECTION=PASS`, `GATEWAY_SOURCE_PLANNER_BOUNDED=PASS`, `GATEWAY_CANONICAL_PAYLOAD_HASH=PASS`, `GATEWAY_JSONB_ROUNDTRIP_HASH=PASS`, `GATEWAY_EXTERNAL_PARTIAL_SIGNATURE_RECOVERY=PASS`, `GATEWAY_SOURCE_WALLET_SERVER_IDENTITY=PASS`, `GATEWAY_FUNDING_EXTERNAL_WALLET=PASS`, `GATEWAY_FUNDING_LEGACY_ROW_COMPATIBLE=PASS`, `GATEWAY_CANONICAL_NETWORK_CONFIG=PASS`, `GATEWAY_CIRCLE_BLOCKCHAIN_IDENTIFIERS=PASS`, `GATEWAY_FOUR_SOURCE_CHAINS=PASS`, `GATEWAY_SOURCE_CHAIN_RECONCILIATION=PASS`, `GATEWAY_DESTINATION_GENERALIZATION=PASS`, `GATEWAY_SAME_CHAIN_WITHDRAWAL=PASS`, `GATEWAY_BURN_INTENT_SET_TYPESTRING=PASS`, `GATEWAY_AUTO_SOURCE_PLANNER=PASS`, `GATEWAY_MULTI_SOURCE_INTENT=PASS`, `GATEWAY_FRONTEND_NEVER_CHOOSES_SOURCE=PASS`, `GATEWAY_MULTI_CHAIN_DEPOSIT=PASS`, `GATEWAY_ACTIVE_RECOVERY_RESUMABLE=PASS`, `GATEWAY_RESUME_STILL_BLOCKS_DUPLICATE=PASS`, `GATEWAY_RESUME_UI=PASS`, `GATEWAY_REVIEW_MESSAGE_RENDERED_ONCE=PASS`, `GATEWAY_ACTIVITY_SERVER_BACKED=PASS`, `GATEWAY_ACTIVITY_BATCH_RECONCILIATION=PASS`, `GATEWAY_ACTIVITY_ONE_GATEWAY_READ=PASS`, `GATEWAY_ACTIVITY_BACKGROUND_RELEASE=PASS`, `GATEWAY_ACTIVITY_DIFFERENT_SOURCE_CONCURRENCY=PASS`, `GATEWAY_ACTIVITY_SAME_SOURCE_GUARD=PASS`, `GATEWAY_ACTIVITY_INTERACTIVE_LOCK=PASS`, `GATEWAY_ACTIVITY_RELOAD_RECOVERY=PASS`, `GATEWAY_ACTIVITY_POLL_BOUNDED=PASS`, `GATEWAY_ACTIVITY_NO_FINANCIAL_SIDE_EFFECTS=PASS`, `GATEWAY_ACTIVITY_UI=PASS`, `GATEWAY_ACTIVITY_RESPONSIVE=PASS`, `GATEWAY_CIRCLE_TWO_CHALLENGE_FLOW=PASS`, `GATEWAY_CIRCLE_RESUME_PHASE_SYNC=PASS`, `GATEWAY_CIRCLE_FINALITY_RAIL=PASS`, `CIRCLE_SOURCE_WALLET_ALL_CHAINS=PASS`, `CIRCLE_BASE_WALLET=PASS`, `GATEWAY_DEPOSIT_EXTERNAL=PASS`, `GATEWAY_DEPOSIT_CIRCLE=PASS`, `GATEWAY_CIRCLE_MULTICHAIN_SECURITY=PASS`, zero live network calls in every case

CURRENT PRODUCTION SAFETY: `EXTREMA_ENABLE_GATEWAY_BROADCAST=false`

UI VISIBILITY STATUS: **IMPLEMENTED / VALIDATED, DUAL MODE.**

- The Gateway section renders for both Circle and external wallet sessions, not Circle only.
- The wallet page now shows TWO clearly separated jobs: `GATEWAY` (one unified balance, then Send USDC with a destination selector and an amount) and `ADD USDC TO GATEWAY` (one compact form with `FROM`, `AVAILABLE`, `AMOUNT`, and `ACTION`).
- There is NO source selector in the transfer surface. The only selector is the destination, whose options are exactly Arc Testnet, Base Sepolia, OP Sepolia, Arbitrum Sepolia and Ethereum Sepolia, rendered from the server's own canonical list.
- The unified balance is stated once, as one number, and the send amount is checked against the unified spendable total rather than any single source balance.
- Source wallet USDC and the Gateway unified balance are rendered as separate quantities and are never substituted for one another.
- The selected source shows its own read-only state: loading, wallet not prepared (Circle only), ready with a real balance, read error, deposit in progress, waiting for finality, and completed. A failed chain read shows an unavailable state and no number; a zero is only ever shown when the chain genuinely returned zero.
- While a deposit is interactive, the form remains bound to that source. After a source transaction is submitted, the action moves to server-backed Activity: `RECONCILING` releases only the local interactive lock, a different source can be selected, and the same-source backend guard still prevents a fresh duplicate action. The backend returns the authoritative recovery disposition: normal active pre-finality states (including `DEPOSIT_PENDING` and `DEPOSIT_VERIFIED`) return `RESUME` even when the same action carries durable challenge or transaction evidence; `RECONCILING`, `RECONCILIATION_REQUIRED`, and terminal `FAILED` or `EXPIRED` rows with evidence return `RECONCILE`; `COMPLETED` and terminal `FAILED` or `EXPIRED` rows with no financial evidence return `CLEAR`. Only `CLEAR` retires local recovery and unlocks a manual new deposit. No state triggers a blind retry or deletes the durable action.
- Responsive layout: four compact form columns on desktop, two columns at medium widths, one column on a phone. Borders, type and spacing only, in the existing editorial style; no bright colors and no dashboard-style filled tiles.
- Existing recovery remains visible. The transfer recovery record stores the destination and the amount (never a source domain) plus the allocation still being signed, and a reload restores the destination and amount and resumes the SAME action under the SAME request id. The deposit recovery record is per mode and carries its own source chain.
- Primary Gateway copy is in the i18n tables for both EN and TR, with no inline locale ternaries for it, and does not expose Gateway domain numbers, chain ids, burn intents, EIP-712, attestations or minting.
- A completed source deposit leaves the same compact form available with a human-readable confirmation. Changing the source only clears local form feedback; it does not create an action or initiate a Circle flow.
- `RECONCILING` renders as a compact Activity item: Deposit submitted → Waiting for Gateway finality → Completed. Its foreground polling is read-only, single-flight and bounded; hidden tabs pause until visible again. A single Activity request reconciles all unresolved rows with at most one Gateway balance read, preserves durable rows on read failure, and never starts or verifies financial work.
- Deterministic validation evidence: `GATEWAY_WALLET_UI=PASS`, `GATEWAY_SOURCE_FORM_UI=PASS`, `GATEWAY_SELECTED_SOURCE_BALANCE_UI=PASS`, `GATEWAY_ACTIVE_RECOVERY_RESUMABLE=PASS`, `GATEWAY_RESUME_STILL_BLOCKS_DUPLICATE=PASS`, `GATEWAY_RESUME_UI=PASS`, `GATEWAY_REVIEW_MESSAGE_RENDERED_ONCE=PASS`, `GATEWAY_ACTIVITY_SERVER_BACKED=PASS`, `GATEWAY_ACTIVITY_BATCH_RECONCILIATION=PASS`, `GATEWAY_ACTIVITY_ONE_GATEWAY_READ=PASS`, `GATEWAY_ACTIVITY_BACKGROUND_RELEASE=PASS`, `GATEWAY_ACTIVITY_DIFFERENT_SOURCE_CONCURRENCY=PASS`, `GATEWAY_ACTIVITY_SAME_SOURCE_GUARD=PASS`, `GATEWAY_ACTIVITY_INTERACTIVE_LOCK=PASS`, `GATEWAY_ACTIVITY_RELOAD_RECOVERY=PASS`, `GATEWAY_ACTIVITY_POLL_BOUNDED=PASS`, `GATEWAY_ACTIVITY_NO_FINANCIAL_SIDE_EFFECTS=PASS`, `GATEWAY_ACTIVITY_UI=PASS`, `GATEWAY_ACTIVITY_RESPONSIVE=PASS`, `GATEWAY_ACTIVITY_POSTGRES_TYPES=PASS`, `GATEWAY_DEPOSIT_RECONCILIATION_REQUIRED_PRESERVED=PASS`, `GATEWAY_UNCERTAIN_RECOVERY_FAILS_CLOSED=PASS`, `GATEWAY_CLEAN_TERMINAL_RECOVERY_RELEASE=PASS`, `GATEWAY_POINTER_FOCUS=PASS`, `GATEWAY_HEADER_ACCOUNT_FOOTPRINT=PASS`, `GATEWAY_SESSION_CONTROLS=PASS`, `GATEWAY_DEPOSIT_LIVE_NETWORK_CALLS=0`, `WALLET_PAGE_DEPOSIT_RECOVERY_LIVE_NETWORK_CALLS=0`, `LIVE_GATEWAY_BROADCAST=NOT_EXECUTED`.

LIVE PROOF STATUS: **OPEN / NOT LIVE PROVEN.** Circle Base Sepolia and the controlled Circle Arbitrum source deposits below are live proven through Gateway credit/finality; no Gateway transfer flow, OP/Ethereum source deposit, or external-wallet full flow is live-proven.

Live proven in production, Circle mode, for `0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876`:

- Circle Base Sepolia companion EOA preparation succeeded, same address as the Arc EOA.
- Base Sepolia source held 20 test USDC; Base native gas was funded.
- The hosted Circle `USDC.approve(GatewayWallet, 2000000)` and `GatewayWallet.deposit(Base USDC, 2000000)` challenges were explicitly approved by the user.
- The durable `2 USDC` deposit action reconciled successfully to `COMPLETED`.
- Base Sepolia deposit transaction: `0x42aed5ef50095267af069f9519c079239f5cb509e79db7b3c040a0848cedc095`; Circle deposit challenge `22c00fd0-d2d8-5a89-838d-3282722b44b9`, Circle transaction `bc1d3b5c-3822-5791-a2e2-1fd0c30d7bcb`.
- Production reconciliation proof: Base USDC `20 → 18`, Gateway allowance `2 → 0`, Gateway domain-6 unified credit `2 USDC`, and total Gateway unified balance `2 USDC`.
- The effective production human application session lifetime is `604800` seconds / seven days.

This proves the Circle source deposit and Gateway credit/finality only. It does not prove a Gateway → Arc transfer, an external-wallet full Gateway flow, or the finality animation in production.

Live proven in production, Circle mode, for the preserved Arbitrum Sepolia action:

- Circle wallet: `0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876`.
- `actionId`: `08bc51a6-f404-433f-8565-dcce8871e2e8`; `requestId`: `832f4878-e0b5-4bd1-8518-c6c7c6777115`; `sourceDomain`: `3`; `sourceChainId`: `421614`; `amountRaw`: `1000000`.
- Approval challenge `eb639625-47fd-5b48-ad6c-1fda94fd7cb5` has Circle transaction `4e7e6522-291e-5799-9a14-5d4efd4209d9` and source-chain approval transaction `0x0d4ad6ec3fe6c02adb6933fc55443aabde1e987f00f69627e244f34e7ad2b964`.
- The preserved deposit challenge `5248643d-fe9c-52da-b1ab-c9589f3b47f5` was explicitly approved and reconciled through the same durable action. Production observed source domain 3 / Arbitrum balance `20 → 19 USDC`, Gateway domain-3 unified balance `2 → 3 USDC`, and the Wallet confirmation `1.00 USDC added to Gateway`.
- Deposit Circle transaction id: `2ba28e50-d3a1-570e-be54-3d46646cd37d`; deposit transaction: `0xc42303982626d63cda6ba7b4fc78feb4bf5f090c6b770f6052cf293675965579`.
- Boundary: **Arbitrum approval, deposit submission, Gateway credit/finality and source flow are LIVE PROVEN.** Gateway → destination transfer remains **NOT LIVE PROVEN**; this exact action was preserved and no replacement action was created.

Still NOT LIVE PROVEN after the unified balance correction (all newly generalized work is deterministically validated only):

- Gateway to Arc transfer
- Gateway to Base Sepolia transfer
- Gateway to OP Sepolia transfer
- Gateway to Arbitrum Sepolia transfer
- Gateway to Ethereum Sepolia transfer
- OP Sepolia and Ethereum Sepolia source deposits
- External-wallet full Gateway flow
- Multi-source aggregated Gateway transfer
- Same-chain Gateway withdrawal
- The live Activity/finality visual in production

Still required:

- [x] Read only production prerequisites for the Circle approval stage (funded Base Sepolia source, prepared companion EOA)
- [ ] Circle Gateway to Arc: obtain explicit approval before one controlled real burn intent transfer and destination reconciliation
- [ ] Multi-source aggregated transfer: one controlled real transfer drawing on more than one source domain
- [ ] External Base Sepolia to Gateway to Arc: one controlled real deposit, then one controlled real burn intent transfer
- [ ] Explicit Koray approval before enabling broadcast
- [ ] Transaction, transfer ID and destination reconciliation proof
- [ ] Post transfer balance and status verification
- [ ] Return the broadcast gate to its intended safe state if appropriate

Gateway is never marked complete only because deterministic tests pass.

### Final hackathon acceptance work

The project is feature frozen for submission. No architecture changes, refactors, or new product features are planned unless a reproduced P0 submission blocker requires one.

The complete list of remaining work, in priority order, lives in the [Current roadmap](#current-roadmap) at the end of this document.

---

# 0. Infrastructure baseline and legacy proof record

These items are real infrastructure, but they are **not substitutes for onchain proof**.

The historical human-wallet proof entries in this section predate the final
human-wallet migration. They remain as evidence of what was executed at that
time; they are not an active passkey or backend-wallet implementation claim.

- [x] Railway backend deployed and reachable
  - Proof:
    - `/readyz -> {"ok":true,"service":"extrema-backend"}`
    - `/health -> {"ok":true,"database":"connected"}`
- [x] PostgreSQL connected on Railway
- [x] Backend runs on Node 22 Docker image
- [x] Frontend dependency audit clean
  - Proof: `npm audit -> found 0 vulnerabilities`
- [x] Frontend build/typecheck passes
  - Proof: `npm run check:all -> PASS`
- [x] Owner-wallet signature flow works
- [x] Passkey registration flow works in current Codespace environment
- [x] Backend creates a real EVM EXTREMA wallet
- [x] Private key is disclosed once to the user at wallet creation
- [x] Reconnect flow verified end-to-end with owner wallet + passkey
  - Browser proof (2026-09-05): session was disconnected, owner wallet reconnected, passkey authentication completed, and the same EXTREMA wallet/onchain balance state was restored without raw auth errors.
- [x] Fresh passkey step-up authorization implemented for critical transaction signing
  - Backend proof:
    - `npm run backend:check -> PASS`
    - Railway `/readyz -> {"ok":true,"service":"extrema-backend"}`
    - action authorization database migration runs before backend readiness
  - Browser/onchain proof:
    - fingerprint/passkey confirmation completed for ETH Daily Low Round #1
    - exact prediction-bound action was followed by real Arc Testnet entry tx `0xf017bdbd00b4cf4bad6fd006d148e6b30210d3a7b15f3cbcaac389a7e7fea312`

---

# 1. Arc Testnet wallet state

## 1.1 Real chain identity

- [x] Frontend and backend both verify Arc Testnet chain ID `5042002`
- [x] EXTREMA wallet address is shown with Arc Testnet explorer link
- [ ] Wrong-network state is detected and blocked for transaction actions
- [ ] Switch-to-Arc-Testnet action is verified

### Proof record

- Chain ID: `5042002`
- Wallet address: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Explorer: `https://testnet.arcscan.app/address/0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Verification date: 2026-09-04
- Notes: Backend RPC state read and wallet UI both reported Arc Testnet / chain ID 5042002. Wrong-network rejection/switch still requires explicit test.

## 1.2 One Arc USDC asset (native + ERC-20 interfaces)

Implementation status: verified on Arc Testnet.

- [x] Read the native Arc USDC interface through RPC for technical fee checks
- [x] Read the canonical ERC-20 USDC `balanceOf` in 6-decimal raw units
- [x] Keep native and ERC-20 reads as one underlying asset (never summed)
- [x] UI displays one canonical Arc USDC balance only

### Proof record

- Wallet: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- RPC: `https://rpc.testnet.arc.network`
- Balance: `40.0 USDC`
- Native-interface decimals: `18` (same USDC asset)
- Balance raw: `40000000000000000000`
- Block number: `60464221`
- Verification: `backend/scripts/verify-native-balance.js` returned `verified: true`, chain ID `5042002`, native currency `USDC`, and formatted balance `40.0`; this is a technical interface read, not a second token balance.

## 1.3 Real Arc Testnet USDC balance

Implementation status: real Arc RPC/USDC balance reader and wallet UI are wired; **proof is still pending**, so no checkbox below is marked complete yet.

Target token:

`0x3600000000000000000000000000000000000000`

- [x] Verify token contract exists on Arc Testnet
- [x] Verify token metadata/decimals from chain
- [x] Read EXTREMA wallet `balanceOf` from the token contract
- [x] Remove `Demo USDC balance`
- [x] Remove `Get 10 demo USDC`
- [x] UI displays only the real onchain USDC balance
- [x] Real testnet funding path established
- [x] Funding transaction verified onchain

### Proof record

- Token address: `0x3600000000000000000000000000000000000000`
- Decimals: `6`
- Wallet: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Balance before recorded faucet funding: `0 USDC`
- Funding tx #1: `0x0e50444ff84050f6f32efe9d6d8a84e8c435d4c8bcc251556f27e695f11dd699`
  - Status: success (`1`)
  - Block: `60461373`
  - Amount: `20.0 USDC`
  - From: `0x3C3380cdFb94dFEEaA41cAD9F58254AE380d752D`
  - To: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Funding tx #2: `0x9264cc9b2cda96b132fa053751b034fadf6f53d60b4a05d8d6c102d6d4d99b8a`
  - Status: success (`1`)
  - Block: `60461361`
  - Amount: `20.0 USDC`
  - From: `0x319dd63E0AC72e7Ac74443029d074032c043460F`
  - To: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Explorer tx #1: `https://testnet.arcscan.app/tx/0x0e50444ff84050f6f32efe9d6d8a84e8c435d4c8bcc251556f27e695f11dd699`
- Explorer tx #2: `https://testnet.arcscan.app/tx/0x9264cc9b2cda96b132fa053751b034fadf6f53d60b4a05d8d6c102d6d4d99b8a`
- Balance after: `40.0 USDC`
- Verification: `backend/scripts/verify-funding.js` returned `allVerified: true`, chain ID `5042002`, and `totalUsdcToWallet: 40.0`.

---

# 2. Smart contract foundation

No pool entry, NFT, settlement, refund, or claim is considered real until this section is complete.

Architecture specification: `contracts/ARCHITECTURE.md`

## 2.1 Contract architecture locked

- [x] Define final contract responsibilities
- [x] Define immutable/constants:
  - Arc Testnet chain ID
  - USDC token address
  - treasury address
  - stake amount = exactly 1 USDC
  - payout percentages
- [x] Define round state machine
  - `ENTRY_OPEN`
  - `LOCKED`
  - `SETTLED`
  - `CANCELLED`
- [x] Define round identity by `roundId`, not market slug
- [x] Define one-entry-per-wallet-per-round rule
- [x] Define one-exact-price-per-round rule
- [x] Define minimum 3 entries or cancel/refund
- [x] Define winner ordering:
  1. absolute distance
  2. earlier onchain entry
  3. transaction/log index
- [x] Define payout split:
  - 1st: 54%
  - 2nd: 22.5%
  - 3rd: 13.5%
  - treasury: 10%
- [x] Define ERC-721 ticket ownership as claim-right ownership

## 2.2 Contract tests

- [x] Unit tests for round creation
- [x] Unit tests for entry
- [x] Unit tests for duplicate-wallet rejection
- [x] Unit tests for duplicate-price rejection
- [x] Unit tests for entry close
- [x] Unit tests for settlement
- [x] Unit tests for winner ranking
- [x] Unit tests for payout accounting
- [x] Unit tests for cancellation
- [x] Unit tests for refunds
- [x] Unit tests for NFT transfer and claim-right transfer
- [x] Unit tests for double-claim prevention

### Proof record

- Verification date: 2026-09-05
- Commands:
  - `forge test -vv`
  - `forge build --sizes`
- Test result: `31 passed; 0 failed; 0 skipped`
- Test exit: `0`
- Size exit: `0`
- Suites:
  - `ExtremaPoolLifecycleTest`: 8/8 PASS
  - `ExtremaFactoryTest`: 5/5 PASS
  - `ExtremaPoolEntryTest`: 5/5 PASS
  - `ExtremaTreasuryTest`: 3/3 PASS
  - `ExtremaRendererTest`: 2/2 PASS
  - `ExtremaTicketTest`: 8/8 PASS
- Production contract sizes:
  - `ExtremaFactory`: runtime 20,609 B; margin 3,967 B
  - `ExtremaPool`: runtime 10,567 B; margin 14,009 B
  - `ExtremaRenderer`: runtime 8,115 B; margin 16,461 B
  - `ExtremaTicket`: runtime 3,865 B; margin 20,711 B
  - `ExtremaTreasury`: runtime 1,368 B; margin 23,208 B
- Covered additionally:
  - all 24 unique pool identities
  - separate NFT collection per pool
  - dual treasury controller withdrawals
  - treasury isolation from player escrow
  - resolver rotation without escrow authority
  - renderer rotation
  - per-round escrow accounting and invariant
  - accidental excess USDC rescue only
  - fully onchain tokenURI
  - HIGH/LOW artwork separation
- Local contract gate passed. Remaining Foundry warnings are documented in `contracts/SECURITY_NOTES.md`; test-only style warnings do not block deployment.
- Next gate: Arc Testnet deployment simulation and onchain deployment proof.

## 2.3 Arc Testnet deployment

- [x] Full Arc Testnet deployment simulation completed without broadcast
- [x] Deploy 24 pool contracts to Arc Testnet
- [x] Deploy 24 paired ERC-721 ticket collections through pool deployment
- [x] Configure treasury contract
- [x] Configure Arc Testnet USDC
- [x] Verify deployed bytecode/contracts and complete topology reads
- [x] Record deployment transactions

### Simulation proof

- Verification date: 2026-09-05
- Chain ID: `5042002`
- Result: `SIMULATION COMPLETE`
- Broadcast: **NO**
- Predicted addresses matched the subsequent broadcast addresses.
- Estimated amount required: `5.44726989 USDC`

### Broadcast proof

- Verification date: 2026-09-05
- Chain ID: `5042002`
- Result: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`
- Successful transactions: `27`
  - 3 core deployments
  - 24 `deployPool(asset,direction,cadence)` calls
- Deployer / Pool Admin: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Resolver: `0x1EDC4594195fFb134315c3258DE974563Ed9762A`
- Arc Testnet USDC: `0x3600000000000000000000000000000000000000`
- Factory: `0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A`
  - deployment tx: `0xf8422d3282092cd8e3dd770dbbb3e2c529442705b51816b860badfb77f3be836`
- Treasury: `0x1D00C89Ed4AF7227a858D305183B4037f732b87e`
  - deployment tx: `0x7cf1791378a54820620f5b9c66e9e00be755b99127708dd230aa7f79ede4ce61`
- Renderer: `0x1C52E55B8CC91A8E327BDDA8E0FAE33bC41fEe1c`
  - deployment tx: `0x7956c50122db1b611013982004b36cba7d25f499d569a444aa1c3c4abc53cf94`
- 24 pool deployment transactions:
  - `0xf3d15fc1758f39c7e04e9a0c3c2d899564e32b33920c9c1ab851d0ff1debc9ae`
  - `0x76a47a49163970d9f113322ec67f37e07da61612977e98d766b894016143df98`
  - `0x2178f2f1fd9dfbf73a71c8f241bcc677448c417b53df6ceca172d039c035f84c`
  - `0xe15e60077c9fe4071b5ef1064bc489ef73fcb4c3f252654aa23e8b2699a89def`
  - `0xd34f316d442992653ad6dda5597ea0d1bf31dfd57d1baf0767452e6bdf90b68b`
  - `0x3c59dea1a1d24b0d750353a5314854396ef230cc02b3b00d940413faa5a47723`
  - `0x4722ab3cf0ffb2a3efe08c5248b05067826768eb32e31e0cc865bf0c026eb57e`
  - `0x81b6dc2fe572123daea73d58108b2a7a7720f661ab6c55c90e2291d35cac6130`
  - `0x818e6a95c5dea7461d79aaa2764b77c1b65a3bf257d4f825977f143f39e37789`
  - `0x55adbfc44345ff15b7627793af9c22cfea3fa870ac644fef2534d5d458d661bb`
  - `0x86fc896efd7f27eb34858b2f2dfb62d367dc9db023e47a40442308af399dd446`
  - `0x34fe0301c7fdb16008cd261c84f1998c06a668a96a04906a337a791a6850f30d`
  - `0x4935fcbd43616df0a7b9a64a1031ad2752348c6a6ce7ed028ca5ab50e2987fc2`
  - `0x2284351decfdb33fc381cf8c191097944097c55b6814ee2bddffd8d98ec91e18`
  - `0x71df3baecbe5bf138c56d8ece64057879c40f8e14862158a01d7e7db13b727b4`
  - `0x9bb148e22934fc36107bcb08d21b6dfb248e646a8760329be0b39d11029c7a48`
  - `0x2f31f107104ee7df8b8b6dffa364707d21c5227ed1d1c8637fcb3f8bcacf9dbf`
  - `0x44d4b396d40165ef8f4d31ee88b404b57194478def85652d43bd8ef80e4bf8ee`
  - `0x4009437117710cdd7801f0f62b71ad39dbd0b93b3e253c1d8989afd185e9b613`
  - `0x21bd4c2743e03f3e0f7a8399fc697b2773d0c065e332d03379837d271eb8c231`
  - `0x0f862d192336b27a1952bf3796c597da61bb234e30831163505fb24dcef32cab`
  - `0x40dc046ba52773323fd75ae923f8bb2716ae9b0ad03de2c3c5c0a1120d6669f3`
  - `0x93b58f220c6ef6e0405fde3f19787c5fd8cd3b2520bfbfe63a1bf860d38a4d50`
  - `0x1fe9e906d9543d994ae698b33f84676cb641e8bb3f4d6a6ad3c3846f47301c9a`
- Total paid: `2.119636575 USDC`
- Broadcast artifact: `broadcast/DeployArcTestnet.s.sol/5042002/run-latest.json`
- Note: each pool deployment creates its paired ExtremaTicket internally; ticket addresses still require explicit topology verification/readout.

### Verification proof

- Verification date: 2026-09-05
- Command: `forge script script/VerifyArcDeployment.s.sol:VerifyArcDeployment --rpc-url https://rpc.testnet.arc.network -vvv`
- Result: `Script ran successfully.`
- The verification script checked onchain:
  - factory pool count = 24
  - Arc Testnet USDC address
  - treasury address
  - pool admin
  - resolver
  - renderer
  - all 24 pool identities
  - all 24 pools use the expected treasury/USDC/admin/resolver
  - every pool has a nonzero ticket collection
  - all 24 ticket collection addresses are distinct
  - every ticket collection uses the expected renderer
- Treasury controller direct reads:
  - `CONTROLLER_A() -> 0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321`
  - `CONTROLLER_B() -> 0x99677aab4b168c274A34525D526346fC47Fab72c`
- Explicit topology readout:
  - Command: `./script/print-arc-topology.sh`
  - Chain ID: `5042002`
  - Factory: `0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A`
  - Result: `POOL_COUNT=24`, `TOPOLOGY_PRINT=PASS`

| # | Asset | Direction | Cadence | Pool | Ticket |
|---:|---|---|---|---|---|
| 1 | BTC | HIGH | DAILY | `0xc724050511Df7CC0cb7aFC688cbcc9C2A16dC36d` | `0x3c04c15025731A07772018e8609a8af7212d8801` |
| 2 | BTC | HIGH | WEEKLY | `0xE7d18196075227F0b264F3612942b02e0FedC1d1` | `0x5e39A234c7654d3f005Ec5d2bEb014c159a9D38d` |
| 3 | BTC | HIGH | QUARTERLY | `0x7573cD9Ff84afda1e1f46Ab59f6Ff3dc4c0106A0` | `0xD6F2545F00eefaA00c02cEcaFfBb4EC33532c603` |
| 4 | BTC | LOW | DAILY | `0x18e34fF5527637fdA1C13297DAcbEE7c08e69dad` | `0x9BF5C34B23658a9aC06C0A47B59d9B90350e735E` |
| 5 | BTC | LOW | WEEKLY | `0x74a1Fc98876C2c7E792eB2F7577a908620F68f89` | `0x468f1485cDfF194114Bd3fC7b126EbdbBa704e0A` |
| 6 | BTC | LOW | QUARTERLY | `0x842A2F152a9b5aD7E9b7CB651DE59eD53040dBD0` | `0xEa6d00b5E473c5647f1B8CdceD8E56653181Afd3` |
| 7 | ETH | HIGH | DAILY | `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f` | `0xF65Cf4a67299ad596e139e3F6a9594E809F05637` |
| 8 | ETH | HIGH | WEEKLY | `0x7c2e9C3221534F24ecA83949D4f7249c95C35c33` | `0xd20a69DB0A957D6f285b6Af67fed653d65cD7E5d` |
| 9 | ETH | HIGH | QUARTERLY | `0x6652e6F150e889Be15fbD6608A70e03aB7048d48` | `0x070C0153F1DCa041FdE84C581f12Ef832f3F50B8` |
| 10 | ETH | LOW | DAILY | `0x490A5CE02E3fd85d51095A69AAE9511552d91095` | `0x6FC6756af39fb520844EdA73D6855990e56049E1` |
| 11 | ETH | LOW | WEEKLY | `0x8ec016AE0376Bf7d893Be4BeA6Fb1C57AAabf718` | `0xa2F82BE41567D7BE6F7F2Ba435D23068eE2A2212` |
| 12 | ETH | LOW | QUARTERLY | `0xBD70a2F01F8524C4858A9A26AEdF82dC936da789` | `0xDb6761e9eeD6e52E3bb42FB0157b3818a2BF6b16` |
| 13 | SOL | HIGH | DAILY | `0xb81C2551cb757Cd51ABfCa3db4e876820634c76c` | `0x7Fb08d5A0d168De4CE479FC21C1E45fF35353F9C` |
| 14 | SOL | HIGH | WEEKLY | `0x7b24aFccf1f63545A36cd41a30c4846aBFb17CF8` | `0x534d90A4E4314f4A54E3eBd4D0cBe276E7CdD92A` |
| 15 | SOL | HIGH | QUARTERLY | `0xC5BA26016387e2c041d136779D1dE8d02DEf5c50` | `0x18c6b2c1Aad92321E83a39D92Fc621ffCDD51264` |
| 16 | SOL | LOW | DAILY | `0xdf1bE0356E5207f8aB96598c289823B488478fF5` | `0x174a3f5C207875f059171f35399869D60F792190` |
| 17 | SOL | LOW | WEEKLY | `0x5341Ca1e1257555a8bAceF969f3F3e06C6583f48` | `0x4BC109D7347855b5096B84BC6194Fe0d34a17bf4` |
| 18 | SOL | LOW | QUARTERLY | `0xc3b87D6C96924C107148D3db01dcDFcddFfCF981` | `0xD2b407294F18ec833c6BED915437832cdd235e6d` |
| 19 | HYPE | HIGH | DAILY | `0x97563B5DE4019311529c405ac78F59D74A001894` | `0x6e40BCedcb29b7E5e509F15d3f4C4380a5C670e2` |
| 20 | HYPE | HIGH | WEEKLY | `0xc699665f2BB38f7545C6bC1226755046F48A4D63` | `0xa7e359d2dF9E94B1E829f56016A7D879C53C63BC` |
| 21 | HYPE | HIGH | QUARTERLY | `0x8EFEEdfF439c772dcD040E36F43767F67B229C74` | `0x3cA0498a01c2D2D4a687E68791f77a542AF88d14` |
| 22 | HYPE | LOW | DAILY | `0x429329Efcd2c20198aB99EbF2459Be649864337C` | `0xAff6f3b5C2947368545B012c9689df2eC55997Bb` |
| 23 | HYPE | LOW | WEEKLY | `0xE936A4125360562390d8202911d767DAb2FA4852` | `0x0A4C0AA2D0ff801AC774167c69A44b4F1210B404` |
| 24 | HYPE | LOW | QUARTERLY | `0x8F921fDc4C02D46a02B85dAd0b2F3dF23303505b` | `0x84B9C1AdC20333022064234BaC11A1C786Cf08fC` |

**Section 2.3 status: COMPLETE.** Deployment, role wiring, treasury controllers, 24 pool identities, and 24 distinct ticket collections are all proven on Arc Testnet.

---

# 3. Real round creation

Locked UTC cadence boundaries:

- DAILY: observation 00:00 UTC → next day 00:00 UTC; entry closes exactly 4 hours before observation start
- WEEKLY: Monday 00:00 UTC → next Monday 00:00 UTC; entry closes exactly 24 hours before observation start
- QUARTERLY: first day of quarter 00:00 UTC → first day of next quarter 00:00 UTC; entry closes exactly 24 hours before observation start
- MONTHLY is not part of the current 24-pool architecture

Assets:

- BTC
- ETH
- SOL
- HYPE

Directions:

- High
- Low

Cadences:

- Daily
- Weekly
- Quarterly

Target: **24 standard pool templates**, each creating distinct onchain rounds.

- [x] Backend round model connected to onchain `roundId`
- [x] Daily round creation verified
- [x] Weekly round creation verified
- [x] Quarterly round creation verified
- [x] High direction verified
- [x] Low direction verified
- [x] BTC verified
- [x] ETH verified
- [x] SOL verified
- [x] HYPE verified
- [x] Entry-open timestamp stored onchain
- [x] Entry-close timestamp stored onchain
- [x] Daily entry-close offset locked at 4 hours before observation start
- [x] Weekly entry-close offset locked at 24 hours before observation start
- [x] Quarterly entry-close offset locked at 24 hours before observation start
- [x] Standard UTC observation boundaries locked
- [x] Observation start/end stored or deterministically represented
- [x] UI reads real round state from chain/backend indexer
- [x] Remove hardcoded `Players`, `Pool`, and `ENTRY_OPEN` values

### Proof record

#### No-broadcast Round #1 simulation

- Verification date: 2026-09-05
- Arc block time used for plan: `2026-09-04T23:00:46Z`
- Chain ID: `5042002`
- Result: `createdRounds: 24`
- Result: `SIMULATION COMPLETE`
- Result: `STANDARD_ROUND_SIMULATION=PASS`
- Broadcast: **NO**
- Estimated gas: `2,650,904`
- Estimated native-interface fee cost (same underlying USDC): `0.131219748 USDC`
- Daily Round #1 plan:
  - entry close: `2026-09-05T20:00:00Z`
  - observation: `2026-09-06T00:00:00Z -> 2026-09-07T00:00:00Z`
- Weekly Round #1 plan:
  - entry close: `2026-09-06T00:00:00Z`
  - observation: `2026-09-07T00:00:00Z -> 2026-09-14T00:00:00Z`
- Quarterly Round #1 plan:
  - entry close: `2026-09-30T00:00:00Z`
  - observation: `2026-10-01T00:00:00Z -> 2027-01-01T00:00:00Z`
- Dry-run artifact: `broadcast/CreateStandardRounds.s.sol/5042002/dry-run/run-latest.json`

#### Arc Testnet Round #1 broadcast proof

- Verification date: 2026-09-05
- Chain ID: `5042002`
- Result: `createdRounds: 24`
- Result: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`
- Result: `STANDARD_ROUND_BROADCAST=COMPLETE`
- Successful transactions: `24`
- Blocks: `60484923` and `60484925`
- Total paid: `0.04617 USDC`
- Total gas: `1,846,800`
- Average gas price: `25 gwei`
- Broadcast artifact: `broadcast/CreateStandardRounds.s.sol/5042002/run-latest.json`
- Creation transaction hashes:
  - #1: `0x6c0898099e77944c80d62c65513d464d497b6e659faa9e1aa9577b201858ed8b`
  - #2: `0x02a0ad77a71148be589489618914e65a9948390761a841a703fc6be2ace98591`
  - #3: `0xc000170d9b2968099b20d768431664e64940581fac284d59d444f663aa41c7b7`
  - #4: `0xd51d13d5674b6c71418ed36516ccda1f49c821ad6a2595d089899170fc1433e2`
  - #5: `0xd3bcca15e0157b226f7d1b633bc1111e2598b3f780c1d05dc3d03f1bec7e72b3`
  - #6: `0x28ea47c6349433fca2ce56d3c63b99c53c6c1e203fd0e9f4266070ba06667112`
  - #7: `0x3732fe8c82b8816ff663fd1a4acb32b038702ba0562db22106dd5841b69d8314`
  - #8: `0x1a9353677d96a08cb616f9dad519ee12719151a732eabe338dff19a7ebeb3b08`
  - #9: `0x69f979904850ed7efce36571f1eb70124601d8f10e642e61e3fa259ec85d38a7`
  - #10: `0x7732b5af116e7fd96cc27fbc59777f08390551aa18e9a2d5ef8656c298a47aad`
  - #11: `0x64e680a5605e5aa9c71195fb79f59fee432b5b23921c8262663bb65272987117`
  - #12: `0x9b245c3a1df6048b513977a7516c463d57686ce386ebc2ee57085ddbdaf3f76c`
  - #13: `0xf10a70683319f0fcb9ba26777b8bbc299e8f5da8ce2f4d8026570c0a438f9fee`
  - #14: `0x0c23365722ccbe0ea2d9852e0d5a39eb9c686b0f4ff14105cb9969d1622f5ecd`
  - #15: `0xf783f4d09f4281b68334d0dfa21f51dd8a49ba62c87a6340f520194c810cd86c`
  - #16: `0xf9e8bb35439bb3df14eb0688018c8876957f10474792a8e04d0ad28445065ac6`
  - #17: `0x30f87f390e11173fecbd88b8706288a089db8ea75fa788335adfc567103f1da2`
  - #18: `0x006bf8665adb4e9afc55af544e25c29658de5c99138834fb11d0fe2e8b8d30e0`
  - #19: `0xa426ce6f1bf98cfbe2837e61dba1a99e484e016fd1983849c70d9349f6984614`
  - #20: `0xa07584119ab36328e955db484f3b9b4cbc9115c5b9d7817e98587a730d967909`
  - #21: `0xf747ba14ce4aa6199e8969c39afeb3a275f69b7bf9871be078dd73869cb2cf8c`
  - #22: `0xadbe77a1c2a88aaf118487b4039acfbf1346fb970658d8379dad6c0888f6e965`
  - #23: `0x2ab6a455a49fcacd4ed7ad217ad7ad683c46b88b4dba267c80bce273d46608b0`
  - #24: `0x5b39ca15a7a4d74d95ef1d1896af5fe71cf083931a9750108dfcac1acd3f8d50`

#### Browser runtime proof

- Verification date: 2026-09-05
- Route: `/pools`
- Browser rendered real Round #1 cards from the backend live-round API.
- Visible runtime state included:
  - `Round #1`
  - `0 Players`
  - `0.0 USDC`
  - `ENTRY_OPEN`
  - real Daily / Weekly / Quarterly entry-close timestamps
- The zero player / zero pool values are expected onchain state because no real prediction entries have been submitted yet.
- No mock player counts or mock pool balances were shown.
- Performance issue observed: first live-round load was delayed because the backend refreshed all 24 pools from Arc RPC on the request path.
- Performance fix: backend now keeps a 15-second in-memory live-round snapshot, serves the last confirmed snapshot immediately, refreshes stale data in the background, warms the snapshot at process start, and supports `?fresh=1` for an explicit fresh read when needed.
- Railway runtime proof after the cache deployment: `GET /api/rounds` returned poolCount `24` at Arc block `60496565` in `0.385s`.

**Section 3 status: COMPLETE.** Real Round #1 creation, backend reads, and browser pool state are all tied to Arc Testnet.

#### Frontend live-round integration build proof

- Verification date: 2026-09-05
- Commands:
  - `npm run typecheck`
  - `npm run build`
- Result: both commands passed twice consecutively after wiring the pool UI to the backend live-round API.
- Next.js version: `16.3.4`
- Production build: `Compiled successfully`
- Dynamic routes confirmed:
  - `/pools/[slug]`
  - `/rounds/[slug]`
  - `/api/extrema/[...path]`
- The frontend source no longer uses hardcoded pool/player/status values on the normal `/pools`, `/pools/[slug]`, or `/rounds/[slug]` paths.
- Browser/runtime proof is still required before checking the two UI completion items below.

#### Backend live-round read proof

- Verification date: 2026-09-05
- Command: `npm --prefix backend run verify:rounds`
- Result: `verified: true`
- Chain ID: `5042002`
- Factory: `0xa7Bff22811Bb1BA9297DFaA611De58E3bc186D7A`
- Pool count: `24`
- Verified assets: BTC, ETH, SOL, HYPE
- Verified directions: HIGH, LOW
- Verified cadences: DAILY, WEEKLY, QUARTERLY
- Sample `btc-daily-high`:
  - pool: `0xc724050511Df7CC0cb7aFC688cbcc9C2A16dC36d`
  - ticket: `0x3c04c15025731A07772018e8609a8af7212d8801`
  - roundId: `1`
  - status: `ENTRY_OPEN`
  - canEnter: `true`
  - entryOpenAt: `2026-09-04T23:04:57.000Z`
  - entryCloseAt: `2026-09-05T20:00:00.000Z`
  - observation: `2026-09-06T00:00:00.000Z -> 2026-09-07T00:00:00.000Z`
  - entryCount: `0`
  - totalStake: `0.0 USDC`
  - escrowRemaining: `0.0 USDC`
- Public Arc RPC rate-limit handling was verified by replacing burst reads with sequential reads plus retry only for explicit `-32005` rate-limit responses.
- No mock/fallback round state is used by this backend read path.

#### Arc Testnet Round #1 verification proof

- Verification date: 2026-09-05
- Command: `./script/verify-standard-rounds.sh`
- Chain ID: `5042002`
- Result: `Script ran successfully.`
- Result: `verifiedRounds: uint256 24`
- Result: `STANDARD_ROUND_VERIFICATION=PASS`
- Verified across all 24 pools:
  - `nextRoundId() == 2`
  - Round #1 exists
  - `entryOpenAt` is nonzero and before entry close
  - `entryCloseAt` matches the exact saved cadence plan
  - `observationStartAt` matches the exact saved cadence plan
  - `observationEndAt` matches the exact saved cadence plan
  - status = `ENTRY_OPEN`
  - `entryCount == 0`
  - `totalStake == 0`
  - `escrowRemaining == 0`
- Because the 24-pool topology covers every combination of BTC/ETH/SOL/HYPE × HIGH/LOW × DAILY/WEEKLY/QUARTERLY, cadence, direction, and asset round-creation checks are proven onchain.
- The stale Foundry artifact warning is non-blocking; the verification script compiled and completed successfully.

### 3.1 Automated round creation

Round #1 for all 24 pools was created by a one-time broadcast script. Ongoing creation of subsequent rounds is handled by the lifecycle automation in `backend/src/services/roundAutomationService.js`, which runs continuously on Railway.

- [x] DAILY round creation automated
  - `ensureCurrentDailyRoundsInternal()` selects the DAILY subset of the pool topology, computes the canonical schedule from chain time, verifies the pool cadence enum before writing, and calls `createRound` from the pool owner wallet.
  - Owner authority is required: `createRound` is `onlyOwner`.
  - Multi-instance safety uses a PostgreSQL advisory lock so two Railway instances cannot create the same round twice.
- [x] WEEKLY round creation automated
  - `ensureCurrentWeeklyRoundsInternal()` routes the WEEKLY topology through `ensureCurrentCadenceRoundsInternal()`.
  - `currentWeeklySchedule()` derives the Monday-to-Monday UTC market period and closes entry exactly 24 hours before period end.
  - Live production read on 2026-09-09: all 8 WEEKLY pools were on V2 Round #3, `ENTRY_OPEN`, with the same canonical schedule `2026-09-07T00:00:00.000Z` → `2026-09-14T00:00:00.000Z`.
- [x] QUARTERLY round creation automated
  - `ensureCurrentQuarterlyRoundsInternal()` routes the QUARTERLY topology through `ensureCurrentCadenceRoundsInternal()`.
  - `currentQuarterlySchedule()` derives the next calendar-quarter boundary rather than using a fixed 91-day duration.
  - Live production read on 2026-09-09: all 8 QUARTERLY pools were on V2 Round #2, `ENTRY_OPEN`, with the same canonical schedule `2026-07-01T00:00:00.000Z` → `2026-10-01T00:00:00.000Z`.

The generalized creation path preserves DAILY separately, validates the onchain cadence enum, re-reads immediately before any write, performs a single `createRound` send attempt, reconciles uncertain outcomes by reading chain state, and isolates failures per pool so one cadence/pool does not block the others.

QUARTERLY intentionally has no fixed duration constant because calendar quarters vary in length; `observationEndAt` is derived from the next UTC quarter boundary.

---

# 4. Real 1 USDC prediction entry

- [x] Entry amount is exactly 1 USDC
- [x] User must have sufficient real Arc Testnet USDC
- [x] Approval/permit/transfer flow finalized
- [x] Human entry authorization uses the user's own connected wallet or a Circle hosted challenge
- [x] No human passkey/WebAuthn or `BACKEND_WALLET` signer is active; earlier proof is retained in the legacy record below
- [x] Prediction is submitted in a real Arc Testnet transaction
- [x] Contract stores:
  - `roundId`
  - entrant wallet
  - exact prediction price
  - onchain entry ordering data
  - ticket ID
  - 1 USDC stake
- [x] Pool balance increases by exactly 1 USDC
- [x] Player count increases by exactly 1
- [x] Same wallet cannot enter same round twice
- [x] Same exact prediction price cannot be taken twice in same round
- [ ] Entry after close is rejected
  - Fork smoke proof: PASS
    - command: `./script/smoke-entry-close-fork.sh`
    - fork source: real Arc Testnet deployed ETH Daily High Round #1
    - chain ID: `5042002`
    - onchain `entryCloseAt = 1788638400`
    - local fork timestamp advanced to `1788638401`
    - read-only `eth_call enterPrediction(...)` reverted with `EntryClosed`
    - result: `ENTRY_CLOSE_FORK_SMOKE=PASS`
    - no Arc Testnet transaction was broadcast
    - live-chain post-cutoff read-only proof remains pending; fork smoke does not replace it
- [x] UI reflects confirmed onchain state only

### Proof record

#### ETH Daily High exact entry + rejection proof

- Verification date: 2026-09-05
- Read-only verification command: `./script/verify-second-entry-and-rejections.sh`
- Result: `SECOND_ENTRY_AND_REJECTIONS_READS_COMPLETE=PASS`
- Chain ID: `5042002`
- Pool: ETH Daily High
- Pool contract: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Ticket contract: `0xF65Cf4a67299ad596e139e3F6a9594E809F05637`
- Round ID: `1`
- EXTREMA wallet: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Stored prediction: `2365.87 USD` / `236587` cents
- Entry sequence: `1`
- Ticket ID: `1`
- Ticket owner: EXTREMA wallet
- Round state:
  - status = `ENTRY_OPEN`
  - entryCount = `1`
  - nextEntrySequence = `2`
  - totalStake = `1.0 USDC`
  - escrowRemaining = `1.0 USDC`
- Direct reads:
  - `hasEntered(1, wallet) -> true`
  - `predictionTaken(1, 236587) -> true`
  - `nextTicketId() -> 2`
  - pool USDC balance = `1000000` = exactly `1.0 USDC`
- `PredictionEntered` transaction:
  - tx: `0xc1ce127a878bb843c6985b22d1e2ac02423d4d6ad719f8da84a07718a8d28528`
  - block: `60504170`
  - explorer: `https://testnet.arcscan.app/tx/0xc1ce127a878bb843c6985b22d1e2ac02423d4d6ad719f8da84a07718a8d28528`
- Exact USDC approval:
  - tx: `0x427e97a46c0bf939896acda0db84a31cea9647089e4f46d7e54d99353a4047aa`
  - block: `60504161`
  - approved raw amount: `0x0f4240` = `1000000` = exactly `1.0 USDC`
  - explorer: `https://testnet.arcscan.app/tx/0x427e97a46c0bf939896acda0db84a31cea9647089e4f46d7e54d99353a4047aa`
- Duplicate-wallet safety proof, read-only `eth_call`:
  - same wallet + different price reverted with `AlreadyEntered`
  - no transaction was broadcast
- Duplicate-price safety proof, read-only `eth_call`:
  - different address + exact stored price reverted with `PriceAlreadyTaken`
  - no transaction was broadcast
- Browser runtime proof:
  - confirmed round rendered `1 prediction`
  - confirmed prize pool rendered `1 USDC`
  - a later second attempt from the same EXTREMA wallet was rejected with the user-facing message `This EXTREMA wallet has already entered this round.`
- Entry-after-close remains intentionally pending until the real Daily cutoff is reached.

#### Second real entry — ETH Daily High runtime proof

- Verification date: 2026-09-05
- Pool: ETH Daily High
- Pool contract: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Round ID: `1`
- Actual stored prediction for ticket #1: `2365.87 USD` / `236587` cents
- Fresh onchain backend read:
  - `entryCount = 1`
  - `totalStakeRaw = 1000000`
  - `totalStakeUsdc = 1.0`
  - `escrowRemainingRaw = 1000000`
  - `escrowRemainingUsdc = 1.0`
- The later browser value `2654.76` was **not** the successful entry. It was a second attempt from the same EXTREMA wallet after ticket #1 already existed.
- That second attempt was blocked by the live contract-state guard with:
  - `This EXTREMA wallet has already entered this round.`
- No second transaction was sent by that rejected attempt.
- Direct reads from the first version of the verification script corrected the successful entry identity:
  - `hasEntered(wallet) -> true`
  - `entries(1).predictionPriceCents -> 236587`
  - `entrySequence -> 1`
  - ticket #1 owner -> EXTREMA wallet
  - pool balance -> `1.0 USDC`
- The first log scan failed only because Arc RPC rejected an oversized block range (`-32012 requested range too large`). The verification script now scans logs in 5,000-block chunks and uses the actual stored prediction `236587`.

#### First real entry — verified onchain

- Verification date: 2026-09-05
- Chain ID: `5042002`
- Pool: ETH Daily Low
- Pool contract: `0x490A5CE02E3fd85d51095A69AAE9511552d91095`
- Ticket contract: `0x6FC6756af39fb520844EdA73D6855990e56049E1`
- Round ID: `1`
- EXTREMA wallet / entrant: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Prediction: `1976.98 USD` / `197698` cents
- Fresh device confirmation: PASS
- Entry transaction: `0xf017bdbd00b4cf4bad6fd006d148e6b30210d3a7b15f3cbcaac389a7e7fea312`
- Explorer: `https://testnet.arcscan.app/tx/0xf017bdbd00b4cf4bad6fd006d148e6b30210d3a7b15f3cbcaac389a7e7fea312`
- Block: `60502376`
- Log index: `94`
- Transaction index: `11`
- Pool state before entry:
  - `entryCount = 0`
  - `totalStake = 0 USDC`
  - `escrowRemaining = 0 USDC`
  - pool USDC balance = `0 USDC`
- Wallet UI balance immediately before the first entry attempt: `37.834193 USDC`
- Read-only verification command: `./script/verify-first-real-entry.sh`
- Read-only verification result: `FIRST_ENTRY_READS_COMPLETE=PASS`
- Onchain reads:
  - `hasEntered(1, wallet) -> true`
  - `predictionTaken(1, 197698) -> true`
  - `nextTicketId() -> 2`
  - `entries(1)`:
    - ticketId = `1`
    - roundId = `1`
    - originalEntrant = `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
    - predictionPriceCents = `197698`
    - entrySequence = `1`
  - `ownerOf(1) -> 0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
  - pool USDC `balanceOf -> 1000000` = exactly `1.0 USDC`
  - wallet USDC `balanceOf -> 36823692` = `36.823692 USDC`
- Round state after entry:
  - `entryCount = 1`
  - `totalStakeRaw = 1000000`
  - `totalStakeUsdc = 1.0`
  - `escrowRemainingRaw = 1000000`
  - `escrowRemainingUsdc = 1.0`
- `PredictionEntered` event proves:
  - roundId = `1`
  - ticketId = `1`
  - entrant = EXTREMA wallet
  - prediction = `197698`
  - entrySequence = `1`
- Note: the first browser response showed `entry_postcondition_failed` only because the original postcondition incorrectly expected wallet ERC-20 balance to fall by exactly 1 USDC. Arc gas also consumes the same underlying USDC balance. The transaction itself succeeded; postcondition logic was fixed in commit `309352cdd9a2d8de0f2d848024dd99f6ebfda661`.


---

# 5. Real ERC-721 prediction ticket

- [x] Successful entry mints a real ERC-721 ticket
- [x] NFT token ID linked to `roundId`
- [x] NFT linked to prediction value
- [x] NFT ownership readable onchain
- [x] `My Tickets` reads real NFT ownership
- [x] No localStorage/mock tickets in production path
- [x] NFT transfer tested on Arc Testnet
- [ ] After transfer, new owner becomes claim-right holder
  - Contract rule and ownership transition are proven; live claim execution remains pending settlement.
- [ ] Original entrant loses claim right after transfer
  - Contract rule is implemented; live rejection proof remains pending settlement.

### Proof record

- Verification date: 2026-09-05
- Ticket: ETH Daily High, Round #1, Ticket #1
- Ticket contract: `0xF65Cf4a67299ad596e139e3F6a9594E809F05637`
- Prediction: `2365.87 USD`
- Entry / mint tx: `0xc1ce127a878bb843c6985b22d1e2ac02423d4d6ad719f8da84a07718a8d28528`
- Owner before transfer: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Destination / owner wallet: `0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321`
- Transfer method: `safeTransferFrom`
- Historical pre-migration passkey step-up: PASS (legacy proof only)
- Transfer tx: `0xc6e5bd0e02b825e84e570bb9ba25f3c381ebd33e14aeb423e446ffdbb3450fee`
- Transfer block: `60612578`
- Owner after transfer: `0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321`
- Explorer: `https://testnet.arcscan.app/tx/0xc6e5bd0e02b825e84e570bb9ba25f3c381ebd33e14aeb423e446ffdbb3450fee`
- Browser verification:
  - My Tickets showed 2 real onchain tickets before transfer.
  - Transfer required passkey confirmation.
  - The transaction completed successfully on Arc Testnet.
  - My Tickets refreshed from 2 tickets to 1 ticket because ETH Daily High Ticket #1 was no longer owned by the EXTREMA wallet.
- Verification: NFT transfer / ownership transition = PASS. Live claim-right enforcement remains a later settlement proof gate.

---

# 6. Real live pool state

- [x] Real player count from chain/indexed events
- [x] Real pool USDC from contract/token balance/accounting
- [x] Real user entry status
- [x] Real user prediction
- [x] Real ticket ID
- [x] Real entry timestamp/order
- [x] Real round status
- [ ] No mock live distribution
- [x] UI updates after confirmed transactions

### Proof record

- Round ID:
- Contract reads/events:
- Pool USDC:
- Players:
- User ticket:
- Block:
- Verification:

---

# 7. Real settlement source and resolver

Official EXTREMA resolution source:

**Binance USDⓈ-M Futures Mark Price Klines**

Symbols:

- BTCUSDT
- ETHUSDT
- SOLUSDT
- HYPEUSDT

Resolution rule:

- High = maximum candle high in the observation period
- Low = minimum candle low in the observation period

Planned intervals:

- Daily: 1m
- Weekly: 15m
- Quarterly: 4h

## 7.1 Resolver data proof

- [x] Exact Binance endpoint/spec locked
  - `GET https://fapi.binance.com/fapi/v1/markPriceKlines`
  - fields used: `[0]` open time, `[2]` high, `[3]` low, `[6]` close time
  - intervals: DAILY `1m`, WEEKLY `15m`, QUARTERLY `4h`
- [x] Exact time-boundary convention locked
  - EXTREMA observation window = `[observationStartAt, observationEndAt)`
  - request uses `endTime = observationEndAt - 1ms`
  - every candle timestamp must be contiguous and aligned; incomplete source data is a hard failure
  - final exact high/low is converted to integer cents with nearest-cent, half-up rounding
- [x] Daily resolver calculation verified
- [x] Weekly resolver calculation verified
- [x] Quarterly resolver calculation verified
- [x] High calculation verified
- [x] Low calculation verified
- [x] Raw source response can be archived/hash-recorded
- [x] Deterministic calculation output recorded

## 7.2 Settlement transaction

- [x] Resolver cannot settle before observation period ends
  - Fork smoke proof: PASS
  - Real Arc Testnet ETH Daily High Round #1 was forked locally.
  - Fork timestamp was set to post-entry-close but pre-`observationEndAt`.
  - Round was locked on the local fork only.
  - Read-only resolver `settleRound` reverted with `ObservationNotEnded`.
  - Result: `SETTLEMENT_BEFORE_END_FORK_SMOKE=PASS`
  - No Arc Testnet transaction was broadcast.
- [x] Resolver submits resolved price to Arc Testnet contract
  - Live ETH Daily High Round #4 settlement tx: `0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9`
- [x] Contract transitions to `SETTLED`
- [ ] Settlement cannot be repeated live
  - Deterministic contract/E2E proof passes. No duplicate production settlement was intentionally broadcast.
- [x] Settled price readable onchain
  - Round #4 resolved price: `253500` cents = `$2535.00`.
- [x] Settlement tx recorded
  - Persisted settlement evidence and live Arc receipt both identify the same settlement transaction.
- [x] Verification page shows source proof + onchain result
  - Canonical route: `app/verify/[slug]/[roundId]/page.tsx`.
  - The page reads `GET /api/rounds/:slug/:roundId/verification` with `cache: "no-store"` and renders the real verification object.
  - Live Railway proof for ETH Daily High Round #4 on 2026-09-09:
    - HTTP `200`, Arc Testnet chain ID `5042002`, status `SETTLED`
    - verification status `VERIFIED`
    - Binance USDⓈ-M Futures Mark Price Klines, `ETHUSDT`, interval `1d`, candle count `1`
    - evidence SHA256 `0451d8569c28edd05e76a008d259a52a5860f7280594f2968bad1882a266dd75`
    - source-data SHA256 `e3ebc5037503422a58bb0e968ef9bbdfa9917be0c8c8111a1dc082dfa7467392`
    - settlement tx `0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9`
    - evidence hash, pool identity, market period, and resolved-price integrity checks all `true`

### 7.3 Resolver signing path is resolved

The operational gap recorded in earlier revisions of this document, that the deployed resolver had no production signing mechanism, is **closed**. The signing path is now both infrastructure-complete and live-proven by successful resolver-authorized cancellation and settlement transactions.

- [x] Resolver signing mechanism exists in production
  - `backend/src/services/resolverSignerService.js` decrypts an AES-256-GCM envelope into an in-memory `ethers.Wallet` and never logs, returns, or persists the key material.
  - The envelope reuses the existing `cryptoService` format and the existing `ENCRYPTION_KEY`. It is supplied to Railway as `EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED`.
  - `backend/src/config.js` accepts only the `v1.<iv>.<ct>.<tag>` envelope shape, so a plaintext private key cannot be configured even by mistake.
  - `backend/scripts/encrypt-resolver-key.js` produces the envelope locally from a Foundry keystore, a keystore file, or a hidden prompt. It verifies the derived address and aborts on mismatch. No key ever reaches argv, shell history, disk, or logs.
- [x] Resolver signer verified against onchain `pool.resolver()` at backend startup
  - `verifyResolverConfiguration()` decrypts the envelope, derives the address, reads live `pool.resolver()`, and compares them.
  - Railway startup proof (2026-09-06):
    - `[round-automation] daily scheduler active`
    - `[round-automation] resolver signer verified {"resolver":"0x1EDC4594195fFb134315c3258DE974563Ed9762A"}`
  - This preflight is informational and does not gate automation. Correctness is guarded independently: `executeResolverAction()` re-reads `pool.resolver()` before every single cancel or settle and refuses to sign on `resolver_signer_mismatch`.
- [x] Resolver funded for gas on Arc Testnet
  - Read-only balance check (2026-09-06): resolver `0x1EDC4594195fFb134315c3258DE974563Ed9762A` holds a positive Arc balance; pool owner `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b` likewise. Arc couples native gas and ERC-20 USDC into one underlying balance.
- [x] Live `settleRound` broadcast
  - ETH Daily High Round #4
  - Tx: `0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9`
  - Block: `60988590`
  - Timestamp: `2026-09-08T00:02:26Z`
  - Resolver: `0x1EDC4594195fFb134315c3258DE974563Ed9762A`

No private key, envelope value, or `ENCRYPTION_KEY` value appears in this repository. See [docs/REFUND_CANCELLATION_READINESS.md](docs/REFUND_CANCELLATION_READINESS.md) for the full mechanism description.

### Proof record

#### Historical DAILY resolver read-only proof

- Verification date: 2026-09-05
- Command: `npm --prefix backend run resolver:verify`
- Result: `RESOLVER_HISTORY_VERIFY=PASS`
- Broadcast: **NO**
- Symbol: `ETHUSDT`
- Cadence: `DAILY`
- Binance interval: `1m`
- Observation window: `[2026-09-04T00:00:00.000Z, 2026-09-05T00:00:00.000Z)`
- Candle count: `1440`
- Source data SHA-256: `79e6acb34f250f2db133f88a7d83e94f4bafa0bf6ab0a3d018d22f37efc3ae31`
- HIGH exact: `2545.71100000`
- HIGH resolved cents: `254571`
- HIGH candle open: `2026-09-04T09:19:00.000Z`
- LOW exact: `2430.93475140`
- LOW resolved cents: `243093`
- LOW candle open: `2026-09-04T14:50:00.000Z`
- Evidence SHA-256: `6cd71b246e1087bb9cf0049e1ba96d5b742841d7f40b8b1c57ab2bdeb635cf36`
- Verification: DAILY source fetch, complete 1-minute candle coverage, HIGH calculation, LOW calculation, and evidence hashing = PASS.

#### Historical WEEKLY resolver read-only proof

- Verification date: 2026-09-05
- Command: `npm --prefix backend run resolver:verify -- ETHUSDT WEEKLY 2026-08-24T00:00:00.000Z 2026-08-31T00:00:00.000Z`
- Result: `RESOLVER_HISTORY_VERIFY=PASS`
- Broadcast: **NO**
- Symbol: `ETHUSDT`
- Cadence: `WEEKLY`
- Binance interval: `15m`
- Observation window: `[2026-08-24T00:00:00.000Z, 2026-08-31T00:00:00.000Z)`
- Candle count: `672`
- Source data SHA-256: `1fb47bb158907fc11e2aa06799b15bb48b7422b3501bcc7c2963d0311ee713cc`
- HIGH exact: `2565.52490160`
- HIGH resolved cents: `256552`
- HIGH candle open: `2026-08-27T09:15:00.000Z`
- LOW exact: `2387.16893023`
- LOW resolved cents: `238717`
- LOW candle open: `2026-08-30T23:45:00.000Z`
- Evidence SHA-256: `569c8ae5b1ea89d68f311eadf1eb3cd05a689957dee1e96f929f4129b200c69b`
- Verification: WEEKLY source fetch, complete 15-minute candle coverage, HIGH calculation, LOW calculation, and evidence hashing = PASS.

#### Historical QUARTERLY resolver read-only proof

- Verification date: 2026-09-05
- Command: `npm --prefix backend run resolver:verify -- ETHUSDT QUARTERLY 2026-04-01T00:00:00.000Z 2026-07-01T00:00:00.000Z`
- Result: `RESOLVER_HISTORY_VERIFY=PASS`
- Broadcast: **NO**
- Symbol: `ETHUSDT`
- Cadence: `QUARTERLY`
- Binance interval: `4h`
- Observation window: `[2026-04-01T00:00:00.000Z, 2026-07-01T00:00:00.000Z)`
- Candle count: `546`
- Source data SHA-256: `abeb04f5151c929b324bc1149ae08c2443eb6d72d9c911f93c4b0c06463e6004`
- HIGH exact: `2463.25488773`
- HIGH resolved cents: `246325`
- HIGH candle open: `2026-04-17T16:00:00.000Z`
- LOW exact: `1504.58000000`
- LOW resolved cents: `150458`
- LOW candle open: `2026-06-06T04:00:00.000Z`
- Evidence SHA-256: `a801bc62362b4ceb77f04d0fc55f60684b782c70856c0a1f1634330937c05f21`
- Verification: QUARTERLY source fetch, complete 4-hour candle coverage, HIGH calculation, LOW calculation, and evidence hashing = PASS.
- Quarterly determinism rerun proof (2026-09-05):
  - same command rerun: `npm --prefix backend run resolver:verify -- ETHUSDT QUARTERLY 2026-04-01T00:00:00.000Z 2026-07-01T00:00:00.000Z`
  - `sourceDataSha256` unchanged: `abeb04f5151c929b324bc1149ae08c2443eb6d72d9c911f93c4b0c06463e6004`
  - `evidenceSha256` unchanged: `a801bc62362b4ceb77f04d0fc55f60684b782c70856c0a1f1634330937c05f21`
  - HIGH unchanged: exact `2463.25488773`, cents `246325`
  - LOW unchanged: exact `1504.58000000`, cents `150458`
  - result: QUARTERLY resolver determinism = PASS
- Section 7.1 historical resolver coverage status: **COMPLETE** for DAILY, WEEKLY, and QUARTERLY.
- Weekly determinism rerun proof (2026-09-05):
  - same command rerun: `npm --prefix backend run resolver:verify -- ETHUSDT WEEKLY 2026-08-24T00:00:00.000Z 2026-08-31T00:00:00.000Z`
  - `sourceDataSha256` unchanged: `1fb47bb158907fc11e2aa06799b15bb48b7422b3501bcc7c2963d0311ee713cc`
  - `evidenceSha256` unchanged: `569c8ae5b1ea89d68f311eadf1eb3cd05a689957dee1e96f929f4129b200c69b`
  - HIGH unchanged: exact `2565.52490160`, cents `256552`
  - LOW unchanged: exact `2387.16893023`, cents `238717`
  - result: WEEKLY resolver determinism = PASS
- Determinism rerun proof (2026-09-05):
  - same command rerun: `npm --prefix backend run resolver:verify`
  - `sourceDataSha256` unchanged: `79e6acb34f250f2db133f88a7d83e94f4bafa0bf6ab0a3d018d22f37efc3ae31`
  - `evidenceSha256` unchanged: `6cd71b246e1087bb9cf0049e1ba96d5b742841d7f40b8b1c57ab2bdeb635cf36`
  - HIGH unchanged: exact `2545.71100000`, cents `254571`
  - LOW unchanged: exact `2430.93475140`, cents `243093`
  - result: DAILY resolver determinism = PASS

#### Settlement-before-observation-end fork proof

- Verification date: 2026-09-05
- Command: `bash script/smoke-settlement-before-end-fork.sh`
- Result: `SETTLEMENT_BEFORE_END_FORK_SMOKE=PASS`
- Broadcast: **NO**
- Source deployment: ETH Daily High Round #1
- Pool: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Chain ID: `5042002`
- Onchain resolver: `0x1EDC4594195fFb134315c3258DE974563Ed9762A`
- Onchain `entryCloseAt`: `1788638400`
- Onchain `observationEndAt`: `1788739200`
- Local fork timestamp: `1788638401`
- Local fork status after `lockRound(1)`: `LOCKED`
- Read-only `settleRound(1, 250000)` result: reverted with `ObservationNotEnded`
- Verification: early settlement rejection = PASS.

#### Underfilled settlement rejection fork proof

- Verification date: 2026-09-05
- Command: `bash script/smoke-underfilled-settlement-fork.sh`
- Result: `UNDERFILLED_SETTLEMENT_FORK_SMOKE=PASS`
- Broadcast: **NO**
- Source deployment: ETH Daily High Round #1
- Pool: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Chain ID: `5042002`
- Onchain entry count: `1`
- Onchain resolver: `0x1EDC4594195fFb134315c3258DE974563Ed9762A`
- Onchain `observationEndAt`: `1788739200`
- Local fork timestamp: `1788739201`
- Round was locked on the local fork only.
- Read-only resolver `settleRound(1, 250000)` result: reverted with `NotEnoughEntries`.
- Verification: a 1-entry round cannot settle and must follow the cancellation/refund path = PASS at fork safety level.
- This does **not** mark the real cancellation/refund checklist complete; Arc Testnet broadcast proof is still required after the real observation window ends.

#### Live settlement proof

- Verification date: 2026-09-09
- Chain: Arc Testnet `5042002`
- Pool: ETH Daily High `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Round ID: `4`
- Entry count: `3`
- Total stake: `3.0 USDC`
- Calculated / submitted value: `253500` cents = `$2535.00`
- Settlement tx: `0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9`
- Block: `60988590`
- Timestamp: `2026-09-08T00:02:26Z`
- Resolver sender: `0x1EDC4594195fFb134315c3258DE974563Ed9762A`
- Winner ticket IDs: `[4, 3, 2]`
- Treasury allocation: `300000` raw = `0.3 USDC`
- Treasury transfer: pool → `0x1D00C89Ed4AF7227a858D305183B4037f732b87e`, `0.3 USDC`
- Current onchain status: `SETTLED`
- Onchain resolved value: `253500`
- Verification: receipt success, sender, pool target, calldata, `RoundSettled`, `TreasuryAllocated`, USDC transfer, winner IDs, entry count and total stake all matched = PASS.

---

# 8. Real winner determination

Winner ranking is computed onchain by `ExtremaPool` at settlement time. Live ETH Daily High Round #4 now proves the ordinary three-winner path; live tie cases and frontend result-surface completion remain separate evidence items below.

- [x] Winner #1 calculated from actual live entries
  - Ticket #4, prediction `$2508.56`, distance `$26.44`.
- [x] Winner #2 calculated from actual live entries
  - Ticket #3, prediction `$2507.56`, distance `$27.44`.
- [x] Winner #3 calculated from actual live entries
  - Ticket #2, prediction `$2506.56`, distance `$28.44`.
- [x] Distance calculation verified against live Round #4
- [ ] Earlier-entry tie break exercised on a live equal-distance case
  - Contract and deterministic E2E proof already PASS; the live Round #4 distances were distinct.
- [x] Final deterministic fallback is contract ticket ID after equal distance and equal entry sequence
  - The older "tx/log-index" wording was stale; the deployed contract uses distance, then `entrySequence`, then `ticketId`.
- [x] Winner ticket IDs stored and readable onchain
  - Live Round #4: `[4, 3, 2]`.
- [x] Results page reads real settled result
  - Canonical route: `app/results/[slug]/[roundId]/page.tsx`.
  - The page reads `GET /api/rounds/:slug/:roundId/result` with `cache: "no-store"` and no demo fixture.
  - Live Railway proof for ETH Daily High Round #4 on 2026-09-09:
    - HTTP `200`, Arc Testnet chain ID `5042002`, status `SETTLED`
    - resolved price `253500` cents
    - winner ticket IDs `[4, 3, 2]`
    - winner #1 claimable `1.62 USDC`
    - winner #2 claimable `0.675 USDC`
    - winner #3 already claimed

Local contract-level proof of the ranking and tie-break rules already exists in section 2.2 and section 10's lifecycle simulation. That is contract logic proof, not live proof.

### Proof record

#### Live pre-settlement result API proof

- Verification date: 2026-09-06 (Türkiye time)
- Endpoint: `GET /api/rounds/eth-weekly-high/1/result`
- Railway response: `HTTP 200`
- Chain: Arc Testnet `5042002`
- Pool: `0x7c2e9C3221534F24ecA83949D4f7249c95C35c33`
- Ticket collection: `0xd20a69DB0A957D6f285b6Af67fed653d65cD7E5d`
- Round: `1`
- Live status: `ENTRY_OPEN`
- Entry count: `3`
- Total stake: `3.0 USDC`
- Escrow remaining: `3.0 USDC`
- Resolved price: `null` / `0` cents before settlement
- Winner ticket IDs: `[0, 0, 0]`
- Winners: `[]`
- Verification: result API is reading the real Arc round and correctly exposes no resolved price or winners before settlement; no mock winner data is returned.
- This does **not** mark the settled-result checklist item complete. Final proof still requires the real round to reach `SETTLED`.

- Round ID: `4`
- Resolved price: `$2535.00`
- Entry set: 3 real entries / `3.0 USDC`
- Winner 1: Ticket #4, `$2508.56`, distance `$26.44`
- Winner 2: Ticket #3, `$2507.56`, distance `$27.44`
- Winner 3: Ticket #2, `$2506.56`, distance `$28.44`
- Tie-break evidence: no live tie occurred; deterministic contract/E2E tie-break proof remains PASS
- Contract result: winner ticket IDs `[4, 3, 2]`
- Verification: live `RoundSettled` event and current onchain round state agree = PASS.

---

# 9. Real payouts

Gross pool distribution:

- 54% first
- 22.5% second
- 13.5% third
- 10% treasury

The core payout path is now live-proven by ETH Daily High Round #4 settlement and Ticket #2 claim. Transferred-winner and duplicate-claim negative cases remain deterministic proof unless separately marked live below.

- [x] Payout math verified with real USDC decimals on live Round #4
  - `1.62 + 0.675 + 0.405 + 0.3 = 3.0 USDC`.
- [x] Total allocation equals 100%
- [x] Treasury amount verified
  - `0.3 USDC` transferred from pool to treasury in the settlement receipt.
- [x] Winner entitlements linked to NFT ownership at contract/deterministic E2E level
- [ ] Live transferred-winner claim by a secondary buyer
  - Deterministic E2E proves this path; the historical live claim owner was also the original entrant.
- [ ] Live second-claim rejection
  - Deterministic contract/E2E proof PASS; no duplicate production claim was intentionally submitted.
- [x] Claim state readable onchain
  - Ticket #2 changed to claimed with `claimable = 0`.

---

# 10. Real claim flow

The backend claim flow and its negative authorization gates are verified, and a successful live Arc Testnet claim is now recorded below. A legacy browser-passkey UI record is not evidence for the current human runtime, and a deliberate live duplicate-claim rejection remains intentionally open.

- [x] Claim requires settled round
  - Pre-settlement negative gate was already live-proven; Ticket #2 later claimed successfully only after Round #4 was `SETTLED`.
- [x] Successful live claim sender matched the current winning NFT owner
  - Non-owner rejection remains separately proven by deterministic contract/E2E tests.
- [ ] Legacy browser passkey step-up for the historical live claim separately recorded as UI evidence (not a current-runtime requirement)
  - Action authorization binding and single-use replay protection are proven; this checklist does not infer missing browser evidence.
- [x] Real Arc Testnet claim transaction submitted
- [x] USDC leaves pool/contract
- [x] USDC arrives in rightful wallet
- [x] Claim state changes onchain
- [ ] Live second claim attempt fails
  - Deterministic contract/E2E proof PASS; no duplicate live transaction was intentionally broadcast.

### Proof record

#### Local lifecycle simulation proof

- Verification date: 2026-09-05
- Command: `forge test --match-contract ExtremaPoolLifecycleTest -vv`
- Broadcast: **NO**
- Result: **PASS — 8 passed, 0 failed, 0 skipped**
- Tests proven locally against the real `ExtremaPool` contract logic with `MockUSDC`:
  - `testSettlementRanksWinnersAndAccountsEveryUsdc()`
  - `testTieBreakUsesEarlierEntrySequence()`
  - `testTransferredWinningNftOwnsClaimAndCannotDoubleClaim()`
  - `testCancelledRoundRefundFollowsTransferredNft()`
  - `testThreeEntriesCannotBeCancelled()`
  - `testUnauthorizedSettlementRejected()`
  - `testOwnerCanRescueOnlyAccidentalExcessUsdc()`
  - `testTreasuryControllersCannotWithdrawPoolEscrow()`
- Settlement/payout simulation:
  - 4-entry round settles successfully.
  - Winner ticket ordering is deterministic.
  - First payout: `2,160,000` raw USDC (54% of 4 USDC).
  - Second payout: `900,000` raw USDC (22.5%).
  - Third payout: `540,000` raw USDC (13.5%).
  - Treasury: `400,000` raw USDC (10%).
  - Remaining winner reserve / round escrow: `3,600,000` raw USDC.
  - Escrow invariant holds.
- NFT ownership / claim simulation:
  - Winning NFT transferred from original entrant to a new owner.
  - Original entrant claim is rejected with `NotTicketOwner`.
  - Current NFT owner receives the full claimable amount.
  - Second claim is rejected with `AlreadyClaimed`.
- Refund simulation:
  - Cancelled-round refund follows current NFT ownership.
  - Original entrant is rejected after ticket transfer.
  - Current NFT owner receives the refund.
  - Second refund is rejected with `AlreadyRefunded`.
- Minimum-participant / authorization simulation:
  - Three-entry round cannot be cancelled (`TooManyEntriesForCancellation`).
  - Non-resolver settlement is rejected (`NotResolver`).
- This is **local contract lifecycle proof only**. It does not mark the real Arc Testnet winner, payout, claim, or refund checklist items complete.

#### Backend claim readiness smoke against live Arc state

- Verification date: 2026-09-06 (Türkiye time)
- Broadcast: **NO**
- Result: `CLAIM_BACKEND_READINESS_SMOKE=PASS`
- ETH Daily High Ticket #1:
  - execution path: `EXTERNAL_OWNER`
  - current owner matched `0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321`
  - live round state read as `LOCKED`
  - `isClaimed == false`
  - `claimableRaw == 0`
  - backend claim builder rejected the request with `claim_round_not_settled`
  - result: `HIGH_EXTERNAL=PASS`
- ETH Daily Low Ticket #1:
  - execution path: `BACKEND_WALLET`
  - current owner matched `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
  - live round state read as `LOCKED`
  - `isClaimed == false`
  - `claimableRaw == 0`
  - backend claim execution path rejected before signing with `claim_round_not_settled`
  - result: `LOW_BACKEND=PASS`
- Verification: both backend and external-owner claim paths re-derived current Arc state and refused an invalid pre-settlement claim. No transaction was signed or broadcast.
- This historical smoke proved the negative authorization gate before settlement. It is now complemented by the later live Round #4 / Ticket #2 successful claim proof below.

#### Claim action authorization smoke

- Verification date: 2026-09-06 (Türkiye time)
- Command: `node script/smoke-claim-action-auth.js`
- Broadcast: **NO**
- Result: `CLAIM_ACTION_AUTH_SMOKE=PASS`
- `CLAIM_ACTION_PAYLOAD=PASS`
  - canonical action type is `CLAIM_REWARD`
  - Arc chain ID, pool, ticket, token, round, current owner, destination, execution mode and exact claim amount are bound into the payload
  - nonce and 120-second expiry are present
  - SHA-256 payload hash matches the canonical payload
- `CLAIM_CHALLENGE_SINGLE_USE=PASS`
  - the WebAuthn challenge can be consumed once
  - replay of the same challenge is rejected
- `CLAIM_PAYLOAD_AND_TYPE_BINDING=PASS`
  - wrong payload hash is rejected
  - wrong action type is rejected
- `CLAIM_ACTION_SINGLE_USE=PASS`
  - a verified `CLAIM_REWARD` authorization can be consumed once
  - replay after consumption is rejected
- `CLAIM_CONSUMED_ACTION_LOOKUP=PASS`
  - consumed authorization is recoverable only with the matching `CLAIM_REWARD` action type
- Verification: claim authorization is nonce-bound, payload-hash-bound, action-type-bound and single-use at the action authorization layer.
- This smoke uses an in-memory DB harness and does not replace a real browser WebAuthn + successful Arc Testnet claim proof.

### Live claim proof

- Verification date: 2026-09-09
- Round ID: `4`
- Ticket ID: `2`
- Pool: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- NFT owner / transaction sender: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Claimable amount: `405000` raw = `0.405 USDC`
- Claim tx: `0xc7913e802e228549cfb564e60eba6f6f57afbbc1e8e4e8fe33ee0f11e59cf2ff`
- Block: `61052025`
- Timestamp: `2026-09-08T09:07:05Z`
- Receipt: success
- USDC movement: pool → current NFT owner, exactly `0.405 USDC`
- Claimable after: `0`
- Onchain claimed state after: `true`
- Second-claim rejection: deterministic proof PASS; not deliberately repeated on production
- Verification: sender, pool target, `claim(ticketId)` calldata, `RewardClaimed` event and exact USDC `Transfer` all matched = PASS.

---

# 11. Cancellation and real refunds

Rule: fewer than 3 valid entries → round cancelled/refundable.

- [ ] Live 0-entry cancellation case recorded
  - Deterministic contract proof exists; no separate 0-entry production proof is claimed here.
- [x] Live 1-entry round cancels correctly
  - ETH Daily Low Round #1, resolver `cancelRound` tx `0xa6119ad38927e96095930e8270d4f21b0b1f4f3a478de58c4a0066d54158a4a3`.
- [ ] Live 2-entry cancellation case recorded
  - Deterministic contract proof exists; no separate 2-entry production proof is claimed here.
- [x] 3-entry minimum-participant rule proven at contract/deterministic E2E level
  - Live ETH Daily High Round #4 had 3 entries and followed settlement rather than the underfilled refund path.
- [x] Refund entitlement linked to ticket/current ownership rule as finalized
- [x] Fresh passkey step-up required by the refund execution design
- [x] Real Arc Testnet refund transaction verified
  - ETH Daily Low Round #1, Ticket #1, exactly `1.0 USDC`.
- [ ] Live double-refund rejection
  - Deterministic contract/E2E proof PASS; no duplicate live transaction was intentionally broadcast.

### 11.1 Automated cancellation status

`cancelRound` is now automated in the lifecycle engine and no longer requires a manual operator action.

- The resolver signing path is production-provisioned and verified at startup. See [section 7.3](#73-resolver-signing-path-is-resolved).
- `executeResolverAction()` re-reads live `pool.resolver()` before signing, re-reads the round to confirm it is still eligible, and no-ops on terminal or ineligible state.
- `sendOnceWithReconciliation()` never resends a transaction. If a send outcome is unknown, it re-reads the round to determine whether the transition actually landed.
- Refunds are deliberately **not** automated. Cancellation releases the escrow, and the current NFT owner then initiates the refund through the existing `REFUND_TICKET` step-up flow. This is a design decision, not a gap: the contract pays the current ticket owner, and the backend must not spend on their behalf without their fresh authorization.

Live `cancelRound` is proven. ETH Daily Low Round #1 was cancelled by the configured resolver at `2026-09-07T00:02:24Z`, shortly after the canonical eligibility boundary.

- Cancel tx: `0xa6119ad38927e96095930e8270d4f21b0b1f4f3a478de58c4a0066d54158a4a3`
- Block: `60826570`
- Resolver sender: `0x1EDC4594195fFb134315c3258DE974563Ed9762A`
- Pool: `0x490A5CE02E3fd85d51095A69AAE9511552d91095`
- Round: `1`
- Receipt: success

### Proof record

#### Underfilled cancellation fork proof

- Verification date: 2026-09-05
- Command: `bash script/smoke-cancel-underfilled-fork.sh`
- Result: `CANCEL_UNDERFILLED_FORK_SMOKE=PASS`
- Broadcast: **NO**
- Source deployment: ETH Daily High Round #1
- Pool: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Entry count: `1`
- Onchain `observationEndAt`: `1788739200`
- Local fork timestamp: `1788739201`
- Local fork status after cancellation: `CANCELLED`
- `escrowRemaining` before cancellation: `1000000`
- `escrowRemaining` after cancellation: `1000000`
- Verification: underfilled cancellation transition and preservation of refund escrow = PASS at fork safety level.
- This does **not** mark the real Arc Testnet cancellation/refund checklist complete.

#### Refund authorization + execution code readiness (no chain evidence)

- `POST /actions/refund/start|finish|verify` now exist in
  `backend/src/routes/actions.js`, backed by
  `backend/src/services/refundExecutionService.js`. The server derives the
  human execution mode from on-chain `currentOwner` and the authenticated
  session; current human execution is `EXTERNAL_OWNER` or
  `CIRCLE_USER_WALLET`, never a backend-held signer.
- Historical pre-migration refund records may mention `BACKEND_WALLET` and a
  passkey step-up. Those labels describe only the old proof, not this runtime.
- `script/smoke-transferred-refund-fork.sh` was hardened this session:
  `TRANSFERRED_REFUND_ACCESS_CONTROL_FORK=PASS` is reported for the
  ownership-gating half independently of the USDC-movement half. The
  owner's net USDC balance is no longer used as a pass/fail gate (it pays
  its own gas from the same coupled balance, so it is diagnostic-only); the
  pool USDC balance decrease and the round `escrowRemaining` decrease
  (both computed as exact deltas, not absolute end-values) are the hard
  gates, plus `refunded(tokenId) == true` and a double-refund
  `AlreadyRefunded` rejection. A best-effort, non-fatal check independently
  confirms the USDC `Transfer` event via `cast logs`. On a failed
  current-owner send, the script always reports
  `CURRENT_OWNER_REFUND_FORK=FAILED_UNCLASSIFIED` /
  `TRANSFERRED_REFUND_FORK=UNPROVEN` — it has no call-trace mechanism to
  actually prove execution reached the external USDC-transfer boundary
  inside `pool.refund()`, so a gas-estimation/empty-`0x`-shaped failure is
  at most *mentioned* as consistent with the previously observed Arc/Anvil
  coupling issue, never asserted as a proven `ARC_SYSTEM_USDC_TRANSFER_FORK`
  conclusion. `TRANSFERRED_REFUND_ACCESS_CONTROL_FORK=PASS` is still
  reported whenever the `NotTicketOwner` rejection is actually observed.
- This hardened script was **not re-executed in this session** — this
  sandbox does not have `anvil`/`cast` installed, and this task intentionally
  did not install Foundry. The actual historical result from the prior
  environment (before this session's hardening) was: original entrant
  refund attempt → rejected with `NotTicketOwner` (**PASS**); current-owner
  refund send on generic Anvil → reverted during gas estimation/execution
  with an empty `0x` (**not a success**); full USDC refund movement
  (pool/escrow delta) → **not proven**; double-refund rejection after a
  successful refund → **not proven in that run**, since no refund had
  actually succeeded to double-refund against; no Arc Testnet transaction.
  No PASS is claimed for the USDC-movement half of this proof until someone
  runs the hardened script with Foundry available and records the actual
  output below.
- See [docs/REFUND_CANCELLATION_READINESS.md](docs/REFUND_CANCELLATION_READINESS.md)
  for the full implementation breakdown. The resolver-signer gap described in
  earlier revisions of that document is now closed; see
  [section 7.3](#73-resolver-signing-path-is-resolved). This remains code
  readiness only. It does not satisfy any "real Arc Testnet" item above, and
  this paragraph describes the earlier readiness state only. A later real Arc Testnet refund is now recorded in the live cancellation/refund proof below.

#### Live Arc Testnet lock proof

Verification date: 2026-09-05.

Resolver operational readiness:
- Resolver keystore imported locally as Foundry account `extrema-resolver`.
- `cast wallet address --account extrema-resolver` resolved to the deployed resolver `0x1EDC4594195fFb134315c3258DE974563Ed9762A`.
- Both ETH Daily High and ETH Daily Low pools report that exact resolver address onchain.
- Resolver was funded from the Arc testnet faucet and shows 20 USDC in both the native-interface view and ERC-20 USDC view; these are two technical views of one asset.
- No private key was added to the repository or environment files.

ETH Daily High Round #1:
- Pool: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Pre-lock status: `ENTRY_OPEN`
- Entry count: `1`
- `escrowRemaining`: `1000000` raw USDC
- Lock tx: `0x0b9f2de2fa221a734b7877904c71348bc7eaf16845ed88fe215c93c2d00644a7`
- Block: `60637750`
- Receipt status: `1 (success)`
- Post-lock status: `LOCKED`

ETH Daily Low Round #1:
- Pool: `0x490A5CE02E3fd85d51095A69AAE9511552d91095`
- Pre-lock status: `ENTRY_OPEN`
- Entry count: `1`
- `escrowRemaining`: `1000000` raw USDC
- Lock tx: `0xac32dde62e060f5fadbb5384ee6fcc528c2828d9637b9e7fb700639d20529219`
- Block: `60638205`
- Receipt status: `1 (success)`
- Post-lock status: `LOCKED`

Verification at the time of the original lock proof:
- Both underfilled Daily Round #1 pools were genuinely `LOCKED` on Arc Testnet.
- Subsequent live evidence supersedes the old pending note: ETH Daily Low Round #1 later transitioned to `CANCELLED` and Ticket #1 was refunded successfully.

Note on how this proof was produced versus how locking works now: these two locks were executed manually from the local Foundry keystore. Locking is since automated. `lockRound` is permissionless, so the lifecycle engine locks due rounds using the owner wallet purely as a funded sender, not as an authority. The manual keystore path described above is no longer the production mechanism for any lifecycle action; see [section 7.3](#73-resolver-signing-path-is-resolved).

#### Live cancellation/refund proof

- Verification date: 2026-09-09
- Pool: ETH Daily Low `0x490A5CE02E3fd85d51095A69AAE9511552d91095`
- Round ID: `1`
- Entry count: `1`
- Cancellation tx: `0xa6119ad38927e96095930e8270d4f21b0b1f4f3a478de58c4a0066d54158a4a3`
- Cancellation block: `60826570`
- Cancellation timestamp: `2026-09-07T00:02:24Z`
- Cancellation sender: resolver `0x1EDC4594195fFb134315c3258DE974563Ed9762A`
- Refund ticket: `1`
- Refund owner: `0xd63f29329f3F34E1F0Bc9D74500E6C33D352083b`
- Refund tx: `0x04183e238f8e2e2a29e733119b5262e2ffc74b8c492542d73febce04117cb8cf`
- Refund block: `61052485`
- Refund timestamp: `2026-09-08T09:11:02Z`
- Refund amount: `1000000` raw = `1.0 USDC`
- USDC movement: pool → current NFT owner, exactly `1.0 USDC`
- Verification: cancel receipt/event/calldata and refund receipt/event/calldata/USDC transfer all matched = PASS.

---

# 12. Real leaderboard

Current state: **COMPLETE.** `app/leaderboard/page.tsx` derives its rows from the real 90-day round archive and contains no seeded player or earnings fixture.

- [x] Leaderboard source defined from settled onchain rounds
- [x] No seeded/mock users
- [x] No seeded/mock scores
- [x] Ranking formula documented
- [x] Wallet identities derived from real participation
- [x] Historical settled rounds rebuild leaderboard deterministically

Leaderboard attribution uses `originalEntrant`, not current ticket owner, because secondary NFT ownership controls claim rights but must not rewrite who made the prediction. Rows are sorted deterministically by wins descending, podiums descending, total reward descending, then address ascending.

### Proof record

- Source: `GET /api/rounds/archive?days=90`.
- Backend archive rebuilds canonical V2 rounds from Arc Testnet contract state and reads settled winner ticket IDs, original entrants, current owners, claim status, and payout amounts.
- Live Railway archive proof on 2026-09-09:
  - Arc Testnet chain ID `5042002`
  - archive block `61275754`
  - retention `90` days
  - settled round count `1`
  - winner count `3`
  - ETH Daily High Round #4 winners: Ticket #4, Ticket #3, Ticket #2
- `app/leaderboard/page.tsx` filters the archive to `SETTLED` rounds and feeds their real winners into `buildLeaderboard()`.
- No hardcoded `players` array remains.

---

# 13. Remove all mock product state

Current state: **COMPLETE.** The normal product runtime no longer uses synthetic financial fixtures, seeded wallets, fake balances, fake tickets, fake predictions, fake claims, or localStorage-backed financial truth.

The old runtime files recorded in earlier checklist revisions are gone:

- `app/lib/data.ts` — absent
- `app/demo-state.tsx` — absent
- `app/verify/[roundId]/page.tsx` — absent
- `app/results/[roundId]/page.tsx` — absent
- `app/rounds/[slug]/RoundUserState.tsx` — absent

Current canonical surfaces use real backend and Arc Testnet state.

- [x] Remove mock USDC balance
- [x] Remove mock faucet
- [x] Remove mock player counts
- [x] Remove mock pool balances
- [x] Remove mock prediction entries
- [x] Remove mock tickets
- [x] Remove mock live position
- [x] Remove mock settlement/result fixture from normal product path
- [x] Remove mock claim balance updates
- [x] Remove localStorage as source of financial truth
- [x] Remove seeded leaderboard data
- [x] Keep any fixtures only outside normal product runtime

### Verification

- [x] Search repository for mock/demo financial state
  - Repo-wide runtime grep on 2026-09-09 found no removed demo-file references and no localStorage financial-state writes.
  - Matches such as `claimTicketKey`, `refundWalletAddress`, and `enterPrediction` are legitimate real product identifiers and execution paths, not mock state.
  - The only remaining `extrema-demo-state-v4` reference is `LEGACY_DEMO_STORAGE_KEY` in `app/wallet-session.tsx`; it is used solely to delete the obsolete demo localStorage key before backend session hydration.
- [x] Confirm normal app financial state is reconstructed from backend / Arc Testnet state
  - wallet session truth comes from `backendApi.wallet.get()`
  - results come from `/api/rounds/:slug/:roundId/result`
  - verification comes from `/api/rounds/:slug/:roundId/verification`
  - leaderboard comes from `/api/rounds/archive?days=90`
  - pools, tickets, balances, claims, refunds, entries, settlement, and marketplace state use their real backend/onchain paths

---

# 14. Security gate before final UI

### Current human runtime

- [x] No active human passkey/WebAuthn path or human `BACKEND_WALLET` signer path
- [x] `EXTERNAL_WALLET` actions are bound to the session wallet and every financial transaction is signed by that wallet.
- [x] `CIRCLE_USER_WALLET` actions are bound to the session wallet and Circle wallet id; every financial transaction uses a Circle hosted challenge.
- [x] Circle entry, transfer, refund, claim, marketplace list, update price, cancel, and buy are deterministically verified. Live Circle post-entry lifecycle transactions remain intentionally unproven.

### Legacy historical proof record

- [x] Legacy passkey step-up preceded the historical entry tx `0xf017bdbd00b4cf4bad6fd006d148e6b30210d3a7b15f3cbcaac389a7e7fea312` (section 0 and section 4).
- [ ] Legacy browser-passkey claim UI evidence was not separately recorded; this is not an open requirement for the current runtime.
- [x] Legacy passkey step-up was implemented for the historical refund design.
- [x] Action challenge bound to:
  - action type
  - chain ID
  - contract
  - round/ticket
  - amount
  - destination
  - expiry
  - one-time nonce
  - Proof: `CLAIM_PAYLOAD_AND_TYPE_BINDING=PASS`; canonical action payload hashing includes the bound fields above and action authorizations use a cryptographically random one-time nonce plus expiry.
- [x] Replay prevention verified
  - Proof: `CLAIM_CHALLENGE_SINGLE_USE=PASS`, `CLAIM_ACTION_SINGLE_USE=PASS`, and `HTTP_ACTIONS_E2E=PASS` replay scenario.
- [x] JWT alone cannot trigger a human financial action
  - External actions require a transaction signed by the session wallet and a receipt that matches the bound payload.
  - Circle actions require a transaction from the bound Circle wallet, created from the stored challenge identity and independently receipt-verified.
- [x] Rate limits verified
  - Proof: `HTTP_ACTIONS_E2E=PASS`; security scenarios include `rate-limit`.
- [x] Session expiry verified
  - Proof: expired authenticated action request returns `401 session_expired` in the HTTP E2E security harness.
- [x] Root/frontend dependency audit is 0
  - Security overrides pin patched transitive versions for `axios`, `ws`, `uuid`, `query-string`, and `decode-uri-component` without changing the EXTREMA wallet-stack API surface.
  - Clean `npm ci` completed successfully and reported 0 vulnerabilities.
  - `npm audit --omit=dev --json` reported 0 vulnerabilities: 0 critical, 0 high, 0 moderate, 0 low.
  - The exact override set was validated by production build/typecheck, Circle and multi-wallet security tests, Forge 67/67, and the full deterministic E2E matrix: 47 PASS, 0 FAIL, 4 unsupported by design.
- [x] Backend dependency audit remains 0
  - Proof: `npm --prefix backend audit --json` reported 0 vulnerabilities.
- [x] Secret rotation procedure documented
  - Procedure: `docs/SECURITY_OPERATIONS.md`.
  - Covers `JWT_SECRET`, `ENCRYPTION_KEY`, `EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED`, resolver-key rotation, Circle credentials, and database credentials.
  - `ENCRYPTION_KEY` rotation applies to legacy data that remains encrypted at rest and the active resolver/seed-agent envelopes; it never enables a human backend signer path.
- [x] No private key, JWT secret, encryption key, or credentials committed to Git
  - Repeatable verifier: `backend/scripts/verify-no-committed-secrets.js`.
  - The verifier prints rule/file names only, skips binary assets, and does not print matched secret values.
  - Verification result: `COMMITTED_SECRET_SCAN=PASS`.

Note on the resolver secret: the resolver key is held only as an AES-256-GCM envelope in the Railway environment. Neither the envelope nor the key is in this repository, and `backend/src/config.js` rejects any value that is not in envelope shape.

---

# 15. Final end-to-end Arc Testnet proof

This is the final functional acceptance test before visual polish.

One complete round must be demonstrated from start to finish:

- [ ] Create real round
- [ ] Fund real EXTREMA wallets with testnet USDC
- [ ] Enter at least 3 real predictions
- [ ] Confirm 1 USDC per entry transferred onchain
- [ ] Confirm 3+ real ERC-721 tickets minted
- [ ] Transfer at least one ticket before settlement
- [ ] Close entry
- [ ] Resolve using Binance Mark Price Klines
- [ ] Submit settlement on Arc Testnet
- [ ] Verify winners
- [ ] Verify transferred NFT ownership controls claim
- [ ] Claim real testnet USDC
- [ ] Verify treasury share
- [ ] Verify no double claim
- [ ] Verify all UI screens reflect real state
- [ ] Record all transaction hashes and explorer links

### Final proof record

#### 2026-09-22 consolidated single-round proof

A stable, read-only final verifier now runs in CI against the canonical Railway result and verification endpoints:

`backend/scripts/verify-final-round-proof.js`

GitHub Actions run `35716569947` completed successfully with:

`RESULT=FINAL_SINGLE_ROUND_PROOF_COMPLETE`

The consolidated live round is **ETH Daily High Round #4**:

- Chain ID: `5042002`
- Pool: `0xA5467fDCDAA0afaE379Fd8Ab0F9761944211725f`
- Ticket contract: `0xF65Cf4a67299ad596e139e3F6a9594E809F05637`
- Round ID: `4`
- Status: `SETTLED`
- Real entries: `3`
- Total stake: `3.0 USDC`
- Resolved price: `$2535.00`
- Winner #1: Ticket #4, prediction `$2508.56`, distance `$26.44`
- Winner #2: Ticket #3, prediction `$2507.56`, distance `$27.44`
- Winner #3: Ticket #2, prediction `$2506.56`, distance `$28.44`
- Settlement transaction: `0xa70d8ee5f5891d3a72e2f9f62f8680a6f737b27ad0999dc701386381826cdcc9`
- Settlement verification status: `VERIFIED`
- Evidence SHA256: `0451d8569c28edd05e76a008d259a52a5860f7280594f2968bad1882a266dd75`
- Source-data SHA256: `e3ebc5037503422a58bb0e968ef9bbdfa9917be0c8c8111a1dc082dfa7467392`
- Evidence hash, pool identity, market period and resolved-price integrity checks: all `true`
- Recorded live claim: Ticket #2, `0.405 USDC`
- Claim transaction: `0xc7913e802e228549cfb564e60eba6f6f57afbbc1e8e4e8fe33ee0f11e59cf2ff`
- Current claim state for Ticket #2: `isClaimed=true`, `claimableRaw=0`
- All three Round #4 winner tickets now read as claimed with zero remaining claimable USDC.

This closes the **core single-round settlement / winner / claim proof** used by the release roadmap.

The stricter acceptance list above is intentionally **not fully checked off**. In particular, Round #4 did not contain the later real secondary-market transfer, so these same-round requirements remain separate:

- transfer a ticket before settlement
- prove that transferred owner later claims that same round live
- record one complete creation/entry/mint/transfer transaction-hash bundle for the same round

Those ownership semantics are already deterministic E2E PASS, and a separate real marketplace sale has transferred a live ticket on Arc Testnet, but this document does not combine evidence from different rounds and call it one live end-to-end transferred-winner proof.

---

# 16. Secondary NFT marketplace

This is a **required EXTREMA product feature**, not an optional future idea.

Purpose:
- A prediction price slot can be minted only once per round.
- As the market moves, a scarce ticket may become materially more valuable than its original 1 USDC entry cost.
- The current NFT owner must be able to sell that position to another user for USDC.
- Buying the NFT transfers the same economic right already enforced by the pool: the current NFT owner owns the future claim/refund right.

## 16.1 Market model

- [ ] Build a secondary market for already-minted EXTREMA ticket NFTs
- [ ] Seller can list a currently owned ticket with an ask price denominated in real USDC
- [ ] Buyer can purchase a listed ticket with real Arc Testnet USDC
- [ ] Purchase transfers the real ERC-721 ticket onchain
- [ ] Marketplace never creates a new prediction slot
- [ ] Primary-market rules remain unchanged:
  - entry costs exactly 1 USDC
  - one primary entry per wallet per round
  - one exact prediction price can be minted only once per round
- [ ] Current NFT ownership after a secondary sale controls later claim/refund rights
- [ ] Listing cancellation is supported and proven onchain
- [ ] Filled/cancelled/expired listings cannot be purchased
- [ ] Marketplace UI shows prediction, direction, cadence, current owner, ask price, round timing, and ticket verification link
- [ ] No mock listings, mock volume, mock sales, or localStorage market state in the production path
- [ ] Decide and document whether one wallet may accumulate multiple tickets from the same round through secondary purchases

## 16.2 Market timing

- [x] DAILY secondary-market cutoff rule locked:
  - trading closes exactly **1 hour before `observationEndAt`**
  - no listing creation, listing purchase, or listing update may execute at or after that cutoff
  - the final hour is intentionally non-tradable to avoid last-minute execution/race problems near the daily outcome boundary
- [ ] Weekly secondary-market cutoff rule finalized
- [ ] Quarterly secondary-market cutoff rule finalized
- [ ] Contract/backend uses chain time or a deterministic onchain-derived cutoff, not browser time
- [ ] UI clearly shows remaining secondary-market trading time
- [ ] Read-only test proves a purchase is rejected at/after the market cutoff
- [ ] Real Arc Testnet trade is completed before cutoff and ownership change is verified

## 16.3 Marketplace proof gate

Before this section is complete, record:
- marketplace contract/address
- listing tx
- ask price
- buyer
- purchase tx
- seller USDC before/after
- buyer USDC before/after
- NFT owner before/after
- listing state before/after
- ArcScan links
- cutoff rejection proof
- final verification result

Implementation order:
1. Finish the core settlement, winner, payout, claim, and refund path first.
2. Then implement this marketplace on top of the already-proven transferable-ticket ownership model.
3. Complete marketplace functional/onchain proof before final visual design.

---

# 17. Design phase

The global EXTREMA visual system is now active across the normal product routes. The old structural wireframe runtime layer has been removed; final browser-level visual polish remains open.

- [x] Remove structural wireframe runtime layer
  - `app/wireframe.css` removed.
  - `app/layout.tsx` no longer imports `wireframe.css`.
  - The final remaining `wf-asset-mark` class was migrated to `ex-asset-mark`.
  - Repo-wide `wireframe.css|wf-` runtime grep returned no matches after cleanup.
- [x] Move current product routes onto the EXTREMA `ex-*` visual system
  - `/pools`
  - `/pools/[slug]`
  - `/results/[slug]/[roundId]`
  - `/verify/[slug]/[roundId]`
  - `/tickets`
  - `/leaderboard`
  - `/how-it-works`
  - `/wallet`
  - `/rounds/[slug]` is not a separate visual surface; it canonically redirects to `/pools/[slug]`.
- [x] Remove obsolete results / verification route conflict
  - `app/results/[roundId]/page.tsx` is absent.
  - `app/verify/[roundId]/page.tsx` is absent.
  - Canonical routes are `/results/[slug]/[roundId]` and `/verify/[slug]/[roundId]`.
  - Next.js production build completed successfully with both canonical dynamic routes.
- [x] Preserve all verified real onchain flows
  - The cleanup changed presentation/runtime CSS only. No backend, contract, schedule, signer, or financial execution path was modified.
  - Post-cleanup deterministic E2E: Forge `67/67`, Layer 1 `1/1`, Layer 3 `16/16`, root scripts `1/1`, matrix `47 PASS / 0 FAIL`, `EXTREMA_E2E=PASS`.
- [x] Production frontend build passes after wireframe removal
  - `npm run check` passed TypeScript generation, typecheck, and Next.js production build.
- [ ] Final browser-level visual polish **(IN PROGRESS)**
  - Review spacing, responsive behavior, alignment, overflow, and visual consistency on the canonical pages.
  - The homepage pair row still lacks dedicated Circle USDC and Arc brand marks. No corresponding asset files currently exist under `public`, so this remains a separate asset/polish task.
- [ ] Re-run the final live Arc Testnet single-round acceptance flow after visual integration
  - Deterministic E2E already passes after the visual cleanup.
  - The stricter Section 15 requirement remains separate because it requires one complete real round from creation through final claim.

---

## Current roadmap

Updated 2026-09-12.

> **Document rule.** Any material production, live proof, or submission status change must update this checklist in the same commit. A task is never considered closed only because it was discussed in chat.
>
> This file is the authoritative source for what is COMPLETE / LIVE PROVEN, what is IMPLEMENTED / WAITING FOR LIVE PROOF, and what is REMAINING.

The old calendar gated lifecycle proof is closed. As of 2026-09-09, the resolver had executed real cancellation and settlement transactions, a real refund and a real winner claim had moved Arc Testnet USDC, Circle production entry reconciliation was verified, and the live marketplace cache refresh path was proven. The 2026-09-11 updates are summarized in the [production state snapshot](#production-state-snapshot).

### Completed live proof gate: C6

- [x] Real Circle production ENTRY
- [x] Real Arc Testnet `settleRound` with 3 participants
- [x] Real winner ordering and treasury allocation
- [x] Real claim with actual pool → winner USDC movement
- [x] Real cancellation of an underfilled round
- [x] Real refund with actual pool → current-owner USDC movement
- [x] Live Railway marketplace cache refresh observation

These proofs intentionally do **not** imply that every negative case was redundantly broadcast on production. Live double-claim and double-refund attempts remain unperformed; their rejection is covered by deterministic contract/E2E tests.

### Open-source release packaging

- [x] MIT `LICENSE` added.
- [x] README now carries a prominent Arc Testnet-only / no operated real-money mainnet notice.
- [x] Frontend and backend environment templates contain placeholders/defaults only; obsolete WebAuthn/email-era template entries were removed.
- [x] Committed-secret scanning is a required deterministic CI step.
- [x] The live Arc Testnet proof was moved to a manual workflow so hosted-service/RPC availability cannot make normal source-code CI flaky.
- [x] Unreferenced `sil/` screenshots and the old design ZIP were removed from the release tree.
- [x] `SECURITY.md` added and linked to the existing operational secret-rotation guide.
- [x] Repository visibility changed to public and re-verified after green CI; only the `main` branch is present.
- [ ] Create the `v1.0-testnet` release/tag after the repository is public.

### Completed immediately after C6

- [x] **Final consolidated single-round core proof completed.** ETH Daily High Round #4 is re-verified in CI through the canonical live Result + Verify surfaces: 3 real entries / 3.0 USDC, SETTLED at $2535.00, winners [4,3,2], persisted settlement evidence VERIFIED, and the recorded Ticket #2 0.405 USDC claim remains reflected onchain as claimed with zero claimable balance. The stricter same-round transferred-winner acceptance item in Section 15 remains separately open.

- [x] **Stale Circle entry recovery UX fixed.** Commit `463d9b6` adds local recovery expiry handling, one read-only reconciliation probe for expired records, no blind ~3-minute polling, and no automatic second financial intent.
- [x] **WEEKLY and QUARTERLY round creation automation verified.** The generalized creation path is already wired into the production lifecycle. Live production state on 2026-09-09 showed 8/8 WEEKLY pools on V2 Round #3 and 8/8 QUARTERLY pools on V2 Round #2 with canonical schedules.
- [x] **Demo/mock runtime financial state removal verified.** Removed demo files are absent, runtime grep found no financial localStorage truth or seeded financial fixtures, and the obsolete demo storage key is deletion-only.
- [x] **Real settlement result and verification surfaces verified.** ETH Daily High Round #4 returned real settled winners and `VERIFIED` Binance/onchain evidence from the canonical Railway endpoints.
- [x] **Real leaderboard verified.** The page derives deterministic rankings from the real 90-day settled-round archive; the live archive returned Round #4 and three real winners.

### Completed major systems

Finished work, listed so it is not reopened. Items whose production proof is still open are listed under Remaining open work instead.

- [x] 24 pool / 24 ticket deployment
- [x] One economic Arc USDC model
- [x] Fixed 1 USDC stake
- [x] Payout and treasury math
- [x] Transferable ticket claim right semantics
- [x] DAILY / WEEKLY / QUARTERLY automation
- [x] Binance archive and settlement evidence
- [x] Real cancel proof
- [x] Real settle proof
- [x] Real refund proof
- [x] Real claim proof
- [x] External wallet execution
- [x] Circle real entry
- [x] Seed v3 implementation (implemented and deployed; daily 72/72 live proof is still open below)
- [x] Seed partial plan retry fix
- [x] RPC retry, failover and write safety
- [x] Result immediate historical snapshot UX
- [x] Verify Result user facing proof UX
- [x] Circle Gateway UI visibility correction
  - Proof: Circle loading, known-zero, positive, no-transferable-source, read-failure, recovery, and external-wallet visibility states are covered by deterministic UI validation: `GATEWAY_WALLET_UI=PASS`. The current compact source-form and recovery-safety coverage is `GATEWAY_SOURCE_FORM_UI=PASS`, `GATEWAY_SELECTED_SOURCE_BALANCE_UI=PASS`, `GATEWAY_DEPOSIT_RECONCILIATION_REQUIRED_PRESERVED=PASS`, `GATEWAY_UNCERTAIN_RECOVERY_FAILS_CLOSED=PASS`, and `GATEWAY_CLEAN_TERMINAL_RECOVERY_RELEASE=PASS`.
- [x] Gateway `RECONCILING` finality UX implemented and deterministically validated
  - The rail is status-only, polls the same `actionId` at approximately 10 seconds without overlap, preserves the durable recovery through a transient read failure, and blocks new deposit submission. The TTL cannot downgrade `RECONCILING`, `DEPOSIT_PENDING`, `RECONCILIATION_REQUIRED`, or a row with a durable approval/deposit transaction hash, Circle challenge id, or Circle transaction id into a clean expiry; rows with none of that evidence may expire. This is **IMPLEMENTED / VALIDATED**, not live UI proof until deployed and observed.
- [x] Gateway recovery safety and compact source-form UI implemented and deterministically validated
  - Proven code/UI root cause: a terminal expiry response could leave stale browser recovery active and globally lock funding. The earlier terminal-unlock treatment was too broad: `EXPIRED`, `FAILED`, and especially `RECONCILIATION_REQUIRED` are not, by name alone, proof that no financial submission reached the source chain.
  - Fix: `RECONCILIATION_REQUIRED` now survives backend TTL processing and returns the same durable action without a replacement transaction. The backend is the sole recovery-release authority: `recoveryDisposition=CLEAR` is returned for `COMPLETED`, or for terminal `FAILED`/`EXPIRED` rows with no financial evidence; it retires only local recovery and permits a manual new deposit, never an automatic retry. `recoveryDisposition=RECONCILE` preserves recovery, source lock, and status-only review for `RECONCILING`, `DEPOSIT_PENDING`, `RECONCILIATION_REQUIRED`, and terminal rows carrying any of `approval_tx_hash`, `deposit_tx_hash`, `approval_circle_challenge_id`, `deposit_circle_challenge_id`, `approval_circle_transaction_id`, or `deposit_circle_transaction_id`; the same applies to durable `APPROVAL_PENDING`, `APPROVAL_VERIFIED`, `DEPOSIT_PENDING`, `DEPOSIT_VERIFIED`, `RECONCILING`, and `RECONCILIATION_REQUIRED` states. Idempotency and ref identifiers alone are not treated as submission evidence. The deposit service currently invokes Gateway balance-delta reconciliation only for `RECONCILING`; `RECONCILIATION_REQUIRED` remains a read-only review state. The UI uses one selected-source `FROM | AVAILABLE | AMOUNT | ACTION` form. `AVAILABLE` is the selected source-wallet balance, never the unified Gateway balance. The Gateway summary remains separate. Circle source-wallet preparation remains Circle-only, while external-wallet source deposits retain the existing source-chain switch and signer checks.
  - Specific production OP financial outcome: **UNVERIFIED**. This work had no database access to retrieve a concrete OP action id, request id, Circle transaction, approval transaction, or deposit transaction. It is not classified as Class D; only an authoritative terminal response together with proof of no submitted/onchain deposit evidence could support that classification.
  - UI polish: pointer-selected dropdowns blur after selection without changing keyboard `:focus-visible`; the desktop header reserves a stable account footprint; the detached session panel is removed and Circle shows `End session` while an external wallet shows `Disconnect wallet` beside the address.
  - Proof: `GATEWAY_SOURCE_FORM_UI=PASS`, `GATEWAY_SELECTED_SOURCE_BALANCE_UI=PASS`, `GATEWAY_DEPOSIT_RECONCILIATION_REQUIRED_PRESERVED=PASS`, `GATEWAY_UNCERTAIN_RECOVERY_FAILS_CLOSED=PASS`, `GATEWAY_CLEAN_TERMINAL_RECOVERY_RELEASE=PASS`, `GATEWAY_POINTER_FOCUS=PASS`, `GATEWAY_HEADER_ACCOUNT_FOOTPRINT=PASS`, `GATEWAY_SESSION_CONTROLS=PASS`, `WALLET_PAGE_DEPOSIT_RECOVERY_LIVE_NETWORK_CALLS=0`, `GATEWAY_DEPOSIT_LIVE_NETWORK_CALLS=0`; no Circle challenge, approval, deposit, transfer, broadcast, or live network call was executed.
- [x] Circle Gateway deposit polling made phase-aware and recovery synchronization implemented
  - Root cause: `pollDeposit()` treated `pending=true` as “the current phase is unresolved”. The real approval verification response can be `DEPOSIT_CHALLENGE` with `pending=true`, so the client stayed in the approval poll and never executed the existing second challenge.
  - Fix: the shipped `gateway-actions.ts` poll helper now accepts a phase stop predicate. Approval polling continues through `APPROVAL_CHALLENGE` and `APPROVAL_PENDING` until the same action advances to `DEPOSIT_CHALLENGE` or a terminal/review state; deposit polling likewise continues through `DEPOSIT_CHALLENGE` and `DEPOSIT_PENDING` until `RECONCILING` or a terminal/review state. The same action’s recovery is persisted as `DEPOSIT_CHALLENGE` with the backend’s existing `depositChallengeId`, then `DEPOSIT_PENDING`, then `RECONCILING`; a resumed `APPROVAL_PENDING` recovery is advanced before executing any challenge.
  - Deterministic proof: `GATEWAY_CIRCLE_TWO_CHALLENGE_FLOW=PASS` executes the real transpiled Circle Gateway client against fakes and proves exactly one approval challenge, immediate return on `DEPOSIT_CHALLENGE`, exactly one deposit challenge, immediate return on `RECONCILING`, ordered progress `APPROVAL_CHALLENGE → APPROVAL_PENDING → DEPOSIT_CHALLENGE → DEPOSIT_PENDING → RECONCILING`, one action/request, and zero generic status fallback. `GATEWAY_CIRCLE_RESUME_PHASE_SYNC=PASS` proves the production-shaped `APPROVAL_PENDING` recovery probes the same action, executes only the existing deposit challenge once, advances recovery to `DEPOSIT_PENDING` and `RECONCILING`, and never starts a new action or approval challenge. `GATEWAY_CIRCLE_FINALITY_RAIL=PASS` proves the Wallet maps `DEPOSIT_CHALLENGE` to confirm-deposit, `DEPOSIT_PENDING` to deposit-submitted, and `RECONCILING` to the existing waiting-finality rail. All are deterministic, with zero live financial calls.
  - Live boundary: this correction resumed the preserved Arbitrum action above without creating a replacement action; its approval, deposit submission, Gateway credit/finality and source flow are now recorded as **LIVE PROVEN**. Gateway → destination transfer remains **NOT LIVE PROVEN**.
- [x] Circle Gateway approval bind durability and source-chain read-after-write confirmation implemented
  - Controlled production evidence for the untouched Base action `de39d94b-a607-4dbb-844f-f47e1e3552f0` / request `ae245fbe-42bf-4e7c-b1d6-aec0caef71cd`: source domain `6`, Base Sepolia chain id `84532`, `1 USDC` (`amountRaw 1000000`), Circle wallet `40a008e8-307b-554e-8cec-2bf45c2980a3`, approval challenge `6e72790e-889b-5d3d-ba10-5d52411ebd4e`, Circle approval transaction `78f5c802-2ff0-512f-b34d-5e6c00400e27`, approval tx `0x56a7f1c9ca6f4c440adaa843f976103bfb30e7945cc4bfec226cb4a3d8141f4a`, challenge status `COMPLETE`, current allowance `1 USDC`, and current source balance `18 USDC`.
  - The live action’s approval is **LIVE PROVEN**. Its durable row was observed as `APPROVAL_CHALLENGE` despite the bound approval evidence; `deposit_circle_challenge_id`, `deposit_circle_transaction_id`, and `deposit_tx_hash` were all null. Therefore the deposit is **NOT YET SUBMITTED / NOT LIVE PROVEN** for this action. Gateway remains `4 USDC` from earlier completed source credits. This task did not alter or retry the production row.
  - Root cause: after Circle positively bound an approval transaction, the service performed one source-chain read before changing the row state. A transient source RPC failure or stale allowance could then report `gateway_deposit_approval_failed` while leaving proven approval evidence under `APPROVAL_CHALLENGE`, forcing a misleading generic failure and an apparent retry handoff.
  - Fix: `bindTransaction()` now atomically persists approval evidence with `APPROVAL_PENDING`, or deposit evidence with `DEPOSIT_PENDING`, before any secondary confirmation. The resolver accepts both pending and challenge states for the next transition. After a bound approval, only bounded read-only source confirmation retries transport/provider availability errors or a stale `allowanceRaw < amountRaw`; chain-id, wallet/address, calldata, sender, target, configuration, malformed-read, and other security failures remain immediate fail-closed errors. Exhaustion preserves `APPROVAL_PENDING` and the approval evidence for the same action.
  - Circle recovery explicitly treats `APPROVAL_PENDING` and `DEPOSIT_PENDING` as read-only states: no hosted challenge, approval, deposit, action, or request is recreated. The same `actionId` is polled until the backend advances or requires genuine review. Activity projects legacy bound `APPROVAL_CHALLENGE` / `DEPOSIT_CHALLENGE` rows as `Approval submitted` / `Deposit submitted` with no action required, without rewriting historical evidence.
  - Proof: `GATEWAY_CIRCLE_APPROVAL_BIND_DURABLE_PENDING=PASS`, `GATEWAY_CIRCLE_DEPOSIT_BIND_DURABLE_PENDING=PASS`, `GATEWAY_CIRCLE_SOURCE_READ_AFTER_WRITE_RETRY=PASS`, `GATEWAY_CIRCLE_STALE_ALLOWANCE_RETRY=PASS`, `GATEWAY_CIRCLE_APPROVAL_PENDING_NO_REPROMPT=PASS`, `GATEWAY_CIRCLE_DEPOSIT_PENDING_NO_REPROMPT=PASS`, `GATEWAY_CIRCLE_PENDING_SAME_ACTION_RECOVERY=PASS`, `GATEWAY_ACTIVITY_BOUND_APPROVAL_SUBMITTED=PASS`, plus the retained Circle/finality/recovery markers. `GATEWAY_DEPOSIT_LIVE_NETWORK_CALLS=0`, `WALLET_PAGE_DEPOSIT_RECOVERY_LIVE_NETWORK_CALLS=0`, and `LIVE_GATEWAY_BROADCAST=NOT_EXECUTED`.
- [x] Seven-day human application sessions and secure Circle refresh implemented and deterministically validated
  - Cookie, JWT, and `auth_sessions` use `604800` seconds. Logout still revokes the DB session and clears the cookie; each financial action retains its own explicit external-wallet or Circle approval. Circle refresh credentials are encrypted server-side, identity-checked after rotation, and deleted on logout; unavailable refresh requires explicit Circle reauthentication. Production verification confirms the effective human session lifetime is `604800` seconds / seven days.
  - Deployment note: a future explicit Railway `JWT_TTL_SECONDS` override remains authoritative and must be changed deliberately. This task did not change Railway environment state.
- [x] Existing pool 60-second refresh validated and hardened
  - Board and detail polling already existed. This change adds in-flight guards, retains last valid round/distribution data on transient refresh failure, and keeps own-entry immediate reconciliation. No WebSocket/SSE or artificial data was added.
- [x] Gateway generalized to both human execution modes (funding and source deposit)
  - Proof: `GATEWAY_FUNDING_EXTERNAL_WALLET=PASS`, `CIRCLE_BASE_WALLET=PASS`, `GATEWAY_DEPOSIT_EXTERNAL=PASS`, `GATEWAY_DEPOSIT_CIRCLE=PASS`; the Gateway section and Base Sepolia source sub-section now render for both `CIRCLE_USER_WALLET` and `EXTERNAL_WALLET` sessions.
- [x] Production bug fixed: Base Sepolia wallet preparation never executed the Circle hosted challenge
  - Found live in commit `93efa5d`: `handlePrepareBaseWallet()` requested a `CHALLENGE_REQUIRED` preparation but never called `executeHostedChallenge`, and minted a fresh `crypto.randomUUID()` idempotency key on every click instead of using the already-present `CircleBaseWalletRecovery` helpers. The button appeared to do something, then silently returned to the same state with no Circle challenge ever shown.
  - Fix: `handlePrepareBaseWallet()` now reads/reuses a live `CircleBaseWalletRecovery` (same idempotency key across retries), persists the challenge id before executing it, calls the existing `executeHostedChallenge` from `circle-actions.ts`, reconciles read only and bounded afterward (Circle eventual consistency), and clears recovery only once the resulting address is confirmed to match the Arc session wallet. A definite non-landing after a reported failure/expiry clears recovery for an explicit restart; every other uncertain outcome preserves it for the next click.
  - Proof: `CIRCLE_BASE_WALLET_UI=PASS` (new, in `verify-circle-base-wallet.js`) statically proves the executor is wired in, recovery is stored before execution, an existing challenge is resumed without a second `createWallet` call, a new idempotency key is never minted while a live recovery exists, and every "ready" transition clears recovery first. No Circle wallet creation, Base USDC approval, Gateway deposit, or Gateway broadcast was executed to produce this proof.
  - **Still NOT LIVE PROVEN**: this closes the code bug; it has not yet been re-verified against the live production Circle flow for the Arc wallet `0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876` that reported the symptom.
- [x] Production bug fixed: Gateway Circle approval reconciliation defaulted to ARC-TESTNET and rejected a genuine Base Sepolia transaction
  - Found live at commit `bc48389`, for the same Arc wallet `0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876`: after the user explicitly approved the hosted `USDC.approve(GatewayWallet, 2000000)` challenge and Base Sepolia allowance genuinely became 2.0 USDC, the durable action (`769088d9-cd91-4466-92e1-726ac76e8cf4`, request `5208053f-c67e-44b1-907c-8bc4f04c5d27`) stayed stuck at `APPROVAL_CHALLENGE` and the UI surfaced `circle_transaction_mismatch`. Root cause: `circleExecutionEngine.resolvePhaseTransaction` never threaded a `blockchain` parameter into `circle.getContractExecutionTransaction`/`findContractExecutionTransaction`, so `circleUserWalletService`'s `ARC-TESTNET` default was used to validate a transaction that genuinely lives on `BASE-SEPOLIA`.
  - Fix: `resolvePhaseTransaction` takes an additive `blockchain = circleUserWalletService.ARC_TESTNET` parameter (every existing Arc caller is unchanged since none pass it), and `gatewayDepositService.resolveCirclePhase` now passes `blockchain: source.circleBlockchain` (`'BASE-SEPOLIA'` for the current source). Challenge creation was untouched; this was a reconciliation-only bug.
  - Recovery: the existing production action reconciles forward with no manual database mutation, no new approval challenge, no new idempotency key, and no re-issued approve calldata — the next call to `verifyApproval` for the SAME action binds the already-known Circle transaction id and moves the SAME action to `DEPOSIT_REQUIRED` / `DEPOSIT_CHALLENGE`.
  - Proof: `GATEWAY_DEPOSIT_PRODUCTION_RECONCILIATION=PASS` (new) replays the exact production row shape and proves the reconciliation binds the already-landed transaction with zero new Circle mutations; `CIRCLE_ENGINE_BLOCKCHAIN_DEFAULT=PASS` (new) proves the engine still defaults to `ARC-TESTNET` when no blockchain is given; `GATEWAY_DEPOSIT_WRONG_BLOCKCHAIN_FAILS_CLOSED=PASS` (new) proves a genuine mismatch still fails closed. Verified by temporarily reverting the fix and confirming these tests fail with the exact same `circle_transaction_mismatch` production saw, then restoring it.
- **Historical boundary:** this source deposit had reached `RECONCILING` at this point in the timeline. Later production reconciliation confirmed the `2 USDC` Gateway credit recorded above; Gateway → Arc burn/transfer remains unproven for both execution modes.
- [x] Production bug fixed: Gateway deposit recovery UI derived the amount from the disabled, empty input instead of the durable recovery
  - Found live for the same still-pending production action (`769088d9-cd91-4466-92e1-726ac76e8cf4`, `sourceDomain 6`, `amountRaw 2000000`, Circle mode): the Wallet page correctly detected the existing deposit recovery and showed "Recovering previous operation...", the amount input was disabled and visually empty, but clicking the recovery button parsed the empty editable field instead of using `depositRecovery.amountRaw` and immediately rejected with "Enter a valid USDC amount". No Circle challenge opened; no backend call and no financial mutation occurred.
  - Fix at that point: `handleGatewayBaseDeposit()` in `app/wallet/page.tsx` treated a live `depositRecovery` as the authoritative financial intent: it used `depositRecovery.amountRaw`/`depositRecovery.sourceDomain` directly (failing closed if the source domain did not match the one configured source), and only fell back to parsing the editable input when no recovery existed. The two recovery-load effects also seeded the display field with `formatGatewayUsdcRaw(recovery.amountRaw)` so it never showed empty/0.000000 while a real amount existed. The idle button read "Continue previous operation" ("Önceki işleme devam et") instead of the misleading "Recovering previous operation...", which was reserved for an actual in-flight resume. The then-current `gateway_deposit_expired` behavior preserved recovery; that terminal browser-lock behavior is superseded by the later terminal recovery unlock recorded above.
  - Recovery: unchanged call path — `confirmGatewayBaseDeposit` still resumes the SAME action via `gateway-actions.ts`'s existing recovery-first logic (`verifyGatewayDepositApproval`/`verifyGatewayDeposit` against the stored `actionId`); the page itself never mints a new request id or clears recovery before calling it.
  - Historical proof: `WALLET_PAGE_DEPOSIT_RECOVERY_UI=PASS` (then-new, in `verify-gateway-deposit.js`) proved the recovery branch was resolved before any input parsing, the input-parsing error was unreachable when recovery existed, both recovery-load effects seeded the display amount, the input stayed disabled, and the idle/busy button labels were correct. The current proof for uncertain recovery safety is `GATEWAY_UNCERTAIN_RECOVERY_FAILS_CLOSED=PASS`.
- **Updated live boundary:** source-chain deposit and Gateway credit proof are recorded above. This recovery/finality UI change remains **IMPLEMENTED / VALIDATED** until its visual state is observed in production; Gateway → Arc transfer remains unproven.
- [x] Architecture correction: Gateway is a unified balance, so the UI no longer asks the user to choose a source
  - Found by reviewing the shipped transfer UI: it asked the user to select a Gateway SOURCE domain and pinned Arc as the only destination. That inverts the product model. Circle Gateway is one unified USDC balance; which deposited source ledger is consumed is protocol execution detail, and a user who has 1.00 on Base and 0.75 on OP could not send 1.50 anywhere at all, because no single source covered it.
  - Correction: the transfer contract is now `destinationDomain` + `valueRaw`. The source selector is gone from the UI and `sourceDomain` is no longer accepted when starting a transfer. The fee-aware Gateway planner resolves the plan server-side, reserves every returned `maxFee`, and may draw on several source domains for one transfer. The destination is selectable across five canonical networks, with the destination token and minter always read from server config. Same-chain withdrawal is permitted, and Arc became a spendable source domain as well as a destination.
  - Product UI: `GATEWAY` now shows one unified balance plus Send USDC (destination selector, amount, Prepare transfer), and `ADD USDC TO GATEWAY` shows one selected-source form across Base, OP, Arbitrum and Ethereum Sepolia. The form has `FROM`, `AVAILABLE`, `AMOUNT`, and `ACTION` columns; its available balance is the selected source wallet and is never the unified Gateway balance. No domain number, chain id or protocol term reaches the user.
  - Canonical config: one server-side table (`gatewayNetworks.js`) owns every chain id, Gateway domain, USDC address, Circle blockchain identifier and label. `baseSepoliaService.js` was replaced by the generic `gatewaySourceChainService.js`: one state machine, four configurations. Circle blockchain identifiers come from the installed SDK's own enum strings, asserted at verification time.
  - Multi-source signing: one EIP-712 `BurnIntent` signature per allocation, submitted as one array of `{ burnIntent, signature }` entries, which is Circle's documented multi-source shape for this forwarding path. Circle's `BurnIntentSet` typehash is recorded and verified against Circle's own contract source but deliberately not signed, because a set signature needs a set-shaped request body that is not confirmed for this path.
  - Backward compatibility: every schema change is additive. `gateway_funding_actions` gains `destination_domain`, `source_plan_json` and the per-allocation intent/signature/challenge columns; `source_domain` becomes nullable and historical rows keep theirs exactly, backfilled as `destination_domain = 26`. `GATEWAY_FUNDING_LEGACY_ROW_COMPATIBLE=PASS` reconstructs a pre-correction row and proves it still reads, verifies and submits. The live Base Sepolia deposit proof above is untouched and remains live proven.
  - Proof: `GATEWAY_CANONICAL_NETWORK_CONFIG=PASS`, `GATEWAY_CIRCLE_BLOCKCHAIN_IDENTIFIERS=PASS`, `GATEWAY_FOUR_SOURCE_CHAINS=PASS`, `GATEWAY_DESTINATION_GENERALIZATION=PASS`, `GATEWAY_SAME_CHAIN_WITHDRAWAL=PASS`, `GATEWAY_BURN_INTENT_SET_TYPESTRING=PASS`, `GATEWAY_AUTO_SOURCE_PLANNER=PASS`, `GATEWAY_MULTI_SOURCE_INTENT=PASS`, `GATEWAY_FRONTEND_NEVER_CHOOSES_SOURCE=PASS`, `GATEWAY_MULTI_CHAIN_DEPOSIT=PASS`, `GATEWAY_SOURCE_FORM_UI=PASS`, `GATEWAY_SELECTED_SOURCE_BALANCE_UI=PASS`, `GATEWAY_DEPOSIT_RECONCILIATION_REQUIRED_PRESERVED=PASS`, `GATEWAY_UNCERTAIN_RECOVERY_FAILS_CLOSED=PASS`, `GATEWAY_EXTERNAL_CHAIN_SWITCH=PASS`, `CIRCLE_SOURCE_WALLET_ALL_CHAINS=PASS`, `GATEWAY_FUNDING_LEGACY_ROW_COMPATIBLE=PASS`, all with zero live network calls and `LIVE_GATEWAY_BROADCAST=NOT_EXECUTED`.
  - **Still NOT LIVE PROVEN**: every Gateway transfer (to Arc, Base, OP, Arbitrum or Ethereum), the OP/Ethereum source deposits, the external-wallet full Gateway flow, multi-source aggregation, same-chain withdrawal and the live Activity/finality visual. The controlled Arbitrum source deposit is separately proven below; `EXTREMA_ENABLE_GATEWAY_BROADCAST` stays `false`.
- [x] Production bug fixed: split-brain Circle authentication caused OP/Arbitrum Gateway deposit clicks to fail before ever reaching the backend
  - Found live for Circle wallet `0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876`: the EXTREMA application session lasts seven days, but Circle's `userToken`/`encryptionKey` are deliberately tab-scoped only (sessionStorage, never persisted). The application session was alive and the Wallet page rendered READY (`circleAuthPresent: false`, `gatewayDepositRecovery: null`), but every Circle financial entry point began with `readCircleTabAuth(); if (!auth) throw new Error("circle_reauthentication_required")` — a hard client-side stop before any backend call. Confirmed by production DB evidence: the latest Arbitrum click created **no** `gateway_deposit_actions` row at all, so it was never a financial submission.
  - Fix: a shared, single-flight `ensureCircleFinancialAuth()` in `circle-actions.ts`. It returns existing tab auth immediately when present; otherwise it calls the existing, unmodified `/circle/session/refresh` route — which is already the sole authority, reading only the authenticated session's own encrypted refresh credentials and re-verifying the rotated token resolves to the SAME Circle wallet id and address before returning anything — stores only `{ userToken, encryptionKey }`, and resumes the SAME originally requested financial intent. Concurrent callers share exactly one refresh request. Any restore failure converges to `circle_reauthentication_required`; no financial challenge, approval, deposit or transfer is ever created merely by restoring auth. Every Circle financial entry point now uses this bootstrap instead of asserting `readCircleTabAuth()` directly: `executeHostedChallenge`, `confirmCircleEntry`, `confirmCircleGatewayFunding`, `confirmCircleAction` (all in `circle-actions.ts`), `runCircleDeposit` (`gateway-actions.ts`, the exact production path), and the Wallet page's per-chain Circle readiness effect and `handlePrepareSourceWallet`. The Wallet page also now distinguishes `circle_reauthentication_required` from a generic Gateway failure, routing to the existing Circle reauthentication UI instead of showing "Gateway deposit could not be completed."
  - Proof: `CIRCLE_AUTH_BOOTSTRAP=PASS` (new, in `verify-circle-auth-bootstrap.js`), executing the real transpiled TypeScript against fakes for all seven cases — existing auth used directly with no refresh; missing auth refreshes exactly once and proceeds; three concurrent callers share exactly one refresh; a refresh failure fails closed with zero financial start calls and zero Circle challenges; Gateway deposit and Gateway funding transfer both restore auth before their financial start call; and every entry point is statically proven to use the shared bootstrap rather than a direct `readCircleTabAuth()` call. Verified by reverting each site individually and confirming the exact expected failure, then restoring it.
  - **Still NOT LIVE PROVEN**: this closes the code bug deterministically; it has not yet been re-verified against a live production click for the same Circle wallet.
- [x] Production bug fixed: a lost browser recovery could let a second, concurrent Gateway deposit action be created for a source domain that already had an unresolved one
  - Found from the same production evidence: sessionStorage recovery for the durable Gateway source deposit action can legitimately disappear (reopened browser, new tab, cleared storage) while the backend's durable action does not. Before this fix, a browser with no memory of a prior attempt could mint a fresh request id and `gatewayDepositService.start()` would happily create a second row for the same source domain, potentially issuing a second Circle challenge against a source that already had one outstanding.
  - Fix: `gatewayDepositService.start()` now checks, only when the given request id has never been seen before (the normal same-request-id resume path is untouched), whether an existing row for the same `(user, wallet, execution mode, source domain)` has a recovery disposition that is not `CLEAR` (reusing the existing `recoveryDispositionFor` classifier, not new logic). If one exists, it throws `gateway_deposit_source_review_required` before any row is inserted and before any Circle challenge or external transaction request is created. The guard is scoped strictly to source domain: an unresolved review on one source never blocks a distinct, intentionally selected source. A `CLEAR` historical action (`COMPLETED`, or `FAILED`/`EXPIRED` with no submitted financial evidence) never blocks a new manually initiated deposit for the same source. There is no blind retry of the uncertain action anywhere in this path.
  - Proof: `GATEWAY_SAME_SOURCE_REVIEW_GUARD=PASS` (new, in `verify-gateway-deposit.js`) proves: an unresolved same-source action blocks a new one with no row inserted and no challenge created; an `EXPIRED` row that carries a durable approval challenge id is treated as review, not as a clean restart; a `COMPLETED` prior action never blocks a new one; a `FAILED`-with-no-evidence prior action never blocks a new one; an unresolved OP action never blocks a distinct Arbitrum source intent; and replaying the SAME request id for an unresolved action still resumes it rather than throwing. `GATEWAY_MULTI_CHAIN_CIRCLE_PREFLIGHT=PASS` (new) additionally proves the Circle branch signs with each chain's own companion wallet id, reports each chain's own chain id, and reconciles against each chain's own `circleBlockchain`, never defaulting to `ARC-TESTNET`, across Base, OP, Arbitrum and Ethereum Sepolia. Verified by reverting the guard and confirming the exact expected failure, then restoring it.
- **Still NOT LIVE PROVEN**: the historical OP action `2e442e30-4176-4e5f-b32d-b6aa468c1778` (`requestId 78aec3a4-2c6d-44da-9c35-789854e24dc6`, `sourceDomain 2`, `amountRaw 2000000`, `state EXPIRED`, `approvalCircleChallengeId 1bfb0ac0-331d-5ddc-97a6-9c5e25ba7661`, no observed Circle transaction id and no approval tx hash) was not mutated by this fix and remains **REVIEW / UNVERIFIED**; the new guard will now correctly refuse a fresh OP deposit attempt until that action is explicitly resolved, which is exactly what lets Arbitrum or Ethereum be live-proven next without blind-retrying OP.
- [x] Gateway deposit recovery disposition separates active resume from uncertain reconciliation
  - The prior classifier let any durable challenge or transaction evidence override the state name, so an active `DEPOSIT_CHALLENGE` was reported as `RECONCILE` and the Wallet could not resume its existing deposit challenge. `ACTIVE_RESUMABLE_STATES` now explicitly covers `STARTED`, `BASELINE_READ`, `APPROVAL_REQUIRED`, `APPROVAL_CHALLENGE`, `APPROVAL_PENDING`, `APPROVAL_VERIFIED`, `DEPOSIT_REQUIRED`, `DEPOSIT_CHALLENGE`, `DEPOSIT_PENDING`, and `DEPOSIT_VERIFIED`; these return `RESUME` even when evidence exists. `RECONCILING` and `RECONCILIATION_REQUIRED` return `RECONCILE`; only `FAILED`/`EXPIRED` apply evidence-aware terminal release, and unknown states fail closed.
  - The same-source guard still rejects a new request for any disposition other than `CLEAR`, while the same request id resumes the same active action. The Wallet keeps the durable source and amount locked, exposes `Continue previous operation` for `RESUME`, and renders the detailed `RECONCILE` review copy once in `ACTION` without duplicating it in the full-width error banner.
  - Proof: `GATEWAY_ACTIVE_RECOVERY_RESUMABLE=PASS`, `GATEWAY_RESUME_STILL_BLOCKS_DUPLICATE=PASS`, `GATEWAY_RESUME_UI=PASS`, `GATEWAY_REVIEW_MESSAGE_RENDERED_ONCE=PASS`, with existing `GATEWAY_SAME_SOURCE_REVIEW_GUARD=PASS` and zero live financial/network calls.
  - Status: **IMPLEMENTED / DETERMINISTICALLY VALIDATED**. The preserved Arbitrum action is now **LIVE PROVEN** through approval, deposit submission, Gateway credit/finality and source flow; Gateway → destination transfer remains **NOT LIVE PROVEN**.
- [x] Gateway Activity PostgreSQL UUID/text compatibility corrected
  - The first production deployment of server-backed Gateway Activity exposed a PostgreSQL type incompatibility in its terminal-row classification: `approval_circle_transaction_id` and `deposit_circle_transaction_id` are `UUID`, so applying `BTRIM()` to either field failed with `42883 function btrim(uuid) does not exist` before Activity rows could render.
  - Fix: text/VARCHAR evidence fields use `NULLIF(BTRIM(column), '') IS NULL`; the two UUID Circle transaction fields use native `IS NULL`. Recovery semantics are unchanged: `COMPLETED` is clear; `FAILED`/`EXPIRED` are clear only without durable evidence; evidence-bearing terminal rows remain unresolved/review. Same-source duplicate protection is unchanged.
  - Deterministic proof: `GATEWAY_ACTIVITY_POSTGRES_TYPES=PASS` reads the real `gateway_deposit_actions` schema, confirms the UUID/text column types, inspects the Activity SQL structurally, and proves UUID fields are not trimmed or cast to text. All existing Activity markers remain PASS.
  - No financial mutation occurred while diagnosing or correcting this query. Activity remains **IMPLEMENTED / DETERMINISTICALLY VALIDATED**; its production visual/live proof remains **NOT LIVE PROVEN** until the corrected deployment succeeds and real server-backed rows render. Base and Arbitrum source-deposit LIVE PROVEN facts remain unchanged; OP remains **REVIEW / UNVERIFIED**.
- [x] Gateway terminal review resolution is durable and evidence-aware
  - Read-only production review recorded the OP historical action as a Circle challenge `FAILED` with no Circle transaction, and the Base historical action as an approval challenge `COMPLETE` with onchain approval tx `0x0bde28c43393920cf459f805421ca866300cdffe81596e63918cd3d44fd028f` for `2 USDC`, successful receipt, no deposit evidence, and current Gateway allowance `0`.
  - The additive review-resolution mechanism is **IMPLEMENTED / DETERMINISTICALLY VALIDATED**: only exact terminal `last_error` codes `gateway_deposit_review_resolved_no_transaction` and `gateway_deposit_review_resolved_approval_only` release local same-source recovery. They preserve all existing Circle challenge/transaction identifiers and approval/deposit hashes; unknown error codes and evidence-bearing terminal rows without an explicit resolution remain `RECONCILE`, while `RECONCILIATION_REQUIRED` remains fail-closed.
  - Resolved `FAILED`/`EXPIRED` rows remain visible in bounded recent Activity history as terminal, without `Action required` or badge attention, and a new same-source request is allowed only after the explicit durable marker. No automatic retry or new request is created.
  - Proof: `GATEWAY_REVIEW_RESOLUTION_DURABLE=PASS`, `GATEWAY_REVIEW_RESOLUTION_PRESERVES_EVIDENCE=PASS`, `GATEWAY_REVIEW_RESOLUTION_RELEASES_SOURCE=PASS`, `GATEWAY_ACTIVITY_POSTGRES_TYPES=PASS`, and all existing Gateway Activity markers. No production cleanup update or OP/Base final retest has been performed; OP remains **REVIEW / UNVERIFIED**.
- [x] Ethereum Sepolia Gateway approval and finality handoff UX audit recorded
  - Read-only production evidence for action `7c7e6b83-0edf-4442-8118-5d8be80a6101` / request `7ed30547-8872-4da4-9c3b-4643f2a42f07`: source domain `0`, Ethereum Sepolia chain id `11155111`, and `1 USDC` (`amountRaw 1000000`). The Circle approval challenge `COMPLETE` produced Circle transaction `63fa05c4-a3a2-5ed5-bbf8-0bab7c3ab8d1`, approval tx `0xd6446c966f3787a2dcd2440d4176da3da140d71fe2696215c41ca74d50765844`, and the observed Gateway allowance was `1 USDC`.
  - The subsequent deposit hosted challenge was visually verified against GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, Ethereum Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, and `1 USDC`; the durable action is currently `RECONCILING`. Ethereum Gateway credit and the full Ethereum source deposit remain **NOT LIVE PROVEN** pending unified/source-domain balance evidence.
  - The controlled production action exposed two UX defects now corrected: `RECONCILING` incorrectly appeared as `Action required`, and releasing the form into Activity did not explain the background finality handoff or prevent an apparent same-source retry. The correction is **IMPLEMENTED / DETERMINISTICALLY VALIDATED**: `RECONCILING` remains an open, status-only Activity row with no action required; the form explains that finality continues in Activity, keeps the selector available, and replaces only the same-source action with a choose-another-source hint.
  - After a hosted approval challenge, only Circle `circle_service_unavailable` and `circle_rate_limited` receive a bounded read-only approval-status retry. Exhaustion preserves the same recovery and shows a pending-status message; no second approval challenge, action, transaction, deposit, transfer, or broadcast is created. Proof: `GATEWAY_FINALITY_NO_ACTION_REQUIRED=PASS`, `GATEWAY_FINALITY_ACTIVITY_OPEN_COUNT=PASS`, `GATEWAY_FINALITY_FORM_HANDOFF_NOTICE=PASS`, `GATEWAY_FINALITY_SAME_SOURCE_UI_GUARD=PASS`, `GATEWAY_FINALITY_DIFFERENT_SOURCE_UI_OPEN=PASS`, `GATEWAY_CIRCLE_TRANSIENT_APPROVAL_READ_RETRY=PASS`, `GATEWAY_CIRCLE_NO_SECOND_APPROVAL_PROMPT=PASS`, and `GATEWAY_CIRCLE_TRANSIENT_READ_PRESERVES_RECOVERY=PASS`. No additional live financial mutation or broadcast was executed.
- Safe public Gateway deposit/Circle source-wallet errors are now allowlisted in `server.js` and deterministically enforced: `verify-action-error-surface.js`'s `GATEWAY_DEPOSIT_ERRORS_SAFE_LISTED=PASS` reads every literal error code `gatewayDepositService.js`, `gatewaySourceChainService.js` and `circleUserWalletService.js` can throw directly from their own source and asserts each one is public, including the new `gateway_deposit_source_review_required`, so a future uncovered code can never again collapse silently to a bare `internal_server_error`.
- [x] Circle Gateway -> Arc typed-data signing failure diagnosed and corrected at the Circle wire boundary
  - Authoritative production attempt: action `1f1b3f46-ed89-43c3-b244-dc76b52e5b4d`, request `3b442b2d-4bda-4bb0-b0a5-fd39f1e0a2e4`, destination Arc Testnet domain `26`, amount `1 USDC`, selected source Base Sepolia domain `6`, payload hash `b1f995fee28cdb84a6cfc711f7ac6ad1792cf0bd4ea7bef34ae9076f2b2f88b7`; Gateway estimate and source plan were LIVE PROVEN.
  - Circle hosted challenge `fffedf7e-5a4e-5a51-aea9-fc5b3e8bc18f` was `FAILED` with errorCode `156026` and typed-data validation error `there is extra data provided in the message (0 < 2)`. The persisted payload had domain `{name: "GatewayWallet", version: "1"}`, primaryType `BurnIntent`, and `BurnIntent`/`TransferSpec` types without an `EIP712Domain` declaration.
  - Signature: **NONE**. Gateway transfer id: **NONE**. Gateway transaction hash: **NONE**. Broadcast: **NOT EXECUTED**. Funds moved: **NO**. The specific production financial outcome is therefore recorded only as this authoritative failed pre-submission attempt; no Gateway transfer or destination credit was proven.
  - Root cause: the internal ethers typed-data object deliberately carried a name/version-only domain, but Circle's wire API requires an EIP-712 JSON string whose `types` includes the matching `EIP712Domain` declaration. The fix adds only that wire declaration, derived from domain fields actually present (`name`, `version`, `chainId`, `verifyingContract`, `salt` in canonical order); internal types, typed data, digest and payload hash remain unchanged. Unknown domain fields and mismatched declarations fail closed.
  - Circle challenge diagnostics now preserve only bounded safe `errorCode`/`errorMessage` metadata. Only errorCode `156026` maps to durable `gateway_signature_typed_data_invalid`; other failures remain `gateway_signature_challenge_failed`.
  - `SIGNATURE_FAILED` is terminal, `readyToBroadcast = false`, and `broadcast = NOT_SUBMITTED`; read/verify returns the durable action and never creates another challenge. Browser recovery is cleared only after a same-action read proves `SIGNATURE_FAILED`/`FAILED`/`EXPIRED` with no transfer id or transaction hash; evidence-bearing terminal outcomes remain fail-closed for reconciliation. READY_TO_BROADCAST remains preparation only, the UI says it is authorized and ready for submission while Gateway submission is disabled, and `EXTREMA_ENABLE_GATEWAY_BROADCAST` remains `false`.
  - Proof: `GATEWAY_CIRCLE_WIRE_EIP712_DOMAIN=PASS`, `GATEWAY_CIRCLE_WIRE_DOMAIN_MATCH=PASS`, `GATEWAY_CIRCLE_WIRE_DIGEST_PRESERVED=PASS`, `GATEWAY_CIRCLE_WIRE_INTERNAL_TYPES_UNCHANGED=PASS`, `GATEWAY_CIRCLE_WIRE_UNKNOWN_DOMAIN_FAILS_CLOSED=PASS`, `GATEWAY_CIRCLE_TYPED_DATA_FAILURE_DIAGNOSTICS=PASS`, `GATEWAY_FUNDING_SIGNATURE_FAILED_TERMINAL=PASS`, `GATEWAY_FUNDING_TERMINAL_RECOVERY_RELEASE=PASS`, `GATEWAY_FUNDING_NO_AUTOMATIC_RESIGN=PASS`, `GATEWAY_FUNDING_FRESH_REQUEST_AFTER_TERMINAL=PASS`, `GATEWAY_FUNDING_READY_NOT_BROADCAST=PASS`, and `LIVE_GATEWAY_BROADCAST=NOT_EXECUTED`.
- [x] Ethereum Sepolia fallback RPC default corrected
  - Production read-only evidence recorded: primary Ethereum Sepolia endpoint was healthy for chain id `11155111` and `19 USDC` with allowance `0`; the old fallback returned HTTP `400` with `chain is not available on free plan`.
  - Only the default `ETHEREUM_SEPOLIA_RPC_FALLBACK_URL` changed to `https://public.1rpc.io/sepolia`; the primary URL, environment override precedence, static chain-id validation, and Base/OP/Arbitrum RPC configuration remain unchanged. The new endpoint is **IMPLEMENTED / DETERMINISTICALLY VALIDATED**, not live-proven in this task.
  - Proof: `ETHEREUM_SEPOLIA_FALLBACK_CONFIG=PASS`; no live RPC call was made.
- [x] Gateway -> Arc outbound completion and normal-user submit/recovery UX proof recorded
  - Authoritative live proof for Circle wallet `0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876`: action `38a941ba-c1f4-47e7-903d-d70ec80bf098`, request `8cb5b8b8-a15b-48f4-b8f2-fce2ca762a57`, source Arbitrum Sepolia domain `3`, destination Arc Testnet domain `26`, and requested value `1 USDC` (`1000000` raw).
  - Circle EIP-712 signature was **LIVE PROVEN**. Gateway transfer id: `ca054213-e5df-4bc3-8f36-473acb48e59f`. Destination tx: `0xf46c922fcaf51d1360ca40be8623f7b6a04c2b9444c8055e12e4b72d7d046e72`. Final backend state: `COMPLETED`; `lastError: null`; broadcast: `COMPLETED`.
  - Exact balance evidence: Arc USDC `36.960408 -> 37.960408` (`+1.000000 USDC`); Gateway unified balance `7.000000 -> 5.974645`. This proves **Gateway -> Arc FULLY LIVE PROVEN** only; it does not close the other outbound destinations.
  - Separately, source deposits from Ethereum Sepolia, Base Sepolia, OP Sepolia and Arbitrum Sepolia remain **FULLY LIVE PROVEN** through their approved source flows. This source-deposit proof is distinct from outbound destination proof.
  - The normal Wallet path now keeps the same action recovery through `READY_TO_BROADCAST`, exposes `submissionEnabled` from the server runtime gate, submits only through the authenticated backend route on an explicit user click, polls the same action read-only through `SUBMITTING`/`SUBMITTED`, fails closed on uncertainty, and clears recovery only after authoritative `COMPLETED` or a proven clean pre-submission terminal response. A completed reload returns to the idle form, shows a human success notice, and refreshes balances without starting a new transfer.
  - Proof: `GATEWAY_FUNDING_COMPLETED_RECOVERY_CLEARS=PASS`, `GATEWAY_FUNDING_COMPLETED_FORM_RESETS=PASS`, `GATEWAY_FUNDING_COMPLETED_SUCCESS_NOTICE=PASS`, `GATEWAY_FUNDING_SUBMITTED_STATUS_ONLY=PASS`, `GATEWAY_FUNDING_NO_DUPLICATE_SUBMIT=PASS`, `GATEWAY_FUNDING_UI_SERVER_GATED_SUBMIT=PASS`, `GATEWAY_FUNDING_GATE_DISABLED_UI=PASS`, `GATEWAY_FUNDING_GATE_ENABLED_UI=PASS`, `GATEWAY_FUNDING_RELOAD_READY=PASS`, `GATEWAY_FUNDING_RELOAD_SUBMITTED=PASS`, `GATEWAY_FUNDING_RELOAD_COMPLETED=PASS`, `GATEWAY_FUNDING_RECONCILIATION_FAIL_CLOSED=PASS`, `GATEWAY_OUTBOUND_DESTINATION_PROOF_MATRIX=PASS`.
  - The production gate was returned to `EXTREMA_ENABLE_GATEWAY_BROADCAST=false` after the live proof. This code task creates no live transaction, does not mutate production state, and does not broadcast.
- Current outbound destination matrix: Arc Testnet, Base Sepolia, OP Sepolia and Arbitrum Sepolia are **FULLY LIVE PROVEN as Gateway destinations**; Ethereum Sepolia remains **OPEN / NOT LIVE PROVEN as a Gateway destination**. General outbound proof remains **OPEN** until Ethereum receives its own controlled normal-UI proof.
- Gateway outbound single-active recovery and explicit discard guard: **IMPLEMENTED / DETERMINISTICALLY VALIDATED**. The completed Arc proof above remains **FULLY LIVE PROVEN**. Two later production `READY_TO_BROADCAST` rows — actions `872d8b0e-451f-428d-80dd-7aec11e63812` / `8a29e35c-5204-4a47-acb7-8bc43df277fe`, requests `5b653f29-de02-45cc-8eae-ce9d3af28564` / `70a4b8b5-44fd-4b70-9050-180df3345a5f`, Arc destination domain `26`, Base source domain `6`, `1 USDC` each — were identified as preparation/test artifacts with null transfer id/hash and no submitted funds; this task did not modify them. The server now guards one unresolved action per human `(user, execution mode, wallet)` identity, returns the existing action for a fresh request, fails closed on historical duplicates, and permits only an explicit pre-submission discard for evidence-free preparation states while preserving the durable plan, challenge, signature and payload evidence. `RECONCILIATION_REQUIRED`, `SUBMITTING`, `SUBMITTED`, and any evidence-bearing row remain recovery-locked and read-only; no blind resubmission is possible. Wallet reload recovery is server-backed, and completed actions are not recovered. Proof: `GATEWAY_FUNDING_SINGLE_ACTIVE_GUARD=PASS`, `GATEWAY_FUNDING_FRESH_REQUEST_RETURNS_EXISTING=PASS`, `GATEWAY_FUNDING_NO_SECOND_SIGNATURE_ACTION=PASS`, `GATEWAY_FUNDING_PRE_SUBMISSION_DISCARD=PASS`, `GATEWAY_FUNDING_DISCARD_PRESERVES_EVIDENCE=PASS`, `GATEWAY_FUNDING_DISCARD_NO_FINANCIAL_SIDE_EFFECT=PASS`, `GATEWAY_FUNDING_SUBMITTED_CANNOT_DISCARD=PASS`, `GATEWAY_FUNDING_SERVER_BACKED_RECOVERY=PASS`, `GATEWAY_FUNDING_DUPLICATE_ACTIVE_FAILS_CLOSED=PASS`, and `GATEWAY_FUNDING_COMPLETED_NOT_RECOVERED=PASS`. At the time of this recovery correction, general outbound proof remained **OPEN** and Base Sepolia, OP Sepolia, Arbitrum Sepolia and Ethereum Sepolia destination proof remained **NOT LIVE PROVEN**. No production row, Circle action, Gateway transfer or broadcast was changed or executed.
- Gateway outbound fee-aware source allocation correction: **IMPLEMENTED / DETERMINISTICALLY VALIDATED**. Current proof is destination-specific: Arc is **FULLY LIVE PROVEN** by the existing completion evidence; Base Sepolia is **FULLY LIVE PROVEN** for action `e00287e5-59cb-4ea7-9811-a7ba3798fc7a`, transaction `0x5bf6ba0cce6015515087e941701845c084c0a7bb81cdf4e8cedea59db861ca32`, with the destination wallet at `18 USDC`; OP Sepolia is **FULLY LIVE PROVEN** for completed action `b189bec0-042b-43cd-8f5c-c7149313ffce`, transaction `0x6b10e2a36b8991fd0b6b65e6ac8b5e3556126683ab27fb276efe96ced87114ce`, with the destination wallet at `20 USDC`; Arbitrum Sepolia remains **OPEN** with current action `dc62db8d-64cc-4469-89a9-e26f707a155b` in `PREPARING`, no source plan, no transfer id/hash, no signature/submit evidence and no funds moved; Ethereum Sepolia outbound remains **OPEN**. The defect was a greedy multi-source split that could saturate the first source and leave a one-raw-unit remainder, while one-source fee reserves were not reallocated and requoted within the same source subset. The correction quotes each exact positive candidate plan, derives per-source capacity as `balance - quoted maxFee`, rejects insolvent subsets, deterministically reallocates the exact requested amount with no zero intents, requotes until stable and solvent, and fails closed on infeasibility, repeated allocation or oscillation within a bounded six-iteration loop. The final quote is bound to the burn intents; selection is minimum source count, then minimum actual quoted total fee, then deterministic allocation/domain order. With the five canonical source domains, the planner has a maximum of `161` estimate calls (`5` one-source probes plus `26` multi-source subsets × `6`). Proof: `GATEWAY_FEE_AWARE_REALLOCATION=PASS`, `GATEWAY_FEE_AWARE_FINAL_QUOTE_SOLVENT=PASS`, `GATEWAY_FEE_AWARE_EXACT_SUM=PASS`, `GATEWAY_FEE_AWARE_NO_ZERO_INTENTS=PASS`, `GATEWAY_FEE_AWARE_REQUOTE=PASS`, `GATEWAY_FEE_AWARE_BOUNDED_CONVERGENCE=PASS`, `GATEWAY_FEE_AWARE_OSCILLATION_FAIL_CLOSED=PASS`, `GATEWAY_FEE_AWARE_MIN_SOURCE_COUNT=PASS`, `GATEWAY_FEE_AWARE_LOWEST_FEE_TIEBREAK=PASS`, `GATEWAY_ARBITRUM_LIVE_BALANCE_REGRESSION=PASS`, and `GATEWAY_INSUFFICIENT_AFTER_FEES_ERROR_SURFACE=PASS`. No production action, database row, live Circle call, Gateway transfer, signature, submit or broadcast was changed or executed.
- Gateway funding database invariant fix: **IMPLEMENTED / DETERMINISTICALLY VALIDATED**. Production evidence for action `dc62db8d-64cc-4469-89a9-e26f707a155b` (Arbitrum Sepolia outbound preparation, `state PREPARING`, `source_plan_json`/`circle_sign_challenge_id`/`signatures_json`/`gateway_transfer_id`/`gateway_transaction_hash` all `null`, `expires_at` already in the past): both an explicit "Discard prepared transfer" click and the automatic TTL sweep tried to move this row to `EXPIRED` and PostgreSQL rejected the write with `code 23514` on `gateway_funding_actions_plan_check` (`state = 'PREPARING' OR source_domain IS NOT NULL OR source_plan_json IS NOT NULL`), because `discard()` and `markExpired()` both retire a planless `PREPARING` row straight to `EXPIRED` without ever writing a source, and the constraint's only planless exception was `PREPARING` itself. Root cause: a PostgreSQL lifecycle constraint mismatch, not an application bug — the action was correctly stuck `PREPARING` forever, with no financial evidence and no submitted transfer. Fix: the constraint now reads `state IN ('PREPARING', 'EXPIRED') OR source_domain IS NOT NULL OR source_plan_json IS NOT NULL`, migrated with the existing idempotent `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair; `READY_TO_BROADCAST`, `SIGNATURE_PENDING`, `SIGN_CHALLENGE_CREATING`, `SUBMITTING`, `SUBMITTED`, `COMPLETED`, `FAILED`, `SIGNATURE_FAILED` and `RECONCILIATION_REQUIRED` still require a resolved source or plan; no service code changed. Proof (`verify-gateway-funding.js`): `GATEWAY_DB_PREPARING_ROW_VALID=PASS`, `GATEWAY_FUNDING_PLANLESS_EXPIRED_ALLOWED=PASS`, `GATEWAY_FUNDING_PLAN_CONSTRAINT_FAIL_CLOSED=PASS` mirror the exact constraint text against representative rows for every state; `GATEWAY_FUNDING_PREPARING_DISCARD_DB_SAFE=PASS` and `GATEWAY_FUNDING_PREPARING_TTL_DB_SAFE=PASS` drive the real `discard()`/`markExpired()` code through a row that fails preparation at `readUnifiedUsdcBalance` exactly as production did, and confirm the resulting row keeps `source_domain`/`source_plan_json` `null` and satisfies the fixed constraint. Verified by reverting the constraint text and confirming the exact expected failure, then restoring it. Arbitrum previous preparation action `dc62db8d-64cc-4469-89a9-e26f707a155b` remains **NOT SUBMITTED**: no plan, challenge, signature or transfer evidence exists, and this fix did not mutate it. After deploy, `current()`/`markExpired()` will retire it to `EXPIRED` automatically on the next read, with no financial mutation, and the Wallet returns to idle Prepare transfer. Arbitrum outbound remains **OPEN** until a fresh live proof using the fee-aware planner; existing Arc, Base Sepolia and OP Sepolia proof status above is unchanged.
- Gateway outbound Ethereum Sepolia fee-drift correction: **IMPLEMENTED / DETERMINISTICALLY VALIDATED**. The supplied authoritative production evidence identifies the latest failed action `d668ff7f-15ad-45f7-a3ee-f7a87d2065d4` for wallet `0x3faa1A48E6c3772d6c2032EafE5C7D84BD6fd876`, destination Ethereum Sepolia domain `0`, and source OP Sepolia domain `2`: the Circle `SIGN_TYPEDDATA` challenge succeeded and a valid signature is durable, but `gateway_transfer_id` and `gateway_transaction_hash` are both `null`, `last_error` is `gateway_transfer_rejected`, and no funds moved. The signed `maxFee` was `1204701` raw (`1.204701 USDC`) while a read-only re-estimate of the same transfer returned `1257798` raw (`1.257798 USDC`), a confirmed `53097` raw (`0.053097 USDC`) fee drift; signed `maxBlockHeight` `49098564` remained `345265` OP blocks above the read-only head `48753299`, so expiry was not the cause. Production evidence reports two failed Ethereum actions, but only this latest action identifier was supplied; no second action ID, transaction, request ID or hash is asserted here. Ethereum remains **OPEN / NOT LIVE PROVEN** as a destination. The correction reads each non-2xx response body exactly once, safely projects only bounded HTTP status/provider code/type/message/reason into an internal diagnostic, classifies fee rejection only when provider text supports it, persists only the bounded error classification, and never exposes raw bodies, signatures, intents, headers or tokens. Before signing, each estimated raw maxFee is buffered as `estimated + max(ceil(estimated × 10%), 100000)`, with a strict buffered ceiling of `10000000` raw (`10 USDC`); the buffered fee is used for every one- and multi-source solvency check, exact allocation, no-zero-intent proof and final signed BurnIntent. The signed typed data is authoritative: no post-sign mutation, automatic re-sign, or automatic submit retry. Proof: `GATEWAY_TRANSFER_REJECTION_BODY_CAPTURED=PASS`, `GATEWAY_TRANSFER_REJECTION_DIAGNOSTICS_BOUNDED=PASS`, `GATEWAY_TRANSFER_REJECTION_NO_SECRET_PERSISTENCE=PASS`, `GATEWAY_MAXFEE_HEADROOM=PASS`, `GATEWAY_MAXFEE_HEADROOM_MINIMUM=PASS`, `GATEWAY_MAXFEE_HEADROOM_PERCENT=PASS`, `GATEWAY_MAXFEE_HEADROOM_BOUNDED=PASS`, `GATEWAY_BUFFERED_SOURCE_SOLVENCY=PASS`, `GATEWAY_BUFFERED_MULTI_SOURCE_SOLVENCY=PASS`, `GATEWAY_BUFFERED_PLAN_EXACT_SUM=PASS`, `GATEWAY_BUFFERED_PLAN_NO_ZERO_INTENTS=PASS`, `GATEWAY_NO_POST_SIGN_FEE_MUTATION=PASS`, `GATEWAY_NO_AUTOMATIC_RESIGN=PASS`, `GATEWAY_NO_AUTOMATIC_SUBMIT_RETRY=PASS`, `GATEWAY_ETHEREUM_FEE_DRIFT_REGRESSION=PASS`, and `GATEWAY_STALE_TERMINAL_NOTICE_CLEARS_ON_FRESH_START=PASS`. No production row, database state, Circle action, signature, Gateway transfer or broadcast was changed or executed.
- Gateway outbound server-derived cost review boundary: **IMPLEMENTED / DETERMINISTICALLY VALIDATED**. The normal flow is now `Review transfer` → server-derived cost review → explicit `Confirm & sign` → Circle hosted challenge or external-wallet signature → separate `Submit transfer` → finality. `estimatedFeeRaw` comes only from durable `estimate_fees_json.total`; `estimatedTotalDebitRaw = value_raw + estimatedFeeRaw`; `maximumAuthorizedFeeRaw` is the exact sum of every persisted burn intent `maxFee`; and `maximumTotalDebitRaw = value_raw + maximumAuthorizedFeeRaw`, all in exact six-decimal integer raw units. The fixture `value=1000000`, estimated fee `1257798`, ceil-10% headroom `125780`, buffered max fee `1383578`, estimated total `2257798`, and maximum total `2383578` is proven. All five configured destinations and both human execution modes are covered; multi-source reviews aggregate every intent. Reload reads the same action/review, partial signing resumes at the durable `signatureIndex`, inputs lock once an action exists, and missing active estimates fail closed. No extra estimate, reprepare, auto-sign or auto-submit occurs; READY remains a distinct submit step. Proof: `GATEWAY_COST_REVIEW_SERVER_DERIVED=PASS`, `GATEWAY_COST_REVIEW_ALL_DESTINATIONS=PASS`, `GATEWAY_COST_REVIEW_CIRCLE_BEFORE_SIGNATURE=PASS`, `GATEWAY_COST_REVIEW_EXTERNAL_BEFORE_SIGNATURE=PASS`, `GATEWAY_COST_REVIEW_ESTIMATED_FEE=PASS`, `GATEWAY_COST_REVIEW_ESTIMATED_TOTAL=PASS`, `GATEWAY_COST_REVIEW_MAX_AUTHORIZED_FEE=PASS`, `GATEWAY_COST_REVIEW_MAX_TOTAL_DEBIT=PASS`, `GATEWAY_COST_REVIEW_MULTI_SOURCE_AGGREGATED=PASS`, `GATEWAY_COST_REVIEW_NO_EXTRA_ESTIMATE=PASS`, `GATEWAY_COST_REVIEW_SAME_DURABLE_ACTION=PASS`, `GATEWAY_COST_REVIEW_NO_REPREPARE_ON_CONFIRM=PASS`, `GATEWAY_COST_REVIEW_RELOAD_PRESERVED=PASS`, `GATEWAY_COST_REVIEW_PARTIAL_SIGNATURE_RESUMES=PASS`, `GATEWAY_COST_REVIEW_READY_SUBMIT_SEPARATE=PASS`, `GATEWAY_COST_REVIEW_NO_AUTOSIGN=PASS`, `GATEWAY_COST_REVIEW_NO_AUTOSUBMIT=PASS`, `GATEWAY_COST_REVIEW_INPUTS_LOCKED=PASS`, `GATEWAY_COST_REVIEW_MISSING_ESTIMATE_FAILS_CLOSED=PASS`, and `GATEWAY_COST_REVIEW_EN_TR_COPY=PASS`. Ethereum Sepolia remains **OPEN / NOT LIVE PROVEN** as a Gateway destination; `EXTREMA_ENABLE_GATEWAY_BROADCAST=false`, `GATEWAY_LIVE_NETWORK_CALLS=0`, and `LIVE_GATEWAY_BROADCAST=NOT_EXECUTED` remain unchanged.
- Gateway cost-review deployment and Circle signing boundary: Gateway cost review is **IMPLEMENTED / DETERMINISTICALLY VALIDATED / PRODUCTION DEPLOYED**; the Circle review-before-sign visual boundary is **LIVE PROVEN**. The review → Circle signing bridge had a **REGRESSION FOUND / FIX IMPLEMENTED / DETERMINISTICALLY VALIDATED**: a durable `SIGNATURE_PENDING` action with one existing challenge was exposed by the status route as `pending=false`, so the browser refused to execute that same challenge. The canonical pending set now includes `SIGN_CHALLENGE_CREATING`, `SIGNATURE_PENDING`, `SUBMITTING`, `SUBMITTED`, and `RECONCILIATION_REQUIRED`; signing requires the exact durable `SIGNATURE_PENDING` state, non-negative `signatureIndex`, existing `challengeId`, and `costReview`. No second action, challenge, estimate, submit or live mutation is introduced, and signing-stage failure uses dedicated human-facing copy. Proof: `GATEWAY_SIGN_PENDING_STATUS_CONSISTENT=PASS`, `GATEWAY_SIGN_CONFIRM_USES_DURABLE_STATE=PASS`, `GATEWAY_SIGN_EXISTING_CHALLENGE_RESUMED=PASS`, `GATEWAY_SIGN_NO_SECOND_ACTION=PASS`, `GATEWAY_SIGN_NO_SECOND_CHALLENGE=PASS`, `GATEWAY_SIGN_NO_REESTIMATE=PASS`, `GATEWAY_SIGN_NO_AUTOSUBMIT=PASS`, `GATEWAY_SIGN_STAGE_ERROR_COPY=PASS`, and `GATEWAY_REVIEW_TO_SIGN_PRODUCTION_REGRESSION=PASS`. Review → Circle signing remains **NOT LIVE PROVEN until after deploy**; Ethereum Sepolia remains **OPEN / NOT LIVE PROVEN**, `EXTREMA_ENABLE_GATEWAY_BROADCAST=false`, `GATEWAY_LIVE_NETWORK_CALLS=0`, and `LIVE_GATEWAY_BROADCAST=NOT_EXECUTED`.

### Remaining open work

Every open item is listed on its own line.

P0 / production proof:

- [ ] Round 8 seed production reconciliation: 72 plans target, or an explicit reason for every missing plan
- [ ] Archive durable PostgreSQL snapshot plus Leaderboard shared cache: deployment and production proof
- [ ] Gateway outbound destination proof: Ethereum Sepolia
- [ ] Wrong network detection and Switch to Arc proof
- [ ] Switch to Base Sepolia proof for an external wallet Gateway deposit
- [ ] Final security acceptance gate
- [ ] Circle post entry lifecycle live proof, if required for final acceptance
- [ ] HYPE Round 7 cancelled ticket refunds, if still unexecuted
- [ ] Marketplace secondary live trade proof, if required

Final submission:

- [ ] Final responsive and browser visual pass
- [ ] Koray Çifci identity and `koraycifci.com`
- [ ] GitHub repository link
- [ ] Official Arc branding
- [ ] Official Circle branding
- [ ] Architecture diagram
- [ ] Hackathon project copy
- [ ] Demo script
- [ ] Demo video
- [ ] Submission form and package
- [ ] README and proof documentation synchronized with the live production state
- [ ] Final deterministic E2E and production smoke; freeze after PASS

Final onchain acceptance:

- [ ] Section 15 ONE SINGLE ROUND end to end proof, all within the same real Arc Testnet round: creation → entries → lock → settlement or cancellation as applicable → winner or refund state → final claim or refund

Normal DAILY / WEEKLY / QUARTERLY lifecycle automation keeps operating on future rounds; those transitions are ordinary protocol operation, not blockers.
