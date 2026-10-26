"use client";

// The pro range builder inputs shared by the New order panel and the two-way LP builder: side, amount, start / end
// price (snapped to the pool grid), presets, weight shape with a live per-bin preview.

import type { ReactNode } from "react";
import { AssetField, Segmented } from "@/components/common";
import type { PositionPlan, Shape, Side } from "@/lib/poolGrid";
import { fmt, type AssetRef } from "@/lib/stellar";
import type { Mode } from "@/lib/pool";

export type PoolForm = {
  mode: Mode;
  side: Side;
  start: string | null;
  end: string | null;
  shape: Shape;
  amount: string;
};

export const initialPoolForm: PoolForm = { mode: "Directional", side: "Ask", start: null, end: null, shape: "uniform", amount: "" };

const fx = (n: number) => String(Number(n.toFixed(4)));

/** Default range around the reference price: asks go up from it, bids go down from just under it. */
export function poolDefaults(side: Side, ref: number): { start: string; end: string } {
  const r = ref > 0 ? ref : 1;
  return side === "Ask" ? { start: fx(r), end: fx(r * 1.02) } : { start: fx(r * 0.999), end: fx(r * 0.999 * 0.98) };
}
export function poolEffective(form: PoolForm, ref: number) {
  const d = poolDefaults(form.side, ref);
  return { start: form.start ?? d.start, end: form.end ?? d.end };
}

const SHAPES: { value: Shape; label: string }[] = [
  { value: "uniform", label: "Uniform" },
  { value: "start", label: "Toward start" },
  { value: "end", label: "Toward end" },
];

const PRESETS = [1, 2, 5];

export function RangeInputs({
  base,
  quote,
  form,
  setForm,
  plan,
  refPrice,
  balance,
  sideHelp,
  children,
}: {
  base: AssetRef;
  quote: AssetRef;
  form: PoolForm;
  setForm: (f: PoolForm) => void;
  plan: PositionPlan;
  refPrice: number;
  /** spendable balance of the sold asset, formatted (undefined = not connected) */
  balance?: string;
  /** one line under the side selector */
  sideHelp?: ReactNode;
  /** rendered between the side selector and the amount (e.g. the two-way mode switch) */
  children?: ReactNode;
}) {
  const eff = poolEffective(form, refPrice);
  const sold = form.side === "Ask" ? base : quote;
  const set = (patch: Partial<PoolForm>) => setForm({ ...form, ...patch });
  // signed percentage vs the reference price, without "+-0.0" artefacts
  const pct = (v: number) => {
    const d = refPrice > 0 ? (v / refPrice - 1) * 100 : 0;
    return Math.abs(d) < 0.05 ? "0.0" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
  };
  const maxBar = Math.max(1, ...plan.bins.map((b) => Number(b.amount)));
  const lo = plan.bins[0];
  const hi = plan.bins[plan.bins.length - 1];

  return (
    <>
      <Segmented
        value={form.side}
        onChange={(side) => setForm({ ...form, side, start: null, end: null })}
        testId="pool-side"
        options={[
          { value: "Ask", label: `Ask: sell ${base.code}`, title: `Sell ${base.code} as the price rises` },
          { value: "Bid", label: `Bid: buy ${base.code}`, title: `Buy ${base.code} as the price falls` },
        ]}
      />
      {sideHelp ? <p className="px-1 text-[11px] leading-relaxed text-mutedfg">{sideHelp}</p> : null}
      {children}

      <AssetField
        label={form.side === "Ask" ? `Sell (${base.code})` : `Spend (${quote.code})`}
        testId="pool-amount"
        value={form.amount}
        onChange={(amount) => set({ amount })}
        asset={sold}
        balance={balance}
      />

      <div className="grid grid-cols-2 gap-2">
        <PriceField label="Start price" testId="pool-start" value={eff.start} sub={`${pct(Number(eff.start))}%`} quote={quote.code} onChange={(v) => set({ start: v })} />
        <PriceField label="End price" testId="pool-end" value={eff.end} sub={`${pct(Number(eff.end))}%`} quote={quote.code} onChange={(v) => set({ end: v })} />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => set({ end: fx(Number(eff.start) * (1 + ((form.side === "Ask" ? 1 : -1) * p) / 100)) })}
            className="rounded-lg border border-border py-1.5 text-[11px] font-medium tabular-nums text-mutedfg transition hover:border-primary/50 hover:text-white"
          >
            {form.side === "Ask" ? "+" : "-"}
            {p}%
          </button>
        ))}
        <button
          onClick={() => setForm({ ...form, start: null, end: null })}
          className="rounded-lg border border-border py-1.5 text-[11px] font-medium text-mutedfg transition hover:border-primary/50 hover:text-white"
        >
          Reset
        </button>
      </div>

      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="text-sm text-mutedfg">Weight shape</div>
        <Segmented value={form.shape} onChange={(shape) => set({ shape })} options={SHAPES} testId="pool-shape" size="sm" className="mt-1.5" />
        <div className="mt-3" data-testid="pool-preview">
          <svg viewBox="0 0 300 70" preserveAspectRatio="none" className="h-[70px] w-full" role="img" aria-label="Size per bin">
            <line x1="0" x2="300" y1="66" y2="66" stroke="rgba(255,255,255,0.12)" />
            {plan.bins.map((b, i) => {
              const w = 300 / plan.bins.length;
              const h = Math.max(2, (Number(b.amount) / maxBar) * 58);
              return <rect key={b.bin} x={i * w + w * 0.1} y={66 - h} width={w * 0.8} height={h} fill="rgba(243,177,206,0.75)" />;
            })}
          </svg>
          <div className="num flex justify-between text-[10px] text-mutedfg">
            <span>{lo ? fmt(Number(lo.price) / 1e7, 4, 4) : "-"}</span>
            <span>{plan.bins.length > 0 ? `${plan.bins.length} bins` : ""}</span>
            <span>{hi ? fmt(Number(hi.price) / 1e7, 4, 4) : "-"}</span>
          </div>
        </div>
      </div>
    </>
  );
}

export function PriceField({ label, value, sub, quote, onChange, testId }: { label: string; value: string; sub: string; quote: string; onChange: (v: string) => void; testId: string }) {
  return (
    <div className="rounded-2xl bg-secondary px-3.5 py-3">
      <div className="flex items-center justify-between text-xs text-mutedfg">
        <span>{label}</span>
        <span className="num whitespace-nowrap">{sub}<span className="hidden sm:inline"> vs ref</span></span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <input
          data-testid={testId}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
          className="w-full min-w-0 bg-transparent text-2xl font-medium tabular-nums outline-none"
        />
        <span className="shrink-0 text-xs text-mutedfg">{quote}</span>
      </div>
    </div>
  );
}

export function Row({ k, v, testId }: { k: string; v: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="shrink-0 text-mutedfg">{k}</span>
      <span className="num text-right" data-testid={testId}>
        {v}
      </span>
    </div>
  );
}
