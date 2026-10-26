"use client";

// Order context of the New position flow: for one planned range order (side + bins + amount), evaluate the four
// places it can wait (lib/orderRoute.ts 2x2: venue pool | sdex, yield off | on) and execute the chosen one through
// lib/orderTx.ts (unchanged). This is the logic of the former NewOrder panel, split from its UI so the strategy cards
// and the review modal read the same numbers.

import { useMemo } from "react";
import { useAssetAccess, type AssetAccess } from "@/components/trade/access";
import { fromStroops } from "@/lib/amount";
import { useConfig } from "@/lib/config-context";
import type { LotusConfig, PoolInstance, Strategy } from "@/lib/config-types";
import {
  MAX_SDEX_LEVELS,
  crossingLevels,
  directionError,
  ladderFromPlan,
  orderSummary,
  referenceFor,
  signaturesNeeded,
  yieldGuard,
  type BookTop,
  type Ladder,
  type MarketTops,
  type Venue,
  type YieldGuard,
} from "@/lib/orderRoute";
import { sdexQuote } from "@/lib/orderTx";
import type { PositionPlan, Side } from "@/lib/poolGrid";
import { assetReady, fmt, isContractId, type AssetRef } from "@/lib/stellar";

export const RESERVE_PER_ENTRY_XLM = 0.5;
export const sameAsset = (a: AssetRef, b: AssetRef) => a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);

/**
 * Pool instances of the flow: the FIRST instance without a vault (USDC idle, yield off) and the first one with a
 * vault (yield on), in testnet.pool.json order. Any other instance (the separate two-way LP pool) is not part of the
 * flow and keeps its own builder ("Advanced: two-way position"). The flow always sends Mode::Directional.
 */
export function directionalPools(pools: PoolInstance[]) {
  const usable = pools.filter((p) => p.status !== "coming-soon" && p.status !== "retired");
  const idle = usable.find((p) => !p.vault) ?? null;
  const vaulted = usable.find((p) => !!p.vault) ?? null;
  const list = [idle, vaulted].filter((p): p is PoolInstance => p !== null);
  return { list, idle, vaulted, others: usable.filter((p) => !list.includes(p)) };
}

export type StrategyId = "pool" | "pool-yield" | "sdex" | "sdex-yield";
export const STRATEGIES: { id: StrategyId; venue: Venue; yieldOn: boolean }[] = [
  { id: "pool", venue: "pool", yieldOn: false },
  { id: "pool-yield", venue: "pool", yieldOn: true },
  { id: "sdex", venue: "sdex", yieldOn: false },
  { id: "sdex-yield", venue: "sdex", yieldOn: true },
];

export type Destination = {
  id: StrategyId;
  venue: Venue;
  yieldOn: boolean;
  /** pool instance the order rests in (venue pool) */
  inst: PoolInstance | null;
  /** SDEX quote asset (USDC or the receipt) */
  sdexQuote: AssetRef;
  /** why this destination cannot be chosen at all (not deployed, curator rule, too many levels) */
  unavailable: string | null;
  guard: YieldGuard;
  /** why the order cannot be signed right now (wallet, trustline, balance...) */
  blockedBy: string | null;
  signatures: number;
  addTrust: AssetRef[];
  needsReceiptTrustline: boolean;
  reserveXlm: number;
  /** order levels that cross this strategy's target books (pool: its bins + BASE/USDC; SDEX: its own book) */
  crossing: number;
  /** reference price of THIS strategy (its own book, see lib/orderRoute.ts referenceFor) */
  ref: { price: number; source: string };
  summary: string | null;
  yieldName: string;
  strategy: Strategy | null;
};

export type OrderInputs = {
  side: PositionPlan["side"];
  plan: PositionPlan;
  amountTyped: boolean;
  stepBps: number;
  /** best bid / ask of every book a strategy can target; pool = per instance (idle, vault-backed) */
  market: { usdc: BookTop; receipt: BookTop; pool: { idle: BookTop; vaulted: BookTop } };
  connected: boolean;
};

