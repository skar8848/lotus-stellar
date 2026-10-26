"use client";

// Limit (Lite) and Range (Pro) views of /swap, laid out as the previous front's LimitScreen (owl/web
// components/app/LimitScreen.tsx: lite "When 1 X is worth" block, pro AssetField + Start / Range end fields + end
// presets + ChartPanel) with its YieldVenueModal trigger turned into the strategy choice of /pools. The order is
// evaluated by useRangeOrder (= the /pools New position logic) and signed in the /pools ReviewDialog (lib/orderTx.ts).

import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowDownUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TokenIcon } from "@/components/common";
import { ReviewDialog } from "@/components/pools/ReviewDialog";
import { StrategyCards } from "@/components/pools/StrategyCards";
import type { LiveApr } from "@/components/pools/useBlendApr";
import type { StrategyId } from "@/components/pools/useOrder";
import { useAssetAccess } from "@/components/trade/access";
import { fromStroops } from "@/lib/amount";
import { useConfig } from "@/lib/config-context";
import { fmt, type AssetRef } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet";
import { NumberInput, TokenButton, fmtBalance, fmtNum } from "./parts";
import { ProChartCard, type RangeEnd } from "./ProRangeChart";
import { useProCandles } from "./useProCandles";
import type { RangeOrder } from "./useRangeOrder";

// the lite / pro "+5% +10% +25% +50%" presets, scaled to the pool grid (10 bps bins, at most 64 bins a position)
const PRESETS = [0.5, 1, 2.5, 5];

const TITLE: Record<StrategyId, string> = {
  pool: "Lotus pool",
  "pool-yield": "Lotus pool + Blend yield",
  sdex: "Stellar DEX",
  "sdex-yield": "Stellar DEX + Blend yield",
};

type Pair = {
  pay: AssetRef;
  recv: AssetRef;
  sellOptions: AssetRef[];
  buyOptions: AssetRef[];
  onSelect: (side: "pay" | "recv", a: AssetRef) => void;
  onFlip: () => void;
};

