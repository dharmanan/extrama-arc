# Security Policy

EXTREMA is a testnet-only reference implementation. The maintained deployment described in this repository runs on Arc Testnet and does not operate a real-money mainnet service.

## Reporting a security issue

Do not open a public issue containing private keys, API keys, database credentials, session tokens, wallet recovery material, or other secrets.

If GitHub private vulnerability reporting is available for this repository, use that channel. Otherwise, contact the repository owner through GitHub first and share sensitive technical details only through a private channel.

If a live credential may already be exposed, rotate or revoke it at the provider before discussing the incident.

## Operational guidance

Secret rotation, encrypted resolver material, database credentials, and the repository secret scanner are documented in:

- [docs/SECURITY_OPERATIONS.md](./docs/SECURITY_OPERATIONS.md)

Run the committed-secret scanner before publishing changes:

```bash
node backend/scripts/verify-no-committed-secrets.js
```

The normal CI workflow also runs this scanner.

## Scope

Security reports are most useful when they include:

- the affected file, contract, route, or execution path
- the Arc Testnet transaction or block number when relevant
- exact reproduction steps that do not require disclosing secret material
- expected behavior and observed behavior

Do not intentionally move real-value assets or test destructive behavior against infrastructure you do not own.
