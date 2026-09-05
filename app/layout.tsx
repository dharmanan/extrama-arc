import type { Metadata } from "next";
import "./globals.css";
import "./wireframe.css";
import { DemoStateProvider } from "./demo-state";
import Web3Provider from "./providers/Web3Provider";
import { LocaleProvider } from "./i18n";

export const metadata: Metadata = {
  title: "EXTREMA — Predict what's next.",
  description: "A fixed-entry crypto forecasting pool built for Arc."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Web3Provider>
          <LocaleProvider><DemoStateProvider>{children}</DemoStateProvider></LocaleProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
