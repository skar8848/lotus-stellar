// Order-book helpers shared by the trade page, the depth charts and the venue comparison.
// Horizon convention: ask `amount` is in BASE; bid `amount` is in QUOTE and bid `price` is quote per base.

import type { AssetRef, Candle, OrderBook, PriceLevel, Trade } from "./stellar";

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

export type DepthPoint = { price: number; depth: number; side: "bid" | "ask"; size: number; cum: number };

/** Cumulative depth points normalised to [0, 1] for the chart's right-hand panel. */
export function depthBars(book: OrderBook | null, limit = 30): DepthPoint[] {
  if (!book) return [];
  const bids = bookRows(book.bids, "bid", limit);
  const asks = bookRows(book.asks, "ask", limit);
  const max = Math.max(bids[bids.length - 1]?.cum ?? 0, asks[asks.length - 1]?.cum ?? 0, 1e-12);
  return [
    ...bids.map((r) => ({ price: r.price, depth: r.cum / max, side: "bid" as const, size: r.size, cum: r.cum })),
    ...asks.map((r) => ({ price: r.price, depth: r.cum / max, side: "ask" as const, size: r.size, cum: r.cum })),
  ];
}

// ---------------------------------------------------------------------------
// Account trades -> one row per user operation.
// Horizon returns one trade per crossed offer, so a path payment USDC > lUSDCb > LBOND is two trades (one per hop)
// that share the operation id. A fill is keyed by (operation, MY offer id on that trade): as the taker my side
// carries the same (synthetic) offer id on every hop, so the hops collapse into one row; as a maker each of my
// resting offers keeps its own row even when one taker operation crosses several of them.

export type AccountTrade = Trade & { base: AssetRef; counter: AssetRef };
export type MarketRef = { id: string; label: string; base: AssetRef; quote: AssetRef };
export type Fill = {
  key: string;
  time: string;
  opId: string;
  tradeIds: string[];
  paid: { asset: AssetRef; amount: number };
  received: { asset: AssetRef; amount: number };
  /** pay asset, every hop asset, receive asset (length 2 for a direct fill) */
  route: AssetRef[];
  routed: boolean;
  /** the configured market of {paid, received}, or null (label falls back to received/paid) */
  marketId: string | null;
  marketLabel: string;
  base: AssetRef;
  quote: AssetRef;
  /** from what the user RECEIVED: base received = Buy */
  side: "Buy" | "Sell";
  /** average price, quote per base */
  price: number;
  size: number;
  total: number;
};

const akey = (a: AssetRef) => (a.issuer ? `${a.code}:${a.issuer}` : "native");
const stroops = (s: string) => Math.round(Number(s) * 1e7);
/** Horizon trade ids are "<toid>-<index>": order the hops of one operation by index. */
const tradeIndex = (id: string) => Number(id.split("-")[1] ?? 0);

export function groupAccountTrades(trades: AccountTrade[], me: string, markets: MarketRef[]): Fill[] {
  const groups = new Map<string, AccountTrade[]>();
  const order: string[] = [];
  for (const t of trades) {
    const mine = t.counterAccount === me ? t.counterOfferId : t.baseOfferId;
    const k = `${t.opId || t.id}:${mine ?? ""}`;
    const g = groups.get(k);
    if (g) g.push(t);
    else {
      groups.set(k, [t]);
      order.push(k);
    }
  }
  const out: Fill[] = [];
  for (const k of order) {
    const g = [...groups.get(k)!].sort((a, b) => tradeIndex(a.id) - tradeIndex(b.id));
    const net = new Map<string, { asset: AssetRef; v: number }>();
    const add = (a: AssetRef, v: number) => {
      const e = net.get(akey(a)) ?? { asset: a, v: 0 };
      e.v += v;
      net.set(akey(a), e);
    };
    const route: AssetRef[] = [];
    for (const t of g) {
      // the counter account receives the base (base_is_seller only says which side rested)
      const boughtBase = t.counterAccount === me;
      const gave = boughtBase ? t.counter : t.base;
      const got = boughtBase ? t.base : t.counter;
      add(got, stroops(boughtBase ? t.baseAmount : t.counterAmount));
      add(gave, -stroops(boughtBase ? t.counterAmount : t.baseAmount));
      if (route.length === 0) route.push(gave);
      if (akey(route[route.length - 1]) !== akey(got)) route.push(got);
    }
    const entries = [...net.values()];
    const paidE = entries.reduce((m, e) => (e.v < m.v ? e : m), entries[0]);
    const recvE = entries.reduce((m, e) => (e.v > m.v ? e : m), entries[0]);
    const paid = { asset: paidE.asset, amount: -paidE.v / 1e7 };
    const received = { asset: recvE.asset, amount: recvE.v / 1e7 };
    const direct = markets.find((m) => akey(m.base) === akey(received.asset) && akey(m.quote) === akey(paid.asset));
    const reversed = direct ? null : markets.find((m) => akey(m.base) === akey(paid.asset) && akey(m.quote) === akey(received.asset));
    const m = direct ?? reversed;
    const buy = !reversed; // unknown pair: shown as "received / paid", a Buy of what was received
    const base = buy ? received.asset : paid.asset;
    const quote = buy ? paid.asset : received.asset;
    const size = buy ? received.amount : paid.amount;
    const total = buy ? paid.amount : received.amount;
    out.push({
      key: k,
      time: g[0].time,
      opId: g[0].opId,
      tradeIds: g.map((t) => t.id),
      paid,
      received,
      route,
      routed: route.length > 2,
      marketId: m?.id ?? null,
      marketLabel: m?.label ?? `${base.code}/${quote.code}`,
      base,
      quote,
      side: buy ? "Buy" : "Sell",
      price: size > 0 ? total / size : NaN,
      size,
      total,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candles: Horizon /trade_aggregations only returns buckets that had trades. For a continuous chart, the empty
// buckets get a FLAT candle at the previous close with zero volume and `filled: true` (drawn muted, labelled
// "no trades"), never an invented trade. Filling runs from the first candle to the current bucket, at most
// `maxBars` buckets back from now; older real candles are kept as they are.

export type ChartCandle = Candle & { filled?: boolean };

export function fillCandleGaps(candles: Candle[], resolutionMs: number, nowMs: number, maxBars = 2000): ChartCandle[] {
  if (candles.length === 0) return [];
  const res = Math.round(resolutionMs / 1000);
  const nowBucket = Math.floor(nowMs / 1000 / res) * res;
  const windowStart = nowBucket - (maxBars - 1) * res;
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const out: ChartCandle[] = [];
  let prev: Candle | null = null;
  const flat = (time: number, close: number): ChartCandle => ({ time, open: close, high: close, low: close, close, volume: 0, trades: 0, filled: true });
  for (const c of sorted) {
    if (prev) for (let t = Math.max(prev.time + res, windowStart); t < c.time; t += res) out.push(flat(t, prev.close));
    out.push(c);
    prev = c;
  }
  if (prev) for (let t = Math.max(prev.time + res, windowStart); t <= nowBucket; t += res) out.push(flat(t, prev.close));
  return out;
}

/** Exponential moving average of the closes (seeded with the first close). */
export function ema(values: number[], length: number): number[] {
  const k = 2 / (length + 1);
  const out: number[] = [];
  let e = values[0];
  for (const v of values) {
    e = out.length === 0 ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
