import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  phantomWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { http, type Chain } from "viem";

export const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
    },
    public: {
      http: ["https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
} as const satisfies Chain;

// The Gateway source chain for deposits. Only Base Sepolia is enabled today;
// the connected wallet must be switched here (never signed on Arc) for a
// USDC approve/deposit transaction, then switched back to Arc for everything
// else the product already does.
export const baseSepolia = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: {
    name: "Sepolia Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://sepolia.base.org"],
    },
    public: {
      http: ["https://sepolia.base.org"],
    },
  },
  blockExplorers: {
    default: {
      name: "BaseScan",
      url: "https://sepolia.basescan.org",
    },
  },
  testnet: true,
} as const satisfies Chain;

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || "";

const rainbowKitProjectId =
  walletConnectProjectId || "00000000000000000000000000000000";

const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [
        metaMaskWallet,
        rabbyWallet,
        phantomWallet,
        coinbaseWallet,
        ...(walletConnectProjectId ? [walletConnectWallet] : []),
        injectedWallet,
      ],
    },
  ],
  {
    appName: "EXTREMA",
    projectId: rainbowKitProjectId,
  },
);

export const wagmiConfig = createConfig({
  chains: [arcTestnet, baseSepolia],
  connectors,
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
    [baseSepolia.id]: http("https://sepolia.base.org"),
  },
  ssr: true,
});
