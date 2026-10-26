// "Your positions" model for /pools: one row per order, whatever strategy it was created with.
//   Lotus pool             -> a lotus_pool position on an instance without a vault
//   Lotus pool + yield     -> a lotus_pool position on an instance whose USDC leg sits in DeFindex/Blend
//   Stellar DEX            -> SDEX offers selling BASE for USDC (Ask) or USDC for BASE (Bid), grouped as one ladder
//   Stellar DEX + yield    -> the same ladder quoted in a Lotus receipt (lUSDCb)
// The SDEX keeps no "order" object: offers of the same side on the same pair are shown as one ladder row (each offer
// is still listed with its own explorer link). Pure, no React.

import type { LotusConfig, PoolInstance, Strategy } from "@/lib/config-types";
import type { Position } from "@/lib/pool";
import { priceAt, type Side } from "@/lib/poolGrid";
import { assetReady, sameAsset, toAssetRef, type AssetRef, type HorizonOffer } from "@/lib/stellar";
import type { StrategyId } from "./useOrder";

/**
 * Product rule: a directional limit order is locked until it is fully filled (no Remove / Cancel, only Claim of the
 * proceeds; "Early redemption" comes later). A two-way LP position never "fills" and keeps Remove.
 * SDEX ladders: a fully filled offer disappears from the book, so a listed ladder is always locked.
 */
export const poolPositionLocked = (p: Pick<Position, "mode" | "inventory">): boolean => p.mode !== "TwoWay" && p.inventory > 0n;
export const EARLY_REDEMPTION_LABEL = "Early redemption · soon";

export type PoolRow = {
  kind: "pool";
  key: string;
  strategy: StrategyId | "two-way";
  inst: PoolInstance;
  position: Position;
  side: Side;
  lo: number;
  hi: number;
  filledPct: number;
};

export type OfferRow = {
  kind: "sdex";
  key: string;
  strategy: StrategyId;
  side: Side;
  base: AssetRef;
  quote: AssetRef;
  receiptOf: Strategy | null;
  offers: HorizonOffer[];
  /** price range in QUOTE per BASE */
  lo: number;
  hi: number;
  /** remaining size: BASE for an Ask ladder, QUOTE for a Bid ladder */
  remaining: number;
};

export type PositionRow = PoolRow | OfferRow;

export const STRATEGY_LABEL: Record<PositionRow["strategy"], string> = {
  pool: "Lotus pool",
  "pool-yield": "Lotus pool + Blend yield",
  sdex: "Stellar DEX",
  "sdex-yield": "Stellar DEX + Blend yield",
  "two-way": "Two-way LP (advanced)",
};

export function poolRows(data: { inst: PoolInstance; positions: Position[] }[]): PoolRow[] {
  const rows: PoolRow[] = [];
  for (const { inst, positions } of data) {
    for (const p of positions) {
      const lo = Number(priceAt(p.loBin, inst.binStepBps)) / 1e7;
      const hi = Number(priceAt(p.hiBin, inst.binStepBps)) / 1e7;
      const strategy: PoolRow["strategy"] = p.mode === "TwoWay" ? "two-way" : inst.vault ? "pool-yield" : "pool";
      rows.push({
        kind: "pool",
        key: `pool:${inst.id}:${p.id}`,
        strategy,
        inst,
        position: p,
        side: p.side,
        lo,
        hi,
        filledPct: p.deposited > 0n ? (Number(p.filled) / Number(p.deposited)) * 100 : 0,
      });
    }
  }
  return rows;
}

/** SDEX ladders of the base asset (LBOND) against USDC or a Lotus receipt, one row per (pair, side). */
export function offerRows(config: LotusConfig, offers: HorizonOffer[]): OfferRow[] {
  const base: AssetRef = config.rwa;
  if (!assetReady(base)) return [];
  const usdc: AssetRef = config.underlying;
  const receipts = config.strategies.filter((s) => assetReady(s.receipt));
  const groups = new Map<string, OfferRow>();
  for (const o of offers) {
    const selling = toAssetRef(o.selling);
    const buying = toAssetRef(o.buying);
    const side: Side | null = sameAsset(o.selling, base) ? "Ask" : sameAsset(o.buying, base) ? "Bid" : null;
    if (!side) continue;
    const other = side === "Ask" ? buying : selling;
    const otherFields = side === "Ask" ? o.buying : o.selling;
    const receiptOf = receipts.find((s) => sameAsset(otherFields, s.receipt)) ?? null;
    const isUsdc = assetReady(usdc) && sameAsset(otherFields, usdc);
    if (!receiptOf && !isUsdc) continue;
    const key = `sdex:${side}:${other.code}:${other.issuer}`;
    const price = Number(o.price);
    // Ask: price is quote per base, amount in base. Bid: price is base per quote, amount in quote.
    const perBase = side === "Ask" ? price : price > 0 ? 1 / price : 0;
    const g =
      groups.get(key) ??
      ({
        kind: "sdex",
        key,
        strategy: receiptOf ? "sdex-yield" : "sdex",
        side,
        base,
        quote: other,
        receiptOf,
        offers: [],
        lo: Infinity,
        hi: 0,
        remaining: 0,
      } satisfies OfferRow);
    g.offers.push(o);
    if (perBase > 0) {
      g.lo = Math.min(g.lo, perBase);
      g.hi = Math.max(g.hi, perBase);
    }
    g.remaining += Number(o.amount);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, lo: Number.isFinite(g.lo) ? g.lo : 0, offers: [...g.offers].sort((a, b) => Number(a.price) - Number(b.price)) }));
}
