// "New order" routing (pure, BigInt, no React, no SDK): one directional range limit order, and where it waits.
//
// A range limit order is built once with the pool grid (lib/poolGrid.ts planPosition: bins, weights, per-bin
// amounts). The user then picks, at creation only:
//   venue  "pool" | "sdex"   where the order rests
//   yield  off | on          whether the USDC side earns while it waits
// which gives four destinations:
//   pool + off : add_position(Directional) on the pool instance without a vault (USDC idle)          1 signature
//   pool + on  : add_position(Directional) on the pool instance whose USDC leg sits in DeFindex/Blend 1 signature
//   sdex + off : one classic tx, one manageSellOffer per bin on BASE/USDC                            1 signature
//   sdex + on  : the same ladder quoted in the Lotus receipt (BASE/receipt). Ask: 1 classic tx.
//                Bid: lotus_vault.deposit(USDC) (Soroban) then the classic ladder that sells the receipt: 2 signatures
//
// Ladder mapping (SDEX): each bin of the plan becomes ONE offer at price_at(bin), with the bin's own amount.
//   Ask: manageSellOffer(selling BASE,  buying QUOTE, amount = bin amount in BASE,  price = p / 1e7)
//   Bid: manageSellOffer(selling QUOTE, buying BASE,  amount = bin amount in QUOTE, price = 1e7 / p)
// p = price_at(bin) is an integer number of stroops (QUOTE per BASE, fixed point 1e7), so both prices are exact
// rationals; reduced by their gcd they fit int32 for every bin of the grid (p <= 1e7 * 1.001^200 < 1.23e7).
// Nothing is rounded beyond what the grid itself does (price_at rounds half-up, same integer as the contract) and
// what planPosition does to split the amount (floor per bin, remainder on the heaviest bin). When an offer fills,
// the protocol rounds the counter amount of each trade in favour of the offer owner (stellar-core rules).

import { SCALE, divRound, fromStroops, gcd } from "./amount.ts";
import { MAX_BIN, MIN_BIN, priceAt, type PositionPlan, type Side } from "./poolGrid.ts";

export type Venue = "pool" | "sdex";

/** At most this many SDEX levels: one transaction (with up to 2 changeTrust ops in front) stays far below 100 ops. */
export const MAX_SDEX_LEVELS = 50;

/**
 * Curator rule (UI only, the contract is unchanged): a Bid resting in the vault-backed pool has its USDC recalled
 * from DeFindex by every swap that fills it. When the top bin is closer than this many bins below the reference
 * price, the yield toggle is disabled for Bid + Pool.
 */
export const PROXIMITY_MIN_BINS = 10;

export type LadderOffer = {
  bin: number;
  /** grid price, QUOTE per BASE, stroops */
  priceStroops: bigint;
  /** manageSellOffer price as an exact reduced rational (selling asset priced in the buying asset) */
  price: { n: number; d: number };
  /** amount of the SOLD asset in stroops: BASE for an ask, QUOTE for a bid */
  sellAmount: bigint;
  /** BASE-equivalent size of the level in stroops */
  baseAmount: bigint;
};

export type Ladder = { side: Side; offers: LadderOffer[]; errors: string[] };

const INT32_MAX = 2147483647n;

/** Exact offer price for a grid price: ask p/1e7, bid 1e7/p, reduced. Throws if it does not fit int32 (never on the grid). */
export function offerPriceForBin(side: Side, priceStroops: bigint): { n: number; d: number } {
  let n = side === "Ask" ? priceStroops : SCALE;
  let d = side === "Ask" ? SCALE : priceStroops;
  const g = gcd(n, d);
  n /= g;
  d /= g;
  if (n <= 0n || d <= 0n || n > INT32_MAX || d > INT32_MAX) throw new Error(`price ${priceStroops} does not fit an SDEX rational`);
  return { n: Number(n), d: Number(d) };
}

