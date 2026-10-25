// Order book math. Horizon /order_book?selling_asset=BASE&buying_asset=COUNTER:
//   asks = offers SELLING base for counter, price = counter per 1 base, Horizon amount in base units
//   bids = offers BUYING  base with counter, price = counter per 1 base, Horizon amount in COUNTER units (!)
// parseBook() below converts both sides to base units.
// Prices are floats for decisions; every amount that goes into a transaction is built with BigInt stroops.

import { fromStroops, toStroops } from '../../lib/stellar.mjs';

export const SCALE = 10_000_000n;

/**
 * Horizon /order_book quirk (verified on testnet against the offers' own amounts): ask amounts are in BASE units,
 * but BID amounts are the raw offer amount, i.e. in COUNTER units (a bid of 99.99 USDC for lUSDC at 0.9999 is listed as
 * "0.9999 x 99.99", it is 100 lUSDC). Everything downstream wants base units, so bids are converted here.
 */
export function parseBook(ob) {
  const ask = (o) => ({ price: Number(o.price), n: Number(o.price_r?.n), d: Number(o.price_r?.d), amount: Number(o.amount), counterAmount: Number(o.amount) * Number(o.price) });
  const bid = (o) => ({ price: Number(o.price), n: Number(o.price_r?.n), d: Number(o.price_r?.d), amount: Number(o.amount) / Number(o.price), counterAmount: Number(o.amount) });
  return { bids: (ob.bids ?? []).map(bid), asks: (ob.asks ?? []).map(ask), at: Date.now() };
}

export const bestBid = (b) => b.bids[0] ?? null;
export const bestAsk = (b) => b.asks[0] ?? null;

export function midOf(b) {
  const bb = bestBid(b);
  const ba = bestAsk(b);
  if (bb && ba) return (bb.price + ba.price) / 2;
  return bb?.price ?? ba?.price ?? null;
}

/** (a - b) / b in basis points. */
export const bps = (a, b) => ((a - b) / b) * 10_000;

/** Sum of ask depth (base units) at price <= maxPrice. */
export function askDepthUpTo(book, maxPrice) {
  let amt = 0;
  for (const l of book.asks) if (l.price <= maxPrice + 1e-12) amt += l.amount;
  return amt;
}

/** Sum of bid depth (base units) at price >= minPrice. */
export function bidDepthDownTo(book, minPrice) {
  let amt = 0;
  for (const l of book.bids) if (l.price >= minPrice - 1e-12) amt += l.amount;
  return amt;
}

/**
 * Cost (counter units) of buying `baseAmount` base from the asks, walking the book. Returns
 * {cost, filled, avg, worst}; filled < baseAmount when the book is too thin.
 */
export function walkAsks(book, baseAmount) {
  let left = baseAmount;
  let cost = 0;
  let worst = null;
  for (const l of book.asks) {
    if (left <= 1e-9) break;
    const take = Math.min(left, l.amount);
    cost += take * l.price;
    left -= take;
    worst = l.price;
  }
  const filled = baseAmount - left;
  return { cost, filled, avg: filled > 0 ? cost / filled : null, worst };
}

/** Proceeds (counter units) of selling `baseAmount` base into the bids. */
export function walkBids(book, baseAmount) {
  let left = baseAmount;
  let proceeds = 0;
  let worst = null;
  for (const l of book.bids) {
    if (left <= 1e-9) break;
    const take = Math.min(left, l.amount);
    proceeds += take * l.price;
    left -= take;
    worst = l.price;
  }
  const filled = baseAmount - left;
  return { proceeds, filled, avg: filled > 0 ? proceeds / filled : null, worst };
}

// ------------------------------------------------------------------ exact amounts

/** number -> 7-decimal string, rounded to nearest. */
export function amt7(x) {
  return fromStroops(BigInt(Math.round(Number(x) * 1e7)));
}
/** number -> 7-decimal string, rounded DOWN (never promise more than we have). */
export function amt7Floor(x) {
  return fromStroops(BigInt(Math.floor(Number(x) * 1e7 + 1e-6)));
}
/** number -> 7-decimal string, rounded UP. */
export function amt7Ceil(x) {
  return fromStroops(BigInt(Math.ceil(Number(x) * 1e7 - 1e-6)));
}

/** Rational price {n, d} for a float price, d = 1e7 (n must fit int32, so price < 214). */
export function priceFrac(p) {
  const d = 10_000_000;
  const n = Math.round(p * d);
  if (n <= 0 || n > 2_147_483_647) throw new Error(`price out of range: ${p}`);
  return { n, d };
}
/**
 * Offer price (units of `buying` per 1 `selling`) for a BID quoted at b = (selling per buying)... precisely:
 * a bid that sells X to buy Y at a quoted price b (X per 1 Y) has offer price 1/b = 1e7 / round(b*1e7).
 * Built as {n: 1e7, d: B} so the effective quote d/n = B/1e7 is exactly b rounded to 7 decimals.
 */
export function invPriceFrac(b) {
  const d = Math.round(b * 10_000_000);
  if (d <= 0 || d > 2_147_483_647) throw new Error(`price out of range: 1/${b}`);
  return { n: 10_000_000, d };
}

export { toStroops, fromStroops };
