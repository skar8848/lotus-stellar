"use client";

import { Copy, ExternalLink, FlaskConical, LogOut, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfig } from "@/lib/config-context";
import { explorerAccount } from "@/lib/explorer";
import { shortAddr } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { Spinner } from "@/components/common";

export function ConnectButton() {
  const w = useWallet();
  const { network } = useConfig();

  if (w.address) {
    const devName = w.kind === "dev" ? w.devAccounts.find((d) => d.address === w.address)?.label : null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2" data-testid="wallet-button" data-address={w.address}>
            <span className="size-2 rounded-full bg-green" />
            {shortAddr(w.address, 4)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs text-mutedfg">
            {w.kind === "dev" ? `Dev wallet${devName ? ` · ${devName}` : ""}` : "Connected"}
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => navigator.clipboard?.writeText(w.address as string)}>
            <Copy className="size-4" /> Copy address
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={explorerAccount(w.address, network)} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" /> View on explorer
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => w.disconnect()} data-testid="wallet-disconnect">
            <LogOut className="size-4" /> Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="gap-2" data-testid="wallet-connect" disabled={w.busy}>
          {w.busy ? <Spinner /> : <Wallet className="size-4" />} Connect
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-mutedfg">Connect a wallet</DropdownMenuLabel>
        <DropdownMenuItem disabled={!w.ready} onClick={() => w.connect()} data-testid="wallet-kit">
          <Wallet className="size-4" /> Freighter, xBull, Albedo, Lobstr...
        </DropdownMenuItem>
        {w.devAccounts.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-primary">
              <FlaskConical className="size-3.5" /> Dev wallet (testnet secret key)
            </DropdownMenuLabel>
            {w.devAccounts.map((d) => (
              <DropdownMenuItem key={d.label} onClick={() => w.connectDev(d.label)} data-testid={`dev-wallet-${d.label}`}>
                <span className="font-medium">{d.label}</span>
                <span className="num ml-auto text-xs text-mutedfg">{shortAddr(d.address, 4)}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {w.error ? <div className="px-2 py-1.5 text-xs text-destructive">{w.error}</div> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
