"use client";

import { useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";

const steps = [
  { title: "Create wallet", body: "Create a fresh EXTREMA wallet for Arc Testnet." },
  { title: "Secure with passkey", body: "Register a passkey with the device-native WebAuthn flow." },
  { title: "Save recovery key", body: "Reveal recovery information once and require explicit confirmation that it was saved." },
  { title: "Wallet ready", body: "Show Arc Testnet, wallet address, USDC balance, funding action and ticket access." },
];

export default function WalletPage() {
  const [step, setStep] = useState(0);
  const current = steps[step];

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <p>ARC TESTNET WALLET</p>
        <h1>Wallet onboarding</h1>
        <p>Wireframe only. No key generation, passkey registration or real wallet persistence is implemented yet.</p>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <h2>{current.title}</h2>
            <p>{current.body}</p>
            <ol>
              {steps.map((item, index) => (
                <li key={item.title}><b>{index + 1}. {item.title}</b>{index === step ? " ← current" : ""}</li>
              ))}
            </ol>

            {step < steps.length - 1 ? (
              <button className="wf-action" type="button" onClick={() => setStep((value) => value + 1)}>
                Continue
              </button>
            ) : (
              <div className="wf-card">
                <strong>0x3aF...92E1</strong>
                <span>Arc Testnet</span>
                <span>12.40 USDC</span>
                <Link className="wf-action" href="/pools">Explore pools</Link>
              </div>
            )}
          </section>

          <section className="wf-panel">
            <h2>Existing wallet</h2>
            <p>Advanced users will also be able to connect an existing EVM wallet.</p>
            <ul>
              <li>MetaMask</li>
              <li>Rabby</li>
              <li>Coinbase Wallet</li>
              <li>WalletConnect-compatible wallets</li>
            </ul>
            <button className="wf-action" type="button">Connect existing wallet</button>
          </section>
        </div>
      </section>
    </main>
  );
}
