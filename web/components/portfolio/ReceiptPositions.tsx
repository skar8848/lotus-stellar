"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AssetLink, Empty, ExplorerLink, Panel, Spinner, TokenIcon, TxStatus } from "@/components/common";
import { StatusBadge } from "@/components/vault/StrategyCard";
import { useAccount } from "@/lib/account";
import { tryStroops } from "@/lib/amount";
import type { Strategy } from "@/lib/config-types";
import { useNet } from "@/lib/config-context";
import { useTx } from "@/lib/hooks";
import { addressArg, fmt, fromStroops, i128Arg, invokeContract, toStroops, type HorizonAccount } from "@/lib/stellar";
import { fmtAmt, hasContract, inOffers } from "@/lib/vault";
import { useWallet } from "@/lib/wallet";
import { findBal } from "./util";

/** Lotus receipts held, one row per Lotus vault: balance, share of supply, and the part resting in SDEX offers. */
export function ReceiptPositions({
  strategies,
  account,
  supplies,
  network,
  loading,
  onChanged,
}: {
  onChanged?: () => void;
  strategies: Strategy[];
  account: HorizonAccount | null;
  /** account not loaded yet: show dashes instead of "no trustline" */
  loading: boolean;
  supplies: Record<string, bigint | null> | null;
  network: string;
}) {
  const list = strategies.filter((s) => s.receipt.issuer);
  return (
    <Panel
      title="Lotus receipts"
      id="receipts"
      subtitle="Receipt tokens of the Lotus vault: USDC in, receipt out 1:1, invested in DeFindex on Blend. You get them with the Stellar DEX + Blend yield strategy on Pools; redeem them for USDC here."
      className="min-w-0 scroll-mt-20"
    >
      {list.length === 0 ? (
        <Empty>No Lotus vault is configured.</Empty>
      ) : (
        <ul className="divide-y divide-border" data-testid="portfolio-receipts">
          {list.map((s) => {
            const bal = findBal(account, s.receipt);
            const balance = bal ? toStroops(bal.balance) : null;
            const offers = inOffers(bal);
            const supply = supplies?.[s.id] ?? null;
            const share = balance !== null && supply !== null && supply > 0n ? (Number(balance) / Number(supply)) * 100 : null;
            // this holder's part of the interest accrued since the last distribution (keeper runs every ~15 min)
            const surplus = supplies?.[`surplus:${s.id}`] ?? null;
            const pending = balance !== null && supply !== null && surplus !== null && supply > 0n && surplus > 0n ? (surplus * balance) / supply : null;
            const idle = s.status !== "live";
            return (
              <li key={s.id} className="grid gap-x-6 gap-y-3 py-3 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))_auto] md:items-center" data-testid={`receipt-${s.id}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <TokenIcon code={s.receipt.code} size={22} />
                    <AssetLink asset={s.receipt} network={network} className="font-medium" />
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="mt-1 break-words text-[11px] text-mutedfg">
                    {s.label}
                    {hasContract(s) ? (
                      <>
                        {" · "}
                        <ExplorerLink kind="contract" id={s.lotusVault} network={network} label="vault contract" mono={false} />
                      </>
                    ) : null}
                  </div>
                </div>
                <Cell
                  label="Balance"
                  value={bal ? `${fmtAmt(balance)} ${s.receipt.code}` : loading ? "-" : "no trustline"}
                  muted={!bal}
                  sub={pending !== null ? `+${fmt(fromStroops(pending), 7)} accrued, paid at the next distribution` : undefined}
                />
                <Cell
                  label="Share of supply"
                  value={share === null ? "-" : `${share < 0.01 && share > 0 ? "<0.01" : fmt(share, 2)}%`}
                  sub={supply !== null ? `supply ${fmt(supply, 2)}` : hasContract(s) ? "supply unavailable" : "no contract"}
                />
                <Cell
                  label="In open offers"
                  value={offers > 0n ? `${fmt(fromStroops(offers), 2)} ${s.receipt.code}` : "-"}
                  sub={
                    offers > 0n
                      ? idle
                        ? "still on your account (no yield accrues on an idle vault)"
                        : "still on your account, so still eligible for distributions"
                      : undefined
                  }
                />
                <div className="md:text-right">
                  {hasContract(s) && balance !== null ? (
                    // stays mounted at 0 so the confirmation of a full redeem remains on screen
                    <RedeemReceipt strategy={s} max={balance - offers > 0n ? balance - offers : 0n} inOffers={offers} network={network} onDone={onChanged} />
                  ) : (
                    <span className="text-[11px] text-mutedfg">{hasContract(s) ? "no trustline" : "no contract"}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Cell({ label, value, sub, muted }: { label: string; value: string; sub?: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`num mt-0.5 truncate text-sm font-medium ${muted ? "text-mutedfg" : ""}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] leading-snug text-mutedfg">{sub}</div> : null}
    </div>
  );
}

/** Redeem lUSDCb -> USDC (lotus_vault.redeem), 1:1 while the vault is fully backed. Was the Vault tab's Redeem form. */
function RedeemReceipt({ strategy, max, inOffers: locked, network, onDone }: { strategy: Strategy; max: bigint; inOffers: bigint; network: string; onDone?: () => void }) {
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Redeem");
  const [amt, setAmt] = useState("");
  const v = tryStroops(amt);
  const over = v !== null && v > max;
  const r = strategy.receipt.code;
  const u = strategy.underlying.code;
  const redeem = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (v === null || v <= 0n) throw new Error("Enter an amount");
      const res = await invokeContract(net, {
        contractId: strategy.lotusVault,
        method: "redeem",
        args: [addressArg(wallet.address), i128Arg(v)],
        source: wallet.address,
        sign: wallet.sign,
        onStage: (st) => onStage(st, "redeem"),
      });
      setAmt("");
      acct.refresh();
      onDone?.();
      const paid = typeof res.result === "bigint" ? `${fromStroops(res.result)} ${u}` : u;
      return { hash: res.hash, result: res.result, note: `burnt ${fromStroops(v)} ${r}, returned ${paid}` };
    });
  return (
    <div className="flex flex-col items-stretch gap-1.5 md:items-end" data-testid={`redeem-${strategy.id}`}>
      <div className="flex items-center gap-1.5">
        <div className="flex h-8 items-center rounded-lg border border-line bg-black/20 px-2">
          <input
            inputMode="decimal"
            placeholder="0"
            value={amt}
            onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))}
            className="w-20 bg-transparent text-right text-sm tabular-nums outline-none"
            data-testid={`redeem-amount-${strategy.id}`}
          />
          <button type="button" className="ml-1.5 text-[10px] text-primary hover:underline" onClick={() => setAmt(fromStroops(max))}>
            max
          </button>
        </div>
        <Button size="sm" variant="outline" disabled={tx.running || max === 0n || v === null || v <= 0n || over} onClick={redeem} data-testid={`redeem-submit-${strategy.id}`}>
          {tx.running ? <Spinner /> : null}
          Redeem {r} → {u}
        </Button>
      </div>
      {over ? <span className="text-[11px] text-destructive">more than your free {r} ({fmtAmt(max)})</span> : null}
      {max === 0n ? <span className="text-[11px] text-mutedfg">{locked > 0n ? `all in offers: cancel them to redeem` : `nothing to redeem`}</span> : null}
      <div className="w-full max-w-sm text-left">
        <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
      </div>
    </div>
  );
}
