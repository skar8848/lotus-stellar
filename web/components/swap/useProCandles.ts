"use client";

// Candles of the Pro range chart: Horizon /trade_aggregations on the SDEX market of the order's strategy (BASE/USDC,
// or BASE/receipt for "Stellar DEX + Blend yield"), falling back to the other book when the preferred one has no
// trades yet. The lotus-main timeframes 1H 1D 1W 1M 1Y are windows, each read at the Horizon resolution that fills it
// (Horizon only has 1m 5m 15m 1h 1d 1w); only the buckets inside the window are kept, gaps are filled by the chart.

import { useCallback, useState } from "react";
import { usePolling } from "@/lib/hooks";
import { assetReady, fetchCandles, type AssetRef, type Candle } from "@/lib/stellar";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const PRO_TIMEFRAMES = [
  { label: "1H", res: MIN, window: HOUR },
  { label: "1D", res: 15 * MIN, window: DAY },
  { label: "1W", res: HOUR, window: 7 * DAY },
  { label: "1M", res: DAY, window: 31 * DAY },
  { label: "1Y", res: 7 * DAY, window: 365 * DAY },
] as const;
export type ProTimeframe = (typeof PRO_TIMEFRAMES)[number];

export function useProCandles({ horizon, base, quote, receipt, preferReceipt, enabled }: { horizon: string; base: AssetRef; quote: AssetRef; receipt: AssetRef; preferReceipt: boolean; enabled: boolean }) {
  const [tfIdx, setTfIdx] = useState(1); // 1D: the market makers trade every minute, the testnet book is young
  const tf = PRO_TIMEFRAMES[tfIdx];
  const fn = useCallback(async () => {
    const books = (preferReceipt ? [receipt, quote] : [quote, receipt]).filter((q) => assetReady(q) && assetReady(base));
    const limit = Math.min(200, Math.ceil(tf.window / tf.res) + 1);
    const from = Math.floor((Date.now() - tf.window) / 1000 / (tf.res / 1000)) * (tf.res / 1000);
    let first: { candles: Candle[]; counter: AssetRef } | null = null;
    for (const counter of books) {
      const all = await fetchCandles(horizon, base, counter, tf.res, limit).catch(() => [] as Candle[]);
      const candles = all.filter((c) => c.time >= from);
      first ??= { candles, counter };
      if (candles.length > 0) return { candles, counter };
    }
    return first ?? { candles: [] as Candle[], counter: quote };
  }, [horizon, base, quote, receipt, preferReceipt, tf]);
  const q = usePolling(fn, 20000, enabled);
  const counter = q.data?.counter ?? (preferReceipt ? receipt : quote);
  return {
    candles: q.data?.candles ?? null,
    tf,
    tfIdx,
    setTfIdx,
    marketLabel: `${base.code}/${counter.code}`,
  };
}
