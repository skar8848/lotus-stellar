"use client";

// Step 3 "Choose your strategy": the 2x2 of lib/orderRoute.ts as four cards (pool | SDEX) x (yield off | on).
// Card styling follows lotus-main's yield-venue rows (YieldVenueModal: selected = pink border + tint, disabled =
// dimmed with the reason) and its round checkbox.

import { fmt, type AssetRef } from "@/lib/stellar";
import { PROXIMITY_MIN_BINS } from "@/lib/orderRoute";
import type { Side } from "@/lib/poolGrid";
import { cn } from "@/lib/utils";
import { RoundCheck } from "./bits";
import type { LiveApr } from "./useBlendApr";
import type { Destination, StrategyId } from "./useOrder";

const TITLE: Record<StrategyId, string> = {
  pool: "Lotus pool",
  "pool-yield": "Lotus pool + Blend yield",
  sdex: "Stellar DEX",
  "sdex-yield": "Stellar DEX + Blend yield",
};

function explain(id: StrategyId, side: Side, base: string, quote: string, receipt: string, bins: number): string {
  switch (id) {
    case "pool":
      return `Rests in the Lotus range pool (Soroban), ${bins} bins. The ${quote} side stays idle in the pool.`;
    case "pool-yield":
      return side === "Ask"
        ? `Same pool order, on the instance whose ${quote} sits in DeFindex: the proceeds earn while they wait to be claimed.`
        : `Same pool order, on the instance whose ${quote} sits in DeFindex: your ${quote} earns until it buys ${base}.`;
    case "sdex":
      return `${bins} offers on the Stellar order book (${base}/${quote}), one per bin at the same prices. One classic transaction.`;
    case "sdex-yield":
      return side === "Ask"
        ? `${bins} offers quoted in ${receipt}, the Lotus receipt (1:1 for ${quote}): proceeds arrive as ${receipt} and keep earning.`
        : `Your ${quote} is deposited 1:1 for ${receipt}, then ${bins} offers buy ${base} with it. The receipt keeps earning while the offers wait.`;
  }
}

export function StrategyCards({
  destinations,
  side,
  base,
  quote,
  receipt,
  bins,
  apr,
  refPrice,
  refSource,
  selected,
  onSelect,
}: {
  destinations: Destination[];
  side: Side;
  base: AssetRef;
  quote: AssetRef;
  receipt: AssetRef;
  bins: number;
  apr: LiveApr;
  refPrice: number;
  refSource: string;
  selected: StrategyId | null;
  onSelect: (id: StrategyId) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="strategy-cards">
      {destinations.map((d) => {
        const disabled = !!d.unavailable;
        const active = selected === d.id && !disabled;
        const yieldLive = d.yieldOn && d.strategy?.status === "live";
        return (
          <button
            key={d.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(d.id)}
            data-testid={`strategy-${d.id}`}
            data-disabled={disabled ? "1" : "0"}
            data-selected={active ? "1" : "0"}
            data-signatures={d.signatures}
            className={cn(
              "flex flex-col gap-3 rounded-xl border p-4 text-left transition",
              active ? "border-primary/60 bg-primary/10" : "border-line hover:border-white/20",
              disabled && "cursor-not-allowed opacity-55 hover:border-line",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <RoundCheck on={active} />
                <span className="text-sm font-semibold text-white">{TITLE[d.id]}</span>
              </div>
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", d.venue === "pool" ? "bg-primary/10 text-primary" : "bg-white/5 text-mutedfg")}>
                {d.venue === "pool" ? "Soroban" : "SDEX"}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-mutedfg">{explain(d.id, side, base.code, quote.code, receipt.code, bins)}</p>

            <div className="mt-auto grid grid-cols-2 gap-2 border-t border-line pt-3 text-xs">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-mutedfg">Expected yield</div>
                {!d.yieldOn ? (
                  <div className="mt-0.5 font-medium text-mutedfg">None</div>
                ) : !yieldLive ? (
                  <div className="mt-0.5 font-medium text-mutedfg">0% (vault idle)</div>
                ) : (
                  <div className="mt-0.5" data-testid={`strategy-${d.id}-apr`}>
                    <span className="font-semibold tabular-nums text-green">
                      {apr.aprPct !== null ? `${fmt(apr.aprPct, 2, 2)}%` : apr.observedPct !== null ? `${fmt(apr.observedPct, 2, 2)}%` : "-"} APR
                    </span>
                    <span className="block text-[10px] leading-snug text-mutedfg">
                      {apr.aprPct !== null
                        ? `observed live on testnet over ${apr.windowS}s, not a forecast`
                        : apr.observedPct !== null
                          ? "last observed on testnet (measuring live...), not a forecast"
                          : "measuring live..."}
                    </span>
                  </div>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-mutedfg">Signatures</div>
                <div className="mt-0.5 font-medium tabular-nums" data-testid={`strategy-${d.id}-sigs`}>
                  {d.signatures}
                  {d.signatures > 1 ? (
                    <span className="block text-[10px] font-normal leading-snug text-mutedfg">
                      {d.needsReceiptTrustline ? `${receipt.code} trustline, deposit, offers` : "deposit, then offers"}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            {disabled ? (
              <p className="rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-2 text-[11px] leading-relaxed text-primary" data-testid={`strategy-${d.id}-why`}>
                {d.unavailable}
                {d.id === "pool-yield" && d.guard.blocked
                  ? ` The top of your range is ${fmt(Math.max(0, d.guard.distance ?? 0), 1)} bins under the price (${fmt(refPrice, 4, 4)}, ${refSource}); the curator rule needs at least ${PROXIMITY_MIN_BINS} bins (about 1%) for a bid to earn in the pool. Move the range down, or use the Stellar DEX + Blend yield, where the receipt keeps earning in the offer.`
                  : ""}
              </p>
            ) : d.id === "pool-yield" && side === "Ask" ? (
              <p className="text-[10px] text-mutedfg">Asks are never blocked: the yield is on proceeds waiting in the vault.</p>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
