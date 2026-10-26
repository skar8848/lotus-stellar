"use client";

import { usePathname } from "next/navigation";
import { Nav } from "@/components/Nav";
import { FaucetHint } from "@/components/faucet/FaucetHint";

// The landing ("/") is a full-bleed hero with its own header, so the shared app nav is hidden
// there. The app screens (/trade, /earn, /portfolio) keep the nav and drop any marketing footer.
export function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const bare = pathname === "/";
  return (
    <>
      {!bare && <Nav />}
      {!bare && <FaucetHint />}
      {children}
    </>
  );
}
