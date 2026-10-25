"use client";

import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AccountProvider } from "@/lib/account";
import { ConfigProvider } from "@/lib/config-context";
import type { LotusConfig } from "@/lib/config-types";
import { WalletProvider } from "@/lib/wallet";

export function Providers({ config, children }: { config: LotusConfig; children: React.ReactNode }) {
  return (
    <ConfigProvider initial={config}>
      <WalletProvider passphrase={config.passphrase}>
        <AccountProvider>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
          <Toaster theme="dark" position="bottom-right" richColors closeButton />
        </AccountProvider>
      </WalletProvider>
    </ConfigProvider>
  );
}
