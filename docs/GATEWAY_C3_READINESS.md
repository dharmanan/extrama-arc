# Circle Gateway (C3) Readiness

Status snapshot for the Gateway work. Descriptive, not a checklist substitute
for [`EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md`](../EXTREMA_ONCHAIN_EXECUTION_CHECKLIST.md).

All findings below were taken from current official Circle documentation and
from a live read-only call to the Gateway testnet API on 2026-09-09. Nothing
here was implemented from memory.

## Is Arc Testnet supported?

Yes. `GET https://gateway-api-testnet.circle.com/v1/info` returns Arc as a
first class domain:

```
chain "ARC", network "Testnet", domain 26
walletContract 0x0077777d7EBA4688BDeF3E311b846F25870A19B9  supportedTokens ["USDC"]
minterContract 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B  supportedTokens ["USDC"]
```

Arc carries both a wallet contract and a minter contract, so it is usable as a
Gateway transfer destination, not only as a source. Gateway identifies chains
by CCTP domain, never by chain id: Arc is domain 26, not 5042002. Circle's
supported blockchains reference lists Arc as testnet only, with roughly one
block confirmation and sub second attestation.

## How USDC becomes usable on Arc

1. The user deposits USDC into the GatewayWallet contract on some source chain
   (`approve` on USDC, then `deposit(token, amount)` on GatewayWallet). A plain
   ERC-20 transfer to the contract is not credited.
2. After that chain's confirmation threshold, the amount joins the unified
   balance, readable through `POST /v1/balances`.
3. To move it to Arc, the wallet signs an EIP-712 **burn intent** and submits it
   to `POST /v1/transfer?enableForwarder=true`. Circle's forwarding service then
   submits `gatewayMint` on Arc itself.

The forwarder matters for EXTREMA: on the direct-mint path the recipient must
hold native gas on the destination chain to call `gatewayMint`. A user whose Arc
balance is too low to enter a pool is exactly the user who cannot pay that gas,
so the direct path is self defeating here. With `enableForwarder=true` there is
no destination gas requirement and Circle submits the mint.

## Signing

The burn intent is EIP-712. Its domain carries only `{ name: "GatewayWallet",
version: "1" }` with no `chainId` and no `verifyingContract`, which is what lets
a single Arc EOA signature spend a balance that sits on any source domain.

Address shaped fields are `bytes32` throughout, because Gateway also serves
Solana. There is no 20 byte variant anywhere in this flow: Circle's quickstart
submits the signed EIP-712 message itself as the `burnIntent` in the
`POST /v1/transfer` body, so the signed shape and the submitted shape are the
same object. `buildArcFundingBurnIntent` returns one frozen intent used for
both, and the tests assert they are strictly identical rather than merely
similar.

**Gateway does not accept EIP-1271 signatures.** A Circle SCA can deposit into
Gateway but cannot sign a burn intent to spend out. This is the concrete reason
the roadmap's "keep the Circle wallet an EOA" rule is load bearing: switching
EXTREMA's Circle wallets to SCA would silently remove the ability to use
Gateway at all.

Both installed SDKs already support the required signing:

- `@circle-fin/user-controlled-wallets@10.8.0` exposes `signUserTypedData`,
  which returns a `challengeId`.
- `@circle-fin/w3s-pw-web-sdk@1.1.11` exposes `ChallengeType.SIGN_TYPEDDATA`
  and returns `{ signature }`.

No new dependency is required to sign a burn intent.

## What is implemented

- `gatewayService.readUnifiedUsdcBalance()` — unified balance read, normalised
  to canonical 6 decimal raw units.
- `GET /api/wallet/gateway-balance` — authenticated, `CIRCLE_USER_WALLET` only,
  depositor derived from the session. It never reads a wallet address from
  `req.body` or `req.query`.
- Wallet page shows the Gateway figure as a third compact column, for Circle
  sessions only, and only when the unified balance is above zero. The read is
  separate from the Arc chain state read, so a Gateway outage cannot surface as
  a wallet error, an Arc balance failure or a broken session; it just hides the
  figure.
- `gatewayService.buildArcFundingBurnIntent()` — builds the burn intent and its
  EIP-712 typed data. Every destination field is pinned by the server rather
  than accepted from the caller: destination domain is always Arc, destination
  token is always canonical Arc USDC, and depositor, signer and recipient are
  always the session wallet. A browser cannot redirect a signed intent to
  another chain, token or recipient.
- `gatewayService.recoverBurnIntentSigner()` — recovers the signer locally so a
  malformed or swapped signature is never submitted to Circle.
- `gatewayFundingService` and `/api/wallet/gateway-funding/*` — a durable,
  Circle-EOA-only preparation state machine. It derives the wallet from the
  authenticated session, spends against exactly one transferable source domain
  (never an aggregated cross-domain value), obtains `maxFee` and
  `maxBlockHeight` from `POST /v1/estimate?enableForwarder=true`, then creates
  a `SIGN_TYPEDDATA` challenge for that exact, pinned burn intent.
- The signed result is verified locally against the session wallet and retained
  as `READY_TO_BROADCAST`. The wallet UI has a source-domain selector, canonical
  six-decimal amount input, clear status/error display, and an in-tab recovery
  record that resumes the same action/challenge after refresh.
- The durable state machine implements the complete forwarding path after
  `READY_TO_BROADCAST`: `SUBMITTING`, `SUBMITTED`, `COMPLETED`, `FAILED`, and
  `RECONCILIATION_REQUIRED`. It submits the exact `{ burnIntent, signature }`
  body to Circle's forwarding endpoint once, under the server's durable
  request identity, and
  reads `GET /v1/transfer/{transferId}` for recovery and polling.
