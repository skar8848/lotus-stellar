"use client";

// One thin line under the nav when the connected wallet is not on testnet yet or lacks a Lotus trustline.
// Hidden on /faucet itself and when no wallet is connected.

import Link from "next/link";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { Droplets } from "lucide-react";
import { useAccount } from "@/lib/account";
import { useConfig } from "@/lib/config-context";
import { faucetAssets, missingTrustlines } from "@/lib/faucet";

export function FaucetHint() {
  const pathname = usePathname();
  const config = useConfig();
  const acct = useAccount();
  const assets = useMemo(() => faucetAssets(config), [config]);
  if (config.network !== "testnet" || !acct.address || acct.updatedAt === null || pathname.startsWith("/faucet")) return null;
  const notFunded = acct.data === null;
  const missing = acct.data ? missingTrustlines(acct.data.balances, assets) : assets;
  if (!notFunded && missing.length === 0) return null;
  return (
    <div className="border-b border-primary/20 bg-primary/5" data-testid="faucet-hint">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-1.5 text-xs sm:px-6">
        <span className="text-mutedfg">
          {notFunded
            ? "This wallet is not on testnet yet."
            : `This wallet has no ${missing.map((m) => m.asset.code).join(" / ")} trustline yet.`}
        </span>
        <Link href="/faucet" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          <Droplets className="size-3.5" aria-hidden /> Get test tokens
        </Link>
      </div>
    </div>
  );
}
