import type { Metadata, Viewport } from "next";
import { Inter, Audiowide } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const audiowide = Audiowide({ subsets: ["latin"], weight: "400", variable: "--font-audiowide", display: "swap" });

export const metadata: Metadata = {
  title: "Lotus — Yield-bearing liquidity for Stellar's orderbook",
  description:
    "Deposit USDC, receive a receipt token that earns Blend yield through DeFindex, and quote it on the Stellar DEX. Offers keep earning while they sit in the book.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${audiowide.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">{children}</body>
    </html>
  );
}
