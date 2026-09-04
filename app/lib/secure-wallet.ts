"use client";

import { Wallet } from "ethers";

const VAULT_KEY = "extrema-secure-wallet-v1";

type SecureWalletVault = {
  version: 1;
  address: string;
  credentialId: string;
  prfSalt: string;
  iv: string;
  ciphertext: string;
};

export type CreatedSecureWallet = {
  address: string;
  privateKey: string;
};

type PrfOutputs = AuthenticationExtensionsClientOutputs & {
  prf?: {
    enabled?: boolean;
    results?: {
      first?: ArrayBuffer;
    };
  };
};

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertWebAuthnAvailable() {
  if (!window.isSecureContext) {
    throw new Error("Passkeys require HTTPS or localhost.");
  }
  if (!("PublicKeyCredential" in window) || !navigator.credentials) {
    throw new Error("This browser does not support WebAuthn passkeys.");
  }
}

async function evaluatePrf(credentialId: Uint8Array, salt: Uint8Array) {
  const extensions = {
    prf: {
      eval: {
        first: salt,
      },
    },
  } as unknown as AuthenticationExtensionsClientInputs;

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: window.location.hostname,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      timeout: 60_000,
      extensions,
    },
  });

  if (!assertion || !(assertion instanceof PublicKeyCredential)) {
    throw new Error("Passkey authentication was cancelled.");
  }

  const extensionResults = assertion.getClientExtensionResults() as PrfOutputs;
  const output = extensionResults.prf?.results?.first;

  if (!output) {
    throw new Error(
      "This passkey/browser does not expose the PRF extension required for secure local key storage. Use an existing wallet on this device.",
    );
  }

  return output;
}

async function deriveAesKey(prfOutput: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", prfOutput);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function readVault(): SecureWalletVault | null {
  try {
    const raw = window.localStorage.getItem(VAULT_KEY);
    return raw ? (JSON.parse(raw) as SecureWalletVault) : null;
  } catch {
    return null;
  }
}

export function hasSecureWallet() {
  if (typeof window === "undefined") return false;
  return Boolean(readVault());
}

export function clearSecureWallet() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(VAULT_KEY);
}

export async function createSecurePasskeyWallet(): Promise<CreatedSecureWallet> {
  assertWebAuthnAvailable();

  if (readVault()) {
    throw new Error("An EXTREMA passkey wallet already exists in this browser. Unlock or reset it first.");
  }

  const userId = randomBytes(32);
  const challenge = randomBytes(32);

  const publicKey = {
    challenge,
    rp: {
      id: window.location.hostname,
      name: "EXTREMA",
    },
    user: {
      id: userId,
      name: "extrema-wallet",
      displayName: "EXTREMA Wallet",
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    timeout: 60_000,
    attestation: "none",
    extensions: {
      prf: {},
    },
  } as unknown as PublicKeyCredentialCreationOptions;

  const credential = await navigator.credentials.create({ publicKey });

  if (!credential || !(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey creation was cancelled.");
  }

  const credentialId = new Uint8Array(credential.rawId);
  const salt = randomBytes(32);
  const prfOutput = await evaluatePrf(credentialId, salt);
  const aesKey = await deriveAesKey(prfOutput);

  const wallet = Wallet.createRandom();
  const iv = randomBytes(12);
  const encodedPrivateKey = new TextEncoder().encode(wallet.privateKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encodedPrivateKey);

  const vault: SecureWalletVault = {
    version: 1,
    address: wallet.address,
    credentialId: toBase64Url(credentialId),
    prfSalt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };

  window.localStorage.setItem(VAULT_KEY, JSON.stringify(vault));

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

export async function unlockSecurePasskeyWallet() {
  assertWebAuthnAvailable();

  const vault = readVault();
  if (!vault) throw new Error("No EXTREMA passkey wallet exists in this browser.");

  const credentialId = fromBase64Url(vault.credentialId);
  const salt = fromBase64Url(vault.prfSalt);
  const prfOutput = await evaluatePrf(credentialId, salt);
  const aesKey = await deriveAesKey(prfOutput);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(vault.iv) },
    aesKey,
    fromBase64Url(vault.ciphertext),
  );

  const privateKey = new TextDecoder().decode(plaintext);
  const wallet = new Wallet(privateKey);

  if (wallet.address.toLowerCase() !== vault.address.toLowerCase()) {
    throw new Error("Stored wallet integrity check failed.");
  }

  return {
    address: wallet.address,
    privateKey,
  };
}

export async function connectInjectedWallet() {
  const ethereum = (window as typeof window & {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }).ethereum;

  if (!ethereum) {
    throw new Error("No injected EVM wallet was found. Install or enable MetaMask, Rabby, or another browser wallet.");
  }

  const response = await ethereum.request({ method: "eth_requestAccounts" });
  const accounts = response as string[];
  const address = accounts?.[0];

  if (!address) throw new Error("Wallet connection was cancelled.");

  return address;
}
