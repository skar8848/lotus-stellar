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
  rows = 30,
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
  const allAsks = useMemo(() => bookRows(book?.asks ?? [], "ask", 200), [book]);
  const allBids = useMemo(() => bookRows(book?.bids ?? [], "bid", 200), [book]);
  const asks = allAsks.slice(0, rows);
  const bids = allBids.slice(0, rows);
  const maxCum = Math.max(asks[asks.length - 1]?.cum ?? 0, bids[bids.length - 1]?.cum ?? 0, 1e-12);
  const { bid, ask } = bestPrices(book);
  const mid = midPrice(book);
  const spread = bid !== null && ask !== null ? ask - bid : null;
  const spreadPct = spread !== null && mid ? (spread / mid) * 100 : null;
  // asks are shown best-at-the-bottom, next to the spread
  const asksTop = [...asks].reverse();
  const hiddenAsks = allAsks.length - asks.length;
  const hiddenBids = allBids.length - bids.length;
  const [hover, setHover] = useState<{ side: "bid" | "ask"; i: number } | null>(null);

  // hovering a level highlights it and every level between it and the spread (what a taker would sweep)
  const hRows = hover ? (hover.side === "ask" ? asks : bids) : [];
  const hSum = hover
    ? hRows.slice(0, hover.i + 1).reduce((acc, r) => ({ size: acc.size + r.size, total: acc.total + r.total }), { size: 0, total: 0 })
    : null;

  const Row = ({ r, side, i }: { r: BookRow; side: "bid" | "ask"; i: number }) => {
    const inSweep = hover !== null && hover.side === side && i <= hover.i;
    return (
      <button
        type="button"
        onClick={() => onPick?.(r.priceStr)}
        onMouseEnter={() => setHover({ side, i })}
        data-testid={`book-${side}`}
        data-price={r.priceStr}
        title={`${fmt(r.price, priceDp, priceDp)} ${quoteCode}: ${fmt(r.size, 4)} ${baseCode} (${fmt(r.total, 4)} ${quoteCode}). Click to use the price in a Limit order`}
        className={cn(
          "relative grid w-full shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 px-3 py-[3px] text-left text-[11px] leading-4 transition-colors",
          inSweep ? (side === "bid" ? "bg-green/10" : "bg-red/10") : "",
          hover?.side === side && hover.i === i ? "outline outline-1 -outline-offset-1 outline-white/15" : "",
        )}
      >
        {/* cumulative depth (light) + this level (darker) */}
        <span aria-hidden className={cn("absolute inset-y-0 right-0 transition-all duration-300", side === "bid" ? "bg-green/8" : "bg-red/8")} style={{ width: `${Math.min(100, (r.cum / maxCum) * 100)}%` }} />
        <span aria-hidden className={cn("absolute inset-y-0 right-0 transition-all duration-300", side === "bid" ? "bg-green/20" : "bg-red/20")} style={{ width: `${Math.min(100, (r.size / maxCum) * 100)}%` }} />
        <span className={cn("num relative z-10 whitespace-nowrap font-medium", side === "bid" ? "text-green" : "text-red")}>{fmt(r.priceStr, priceDp, priceDp)}</span>
        <span className="num relative z-10 whitespace-nowrap text-right">{compact(r.size)}</span>
        <span className={cn("num relative z-10 whitespace-nowrap text-right", inSweep ? "text-foreground" : "text-mutedfg")}>{compact(r.cum)}</span>
      </button>
    );
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="order-book" onMouseLeave={() => setHover(null)}>
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border px-3 py-1 text-[10px] font-medium text-mutedfg">
        <span className="flex flex-col leading-tight" title={`Price in ${quoteCode}`}>
          <span className="uppercase tracking-wider">Price</span>
          <span className="truncate text-[9px] font-normal opacity-80">{quoteCode}</span>
        </span>
        <span className="flex flex-col text-right leading-tight" title={`Size of the level in ${baseCode}`}>
          <span className="uppercase tracking-wider">Size</span>
          <span className="truncate text-[9px] font-normal opacity-80">{baseCode}</span>
        </span>
        <span className="flex flex-col text-right leading-tight" title={`Cumulative size from the spread, in ${baseCode}`}>
          <span className="uppercase tracking-wider">Total</span>
          <span className="truncate text-[9px] font-normal opacity-80">{baseCode} cum.</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        {hiddenAsks > 0 ? <div className="shrink-0 px-3 py-1 text-center text-[9px] text-mutedfg">+{hiddenAsks} more level{hiddenAsks > 1 ? "s" : ""} above</div> : null}
        {asksTop.length === 0 ? <div className="py-4 text-center text-xs text-mutedfg">No asks</div> : asksTop.map((r, k) => <Row key={`a${r.priceStr}-${k}`} r={r} side="ask" i={asksTop.length - 1 - k} />)}
      </div>
      <div className="shrink-0 border-y border-border bg-secondary/40 px-3 py-1.5" data-testid="book-mid">
        <div className="flex items-center justify-between gap-2">
          <span className="num text-sm font-bold">{mid !== null ? fmt(mid, priceDp, priceDp) : "--"}</span>
          <span className="num text-[10px] text-mutedfg">
            {spread !== null ? `Spread ${fmt(spread, priceDp, priceDp)} (${fmt(spreadPct, 2, 2)}%)` : bid === null && ask === null ? "empty book" : "one-sided book"}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {bids.length === 0 ? <div className="py-4 text-center text-xs text-mutedfg">No bids</div> : bids.map((r, i) => <Row key={`b${r.priceStr}-${i}`} r={r} side="bid" i={i} />)}
        {hiddenBids > 0 ? <div className="px-3 py-1 text-center text-[9px] text-mutedfg">+{hiddenBids} more level{hiddenBids > 1 ? "s" : ""} below</div> : null}
      </div>
      {hover && hSum ? (
        <div
          className={cn(
            "num pointer-events-none absolute inset-x-2 z-20 rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur",
            // asks sit above the spread: summary over the bids; for a bid, over the far asks
            hover.side === "ask" ? "bottom-2" : "top-9",
          )}
          data-testid="book-hover-summary"
        >
          <div className="flex justify-between gap-2">
            <span className={hover.side === "bid" ? "text-green" : "text-red"}>
              {hover.i + 1} level{hover.i > 0 ? "s" : ""} to {fmt(hRows[hover.i]?.priceStr, priceDp, priceDp)}
            </span>
            <span className="text-mutedfg">avg {hSum.size > 0 ? fmt(hSum.total / hSum.size, priceDp, priceDp) : "--"}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>{fmt(hSum.size, 2, 2)} {baseCode}</span>
            <span>{fmt(hSum.total, 2, 2)} {quoteCode}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Book sizes: full precision up to 99,999.99, then K / M so a column never overflows. */
function compact(n: number): string {
  if (!Number.isFinite(n)) return "--";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e5) return `${(n / 1e3).toFixed(1)}K`;
  return fmt(n, 2, 2);
}

// ---------------------------------------------------------------------------
// Cumulative depth chart (SVG step areas), BASE units against price
// ---------------------------------------------------------------------------

export function DepthChart({ book, height = 150, baseCode = "", quoteCode = "" }: { book: OrderBook | null; height?: number; baseCode?: string; quoteCode?: string }) {
  const bids = useMemo(() => bookRows(book?.bids ?? [], "bid", 40), [book]);
  const asks = useMemo(() => bookRows(book?.asks ?? [], "ask", 40), [book]);
  const [hover, setHover] = useState<{ side: "bid" | "ask"; i: number } | null>(null);
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

  // hover: the level nearest to the cursor (bids left of mid, asks right of it), with its cumulative size + total
  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const price = x0 + ((e.clientX - rect.left) / rect.width) * (x1 - x0);
    let best: { side: "bid" | "ask"; i: number; d: number } | null = null;
    const scan = (rows: BookRow[], side: "bid" | "ask") =>
      rows.forEach((r, i) => {
        const d = Math.abs(r.price - price);
        if (!best || d < best.d) best = { side, i, d };
      });
    scan(bids, "bid");
    scan(asks, "ask");
    const b = best as { side: "bid" | "ask"; i: number; d: number } | null;
    setHover(b ? { side: b.side, i: b.i } : null);
  }
  const rows = hover ? (hover.side === "bid" ? bids : asks) : null;
  const hr = rows && hover ? rows[hover.i] : null;
  const cumTotal = rows && hover ? rows.slice(0, hover.i + 1).reduce((s, r) => s + r.total, 0) : 0;
  const hx = hr ? (X(hr.price) / W) * 100 : 0;
  const hy = hr ? (Y(hr.cum) / H) * height : 0;

  return (
    <div data-testid="depth-chart">
      <div className="relative" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Cumulative depth">
          <path d={stepPath(bids, -1)} fill="rgba(2,199,123,0.18)" stroke="#02c77b" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <path d={stepPath(asks, 1)} fill="rgba(235,54,90,0.18)" stroke="#eb365a" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {mid !== null ? <line x1={X(mid)} x2={X(mid)} y1={6} y2={H - 14} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" /> : null}
          <line x1={0} x2={W} y1={H - 14} y2={H - 14} stroke="rgba(255,255,255,0.12)" vectorEffect="non-scaling-stroke" />
          {hr ? <line x1={X(hr.price)} x2={X(hr.price)} y1={0} y2={H - 14} stroke="rgba(255,255,255,0.35)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {hr && hover ? (
          <>
            <span
              aria-hidden
              className={cn("pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background", hover.side === "bid" ? "bg-green" : "bg-red")}
              style={{ left: `${hx}%`, top: hy }}
            />
            <div
              className="num pointer-events-none absolute z-10 w-[190px] rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur"
              style={{ left: hx > 60 ? `calc(${hx}% - 200px)` : `calc(${hx}% + 10px)`, top: Math.max(4, Math.min(height - 80, hy - 40)) }}
              data-testid="depth-chart-tooltip"
            >
              <div className={cn("font-medium", hover.side === "bid" ? "text-green" : "text-red")}>
                {hover.side === "bid" ? "Bid" : "Ask"} {fmt(hr.priceStr, 4, 4)} <span className="text-mutedfg">{quoteCode}</span>
              </div>
              <div className="flex justify-between gap-2"><span className="text-mutedfg">Size</span><span>{fmt(hr.size, 2, 2)} {baseCode}</span></div>
              <div className="flex justify-between gap-2"><span className="text-mutedfg">Cumulative</span><span>{fmt(hr.cum, 2, 2)} {baseCode}</span></div>
              <div className="flex justify-between gap-2"><span className="text-mutedfg">Total</span><span>{fmt(cumTotal, 2, 2)} {quoteCode}</span></div>
            </div>
          </>
        ) : null}
      </div>
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
  rows = 40,
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
    <div data-testid="recent-trades" className="text-[11px]">
      <div className="sticky top-0 z-10 grid grid-cols-[1fr_1fr_auto_auto] gap-2 border-b border-border bg-background px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-mutedfg">
        <span title={`Price in ${quoteCode}`}>Price</span>
        <span className="text-right" title={`Size in ${baseCode}`}>Size</span>
        <span className="text-right">Time</span>
        <span className="w-8 text-right">Tx</span>
      </div>
      {trades === null ? (
        <Empty>Loading...</Empty>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8">
          <p className="text-sm text-mutedfg">No trades yet</p>
          <p className="mt-1 text-xs text-mutedfg/60">Fills on this market will appear here</p>
        </div>
      ) : (
        <ul>
          {shown.map((t) => (
            <li key={t.id} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-2 border-b border-border/50 px-3 py-[3px] transition-colors hover:bg-white/[0.03]">
              <span className={cn("num", t.baseIsSeller ? "text-green" : "text-red")} title={t.baseIsSeller ? `${baseCode} bought` : `${baseCode} sold`}>
                {fmt(t.price, 4, 4)}
              </span>
              <span className="num text-right">{fmt(t.baseAmount, 2)}</span>
              <span className="num text-right text-mutedfg">{new Date(t.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
              <span className="w-8 text-right">
                {hashes[t.opId] ? <ExplorerLink kind="tx" id={hashes[t.opId]} network={network} label="tx" className="text-[10px]" /> : <span className="text-mutedfg">...</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