/** Bins of a plan -> SDEX offers (one per bin, same amounts). */
export function ladderFromPlan(plan: PositionPlan, maxLevels = MAX_SDEX_LEVELS): Ladder {
  const errors: string[] = [];
  if (!plan.ok) return { side: plan.side, offers: [], errors: plan.errors.length > 0 ? plan.errors : ["Invalid range"] };
  if (plan.bins.length > maxLevels)
    errors.push(`On the SDEX each bin is one offer: ${plan.bins.length} bins is more than ${maxLevels} (narrow the range).`);
  const offers = plan.bins
    .filter((b) => b.amount > 0n)
    .map((b) => ({
      bin: b.bin,
      priceStroops: b.price,
      price: offerPriceForBin(plan.side, b.price),
      sellAmount: b.amount,
      baseAmount: b.baseSize,
    }));
  return { side: plan.side, offers, errors };
}

/** Distance, in bins (fractional), from the top of a range down to the reference price. Negative when above it. */
export function binsBelowReference(hiBin: number, stepBps: number, refPrice: number): number {
  if (!(refPrice > 0)) return Infinity;
  const top = Number(priceAt(hiBin, stepBps)) / Number(SCALE);
  return Math.log(refPrice / top) / Math.log(1 + stepBps / 10_000);
}

export type YieldGuard = { blocked: boolean; reason: string | null; distance: number | null };

export const PROXIMITY_REASON = "Too close to the price";

/** Proximity rule: only Bid + Pool can be blocked; Ask and SDEX are never blocked. */
export function yieldGuard(i: { side: Side; venue: Venue; hiBin: number; stepBps: number; refPrice: number }): YieldGuard {
  if (i.side !== "Bid" || i.venue !== "pool") return { blocked: false, reason: null, distance: null };
  const distance = binsBelowReference(i.hiBin, i.stepBps, i.refPrice);
  // grid prices are rounded to 1 stroop, so a reference sitting exactly on a grid price can read 9.9999 bins:
  // 1e-3 bin of tolerance absorbs that (one bin is 10 bps, the rounding is < 1e-4 bin)
  const blocked = distance + 1e-3 < PROXIMITY_MIN_BINS;
  return { blocked, reason: blocked ? PROXIMITY_REASON : null, distance };
}

/**
 * Highest top bin a Bid can use and still pass the curator rule for this reference (reference bin minus
 * PROXIMITY_MIN_BINS, on the exact yieldGuard test). Used by "Change range".
 */
export function maxYieldBidHiBin(stepBps: number, refPrice: number): number {
  if (!(refPrice > 0)) return MAX_BIN;
  let b = Math.min(MAX_BIN, Math.floor(Math.log(refPrice) / Math.log(1 + stepBps / 10_000)) - PROXIMITY_MIN_BINS + 2);
  while (b > MIN_BIN && yieldGuard({ side: "Bid", venue: "pool", hiBin: b, stepBps, refPrice }).blocked) b--;
  return b;
}

/** Move a Bid range down so its top is maxYieldBidHiBin, keeping the width when the grid allows it. */
export function rangeForYield(loBin: number, hiBin: number, stepBps: number, refPrice: number): { loBin: number; hiBin: number } {
  const top = Math.min(hiBin, maxYieldBidHiBin(stepBps, refPrice));
  const width = Math.max(0, hiBin - loBin);
  return { loBin: Math.max(MIN_BIN, top - width), hiBin: top };
}

// ---- direction rule ---------------------------------------------------------------------------------------------
// A directional order never starts on the wrong side of the price of the venue it waits on: a SELL (Ask) range is
// entirely at or above the reference, a BUY (Bid) range entirely at or below it (else it is a market order).

