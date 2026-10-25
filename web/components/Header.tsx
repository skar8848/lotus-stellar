"use client";

import Link from "next/link";
import type { LotusConfig } from "@/lib/config";
import { useWallet } from "@/lib/wallet";
import { shortAddr } from "@/lib/stellar";
import { Dot, Spinner, Wordmark } from "./ui";

export function Header({ config }: { config: LotusConfig }) {
  const w = useWallet();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-black/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" alt="" className="h-6 w-6" />
            <Wordmark className="text-base leading-none" />
          </Link>
          <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-fg">
            {config.network}
          </span>
        </div>

        <nav className="hidden items-center gap-5 text-xs text-muted-fg md:flex">
          <a href="#vault" className="hover:text-foreground">
            Vault
          </a>
          <a href="#book" className="hover:text-foreground">
            Book
          </a>
          <a href="#peg" className="hover:text-foreground">
            Peg
          </a>
          <a href="#holders" className="hover:text-foreground">
            Holders
          </a>
        </nav>

        <div className="flex items-center gap-2">
          {w.address ? (
            <>
              <span className="hidden items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs sm:flex">
                <Dot ok />
                <span className="num">{shortAddr(w.address, 5)}</span>
              </span>
              <button className="btn btn-sm" onClick={w.disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={w.connect} disabled={!w.ready || w.busy}>
              {w.busy ? <Spinner /> : null}
              {w.ready ? "Connect wallet" : "Loading wallets"}
            </button>
          )}
        </div>
      </div>
      {w.error ? <div className="border-t border-red/30 bg-red/5 px-4 py-1.5 text-center text-xs text-red">{w.error}</div> : null}
    </header>
  );
}
