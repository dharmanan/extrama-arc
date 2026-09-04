import type { Metadata } from "next";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";
import "./wireframe.css";
import { DemoStateProvider } from "./demo-state";
import Web3Provider from "./providers/Web3Provider";

export const metadata: Metadata = {
  title: "EXTREMA — Predict what's next.",
  description: "A fixed-entry crypto forecasting pool built for Arc."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Web3Provider>
          <DemoStateProvider>{children}</DemoStateProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