const pctOf = (v: number, ref: number) => (ref > 0 ? (v / ref - 1) * 100 : 0);
const signed = (n: number, dp = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;

/** LimitScreen AssetField: amount, token dropdown, value + balance line. */
function AssetField({
  label,
  amount,
  onAmount,
  value,
  asset,
  options,
  onSelect,
  readOnly,
  balance,
  testId,
}: {
  label: string;
  amount: string;
  onAmount?: (v: string) => void;
  value: string;
  asset: AssetRef;
  options: AssetRef[];
  onSelect: (a: AssetRef) => void;
  readOnly?: boolean;
  balance?: number | null;
  testId?: string;
}) {
  return (
    <div className="rounded-2xl bg-secondary px-4 py-3.5">
      <div className="text-sm text-mutedfg">{label}</div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          readOnly={readOnly}
          onChange={(e) => onAmount?.(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0"
          data-testid={testId}
          className={cn("w-full min-w-0 bg-transparent text-4xl font-medium tabular-nums outline-none placeholder:text-mutedfg/50", readOnly && "text-mutedfg")}
        />
        <TokenButton asset={asset} options={options} onSelect={onSelect} testId={`${testId}-token`} />
      </div>
      <div className="mt-1 flex items-center justify-between text-sm text-mutedfg tabular-nums">
        <span>{value}</span>
        {balance != null &&
          (onAmount && !readOnly ? (
            <button onClick={() => onAmount(String(Math.floor(balance * 1e7) / 1e7))} className="transition hover:text-white" title={`Use full ${asset.code} balance`}>
              Balance: {fmtBalance(balance)}
            </button>
          ) : (
            <span>Balance: {fmtBalance(balance)}</span>
          ))}
      </div>
    </div>
  );
}

/** Sell -> Buy cards of both order views: Sell = the deposit, Buy = what it becomes once fully filled. */
function SellBuy({ o, pair, labels, flipIcon }: { o: RangeOrder; pair: Pair; labels: [string, string]; flipIcon: "down" | "updown" }) {
  const payAccess = useAssetAccess(pair.pay);
  const recvAccess = useAssetAccess(pair.recv);
  const proceeds = o.plan.ok && o.amountTyped ? fmtNum(Number(fromStroops(o.plan.proceedsIfFilled))) : "";
  const sellQuoteValue = o.amountTyped && o.refPrice > 0 ? (o.side === "Ask" ? Number(o.amount) * o.refPrice : Number(o.amount)) : 0;
  const buyQuoteValue = o.plan.ok && o.amountTyped ? Number(fromStroops(o.plan.proceedsIfFilled)) * (o.side === "Ask" ? 1 : o.refPrice) : 0;
  const Icon = flipIcon === "down" ? ArrowDown : ArrowDownUp;
  return (
    <div className="space-y-1.5">
      <AssetField
        label={labels[0]}
        amount={o.amount}
        onAmount={o.setAmount}
        value={`≈ ${fmtNum(sellQuoteValue)} ${o.quote.code}`}
        asset={pair.pay}
        options={pair.sellOptions}
        onSelect={(a) => pair.onSelect("pay", a)}
        balance={payAccess.available ?? 0}
        testId="order-amount"
      />
      <div className="relative h-0">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <button onClick={pair.onFlip} aria-label="Flip pair" data-testid="order-flip" className="grid size-9 place-items-center rounded-xl border-4 border-bg bg-secondary text-mutedfg transition hover:text-white">
            <Icon className="size-4" />
          </button>
        </div>
      </div>
      <AssetField
        label={labels[1]}
        amount={proceeds}
        value={`≈ ${fmtNum(buyQuoteValue)} ${o.quote.code}`}
        asset={pair.recv}
        options={pair.buyOptions}
        onSelect={(a) => pair.onSelect("recv", a)}
        readOnly
        balance={recvAccess.available ?? 0}
        testId="order-receive"
      />
    </div>
  );
}

/** The YieldVenueModal trigger, as the strategy choice of /pools (StrategyCards in the modal). */
function StrategyPicker({ o, apr }: { o: RangeOrder; apr: LiveApr }) {
  const [open, setOpen] = useState(false);
  const d = o.chosen;
  const aprPct = apr.aprPct ?? apr.observedPct;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="order-strategy"
        data-strategy={d?.id ?? ""}
        className="flex w-full items-center justify-between rounded-xl bg-secondary px-4 py-3 text-left transition hover:bg-white/[0.04]"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {d ? (
            d.venue === "pool" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/tokens/lotus-pool.svg" alt="" width={22} height={22} className="size-[22px] shrink-0 rounded-full" />
            ) : (
              <TokenIcon code="XLM" size={22} />
            )
          ) : null}
          <span className="min-w-0">
            <span className="block text-[11px] text-mutedfg">Strategy</span>
            <span className="block truncate text-sm font-medium text-white">{d ? TITLE[d.id] : "Choose where your order waits"}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-mutedfg">
          {d?.yieldOn && aprPct !== null ? <span className="tabular-nums text-green">{aprPct.toFixed(2)}%</span> : null}
          <ChevronDown className="size-4 opacity-60" />
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl" data-testid="strategy-dialog">
          <DialogHeader>
            <DialogTitle>Choose your strategy</DialogTitle>
            <DialogDescription className="text-xs">
              Same order, same bins, same prices. Pick where it waits, and whether the {o.quote.code} side earns Blend interest while it waits.
            </DialogDescription>
          </DialogHeader>
          <StrategyCards
            destinations={o.destinations}
            side={o.side}
            base={o.base}
            quote={o.quote}
            receipt={o.receipt}
            bins={o.plan.ok ? o.plan.bins.length : 0}
            apr={apr}
            selected={d?.id ?? null}
            onSelect={(id) => {
              o.setChoice(id);
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Confirm / Get started -> the /pools review modal (sign). */
function SubmitOrder({ o, apr, label, className }: { o: RangeOrder; apr: LiveApr; label: string; className: string }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const d = o.chosen;
  const aprText = apr.aprPct !== null ? `${apr.aprPct.toFixed(2)}% APR` : apr.observedPct !== null ? `${apr.observedPct.toFixed(2)}% APR` : null;
  const blocked = !wallet.address ? null : !d ? "No strategy open for this order" : d.blockedBy;
  const faucet = blocked && /trustline|authoriz/i.test(blocked);
  return (
    <>
      {faucet ? (
        <Button asChild className={className}>
          <Link href="/faucet" data-testid="order-submit">
            {blocked} · Faucet
          </Link>
        </Button>
      ) : (
        <Button
          className={className}
          disabled={!!blocked}
          onClick={() => (wallet.address ? setOpen(true) : void wallet.connect())}
          data-testid="order-submit"
        >
          {!wallet.address ? "Connect a wallet" : blocked ?? label}
        </Button>
      )}
      {d ? (
        <ReviewDialog
          open={open}
          onOpenChange={setOpen}
          dest={d}
          env={o.env}
          plan={o.plan}
          side={o.side}
          aprText={aprText}
          onDone={o.refresh}
          onSuccessClose={() => {
            o.setAmount("");
            o.setChoice(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Lite "Limit": one price, one bin ("When 1 X is worth"). */
export function LiteLimit({ o, pair, apr }: { o: RangeOrder; pair: Pair; apr: LiveApr }) {
  const sign = o.side === "Ask" ? 1 : -1;
  const presetActive = (p: number) => o.refPrice > 0 && Math.abs(o.start - o.refPrice * (1 + (sign * p) / 100)) < o.refPrice * 0.0006;
  return (
    <div data-testid="lite-limit" data-side={o.side}>
      <SellBuy o={o} pair={pair} labels={["Sell", "Buy"]} flipIcon="down" />

      {/* "When 1 X is worth [price]" */}
      <div className="mt-1.5 rounded-2xl bg-secondary px-4 py-3.5">
        <div className="flex items-center justify-between text-sm text-mutedfg">
          <span>
            When 1 <span className="font-medium text-white">{o.base.code}</span> is worth
          </span>
          <button onClick={pair.onFlip} aria-label="Flip pair" className="grid size-7 place-items-center rounded-md text-mutedfg transition hover:text-white">
            <ArrowDownUp className="size-4" />
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <NumberInput
            value={o.start}
            onChange={o.setStart}
            testId="limit-price" dp={4}
            className="w-full min-w-0 bg-transparent text-4xl font-medium tabular-nums outline-none placeholder:text-mutedfg/50"
          />
          <span className="shrink-0 text-base text-mutedfg">{o.quote.code}</span>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button onClick={o.resetPrices} className="rounded-md bg-white/5 px-2 py-1 text-[11px] font-medium text-mutedfg transition hover:text-white">
            Market
          </button>
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => o.setStart(o.refPrice * (1 + (sign * p) / 100))}
              disabled={o.refPrice <= 0}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] font-medium tabular-nums transition disabled:opacity-40",
                presetActive(p) ? "bg-primary text-primary-foreground" : "bg-white/5 text-mutedfg hover:text-white",
              )}
            >
              {sign > 0 ? "+" : "-"}
              {p}%
            </button>
          ))}
          {o.refPrice > 0 && (
            <span className="ml-auto text-[11px] tabular-nums text-mutedfg" data-testid="limit-spot">
              spot {fmtNum(o.refPrice)} {o.quote.code}
            </span>
          )}
        </div>
      </div>

      {/* expiry: Lotus orders rest until filled (no expiry on the pool or the SDEX) */}
      <div className="mt-3 flex items-center justify-between rounded-xl bg-secondary px-4 py-3">
        <span className="text-sm text-mutedfg">Expiry</span>
        <span className="rounded-md bg-white/10 px-2 py-1 text-xs font-medium text-white">Until filled</span>
      </div>

      <div className="mt-3">
        <StrategyPicker o={o} apr={apr} />
      </div>
      <OrderNote o={o} />
      <SubmitOrder o={o} apr={apr} label="Confirm" className="mt-3 h-12 w-full text-base" />
    </div>
  );
}

/** Pro "Range": Selling / Buying, Start price + Range end (% or price), end presets, strategy. */
export function ProRange({ o, pair, apr }: { o: RangeOrder; pair: Pair; apr: LiveApr }) {
  const sign = o.side === "Ask" ? 1 : -1;
  const startDelta = pctOf(o.start, o.refPrice);
  const endDelta = pctOf(o.end, o.start);
  return (
    <div data-testid="pro-range" data-side={o.side}>
      <SellBuy o={o} pair={pair} labels={["Selling", "Buying"]} flipIcon="updown" />

      <div className="mt-4 space-y-2.5">
        <div className="text-sm font-medium">Set up your range order</div>
        <div className="grid grid-cols-2 gap-2">
          {/* Start price */}
          <div className="rounded-2xl bg-secondary px-3.5 py-3">
            <div className="flex items-center justify-between text-xs text-mutedfg">
              <span>Start price</span>
              <span className={cn("tabular-nums", startDelta >= 0 ? "text-green" : "text-red")}>{signed(startDelta)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <NumberInput value={o.start} onChange={o.setStart} testId="range-start" dp={4} className="w-full min-w-0 bg-transparent text-2xl font-medium tabular-nums outline-none" />
              <span className="shrink-0 text-xs text-mutedfg">{o.quote.code}</span>
            </div>
          </div>
          {/* Range end */}
          <div className="rounded-2xl bg-secondary px-3.5 py-3">
            <div className="flex items-center justify-between text-xs text-mutedfg">
              <span>Range end</span>
              <div className="flex items-center rounded-md border border-line text-[10px] font-medium">
                <button onClick={() => o.setEndMode("pct")} className={cn("rounded-l-md px-1.5 py-0.5 transition", o.endMode === "pct" ? "bg-white/10 text-white" : "text-mutedfg")}>
                  %
                </button>
                <button onClick={() => o.setEndMode("abs")} className={cn("rounded-r-md px-1.5 py-0.5 transition", o.endMode === "abs" ? "bg-white/10 text-white" : "text-mutedfg")}>
                  {o.quote.code}
                </button>
              </div>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              {o.endMode === "pct" ? (
                <>
                  <NumberInput value={o.endPct} onChange={o.setEndPct} testId="range-end-pct" className="w-full min-w-0 bg-transparent text-2xl font-medium tabular-nums outline-none" />
                  <span className="shrink-0 text-sm text-mutedfg">%</span>
                </>
              ) : (
                <>
                  <NumberInput value={o.end} onChange={o.setEndAbs} testId="range-end" dp={4} className="w-full min-w-0 bg-transparent text-2xl font-medium tabular-nums outline-none" />
                  <span className="shrink-0 text-xs text-mutedfg">{o.quote.code}</span>
                </>
              )}
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-mutedfg">{o.endMode === "pct" ? `= ${fmtNum(o.end)} ${o.quote.code}` : signed(endDelta)}</div>
          </div>
        </div>

        <div className="text-[11px] text-mutedfg" data-testid="range-line">
          Range <span className="tabular-nums text-white">{fmtNum(o.lo)}</span> → <span className="tabular-nums text-white">{fmtNum(o.hi)}</span> {o.quote.code}
          {o.start > 0 && <span className="ml-1 tabular-nums">({signed(endDelta)})</span>}
          {o.plan.ok ? <span className="ml-1">· {o.plan.bins.length} bin{o.plan.bins.length === 1 ? "" : "s"}</span> : null}
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => o.setEndPct(p)}
              disabled={o.start <= 0}
              className={cn(
                "rounded-lg border py-1.5 text-[11px] font-medium tabular-nums transition disabled:opacity-40",
                o.endMode === "pct" && o.endPct === p ? "border-primary/60 bg-primary/10 text-white" : "border-line text-mutedfg hover:border-primary/50 hover:text-white",
              )}
            >
              {sign > 0 ? "+" : "-"}
              {p}%
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <StrategyPicker o={o} apr={apr} />
      </div>
      <OrderNote o={o} />
      <SubmitOrder o={o} apr={apr} label="Get started" className="mt-3 h-12 w-full text-base" />
    </div>
  );
}

/** Why the chosen strategy cannot take the order, or what it crosses (the /pools card notes, one line). */
function OrderNote({ o }: { o: RangeOrder }) {
  const d = o.chosen;
  if (!o.plan.ok && o.amountTyped) return <p className="mt-2 text-[11px] text-red">{o.plan.errors[0]}</p>;
  if (!d) return o.amountTyped ? <p className="mt-2 text-[11px] text-red">No strategy can take this order: move the price {o.side === "Ask" ? "up" : "down"}.</p> : null;
  if (d.crossing > 0 && o.plan.ok)
    return (
      <p className="mt-2 text-[11px] text-red" data-testid="order-crosses">
        {d.crossing} of {o.plan.bins.length} level{o.plan.bins.length === 1 ? "" : "s"} {o.side === "Ask" ? "at or under the best bid" : "at or above the best ask"} ({fmt(d.ref.price, 4, 4)}, {d.ref.source}): {o.side === "Ask" ? "move the price up" : "move the price down"}.
      </p>
    );
  return null;
}

/** LimitScreen ChartPanel: the lotus-main /pro chart card (candles + Start / End handles + pool / SDEX liquidity). */
export function ChartPanel({ o, showRange }: { o: RangeOrder; showRange: boolean }) {
  const config = useConfig();
  const c = useProCandles({ horizon: config.horizon, base: o.base, quote: o.quote, receipt: o.receipt, preferReceipt: o.chosen?.id === "sdex-yield", enabled: o.ready });
  const range = showRange && o.start > 0 && o.end > 0 ? { start: o.start, end: o.end } : null;
  // a handle never crosses the other one (Ask: start under end, Bid: start above end); snapping is useRangeOrder's
  const g = o.step / 10_000;
  const ask = o.side === "Ask";
  const drag = (which: RangeEnd, p: number) =>
    which === "start" ? o.setLoHi(ask ? Math.min(p, o.end * (1 - g)) : Math.max(p, o.end * (1 + g)), o.end) : o.setLoHi(o.start, ask ? Math.max(p, o.start * (1 + g)) : Math.min(p, o.start * (1 - g)));
  return (
    <ProChartCard
      base={o.base.code}
      quote={o.quote.code}
      price={o.refPrice}
      loading={!o.live}
      inRangeShare={o.inRangeShare}
      tfIdx={c.tfIdx}
      onTf={c.setTfIdx}
      marketLabel={c.marketLabel}
      candles={c.candles}
      resMs={c.tf.res}
      range={range}
      bins={range && o.plan.ok ? o.plan.bins.map((b) => Number(b.price) / 1e7) : []}
      depth={o.depthBins}
      refPrice={o.refPrice}
      onRangeChange={range ? drag : undefined}
      onRecenter={range ? o.recenter : undefined}
    />
  );
}
