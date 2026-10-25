// Range builder math (pure, BigInt stroops, no React). Turns "price range + levels + size + shape"
// into the list of SDEX offers that one transaction will carry.
//
// Conventions (same as the order book): every price is QUOTE per BASE.
//   ask  = sell BASE for QUOTE at price p                -> manageSellOffer(selling=base,  buying=quote, price = p)
//   bid  = buy BASE with QUOTE at price p (sell QUOTE)   -> manageSellOffer(selling=quote, buying=base,  price = 1/p)
//
// Modes:
//   sell : asks only   (one-way exit: sell the base across the range)
//   buy  : bids only   (one-way accumulate: buy the base across the range)
//   band : bids below `split`, asks at or above it (two-sided market making)
//
// A filled level never flips back by itself (unlike an AMM position): re-quote to continue.

import { SCALE, divRound, fromStroops, gcd, tryStroops } from "./amount.ts";

export type RangeMode = "sell" | "buy" | "band";
export type Shape = "uniform" | "start" | "end";

export const MIN_LEVELS = 2;
export const MAX_LEVELS = 50;
/** XLM base reserve locked per open offer (one subentry). */
export const RESERVE_PER_OFFER_XLM = 0.5;
export const MAX_OPS_PER_TX = 100;

export type RangeInput = {
  mode: RangeMode;
  /** first level, quote per base */
  from: string;
  /** last level, quote per base */
  to: string;
  levels: number;
  /** total size in BASE units (decimal string) */
  totalBase: string;
  shape: Shape;
  /** band mode: levels strictly below this price are bids, the rest asks */
  split?: string;
};

export type RangeLevel = {
  index: number;
  side: "ask" | "bid";
  /** quote per base, 7dp decimal string */
  price: string;
  priceStroops: bigint;
  /** size of the level in BASE stroops */
  baseAmount: bigint;
  /** amount of the SOLD asset in stroops: base for an ask, quote for a bid */
  sellAmount: bigint;
  /** quote value of the level in stroops (price * base) */
  quoteValue: bigint;
  weight: number;
};

export type RangeSummary = {
  offers: number;
  asks: number;
  bids: number;
  totalBase: bigint;
  /** size-weighted average price (quote per base), null when empty */
  avgPrice: number | null;
  /** BASE you must hold free to post the asks */
  needBase: bigint;
  /** QUOTE you must hold free to post the bids */
  needQuote: bigint;
  /** XLM reserve locked by the offers (0.5 each) */
  reserveXlm: number;
  /** transactions needed at 100 ops each */
  txCount: number;
};

export type RangeResult = { levels: RangeLevel[]; summary: RangeSummary; errors: string[] };

export function shapeWeights(shape: Shape, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (shape === "uniform" ? 1 : shape === "start" ? n - i : i + 1));
}

const emptySummary: RangeSummary = {
  offers: 0,
  asks: 0,
  bids: 0,
  totalBase: 0n,
  avgPrice: null,
  needBase: 0n,
  needQuote: 0n,
  reserveXlm: 0,
  txCount: 0,
};