export type OrderEnv = {
  config: LotusConfig;
  base: AssetRef;
  quote: AssetRef;
  receipt: AssetRef;
  vaultOk: boolean;
  idle: PoolInstance | null;
  vaulted: PoolInstance | null;
  access: { base: AssetAccess; quote: AssetAccess; receipt: AssetAccess; xlm: AssetAccess };
  ladder: Ladder;
};

/** Evaluate one destination (pure apart from its inputs). */
export function evaluate(env: OrderEnv, i: OrderInputs, s: (typeof STRATEGIES)[number]): Destination {
  const { config, base, quote, receipt, access, ladder } = env;
  const { side, plan } = i;
  const { venue, yieldOn } = s;
  const inst = venue === "pool" ? (yieldOn ? env.vaulted : env.idle) : null;
  const sq = sdexQuote({ yieldOn, quote, receipt });
  const strategy =
    (venue === "pool"
      ? config.strategies.find((x) => x.id === env.vaulted?.strategyId)
      : config.strategies.find((x) => x.lotusVault === config.lotusVault)) ?? null;
  const yieldName = strategy?.status === "live" ? "Blend yield" : "vault yield";

  const tops: MarketTops = { usdc: i.market.usdc, receipt: i.market.receipt, pool: yieldOn ? i.market.pool.vaulted : i.market.pool.idle };
  const ref = referenceFor(venue, yieldOn, tops);
  const guard = yieldGuard({ side, venue, hiBin: plan.hiBin, stepBps: i.stepBps, refPrice: ref.price });
  let unavailable: string | null = null;
  if (venue === "pool" && !inst) unavailable = yieldOn ? "No vault-backed pool instance is deployed." : "No idle pool instance is deployed.";
  else if (plan.ok && directionError(side, plan.loBin, plan.hiBin, i.stepBps, ref.price))
    unavailable = `${directionError(side, plan.loBin, plan.hiBin, i.stepBps, ref.price)} of this venue (${fmt(ref.price, 4, 4)}, ${ref.source}).`;
  else if (venue === "pool" && yieldOn && plan.ok && guard.blocked) unavailable = guard.reason;
  else if (venue === "sdex" && yieldOn && !env.vaultOk) unavailable = "No Lotus vault (receipt) is configured in testnet.contract.json.";
  else if (venue === "sdex" && plan.ok && ladder.errors.length > 0) unavailable = `Max ${MAX_SDEX_LEVELS} levels on the SDEX: each bin is one offer (narrow the range).`;

  // trustlines the classic tx adds in front of the offers (SDEX Ask: where the proceeds land). A Bid with yield needs
  // the receipt trustline BEFORE the deposit (the vault mints to it), so that one is its own first transaction.
  const addTrust: AssetRef[] = [];
  if (venue === "sdex") {
    if (side === "Ask" && !yieldOn && access.quote.state === "no-trustline") addTrust.push(quote);
    if (side === "Ask" && yieldOn && access.receipt.state === "no-trustline") addTrust.push(receipt);
  }
  const needsReceiptTrustline = venue === "sdex" && yieldOn && side === "Bid" && access.receipt.state === "no-trustline";
  const signatures = signaturesNeeded({ side, venue, yieldOn, needsReceiptTrustline });
  const reserveXlm = venue === "sdex" ? (ladder.offers.length + addTrust.length + (needsReceiptTrustline ? 1 : 0)) * RESERVE_PER_ENTRY_XLM : 0;

  // levels that would cross the target books and fill at once (pool: arbitraged against its bins / the USDC book)
  const crossing = plan.ok
    ? crossingLevels(
        side,
        plan.bins.filter((b) => b.amount > 0n).map((b) => Number(b.price) / 1e7),
        venue,
        yieldOn,
        tops,
      )
    : 0;

  const sold = side === "Ask" ? base : quote;
  const soldAccess = side === "Ask" ? access.base : access.quote;
  const need = plan.ok ? Number(fromStroops(plan.deposit)) : 0;
  const lbondBlocked = access.base.state === "no-trustline" || access.base.state === "unauthorized";
  const blockedBy = unavailable
    ? unavailable
    : !i.connected
      ? "Connect a wallet"
      : lbondBlocked
        ? access.base.state === "unauthorized"
          ? `${base.code}: not authorized by the issuer`
          : `${base.code} trustline needed`
        : (venue === "pool" || side === "Bid") && (access.quote.state === "no-trustline" || access.quote.state === "unauthorized")
          ? `${quote.code} trustline needed`
          : !i.amountTyped
            ? "Enter an amount"
            : !plan.ok
              ? (plan.errors[0] ?? "Enter a range and an amount")
              : soldAccess.available !== null && need > soldAccess.available + 1e-9
                ? `Insufficient ${sold.code}`
                : access.xlm.available !== null && reserveXlm > access.xlm.available + 1e-9
                  ? "Not enough XLM for the reserve"
                  : null;

  const summary = plan.ok
    ? orderSummary({
        side,
        venue,
        yieldOn,
        amount: plan.deposit,
        loPrice: plan.bins[0]?.price ?? 0n,
        hiPrice: plan.bins[plan.bins.length - 1]?.price ?? 0n,
        baseCode: base.code,
        quoteCode: quote.code,
        receiptCode: receipt.code,
        yieldName,
        signatures,
      })
    : null;

  return { id: s.id, venue, yieldOn, inst, sdexQuote: sq, unavailable, guard, blockedBy, signatures, addTrust, needsReceiptTrustline, reserveXlm, crossing, ref, summary, yieldName, strategy };
}

