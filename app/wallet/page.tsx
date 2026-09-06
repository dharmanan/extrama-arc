"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProductHeader } from "../product-components";
import { useAccount, useConnect, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { arcTestnet } from "../lib/web3";
import { shortAddress, useWalletSession } from "../wallet-session";
import { backendApi, isAuthSessionError } from "../lib/backend-api";
import { authenticatePasskey, registerPasskey } from "../lib/passkey-client";

type Step = "owner" | "choice" | "create" | "recovery" | "ready";

export default function WalletPage() {
  const {
    address: walletAddress,
    status: walletStatus,
    setWalletReady,
    lockWallet,
  } = useWalletSession();

  const { address: connectedAddress, isConnected, chain } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(walletStatus === "ready" ? "ready" : "owner");
  const [deviceName, setDeviceName] = useState("My Device");
  const [privateKey, setPrivateKey] = useState("");
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [chainState, setChainState] = useState<Awaited<ReturnType<typeof backendApi.wallet.chainState>> | null>(null);
  const [chainBusy, setChainBusy] = useState("");
  const [chainError, setChainError] = useState("");
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [sessionNeedsAuth, setSessionNeedsAuth] = useState(false);
  const [walletNotice, setWalletNotice] = useState("");

  useEffect(() => {
    if (isConnected && connectedAddress) {
      setOwnerAddress(connectedAddress);
      if (step === "owner") setStep("choice");
    } else if (!isConnected) {
      setOwnerAddress(null);
      if (step !== "recovery" && step !== "ready") setStep("owner");
    }
  }, [isConnected, connectedAddress, step]);


  async function handleConnectInjected() {
    setError("");
    setBusy("Connecting wallet...");
    try {
      const connector = connectors[0];
      if (!connector) throw new Error("No injected EVM wallet connector is available.");
      await connectAsync({ connector });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      setBusy("");
    }
  }

  async function copyExtremaAddress() {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopiedAddress(true);
      window.setTimeout(() => setCopiedAddress(false), 1500);
    } catch {
      setChainError("Wallet address could not be copied.");
    }
  }

  async function refreshChainState() {
    setChainError("");
    setChainBusy("Reading Arc Testnet...");
    try {
      const state = await backendApi.wallet.chainState();
      setChainState(state);
      setSessionNeedsAuth(false);
    } catch (cause) {
      setChainState(null);
      if (isAuthSessionError(cause)) {
        setSessionNeedsAuth(true);
        setChainError("");
      } else {
        setChainError("Arc Testnet balance could not be refreshed. Try again.");
      }
    } finally {
      setChainBusy("");
    }
  }

  useEffect(() => {
    if (step === "ready" && walletStatus === "ready" && walletAddress) {
      void refreshChainState();
    }
  }, [step, walletStatus, walletAddress]);

  async function ensureArcTestnet() {
    if (chain?.id === arcTestnet.id) return;
    await switchChainAsync({ chainId: arcTestnet.id });
  }

  async function handleCreate() {
    if (!ownerAddress) return;
    setError("");
    setWalletNotice("");
    setBusy("Waiting for wallet signature...");
    try {
      await registerPasskey(
        ownerAddress,
        deviceName,
        async (message) => {
          setBusy("Waiting for owner wallet signature...");
          await ensureArcTestnet();
          const signature = await signMessageAsync({ message });
          setBusy("Registering passkey...");
          return signature;
        },
      );

      setBusy("Checking EXTREMA wallet...");
      const result = await backendApi.wallet.create();

      if (!result.wallet?.address) {
        throw new Error("Backend did not return an EXTREMA wallet.");
      }

      setWalletReady(result.wallet.address);

      if (result.created && result.privateKey) {
        setPrivateKey(result.privateKey);
        setWalletNotice("");
        setStep("recovery");
      } else {
        setWalletNotice(
          "Existing EXTREMA wallet restored. No new wallet was created. The private key is not re-disclosed.",
        );
        setStep("ready");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EXTREMA wallet creation failed.");
    } finally {
      setBusy("");
    }
  }

  async function handleResumeSession() {
    if (!ownerAddress) {
      setStep("owner");
      return;
    }

    setError("");
    setChainError("");
    setBusy("Authenticating with passkey...");
    try {
      await authenticatePasskey(ownerAddress);
      const result = await backendApi.wallet.get();

      if (!result.wallet?.address) {
        throw new Error("No EXTREMA wallet exists for this owner wallet.");
      }

      setWalletReady(result.wallet.address);
      setSessionNeedsAuth(false);
      await refreshChainState();
    } catch (cause) {
      if (isAuthSessionError(cause)) {
        setSessionNeedsAuth(true);
        setChainError("");
      } else {
        setChainError(cause instanceof Error ? cause.message : "Passkey authentication failed.");
      }
    } finally {
      setBusy("");
    }
  }

  async function handleReconnect() {
    if (!ownerAddress) return;
    setError("");
    setBusy("Authenticating with passkey...");
    try {
      await authenticatePasskey(ownerAddress);
      const result = await backendApi.wallet.get();

      if (!result.wallet?.address) {
        throw new Error("No EXTREMA wallet exists for this owner wallet.");
      }

      setWalletReady(result.wallet.address);
      setSessionNeedsAuth(false);
      setStep("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconnect failed.");
    } finally {
      setBusy("");
    }
  }

  async function handleLock() {
    try {
      await backendApi.auth.logout();
    } catch {
      // Session may already be expired; local lock must still succeed.
    }
    lockWallet();
    disconnect();
    setOwnerAddress(null);
    setPrivateKey("");
    setRecoveryConfirmed(false);
    setWalletNotice("");
    setStep("owner");
  }

  if (step === "recovery" && walletAddress && privateKey) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <p>ONE-TIME DISCLOSURE</p>
          <h1>Save your EXTREMA private key</h1>
          <p>
            This private key is returned only when the backend creates the wallet.
            It will not be shown again by EXTREMA after you continue.
          </p>

          <section className="wf-panel wf-section">
            <p><b>EXTREMA wallet address</b></p>
            <p className="wf-code">{walletAddress}</p>

            <p><b>Private key</b></p>
            <p className="wf-code">{privateKey}</p>

            <p>
              Store it in a password manager or another secure vault.
              Anyone with this key controls the wallet.
            </p>

            <label className="wf-row" style={{ justifyContent: "flex-start" }}>
              <input
                type="checkbox"
                checked={recoveryConfirmed}
                onChange={(event) => setRecoveryConfirmed(event.target.checked)}
              />
              I have saved the private key securely.
            </label>

            <button
              className="wf-action"
              type="button"
              disabled={!recoveryConfirmed}
              onClick={() => {
                setPrivateKey("");
                setRecoveryConfirmed(false);
                setStep("ready");
              }}
            >
              I have saved the key · Continue
            </button>
          </section>
        </section>
      </main>
    );
  }

  if (step === "ready" && walletStatus === "ready" && walletAddress) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <p>ARC TESTNET WALLET</p>
          <h1>EXTREMA wallet ready</h1>
          {walletNotice && <p className="wf-message">{walletNotice}</p>}

          <div className="wf-two-col wf-section">
            <section className="wf-panel">
              {ownerAddress && (
                <p><b>Owner wallet:</b> {shortAddress(ownerAddress)}</p>
              )}
              <p><b>EXTREMA wallet:</b> {shortAddress(walletAddress)}</p>
              <div className="wf-row" style={{ justifyContent: "flex-start", alignItems: "center" }}>
                <p className="wf-code" style={{ margin: 0, flex: 1 }}>{walletAddress}</p>
                <button className="wf-action" type="button" onClick={copyExtremaAddress}>
                  {copiedAddress ? "Copied" : "Copy address"}
                </button>
              </div>

              {sessionNeedsAuth ? (
                <section className="wf-panel wf-section">
                  <h3>Session expired</h3>
                  <p>Authenticate with your passkey to continue.</p>
                  <button
                    className="wf-action"
                    type="button"
                    onClick={handleResumeSession}
                    disabled={Boolean(busy)}
                  >
                    {busy || "Authenticate with passkey"}
                  </button>
                </section>
              ) : chainState ? (
                <>
                  <p><b>Network:</b> {chainState.chain.name} · Chain ID {chainState.chain.id}</p>
                  <p><b>Block:</b> {chainState.chain.blockNumber}</p>
                  <p><b>Native gas balance:</b> {chainState.native.balanceFormatted} {chainState.native.symbol}</p>
                  <p><b>Native decimals:</b> {chainState.native.decimals}</p>
                  <p><b>USDC contract:</b></p>
                  <p className="wf-code">{chainState.usdc.address}</p>
                  <p><b>USDC decimals:</b> {chainState.usdc.decimals}</p>
                  <p><b>Real USDC balance:</b> {chainState.usdc.balanceFormatted} {chainState.usdc.symbol}</p>
                </>
              ) : (
                <p>{chainBusy || "Arc Testnet balance not loaded yet."}</p>
              )}

              {!sessionNeedsAuth && chainError && <p className="wf-message">{chainError}</p>}

              <div className="wf-row">
                <button className="wf-action" type="button" onClick={refreshChainState} disabled={Boolean(chainBusy)}>
                  {chainBusy || "Refresh onchain balance"}
                </button>
                <a
                  className="wf-action"
                  href="https://faucet.circle.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Circle Faucet
                </a>
                {chainState && (
                  <a
                    className="wf-action"
                    href={chainState.wallet.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on ArcScan
                  </a>
                )}
                <Link className="wf-action" href="/pools">Explore pools</Link>
              </div>
            </section>

            <section className="wf-panel">
              <h2>Session</h2>
              <p>
                The EXTREMA wallet private key is encrypted on the backend.
                Returning sessions authenticate with the owner wallet plus passkey.
              </p>
              <button className="wf-action" type="button" onClick={handleLock}>
                Disconnect session
              </button>
            </section>
          </div>
        </section>
      </main>
    );
  }

  if (step === "owner") {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <div className="wf-row" style={{ marginBottom: 24 }}>
            <div>
              <b>Owner wallet</b>
              <div>{isConnected && connectedAddress ? shortAddress(connectedAddress) : "Not connected"}</div>
            </div>
            <div>
              <b>Network</b>
              <div>{chain?.name || "—"}</div>
            </div>
            <button className="wf-action" type="button" onClick={isConnected ? () => disconnect() : handleConnectInjected}>
              {isConnected ? "Disconnect" : "Connect wallet"}
            </button>
          </div>
          <p>STEP 1</p>
          <h1>Connect your owner wallet</h1>
          <p>
            This wallet proves account ownership. It is separate from the EXTREMA wallet
            that will be created for predictions.
          </p>

          <section className="wf-panel wf-section">
            <h2>Owner wallet required</h2>
            <p>MetaMask, Rabby or another injected EVM wallet can be used.</p>
            <button className="wf-action" type="button" onClick={handleConnectInjected} disabled={Boolean(busy)}>
              {busy || "Connect owner wallet"}
            </button>
            {error && <p className="wf-message">{error}</p>}
          </section>
        </section>
      </main>
    );
  }

  if (step === "create" && ownerAddress) {
    return (
      <main className="wf-page">
        <ProductHeader />
        <section className="wf-main">
          <div className="wf-row" style={{ marginBottom: 24 }}>
            <div><b>Owner wallet</b><div>{connectedAddress ? shortAddress(connectedAddress) : "Not connected"}</div></div>
            <div><b>Network</b><div>{chain?.name || "—"}</div></div>
            <div className="wf-row">
              {chain?.id !== arcTestnet.id && (
                <button className="wf-action" type="button" onClick={() => switchChainAsync({ chainId: arcTestnet.id })}>
                  Switch to Arc Testnet
                </button>
              )}
              <button className="wf-action" type="button" onClick={() => disconnect()}>Disconnect</button>
            </div>
          </div>
          <p>STEP 3</p>
          <h1>Set up EXTREMA wallet</h1>
          <p>Owner: {shortAddress(ownerAddress)}</p>

          <section className="wf-panel wf-section">
            <label className="wf-field">
              Device name
              <input
                value={deviceName}
                maxLength={100}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="e.g. My MacBook"
              />
            </label>

            <p>
              Next, your owner wallet will ask you to sign an EXTREMA registration message.
              Only after that succeeds will the browser ask you to register a passkey.
              If this owner already has an EXTREMA wallet, the existing wallet will be restored.
              Otherwise a new wallet will be created and its private key will be shown once.
            </p>

            <div className="wf-row">
              <button className="wf-action" type="button" onClick={handleCreate} disabled={Boolean(busy)}>
                {busy || "Sign, register passkey & continue"}
              </button>
              <button className="wf-action" type="button" onClick={() => setStep("choice")} disabled={Boolean(busy)}>
                Back
              </button>
            </div>

            {error && <p className="wf-message">{error}</p>}
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="wf-page">
      <ProductHeader />
      <section className="wf-main">
        <div className="wf-row" style={{ marginBottom: 24 }}>
          <div><b>Owner wallet</b><div>{connectedAddress ? shortAddress(connectedAddress) : "Not connected"}</div></div>
          <div><b>Network</b><div>{chain?.name || "—"}</div></div>
          <div className="wf-row">
            {chain?.id !== arcTestnet.id && (
              <button className="wf-action" type="button" onClick={() => switchChainAsync({ chainId: arcTestnet.id })}>
                Switch to Arc Testnet
              </button>
            )}
            <button className="wf-action" type="button" onClick={() => disconnect()}>Disconnect</button>
          </div>
        </div>
        <p>STEP 2</p>
        <h1>EXTREMA wallet</h1>
        <p>Owner wallet connected: <b>{ownerAddress ? shortAddress(ownerAddress) : "—"}</b></p>

        <div className="wf-two-col wf-section">
          <section className="wf-panel">
            <h2>Set up EXTREMA wallet</h2>
            <p>
              Register a passkey to continue. If this owner already has an EXTREMA wallet,
              it will be restored. Otherwise a new server-managed EVM wallet will be created
              and its private key will be shown exactly once.
            </p>
            <button className="wf-action" type="button" onClick={() => {
              setError("");
              setStep("create");
            }}>
              Register passkey & continue
            </button>
          </section>

          <section className="wf-panel">
            <h2>Reconnect existing EXTREMA wallet</h2>
            <p>
              Already created one? Authenticate with the registered passkey and restore the session.
            </p>
            <button className="wf-action" type="button" onClick={handleReconnect} disabled={Boolean(busy)}>
              {busy || "Authenticate with passkey"}
            </button>
          </section>
        </div>

        <button className="wf-action" type="button" onClick={() => {
          disconnect();
          setOwnerAddress(null);
          setStep("owner");
        }}>
          Change owner wallet
        </button>

        {error && <p className="wf-message">{error}</p>}
      </section>
    </main>
  );
}
