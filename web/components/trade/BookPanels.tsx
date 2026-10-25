"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { bestPrices, bookRows, midPrice, type BookRow } from "@/lib/book";
import { fetchOperationTxHash, fmt, type OrderBook, type Trade } from "@/lib/stellar";
import { Empty, ExplorerLink } from "@/components/common";

// ---------------------------------------------------------------------------
// Order book table: asks above, spread in the middle, bids below. Click a price to use it in the Limit tab.
// ---------------------------------------------------------------------------

export function OrderBookTable({
  book,
  baseCode,
  quoteCode,
  rows = 8,
  priceDp = 4,
  onPick,
}: {
  book: OrderBook | null;
  baseCode: string;
  quoteCode: string;
  rows?: number;
  priceDp?: number;
  onPick?: (price: string) => void;
}) {
  const asks = useMemo(() => bookRows(book?.asks ?? [], "ask", rows), [book, rows]);
  const bids = useMemo(() => bookRows(book?.bids ?? [], "bid", rows), [book, rows]);
  const maxCum = Math.max(asks[asks.length - 1]?.cum ?? 0, bids[bids.length - 1]?.cum ?? 0, 1e-12);
  const { bid, ask } = bestPrices(book);
  const mid = midPrice(book);
  const spreadPct = bid !== null && ask !== null && mid ? ((ask - bid) / mid) * 100 : null;
  // asks are shown best-at-the-bottom, next to the spread
  const asksTop = [...asks].reverse();

  const Row = ({ r, side }: { r: BookRow; side: "bid" | "ask" }) => (
    <button
      type="button"
      onClick={() => onPick?.(r.priceStr)}
      data-testid={`book-${side}`}
      className="relative grid w-full grid-cols-3 gap-2 overflow-hidden rounded-sm px-1.5 py-[3px] text-left text-xs hover:bg-white/5"
    >
      <span
        aria-hidden
        className={cn("absolute inset-y-0 right-0", side === "bid" ? "bg-green/12" : "bg-red/12")}
        style={{ width: `${Math.min(100, (r.cum / maxCum) * 100)}%` }}
      />
      <span className={cn("num relative", side === "bid" ? "text-green" : "text-red")}>{fmt(r.priceStr, priceDp, priceDp)}</span>
      <span className="num relative text-right">{fmt(r.size, 2)}</span>
      <span className="num relative text-right text-mutedfg">{fmt(r.total, 2)}</span>
    </button>
  );

  return (
    <div data-testid="order-book">
      <div className="label mb-1 grid grid-cols-3 gap-2 px-1.5">
        <span>Price {quoteCode}</span>
        <span className="text-right">Size {baseCode}</span>
        <span className="text-right">Total</span>
      </div>
      {asksTop.length === 0 ? <Empty className="py-3">No asks</Empty> : asksTop.map((r, i) => <Row key={`a${r.priceStr}-${i}`} r={r} side="ask" />)}
      <div className="my-1 flex items-center justify-between border-y border-border px-1.5 py-1.5 text-xs">
        <span className="num text-base font-medium">{mid !== null ? fmt(mid, priceDp, priceDp) : "-"}</span>
        <span className="text-mutedfg">
          {bid !== null && ask !== null ? `spread ${fmt(spreadPct, 2)}%` : bid === null && ask === null ? "empty book" : "one-sided book"}
        </span>
      </div>
      {bids.length === 0 ? <Empty className="py-3">No bids</Empty> : bids.map((r, i) => <Row key={`b${r.priceStr}-${i}`} r={r} side="bid" />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cumulative depth chart (SVG step areas), BASE units against price
// ---------------------------------------------------------------------------

export function DepthChart({ book, height = 150 }: { book: OrderBook | null; height?: number }) {
  const bids = useMemo(() => bookRows(book?.bids ?? [], "bid", 40), [book]);
  const asks = useMemo(() => bookRows(book?.asks ?? [], "ask", 40), [book]);
  if (bids.length === 0 && asks.length === 0) return <Empty>Empty book: nothing to draw.</Empty>;

  const prices = [...bids, ...asks].map((r) => r.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || Math.max(hi * 0.02, 1e-6);
  const pad = span * 0.08;
  const x0 = lo - pad;
  const x1 = hi + pad;
  const maxCum = Math.max(bids[bids.length - 1]?.cum ?? 0, asks[asks.length - 1]?.cum ?? 0, 1e-12);
  const W = 600;
  const H = 200;
  const X = (p: number) => ((p - x0) / (x1 - x0)) * W;
  const Y = (c: number) => H - 14 - (c / maxCum) * (H - 28);

  // bids accumulate going DOWN in price from the best bid; asks going UP from the best ask
  const stepPath = (rows: BookRow[], dir: 1 | -1) => {
    if (rows.length === 0) return "";
    let d = `M${X(rows[0].price)},${Y(0)}`;
    let prevCum = 0;
    for (const r of rows) {
      d += ` L${X(r.price)},${Y(prevCum)} L${X(r.price)},${Y(r.cum)}`;
      prevCum = r.cum;
    }
    const last = rows[rows.length - 1];
    d += ` L${X(last.price + dir * pad * 0.5)},${Y(prevCum)} L${X(last.price + dir * pad * 0.5)},${Y(0)} Z`;
    return d;
  };
  const mid = midPrice(book);

  return (
    <div data-testid="depth-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Cumulative depth">
        <path d={stepPath(bids, -1)} fill="rgba(2,199,123,0.18)" stroke="#02c77b" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={stepPath(asks, 1)} fill="rgba(235,54,90,0.18)" stroke="#eb365a" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {mid !== null ? <line x1={X(mid)} x2={X(mid)} y1={6} y2={H - 14} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" /> : null}
        <line x1={0} x2={W} y1={H - 14} y2={H - 14} stroke="rgba(255,255,255,0.12)" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="num mt-1 flex justify-between text-[11px] text-mutedfg">
        <span>{fmt(lo, 4, 4)}</span>
        <span>{mid !== null ? `mid ${fmt(mid, 4, 4)}` : ""}</span>
        <span>{fmt(hi, 4, 4)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent trades with a stellar.expert link per trade (operation -> tx hash resolved lazily and cached)
// ---------------------------------------------------------------------------

export function RecentTrades({
  trades,
  horizon,
  baseCode,
  quoteCode,
  network,
  rows = 12,
}: {
  trades: Trade[] | null;
  horizon: string;
  baseCode: string;
  quoteCode: string;
  network: string;
  rows?: number;
}) {
  const shown = useMemo(() => (trades ?? []).slice(0, rows), [trades, rows]);
  const [hashes, setHashes] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const missing = shown.filter((t) => t.opId && !hashes[t.opId]);
    if (missing.length === 0) return;
    const ids = [...new Set(missing.map((t) => t.opId))];
    Promise.all(ids.map((id) => fetchOperationTxHash(horizon, id).then((h) => [id, h] as const))).then((pairs) => {
      if (!alive) return;
      setHashes((cur) => {
        const next = { ...cur };
        for (const [id, h] of pairs) if (h) next[id] = h;
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // hashes is intentionally not a dependency: it is only ever extended
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, horizon]);

  return (
    <div data-testid="recent-trades">
      <div className="label mb-1 grid grid-cols-[1fr_1fr_auto_auto] gap-2 px-1.5">
        <span>Price {quoteCode}</span>
        <span className="text-right">Size {baseCode}</span>
        <span className="text-right">Time</span>
        <span className="w-12 text-right">Tx</span>
      </div>
      {trades === null ? (
        <Empty>Loading...</Empty>
      ) : shown.length === 0 ? (
        <Empty>No trades on this market yet.</Empty>
      ) : (
        <ul>
          {shown.map((t) => (
            <li key={t.id} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 px-1.5 py-[3px] text-xs">
              <span className={cn("num", t.baseIsSeller ? "text-green" : "text-red")}>{fmt(t.price, 4, 4)}</span>
              <span className="num text-right">{fmt(t.baseAmount, 2)}</span>
              <span className="num text-right text-mutedfg">{new Date(t.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className="w-12 text-right">
                {hashes[t.opId] ? <ExplorerLink kind="tx" id={hashes[t.opId]} network={network} label="tx" /> : <span className="text-mutedfg">...</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
