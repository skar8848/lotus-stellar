"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/trade", label: "Trade" },
  { href: "/earn", label: "Earn" },
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
      <nav className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
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
        <div className="flex items-center gap-2.5">
          <NetworkBadge className="hidden sm:inline-flex" />
          <ConnectButton />
        </div>
      </nav>
      {/* phone: the three destinations as a second row */}
      <div className="mx-auto grid max-w-7xl grid-cols-3 gap-1 px-4 pb-2 md:hidden">
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