/** Allowed bins for a side at a reference: Ask from the first bin priced >= ref, Bid up to the last bin priced <= ref. */
export function directionBounds(side: Side, stepBps: number, refPrice: number): { minBin: number; maxBin: number } {
  if (!(refPrice > 0)) return { minBin: MIN_BIN, maxBin: MAX_BIN };
  const ref = BigInt(Math.round(refPrice * Number(SCALE)));
  let b = Math.max(MIN_BIN, Math.min(MAX_BIN, Math.round(Math.log(refPrice) / Math.log(1 + stepBps / 10_000))));
  if (side === "Ask") {
    while (b > MIN_BIN && priceAt(b - 1, stepBps) >= ref) b--;
    while (b < MAX_BIN && priceAt(b, stepBps) < ref) b++;
    return { minBin: b, maxBin: MAX_BIN };
  }
  while (b < MAX_BIN && priceAt(b + 1, stepBps) <= ref) b++;
  while (b > MIN_BIN && priceAt(b, stepBps) > ref) b--;
  return { minBin: MIN_BIN, maxBin: b };
}

/** null when the range respects the direction rule, else a short message. */
export function directionError(side: Side, loBin: number, hiBin: number, stepBps: number, refPrice: number): string | null {
  const { minBin, maxBin } = directionBounds(side, stepBps, refPrice);
  if (side === "Ask" && loBin < minBin) return "A sell range must be at or above the current price";
  if (side === "Bid" && hiBin > maxBin) return "A buy range must be at or below the current price";
  return null;
}

/** Number of wallet signatures the destination needs (shown before signing). */
export function signaturesNeeded(i: { side: Side; venue: Venue; yieldOn: boolean; needsReceiptTrustline?: boolean }): number {
  if (i.venue === "sdex" && i.yieldOn && i.side === "Bid") return i.needsReceiptTrustline ? 3 : 2;
  return 1;
}

/**
 * Legacy single reference (two-way builder only): SDEX receipt book mid, else SDEX USDC book mid, else the pool's
 * own mid, else 1.0. The New position flow uses referenceFor (per strategy) below.
 */
export function pickReference(cands: { receiptMid: number | null; usdcMid: number | null; poolMid: number | null }): { price: number; source: string } {
  const ok = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;
  if (ok(cands.receiptMid)) return { price: cands.receiptMid, source: "SDEX receipt book" };
  if (ok(cands.usdcMid)) return { price: cands.usdcMid, source: "SDEX USDC book" };
  if (ok(cands.poolMid)) return { price: cands.poolMid, source: "Lotus pool" };
  return { price: 1, source: "default 1.0" };
}

// ---- per-strategy reference price and crossing --------------------------------------------------------------------
// Each strategy waits against a different book, so its reference price (range presets, curator rule) and its
// "crosses the book" check must read THAT book, not the receipt book for every strategy:
//   pool        : the instance's own bins, then BASE/USDC (a pool ask under the USDC bids is arbitraged at once)
//   sdex        : BASE/USDC (the offers are posted on that book)
//   sdex + yield: BASE/receipt
// The fallbacks only feed the reference price when the target book is empty (nothing to cross there then).

/** Best bid / best ask of one book (QUOTE per BASE, decimal), null when that side is empty. */
export type BookTop = { bid: number | null; ask: number | null };
export type MarketTops = { usdc: BookTop; receipt: BookTop; pool: BookTop };
export type BookKey = keyof MarketTops;

const BOOK_SOURCE: Record<BookKey, string> = { pool: "Lotus pool bins", usdc: "SDEX USDC book", receipt: "SDEX receipt book" };

const okPrice = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

/** Mid of a book top, or the one side that exists, or null. */
export function topMid(t: BookTop): number | null {
  const b = okPrice(t.bid) ? t.bid : null;
  const a = okPrice(t.ask) ? t.ask : null;
  return b !== null && a !== null ? (a + b) / 2 : (b ?? a);
}

/** Books the order rests against / can be crossed on (first = the venue itself). */
export function targetBooks(venue: Venue, yieldOn: boolean): BookKey[] {
  if (venue === "pool") return ["pool", "usdc"];
  return yieldOn ? ["receipt"] : ["usdc"];
}

/** Reference price order: the target books first, then the others as a fallback. */
export function referenceOrder(venue: Venue, yieldOn: boolean): BookKey[] {
  if (venue === "pool") return ["pool", "usdc", "receipt"];
  return yieldOn ? ["receipt", "usdc", "pool"] : ["usdc", "pool", "receipt"];
}

