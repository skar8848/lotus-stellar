// Order-book helpers shared by the trade page, the depth charts and the venue comparison.
// Horizon convention: ask `amount` is in BASE; bid `amount` is in QUOTE and bid `price` is quote per base.

import type { OrderBook, PriceLevel } from "./stellar";

export type BookRow = { price: number; priceStr: string; size: number; total: number; cum: number };

/** Normalise Horizon levels to BASE size + QUOTE total, with cumulative BASE depth. */
export function bookRows(levels: PriceLevel[], side: "bid" | "ask", limit = 12): BookRow[] {
  let cum = 0;
  return levels.slice(0, limit).map((l) => {
    const price = Number(l.price);
    const amt = Number(l.amount);
    const size = side === "ask" ? amt : price > 0 ? amt / price : 0;
    const total = side === "ask" ? amt * price : amt;
    cum += size;
    return { price, priceStr: l.price, size, total, cum };
  });
}

export function bestPrices(book: OrderBook | null): { bid: number | null; ask: number | null } {
  const bid = book?.bids[0] ? Number(book.bids[0].price) : null;
  const ask = book?.asks[0] ? Number(book.asks[0].price) : null;
  return { bid: bid !== null && Number.isFinite(bid) ? bid : null, ask: ask !== null && Number.isFinite(ask) ? ask : null };
}

/** Mid of best bid/ask, or the one side that exists, or null. */
export function midPrice(book: OrderBook | null): number | null {
  const { bid, ask } = bestPrices(book);
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return bid ?? ask;
}

export type DepthPoint = { price: number; depth: number; side: "bid" | "ask" };

/** Cumulative depth points normalised to [0, 1] for the chart's right-hand panel. */
export function depthBars(book: OrderBook | null, limit = 30): DepthPoint[] {
  if (!book) return [];
  const bids = bookRows(book.bids, "bid", limit);
  const asks = bookRows(book.asks, "ask", limit);
  const max = Math.max(bids[bids.length - 1]?.cum ?? 0, asks[asks.length - 1]?.cum ?? 0, 1e-12);
  return [
    ...bids.map((r) => ({ price: r.price, depth: r.cum / max, side: "bid" as const })),
    ...asks.map((r) => ({ price: r.price, depth: r.cum / max, side: "ask" as const })),
  ];
}
