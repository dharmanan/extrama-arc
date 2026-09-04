"use client";

import type { Asset } from "./domain";

const API_URL = "/api/extrema";

export type LiveRoundState = {
  roundId: number;
  contractStatus: "ENTRY_OPEN" | "LOCKED" | "SETTLED" | "CANCELLED";
  canEnter: boolean;
  entryOpenAt: string;
  entryCloseAt: string;
  observationStartAt: string;
  observationEndAt: string;
  entryCount: number;
  totalStakeRaw: string;
  totalStakeUsdc: string;
  escrowRemainingRaw: string;
  escrowRemainingUsdc: string;
  resolvedPriceCents: string;
};

export type LivePool = {
  slug: string;
  poolAddress: string;
  ticketAddress: string;
  asset: Asset;
  direction: "HIGH" | "LOW";
  cadence: "DAILY" | "WEEKLY" | "QUARTERLY";
  source: string;
  sourceSymbol: string;
  round: LiveRoundState;
};

export type LiveRoundsResponse = {
  chain: {
    id: number;
    name: string;
    blockNumber: number;
    timestamp: number;
    timestampIso: string;
    explorerUrl: string;
  };
  factory: {
    address: string;
    poolCount: number;
  };
  pools: LivePool[];
};

export type LiveRoundResponse = {
  chain: LiveRoundsResponse["chain"];
  factory: LiveRoundsResponse["factory"];
  pool: LivePool;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (typeof window !== "undefined") {
    headers.set("x-extrema-browser-origin", window.location.origin);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.message === "string"
          ? body.message
          : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function post<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const backendApi = {
  auth: {
    registerChallenge(ownerAddress: string) {
      return post<{ challengeId: string; message: string; expiresInSeconds: number }>(
        "/auth/register/challenge",
        { ownerAddress },
      );
    },
    startRegister(ownerAddress: string, challengeId: string, signature: string) {
      return post<PublicKeyCredentialCreationOptionsJSON>("/auth/register/start", {
        ownerAddress,
        challengeId,
        signature,
      });
    },
    finishRegister(ownerAddress: string, credential: unknown, deviceName: string) {
      return post<{ ownerAddress: string }>("/auth/register/finish", {
        ownerAddress,
        credential,
        deviceName,
      });
    },
    startLogin(ownerAddress: string) {
      return post<PublicKeyCredentialRequestOptionsJSON>("/auth/login/start", { ownerAddress });
    },
    finishLogin(ownerAddress: string, credential: unknown) {
      return post<{ ownerAddress: string }>("/auth/login/finish", {
        ownerAddress,
        credential,
      });
    },
    logout() {
      return post<{ ok: true }>("/auth/logout", {});
    },
  },
  rounds: {
    list() {
      return request<LiveRoundsResponse>("/rounds");
    },
    get(slug: string) {
      return request<LiveRoundResponse>(`/rounds/${encodeURIComponent(slug)}`);
    },
  },
  wallet: {
    get() {
      return request<{ wallet: { id: string; address: string; createdAt: string } | null }>("/wallet");
    },
    chainState() {
      return request<{
        chain: {
          id: number;
          name: string;
          rpcUrl: string;
          explorerUrl: string;
          blockNumber: number;
        };
        native: {
          symbol: string;
          decimals: number;
          balanceRaw: string;
          balanceFormatted: string;
        };
        usdc: {
          address: string;
          name: string;
          symbol: string;
          decimals: number;
          balanceRaw: string;
          balanceFormatted: string;
          contractCodePresent: boolean;
        };
        wallet: {
          address: string;
          explorerUrl: string;
        };
      }>("/wallet/chain-state");
    },
    create() {
      return post<{
        created: boolean;
        wallet: { id: string; address: string; createdAt: string };
        privateKey: string | null;
        privateKeyDisclosure: "one_time_only" | null;
      }>("/wallet/create", {});
    },
  },
};

export type PublicKeyCredentialCreationOptionsJSON = {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: PublicKeyCredentialType; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
};

export type PublicKeyCredentialRequestOptionsJSON = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: Array<{
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  userVerification?: UserVerificationRequirement;
};
