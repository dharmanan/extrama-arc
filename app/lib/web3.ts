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

// The Gateway funding chains. A USDC approve/deposit for one of these must be
// signed on that exact chain, never on Arc, so the connected wallet is
// switched here first and switched back to Arc for everything else the product
// already does.
//
// The Gateway domain each chain maps to is server-side knowledge
// (gatewayNetworks); the browser only ever needs the EVM chain id, which is
// what a wallet switch is expressed in.
function sourceChain(
  id: number,
  name: string,
  rpcUrl: string,
  explorerName: string,
  explorerUrl: string,
) {
  return {
    id,
    name,
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
    blockExplorers: { default: { name: explorerName, url: explorerUrl } },
    testnet: true,
  } as const satisfies Chain;
}

export const baseSepolia = sourceChain(
  84532, "Base Sepolia", "https://sepolia.base.org",
  "BaseScan", "https://sepolia.basescan.org",
);

export const opSepolia = sourceChain(
  11155420, "OP Sepolia", "https://sepolia.optimism.io",
  "Blockscout", "https://optimism-sepolia.blockscout.com",
);

export const arbitrumSepolia = sourceChain(
  421614, "Arbitrum Sepolia", "https://sepolia-rollup.arbitrum.io/rpc",
  "Arbiscan", "https://sepolia.arbiscan.io",
);

export const ethereumSepolia = sourceChain(
  11155111, "Ethereum Sepolia", "https://ethereum-sepolia-rpc.publicnode.com",
  "Etherscan", "https://sepolia.etherscan.io",
);

export const gatewaySourceChains = [
  baseSepolia, opSepolia, arbitrumSepolia, ethereumSepolia,
] as const;

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
  chains: [arcTestnet, baseSepolia, opSepolia, arbitrumSepolia, ethereumSepolia],
  connectors,
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
    [baseSepolia.id]: http(baseSepolia.rpcUrls.default.http[0]),
    [opSepolia.id]: http(opSepolia.rpcUrls.default.http[0]),
    [arbitrumSepolia.id]: http(arbitrumSepolia.rpcUrls.default.http[0]),
    [ethereumSepolia.id]: http(ethereumSepolia.rpcUrls.default.http[0]),
  },
  ssr: true,
});
