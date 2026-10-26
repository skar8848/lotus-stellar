// Open SDEX offers as ORDERS (pure, no React, no SDK, no runtime imports: unit-tested with plain node).
//
// The SDEX keeps no "order" object, only offers. A range limit order placed by the app (/pools or /swap Pro / Limit
// with a Stellar DEX strategy) is a ladder of manageSellOffer ops posted in ONE transaction. lib/offerOrigin.ts maps
// each offer id to the transaction that created it; here the offers created by the same transaction on the same
// (selling, buying) pair become one range row. Anything without a known origin (created before the scanned window,
// or by another tool that posted one offer per tx) stays a single row.

import type { Market } from "./markets";
import type { HorizonOffer } from "./stellar";

type AssetFields = HorizonOffer["selling"];

/** "native" or "CODE:ISSUER", same keys as lib/stellar.ts assetKey. */
export const fieldsKey = (f: AssetFields): string => (f.asset_type === "native" ? "native" : `${f.asset_code}:${f.asset_issuer}`);
const refKey = (a: { code: string; issuer: string | null }): string => (a.issuer ? `${a.code}:${a.issuer}` : "native");
const fieldsCode = (f: AssetFields): string => (f.asset_type === "native" ? "XLM" : (f.asset_code as string));

export type Described = {
  offer: HorizonOffer;
  market: Market | null;
  side: "Ask" | "Bid" | "Offer";
  /** quote per base when the offer belongs to a known market */
  price: number;
  /** base size */
  size: number;
  /** quote total */
  total: number;
  sellCode: string;
  buyCode: string;
};

export function describeOffer(o: HorizonOffer, markets: Market[]): Described {
  const sk = fieldsKey(o.selling);
  const bk = fieldsKey(o.buying);
  const sellCode = fieldsCode(o.selling);
  const buyCode = fieldsCode(o.buying);
  const amount = Number(o.amount);
  const p = Number(o.price);
  for (const m of markets) {
    if (sk === refKey(m.base) && bk === refKey(m.quote))
      return { offer: o, market: m, side: "Ask", price: p, size: amount, total: amount * p, sellCode, buyCode };
    if (sk === refKey(m.quote) && bk === refKey(m.base))
      return { offer: o, market: m, side: "Bid", price: p > 0 ? 1 / p : 0, size: amount * p, total: amount, sellCode, buyCode };
  }
  return { offer: o, market: null, side: "Offer", price: p, size: amount, total: amount * p, sellCode, buyCode };
}

/** One offer created by a transaction (offerId null: fully crossed at creation, never rested). */
export type CreatedOffer = { offerId: string | null; selling: string; buying: string; /** initial amount, selling units */ initial: number };
export type OfferTx = { hash: string; createdAt: string; created: CreatedOffer[] };
export type OriginIndex = {
  /** offer id -> the transaction that created it */
  byOffer: Map<string, OfferTx>;
  /** offers later cancelled (manage offer with that id and amount 0) */
  cancelled: Set<string>;
  /** offers later updated with a new amount (their initial amount no longer says what filled) */
  updated: Set<string>;
};

export const emptyOrigins = (): OriginIndex => ({ byOffer: new Map(), cancelled: new Set(), updated: new Set() });

export type SingleOrderRow = {
  kind: "single";
  key: string;
  d: Described;
  tx: OfferTx | null;
  /** 0..100, null when the creation amount is unknown */
  filledPct: number | null;
};

export type RangeOrderRow = {
  kind: "range";
  key: string;
  tx: OfferTx;
  market: Market | null;
  side: Described["side"];
  /** open offers, by price per base ascending */
  offers: Described[];
  /** price range, quote per base (raw Horizon price for an unknown market) */
  lo: number;
  hi: number;
  /** levels still open / levels the transaction created (cancelled ones excluded) */
  open: number;
  levels: number;
  /** remaining base size and quote total of the open offers */
  size: number;
  total: number;
  sellCode: string;
  buyCode: string;
  filledPct: number | null;
};

export type OrderRow = SingleOrderRow | RangeOrderRow;

const pct = (current: number, initial: number): number | null =>
  initial > 0 ? Math.min(100, Math.max(0, (1 - current / initial) * 100)) : null;

/** Offers + origin index -> order rows, in the order of the first offer of each row (Horizon: offer id ascending). */
export function groupOffers(described: Described[], origins: OriginIndex | null): OrderRow[] {
  const idx = origins ?? emptyOrigins();
  const groups = new Map<string, { tx: OfferTx; pair: [string, string]; items: Described[] }>();
  const order: (string | Described)[] = [];
  for (const d of described) {
    const tx = idx.byOffer.get(d.offer.id);
    if (!tx) {
      order.push(d);
      continue;
    }
    const pair: [string, string] = [fieldsKey(d.offer.selling), fieldsKey(d.offer.buying)];
    const key = `${tx.hash}|${pair[0]}>${pair[1]}`;
    const g = groups.get(key);
    if (g) g.items.push(d);
    else {
      groups.set(key, { tx, pair, items: [d] });
      order.push(key);
    }
  }

  return order.map((entry): OrderRow => {
    if (typeof entry !== "string") return { kind: "single", key: `offer:${entry.offer.id}`, d: entry, tx: null, filledPct: null };
    const { tx, pair, items } = groups.get(entry)!;
    const created = tx.created.filter((c) => c.selling === pair[0] && c.buying === pair[1] && !(c.offerId && idx.cancelled.has(c.offerId)));
    const initial = created.reduce((s, c) => s + c.initial, 0);
    const current = items.reduce((s, d) => s + Number(d.offer.amount), 0);
    const filledPct = items.some((d) => idx.updated.has(d.offer.id)) ? null : pct(current, initial);
    if (created.length < 2) return { kind: "single", key: `offer:${items[0].offer.id}`, d: items[0], tx, filledPct };
    const offers = [...items].sort((a, b) => a.price - b.price);
    const first = offers[0];
    return {
      kind: "range",
      key: `range:${entry}`,
      tx,
      market: first.market,
      side: first.side,
      offers,
      lo: first.price,
      hi: offers[offers.length - 1].price,
      open: offers.length,
      levels: created.length,
      size: offers.reduce((s, d) => s + d.size, 0),
      total: offers.reduce((s, d) => s + d.total, 0),
      sellCode: first.sellCode,
      buyCode: first.buyCode,
      filledPct,
    };
  });
}

/**
 * Owner rule: a range quoted in a Lotus receipt (the "Stellar DEX + Blend yield" strategy) is locked until filled,
 * like the Lotus pool orders. Enforced by the UI only: the offers belong to the user's account.
 */
export const rangeLocked = (r: OrderRow): boolean => r.kind === "range" && !!r.market && r.market.kind !== "cash";

/** "earns" tag of an offer quoted in a Lotus receipt: a bid's waiting receipt earns, an ask's proceeds will. */
export function earnTag(market: Market | null, side: Described["side"]): { label: string; title: string } | null {
  if (!market || market.kind === "cash" || !(side === "Bid" || market.kind === "bond")) return null;
  return side === "Bid"
    ? { label: "earns", title: `The ${market.quote.code} (Lotus receipt) waiting in this order keeps earning` }
    : { label: "proceeds earn", title: `Proceeds arrive as ${market.quote.code} (Lotus receipt) and start earning` };
}