/** Warning for a range that crosses the strategy's own book(s); also used by the review modal. */
export function crossText(d: Destination, side: Side, base: string, quote: string, receipt: string, bins: number): string {
  const n = `${d.crossing} of ${bins} level${bins === 1 ? "" : "s"}`;
  const vs = side === "Ask" ? "at or under the best bid" : "at or above the best ask";
  const ref = `reference ${fmt(d.ref.price, 4, 4)}, ${d.ref.source}`;
  if (d.venue === "pool")
    return `${n} sit ${vs} of the pool bins or ${base}/${quote} (${ref}): they would be arbitraged at once instead of waiting. Move the range ${side === "Ask" ? "up" : "down"}.`;
  return `${n} ${vs} of ${base}/${d.yieldOn ? receipt : quote} (${ref}): they fill immediately as a taker instead of waiting. Move the range ${side === "Ask" ? "up" : "down"}.`;
}

/** Hook: environment (assets, access, ladder) + the four evaluated destinations. */
export function useOrderDestinations(pools: PoolInstance[], inputs: OrderInputs) {
  const config = useConfig();
  const { idle, vaulted } = useMemo(() => directionalPools(pools), [pools]);
  const main = idle ?? vaulted ?? pools[0];
  const base: AssetRef = main.base;
  const quote: AssetRef = main.quote;
  const receipt: AssetRef = config.receipt;
  const vaultOk = isContractId(config.lotusVault) && assetReady(receipt) && sameAsset(config.underlying, quote);
  const access = {
    base: useAssetAccess(base),
    quote: useAssetAccess(quote),
    receipt: useAssetAccess(receipt),
    xlm: useAssetAccess({ code: "XLM", issuer: null }),
  };
  const ladder = useMemo(() => ladderFromPlan(inputs.plan), [inputs.plan]);
  const env: OrderEnv = { config, base, quote, receipt, vaultOk, idle, vaulted, access, ladder };
  const destinations = STRATEGIES.map((s) => evaluate(env, inputs, s));
  return { env, destinations };
}
