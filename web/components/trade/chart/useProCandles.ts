"use client";

// Candles of the Pro range chart: the same Horizon /trade_aggregations as /trade, on the SDEX market of the order's
// strategy (BASE/USDC, or BASE/receipt for "Stellar DEX + Blend yield"); falls back to the other book when the
// preferred one has no trades yet.

import { useCallback, useState } from "react";
import { usePolling } from "@/lib/hooks";
import { assetReady, fetchCandles, type AssetRef, type Candle } from "@/lib/stellar";
import { CHART_TIMEFRAMES } from "./series";

export function useProCandles({ horizon, base, quote, receipt, preferReceipt, enabled }: { horizon: string; base: AssetRef; quote: AssetRef; receipt: AssetRef; preferReceipt: boolean; enabled: boolean }) {
  const [tfIdx, setTfIdx] = useState(1); // 5m: the market makers trade every minute, so buckets are full
  const ms = CHART_TIMEFRAMES[tfIdx].ms;
  const fn = useCallback(async () => {
    const books = (preferReceipt ? [receipt, quote] : [quote, receipt]).filter((q) => assetReady(q) && assetReady(base));
    let first: { candles: Candle[]; counter: AssetRef } | null = null;
    for (const counter of books) {
      const candles = await fetchCandles(horizon, base, counter, ms, 200).catch(() => [] as Candle[]);
      first ??= { candles, counter };
      if (candles.length > 0) return { candles, counter };
    }
    return first ?? { candles: [] as Candle[], counter: quote };
  }, [horizon, base, quote, receipt, preferReceipt, ms]);
  const q = usePolling(fn, 20000, enabled);
  const counter = q.data?.counter ?? (preferReceipt ? receipt : quote);
  return {
    candles: q.data?.candles ?? null,
    tfIdx,
    setTfIdx,
    timeframes: CHART_TIMEFRAMES,
    marketLabel: `${base.code}/${counter.code}`,
    // same id as the /trade market, so drawings are shared with /trade
    marketId: `${base.code}-${counter.code}`,
  };
}
