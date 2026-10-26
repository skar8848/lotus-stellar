"use client";

import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Market } from "@/lib/markets";
import type { RangeResult } from "@/lib/range";
import type { OrderBook } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { LimitTab, type PricePick } from "./LimitTab";
import { RangeTab } from "./RangeTab";
import { SwapTab } from "./SwapTab";
import type { RangeForm } from "./rangeState";

export type OrderTab = "swap" | "limit" | "range";

const PRESETS = [0.1, 0.5, 1];

function SlippageSettings({ slippage, onChange }: { slippage: number; onChange: (v: number) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 text-mutedfg" aria-label="Settings" data-testid="slippage-settings" title={`Slippage ${slippage}%`}>
          <Settings className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="text-sm font-medium">Settings</div>
        <div className="mt-1 text-xs text-mutedfg">Max slippage tolerance (swaps)</div>
        <div className="mt-2 flex items-center gap-2">
          {PRESETS.map((p) => (
            <Button key={p} size="sm" variant={slippage === p ? "default" : "outline"} onClick={() => onChange(p)} className="flex-1">
              {p}%
            </Button>
          ))}
          <div className="flex items-center gap-1 rounded-md border border-border px-2">
            <Input
              type="number"
              value={slippage}
              onChange={(e) => onChange(Math.max(0, Math.min(50, Number(e.target.value))))}
              className="h-7 w-12 border-0 bg-transparent px-0 text-right text-sm shadow-none focus-visible:ring-0"
            />
            <span className="text-xs text-mutedfg">%</span>
          </div>
        </div>
        {slippage > 5 ? <p className="mt-2 text-[11px] text-destructive">High slippage: your fill may be front-run.</p> : null}
      </PopoverContent>
    </Popover>
  );
}

const TYPES: { value: OrderTab; label: string; title: string }[] = [
  { value: "swap", label: "Swap", title: "Market order: one path payment through the books" },
  { value: "limit", label: "Limit", title: "One resting offer at your price" },
  { value: "range", label: "Range", title: "A ladder of offers across a price range, one transaction" },
];

/** The order-entry column: Swap (taker) | Limit (one offer) | Range (SDEX ladder). Every action is signed in the wallet. */
export function OrderPanel({
  market,
  book,
  tab,
  onTab,
  slippage,
  onSlippage,
  pick,
  form,
  setForm,
  rangeResult,
  refPrice,
  onDone,
}: {
  market: Market;
  book: OrderBook | null;
  tab: OrderTab;
  onTab: (t: OrderTab) => void;
  slippage: number;
  onSlippage: (v: number) => void;
  pick: PricePick;
  form: RangeForm;
  setForm: (f: RangeForm) => void;
  rangeResult: RangeResult;
  refPrice: number;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col" data-testid="order-panel">
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
        <h3 className="text-xs font-semibold">Place order</h3>
        <SlippageSettings slippage={slippage} onChange={onSlippage} />
      </div>
      <div className="flex gap-1 px-3 pb-1" role="tablist">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            data-state={tab === t.value ? "active" : "inactive"}
            title={t.title}
            onClick={() => onTab(t.value)}
            data-testid={`tab-${t.value}`}
            className={cn(
              "rounded-md border px-3 py-1 text-xs font-medium transition-colors",
              tab === t.value ? "border-border bg-secondary text-foreground" : "border-transparent text-mutedfg hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="px-3 pb-4 pt-2">
        {tab === "swap" ? <SwapTab key={market.id} market={market} slippageBps={Math.round(slippage * 100)} onDone={onDone} /> : null}
        {tab === "limit" ? <LimitTab key={market.id} market={market} book={book} pick={pick} onDone={onDone} /> : null}
        {tab === "range" ? <RangeTab market={market} book={book} form={form} setForm={setForm} result={rangeResult} refPrice={refPrice} onDone={onDone} /> : null}
      </div>
    </div>
  );
}
