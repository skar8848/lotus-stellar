"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AssetLink, Empty, ExplorerLink, Panel, TokenIcon } from "@/components/common";
import { StatusBadge } from "@/components/vault/StrategyCard";
import type { Strategy } from "@/lib/config-types";
import { fmt, fromStroops, toStroops, type HorizonAccount } from "@/lib/stellar";
import { fmtAmt, hasContract, inOffers } from "@/lib/vault";
import { findBal } from "./util";

/** Lotus receipts held, one row per Lotus vault: balance, share of supply, and the part resting in SDEX offers. */
export function ReceiptPositions({
  strategies,
  account,
  supplies,
  network,
  loading,
}: {
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
      subtitle="Receipt tokens from the Lotus vault (USDC in, receipt out 1:1). They trade on the SDEX like any asset."
      className="min-w-0"
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
                <Cell label="Balance" value={bal ? `${fmtAmt(balance)} ${s.receipt.code}` : loading ? "-" : "no trustline"} muted={!bal} />
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
                  <Link
                    href={`/pools?tab=vault&strategy=${encodeURIComponent(s.id)}`}
                    className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                    data-testid={`receipt-manage-${s.id}`}
                  >
                    Deposit or redeem <ArrowRight className="size-3" />
                  </Link>
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
