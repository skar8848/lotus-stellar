// Range limit order: the four places it can wait (web/lib/orderRoute.ts 2x2) evaluated for one account, without
// React. Port of web/components/pools/useOrder.ts `evaluate` + `directionalPools`, driven by the shared, verbatim
// copies of web/lib/orderRoute.ts and web/lib/poolGrid.ts (src/shared/), so the rules are the app's rules:
//   - plan           : planPosition (bins, weights, per-bin amounts)
//   - reference      : referenceFor(venue, yield, tops): the book the strategy rests on, then fallbacks
//   - direction rule : directionError (a sell range at or above the reference, a buy range at or below it)
//   - curator rule   : yieldGuard (Bid + pool + yield blocked when the top is < PROXIMITY_MIN_BINS below the reference)
//   - SDEX ladder    : ladderFromPlan (one offer per bin, exact rational price, at most MAX_SDEX_LEVELS)
//   - crossing       : crossingLevels (warning only, as in the app)

import type { LotusConfig, PoolInstance, Strategy } from "./shared/config-types.ts";
import { fromStroops } from "./shared/amount.ts";
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
} from "./shared/orderRoute.ts";
import type { PositionPlan, Side } from "./shared/poolGrid.ts";
import { findBalance, isNative, sameAsset, type AssetRef, type HorizonAccount } from "./net.ts";

export type StrategyId = "pool" | "pool-yield" | "sdex" | "sdex-yield";
export const STRATEGIES: { id: StrategyId; venue: Venue; yieldOn: boolean; label: string }[] = [
  { id: "pool", venue: "pool", yieldOn: false, label: "Lotus pool (USDC idle)" },
  { id: "pool-yield", venue: "pool", yieldOn: true, label: "Lotus pool + Blend yield (USDC leg in DeFindex)" },
  { id: "sdex", venue: "sdex", yieldOn: false, label: "Stellar DEX, quoted in USDC" },
  { id: "sdex-yield", venue: "sdex", yieldOn: true, label: "Stellar DEX + Blend yield, quoted in the receipt" },
];

export const RESERVE_PER_ENTRY_XLM = 0.5;

/** The flow's pool instances: the FIRST live instance without a vault and the first with one (useOrder.ts). */
export function directionalPools(pools: PoolInstance[]) {
  const usable = pools.filter((p) => p.status !== "coming-soon" && p.status !== "retired");
  const idle = usable.find((p) => !p.vault) ?? null;
  const vaulted = usable.find((p) => !!p.vault) ?? null;
  const list = [idle, vaulted].filter((p): p is PoolInstance => p !== null);
  return { list, idle, vaulted, others: usable.filter((p) => !list.includes(p)) };
}

export type AccessState = "ok" | "no-trustline" | "unauthorized" | "no-account";
export type AssetAccess = { state: AccessState; available: number | null };

/** Same rules as web/components/trade/access.ts useAssetAccess, from a Horizon account. */
export function assetAccess(acct: HorizonAccount | null, asset: AssetRef): AssetAccess {
  if (!acct) return { state: "no-account", available: null };
  const b = findBalance(acct, asset);
  if (isNative(asset)) {
    const reserve = (2 + acct.subentry_count) * 0.5;
    const avail = b ? Number(b.balance) - Number(b.selling_liabilities ?? 0) - reserve : null;
    return { state: "ok", available: avail === null ? null : Math.max(0, avail) };
  }
  if (!b) return { state: "no-trustline", available: null };
  const available = Math.max(0, Number(b.balance) - Number(b.selling_liabilities ?? 0));
  if (b.is_authorized === false) return { state: "unauthorized", available };
  return { state: "ok", available };
}

export type MarketSnapshot = { usdc: BookTop; receipt: BookTop; pool: { idle: BookTop; vaulted: BookTop } };