export function buildRange(input: RangeInput): RangeResult {
  const errors: string[] = [];
  const n = Math.floor(input.levels);
  const from = tryStroops(input.from);
  const to = tryStroops(input.to);
  const total = tryStroops(input.totalBase);

  if (!Number.isFinite(n) || n < MIN_LEVELS || n > MAX_LEVELS) errors.push(`Levels must be between ${MIN_LEVELS} and ${MAX_LEVELS}.`);
  if (from === null || from <= 0n) errors.push("Enter a start price.");
  if (to === null || to <= 0n) errors.push("Enter an end price.");
  if (from !== null && to !== null && from > 0n && to > 0n && from === to) errors.push("Start and end price must differ.");
  if (total === null || total <= 0n) errors.push("Enter a total size.");
  if (errors.length > 0 || from === null || to === null || total === null) return { levels: [], summary: emptySummary, errors };

  // evenly spaced prices, rounded to the 7dp tick
  const prices: bigint[] = Array.from({ length: n }, (_, i) => from + divRound((to - from) * BigInt(i), BigInt(n - 1)));
  if (prices.some((p) => p <= 0n)) {
    errors.push("A level price rounds to zero.");
    return { levels: [], summary: emptySummary, errors };
  }

  // sizes: integer weights, floor, remainder to the heaviest level so the total is exact
  const weights = shapeWeights(input.shape, n);
  const wSum = BigInt(weights.reduce((a, b) => a + b, 0));
  const sizes = weights.map((w) => (total * BigInt(w)) / wSum);
  const rest = total - sizes.reduce((a, b) => a + b, 0n);
  let heavy = 0;
  weights.forEach((w, i) => {
    if (w > weights[heavy]) heavy = i;
  });
  sizes[heavy] += rest;
  if (sizes.some((s) => s <= 0n)) errors.push("Total size is too small to give every level at least 0.0000001.");

  // band split
  let split: bigint | null = null;
  if (input.mode === "band") {
    split = tryStroops(input.split ?? "");
    if (split === null || split <= 0n) {
      // default: the middle of the range
      split = (from + to) / 2n;
    }
  }

  const levels: RangeLevel[] = prices.map((p, i) => {
    const side: "ask" | "bid" = input.mode === "sell" ? "ask" : input.mode === "buy" ? "bid" : p < (split as bigint) ? "bid" : "ask";
    const base = sizes[i];
    const quoteValue = divRound(base * p, SCALE);
    return {
      index: i,
      side,
      price: fromStroops(p),
      priceStroops: p,
      baseAmount: base,
      sellAmount: side === "ask" ? base : quoteValue,
      quoteValue,
      weight: weights[i],
    };
  });
  if (levels.some((l) => l.sellAmount <= 0n)) errors.push("Total size is too small: a level would sell 0.");

  return { levels, summary: summarize(levels), errors };
}

export function summarize(levels: RangeLevel[]): RangeSummary {
  if (levels.length === 0) return emptySummary;
  const totalBase = levels.reduce((a, l) => a + l.baseAmount, 0n);
  const value = levels.reduce((a, l) => a + l.quoteValue, 0n);
  const asks = levels.filter((l) => l.side === "ask");
  const bids = levels.filter((l) => l.side === "bid");
  return {
    offers: levels.length,
    asks: asks.length,
    bids: bids.length,
    totalBase,
    avgPrice: totalBase > 0n ? Number(value) / Number(totalBase) : null,
    needBase: asks.reduce((a, l) => a + l.sellAmount, 0n),
    needQuote: bids.reduce((a, l) => a + l.sellAmount, 0n),
    reserveXlm: levels.length * RESERVE_PER_OFFER_XLM,
    txCount: Math.ceil(levels.length / MAX_OPS_PER_TX),
  };
}

/** How many levels would cross the current book and fill immediately (as a taker). */
export function crossingCount(levels: RangeLevel[], bestBid: number | null, bestAsk: number | null): number {
  return levels.filter((l) => {
    const p = Number(l.price);
    return l.side === "ask" ? bestBid !== null && p <= bestBid : bestAsk !== null && p >= bestAsk;
  }).length;
}

/**
 * Price argument for manageSellOffer as an exact reduced rational n/d (int32 each), or null if it
 * does not fit (then the caller falls back to a decimal string and lets the SDK approximate).
 *   ask: price = p            -> n/d = p_stroops / 1e7
 *   bid: price = 1/p          -> n/d = 1e7 / p_stroops
 */
export function offerPrice(level: Pick<RangeLevel, "side" | "priceStroops">): { n: number; d: number } | null {
  let n = level.side === "ask" ? level.priceStroops : SCALE;
  let d = level.side === "ask" ? SCALE : level.priceStroops;
  const g = gcd(n, d);
  n /= g;
  d /= g;
  const MAX = 2147483647n;
  if (n <= 0n || d <= 0n || n > MAX || d > MAX) return null;
  return { n: Number(n), d: Number(d) };
}

/** Split a list into chunks of at most `size`. */
export function chunkOps<T>(items: T[], size = MAX_OPS_PER_TX): T[][] {
  const out: T[][] = [];
  const s = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += s) out.push(items.slice(i, i + s));
  return out;
}
