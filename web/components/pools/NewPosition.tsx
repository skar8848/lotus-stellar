"use client";

// /pools: ONE "New position" flow, Uniswap-v3/v4 style, ported from the lotus-main New Position wizard
// (owl git a938fc3 "Uniswap-v4 New Position wizard", web/app/pro1/page.tsx at c00c39c^): breadcrumb + title + Reset,
// a stepper card on the left, the step card on the right, the draggable range chart over live depth, range presets,
// min / max price fields with +/- steppers, the deposit field, then a review modal. No EVM code: everything below
// talks to the Lotus pool (Soroban) and the SDEX through lib/orderRoute.ts + lib/orderTx.ts.
//
//   Step 1  pair (LBOND / USDC) and side: sell LBOND (Ask) or buy LBOND with USDC (Bid). Directional only.
//   Step 2  range on the chart (handles snap to the pool grid) + amount + weight shape.
//   Step 3  choose your strategy: Lotus pool / + Blend yield / Stellar DEX / + Blend yield (the 2x2 of orderRoute).
//   Review  summary line, details, sign.

import { useCallback, useMemo, useState } from "react";
import { ArrowLeftRight, ChevronRight, Info, Minus, Pencil, Plus, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Segmented, TokenIcon } from "@/components/common";
import { useConfig, useNet } from "@/lib/config-context";
import type { PoolInstance } from "@/lib/config-types";
import { usePolling } from "@/lib/hooks";
import { bestPrices } from "@/lib/book";
import { PROXIMITY_MIN_BINS, binsBelowReference, conservativeReference, directionBounds, rangeForYield, referenceFor, type BookTop } from "@/lib/orderRoute";
import { getPoolClient } from "@/lib/pool";
import { MAX_BIN, MAX_POSITION_BINS, MIN_BIN, binForPrice, planPosition, priceAt, type Shape, type Side } from "@/lib/poolGrid";
import { assetReady, fetchCandles, fetchOrderBook, fmt, type AssetRef } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { LiquidityRangeChart, type DepthBin } from "./LiquidityRangeChart";
import { ReviewDialog } from "./ReviewDialog";
import { StrategyCards } from "./StrategyCards";
import type { LiveApr } from "./useBlendApr";
import { STRATEGIES, crossText, directionalPools, useOrderDestinations, type StrategyId } from "./useOrder";

const TIMEFRAMES = [
  { label: "1H", res: 60_000, limit: 60 },
  { label: "1D", res: 900_000, limit: 96 },
  { label: "1W", res: 3_600_000, limit: 168 },
  { label: "1M", res: 86_400_000, limit: 30 },
];

const SHAPES: { value: Shape; label: string; title: string }[] = [
  { value: "uniform", label: "Even", title: "Same size in every bin" },
  { value: "start", label: "Front", title: "Heavier near the start of the range (nearest the price)" },
  { value: "end", label: "Back", title: "Heavier toward the end of the range" },
];

/**
 * Range presets, as % from the reference price (lotus-main "Strategies" grid; renamed: strategy is step 3 here).
 * The reference is the chosen strategy's own book (lib/orderRoute.ts referenceFor); before a strategy is chosen,
 * the most conservative of the four, so a preset crosses no venue (step 3 re-checks crossing per strategy anyway).
 */
const PRESETS: Record<Side, { name: string; sub: string; lo: number; hi: number; hint: string }[]> = {
  Ask: [
    { name: "Just above", sub: "+0.1% → +1%", lo: 0.1, hi: 1, hint: "First fills soon" },
    { name: "Sell the rip", sub: "+1% → +3%", lo: 1, hi: 3, hint: "Sell into strength" },
    { name: "Ladder", sub: "+0.5% → +2.5%", lo: 0.5, hi: 2.5, hint: "Even steps up" },
    { name: "Wide", sub: "+0.1% → +6%", lo: 0.1, hi: 6, hint: "Up to 60 bins" },
  ],
  Bid: [
    { name: "Just below", sub: "-1% → -0.1%", lo: -1, hi: -0.1, hint: "Pool yield needs 1% under the pool price" },
    { name: "Buy the dip", sub: "-3% → -1.1%", lo: -3, hi: -1.1, hint: "Every strategy open" },
    { name: "Ladder", sub: "-3.5% → -1.5%", lo: -3.5, hi: -1.5, hint: "Even steps down" },
    { name: "Wide", sub: "-6% → -1.1%", lo: -6, hi: -1.1, hint: "Up to 50 bins" },
  ],
};

