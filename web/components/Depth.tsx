"use client";

import { fmt, type OrderBook, type PriceLevel } from "@/lib/stellar";

type Row = { price: string; size: number; total: number; cum: number };

/**
 * Horizon convention: ask `amount` is in the base (selling) asset, bid `amount` is in the
 * counter (buying) asset. Normalise both to base-asset size + counter-asset total.
 */
function toRows(levels: PriceLevel[], side: "bid" | "ask"): Row[] {
  let cum = 0;
  return levels.map((l) => {
    const price = Number(l.price);
    const amt = Number(l.amount);
    const size = side === "ask" ? amt : price > 0 ? amt / price : 0;
    const total = side === "ask" ? amt * price : amt;
    cum += size;
    return { price: l.price, size, total, cum };
  });
}

export function Depth({
  book,
  baseCode,
  counterCode,
  rows = 10,
  priceDp = 4,
  sizeDp = 2,
  compact = false,
}: {
  book: OrderBook | null;
  baseCode: string;
  counterCode: string;
  rows?: number;
  priceDp?: number;
  sizeDp?: number;
  compact?: boolean;
}) {
  const bids = toRows((book?.bids ?? []).slice(0, rows), "bid");
  const asks = toRows((book?.asks ?? []).slice(0, rows), "ask");
  const maxCum = Math.max(bids[bids.length - 1]?.cum ?? 0, asks[asks.length - 1]?.cum ?? 0, 1e-9);
  const bestBid = bids[0] ? Number(bids[0].price) : null;
  const bestAsk = asks[0] ? Number(asks[0].price) : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const spreadPct = bestBid !== null && bestAsk !== null && mid ? ((bestAsk - bestBid) / mid) * 100 : null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted-fg">
        <span>
          Bid <span className="num text-green">{fmt(bestBid, priceDp)}</span>
        </span>
        <span className="num">
          Mid <span className="text-foreground">{fmt(mid, priceDp)}</span>
          {!compact ? (
            <>
              {" "}
              · Spread <span className="text-foreground">{spreadPct === null ? "—" : `${fmt(spreadPct, 2)}%`}</span>
            </>
          ) : null}
        </span>
        <span>
          Ask <span className="num text-red">{fmt(bestAsk, priceDp)}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Side rows={bids} side="bid" maxCum={maxCum} baseCode={baseCode} counterCode={counterCode} priceDp={priceDp} sizeDp={sizeDp} compact={compact} />
        <Side rows={asks} side="ask" maxCum={maxCum} baseCode={baseCode} counterCode={counterCode} priceDp={priceDp} sizeDp={sizeDp} compact={compact} />
      </div>
    </div>
  );
}

function Side({
  rows,
  side,
  maxCum,
  baseCode,
  counterCode,
  priceDp,
  sizeDp,
  compact,
}: {
  rows: Row[];
  side: "bid" | "ask";
  maxCum: number;
  baseCode: string;
  counterCode: string;
  priceDp: number;
  sizeDp: number;
  compact: boolean;
}) {
  const isBid = side === "bid";
  const color = isBid ? "text-green" : "text-red";
  const cells = (r: Row) => {
    const price = (
      <span key="p" className={`num ${color}`}>
        {fmt(r.price, priceDp, priceDp)}
      </span>
    );
    const size = (
      <span key="s" className="num">
        {fmt(r.size, sizeDp)}
      </span>
    );
    const total = (
      <span key="t" className={`num text-muted-fg ${compact ? "hidden" : "hidden sm:inline"}`}>
        {fmt(r.total, sizeDp)}
      </span>
    );
    return isBid ? [total, size, price] : [price, size, total];
  };
  const heads = isBid ? [`Total ${counterCode}`, `Size ${baseCode}`, "Price"] : ["Price", `Size ${baseCode}`, `Total ${counterCode}`];
  const gridCols = compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3";

  return (
    <div className="min-w-0">
      <div className={`label mb-1 grid ${gridCols} gap-2 ${isBid ? "text-right" : "text-left"}`}>
        {heads.map((h, i) => {
          const hideable = isBid ? i === 0 : i === 2;
          return (
            <span key={h} className={hideable ? (compact ? "hidden" : "hidden sm:inline") : ""}>
              {h}
            </span>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted">{isBid ? "No bids" : "No asks"}</div>
      ) : (
        <ul className="space-y-px">
          {rows.map((r, i) => (
            <li key={`${r.price}-${i}`} className="relative overflow-hidden rounded-sm">
              <span
                aria-hidden
                className={`absolute inset-y-0 ${isBid ? "right-0 bg-green/12" : "left-0 bg-red/12"}`}
                style={{ width: `${Math.min(100, (r.cum / maxCum) * 100)}%` }}
              />
              <div className={`relative grid ${gridCols} gap-2 px-1.5 py-[3px] text-xs ${isBid ? "text-right" : "text-left"}`}>{cells(r)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
