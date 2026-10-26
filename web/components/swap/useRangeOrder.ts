"use client";

// The order behind the Limit (Lite) and Range (Pro) views of /swap: the same live data and evaluation as the /pools
// "New position" flow (pool depth of every live instance, SDEX books, candles, per-strategy reference price), then
// the same plan (lib/poolGrid planPosition) and the same four destinations (components/pools/useOrder.ts
// useOrderDestinations). Signing goes through the /pools ReviewDialog -> lib/orderTx.ts placeOrder, unchanged.

import { useCallback, useMemo, useState } from "react";
import { useConfig, useNet } from "@/lib/config-context";
import type { PoolInstance } from "@/lib/config-types";
import { usePolling } from "@/lib/hooks";
import { bestPrices } from "@/lib/book";
import { conservativeReference, referenceFor, type BookTop } from "@/lib/orderRoute";
import { getPoolClient } from "@/lib/pool";
import { MAX_BIN, MIN_BIN, binForPrice, planPosition, priceAt, type Side } from "@/lib/poolGrid";
import { assetReady, fetchOrderBook, type AssetRef } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import type { DepthBin } from "@/components/trade/chart/rangeLayer";
import { STRATEGIES, directionalPools, useOrderDestinations, type StrategyId } from "@/components/pools/useOrder";

export const snapPrice = (p: number, step: number) => Number(priceAt(binForPrice(p, step), step)) / 1e7;
const fixed = (n: number) => n.toFixed(7);

export type OrderKind = "limit" | "range";

