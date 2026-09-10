# C4 Preflight: Controlled Real Circle Entry Transaction

Runbook for the first real Arc Testnet entry executed from a Circle user
controlled wallet. Every step below is read-only until the final one.

**This runbook must not be executed without Koray's explicit approval.** The
last step spends 1 USDC on Arc Testnet and mints a real ticket NFT.

## What the transaction will do

One entry into one pool: exactly `1,000,000` raw USDC (1 USDC), producing one
transferable ERC721 ticket bound to the chosen prediction price. If the round
ends with fewer than three participants it is cancelled and the current ticket
owner can refund.

## Preconditions to confirm before starting

| # | Check | How to confirm | Required value |
| --- | --- | --- | --- |
| 1 | Execution mode | `GET /api/wallet` | `executionMode` is `CIRCLE_USER_WALLET` |
| 2 | Session wallet | `GET /api/wallet` | `wallet.address` is the Circle Arc EOA, and `wallet.id` is the Circle wallet id |
| 3 | Wallet is an EOA | `POST /api/circle/wallet` | `wallet.accountType` is `EOA` and `wallet.blockchain` is Arc Testnet. The backend only ever selects an Arc EOA and raises `circle_arc_eoa_ambiguous` if more than one matches |
| 4 | Chain | `GET /api/wallet/chain-state` | `chain.id` is `5042002` |
| 5 | USDC contract | `GET /api/wallet/chain-state` | `usdc.address` is `0x3600000000000000000000000000000000000000` and `usdc.contractCodePresent` is true |
| 6 | Balance | `GET /api/wallet/chain-state` | `usdc.balanceRaw` comfortably above `1000000`, since Arc charges gas in USDC from the same balance |
| 7 | Pool | pool page for the chosen asset and cadence | one of the 24 canonical pools |
| 8 | Round state | `GET /api/rounds/:slug` | round status is `ENTRY_OPEN` |
| 9 | Prediction price | pool entry form | a price no existing entrant has used; exact prediction prices are unique |
| 10 | Challenge issued | `POST /actions/entry/start` response | `executionMode` is `CIRCLE_USER_WALLET`, `step` is `APPROVAL_REQUIRED` or `ENTRY_READY`, and a `challengeId` is present |

The Circle branch of `entry/start` deliberately returns only the action id,
payload hash, expiry, execution mode and the challenge. It does not echo the
payload back, so the destination contract and amount are not client visible and
cannot be tampered with. Both are pinned server side: the canonical entry
payload hardcodes `amountRaw: '1000000'` and derives `contract` from the pool,
and `POST /actions/entry/verify` re-checks the mined transaction against them.

Steps 1 to 6 are a single wallet page load: the ready state already shows
network, chain id and USDC balance.

## Allowance

The entry is a two phase Circle flow. The backend decides which phase applies
and the client never chooses:

- If USDC allowance for the pool is insufficient, `POST /actions/entry/start`
  returns `step: "APPROVAL_REQUIRED"` with a Circle challenge for the `approve`
  call on the USDC contract. After that transaction is confirmed on Arc,
  `POST /actions/entry/approval/verify` checks the receipt and issues the second
  challenge.
- If allowance is already sufficient, `start` returns `step: "ENTRY_READY"`
  directly.

Expect two wallet confirmations on a first ever entry, one on later entries.

## Duplicate and recovery protection to confirm

These already exist and should be observed working, not re-implemented:

- The action authorization is one time and expires; a replayed
  `finish`/`verify` for a consumed action is rejected.
- `circleEntryIdempotencyKey` and `circleEntryRefId` are reserved before the
  Circle challenge is created, so a repeated `start` returns the existing
  challenge instead of creating a second transaction.
- Browser side recovery state records the in flight action. A page reload mid
  flow resumes the same action; an attempt to start a *different* intent while
  one is pending fails with `circle_pending_action_for_different_intent`.
- Recovery state holds only non secret identifiers. No Circle user token,
  encryption key, private key or backend JWT is persisted in the browser.

Worth exercising before the real run: start an entry, reload the page mid
challenge, and confirm the flow resumes the same action rather than starting a
second one.

## Backend verification that must pass afterwards

`POST /actions/entry/verify` independently fetches the transaction and receipt
from Arc and confirms the entry against onchain state. The client's claim of
success is never trusted. The returned result must match the intent that was
started: same pool address, same round id, same prediction price.

## Explorer verification

- Wallet: `https://testnet.arcscan.app/address/<circle wallet address>`
- Transaction: `https://testnet.arcscan.app/tx/<txHash>`

Confirm on the explorer: status success, a USDC `Transfer` of exactly
`1000000` raw from the Circle wallet to the pool, and the ticket mint to the
Circle wallet.

## Execution order on the day

1. Confirm every precondition above. Stop at the first mismatch.
2. Record the starting `usdc.balanceRaw` and the current ticket count.
3. Open the pool, enter the prediction price, submit.
4. Approve the Circle challenge or challenges when prompted.
5. Wait for `verify` to return a non pending result.
6. Record the transaction hash and confirm it on ArcScan.
7. Confirm the ticket appears on `/tickets` and the round participant count
   increased by one.

## Rollback

There is none. An entry is final once mined. If the round ends with fewer than
three participants it is cancelled and the ticket owner can refund; otherwise
the stake is committed to the round outcome. Treat step 3 as the point of no
return.

## Gateway is not part of C4

The entry path uses the canonical Arc USDC balance through its ERC-20
interface. Arc's native 18-decimal read is the same underlying USDC and is
used only to confirm fee availability; it is not a second asset balance. Gateway
is a separate, currently unwired capability; see
[`GATEWAY_C3_READINESS.md`](GATEWAY_C3_READINESS.md). Precondition 6 must be
satisfied with real Arc USDC, from the Circle faucet if needed.
