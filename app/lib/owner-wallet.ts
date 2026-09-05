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

export async function getOwnerChainId() {
  const chainId = await provider().request({ method: "eth_chainId" });
  if (typeof chainId !== "string") {
    throw new Error("Unable to read the connected wallet's network.");
  }

  return chainId;
}

export async function sendOwnerTransaction(tx: {
  to: string;
  data: string;
  value: string;
  from: string;
}) {
  const txHash = await provider().request({
    method: "eth_sendTransaction",
    params: [tx],
  });

  if (typeof txHash !== "string") {
    throw new Error("Wallet transaction was cancelled.");
  }

  return txHash;
}

export async function waitForOwnerTransactionReceipt(
  txHash: string,
  { attempts = 40, intervalMs = 1500 }: { attempts?: number; intervalMs?: number } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await provider().request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    });

    if (receipt && typeof receipt === "object") {
      return receipt as { status?: string; blockNumber?: string };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for the refund transaction to confirm. Check the explorer.");
}
