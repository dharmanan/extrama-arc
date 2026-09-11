"use client";

import { useEffect, useRef, useState } from "react";
import { backendApi } from "./lib/backend-api";
import { storeCircleTabAuth } from "./lib/circle-auth";

type CircleLoginResult = {
  userToken: string;
  encryptionKey: string;
  refreshToken?: string;
};

type CircleSdk = {
  getDeviceId(): Promise<string>;
  updateConfigs(configs: object, onLoginComplete: (error: { message: string } | undefined, result: CircleLoginResult | undefined) => void): void;
  performLogin(provider: unknown): Promise<void>;
  verifyOtp(): void;
  setOnResendOtpEmail(callback: () => void): void;
  setAuthentication(auth: CircleLoginResult): void;
  execute(challengeId: string, onCompleted?: (error: { message: string } | undefined) => void): void;
};

type PendingLogin = {
  deviceToken: string;
  deviceEncryptionKey: string;
  otpToken?: string;
  email?: string;
  deviceId?: string;
  createdAt: number;
};

const PENDING_LOGIN_KEY = "extrema-circle-pending-login-v1";
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

const CIRCLE_SESSION_RETRY_DELAYS_MS = [500, 1000, 1500, 2000] as const;

async function createCircleSessionWhenIndexed(
  userToken: string,
  refresh?: { refreshToken: string; deviceId: string },
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await backendApi.circle.session(userToken, refresh);
    } catch (cause) {
      const retryable =
        cause instanceof Error &&
        cause.message === "circle_arc_eoa_not_found";

      if (!retryable || attempt >= CIRCLE_SESSION_RETRY_DELAYS_MS.length) {
        throw cause;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, CIRCLE_SESSION_RETRY_DELAYS_MS[attempt]),
      );
    }
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
  const [resentOtpReady, setResentOtpReady] = useState(false);
  const [resendSecondsLeft, setResendSecondsLeft] = useState(0);
  const resendAllowedAtRef = useRef(0);

  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
  const googleClientId = process.env.NEXT_PUBLIC_CIRCLE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!resentOtpReady) return;

    const updateCountdown = () => {
      const seconds = Math.max(
        0,
        Math.ceil((resendAllowedAtRef.current - Date.now()) / 1000),
      );
      setResendSecondsLeft(seconds);
    };

    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [resentOtpReady]);

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
    // Circle returns a refresh token only from its hosted login. The browser
    // forwards it once, over the authenticated application route, for
    // encrypted server-side storage; it is never put in tab recovery,
    // localStorage, or a URL.
    const deviceId = await sdk.getDeviceId();
    const session = await createCircleSessionWhenIndexed(
      auth.userToken,
      auth.refreshToken ? { refreshToken: auth.refreshToken, deviceId } : undefined,
    );
    clearCircleTransientState();
    try {
      // Required only to authorize future Circle hosted challenges. It is scoped
      // to this browser tab and is never written to localStorage or a URL.
      storeCircleTabAuth({
        userToken: auth.userToken,
        encryptionKey: auth.encryptionKey,
      });
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
        clearCircleTransientState();
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
          ...(pending.email ? { email: { email: pending.email } } : {}),
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
    if (sdkRef.current) {
      sdkRef.current.updateConfigs(configs, loginCallback);

      if (pending?.email && pending.deviceId) {
        const resendPending = pending;
        sdkRef.current.setOnResendOtpEmail(() => {
          const activeSdk = sdkRef.current;
          if (activeSdk) {
            void resendEmailOtp(resendPending);
          }
        });
      }

      socialProviderRef.current = "Google";
      return sdkRef.current;
    }

    const sdk = new module.W3SSdk(configs, loginCallback) as unknown as CircleSdk;
    sdkRef.current = sdk;

    if (pending?.email && pending.deviceId) {
      const resendPending = pending;
      sdk.setOnResendOtpEmail(() => {
        void resendEmailOtp(resendPending);
      });
    }

    // v1.1.11 exports W3SSdk only; its installed runtime compares the provider
    // to the documented enum value SocialLoginProvider.GOOGLE ("Google").
    socialProviderRef.current = "Google";
    return sdk;
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = readPendingLogin();
      const hasOAuthResponse =
        window.location.hash.includes("id_token=") ||
        window.location.hash.includes("access_token=") ||
        window.location.hash.includes("error=");

      if (pending && !hasOAuthResponse) {
        clearCircleTransientState();
      }

      const sdk = await setupSdk(hasOAuthResponse ? pending : null);
      if (!cancelled && sdk && pending && hasOAuthResponse) {
        setBusy("Completing Circle sign-in...");
      }
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

  async function resendEmailOtp(pending: PendingLogin) {
    if (!pending.email || !pending.deviceId) return;

    const now = Date.now();
    if (now < resendAllowedAtRef.current) {
      const seconds = Math.ceil((resendAllowedAtRef.current - now) / 1000);

      document.getElementById("sdkIframe")?.remove();

      setResentOtpReady(true);
      setResendSecondsLeft(seconds);
      setBusy("");
      return;
    }

    // Prevent repeated clicks while the request is in flight.
    resendAllowedAtRef.current = now + 60_000;

    setError("");
    setBusy("Sending a new verification code...");

    try {
      const device = await backendApi.circle.emailDeviceToken(
        pending.deviceId,
        pending.email,
        crypto.randomUUID(),
      );

      const nextPending: PendingLogin = {
        ...device,
        email: pending.email,
        deviceId: pending.deviceId,
        createdAt: Date.now(),
      };

      storePendingLogin(nextPending);

      const configuredSdk = await setupSdk(nextPending);
      if (!configuredSdk) {
        throw new Error("Circle wallet is not configured.");
      }

      // The fresh Circle login tokens are now configured.
      // Close the current hosted OTP frame instead of immediately reopening it.
      // Reopening it here is what causes browser password-manager UI to appear
      // directly after the user presses Send again.
      document.getElementById("sdkIframe")?.remove();

      setResentOtpReady(true);
      setResendSecondsLeft(60);
      setBusy("");
    } catch (cause) {
      resendAllowedAtRef.current = 0;

      const message = cause instanceof Error ? cause.message : "";

      if (message === "circle_email_otp_cooldown") {
        setError("A verification code was already sent. Please wait 60 seconds before requesting another.");
      } else if (message === "circle_email_otp_send_limit") {
        setError("You've requested several verification codes. Please try again in 60 minutes.");
      } else if (message === "circle_email_otp_attempt_limit") {
        setError("Too many verification attempts were made. Please try again in 60 minutes.");
      } else if (message === "circle_request_rejected") {
        setError("We couldn't send a new verification code. Please try again.");
      } else {
        setError(message || "A new verification code could not be sent. Please try again.");
      }

      setBusy("");
    }
  }

  async function openResentEmailOtp() {
    const pending = readPendingLogin();

    if (!pending?.email || !pending.otpToken) {
      setResentOtpReady(false);
      setError("The verification session expired. Please request a new code.");
      return;
    }

    setError("");
    setBusy("Opening verification...");

    try {
      const configuredSdk = await setupSdk(pending);
      if (!configuredSdk) {
        throw new Error("Circle wallet is not configured.");
      }

      configuredSdk.verifyOtp();
      setBusy("");
    } catch (cause) {
      setBusy("");
      setError(
        cause instanceof Error
          ? cause.message
          : "Verification could not be opened. Please try again.",
      );
    }
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
    const normalizedEmail = email.trim();
    if (!appId || !normalizedEmail) return;
    setError("");
    setResentOtpReady(false);
    setResendSecondsLeft(0);
    setBusy("Sending verification email...");
    try {
      const sdk = await getSdk();
      if (!sdk) throw new Error("Circle wallet is not configured.");
      const deviceId = await sdk.getDeviceId();
      const device = await backendApi.circle.emailDeviceToken(
        deviceId,
        normalizedEmail,
        crypto.randomUUID(),
      );

      const pending: PendingLogin = {
        ...device,
        email: normalizedEmail,
        deviceId,
        createdAt: Date.now(),
      };

      storePendingLogin(pending);

      // The first OTP email also starts the resend cooldown.
      // Circle's hosted Send again link remains visible, but pressing it
      // during this window must not trigger another email.
      resendAllowedAtRef.current = Date.now() + 60_000;

      const configuredSdk = await setupSdk(pending);
      if (!configuredSdk) throw new Error("Circle wallet is not configured.");
      setBusy("Open the verification from Circle...");
      configuredSdk.verifyOtp();
    } catch (cause) {
      clearCircleTransientState();

      const message = cause instanceof Error ? cause.message : "";

      if (message === "circle_email_otp_cooldown") {
        setError("A verification code was already sent. Please wait 60 seconds before requesting another.");
      } else if (message === "circle_email_otp_send_limit") {
        setError("You've requested several verification codes. Please try again in 60 minutes.");
      } else if (message === "circle_email_otp_attempt_limit") {
        setError("Too many verification attempts were made. Please try again in 60 minutes.");
      } else if (message === "circle_request_rejected") {
        setError("We couldn't send a verification code. Please try again.");
      } else {
        setError(message || "Email verification could not start. Please try again.");
      }

      setBusy("");
    }
  }

  if (!appId) {
    return (
      <div className="ex-circle-onboarding">
        <div className="ex-wallet-panel__actions">
          <button className="ex-btn ex-btn--ghost" type="button" disabled>
            Continue with Google
          </button>
        </div>

        <label className="ex-entry__field">
          <span className="ex-entry__label">Email</span>
          <input
            type="email"
            disabled
            placeholder="you@example.com"
          />
        </label>

        <div className="ex-wallet-panel__actions">
          <button className="ex-btn ex-btn--ghost" type="button" disabled>
            Continue with email
          </button>
        </div>

        <p className="ex-wallet-panel__note">
          Circle sign in will become available when configuration is enabled.
        </p>
      </div>
    );
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
        <button
          className="ex-btn ex-btn--ghost"
          type="button"
          onClick={resentOtpReady ? openResentEmailOtp : continueWithEmail}
          disabled={resentOtpReady ? Boolean(busy) : !email.trim() || Boolean(busy)}
        >
          {resentOtpReady ? "Enter new code" : "Continue with email"}
        </button>
      </div>
      <p className="ex-wallet-panel__note">
        {busy ||
          (resentOtpReady
            ? resendSecondsLeft > 0
              ? `A new code was sent. Enter the latest code. You can request another in ${resendSecondsLeft}s.`
              : "A new code was sent. Enter the latest code. You can request another code now."
            : "Circle hosts authentication and approval; EXTREMA never receives your private key.")}
      </p>
      {error && <p className="ex-entry__msg" data-tone="error">{error}</p>}
    </div>
  );
}