/** Reference price of one strategy: mid of its first non-empty book in referenceOrder, else 1.0. */
export function referenceFor(venue: Venue, yieldOn: boolean, m: MarketTops): { price: number; source: string } {
  for (const k of referenceOrder(venue, yieldOn)) {
    const mid = topMid(m[k]);
    if (mid !== null) return { price: mid, source: BOOK_SOURCE[k] };
  }
  return { price: 1, source: "default 1.0" };
}

/**
 * Range-step reference before a strategy is chosen: the most conservative of the per-strategy references, so a
 * preset placed from it crosses no venue (Ask: the highest reference, Bid: the lowest).
 */
export function conservativeReference(side: Side, refs: { price: number; source: string }[]): { price: number; source: string } {
  const real = refs.filter((r) => okPrice(r.price) && r.source !== "default 1.0");
  if (real.length === 0) return refs[0] ?? { price: 1, source: "default 1.0" };
  return real.reduce((best, r) => (side === "Ask" ? (r.price > best.price ? r : best) : r.price < best.price ? r : best));
}

/**
 * Number of order levels (grid prices, QUOTE per BASE) that cross the strategy's target books: an ask at or under
 * the best bid, a bid at or above the best ask, of any target book.
 */
export function crossingLevels(side: Side, prices: number[], venue: Venue, yieldOn: boolean, m: MarketTops): number {
  const books = targetBooks(venue, yieldOn).map((k) => m[k]);
  if (side === "Ask") {
    const bids = books.map((b) => b.bid).filter(okPrice);
    if (bids.length === 0) return 0;
    const best = Math.max(...bids);
    return prices.filter((p) => p <= best).length;
  }
  const asks = books.map((b) => b.ask).filter(okPrice);
  if (asks.length === 0) return 0;
  const best = Math.min(...asks);
  return prices.filter((p) => p >= best).length;
}

export type SummaryInput = {
  side: Side;
  venue: Venue;
  yieldOn: boolean;
  /** deposit in stroops of the sold asset */
  amount: bigint;
  /** lowest and highest grid price of the range, stroops */
  loPrice: bigint;
  hiPrice: bigint;
  baseCode: string;
  quoteCode: string;
  receiptCode: string;
  /** "Blend yield" when the strategy is live, otherwise e.g. "vault yield" */
  yieldName: string;
  signatures: number;
};

const px = (p: bigint) => {
  const s = fromStroops(divRound(p, 10_000n) * 10_000n); // 3 dp, like the jury-facing line
  const [i, f = ""] = s.split(".");
  return `${i}.${(f + "000").slice(0, 3)}`;
};

/** One-line summary shown before signing, e.g. "Sell 100 LBOND from 1.000 to 1.005 · waits in the Lotus pool · ...". */
export function orderSummary(s: SummaryInput): string {
  const amt = fromStroops(s.amount);
  const what =
    s.side === "Ask"
      ? `Sell ${amt} ${s.baseCode} from ${px(s.loPrice)} to ${px(s.hiPrice)}`
      : `Buy ${s.baseCode} with ${amt} ${s.quoteCode} from ${px(s.hiPrice)} down to ${px(s.loPrice)}`;
  const where =
    s.venue === "pool"
      ? "waits in the Lotus pool"
      : `waits on the SDEX (${s.baseCode}/${s.yieldOn ? s.receiptCode : s.quoteCode})`;
  let earn: string;
  if (!s.yieldOn) earn = "no yield";
  else if (s.venue === "pool") earn = s.side === "Ask" ? `earns ${s.yieldName} on proceeds` : `your ${s.quoteCode} earns ${s.yieldName} while it waits`;
  else
    earn =
      s.side === "Ask"
        ? `proceeds arrive as ${s.receiptCode} and earn ${s.yieldName}`
        : `deposits ${amt} ${s.quoteCode} for ${s.receiptCode}, which keeps earning ${s.yieldName} in the offers`;
  return `${what} · ${where} · ${earn} · ${s.signatures} signature${s.signatures === 1 ? "" : "s"}`;
}
