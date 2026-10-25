"use client";

import { Badge } from "@/components/ui/badge";
import { AssetLink, Empty, ExplorerLink, Panel, TokenIcon } from "@/components/common";
import { fmt } from "@/lib/stellar";
import { fmtNum } from "./util";
import { cn } from "@/lib/utils";
import type { BalanceRow } from "./model";

const KIND_LABEL: Record<BalanceRow["kind"], string> = {
  native: "native",
  underlying: "underlying",
  receipt: "Lotus receipt",
  bond: "tokenized bond",
  other: "",
  lp: "liquidity pool",
};

/** Balances from Horizon: total, spendable ("available") and the part locked in open offers. */
export function Balances({ rows, network, priceNotes, loading }: { rows: BalanceRow[]; network: string; priceNotes: string[]; loading: boolean }) {
  return (
    <Panel
      title="Balances"
      subtitle="Wallet assets. Offers only set a selling liability, so what sits in offers is still yours (and still counted)."
      className="min-w-0"
    >
      {loading ? (
        <Empty>Loading balances...</Empty>
      ) : rows.length === 0 ? (
        <Empty>No balances yet.</Empty>
      ) : (
        <div className="overflow-x-auto scroll-thin" data-testid="portfolio-balances">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1.5 pr-3 font-normal">Asset</th>
                <th className="py-1.5 pr-3 text-right font-normal">Balance</th>
                <th className="py-1.5 pr-3 text-right font-normal">Available</th>
                <th className="py-1.5 pr-3 text-right font-normal">In offers</th>
                <th className="py-1.5 text-right font-normal">Value (USDC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={cn("border-t border-border", !r.held && "text-mutedfg")} data-testid={`balance-${r.code}`} data-held={r.held ? "1" : "0"}>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2.5">
                      <TokenIcon code={r.code === "Pool share" ? "P" : r.code} size={22} />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {r.asset ? <AssetLink asset={r.asset} network={network} className="font-medium" /> : r.poolId ? <ExplorerLink kind="liquidity-pool" id={r.poolId} network={network} label="Pool share" mono={false} className="font-medium" /> : <span className="font-medium">{r.code}</span>}
                          {r.unauthorized ? (
                            <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive" title="The issuer has not authorized this trustline: you cannot receive or send this asset until it does.">
                              not authorized by issuer
                            </Badge>
                          ) : null}
                        </div>
                        {KIND_LABEL[r.kind] ? <div className="text-[11px] text-mutedfg">{KIND_LABEL[r.kind]}</div> : null}
                      </div>
                    </div>
                  </td>
                  {r.held ? (
                    <>
                      <td className="num py-2 pr-3 text-right">{fmtNum(r.balance)}</td>
                      <td className="num py-2 pr-3 text-right">{fmtNum(r.available)}</td>
                      <td className={cn("num py-2 pr-3 text-right", r.inOffers > 0 ? "text-green" : "text-mutedfg")}>{r.inOffers > 0 ? fmtNum(r.inOffers) : "-"}</td>
                      <td className="num py-2 text-right" title={r.price ? `${fmt(r.price.price, 4, 4)} USDC per unit (${r.price.source})` : "no price source for this asset"}>
                        {fmtNum(r.value)}
                      </td>
                    </>
                  ) : (
                    <td colSpan={4} className="py-2 text-right text-xs text-mutedfg">
                      no trustline
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="mt-3 space-y-0.5 text-[11px] text-mutedfg">
        <li>Available = balance minus what is locked in offers (XLM also minus the base reserve, 0.5 XLM per account entry).</li>
        <li>Value uses real prices only: USDC is the unit, each Lotus receipt counts at par (1:1 redemption; undistributed surplus is not counted).</li>
        {priceNotes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        <li>A dash in the value column means no price source exists for that asset; it is excluded from the total.</li>
      </ul>
    </Panel>
  );
}
