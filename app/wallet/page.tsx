"use client";
import { useState } from "react";
import Link from "next/link";
import { Header, Mark } from "../components";
const steps = ["Create wallet", "Secure with passkey", "Save recovery key", "Wallet ready"];
export default function Wallet() { const [step, setStep] = useState(0); const ready = step === 3; return <main className="wallet-page"><Header inverse /><section className="wallet-card"><Mark /><p className="eyebrow">ARC TESTNET</p><h1>{ready ? "Your wallet is ready." : steps[step]}</h1><p>{ready ? "Your mock wallet is ready for predictions on Arc Testnet." : "A quiet, simple place for your prediction tickets. This is prototype-only UX; no keys are created."}</p><div className="stepper">{steps.map((item, index) => <span className={index <= step ? "active" : ""} key={item}>{index + 1}<small>{item}</small></span>)}</div>{ready ? <div className="wallet-ready"><b>0x3aF...92E1</b><span>12.40 USDC</span><Link className="button light" href="/pools">Explore pools →</Link></div> : <button className="button light" onClick={() => setStep(step + 1)}>{step === 0 ? "Create Wallet" : "Continue"} →</button>}<a href="#connect">Connect existing wallet</a></section></main>; }
