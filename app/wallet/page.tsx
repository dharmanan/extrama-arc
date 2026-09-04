"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import { shortAddress, useDemoState } from "../demo-state";
import {
  clearSecureWallet,
  connectInjectedWallet,
  createSecurePasskeyWallet,
  hasSecureWallet,
  unlockSecurePasskeyWallet,
} from "../lib/secure-wallet";

export default function WalletPage() {
  const {
    wallet,
    createWallet,
    connectExistingWallet,
    fundWallet,
    lockWallet,
    unlockWallet,
    resetDemo,
  } = useDemoState();

  const [vaultExists, setVaultExists] = useState(false);
  const [creating, setCreating] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [created, setCreated] = useState<{ address: string; privateKey: string } | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setVaultExists(hasSecureWallet());
  }, []);

  async function handleCreateWallet() {
    setError("");
    setCreating(true);
    try {
      const result = await createSecurePasskeyWallet();
      setCreated(result);
      setVaultExists(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet creation failed.");
    } finally {
      setCreating(false);
    }
  }

  function finishCreateWallet() {
    if (!created || !recoveryConfirmed) return;
    const address = created.address;
    setCreated(null);
    setRecoveryConfirmed(false);
    createWallet(address);
  }

  async function handleUnlock() {
    setError("");
    setUnlocking(true);
    try {
      if (wallet.mode === "extrema") {
        const result = await unlockSecurePasskeyWallet();
        if (wallet.address && result.address.toLowerCase() !== wallet.address.toLowerCase()) {
          throw new Error("The passkey unlocked a different wallet.");
        }
      } else {
        const address = await connectInjectedWallet();
        if (wallet.address && address.toLowerCase() !== wallet.address.toLowerCase()) {
          throw new Error("Connect the same wallet that was used previously.");
        }
      }
      unlockWallet();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet unlock failed.");
    } finally {
      setUnlocking(false);
    }
  }

  async function handleConnectExisting() {
    setError("");
    setConnecting(true);
    try {
      const address = await connectInjectedWallet();
      connectExistingWallet(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setConnecting(false);
    }
  }

  function handleReset() {
    clearSecureWallet();
    resetDemo();
    setCreated(null);
    setRecoveryConfirmed(false);
    setVaultExists(false);
    setError("");
  }

  if (wallet.status === "ready" && wallet.address) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <p>ARC TESTNET WALLET</p>
          <h1>Wallet ready</h1>

          <div className="wf-two-col wf-section">
            <section className="wf-panel">
              <p><b>Mode:</b> {wallet.mode === "extrema" ? "EXTREMA Passkey Wallet" : "Existing EVM Wallet"}</p>
              <p><b>Address:</b> {shortAddress(wallet.address)}</p>
              <p className="wf-code">{wallet.address}</p>
              <p><b>Balance:</b> {wallet.balanceUsdc.toFixed(2)} USDC</p>

              <div className="wf-row">
                <button className="wf-action" type="button" onClick={() => fundWallet(10)}>Get 10 test USDC</button>
                <Link className="wf-action" href="/pools">Explore pools</Link>
              </div>
            </section>

            <section className="wf-panel">
              <h2>Wallet controls</h2>
              <button className="wf-action" type="button" onClick={lockWallet}>Lock wallet</button>
              <p>
                {wallet.mode === "extrema"
                  ? "Unlocking this wallet requires the same passkey again."
                  : "Unlocking requires reconnecting the same browser wallet."}
              </p>
              <button className="wf-action" type="button" onClick={handleReset}>Reset complete demo state</button>
            </section>
          </div>
        </section>
      </main>
    );
  }

  if (wallet.address) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <p>ARC TESTNET WALLET</p>
          <h1>Wallet locked</h1>
          <p>Your address, balance and tickets are preserved.</p>

          <section className="wf-panel wf-section">
            <p className="wf-code">{wallet.address}</p>
            <p>Stored balance: {wallet.balanceUsdc.toFixed(2)} USDC</p>
            <button className="wf-action" type="button" onClick={handleUnlock} disabled={unlocking}>
              {unlocking
                ? "Unlocking..."
                : wallet.mode === "extrema"
                  ? "Unlock with passkey"
                  : "Reconnect wallet"}
            </button>
            {error && <p className="wf-message">{error}</p>}
          </section>
        </section>
      </main>
    );
  }

  if (created) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <p>RECOVERY KEY · SHOWN ONCE</p>
          <h1>Save your private key now</h1>
          <p>
            This private key controls the wallet. EXTREMA will not show it again after you continue.
            Do not share it with anyone.
          </p>

          <section className="wf-panel wf-section">
            <p><b>Wallet address</b></p>
            <p className="wf-code">{created.address}</p>

            <p><b>Private key</b></p>
            <p className="wf-code">{created.privateKey}</p>

            <label className="wf-row" style={{justifyContent:"flex-start"}}>
              <input
                type="checkbox"
                checked={recoveryConfirmed}
                onChange={(event) => setRecoveryConfirmed(event.target.checked)}
              />
              I saved this private key somewhere safe.
            </label>

            <button
              className="wf-action"
              type="button"
              disabled={!recoveryConfirmed}
              onClick={finishCreateWallet}
            >
              I saved it · Continue
            </button>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>ARC TESTNET WALLET</p>
        <h1>Create or connect a wallet</h1>
        <p>
          EXTREMA Wallet creates a real EVM key locally. The private key is encrypted in this browser
          with a passkey-backed WebAuthn PRF key. The unencrypted private key is shown only once during creation.
        </p>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <h2>Create EXTREMA Wallet</h2>
            <p>
              Your browser will request a passkey using Touch ID, Face ID, Windows Hello or your device PIN.
              No wallet is created if passkey authentication is cancelled.
            </p>

            {vaultExists ? (
              <>
                <p><b>An EXTREMA passkey vault already exists in this browser.</b></p>
                <button className="wf-action" type="button" onClick={handleUnlock} disabled={unlocking}>
                  {unlocking ? "Unlocking..." : "Unlock existing passkey wallet"}
                </button>
              </>
            ) : (
              <button className="wf-action" type="button" onClick={handleCreateWallet} disabled={creating}>
                {creating ? "Waiting for passkey..." : "Create Wallet with Passkey"}
              </button>
            )}
          </section>

          <section className="wf-panel">
            <h2>Connect existing wallet</h2>
            <p>Use an injected EVM wallet already installed in this browser.</p>
            <ul>
              <li>MetaMask</li>
              <li>Rabby</li>
              <li>Coinbase Wallet</li>
              <li>Other EIP-1193 browser wallets</li>
            </ul>
            <button className="wf-action" type="button" onClick={handleConnectExisting} disabled={connecting}>
              {connecting ? "Connecting..." : "Connect existing wallet"}
            </button>
          </section>
        </div>

        {error && <p className="wf-message">{error}</p>}
      </section>
    </main>
  );
}