export type Destination = {
  id: StrategyId;
  venue: Venue;
  yieldOn: boolean;
  inst: PoolInstance | null;
  sdexQuote: AssetRef;
  /** why this destination cannot be chosen at all (not deployed, direction rule, curator rule, too many levels) */
  unavailable: string | null;
  guard: YieldGuard;
  /** why the order cannot be signed right now for this account (trustline, balance, reserve) */
  blockedBy: string | null;
  signatures: number;
  addTrust: AssetRef[];
  needsReceiptTrustline: boolean;
  reserveXlm: number;
  crossing: number;
  ref: { price: number; source: string };
  summary: string | null;
  yieldName: string;
  strategy: Strategy | null;
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

const ref = (a: { code: string; issuer: string | null }): AssetRef => ({ code: a.code, issuer: a.issuer ?? null });

export function orderEnv(config: LotusConfig, acct: HorizonAccount | null, plan: PositionPlan): OrderEnv {
  const { idle, vaulted } = directionalPools(config.pools);
  const main = idle ?? vaulted ?? config.pools[0];
  if (!main) throw new Error("no pool instance in the config");
  const base = ref(main.base);
  const quote = ref(main.quote);
  const receipt = ref(config.receipt);
  const vaultOk = /^C[A-Z2-7]{55}$/.test(config.lotusVault) && !!receipt.issuer && sameAsset(ref(config.underlying), quote);
  return {
    config,
    base,
    quote,
    receipt,
    vaultOk,
    idle,
    vaulted,
    access: {
      base: assetAccess(acct, base),
      quote: assetAccess(acct, quote),
      receipt: assetAccess(acct, receipt),
      xlm: assetAccess(acct, { code: "XLM", issuer: null }),
    },
    ladder: ladderFromPlan(plan),
  };
}

/** Evaluate one destination. Port of useOrder.ts evaluate() (same order of checks and the same messages). */
export function evaluate(env: OrderEnv, plan: PositionPlan, stepBps: number, market: MarketSnapshot, s: (typeof STRATEGIES)[number]): Destination {
  const { config, base, quote, receipt, access, ladder } = env;
  const side: Side = plan.side;
  const { venue, yieldOn } = s;
  const inst = venue === "pool" ? (yieldOn ? env.vaulted : env.idle) : null;
  const sq = yieldOn ? receipt : quote;
  const strategy =
    (venue === "pool"
      ? config.strategies.find((x) => x.id === env.vaulted?.strategyId)
      : config.strategies.find((x) => x.lotusVault === config.lotusVault)) ?? null;
  const yieldName = strategy?.status === "live" ? "Blend yield" : "vault yield";

  const tops: MarketTops = { usdc: market.usdc, receipt: market.receipt, pool: yieldOn ? market.pool.vaulted : market.pool.idle };
  const reference = referenceFor(venue, yieldOn, tops);
  const guard = yieldGuard({ side, venue, hiBin: plan.hiBin, stepBps, refPrice: reference.price });
  let unavailable: string | null = null;
  const dirErr = plan.ok ? directionError(side, plan.loBin, plan.hiBin, stepBps, reference.price) : null;
  if (venue === "pool" && !inst) unavailable = yieldOn ? "No vault-backed pool instance is deployed." : "No idle pool instance is deployed.";
  else if (dirErr) unavailable = `${dirErr} of this venue (${reference.price.toFixed(4)}, ${reference.source}).`;
  else if (venue === "pool" && yieldOn && plan.ok && guard.blocked) unavailable = guard.reason;
  else if (venue === "sdex" && yieldOn && !env.vaultOk) unavailable = "No Lotus vault (receipt) is configured.";
  else if (venue === "sdex" && plan.ok && ladder.errors.length > 0) unavailable = `Max ${MAX_SDEX_LEVELS} levels on the SDEX: each bin is one offer (narrow the range).`;

  const addTrust: AssetRef[] = [];
  if (venue === "sdex") {
    if (side === "Ask" && !yieldOn && access.quote.state === "no-trustline") addTrust.push(quote);
    if (side === "Ask" && yieldOn && access.receipt.state === "no-trustline") addTrust.push(receipt);
  }
  const needsReceiptTrustline = venue === "sdex" && yieldOn && side === "Bid" && access.receipt.state === "no-trustline";
  const signatures = signaturesNeeded({ side, venue, yieldOn, needsReceiptTrustline });
  const reserveXlm = venue === "sdex" ? (ladder.offers.length + addTrust.length + (needsReceiptTrustline ? 1 : 0)) * RESERVE_PER_ENTRY_XLM : 0;
  const crossing = plan.ok
    ? crossingLevels(side, plan.bins.filter((b) => b.amount > 0n).map((b) => Number(b.price) / 1e7), venue, yieldOn, tops)
    : 0;

  const sold = side === "Ask" ? base : quote;
  const soldAccess = side === "Ask" ? access.base : access.quote;
  const need = plan.ok ? Number(fromStroops(plan.deposit)) : 0;
  const lbondBlocked = access.base.state === "no-trustline" || access.base.state === "unauthorized";
  const blockedBy = unavailable
    ? unavailable
    : access.base.state === "no-account"
      ? "The account does not exist on the network (fund it with Friendbot)"
      : lbondBlocked
        ? access.base.state === "unauthorized"
          ? `${base.code}: not authorized by the issuer (claim from the faucet, it authorizes the trustline)`
          : `${base.code} trustline needed`
        : (venue === "pool" || side === "Bid") && (access.quote.state === "no-trustline" || access.quote.state === "unauthorized")
          ? `${quote.code} trustline needed`
          : !plan.ok
            ? (plan.errors[0] ?? "Enter a range and an amount")
            : soldAccess.available !== null && need > soldAccess.available + 1e-9
              ? `Insufficient ${sold.code} (available ${soldAccess.available})`
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

  return { id: s.id, venue, yieldOn, inst, sdexQuote: sq, unavailable, guard, blockedBy, signatures, addTrust, needsReceiptTrustline, reserveXlm, crossing, ref: reference, summary, yieldName, strategy };
}

export function crossText(d: Destination, side: Side, base: string, quote: string, receipt: string, bins: number): string {
  const n = `${d.crossing} of ${bins} level${bins === 1 ? "" : "s"}`;
  const vs = side === "Ask" ? "at or under the best bid" : "at or above the best ask";
  const r = `reference ${d.ref.price.toFixed(4)}, ${d.ref.source}`;
  if (d.venue === "pool")
    return `${n} sit ${vs} of the pool bins or ${base}/${quote} (${r}): they would be arbitraged at once instead of waiting. Move the range ${side === "Ask" ? "up" : "down"}.`;
  return `${n} ${vs} of ${base}/${d.yieldOn ? receipt : quote} (${r}): they fill immediately as a taker instead of waiting. Move the range ${side === "Ask" ? "up" : "down"}.`;
}
