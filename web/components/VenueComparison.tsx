"use client";

// Same input, two venues: the Lotus pool (quote_swap) next to the SDEX path payment (Horizon strict-send).
// Marks the better one by effective price (USDC per LBOND). Used on /pools (swap) and /trade (swap panel).

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useNet } from "@/lib/config-context";
import type { PoolInstance } from "@/lib/config-types";
import { useDebounced, usePolling } from "@/lib/hooks";
import { getPoolClient } from "@/lib/pool";
import { fetchStrictSendPaths, fmt, fromStroops, normalizeAmount, toAssetRef, toStroops, type AssetRef, type PathRecord } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/common";

export type VenueQuote = {
  venue: "pool" | "sdex";
  /** amount received, decimal string; null when the venue cannot fill */
  out: string | null;
  /** USDC per LBOND */
  price: number | null;
  detail: string;
  partial?: boolean;
  note?: string;
};

function bestPath(records: PathRecord[]): PathRecord | null {
  if (records.length === 0) return null;
  return records.reduce((a, b) => (Number(b.destination_amount) > Number(a.destination_amount) ? b : a));
}

/** buy = pay quote (USDC), receive base (LBOND); sell = pay base, receive quote. */
export function useVenueQuotes({
  pool,
  direction,
  amountIn,
  base,
  quote,
  horizon,
}: {
  pool: PoolInstance | undefined;
  direction: "buy" | "sell";
  amountIn: string;
  base: AssetRef;
  quote: AssetRef;
  horizon: string;
}) {
  const net = useNet();
  const debounced = useDebounced(amountIn, 350);
  const valid = useMemo(() => {
    try {
      return toStroops(debounced) > 0n ? normalizeAmount(debounced) : null;
    } catch {
      return null;
    }
  }, [debounced]);

  const poolFn = useCallback(async (): Promise<VenueQuote> => {
    if (!pool || !valid) return { venue: "pool", out: null, price: null, detail: "-" };
    const q = await getPoolClient(net, pool).quoteSwap(direction === "buy", toStroops(valid));
    if (q.amountOut <= 0n) return { venue: "pool", out: null, price: null, detail: "no liquidity", partial: q.partial };
    const out = fromStroops(q.amountOut);
    const price = q.avgPrice > 0n ? Number(q.avgPrice) / 1e7 : direction === "buy" ? Number(valid) / Number(out) : Number(out) / Number(valid);
    return {
      venue: "pool",
      out,
      price,
      detail: `${q.binsCrossed} bin${q.binsCrossed === 1 ? "" : "s"} crossed, fee ${fmt(fromStroops(q.fee), 4)} USDC`,
      partial: q.partial,
      note: q.partial ? "Pool depth is smaller than this size: only part of the input would be used." : undefined,
    };
  }, [net, pool, valid, direction]);
  const poolQ = usePolling(poolFn, 8000, !!pool && !!valid);

  const sdexFn = useCallback(async (): Promise<VenueQuote> => {
    if (!valid) return { venue: "sdex", out: null, price: null, detail: "-" };
    const pay = direction === "buy" ? quote : base;
    const recv = direction === "buy" ? base : quote;
    const recs = await fetchStrictSendPaths(horizon, pay, valid, recv);
    const best = bestPath(recs);
    if (!best) return { venue: "sdex", out: null, price: null, detail: "no path" };
    const route = [pay.code, ...best.path.map((p) => toAssetRef(p).code), recv.code].join(" > ");
    const out = best.destination_amount;
    const price = direction === "buy" ? Number(valid) / Number(out) : Number(out) / Number(valid);
    return { venue: "sdex", out, price, detail: route };
  }, [horizon, valid, direction, base, quote]);
  const sdexQ = usePolling(sdexFn, 8000, !!valid);

  const a = poolQ.data;
  const b = sdexQ.data;
  let better: "pool" | "sdex" | null = null;
  if (a?.price && b?.price) better = direction === "buy" ? (a.price <= b.price ? "pool" : "sdex") : a.price >= b.price ? "pool" : "sdex";
  else if (a?.price) better = "pool";
  else if (b?.price) better = "sdex";

  return {
    valid: !!valid,
    pool: a,
    sdex: b,
    loading: (!!pool && poolQ.loading) || sdexQ.loading,
    errors: [poolQ.error, sdexQ.error].filter(Boolean) as string[],
    better,
  };
}

export function VenueComparison({
  pool,
  direction,
  amountIn,
  base,
  quote,
  horizon,
  compact = false,
}: {
  pool: PoolInstance | undefined;
  direction: "buy" | "sell";
  amountIn: string;
  base: AssetRef;
  quote: AssetRef;
  horizon: string;
  compact?: boolean;
}) {
  const q = useVenueQuotes({ pool, direction, amountIn, base, quote, horizon });
  const outCode = direction === "buy" ? base.code : quote.code;

  if (!pool && !q.valid) return null;
  return (
    <div className={cn("space-y-1.5", compact ? "mt-3" : "mt-4")} data-testid="venue-comparison">
      <div className="flex items-center justify-between">
        <div className="label">Venue comparison</div>
        {pool?.mock ? <span className="text-[10px] text-primary">pool = local simulation</span> : null}
      </div>
      {q.valid ? (
        <>
          {pool ? <VenueRow title="Lotus pool" v={q.pool} id="pool" better={q.better} loading={q.loading} outCode={outCode} quote={quote} base={base} /> : null}
          <VenueRow title="SDEX path payment" v={q.sdex} id="sdex" better={q.better} loading={q.loading} outCode={outCode} quote={quote} base={base} />
          <p className="text-[11px] text-mutedfg">
            Same input on both venues, compared by effective price. Execute the pool leg on <Link href="/pools" className="text-primary underline-offset-2 hover:underline">Pools</Link>; the SDEX leg is the swap above.
          </p>
        </>
      ) : (
        <p className="text-[11px] text-mutedfg">Enter an amount to compare the Lotus pool and the SDEX for the same input.</p>
      )}
    </div>
  );
}

function VenueRow({
  title,
  v,
  id,
  better,
  loading,
  outCode,
  quote,
  base,
}: {
  title: string;
  v: VenueQuote | null | undefined;
  id: "pool" | "sdex";
  better: "pool" | "sdex" | null;
  loading: boolean;
  outCode: string;
  quote: AssetRef;
  base: AssetRef;
}) {
  return (
    <div
      data-testid={`venue-${id}`}
      data-better={better === id ? "1" : "0"}
      className={cn("grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 rounded-xl border px-3 py-2", better === id ? "border-primary/50 bg-primary/5" : "border-border")}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {title}
        {better === id ? <Badge className="h-5 px-1.5 text-[10px]">Better</Badge> : null}
      </div>
      <div className="num text-right text-sm font-medium">{v?.out ? `${fmt(v.out, 4)} ${outCode}` : loading && !v ? <Spinner /> : "-"}</div>
      <div className="min-w-0 truncate text-[11px] text-mutedfg">{v?.detail ?? " "}</div>
      <div className="num text-right text-[11px] text-mutedfg">{v?.price ? `${fmt(v.price, 4, 4)} ${quote.code}/${base.code}` : " "}</div>
      {v?.note ? <div className="col-span-2 text-[11px] text-primary">{v.note}</div> : null}
    </div>
  );
}
