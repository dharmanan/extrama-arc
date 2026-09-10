# EXTREMA Security Operations

## Secret rotation

Production secrets must never be committed to Git, written to application logs, or passed as command-line arguments when they contain private key material.

### JWT_SECRET

1. Generate a new strong secret outside the repository.
2. Replace `JWT_SECRET` in the Railway environment.
3. Redeploy the backend.
4. Treat every previously issued JWT as invalid and require users to authenticate again.
5. Verify `/readyz`, wallet login, session expiry, and one non-financial authenticated read.
6. Remove any retained copy of the old secret after verification.

EXTREMA does not require a dual-JWT-key grace period. Rotation intentionally invalidates existing sessions.

### ENCRYPTION_KEY

`ENCRYPTION_KEY` protects encrypted EXTREMA wallet private keys in
`extrema_wallets.private_key_encrypted`. It also protects the resolver envelope
stored in `EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED`.

Do not replace `ENCRYPTION_KEY` by itself. Existing envelopes would become
undecryptable.

A production rotation requires a maintenance window:

1. Stop financial writes and backend signing.
2. Take a verified PostgreSQL backup.
3. Generate a new 32-byte encryption key outside the repository.
4. Using a controlled one-off migration, decrypt every existing
   `extrema_wallets.private_key_encrypted` value with the old key.
5. Verify each decrypted key derives the stored `wallet_address`.
6. Re-encrypt each wallet private key with the new key and update the database
   transactionally.
7. Re-encrypt the existing resolver private key under the new key using
   `backend/scripts/encrypt-resolver-key.js`.
8. Verify the derived resolver address still matches the deployed pool resolver.
9. Update Railway `ENCRYPTION_KEY` and
   `EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED` together, then redeploy.
10. Verify wallet signer integrity, resolver startup verification, `/readyz`,
    and a read-only Arc Testnet state check before financial automation resumes.
11. Retain the pre-rotation database backup until verification is complete,
    then securely remove old secret material.

The normal backend binds `ENCRYPTION_KEY` when `cryptoService` is imported and
does not implement dual-key decryption. Therefore an encryption-key rotation
must not be attempted in place without a separately tested migration tool.

### Resolver private key

Rotating the resolver private key itself is a separate onchain operation from
rotating its encryption envelope. If the resolver key changes:

1. Create the replacement key outside the repository.
2. Update the deployed pool resolver authority through the authorized contract
   path.
3. Verify `pool.resolver()` on Arc Testnet.
4. Encrypt the replacement private key with
   `backend/scripts/encrypt-resolver-key.js`.
5. Set only the encrypted envelope in Railway and redeploy.
6. Verify the backend derives the same address reported by `pool.resolver()`.

### Circle and database credentials

For `CIRCLE_API_KEY` or database credentials, create/rotate the credential at
the provider first, update Railway, redeploy and verify service health, then
revoke the old credential. Never place either credential in `.env.example`,
documentation, screenshots, or committed test fixtures.

## Repeatable repository secret scan

Run:

    node backend/scripts/verify-no-committed-secrets.js

The verifier reports rule names and filenames only. It does not print matched
secret values and skips binary assets.
