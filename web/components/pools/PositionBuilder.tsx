"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccount } from "@/lib/account";
import { fromStroops } from "@/lib/amount";
import type { PoolInstance, Strategy } from "@/lib/config-types";
import { useTx } from "@/lib/hooks";
import type { PoolClient, PoolConfig } from "@/lib/pool";
import type { PositionPlan, Shape, Side } from "@/lib/poolGrid";
import { poolYield } from "@/lib/poolUi";
import { fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { AssetField, Segmented, Spinner, TxStatus } from "@/components/common";
import { TrustlineNotice, useAssetAccess } from "@/components/trade/access";

export type PoolForm = {
  side: Side;
  start: string | null;
  end: string | null;
  shape: Shape;
  amount: string;
};

export const initialPoolForm: PoolForm = { side: "Ask", start: null, end: null, shape: "uniform", amount: "" };

const fx = (n: number) => String(Number(n.toFixed(4)));

/** Default range around the pool's reference price: asks go up from it, bids go down from just under it. */
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

export function PositionBuilder({
  inst,
  client,
  cfg,
  strategies,
  form,
  setForm,
  plan,
  refPrice,
  network,
  onDone,
}: {
  inst: PoolInstance;
  client: PoolClient;
  cfg: PoolConfig | null;
  strategies: Strategy[];
  form: PoolForm;
  setForm: (f: PoolForm) => void;
  plan: PositionPlan;
  refPrice: number;
  network: string;
  onDone: () => void;
}) {
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Add position");
  const baseAccess = useAssetAccess(inst.base);
  const quoteAccess = useAssetAccess(inst.quote);
  const eff = poolEffective(form, refPrice);
  const sold = form.side === "Ask" ? inst.base : inst.quote;
  const soldAccess = form.side === "Ask" ? baseAccess : quoteAccess;
  const twoWay = inst.supportsTwoWay || cfg?.supportsTwoWay === true;
  const yieldInfo = poolYield(inst, strategies);
  const set = (patch: Partial<PoolForm>) => setForm({ ...form, ...patch });
  // signed percentage vs the reference price, without "+-0.0" artefacts
  const pct = (v: number) => {
    const d = refPrice > 0 ? (v / refPrice - 1) * 100 : 0;
    return Math.abs(d) < 0.05 ? "0.0" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
  };

  const need = plan.ok ? Number(fromStroops(plan.deposit)) : 0;
  const insufficient = plan.ok && soldAccess.available !== null && need > soldAccess.available + 1e-9;
  const blockedBy = !wallet.address
    ? "Connect a wallet"
    : baseAccess.state === "no-trustline" || baseAccess.state === "unauthorized"
      ? `${inst.base.code} trustline needed`
      : quoteAccess.state === "no-trustline" || quoteAccess.state === "unauthorized"
        ? `${inst.quote.code} trustline needed`
        : !(Number(form.amount) > 0)
          ? "Enter an amount"
          : !plan.ok
            ? plan.errors[0] ?? "Enter a range and an amount"
            : insufficient
            ? `Insufficient ${sold.code}`
            : null;

  const submit = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (!plan.ok) throw new Error(plan.errors[0] ?? "Invalid position");
      const r = await client.addPosition(
        { source: wallet.address, sign: wallet.sign, onStage },
        { side: form.side, mode: "Directional", loBin: plan.loBin, hiBin: plan.hiBin, amount: plan.deposit, weights: plan.weights },
      );
      set({ amount: "" });
      acct.refresh();
      onDone();
      return {
        hash: r.hash,
        result: r.result,
        note: `${form.side} position, ${plan.bins.length} bins (${plan.loBin}..${plan.hiBin}), ${fmt(fromStroops(plan.deposit), 2)} ${sold.code}${r.simulated ? " (simulated locally, no transaction)" : ""}`,
      };
    });

  const maxBar = Math.max(1, ...plan.bins.map((b) => Number(b.amount)));
  const lo = plan.bins[0];
  const hi = plan.bins[plan.bins.length - 1];

  return (
    <div className="space-y-2" data-testid="position-builder">
      <Segmented
        value={form.side}
        onChange={(side) => setForm({ ...form, side, start: null, end: null })}
        testId="pool-side"
        options={[
          { value: "Ask", label: `Ask: sell ${inst.base.code}`, title: `Sell ${inst.base.code} as the price rises` },
          { value: "Bid", label: `Bid: buy ${inst.base.code}`, title: `Buy ${inst.base.code} as the price falls` },
        ]}
      />
      <p className="px-1 text-[11px] leading-relaxed text-mutedfg">
        {form.side === "Ask"
          ? `Your ${inst.base.code} is sold bin by bin as the price rises through the range. Proceeds arrive in ${inst.quote.code}.`
          : `Your ${inst.quote.code} buys ${inst.base.code} bin by bin as the price falls through the range. Proceeds arrive in ${inst.base.code}.`}
      </p>

      {/* mode: directional (default) vs two-way LP */}
      <div className="flex items-center gap-2" data-testid="pool-mode">
        <Segmented
          value="Directional"
          onChange={() => {}}
          size="sm"
          options={[{ value: "Directional", label: "Directional", title: "Inventory only goes down, proceeds only go up" }]}
          className="flex-1"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex-1" data-testid="pool-mode-twoway" data-enabled={twoWay ? "1" : "0"}>
              <button
                type="button"
                disabled={!twoWay}
                className={cn("w-full rounded-full border border-border px-3 py-1 text-[11px] font-medium", twoWay ? "text-mutedfg hover:text-white" : "cursor-not-allowed text-mutedfg/50")}
              >
                Two-way LP
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[16rem] text-[11px] leading-relaxed">
            {twoWay
              ? "Crossback positions: filled inventory can trade back."
              : "Not available on this pool: supports_two_way is false. Directional positions never trade back; two-way (crossback) positions are a stretch goal."}
          </TooltipContent>
        </Tooltip>
      </div>

      <AssetField
        label={form.side === "Ask" ? `Sell (${inst.base.code})` : `Spend (${inst.quote.code})`}
        testId="pool-amount"
        value={form.amount}
        onChange={(amount) => set({ amount })}
        asset={sold}
        balance={soldAccess.available !== null ? fmt(soldAccess.available, 2) : wallet.address ? "-" : undefined}
      />

      <div className="grid grid-cols-2 gap-2">
        <PriceField label="Start price" testId="pool-start" value={eff.start} sub={`${pct(Number(eff.start))}%`} quote={inst.quote.code} onChange={(v) => set({ start: v })} />
        <PriceField label="End price" testId="pool-end" value={eff.end} sub={`${pct(Number(eff.end))}%`} quote={inst.quote.code} onChange={(v) => set({ end: v })} />
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

      <div className="rounded-xl border border-border px-3 py-2.5 text-xs" data-testid="pool-summary">
        <div className="flex items-center justify-between pb-1">
          <span className="label">Summary</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="About the pool grid" className="text-mutedfg hover:text-foreground">
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[17rem] text-[11px] leading-relaxed">
              Prices sit on the contract&apos;s grid: price_at(bin) = 1e7 x (1 + {inst.binStepBps} bps) ^ bin, bins -200 to 200. Your start and end prices snap to the nearest bins.
            </TooltipContent>
          </Tooltip>
        </div>
        <Row k="Average price" v={plan.ok && plan.avgPrice !== null ? `${fmt(Number(plan.avgPrice) / 1e7, 4, 4)} ${inst.quote.code}` : "-"} />
        <Row k="Bins" v={plan.ok ? `${plan.bins.length} (${plan.loBin} to ${plan.hiBin})` : "-"} testId="pool-bins" />
        <Row k="Price range" v={plan.ok && lo && hi ? `${fmt(Number(lo.price) / 1e7, 4, 4)} to ${fmt(Number(hi.price) / 1e7, 4, 4)}` : "-"} />
        <Row k="Fee tier" v={`${fmt(inst.feeBps / 100, 2)}% of the ${inst.quote.code} leg of each fill`} />
        <Row
          k="If fully filled you receive"
          v={plan.ok ? `${fmt(fromStroops(plan.proceedsIfFilled), 2)} ${form.side === "Ask" ? inst.quote.code : inst.base.code} (before fees)` : "-"}
        />
        <Row k="Your funds" v={form.side === "Ask" ? `${inst.base.code} stays in the pool until filled` : `${inst.quote.code} stays in the pool until filled`} />
      </div>
      <p className="px-1 text-[11px] leading-relaxed text-mutedfg">
        Directional: inventory only goes down and proceeds only go up. A filled bin never flips back (unlike an AMM position). {form.side === "Bid" ? yieldInfo.detail : `Proceeds are ${inst.quote.code}: ${yieldInfo.detail}`}
      </p>

      <TrustlineNotice asset={inst.base} access={baseAccess} verb={form.side === "Ask" ? "deposit" : "receive"} showOk />
      <TrustlineNotice asset={inst.quote} access={quoteAccess} verb="hold" />
      <Button className="h-12 w-full text-base" onClick={submit} disabled={tx.running || blockedBy !== null} data-testid="pool-submit">
        {tx.running ? <Spinner className="size-5" /> : blockedBy ?? "Add position"}
      </Button>
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
    </div>
  );
}

function PriceField({ label, value, sub, quote, onChange, testId }: { label: string; value: string; sub: string; quote: string; onChange: (v: string) => void; testId: string }) {
  return (
    <div className="rounded-2xl bg-secondary px-3.5 py-3">
      <div className="flex items-center justify-between text-xs text-mutedfg">
        <span>{label}</span>
        <span className="num whitespace-nowrap">{sub}<span className="hidden sm:inline"> vs mid</span></span>
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

function Row({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="shrink-0 text-mutedfg">{k}</span>
      <span className="num text-right" data-testid={testId}>
        {v}
      </span>
    </div>
  );
}

