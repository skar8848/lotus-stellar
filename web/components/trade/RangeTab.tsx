"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { fromStroops } from "@/lib/amount";
import { bestPrices } from "@/lib/book";
import { useTx } from "@/lib/hooks";
import type { Market } from "@/lib/markets";
import {
  MAX_LEVELS,
  MIN_LEVELS,
  crossingCount,
  offerPrice,
  type RangeLevel,
  type RangeMode,
  type RangeResult,
  type Shape,
} from "@/lib/range";
import { MAX_OPS_PER_TX, fmt, manageSellOfferOp, submitClassicChunked, type OrderBook } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { Segmented, Spinner, TxStatus } from "@/components/common";
import { TrustlineNotice, useAssetAccess } from "./access";
import { effective, type RangeForm } from "./rangeState";

const MODES: { value: RangeMode; label: string; title: string }[] = [
  { value: "sell", label: "One-way sell", title: "Asks only: sell the base across the range (exit)" },
  { value: "buy", label: "One-way buy", title: "Bids only: buy the base across the range (accumulate)" },
  { value: "band", label: "Two-sided band", title: "Bids below the split price, asks above (market making)" },
];

const SHAPES: { value: Shape; label: string }[] = [
  { value: "uniform", label: "Uniform" },
  { value: "start", label: "To start" },
  { value: "end", label: "To end" },
];

const PRESETS = [5, 10, 25];

