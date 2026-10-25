"use client";

import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Market } from "@/lib/markets";
import type { RangeResult } from "@/lib/range";
import type { OrderBook } from "@/lib/stellar";
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
        <Button variant="outline" size="icon" className="size-9" aria-label="Settings" data-testid="slippage-settings">
          <Settings className="size-4" />
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

const triggerCls =
  "h-auto flex-none rounded-none border-0 bg-transparent px-2 py-1 text-lg font-semibold text-mutedfg/60 shadow-none hover:text-mutedfg data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent dark:data-[state=active]:border-transparent";

/** Swap (taker) | Limit (one offer) | Range (pro range builder), like lotus-main's lite/pro order panel. */
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
    <div className="card p-4 sm:p-5" data-testid="order-panel">
      <Tabs value={tab} onValueChange={(v) => onTab(v as OrderTab)} className="gap-3">
        <div className="flex items-center justify-between">
          <TabsList className="h-auto gap-0 bg-transparent p-0">
            <TabsTrigger value="swap" className={triggerCls} data-testid="tab-swap">
              Swap
            </TabsTrigger>
            <TabsTrigger value="limit" className={triggerCls} data-testid="tab-limit">
              Limit
            </TabsTrigger>
            <TabsTrigger value="range" className={triggerCls} data-testid="tab-range">
              Range
            </TabsTrigger>
          </TabsList>
          <SlippageSettings slippage={slippage} onChange={onSlippage} />
        </div>
        <TabsContent value="swap">
          <SwapTab key={market.id} market={market} slippageBps={Math.round(slippage * 100)} onDone={onDone} />
        </TabsContent>
        <TabsContent value="limit">
          <LimitTab key={market.id} market={market} book={book} pick={pick} onDone={onDone} />
        </TabsContent>
        <TabsContent value="range">
          <RangeTab market={market} book={book} form={form} setForm={setForm} result={rangeResult} refPrice={refPrice} onDone={onDone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
