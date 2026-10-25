import type { Metadata, Viewport } from "next";
import { Audiowide } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { SiteChrome } from "@/components/SiteChrome";
import { loadConfig } from "@/lib/config";

// Inter, self-hosted (inter-ui 4.1.1, latin subset of the variable font, SIL OFL) so the OpenType feature
// cv05 is available: lowercase "l" gets a tail, which keeps the token name "lUSDC" from reading as "IUSDC".
const inter = localFont({ src: "./fonts/InterVariable.woff2", variable: "--font-inter", weight: "100 900", display: "swap" });
const audiowide = Audiowide({ subsets: ["latin"], weight: "400", variable: "--font-audiowide", display: "swap" });

export const metadata: Metadata = {
  title: "Lotus: Yield-bearing liquidity for Stellar's orderbook",
  description:
    "Deposit USDC, receive a yield-bearing receipt token, and quote it on the Stellar DEX. The receipt is backed by a DeFindex vault that lends on Blend, and offers keep earning while they sit in the book.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
};

// The deployment config is read from ../deployments at request time (see lib/config.ts), so a
// fresh deploy shows up without a rebuild.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const config = loadConfig();
  return (
    <html lang="en" className={`${inter.variable} ${audiowide.variable} h-full antialiased dark`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <Providers config={config}>
          <SiteChrome>{children}</SiteChrome>
        </Providers>
      </body>
    </html>
  );
}
