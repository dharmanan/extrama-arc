"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { backendApi } from "./lib/backend-api";

export type WalletSessionStatus = "disconnected" | "ready";

type WalletSession = {
  address: string | null;
  status: WalletSessionStatus;
  setWalletReady: (address: string) => void;
  lockWallet: () => void;
};

// The old demo financial simulator persisted fake balances/tickets/entries
// under this key. It must never influence connection truth and is removed
// on every mount, before hydration, so no remembered local value can leak
// into the real session state below.
const LEGACY_DEMO_STORAGE_KEY = "extrema-demo-state-v4";

const WalletSessionContext = createContext<WalletSession | null>(null);

export function WalletSessionProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<WalletSessionStatus>("disconnected");

  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_DEMO_STORAGE_KEY);
    } catch {
      // Storage may be unavailable (private mode, disabled); nothing to clean up.
    }

    let cancelled = false;

    // The backend session is the only authority for connection state. A
    // real wallet is set to ready only after the backend confirms one
    // exists for the current authenticated session; anything else --
    // no session, expired session, authenticated with no wallet yet --
    // is disconnected. No address is ever fabricated locally.
    backendApi.wallet
      .get()
      .then((result) => {
        if (cancelled) return;
        if (result.wallet?.address) {
          setAddress(result.wallet.address);
          setStatus("ready");
        } else {
          setAddress(null);
          setStatus("disconnected");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setAddress(null);
        setStatus("disconnected");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function setWalletReady(nextAddress: string) {
    setAddress(nextAddress);
    setStatus("ready");
  }

  function lockWallet() {
    setAddress(null);
    setStatus("disconnected");
  }

  const value = useMemo<WalletSession>(
    () => ({ address, status, setWalletReady, lockWallet }),
    [address, status],
  );

  return <WalletSessionContext.Provider value={value}>{children}</WalletSessionContext.Provider>;
}

export function useWalletSession() {
  const value = useContext(WalletSessionContext);
  if (!value) throw new Error("useWalletSession must be used inside WalletSessionProvider");
  return value;
}

export function shortAddress(address: string | null) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