- `EXTREMA_ENABLE_GATEWAY_BROADCAST` is a server-side gate and defaults to
  `false`. The wallet UI does not expose a broadcast control, and refreshes or
  repeated frontend requests cannot bypass the persisted compare-and-set
  reservation. The code path is therefore implemented and mock-tested without
  executing a live transfer in this task.

`verify-gateway-service.js` covers this with real cryptography, not mocks: it
signs a built intent with a generated key, recovers the address, and asserts a
signature over a different intent does not validate. It also asserts the pinned
destination fields, that the submitted intent is strictly the signed message
with every address field bytes32 padded, and that every unsafe
input fails closed.

`verify-gateway-funding.js` runs the real durable preparation service against
in-memory DB/Circle/forwarding adapters. It proves same-request replay returns
the same action and challenge, the selected source balance is checked before
estimate (without aggregating domains), the Circle completion first reports
pending, the resulting signature must recover the session wallet, a successful
mocked submission is one-shot and reaches `COMPLETED`, and an ambiguous submit
stays `RECONCILIATION_REQUIRED` without retrying.

## Live broadcast remains disabled by default

The forwarding-service submission and reconciliation path is implemented, but
the production gate remains closed unless a server deployment explicitly opts
in. This is a deliberate financial control, not an omitted code path: the first
`POST /v1/transfer?enableForwarder=true` can cause a real burn and therefore
requires separate approval plus an approved testnet proof.

1. **No real Gateway funding broadcast has been authorized.** The estimate and
   signature flow are deterministic and locally verified, but no Gateway
   transfer ID, burn transaction, forwarded mint, or Arc balance increase is
   claimed.
2. **No live transfer proof is claimed.** No EXTREMA wallet currently holds a
   Gateway balance, so the signed payload and Gateway response are proven here
   only through deterministic local fakes, not an approved real testnet
   transaction.
3. **The precondition is external to EXTREMA.** A unified balance only exists if
   the user has already deposited USDC into GatewayWallet on another supported
   chain, which needs USDC *and* native gas on that chain. A freshly onboarded
   Circle user has neither. For those users the Arc faucet already linked on the
   wallet page is the real funding path, not Gateway.

Point 3 is the important product finding: today Gateway funding helps only a
user who separately parked USDC in Gateway elsewhere. That is why the wallet
page surfaces the balance when it exists and stays silent when it does not,
rather than advertising a funding capability that would almost always be empty.

## Supported source domains

A burn intent must name the USDC contract on the source chain, and that address
differs per chain. Every EVM testnet domain Gateway currently supports is
covered, with addresses taken from Circle's published USDC contract addresses
page as the single source of truth:

| Domain | Chain | Testnet USDC |
| --- | --- | --- |
| 0 | Ethereum Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| 1 | Avalanche Fuji | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| 2 | OP Sepolia | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` |
| 3 | Arbitrum Sepolia | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| 6 | Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| 7 | Polygon PoS Amoy | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` |
| 10 | Unichain Sepolia | `0x31d0220469e10c4E71834a79b1f276d740d3768F` |
| 13 | Sonic Testnet | `0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51` |
| 14 | World Chain Sepolia | `0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88` |
| 16 | Sei Testnet | `0x4fCF1784B31630811181f670Aea7A7bEF803eaED` |
| 19 | HyperEVM Testnet | `0x2B3370eE501B4a559b57D449569354196457D8Ab` |

Two networks in that list are easy to confuse. Gateway's domain 13 is **Sonic
Testnet**, which both the supported blockchains page and live `/v1/info` report
as `chain "Sonic", network "Testnet"`. Circle's USDC page separately lists a
**Sonic Blaze Testnet** at `0xA4879Fed32Ecbef99399e5cbC247E533421C4eC6`, which is
a different network and must not be used for domain 13.

The test suite checksum validates every address in the table, but a checksum
only proves syntax and transcription integrity. It cannot prove an address
belongs to the right network: a correctly checksummed address for the wrong
chain passes silently. Network identity has to be matched against the chain and
network names Gateway itself reports for that domain, which is why domain 13 is
additionally pinned by an explicit test.

Two Gateway domains are excluded on purpose. Solana (domain 5) is not EVM and
does not use this EIP-712 signing path. Arc itself (domain 26) is rejected as a
source, since burning an Arc balance to mint back onto Arc pays a fee and
delivers nothing. Any other domain is rejected with
`gateway_source_domain_unsupported` rather than guessed, and adding one requires
its USDC address from official Circle documentation. Do not infer one.

Because `readUnifiedUsdcBalance` reports balances on every domain Gateway knows
about, including the two excluded ones, each balance carries a `transferable`
flag and the response carries `transferableTotalRaw` alongside `totalRaw`. A
future execution path must spend against the transferable total, never the raw
unified total.

## Broadcast authorization gate

When a separately approved server deployment enables
`EXTREMA_ENABLE_GATEWAY_BROADCAST=true`, the service submits the persisted
`{ burnIntent, signature }` once to `POST /v1/transfer?enableForwarder=true`,
stores the returned `transferId`, and reconciles
`GET /v1/transfer/{id}` to a terminal forwarding outcome. `SUBMITTING` is
durable before the mutation; an ambiguous timeout becomes
`RECONCILIATION_REQUIRED` and never triggers an automatic second submission.
The current task leaves this gate disabled and makes no live transfer claim.
