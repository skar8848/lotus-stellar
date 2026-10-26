"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Droplets } from "lucide-react";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/swap", label: "Swap" },
  { href: "/trade", label: "Trade" },
  { href: "/pools", label: "Pools" },
  { href: "/portfolio", label: "Portfolio" },
];

export function NetworkBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 border-primary/30 py-1 pl-2 pr-2.5 text-primary", className)} data-testid="network-badge">
      <span className="size-1.5 rounded-full bg-primary" />
      Testnet
    </Badge>
  );
}

export function Nav() {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/70 backdrop-blur-md">
      {/* one container on every page: full width, 16px gutter (the /trade terminal is full width too, so the logo
          lines up with the market selector there and sits at the same x on every route) */}
      <nav className="flex w-full items-center justify-between gap-3 px-4 py-3" data-testid="nav">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lotus-logo.svg" alt="" className="h-6 w-auto" />
            <span className="font-[family-name:var(--font-audiowide)] tracking-[0.16em]">LOTUS</span>
          </Link>
          <div className="hidden items-center gap-5 text-sm md:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn("transition hover:text-white", active(l.href) ? "text-white" : "text-mutedfg")}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/faucet"
            data-testid="nav-faucet"
            title="Testnet faucet: XLM, trustlines, LBOND + USDC"
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition",
              active("/faucet") ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-mutedfg hover:border-primary/40 hover:text-primary",
            )}
          >
            <Droplets className="size-3.5" aria-hidden />
            Faucet
          </Link>
          <NetworkBadge className="hidden sm:inline-flex" />
          <ConnectButton />
        </div>
      </nav>
      {/* phone: the destinations as a second row */}
      <div className="grid w-full grid-cols-4 gap-1 px-4 pb-2 md:hidden">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "rounded-md py-1.5 text-center text-sm transition",
              active(l.href) ? "bg-white/10 text-white" : "text-mutedfg hover:text-white",
            )}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </header>
  );
}
