"use client";

import { useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import { shortAddress, useDemoState } from "../demo-state";

const steps = [
  { title: "Create wallet", body: "Create a fresh EXTREMA wallet for Arc Testnet." },
  { title: "Secure with passkey", body: "Simulate the device-native WebAuthn registration step." },
  { title: "Save recovery key", body: "Simulate the one-time recovery-key confirmation step." },
  { title: "Wallet ready", body: "Finish the demo wallet and expose balance/funding actions." },
];

export default function WalletPage() {
  const { wallet, createWallet, connectExistingWallet, fundWallet, lockWallet, unlockWallet, resetDemo } = useDemoState();
  const [step, setStep] = useState(0);
  const current = steps[step];

  function continueCreateFlow() {
    if (step < steps.length - 1) {
      setStep((value) => value + 1);
      return;
    }
    createWallet();
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
              <p><b>Mode:</b> {wallet.mode === "extrema" ? "EXTREMA Wallet" : "Existing wallet"}</p>
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
              <p>Locking keeps the demo state but requires reopening the wallet page to reconnect.</p>
              <button className="wf-action" type="button" onClick={resetDemo}>Reset complete demo state</button>
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
          <p>Your demo wallet state is preserved. Unlocking restores the same address, balance and ticket history.</p>
          <section className="wf-panel wf-section">
            <p className="wf-code">{wallet.address}</p>
            <p>Stored balance: {wallet.balanceUsdc.toFixed(2)} USDC</p>
            <button className="wf-action" type="button" onClick={unlockWallet}>Unlock wallet</button>
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
        <h1>Wallet onboarding</h1>
        <p>This is the functional demo-state flow. Real WebAuthn/key generation will replace these simulated steps later.</p>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <h2>{current.title}</h2>
            <p>{current.body}</p>
            <ol>
              {steps.map((item, index) => (
                <li key={item.title}>
                  <b>{index + 1}. {item.title}</b>
                  {index === step ? " ← current" : ""}
                </li>
              ))}
            </ol>

            <button className="wf-action" type="button" onClick={continueCreateFlow}>
              {step === steps.length - 1 ? "Finish & create wallet" : "Continue"}
            </button>
          </section>

          <section className="wf-panel">
            <h2>Connect existing wallet</h2>
            <p>For the demo, this creates the same deterministic test identity but marks it as an external wallet connection.</p>
            <ul>
              <li>MetaMask</li>
              <li>Rabby</li>
              <li>Coinbase Wallet</li>
              <li>WalletConnect-compatible wallets</li>
            </ul>
            <button className="wf-action" type="button" onClick={connectExistingWallet}>Connect demo wallet</button>
          </section>
        </div>
      </section>
    </main>
  );
}
