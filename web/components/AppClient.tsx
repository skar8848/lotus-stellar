"use client";

import type { LotusConfig } from "@/lib/config";
import { AccountProvider } from "@/lib/account";
import { assetReady, isContractId } from "@/lib/stellar";
import { WalletProvider } from "@/lib/wallet";
import { BookPanel } from "./BookPanel";
import { Header } from "./Header";
import { HoldersStrip } from "./HoldersStrip";
import { PegPanel } from "./PegPanel";
import { VaultPanel } from "./VaultPanel";

export function AppClient({ config }: { config: LotusConfig }) {
  const missing: string[] = [];
  if (!isContractId(config.lotusVault)) missing.push("lotus_vault contract");
  if (!assetReady(config.receipt)) missing.push(`${config.receipt.code} issuer`);
  if (!assetReady(config.rwa)) missing.push(`${config.rwa.code} issuer`);
  const placeholder = config.sources.contract === "example" || config.sources.classic === "example";

  return (
    <WalletProvider passphrase={config.passphrase}>
      <AccountProvider horizon={config.horizon}>
        <Header config={config} />
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-16 pt-5">
          {placeholder || missing.length > 0 ? (
            <div className="mb-4 rounded-md border border-line bg-card px-3 py-2 text-xs text-muted-fg">
              <span className="text-foreground">Partial config.</span>{" "}
              {placeholder ? `Deployment files not found (${config.sources.contract === "example" ? "testnet.contract.json" : ""}${
                placeholder && config.sources.contract === "example" && config.sources.classic === "example" ? ", " : ""
              }${config.sources.classic === "example" ? "testnet.classic.json" : ""}); using web/config.example.json. ` : null}
              {missing.length > 0 ? `Missing: ${missing.join(", ")}. Panels that depend on them show "—".` : null}
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-4" id="vault">
              <VaultPanel config={config} />
            </div>
            <div className="min-w-0 lg:col-span-8">
              <BookPanel config={config} />
            </div>
            <div className="min-w-0 lg:col-span-4" id="peg">
              <PegPanel config={config} />
            </div>
            <div className="min-w-0 lg:col-span-8">
              <HoldersStrip config={config} />
            </div>
          </div>

          <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
            <span>
              {config.network} · Horizon {config.horizon.replace("https://", "")} · RPC {config.rpc.replace("https://", "")}
            </span>
            <span>Lotus · HackMeridian</span>
          </footer>
        </main>
      </AccountProvider>
    </WalletProvider>
  );
}
