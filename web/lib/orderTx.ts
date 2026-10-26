// Execution of a "New order" (see lib/orderRoute.ts for the routing rules). One function per destination shape,
// all reached through placeOrder(). Client-safe (SDK, no React).

import type { xdr } from "@stellar/stellar-sdk";
import { fromStroops } from "./amount";
import type { PoolClient } from "./pool";
import type { PositionPlan, Side } from "./poolGrid";
import type { LadderOffer, Venue } from "./orderRoute";
import {
  PairError,
  addressArg,
  changeTrustOp,
  i128Arg,
  manageSellOfferOp,
  submitClassic,
  submitSorobanThenClassic,
  type AssetRef,
  type NetCfg,
  type Signer,
  type TxStage,
} from "./stellar";

export { PairError };

/** One manageSellOffer per ladder level. Ask sells BASE for `quote`; Bid sells `quote` for BASE. */
export function ladderOps(side: Side, offers: LadderOffer[], base: AssetRef, quote: AssetRef): xdr.Operation[] {
  return offers.map((o) =>
    side === "Ask"
      ? manageSellOfferOp({ selling: base, buying: quote, amount: fromStroops(o.sellAmount), price: o.price })
      : manageSellOfferOp({ selling: quote, buying: base, amount: fromStroops(o.sellAmount), price: o.price }),
  );
}

export type PlaceOrderInput = {
  side: Side;
  venue: Venue;
  yieldOn: boolean;
  plan: PositionPlan;
  offers: LadderOffer[];
  base: AssetRef;
  /** the plain quote asset (USDC) */
  quote: AssetRef;
  /** the Lotus receipt of the active vault (testnet.contract.json) and its lotus_vault contract */
  receipt: AssetRef;
  lotusVault: string;
  /** pool client of the destination instance (venue "pool" only) */
  pool: PoolClient | null;
  /** trustlines missing on the account that the classic tx should add first (e.g. the receipt, USDC for proceeds) */
  addTrust: AssetRef[];
};

export type PlaceOrderResult = { hashes: string[]; result?: unknown; note: string; simulated?: boolean };

type Ctx = { source: string; sign: Signer; onStage?: (s: TxStage, note?: string) => void };

/** The SDEX quote asset of a destination: the receipt when yield is on, else USDC. */
export const sdexQuote = (i: Pick<PlaceOrderInput, "yieldOn" | "quote" | "receipt">): AssetRef => (i.yieldOn ? i.receipt : i.quote);

export async function placeOrder(net: NetCfg, ctx: Ctx, i: PlaceOrderInput): Promise<PlaceOrderResult> {
  if (!i.plan.ok) throw new Error(i.plan.errors[0] ?? "Invalid range");
  const sold = i.side === "Ask" ? i.base : i.quote;
  const amountText = `${fromStroops(i.plan.deposit)} ${sold.code}`;

  if (i.venue === "pool") {
    if (!i.pool) throw new Error("No pool instance for this destination");
    const r = await i.pool.addPosition(ctx, {
      side: i.side,
      mode: "Directional",
      loBin: i.plan.loBin,
      hiBin: i.plan.hiBin,
      amount: i.plan.deposit,
      weights: i.plan.weights,
    });
    return {
      hashes: r.hash ? [r.hash] : [],
      result: r.result,
      simulated: r.simulated,
      note: `${i.side} position in the Lotus pool, ${i.plan.bins.length} bins (${i.plan.loBin}..${i.plan.hiBin}), ${amountText}${r.simulated ? " (simulated locally)" : ""}`,
    };
  }

  const q = sdexQuote(i);
  const offerOps = ladderOps(i.side, i.offers, i.base, q);

  if (i.yieldOn && i.side === "Bid") {
    // receipt trustline must exist before the deposit can be simulated (the vault mints to it)
    let pre: string[] = [];
    if (i.addTrust.some((a) => a.code === i.receipt.code && a.issuer === i.receipt.issuer)) {
      const t = await submitClassic(net, { ...ctx, ops: [changeTrustOp(i.receipt)], onStage: (s) => ctx.onStage?.(s, `${i.receipt.code} trustline`) });
      pre = [t.hash];
    }
    const others = i.addTrust.filter((a) => !(a.code === i.receipt.code && a.issuer === i.receipt.issuer));
    const r = await submitSorobanThenClassic(net, {
      source: ctx.source,
      sign: ctx.sign,
      call: { contractId: i.lotusVault, method: "deposit", args: [addressArg(ctx.source), i128Arg(i.plan.deposit)] },
      ops: [...others.map(changeTrustOp), ...offerOps],
      onStage: ctx.onStage,
      labels: [`deposit ${amountText}`, `${i.offers.length} offers`],
    });
    return {
      hashes: [...pre, ...r.hashes],
      result: r.result,
      note: `deposited ${amountText} for ${fromStroops(i.plan.deposit)} ${i.receipt.code}, then ${i.offers.length} bids on ${i.base.code}/${i.receipt.code}`,
    };
  }

  const r = await submitClassic(net, { ...ctx, ops: [...i.addTrust.map(changeTrustOp), ...offerOps] });
  const trustNote = i.addTrust.length > 0 ? ` (+ ${i.addTrust.map((a) => a.code).join(", ")} trustline)` : "";
  return {
    hashes: [r.hash],
    note: `${i.offers.length} ${i.side === "Ask" ? "asks" : "bids"} on ${i.base.code}/${q.code}, ${amountText}${trustNote}`,
  };
}

/** Retry of the second half of a 2-transaction order: post the receipt ladder again (one classic tx, fresh sequence). */
export async function repostOffers(net: NetCfg, ctx: Ctx, i: Pick<PlaceOrderInput, "side" | "offers" | "base" | "receipt">) {
  const r = await submitClassic(net, { ...ctx, ops: ladderOps(i.side, i.offers, i.base, i.receipt) });
  return { hashes: [r.hash], note: `${i.offers.length} bids on ${i.base.code}/${i.receipt.code} posted` };
}
