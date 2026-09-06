import type { Metadata } from "next";
import "./globals.css";
import "./wireframe.css";
import { WalletSessionProvider } from "./wallet-session";
import Web3Provider from "./providers/Web3Provider";
import { LocaleProvider } from "./i18n";

export const metadata: Metadata = {
  title: "EXTREMA · Small predictions. Real rewards.",
  description:
    "Predict the next high or low of BTC, ETH, SOL or HYPE. Every entry costs exactly 1 USDC and every result settles onchain on Arc Testnet."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Web3Provider>
          <LocaleProvider><WalletSessionProvider>{children}</WalletSessionProvider></LocaleProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
