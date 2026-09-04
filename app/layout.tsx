import type { Metadata } from "next";
import "./globals.css";
import "./wireframe.css";
import { DemoStateProvider } from "./demo-state";

export const metadata: Metadata = {
  title: "EXTREMA — Predict what's next.",
  description: "A fixed-entry crypto forecasting pool built for Arc."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><DemoStateProvider>{children}</DemoStateProvider></body></html>;
}
