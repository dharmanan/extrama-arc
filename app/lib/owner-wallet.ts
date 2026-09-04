"use client";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

function provider(): EthereumProvider {
  const ethereum = (window as typeof window & { ethereum?: EthereumProvider }).ethereum;
  if (!ethereum) {
    throw new Error("No browser wallet found. Install or enable MetaMask, Rabby, or another EVM wallet.");
  }
  return ethereum;
}

export async function connectOwnerWallet() {
  const response = await provider().request({ method: "eth_requestAccounts" });
  const accounts = response as string[];
  const address = accounts?.[0];

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Wallet connection was cancelled.");
  }

  return address;
}

export async function signOwnerMessage(address: string, message: string) {
  const signature = await provider().request({
    method: "personal_sign",
    params: [message, address],
  });

  if (typeof signature !== "string") {
    throw new Error("Wallet signature was cancelled.");
  }

  return signature;
}
