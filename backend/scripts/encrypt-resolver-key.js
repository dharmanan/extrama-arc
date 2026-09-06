'use strict';

/**
 * Operator tool. Run LOCALLY or in Codespaces, never in production.
 *
 * Produces the ciphertext envelope for EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED
 * and prints only that plus the verified resolver address.
 *
 * The resolver key is obtained, in order of preference:
 *   1. the existing Foundry keystore account, via Foundry's own prompt
 *   2. the keystore file directly, behind a hidden prompt
 *   3. a hidden prompt for the key itself, for environments such as
 *      Codespaces where no Foundry keystore exists
 *
 * No secret is ever printed, written to disk, passed through argv, or placed
 * in shell history. Both secrets are asked for interactively.
 *
 *   node backend/scripts/encrypt-resolver-key.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

let ethers;
try {
  ({ ethers } = require('ethers'));
} catch {
  console.error(
    'ERROR: ethers is not installed. Install the backend dependencies first ' +
      '(inside backend/), then re-run this helper.',
  );
  process.exit(1);
}

const EXPECTED_RESOLVER = '0x1EDC4594195fFb134315c3258DE974563Ed9762A';
const ACCOUNT = process.env.EXTREMA_RESOLVER_ACCOUNT || 'extrema-resolver';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// Reads a secret without echoing it to the terminal.
function promptHidden(query) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('stdin is not a TTY: run this in an interactive terminal'));
      return;
    }

    const stdout = process.stdout;
    const originalWrite = stdout.write.bind(stdout);
    const rl = readline.createInterface({ input: process.stdin, output: stdout, terminal: true });

    originalWrite(query);
    stdout.write = () => true;

    rl.question('', (value) => {
      stdout.write = originalWrite;
      originalWrite('\n');
      rl.close();
      resolve(value);
    });
  });
}

// Preferred: let Foundry itself unlock the account with its normal prompt. Its
// password prompt goes to the inherited terminal; only stdout is captured, so
// the key never reaches the visible session.
function readKeyViaFoundry(account) {
  for (const args of [
    ['wallet', 'private-key', '--account', account],
    ['wallet', 'decrypt-keystore', account],
  ]) {
    const result = spawnSync('cast', args, {
      stdio: ['inherit', 'pipe', 'inherit'],
      encoding: 'utf8',
    });

    if (result.error || result.status !== 0) continue;

    const match = String(result.stdout || '').match(/0x[0-9a-fA-F]{64}/);
    if (match) return match[0];
  }

  return null;
}

// Fallback: decrypt the keystore file directly. Same V3 format Foundry writes,
// with an equally hidden password prompt.
async function readKeyViaKeystoreFile(file, account) {
  if (!fs.existsSync(file)) return null;

  const json = fs.readFileSync(file, 'utf8');
  const password = await promptHidden(`Foundry keystore password for "${account}": `);

  let wallet;
  try {
    wallet = await ethers.Wallet.fromEncryptedJson(json, password);
  } catch {
    fail('Could not decrypt the Foundry keystore with that password.');
  }

  return wallet.privateKey;
}

// For environments with no Foundry keystore, such as Codespaces. The key is
// typed into a hidden prompt, so it never reaches the screen, argv or history.
// The address check below is what confirms the value was entered correctly.
async function readKeyByHiddenPrompt() {
  const entered = await promptHidden('Resolver private key (hidden, 0x-prefixed): ');
  const key = String(entered).trim();

  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    fail('Expected a 0x-prefixed 32 byte private key.');
  }

  return key;
}

async function main() {
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY || '')) {
    const entered = await promptHidden('Backend ENCRYPTION_KEY (64 hex, hidden): ');
    if (!/^[0-9a-fA-F]{64}$/.test(String(entered).trim())) {
      fail('ENCRYPTION_KEY must be exactly 64 hex characters.');
    }
    process.env.ENCRYPTION_KEY = String(entered).trim();
  }

  // config validates the whole backend schema on import. These placeholders
  // satisfy fields this offline tool never reads; only ENCRYPTION_KEY is real.
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:5432/unused';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

  // Required after ENCRYPTION_KEY is set: cryptoService binds the key on import.
  const { encrypt } = require('../src/services/cryptoService');

  // Only involve Foundry when this machine actually has the account, so a
  // Codespace goes straight to the hidden prompt instead of a stray password
  // request from cast.
  const keystoreFile = path.join(os.homedir(), '.foundry', 'keystores', ACCOUNT);
  let privateKey = null;

  if (fs.existsSync(keystoreFile)) {
    privateKey = readKeyViaFoundry(ACCOUNT);
    if (!privateKey) privateKey = await readKeyViaKeystoreFile(keystoreFile, ACCOUNT);
  }

  if (!privateKey) privateKey = await readKeyByHiddenPrompt();

  let address;
  try {
    address = new ethers.Wallet(privateKey).address;
  } catch {
    fail('Recovered key material is not a valid private key.');
  }

  if (address.toLowerCase() !== EXPECTED_RESOLVER.toLowerCase()) {
    // Address is public; the key is still never shown.
    fail(
      `Resolver address mismatch.\n  expected ${EXPECTED_RESOLVER}\n  got      ${address}\n` +
        'Refusing to emit an envelope for a key that is not the deployed resolver.',
    );
  }

  const envelope = encrypt(privateKey);

  // Drop the references we control. Node strings are immutable, so this is a
  // best effort rather than a guaranteed wipe.
  privateKey = null;
  delete process.env.ENCRYPTION_KEY;

  console.log('');
  console.log(`resolver address verified : ${address}`);
  console.log('');
  console.log('Set this in Railway (value only, keep it secret):');
  console.log('');
  console.log(`EXTREMA_RESOLVER_PRIVATE_KEY_ENCRYPTED=${envelope}`);
  console.log('');
}

main().catch((error) => fail(error.message));
