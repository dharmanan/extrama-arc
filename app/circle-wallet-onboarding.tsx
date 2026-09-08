"use client";

import { useEffect, useRef, useState } from "react";
import { backendApi } from "./lib/backend-api";

type CircleLoginResult = {
  userToken: string;
  encryptionKey: string;
};

type CircleSdk = {
  getDeviceId(): Promise<string>;
  updateConfigs(configs: object, onLoginComplete: (error: { message: string } | undefined, result: CircleLoginResult | undefined) => void): void;
  performLogin(provider: unknown): Promise<void>;
  verifyOtp(): void;
  setAuthentication(auth: CircleLoginResult): void;
  execute(challengeId: string, onCompleted?: (error: { message: string } | undefined) => void): void;
};

type PendingLogin = {
  deviceToken: string;
  deviceEncryptionKey: string;
  otpToken?: string;
  createdAt: number;
};

const PENDING_LOGIN_KEY = "extrema-circle-pending-login-v1";
const CIRCLE_AUTH_KEY = "extrema-circle-auth-v1";
const PENDING_LOGIN_MAX_AGE_MS = 15 * 60 * 1000;

function readPendingLogin(): PendingLogin | null {
  try {
    const value = window.sessionStorage.getItem(PENDING_LOGIN_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as PendingLogin;
    if (!parsed.deviceToken || !parsed.deviceEncryptionKey || Date.now() - parsed.createdAt > PENDING_LOGIN_MAX_AGE_MS) {
      window.sessionStorage.removeItem(PENDING_LOGIN_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function storePendingLogin(value: PendingLogin) {
  window.sessionStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(value));
}

function clearCircleTransientState() {
  try {
    window.sessionStorage.removeItem(PENDING_LOGIN_KEY);
  } catch {
    // Storage may be unavailable; the hosted Circle flow can still complete in-memory.
  }
}

export function CircleWalletOnboarding({
  onReady,
}: {
  onReady: (session: { walletAddress: string; ownerAddress: string }) => void;
}) {
  const sdkRef = useRef<CircleSdk | null>(null);
  const socialProviderRef = useRef<unknown>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
  const googleClientId = process.env.NEXT_PUBLIC_CIRCLE_GOOGLE_CLIENT_ID;

  async function bindExtremaSession(auth: CircleLoginResult, sdk: CircleSdk) {
    setBusy("Preparing your Arc wallet...");
    const initialized = await backendApi.circle.initializeWallet(auth.userToken, crypto.randomUUID());
    if (initialized.status === "CHALLENGE_REQUIRED") {
      if (!initialized.challengeId) throw new Error("Circle did not return a wallet challenge.");
      sdk.setAuthentication(auth);
      await new Promise<void>((resolve, reject) => {
        sdk.execute(initialized.challengeId as string, (challengeError) => {
          if (challengeError) reject(new Error(challengeError.message));
          else resolve();
        });
      });
    }

    setBusy("Securing your EXTREMA session...");
    // The backend re-lists the Arc EOA using this Circle-authenticated token;
    // no address or Circle wallet ID is accepted from the browser.
    const session = await backendApi.circle.session(auth.userToken);
    clearCircleTransientState();
    try {
      // Required only to authorize future Circle hosted challenges. It is scoped
      // to this browser tab and is never written to localStorage or a URL.
      window.sessionStorage.setItem(CIRCLE_AUTH_KEY, JSON.stringify(auth));
    } catch {
      // A session is still valid; a later Circle transaction will request login again.
    }
    onReady(session);
  }

  async function setupSdk(pending: PendingLogin | null) {
    if (!appId) return null;
    const module = await import("@circle-fin/w3s-pw-web-sdk");
    const loginCallback = async (
      loginError: { message: string } | undefined,
      result: CircleLoginResult | undefined,
    ) => {
      if (loginError || !result?.userToken || !result.encryptionKey) {
        clearCircleTransientState();
        setBusy("");
        setError(loginError?.message || "Circle sign-in did not complete.");
        return;
      }
      try {
        const sdk = sdkRef.current;
        if (!sdk) throw new Error("Circle wallet is not ready.");
        await bindExtremaSession(result, sdk);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Circle wallet setup failed.");
      } finally {
        setBusy("");
      }
    };
    const configs = {
      appSettings: { appId },
      ...(pending ? {
        loginConfigs: {
          deviceToken: pending.deviceToken,
          deviceEncryptionKey: pending.deviceEncryptionKey,
          ...(pending.otpToken ? { otpToken: pending.otpToken } : {}),
          ...(googleClientId ? {
            google: {
              clientId: googleClientId,
              redirectUri: process.env.NEXT_PUBLIC_CIRCLE_GOOGLE_REDIRECT_URI || `${window.location.origin}/wallet`,
              selectAccountPrompt: true,
            },
          } : {}),
        },
      } : {}),
    };
    const sdk = new module.W3SSdk(configs, loginCallback) as unknown as CircleSdk;
    sdkRef.current = sdk;
    // v1.1.11 exports W3SSdk only; its installed runtime compares the provider
    // to the documented enum value SocialLoginProvider.GOOGLE ("Google").
    socialProviderRef.current = "Google";
    return sdk;
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = readPendingLogin();
      const sdk = await setupSdk(pending);
      if (!cancelled && sdk && pending) setBusy("Completing Circle sign-in...");
    })().catch(() => {
      if (!cancelled) setError("Circle wallet could not be initialized.");
    });
    return () => { cancelled = true; };
  // The SDK must be rebuilt only for the one persisted OAuth continuation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function getSdk() {
    return sdkRef.current || setupSdk(null);
  }

  async function continueWithGoogle() {
    if (!appId || !googleClientId) return;
    setError("");
    setBusy("Opening Google sign-in...");
    try {
      const sdk = await getSdk();
      if (!sdk) throw new Error("Circle wallet is not configured.");
      const deviceId = await sdk.getDeviceId();
      const device = await backendApi.circle.socialDeviceToken(deviceId, crypto.randomUUID());
      storePendingLogin({ ...device, createdAt: Date.now() });
      const configuredSdk = await setupSdk(readPendingLogin());
      if (!configuredSdk) throw new Error("Circle wallet is not configured.");
      await configuredSdk.performLogin(socialProviderRef.current);
    } catch (cause) {
      clearCircleTransientState();
      setError(cause instanceof Error ? cause.message : "Google sign-in could not start.");
      setBusy("");
    }
  }

  async function continueWithEmail() {
    if (!appId || !email.trim()) return;
    setError("");
    setBusy("Sending verification email...");
    try {
      const sdk = await getSdk();
      if (!sdk) throw new Error("Circle wallet is not configured.");
      const deviceId = await sdk.getDeviceId();
      const device = await backendApi.circle.emailDeviceToken(deviceId, email.trim(), crypto.randomUUID());
      storePendingLogin({ ...device, createdAt: Date.now() });
      const configuredSdk = await setupSdk(readPendingLogin());
      if (!configuredSdk) throw new Error("Circle wallet is not configured.");
      setBusy("Open the verification from Circle...");
      configuredSdk.verifyOtp();
    } catch (cause) {
      clearCircleTransientState();
      setError(cause instanceof Error ? cause.message : "Email verification could not start.");
      setBusy("");
    }
  }

  if (!appId) {
    return <p className="ex-wallet-panel__note">Circle wallet onboarding is not configured yet.</p>;
  }

  return (
    <div className="ex-circle-onboarding">
      <div className="ex-wallet-panel__actions">
        <button className="ex-btn ex-btn--ghost" type="button" onClick={continueWithGoogle} disabled={!googleClientId || Boolean(busy)}>
          Continue with Google
        </button>
      </div>
      <label className="ex-entry__field">
        <span className="ex-entry__label">Email</span>
        <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
      </label>
      <div className="ex-wallet-panel__actions">
        <button className="ex-btn ex-btn--ghost" type="button" onClick={continueWithEmail} disabled={!email.trim() || Boolean(busy)}>
          Continue with email
        </button>
      </div>
      <p className="ex-wallet-panel__note">{busy || "Circle hosts authentication and approval; EXTREMA never receives your private key."}</p>
      {error && <p className="ex-entry__msg" data-tone="error">{error}</p>}
    </div>
  );
}
