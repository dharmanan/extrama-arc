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

`verify-gateway-service.js` covers this with real cryptography, not mocks: it
signs a built intent with a generated key, recovers the address, and asserts a
signature over a different intent does not validate. It also asserts the pinned
destination fields, that the submitted intent is strictly the signed message
with every address field bytes32 padded, and that every unsafe
input fails closed.

## What is deliberately NOT implemented

There is no Gateway funding action, no route, no database state and no UI
button. `buildArcFundingBurnIntent` is a foundation module that nothing calls
yet. Three things block the user facing flow, and none of them are code
problems:

1. **No fee source is wired.** `maxFee` must come from
   `POST /v1/estimate?enableForwarder=true`. Its request and response shapes are
   documented, but the values have never been observed live, because that call
   is only meaningful for a wallet that actually holds a unified balance.
2. **Nothing to test against.** No EXTREMA wallet currently holds a Gateway
   balance, so the burn intent wire format cannot be proven end to end without
   an approved real testnet transaction. A wrong signature fails safely (Gateway
   rejects it and no funds move), but "fails safely" is not the same as
   "verified".
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

## To finish C3

Needs a decision from Koray, because both options touch his standing rules:

- **Hand rolled**, continuing the module above: add estimate, submit and poll
  calls, a persisted funding intent for idempotency and recovery, a
  `SIGN_TYPEDDATA` challenge reusing the existing Circle challenge pattern, and
  the contextual wallet action. Uses only `ethers`, which is already installed.
- **Official SDK**, `@circle-fin/unified-balance-kit`: Circle maintains the
  wire format, but it is a new dependency, and adding one needs explicit
  approval first.

Either way the first real transfer is a financial action and requires the same
explicit approval as C4.
