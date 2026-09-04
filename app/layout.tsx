import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EXTREMA — Predict what's next.",
  description: "A visual prototype for a quieter prediction market."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