/** The pro-mode range builder: many levels, one transaction, one signature. */
export function RangeTab({
  market,
  book,
  form,
  setForm,
  result,
  refPrice,
  onDone,
}: {
  market: Market;
  book: OrderBook | null;
  form: RangeForm;
  setForm: (f: RangeForm) => void;
  result: RangeResult;
  refPrice: number;
  onDone: () => void;
}) {
  const { network } = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Range");

  const e = effective(form, refPrice);
  const { levels, summary, errors } = result;
  const baseAccess = useAssetAccess(market.base);
  const quoteAccess = useAssetAccess(market.quote);
  const xlmAccess = useAssetAccess({ code: "XLM", issuer: null });
  const { bid, ask } = bestPrices(book);
  const crossing = crossingCount(levels, bid, ask);
  const fromN = Number(e.from);
  const toN = Number(e.to);

  const set = (patch: Partial<RangeForm>) => setForm({ ...form, ...patch });
  const setMode = (mode: RangeMode) => setForm({ ...form, mode, from: null, to: null, split: null });
  // signed percentage vs the reference price, without "+-0.0" artefacts
  const pct = (v: number) => {
    const d = refPrice > 0 ? (v / refPrice - 1) * 100 : 0;
    return Math.abs(d) < 0.05 ? "0.0" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
  };

  const needBase = Number(fromStroops(summary.needBase));
  const needQuote = Number(fromStroops(summary.needQuote));
  const needTrustline = baseAccess.state === "no-trustline" || quoteAccess.state === "no-trustline";
  const reserveNeeded = summary.reserveXlm;
  const xlmFree = xlmAccess.available;

  const problems: string[] = [];
  if (wallet.address && baseAccess.state === "ok" && quoteAccess.state === "ok") {
    if (needBase > 0 && baseAccess.available !== null && needBase > baseAccess.available + 1e-9)
      problems.push(`Needs ${fmt(needBase, 2)} free ${market.base.code}, you have ${fmt(baseAccess.available, 2)}.`);
    if (needQuote > 0 && quoteAccess.available !== null && needQuote > quoteAccess.available + 1e-9)
      problems.push(`Needs ${fmt(needQuote, 2)} free ${market.quote.code}, you have ${fmt(quoteAccess.available, 2)}.`);
    if (xlmFree !== null && reserveNeeded > xlmFree + 1e-9)
      problems.push(`Needs ${fmt(reserveNeeded, 1)} XLM of base reserve (0.5 per offer), ${fmt(xlmFree, 2)} XLM free.`);
  }

  const blockedBy = !wallet.address
    ? "Connect a wallet"
    : needTrustline
      ? "Add the missing trustline"
      : baseAccess.state === "unauthorized"
        ? `${market.base.code}: issuer authorization required`
        : quoteAccess.state === "unauthorized"
          ? `${market.quote.code}: issuer authorization required`
          : errors.length > 0
            ? errors[0]
            : problems.length > 0
              ? "Not enough balance"
              : null;

  const place = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (errors.length > 0 || levels.length === 0) throw new Error(errors[0] ?? "Nothing to place");
      const ops = levels.map((l: RangeLevel) => {
        const r = offerPrice(l);
        // exact reduced rational when it fits int32, else a decimal string (the SDK approximates)
        const price = r ?? (l.side === "ask" ? l.price : String(1 / Number(l.price)));
        return l.side === "ask"
          ? manageSellOfferOp({ selling: market.base, buying: market.quote, amount: fromStroops(l.sellAmount), price })
          : manageSellOfferOp({ selling: market.quote, buying: market.base, amount: fromStroops(l.sellAmount), price });
      });
      const r = await submitClassicChunked(net, { source: wallet.address, ops, sign: wallet.sign, onStage });
      acct.refresh();
      onDone();
      return {
        hash: r.hashes[0],
        hashes: r.hashes,
        note: `${levels.length} offers (${summary.asks} asks, ${summary.bids} bids) in ${r.hashes.length} transaction${r.hashes.length === 1 ? "" : "s"}`,
      };
    });

  const maxBase = useMemo(() => Math.max(1, ...levels.map((l) => Number(l.baseAmount))), [levels]);
  const receiptInOffers = summary.bids > 0 && market.quote.code === market.receipt.code;
  const receiptProceeds = summary.asks > 0 && market.quote.code === market.receipt.code;
  const dir = form.mode === "buy" ? -1 : 1;

  return (
    <div className="space-y-2" data-testid="range-tab">
      <Link
        href="/pools"
        data-testid="range-new-order-link"
        className="block rounded-xl border border-primary/40 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed text-primary transition hover:bg-primary/10"
      >
        Directional range order on the pool grid, waiting in the Lotus pool or on the SDEX, with or without yield: use{" "}
        <span className="font-medium underline underline-offset-2">New order on Pools</span>. This tab is the free-form SDEX ladder (any levels, two-sided bands).
      </Link>
      <Segmented value={form.mode} onChange={setMode} options={MODES} testId="range-mode" size="sm" />
      <p className="px-1 text-[11px] leading-relaxed text-mutedfg">
        {form.mode === "sell" &&
          `Exit: ${market.base.code} is offered for ${market.quote.code} at every level of the range. Each level that fills is gone for good.`}
        {form.mode === "buy" &&
          `Accumulate: a bid for ${market.base.code} at every level, paid in ${market.quote.code}. Each level that fills is gone for good.`}
        {form.mode === "band" &&
          `Market making: bids below the split price, asks above it. A filled level never flips back automatically (unlike an AMM position): re-quote to continue.`}
      </p>

      {/* total size */}
      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="flex items-center justify-between text-sm text-mutedfg">
          <span>Total size ({market.base.code})</span>
          <span className="num text-[11px]">{summary.avgPrice !== null ? `${fmt(summary.avgPrice * Number(fromStroops(summary.totalBase)), 2)} ${market.quote.code} notional` : ""}</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <input
            data-testid="range-total"
            inputMode="decimal"
            value={form.total}
            placeholder="0"
            onChange={(ev) => set({ total: ev.target.value.replace(/[^0-9.]/g, "") })}
            className="w-full min-w-0 bg-transparent text-3xl font-medium tabular-nums outline-none placeholder:text-mutedfg/50 sm:text-4xl"
          />
          <span className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-accent px-3.5 text-base font-medium">{market.base.code}</span>
        </div>
      </div>

      {/* range: start -> end */}
      <div className="grid grid-cols-2 gap-2">
        <PriceField label="Start price" testId="range-from" value={e.from} sub={`${pct(fromN)}% vs mid`} quote={market.quote.code} onChange={(v) => set({ from: v })} />
        <PriceField label="End price" testId="range-to" value={e.to} sub={`${pct(toN)}% vs mid`} quote={market.quote.code} onChange={(v) => set({ to: v })} />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            disabled={!(fromN > 0)}
            onClick={() => set({ to: String(Number((fromN * (1 + (dir * p) / 100)).toFixed(4))) })}
            className="rounded-lg border border-border py-1.5 text-[11px] font-medium tabular-nums text-mutedfg transition hover:border-primary/50 hover:text-white disabled:opacity-40"
          >
            {dir > 0 ? "+" : "-"}
            {p}%
          </button>
        ))}
        <button
          onClick={() => setForm({ ...form, from: null, to: null, split: null })}
          className="rounded-lg border border-border py-1.5 text-[11px] font-medium text-mutedfg transition hover:border-primary/50 hover:text-white"
          title="Reset the range around the market"
        >
          Reset
        </button>
      </div>
      {form.mode === "band" ? (
        <PriceField label="Split price (bids below, asks above)" testId="range-split" value={e.split} sub={`${pct(Number(e.split))}% vs mid`} quote={market.quote.code} onChange={(v) => set({ split: v })} />
      ) : null}

      {/* levels + shape */}
      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="flex items-center justify-between text-sm text-mutedfg">
          <span>Levels</span>
          <input
            data-testid="range-levels"
            inputMode="numeric"
            value={form.levels}
            onChange={(ev) => {
              const n = Number(ev.target.value.replace(/\D/g, ""));
              set({ levels: Math.max(0, Math.min(MAX_LEVELS, n)) });
            }}
            className="num w-12 rounded-md bg-accent px-2 py-0.5 text-right text-sm text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
        <Slider className="mt-3" min={MIN_LEVELS} max={MAX_LEVELS} step={1} value={[Math.max(MIN_LEVELS, form.levels)]} onValueChange={(v) => set({ levels: v[0] })} aria-label="Levels" />
        <div className="mt-1 flex justify-between text-[10px] text-mutedfg">
          <span>{MIN_LEVELS}</span>
          <span>{MAX_LEVELS}</span>
        </div>
        <div className="mt-3 flex items-center justify-between text-sm text-mutedfg">
          <span>Size distribution</span>
        </div>
        <Segmented value={form.shape} onChange={(shape) => set({ shape })} options={SHAPES} testId="range-shape" size="sm" className="mt-1.5" />
        {/* live preview of the levels */}
        <div className="mt-3" data-testid="range-preview">
          <svg viewBox="0 0 300 70" preserveAspectRatio="none" className="h-[70px] w-full" role="img" aria-label="Size per level">
            <line x1="0" x2="300" y1="66" y2="66" stroke="rgba(255,255,255,0.12)" />
            {levels.map((l, i) => {
              const n = levels.length;
              const w = 300 / n;
              const h = Math.max(2, (Number(l.baseAmount) / maxBase) * 58);
              return <rect key={l.index} x={i * w + w * 0.12} y={66 - h} width={w * 0.76} height={h} rx={1.5} fill={l.side === "ask" ? "rgba(235,54,90,0.7)" : "rgba(2,199,123,0.7)"} />;
            })}
          </svg>
          <div className="num flex justify-between text-[10px] text-mutedfg">
            <span>{levels[0] ? fmt(levels[0].price, 4, 4) : "-"}</span>
            <span>{levels.length > 0 ? `${levels.length} levels` : ""}</span>
            <span>{levels[levels.length - 1] ? fmt(levels[levels.length - 1].price, 4, 4) : "-"}</span>
          </div>
        </div>
      </div>

      {/* summary */}
      <div className="rounded-xl border border-border px-3 py-2.5 text-xs" data-testid="range-summary">
        <div className="flex items-center justify-between pb-1">
          <span className="label">Summary</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="About the summary" className="text-mutedfg hover:text-foreground">
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[16rem] text-[11px] leading-relaxed">
              Each offer is a manageSellOffer. It only sets a selling liability, so the funds stay on your account until a taker fills the level.
            </TooltipContent>
          </Tooltip>
        </div>
        <Row k="Average price" v={summary.avgPrice !== null ? `${fmt(summary.avgPrice, 4, 4)} ${market.quote.code}` : "-"} />
        <Row k="Total size" v={`${fmt(fromStroops(summary.totalBase), 2)} ${market.base.code}`} />
        <Row k="Offers" v={`${summary.offers}${summary.offers > 0 ? ` (${summary.asks} asks, ${summary.bids} bids)` : ""}`} testId="range-offers" />
        {needBase > 0 ? <Row k="You sell" v={`${fmt(needBase, 2)} ${market.base.code}`} /> : null}
        {needQuote > 0 ? <Row k="You sell" v={`${fmt(needQuote, 2)} ${market.quote.code}`} /> : null}
        <Row k="XLM base reserve" v={`${fmt(summary.reserveXlm, 1)} XLM (0.5 per offer)`} />
        <Row
          k="Transactions"
          v={`${Math.max(1, summary.txCount)} (${summary.txCount > 1 ? "one signature each" : "one signature"})`}
        />
      </div>
      <p className="px-1 text-[11px] leading-relaxed text-mutedfg">
        Stellar allows at most {MAX_OPS_PER_TX} operations per transaction; this range uses {summary.offers}, so it goes in {Math.max(1, summary.txCount)} transaction{summary.txCount > 1 ? "s" : ""}.
        Your funds stay on your account (selling liabilities) until a level fills.
      </p>
      {receiptInOffers ? (
        <p className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-primary" data-testid="range-yield-note">
          Your {market.receipt.code} in these offers keeps earning yield: a resting offer never moves it out of your account, so the keeper&apos;s distribution still reaches it.
        </p>
      ) : receiptProceeds ? (
        <p className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] text-primary" data-testid="range-yield-note">
          Proceeds arrive as {market.receipt.code} and start earning as soon as they land.
        </p>
      ) : null}
      {crossing > 0 ? (
        <p className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2 text-[11px] text-primary" data-testid="range-crosses">
          {crossing} level{crossing === 1 ? "" : "s"} cross the book and would fill immediately (you act as taker). Move the range if you want to rest at these prices.
        </p>
      ) : null}
      {problems.map((p) => (
        <p key={p} className="px-1 text-[11px] text-destructive">
          {p}
        </p>
      ))}
      {errors.length > 0 && wallet.address ? <p className="px-1 text-[11px] text-destructive">{errors[0]}</p> : null}

      <TrustlineNotice asset={market.base} access={baseAccess} verb={form.mode === "sell" ? "sell" : "receive"} showOk />
      <TrustlineNotice asset={market.quote} access={quoteAccess} verb="hold" />

      <Button className={cn("h-12 w-full text-base")} onClick={place} disabled={tx.running || blockedBy !== null} data-testid="range-submit">
        {tx.running ? <Spinner className="size-5" /> : blockedBy ?? `Place ${summary.offers} offers in ${Math.max(1, summary.txCount)} tx`}
      </Button>
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
    </div>
  );
}

function PriceField({ label, value, sub, quote, onChange, testId }: { label: string; value: string; sub: string; quote: string; onChange: (v: string) => void; testId: string }) {
  return (
    <div className="rounded-2xl bg-secondary px-3.5 py-3">
      <div className="flex items-center justify-between text-xs text-mutedfg">
        <span className="truncate">{label}</span>
        <span className="num shrink-0 pl-2">{sub}</span>
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
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-mutedfg">{k}</span>
      <span className="num text-right" data-testid={testId}>
        {v}
      </span>
    </div>
  );
}

