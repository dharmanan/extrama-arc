import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  injectedWallet,
  braveWallet,
  coinbaseWallet,
} from "@rainbow-me/rainbowkit/wallets";

export const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ARC", symbol: "ARC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
    public: { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
} as const;

const connectors = connectorsForWallets(
  [
    {
      groupName: "Recommended",
      wallets: [injectedWallet, metaMaskWallet, braveWallet, coinbaseWallet],
    },
  ],
  {
    appName: "EXTREMA",
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "extrema-placeholder",
  },
);

export const wagmiConfig = createConfig({
  connectors: [...connectors, injected()],
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
  },
  ssr: true,
});
