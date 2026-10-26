"use client";

// Trustline / authorization state of the connected account for one asset, plus the notice + "Add trustline"
// action. LBOND is AUTH_REQUIRED: a trustline alone is not enough, the issuer must authorize the account.

import { useCallback } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { usePolling, useTx } from "@/lib/hooks";
import {
  changeTrustOp,
  fetchAssetFlags,
  findBalance,
  isNative,
  submitClassic,
  type AssetFlags,
  type AssetRef,
  type HorizonBalance,
} from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { ExplorerLink, Spinner, TxStatus } from "@/components/common";

export type AccessState = "disconnected" | "loading" | "ok" | "no-trustline" | "unauthorized";

export type AssetAccess = {
  state: AccessState;
  balance: HorizonBalance | undefined;
  /** balance minus selling liabilities (minus a 2 XLM cushion for native), as a number; null when unknown */
  available: number | null;
  flags: AssetFlags | null;
};

export function useAssetAccess(asset: AssetRef | null): AssetAccess {
  const { horizon } = useConfig();
  const wallet = useWallet();
  const acct = useAccount();
  const issuer = asset?.issuer ?? null;
  const flagsFn = useCallback(() => (issuer ? fetchAssetFlags(horizon, issuer) : Promise.resolve(null)), [horizon, issuer]);
  const flags = usePolling(flagsFn, 120000, !!issuer);

  if (!asset) return { state: "loading", balance: undefined, available: null, flags: null };
  if (!wallet.address) return { state: "disconnected", balance: undefined, available: null, flags: flags.data };
  if (!acct.data) return { state: "loading", balance: undefined, available: null, flags: flags.data };
  const balance = findBalance(acct.data, asset);
  if (isNative(asset)) {
    const reserve = (2 + acct.data.subentry_count) * 0.5;
    const avail = balance ? Number(balance.balance) - Number(balance.selling_liabilities ?? 0) - reserve : null;
    return { state: "ok", balance, available: avail === null ? null : Math.max(0, avail), flags: null };
  }
  if (!balance) return { state: "no-trustline", balance, available: null, flags: flags.data };
  const available = Math.max(0, Number(balance.balance) - Number(balance.selling_liabilities ?? 0));
  if (balance.is_authorized === false) return { state: "unauthorized", balance, available, flags: flags.data };
  return { state: "ok", balance, available, flags: flags.data };
}

/** Plain-language status line + "Add trustline" for one asset. Renders nothing when everything is fine. */
export function TrustlineNotice({
  asset,
  access,
  verb = "hold",
}: {
  asset: AssetRef;
  access: AssetAccess;
  verb?: string;
  showOk?: boolean;
}) {
  const net = useNet();
  const { network } = useConfig();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx(`${asset.code} trustline`);

  const add = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const r = await submitClassic(net, { source: wallet.address, ops: [changeTrustOp(asset)], sign: wallet.sign, onStage });
      acct.refresh();
      return { ...r, note: access.flags?.authRequired ? `${asset.code} trustline added, waiting for issuer authorization` : `${asset.code} trustline added` };
    });

  if (access.state === "disconnected" || access.state === "loading") return null;

  const regulated = access.flags?.authRequired;

  if (access.state === "ok") {
    // authorized: nothing to say (only problems are shown)
    return null;
  }

  if (access.state === "no-trustline") {
    return (
      <div className="mt-2 rounded-xl border border-border bg-secondary/50 px-3 py-2.5 text-xs" data-testid={`access-${asset.code}`} data-access="no-trustline">
        <div className="flex items-center justify-between gap-3">
          <span className="text-mutedfg">
            No {asset.code} trustline on this account.
            {regulated ? ` ${asset.code} is AUTH_REQUIRED: after you add it, the issuer must still authorize you before you can ${verb} it.` : ""}
          </span>
          <Button size="xs" variant="outline" onClick={add} disabled={tx.running} data-testid={`add-trustline-${asset.code}`}>
            {tx.running ? <Spinner /> : null}
            Add trustline
          </Button>
        </div>
        <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
      </div>
    );
  }

  // trustline exists but the issuer has not authorized it
  return (
    <div className="mt-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs" data-testid={`access-${asset.code}`} data-access="unauthorized">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>
          <span className="font-medium text-destructive">Not authorized by the issuer.</span>{" "}
          <span className="text-mutedfg">
            {asset.code} is a regulated asset (AUTH_REQUIRED): your trustline exists but the issuer has not authorized this account, so it cannot {verb} {asset.code}. Ask the issuer{" "}
            {asset.issuer ? <ExplorerLink kind="account" id={asset.issuer} network={network} /> : null} to authorize it.
          </span>
        </span>
      </div>
    </div>
  );
}