type Range = { lo: number; hi: number };

const snap = (p: number, step: number) => Number(priceAt(binForPrice(p, step), step)) / 1e7;
const fixed = (n: number) => n.toFixed(7);

function defaultRange(side: Side, ref: number, step: number): Range {
  const r = ref > 0 ? ref : 1;
  // Ask: from just above the price; Bid: top 11 bins under it, so the Blend-yield pool strategy stays open
  return side === "Ask" ? { lo: snap(r * 1.001, step), hi: snap(r * 1.02, step) } : { lo: snap(r * 0.969, step), hi: snap(r * 0.989, step) };
}

export function NewPosition({
  apr,
  onCreated,
  twoWayInst,
  onAdvanced,
}: {
  /** live Blend APR of the yield strategy (read once by the page, shared with Your positions) */
  apr: LiveApr;
  onCreated: () => void;
  onOpenSwap: () => void;
  twoWayInst: PoolInstance | null;
  onAdvanced: () => void;
}) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const pools = config.pools;
  const { idle, vaulted } = useMemo(() => directionalPools(pools), [pools]);
  const main = (idle ?? vaulted ?? pools[0]) as PoolInstance;
  const step = main.binStepBps;
  const base: AssetRef = main.base;
  const quote: AssetRef = main.quote;
  const receipt: AssetRef = config.receipt;

  const [wizard, setWizard] = useState<1 | 2 | 3>(1);
  const [side, setSide] = useState<Side>("Ask");
  const [range, setRange] = useState<Range | null>(null);
  const [amount, setAmount] = useState("");
  const [shape, setShape] = useState<Shape>("uniform");
  const [tf, setTf] = useState(1);
  const [choice, setChoice] = useState<StrategyId | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [clampNote, setClampNote] = useState<string | null>(null);

  // ---- live data: pool depth (every live instance), SDEX books, candles -------------------------------------------
  const depthPools = useMemo(() => pools.filter((p) => p.status !== "retired" && p.status !== "coming-soon"), [pools]);
  const depthFn = useCallback(async () => {
    const per = await Promise.all(
      depthPools.map(async (inst) => {
        const c = getPoolClient(net, inst);
        const [asks, bids] = await Promise.all([c.depth("Ask", MIN_BIN, MAX_BIN).catch(() => []), c.depth("Bid", MIN_BIN, MAX_BIN).catch(() => [])]);
        return { inst, asks, bids };
      }),
    );
    return per;
  }, [net, depthPools]);
  const depthQ = usePolling(depthFn, 10000, true);

  const booksFn = useCallback(async () => {
    const ok = assetReady(base) && !!base.issuer;
    const [rb, ub] = await Promise.all([
      ok && assetReady(receipt) ? fetchOrderBook(config.horizon, base, receipt, 50).catch(() => null) : Promise.resolve(null),
      ok && assetReady(quote) ? fetchOrderBook(config.horizon, base, quote, 50).catch(() => null) : Promise.resolve(null),
    ]);
    return { receipt: rb, usdc: ub };
  }, [config.horizon, base, quote, receipt]);
  const booksQ = usePolling(booksFn, 10000, true);

  const t = TIMEFRAMES[tf];
  const candlesFn = useCallback(async () => {
    const usdc = await fetchCandles(config.horizon, base, quote, t.res, t.limit).catch(() => []);
    if (usdc.length > 1) return { closes: usdc.map((c) => c.close), market: `${base.code}/${quote.code}` };
    const r = assetReady(receipt) ? await fetchCandles(config.horizon, base, receipt, t.res, t.limit).catch(() => []) : [];
    return { closes: r.map((c) => c.close), market: `${base.code}/${receipt.code}` };
  }, [config.horizon, base, quote, receipt, t.res, t.limit]);
  const candlesQ = usePolling(candlesFn, 30000, true);

  // best bid / ask of every book a strategy can target: each pool instance's own bins, SDEX USDC and receipt books
  const market = useMemo(() => {
    const poolTop = (inst: PoolInstance | null): BookTop => {
      const d = inst ? depthQ.data?.find((x) => x.inst.id === inst.id) : undefined;
      return {
        ask: d?.asks[0] ? Number(d.asks[0].price) / 1e7 : null,
        bid: d?.bids.length ? Number(d.bids[d.bids.length - 1].price) / 1e7 : null,
      };
    };
    return {
      usdc: bestPrices(booksQ.data?.usdc ?? null),
      receipt: bestPrices(booksQ.data?.receipt ?? null),
      pool: { idle: poolTop(idle), vaulted: poolTop(vaulted) },
    };
  }, [depthQ.data, booksQ.data, idle, vaulted]);
  // reference price per strategy (its own book), and the one the range step uses: the chosen strategy's, or before a
  // strategy is chosen the most conservative one, so presets cross no venue (lib/orderRoute.ts referenceFor)
  const refs = useMemo(() => {
    const out = {} as Record<StrategyId, { price: number; source: string }>;
    for (const st of STRATEGIES) {
      const pool = st.yieldOn ? market.pool.vaulted : market.pool.idle;
      out[st.id] = referenceFor(st.venue, st.yieldOn, { usdc: market.usdc, receipt: market.receipt, pool });
    }
    return out;
  }, [market]);
  const ref = choice ? refs[choice] : conservativeReference(side, STRATEGIES.map((st) => refs[st.id]));
  const refLabel = choice ? `${ref.source}, the book of your strategy` : `${ref.source}, ${side === "Ask" ? "highest" : "lowest"} across strategies`;
  const refPrice = ref.price;

  const eff: Range = range ?? defaultRange(side, refPrice, step);
  const plan = useMemo(
    () =>
      planPosition({
        side,
        startPrice: fixed(side === "Ask" ? eff.lo : eff.hi),
        endPrice: fixed(side === "Ask" ? eff.hi : eff.lo),
        shape,
        // a placeholder size keeps the preview alive before the user types an amount
        amount: Number(amount) > 0 ? amount : "1",
        stepBps: step,
        feeBps: main.feeBps,
      }),
    [side, eff.lo, eff.hi, shape, amount, step, main.feeBps],
  );
  const amountTyped = Number(amount) > 0;

  const { env, destinations } = useOrderDestinations(pools, {
    side,
    plan,
    amountTyped,
    stepBps: step,
    market,
    connected: !!wallet.address,
  });

  // ---- depth histogram: pool bins + SDEX levels, both on the pool grid, in BASE-equivalent -------------------------
  const depthBins: DepthBin[] = useMemo(() => {
    const m = new Map<number, DepthBin>();
    const at = (bin: number) => {
      let d = m.get(bin);
      if (!d) {
        d = { bin, price: Number(priceAt(bin, step)) / 1e7, pool: 0, sdex: 0 };
        m.set(bin, d);
      }
      return d;
    };
    for (const { asks, bids } of depthQ.data ?? []) {
      for (const b of asks) at(b.bin).pool += Number(b.inventory) / 1e7;
      for (const b of bids) {
        const p = Number(b.price) / 1e7;
        if (p > 0) at(b.bin).pool += Number(b.inventory) / 1e7 / p;
      }
    }
    for (const book of [booksQ.data?.usdc, booksQ.data?.receipt]) {
      if (!book) continue;
      for (const l of book.asks) at(binForPrice(Number(l.price), step)).sdex += Number(l.amount);
      for (const l of book.bids) {
        const p = Number(l.price);
        if (p > 0) at(binForPrice(p, step)).sdex += Number(l.amount) / p;
      }
    }
    if (plan.ok && amountTyped) for (const b of plan.bins) at(b.bin).mine = Number(b.baseSize) / 1e7;
    return [...m.values()].sort((a, b) => a.price - b.price);
  }, [depthQ.data, booksQ.data, plan, amountTyped, step]);
  const inRangeShare = useMemo(() => {
    const total = depthBins.reduce((s, d) => s + d.pool + d.sdex, 0);
    if (total <= 0) return null;
    const inside = depthBins.filter((d) => d.price >= eff.lo && d.price <= eff.hi).reduce((s, d) => s + d.pool + d.sdex, 0);
    return Math.round((inside / total) * 100);
  }, [depthBins, eff.lo, eff.hi]);

  // ---- actions ----------------------------------------------------------------------------------------------------
  // direction rule (lib/orderRoute.ts directionBounds): a sell range sits at or above the price, a buy range at or
  // below it; handles, fields, steppers and presets are clamped to that bound, with a short note
  const setLoHi = (lo: number, hi: number) => {
    let a = binForPrice(Math.max(1e-7, Math.min(lo, hi)), step);
    let b = binForPrice(Math.max(1e-7, Math.max(lo, hi)), step);
    const { minBin, maxBin } = directionBounds(side, step, refPrice);
    let clamped = false;
    if (side === "Ask" && a < minBin) {
      a = minBin;
      b = Math.max(b, minBin);
      clamped = true;
    }
    if (side === "Bid" && b > maxBin) {
      b = maxBin;
      a = Math.min(a, maxBin);
      clamped = true;
    }
    setClampNote(clamped ? (side === "Ask" ? "A sell range starts at or above the current price" : "A buy range ends at or below the current price") : null);
    setRange({ lo: Number(priceAt(a, step)) / 1e7, hi: Number(priceAt(b, step)) / 1e7 });
  };
  const stepBin = (which: "lo" | "hi", dir: 1 | -1) => {
    const v = which === "lo" ? eff.lo : eff.hi;
    const next = Number(priceAt(Math.max(MIN_BIN, Math.min(MAX_BIN, binForPrice(v, step) + dir)), step)) / 1e7;
    if (which === "lo") setLoHi(Math.min(next, eff.hi), eff.hi);
    else setLoHi(eff.lo, Math.max(next, eff.lo));
  };
  const preset = (p: (typeof PRESETS)[Side][number]) => setLoHi(refPrice * (1 + p.lo / 100), refPrice * (1 + p.hi / 100));
  // "Change range" of the curator rule: top bin = pool + yield reference bin - PROXIMITY_MIN_BINS, same width
  const rangeToYield = () => {
    const r = rangeForYield(binForPrice(eff.lo, step), binForPrice(eff.hi, step), step, refs["pool-yield"].price);
    setClampNote(null);
    setRange({ lo: Number(priceAt(r.loBin, step)) / 1e7, hi: Number(priceAt(r.hiBin, step)) / 1e7 });
  };
  const resetAll = () => {
    setClampNote(null);
    setWizard(1);
    setRange(null);
    setAmount("");
    setShape("uniform");
    setChoice(null);
  };
  const chooseSide = (s: Side) => {
    if (s !== side) {
      setSide(s);
      setRange(null);
      setClampNote(null);
      setAmount("");
      setChoice(null);
    }
  };

  const chosen = destinations.find((d) => d.id === choice) ?? null;
  const sold = side === "Ask" ? base : quote;
  const soldAvail = side === "Ask" ? env.access.base.available : env.access.quote.available;
  const binsCount = plan.ok ? plan.bins.length : Math.abs(binForPrice(eff.hi, step) - binForPrice(eff.lo, step)) + 1;
  const rangeOk = plan.ok;
  const pct = (v: number) => (refPrice > 0 ? ((v / refPrice - 1) * 100).toFixed(2) : "0.00");
  const aprText = apr.aprPct !== null ? `${apr.aprPct.toFixed(2)}% APR` : apr.observedPct !== null ? `${apr.observedPct.toFixed(2)}% APR` : null;

  const stepsList = [
    { n: 1 as const, t: "Select pair and side" },
    { n: 2 as const, t: "Set price range and deposit" },
    { n: 3 as const, t: "Choose your strategy" },
  ];
  const canReach = (n: 1 | 2 | 3) => n <= wizard || (n === 2 && wizard >= 1) || (n === 3 && rangeOk && amountTyped);

  return (
    <div data-testid="new-position" data-step={wizard} data-side={side}>
      <div className="text-xs text-mutedfg">
        <a href="#your-positions" className="hover:text-white">
          Your positions
        </a>{" "}
        <ChevronRight className="inline size-3" /> New position
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">New position</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={resetAll} data-testid="np-reset">
            <RotateCcw className="size-3.5" /> <span className="hidden sm:inline">Reset</span>
          </Button>
          <Button asChild variant="outline" size="sm" className="gap-1.5" data-testid="np-open-swap">
            <a href="/swap">
              <ArrowLeftRight className="size-3.5" /> Swap on the pool
            </a>
          </Button>
          {twoWayInst ? (
            <Button variant="ghost" size="sm" className="text-mutedfg hover:text-white" onClick={onAdvanced} data-testid="twoway-link">
              Advanced: two-way position
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* stepper */}
        <ol className="card flex h-fit gap-2 p-3 lg:sticky lg:top-20 lg:flex-col lg:gap-1" data-testid="np-stepper">
          {stepsList.map((s, i) => (
            <li key={s.n} className="flex flex-1 flex-col lg:flex-none">
              <button
                type="button"
                disabled={!canReach(s.n)}
                onClick={() => setWizard(s.n)}
                className={cn("flex w-full gap-3 rounded-lg p-3 text-left transition disabled:cursor-default", wizard === s.n ? "bg-white/5" : "opacity-60 hover:opacity-90 disabled:hover:opacity-60")}
              >
                <span
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                    wizard === s.n ? "border-white bg-white text-black" : wizard > s.n ? "border-primary text-primary" : "border-line text-mutedfg",
                  )}
                >
                  {s.n}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs text-mutedfg">Step {s.n}</span>
                  <span className="hidden text-sm font-medium leading-tight sm:block">{s.t}</span>
                </span>
              </button>
              {i < stepsList.length - 1 ? <span className="ml-[26px] hidden h-5 w-px bg-line lg:block" /> : null}
            </li>
          ))}
        </ol>

        {/* content */}
        <div className="min-w-0 space-y-4">
          {wizard > 1 ? (
            <div className="card flex flex-wrap items-center justify-between gap-3 px-5 py-4" data-testid="np-pair-header">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="flex -space-x-1.5">
                  <TokenIcon code={base.code} size={26} />
                  <TokenIcon code={quote.code} size={26} />
                </span>
                <span className="text-lg font-semibold">
                  {base.code} <span className="text-mutedfg">/</span> {quote.code}
                </span>
                <Badge variant="outline" className={cn("text-[11px]", side === "Ask" ? "border-red/40 text-red" : "border-green/40 text-green")}>
                  {side === "Ask" ? `Sell ${base.code}` : `Buy ${base.code}`}
                </Badge>
                <Badge variant="outline" className="text-[11px] text-mutedfg">
                  {fmt(step / 100, 2)}% bins · {fmt(main.feeBps / 100, 2)}% pool fee
                </Badge>
                {wizard === 3 && plan.ok ? (
                  <Badge variant="outline" className="text-[11px] text-mutedfg" data-testid="np-range-badge">
                    {fmt(eff.lo, 4, 4)} – {fmt(eff.hi, 4, 4)} · {amount} {sold.code}
                  </Badge>
                ) : null}
              </div>
              <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setWizard(wizard === 3 ? 2 : 1)} data-testid="np-edit">
                <Pencil className="size-3.5" /> Edit
              </Button>
            </div>
          ) : null}

          <div className="card p-5 sm:p-6">
            {wizard === 1 ? (
              <div className="space-y-6" data-testid="np-step-1">
                <div>
                  <h2 className="text-lg font-semibold">Select pair</h2>
                  <p className="mt-1 text-sm text-mutedfg">
                    {base.code} is a tokenized bond (regulated, AUTH_REQUIRED) priced in {quote.code}. One pair for now, on the Lotus pool and the Stellar DEX.
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <TokenTile label="Token" code={base.code} sub="Lotus bond" />
                    <TokenTile label="Priced in" code={quote.code} sub="Stellar testnet USDC" />
                  </div>
                </div>

                <Separator />

                <div>
                  <h2 className="text-lg font-semibold">Side</h2>
                  <p className="mt-1 text-sm text-mutedfg">
                    A directional range limit order: your inventory is sold (or bought) bin by bin as the price crosses the range, and never trades back.
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <SideCard
                      active={side === "Ask"}
                      onClick={() => chooseSide("Ask")}
                      testId="np-side-ask"
                      title={`Sell ${base.code}`}
                      tag="Ask"
                      tone="red"
                      body={`Deposit ${base.code}. It is sold as the price rises through your range; proceeds arrive in ${quote.code}.`}
                    />
                    <SideCard
                      active={side === "Bid"}
                      onClick={() => chooseSide("Bid")}
                      testId="np-side-bid"
                      title={`Buy ${base.code} with ${quote.code}`}
                      tag="Bid"
                      tone="green"
                      body={`Deposit ${quote.code}. It buys ${base.code} as the price falls through your range.`}
                    />
                  </div>
                </div>

                <Button className="w-full" size="lg" onClick={() => setWizard(2)} data-testid="np-continue-1">
                  Continue
                </Button>
              </div>
            ) : wizard === 2 ? (
              <div
                className="space-y-5"
                data-testid="np-step-2"
                data-ref={refPrice}
                data-ref-pool={refs.pool.price}
                data-ref-pool-yield={refs["pool-yield"].price}
                data-ref-sdex={refs.sdex.price}
                data-ref-sdex-yield={refs["sdex-yield"].price}
              >
                <div>
                  <h2 className="text-lg font-semibold">Set price range</h2>
                  <p className="mt-1 text-sm text-mutedfg">
                    Drag the handles or type the prices. Both ends snap to the pool grid ({fmt(step / 100, 2)}% per bin, up to {MAX_POSITION_BINS} bins); the same bins become
                    SDEX offers if you choose the Stellar DEX in the next step.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="text-mutedfg">Current price </span>
                    <span className="font-semibold tabular-nums" data-testid="np-ref-price">
                      {fmt(refPrice, 4, 4)} {quote.code}/{base.code}
                    </span>
                    <span className="ml-1.5 text-[11px] text-mutedfg" data-testid="np-ref-source">
                      ({refLabel})
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    {inRangeShare !== null ? (
                      <Badge variant="outline" className="text-[10px] text-primary">
                        {inRangeShare}% of visible liquidity in range
                      </Badge>
                    ) : null}
                    <Badge variant="outline" className="gap-1 text-[10px] text-green">
                      <span className="size-1.5 rounded-full bg-green" /> live depth
                    </Badge>
                  </span>
                </div>

                <LiquidityRangeChart line={candlesQ.data?.closes ?? []} depth={depthBins} min={eff.lo} max={eff.hi} current={refPrice} stepBps={step} onChange={setLoHi} unit={base.code} />

                <div className="flex flex-wrap items-center gap-1">
                  {TIMEFRAMES.map((x, i) => (
                    <button
                      key={x.label}
                      onClick={() => setTf(i)}
                      className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition", tf === i ? "bg-white/10 text-white" : "text-mutedfg hover:text-white")}
                    >
                      {x.label}
                    </button>
                  ))}
                  <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mutedfg">
                    <Legend c="#8fb6c8" l={`${candlesQ.data?.market ?? "SDEX"} trades`} />
                    <Legend c="rgba(110,140,165,0.7)" l="Lotus pool bins" />
                    <Legend c="rgba(110,140,165,0.35)" l="SDEX offers" />
                    <Legend c="#F3B1CE" l="your order" />
                  </span>
                </div>

                <div>
                  <div className="mb-2 text-sm font-medium">Range presets</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {PRESETS[side].map((p) => (
                      <button key={p.name} onClick={() => preset(p)} className="rounded-lg border border-line p-2.5 text-left transition hover:border-primary/50" data-testid={`np-preset-${p.name.replace(/\s+/g, "-").toLowerCase()}`}>
                        <div className="text-xs font-semibold">{p.name}</div>
                        <div className="mt-0.5 text-[11px] tabular-nums text-primary">{p.sub}</div>
                        <div className="mt-1 text-[10px] leading-tight text-mutedfg">{p.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <PriceField
                    label="Min price"
                    testId="np-min"
                    value={eff.lo}
                    delta={pct(eff.lo)}
                    quote={quote.code}
                    onChange={(v) => setLoHi(v, eff.hi)}
                    onStep={(d) => stepBin("lo", d)}
                  />
                  <PriceField
                    label="Max price"
                    testId="np-max"
                    value={eff.hi}
                    delta={pct(eff.hi)}
                    quote={quote.code}
                    onChange={(v) => setLoHi(eff.lo, v)}
                    onStep={(d) => stepBin("hi", d)}
                  />
                </div>
                <p className="-mt-2 text-[11px] text-mutedfg" data-testid="np-bins">
                  {binsCount} bin{binsCount === 1 ? "" : "s"} · {side === "Ask" ? `sells from ${fmt(eff.lo, 4, 4)} up to ${fmt(eff.hi, 4, 4)}` : `buys from ${fmt(eff.hi, 4, 4)} down to ${fmt(eff.lo, 4, 4)}`}
                  {side === "Bid" ? ` · top bin ${fmt(Math.max(0, binsBelowReference(binForPrice(eff.hi, step), step, refs["pool-yield"].price)), 1)} bins under the price (Blend yield in the pool needs ${PROXIMITY_MIN_BINS})` : ""}
                </p>
                {clampNote ? (
                  <p className="text-[11px] text-primary" data-testid="np-direction-note">
                    {clampNote} ({fmt(refPrice, 4, 4)}).
                  </p>
                ) : null}
                {chosen && chosen.crossing > 0 && plan.ok ? (
                  <p className="rounded-lg border border-red/40 bg-red/5 px-2.5 py-2 text-[11px] text-red" data-testid="np-crosses">
                    {crossText(chosen, side, base.code, quote.code, receipt.code, plan.bins.length)}
                  </p>
                ) : null}

                <div>
                  <div className="mb-2 flex items-center justify-between text-sm font-medium">
                    <span>Deposit {sold.code}</span>
                    <span className="flex items-center gap-1 text-[11px] font-normal text-mutedfg">
                      Weight
                      <Segmented value={shape} onChange={setShape} options={SHAPES} size="sm" className="w-auto" testId="np-shape" />
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-black/20 p-3">
                    <input
                      data-testid="np-amount"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                      className="w-full min-w-0 bg-transparent text-2xl font-semibold tabular-nums outline-none placeholder:text-mutedfg/50"
                    />
                    <div className="flex shrink-0 items-center gap-2 rounded-full bg-white/5 px-3 py-1.5 text-sm">
                      <TokenIcon code={sold.code} size={18} /> {sold.code}
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mutedfg">
                    <span>
                      {plan.ok && amountTyped
                        ? `spread over ${plan.bins.length} bins · avg ${fmt(Number(plan.avgPrice ?? 0n) / 1e7, 4, 4)} · receive about ${fmt(Number(plan.proceedsIfFilled) / 1e7, 2)} ${side === "Ask" ? quote.code : base.code} if fully filled`
                        : plan.ok
                          ? `spread over ${plan.bins.length} bins`
                          : (plan.errors[0] ?? "")}
                    </span>
                    {soldAvail !== null ? (
                      <button type="button" className="tabular-nums hover:text-white" onClick={() => setAmount(String(Math.floor(soldAvail * 1e7) / 1e7))}>
                        Balance: {fmt(soldAvail, 2)} {sold.code}
                      </button>
                    ) : wallet.address ? null : (
                      <span>Connect a wallet to see your balance</span>
                    )}
                  </div>
                </div>

                <Button className="w-full" size="lg" disabled={!plan.ok || !amountTyped} onClick={() => {
                    // freeze the default range: choosing a strategy changes the reference, it must not move the order
                    if (!range) setRange(eff);
                    setWizard(3);
                  }}
                  data-testid="np-continue-2">
                  {!amountTyped ? "Enter an amount" : !plan.ok ? (plan.errors[0] ?? "Invalid range") : "Continue"}
                </Button>
              </div>
            ) : (
              <div className="space-y-5" data-testid="np-step-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">Choose your strategy</h2>
                    <p className="mt-1 text-sm text-mutedfg">Same order, same bins, same prices. Pick where it waits, and whether the {quote.code} side earns Blend interest while it waits. Chosen once, at creation.</p>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" aria-label="About yield" className="mt-1 text-mutedfg hover:text-foreground">
                        <Info className="size-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[20rem] text-[11px] leading-relaxed">
                      Yield is the Blend {quote.code} supply rate, reached through our DeFindex vault (fee 0). The APR is read live from the Blend pool (b_rate growth while this page is
                      open); it moves with testnet utilization and is not a forecast. BLND emissions are not counted.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <StrategyCards
                  destinations={destinations}
                  side={side}
                  base={base}
                  quote={quote}
                  receipt={receipt}
                  bins={plan.ok ? plan.bins.length : 0}
                  apr={apr}
                  selected={choice}
                  onSelect={setChoice}
                  onChangeRange={rangeToYield}
                />
                <Button
                  className="w-full"
                  size="lg"
                  disabled={!chosen || !!chosen.unavailable}
                  onClick={() => (wallet.address ? setReviewOpen(true) : wallet.connect())}
                  data-testid="np-review"
                >
                  {!chosen ? "Choose a strategy" : chosen.unavailable ? "Not available for this range" : wallet.address ? "Review" : "Connect a wallet"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {chosen ? (
        <ReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          dest={chosen}
          env={env}
          plan={plan}
          side={side}
          aprText={aprText}
          onDone={() => {
            onCreated();
            depthQ.refresh();
            booksQ.refresh();
          }}
          onSuccessClose={() => {
            setAmount("");
            setChoice(null);
            setWizard(2);
          }}
        />
      ) : null}
    </div>
  );
}

function Legend({ c, l }: { c: string; l: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block size-2.5 rounded-sm" style={{ background: c }} />
      {l}
    </span>
  );
}

function TokenTile({ label, code, sub }: { label: string; code: string; sub: string }) {
  return (
    <div className="flex h-14 items-center gap-2.5 rounded-md border border-line bg-black/20 px-3">
      <TokenIcon code={code} size={26} />
      <span className="min-w-0 leading-tight">
        <span className="block text-[10px] text-mutedfg">{label}</span>
        <span className="font-semibold">{code}</span>
        <span className="ml-1.5 text-[11px] text-mutedfg">{sub}</span>
      </span>
    </div>
  );
}

function SideCard({ active, onClick, title, tag, body, tone, testId }: { active: boolean; onClick: () => void; title: string; tag: string; body: string; tone: "red" | "green"; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active ? "1" : "0"}
      className={cn("rounded-xl border p-4 text-left transition", active ? "border-primary/60 bg-primary/10" : "border-line hover:border-white/20")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", tone === "red" ? "bg-red/10 text-red" : "bg-green/10 text-green")}>{tag}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-mutedfg">{body}</p>
    </button>
  );
}

/** lotus-main min / max price field with +/- steppers (one pool bin per click). */
function PriceField({
  label,
  value,
  delta,
  quote,
  onChange,
  onStep,
  testId,
}: {
  label: string;
  value: number;
  delta: string;
  quote: string;
  onChange: (v: number) => void;
  onStep: (d: 1 | -1) => void;
  testId: string;
}) {
  const [buf, setBuf] = useState<string | null>(null);
  const shown = buf ?? fmt(value, 4, 4).replace(/,/g, "");
  const commit = () => {
    if (buf !== null && Number(buf) > 0) onChange(Number(buf));
    setBuf(null);
  };
  const up = Number(delta) >= 0;
  return (
    <div className="rounded-lg border border-line bg-black/20 p-3">
      <div className="flex items-center justify-between text-xs text-mutedfg">
        <span>{label}</span>
        <div className="flex gap-1">
          <button type="button" aria-label={`${label} down one bin`} data-testid={`${testId}-minus`} onClick={() => onStep(-1)} className="grid size-5 place-items-center rounded border border-line hover:bg-white/5">
            <Minus className="size-3" />
          </button>
          <button type="button" aria-label={`${label} up one bin`} data-testid={`${testId}-plus`} onClick={() => onStep(1)} className="grid size-5 place-items-center rounded border border-line hover:bg-white/5">
            <Plus className="size-3" />
          </button>
        </div>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <input
          data-testid={testId}
          inputMode="decimal"
          value={shown}
          onChange={(e) => setBuf(e.target.value.replace(/[^0-9.]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          className="w-full min-w-0 bg-transparent text-xl font-semibold tabular-nums outline-none"
        />
        <span className="shrink-0 text-xs text-mutedfg">{quote}</span>
      </div>
      <div className={cn("text-[11px] tabular-nums", up ? "text-green" : "text-red")}>
        {up ? "+" : ""}
        {delta}%
      </div>
    </div>
  );
}