export function useRangeOrder({ sideFromSell, kind, enabled }: { sideFromSell: Side; kind: OrderKind; enabled: boolean }) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const pools = config.pools;
  const { idle, vaulted } = useMemo(() => directionalPools(pools), [pools]);
  const main = (idle ?? vaulted ?? pools[0]) as PoolInstance | undefined;
  const step = main?.binStepBps ?? 10;
  const feeBps = main?.feeBps ?? 0;
  const base = main?.base as AssetRef;
  const quote = main?.quote as AssetRef;
  const receipt: AssetRef = config.receipt;
  const side = sideFromSell;

  // start / end in QUOTE per BASE; null = follow the reference price
  const [start, setStart] = useState<number | null>(null);
  const [endMode, setEndMode] = useState<"pct" | "abs">("pct");
  const [endPct, setEndPct] = useState(2);
  const [endAbs, setEndAbs] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [choice, setChoice] = useState<StrategyId | null>(null);

  // ---- live data, as /pools NewPosition ----------------------------------------------------------------------------
  const depthPools = useMemo(() => pools.filter((p) => p.status !== "retired" && p.status !== "coming-soon"), [pools]);
  const depthFn = useCallback(
    () =>
      Promise.all(
        depthPools.map(async (inst) => {
          const c = getPoolClient(net, inst);
          const [asks, bids] = await Promise.all([c.depth("Ask", MIN_BIN, MAX_BIN).catch(() => []), c.depth("Bid", MIN_BIN, MAX_BIN).catch(() => [])]);
          return { inst, asks, bids };
        }),
      ),
    [net, depthPools],
  );
  const depthQ = usePolling(depthFn, 10000, enabled && !!main);

  const booksFn = useCallback(async () => {
    const ok = assetReady(base) && !!base.issuer;
    const [rb, ub] = await Promise.all([
      ok && assetReady(receipt) ? fetchOrderBook(config.horizon, base, receipt, 50).catch(() => null) : Promise.resolve(null),
      ok && assetReady(quote) ? fetchOrderBook(config.horizon, base, quote, 50).catch(() => null) : Promise.resolve(null),
    ]);
    return { receipt: rb, usdc: ub };
  }, [config.horizon, base, quote, receipt]);
  const booksQ = usePolling(booksFn, 10000, enabled && !!main);

  const market = useMemo(() => {
    const poolTop = (inst: PoolInstance | null): BookTop => {
      const d = inst ? depthQ.data?.find((x) => x.inst.id === inst.id) : undefined;
      return {
        ask: d?.asks[0] ? Number(d.asks[0].price) / 1e7 : null,
        bid: d?.bids.length ? Number(d.bids[d.bids.length - 1].price) / 1e7 : null,
      };
    };
    return { usdc: bestPrices(booksQ.data?.usdc ?? null), receipt: bestPrices(booksQ.data?.receipt ?? null), pool: { idle: poolTop(idle), vaulted: poolTop(vaulted) } };
  }, [depthQ.data, booksQ.data, idle, vaulted]);
  const refs = useMemo(() => {
    const out = {} as Record<StrategyId, { price: number; source: string }>;
    for (const st of STRATEGIES) out[st.id] = referenceFor(st.venue, st.yieldOn, { usdc: market.usdc, receipt: market.receipt, pool: st.yieldOn ? market.pool.vaulted : market.pool.idle });
    return out;
  }, [market]);
  const ref = choice ? refs[choice] : conservativeReference(side, STRATEGIES.map((st) => refs[st.id]));
  const refPrice = ref.price;
  const live = depthQ.data !== null || booksQ.data !== null;

  // ---- the order ---------------------------------------------------------------------------------------------------
  // defaults as /pools: an ask from just above the price, a bid 11 bins under it (keeps Blend yield in the pool open)
  const defStart = refPrice > 0 ? snapPrice(side === "Ask" ? refPrice * 1.001 : refPrice * 0.989, step) : 0;
  const startEff = start ?? defStart;
  const sign = side === "Ask" ? 1 : -1;
  const endEff =
    kind === "limit"
      ? startEff
      : endMode === "abs" && endAbs !== null
        ? endAbs
        : startEff > 0
          ? snapPrice(startEff * (1 + (sign * endPct) / 100), step)
          : 0;
  const plan = useMemo(
    () =>
      planPosition({
        side,
        startPrice: fixed(startEff),
        endPrice: fixed(endEff),
        shape: "uniform",
        // a placeholder size keeps the preview alive before an amount is typed (as /pools)
        amount: Number(amount) > 0 ? amount : "1",
        stepBps: step,
        feeBps,
      }),
    [side, startEff, endEff, amount, step, feeBps],
  );
  const amountTyped = Number(amount) > 0;

  const { env, destinations } = useOrderDestinations(pools, { side, plan, amountTyped, stepBps: step, market, connected: !!wallet.address });
  // as the lite page's yield venue: a default pick (the first strategy open for this order), the user can change it
  const firstOpen = destinations.find((d) => !d.unavailable) ?? null;
  const chosen = destinations.find((d) => d.id === choice) ?? firstOpen;

  // depth histogram, pool bins + SDEX levels on the pool grid, in BASE-equivalent (as /pools)
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

  const lo = Math.min(startEff, endEff);
  const hi = Math.max(startEff, endEff);
  const inRangeShare = useMemo(() => {
    const total = depthBins.reduce((s, d) => s + d.pool + d.sdex, 0);
    if (total <= 0) return null;
    const inside = depthBins.filter((d) => d.price >= lo && d.price <= hi).reduce((s, d) => s + d.pool + d.sdex, 0);
    return Math.round((inside / total) * 100);
  }, [depthBins, lo, hi]);

  const setStartSnap = (v: number) => setStart(v > 0 ? snapPrice(v, step) : 0);
  const setEndAbsSnap = (v: number) => {
    setEndMode("abs");
    setEndAbs(v > 0 ? snapPrice(v, step) : 0);
  };
  /** chart handles: min / max -> start / end by side */
  const setLoHi = (a: number, b: number) => {
    const mn = Math.min(a, b);
    const mx = Math.max(a, b);
    setStartSnap(side === "Ask" ? mn : mx);
    setEndAbsSnap(side === "Ask" ? mx : mn);
  };
  const reset = () => {
    setStart(null);
    setEndMode("pct");
    setEndPct(2);
    setEndAbs(null);
    setAmount("");
    setChoice(null);
  };
  /** a new side (flip / token change): the prices follow the new reference again, the amount stays */
  const resetPrices = () => {
    setStart(null);
    setEndAbs(null);
    setEndMode("pct");
    setChoice(null);
  };
  const refresh = () => {
    depthQ.refresh();
    booksQ.refresh();
  };

  return {
    ready: !!main,
    base,
    quote,
    receipt,
    side,
    step,
    ref,
    refPrice,
    refs,
    live,
    start: startEff,
    end: endEff,
    lo,
    hi,
    setStart: setStartSnap,
    endMode,
    setEndMode: (m: "pct" | "abs") => {
      if (m === endMode) return;
      if (m === "abs") setEndAbs(endEff);
      else if (startEff > 0) setEndPct(Math.round(Math.abs(endEff / startEff - 1) * 10000) / 100);
      setEndMode(m);
    },
    endPct,
    setEndPct: (v: number) => {
      setEndMode("pct");
      setEndPct(v);
    },
    setEndAbs: setEndAbsSnap,
    setLoHi,
    amount,
    setAmount,
    amountTyped,
    plan,
    env,
    destinations,
    chosen,
    choice,
    setChoice,
    depthBins,
    inRangeShare,
    reset,
    resetPrices,
    refresh,
  };
}

export type RangeOrder = ReturnType<typeof useRangeOrder>;
