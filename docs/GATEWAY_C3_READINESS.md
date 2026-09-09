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
Address shaped fields are `bytes32` in the signed message (Gateway also serves
Solana) while the REST payload carries the same values as plain 20 byte
addresses. That asymmetry is easy to get wrong and is covered by tests.

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
destination fields, the 20 byte vs bytes32 asymmetry, and that every unsafe
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

`buildArcFundingBurnIntent` accepts a source domain only if that chain's testnet
USDC address is published in Circle's current EVM quickstart, because a burn
intent must name the USDC contract on the source chain and that address differs
per chain:

| Domain | Chain | Testnet USDC |
| --- | --- | --- |
| 0 | Ethereum Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| 1 | Avalanche Fuji | `0x5425890298aed601595a70ab815c96711a31bc65` |
| 6 | Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| 13 | Sonic Testnet | `0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51` |

Any other domain is rejected with `gateway_source_domain_unsupported` rather
than guessed. Solana (domain 5) is excluded on purpose: it is not EVM and does
not use this signing path. Arc itself (domain 26) is rejected as a source, since
burning an Arc balance to mint back onto Arc pays a fee and delivers nothing.

Adding a domain to that table requires its USDC address from official Circle
documentation. Do not infer one.

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
