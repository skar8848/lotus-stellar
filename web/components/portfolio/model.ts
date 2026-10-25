// Pure data model for /portfolio: price map, balance rows, pool valuation, activity rows.
// No React in here. Display math uses JS numbers (never used to build a transaction).

import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { bestPrices } from "@/lib/book";
import type { LotusConfig, PoolInstance, Strategy } from "@/lib/config-types";
import type { Position } from "@/lib/pool";
import {
  assetKey,
  assetReady,
  eventAmount,
  eventName,
  fetchOrderBook,
  fetchTrades,
  fmt,
  fromStroops,
  sameAsset,
  shortAddr,
  toAssetRef,
  type AccountOp,
  type AssetRef,
  type ContractEvent,
  type HorizonAccount,
  type HorizonBalance,
} from "@/lib/stellar";

export const XLM: AssetRef = { code: "XLM", issuer: null };

// ---------------------------------------------------------------------------
// Prices (USDC-equivalent). Only real data: reference USDC, receipts at par, order-book mids, last trades.
// ---------------------------------------------------------------------------

export type PriceInfo = { price: number; source: string };
export type PriceMap = Record<string, PriceInfo>;

type BookPrice = { price: number; source: string };

/** Mid of a two-sided book, else the last trade, else null. */
async function bookPrice(horizon: string, base: AssetRef, quote: AssetRef): Promise<BookPrice | null> {
  const book = await fetchOrderBook(horizon, base, quote, 5).catch(() => null);
  const { bid, ask } = bestPrices(book);
  if (bid !== null && ask !== null) return { price: (bid + ask) / 2, source: "order book mid" };
  const trades = await fetchTrades(horizon, base, quote, 1).catch(() => []);
  const last = trades[0];
  if (last && Number.isFinite(last.price) && last.price > 0) return { price: last.price, source: "last trade" };
  return null;
}

/**
 * Reference unit is the first strategy's underlying (USDC). Receipts are valued at par (1:1 redemption,
 * undistributed surplus not counted); LBOND through its first receipt book that has a price; XLM through an
 * XLM/USDC book when one exists. Everything else has no price.
 */
export async function loadPrices(config: LotusConfig): Promise<PriceMap> {
  const out: PriceMap = {};
  const usdc = config.underlying;
  if (assetReady(usdc)) out[assetKey(usdc)] = { price: 1, source: "reference unit" };
  const strategies = config.strategies.filter((s) => assetReady(s.receipt));
  for (const s of strategies) {
    if (assetReady(s.underlying) && assetKey(s.underlying) === assetKey(usdc)) {
      out[assetKey(s.receipt)] = { price: 1, source: "par redemption" };
    }
  }
  const rwa = config.rwa;
  const bond = (async () => {
    if (!assetReady(rwa)) return;
    for (const s of strategies) {
      const par = out[assetKey(s.receipt)];
      if (!par) continue;
      const p = await bookPrice(config.horizon, rwa, s.receipt);
      if (p) {
        out[assetKey(rwa)] = { price: p.price * par.price, source: `${rwa.code}/${s.receipt.code} ${p.source}, ${s.receipt.code} at par` };
        return;
      }
    }
  })();
  const xlm = (async () => {
    if (!assetReady(usdc)) return;
    const p = await bookPrice(config.horizon, XLM, usdc);
    if (p) out[assetKey(XLM)] = { price: p.price, source: `XLM/${usdc.code} ${p.source}` };
  })();
  await Promise.all([bond, xlm]);
  return out;
}

// ---------------------------------------------------------------------------
// Balance rows
// ---------------------------------------------------------------------------

export type RowKind = "native" | "underlying" | "receipt" | "bond" | "other" | "lp";

export type BalanceRow = {
  key: string;
  kind: RowKind;
  asset: AssetRef | null;
  code: string;
  /** native balance or an existing trustline */
  held: boolean;
  balance: number;
  /** balance minus selling liabilities (minus the base reserve for XLM) */
  available: number | null;
  inOffers: number;
  /** trustline exists but the issuer has not authorized it */
  unauthorized: boolean;
  price: PriceInfo | null;
  value: number | null;
  poolId?: string;
};

const num = (v: string | undefined | null): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function makeRow(kind: RowKind, asset: AssetRef, bal: HorizonBalance | undefined, acct: HorizonAccount | null, prices: PriceMap): BalanceRow {
  const key = assetKey(asset);
  const balance = num(bal?.balance);
  const locked = num(bal?.selling_liabilities);
  const reserve = kind === "native" && acct ? (2 + acct.subentry_count) * 0.5 : 0;
  const price = prices[key] ?? null;
  return {
    key,
    kind,
    asset,
    code: asset.issuer ? asset.code : "XLM",
    held: !!bal,
    balance,
    available: bal ? Math.max(0, balance - locked - reserve) : null,
    inOffers: locked,
    unauthorized: bal?.is_authorized === false,
    price,
    value: price ? balance * price.price : null,
  };
}

/** XLM, the underlying(s), every receipt, LBOND, then any other asset the account holds. */
export function buildBalanceRows(config: LotusConfig, acct: HorizonAccount | null, prices: PriceMap): BalanceRow[] {
  const rows: BalanceRow[] = [];
  const seen = new Set<string>();
  const find = (a: AssetRef) => acct?.balances.find((b) => (a.issuer ? sameAsset(b, a) : b.asset_type === "native"));
  const push = (asset: AssetRef, kind: RowKind) => {
    const key = assetKey(asset);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(makeRow(kind, asset, find(asset), acct, prices));
  };
  push(XLM, "native");
  for (const s of config.strategies) if (assetReady(s.underlying)) push(s.underlying, "underlying");
  if (assetReady(config.underlying)) push(config.underlying, "underlying");
  for (const s of config.strategies) if (assetReady(s.receipt)) push(s.receipt, "receipt");
  if (assetReady(config.rwa)) push(config.rwa, "bond");

  const others: BalanceRow[] = [];
  for (const b of acct?.balances ?? []) {
    if (b.asset_type === "native") continue;
    if (b.asset_type === "liquidity_pool_shares") {
      const id = (b as unknown as { liquidity_pool_id?: string }).liquidity_pool_id ?? "";
      others.push({
        key: `lp:${id}`,
        kind: "lp",
        asset: null,
        code: "Pool share",
        held: true,
        balance: num(b.balance),
        available: num(b.balance),
        inOffers: 0,
        unauthorized: false,
        price: null,
        value: null,
        poolId: id,
      });
      continue;
    }
    const asset = toAssetRef(b);
    const key = assetKey(asset);
    if (seen.has(key)) continue;
    seen.add(key);
    others.push(makeRow("other", asset, b, acct, prices));
  }
  others.sort((a, b) => a.code.localeCompare(b.code));
  return [...rows, ...others];
}

export type WalletTotals = { value: number; priced: number; excluded: number };

/** Sum of priced balances; `excluded` counts assets the account holds that have no price. */
export function walletTotals(rows: BalanceRow[]): WalletTotals {
  let value = 0;
  let priced = 0;
  let excluded = 0;
  for (const r of rows) {
    if (r.balance <= 0) continue;
    if (r.value === null) excluded++;
    else {
      value += r.value;
      priced++;
    }
  }
  return { value, priced, excluded };
}

// ---------------------------------------------------------------------------
// Pool positions
// ---------------------------------------------------------------------------

export type PositionUnits = { inventory: AssetRef; proceeds: AssetRef; fees: AssetRef };

/** Ask: inventory in BASE, proceeds and fees in QUOTE. Bid: inventory in QUOTE, proceeds in BASE, fees in QUOTE. */
export function positionUnits(p: Position, inst: PoolInstance): PositionUnits {
  const base: AssetRef = { code: inst.base.code, issuer: inst.base.issuer };
  const quote: AssetRef = { code: inst.quote.code, issuer: inst.quote.issuer };
  return p.side === "Ask" ? { inventory: base, proceeds: quote, fees: quote } : { inventory: quote, proceeds: base, fees: quote };
}

const stroopsNum = (v: bigint) => Number(fromStroops(v));

/** USDC-equivalent value of on-chain pool positions (inventory + pending proceeds and fees), skipping unpriced legs. */
export function poolValue(positions: { inst: PoolInstance; position: Position }[], prices: PriceMap): { value: number; excluded: number } {
  let value = 0;
  let excluded = 0;
  for (const { inst, position: p } of positions) {
    const u = positionUnits(p, inst);
    const legs: [bigint, AssetRef][] = [
      [p.inventory, u.inventory],
      [p.pendingProceeds, u.proceeds],
      [p.pendingFees, u.fees],
    ];
    for (const [amt, asset] of legs) {
      if (amt <= 0n) continue;
      const px = prices[assetKey(asset)];
      if (px) value += stroopsNum(amt) * px.price;
      else excluded++;
    }
  }
  return { value, excluded };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type ActivityKind = "op" | "fill" | "vault";
export type ActivityRow = {
  id: string;
  time: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  tx: string | null;
};

const assetCode = (type: unknown, code: unknown): string => (type === "native" ? "XLM" : typeof code === "string" && code ? code : "?");
const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");

function decodeInvoke(op: AccountOp): { contract: string; fn: string } | null {
  const params = (op as Record<string, unknown>).parameters as { type: string; value: string }[] | undefined;
  if (!Array.isArray(params) || params.length < 2) return null;
  try {
    const contract = scValToNative(xdr.ScVal.fromXDR(params[0].value, "base64"));
    const fn = scValToNative(xdr.ScVal.fromXDR(params[1].value, "base64"));
    return { contract: String(contract), fn: String(fn) };
  } catch {
    return null;
  }
}

/** Net balance change of `me` from a contract call's asset_balance_changes, e.g. "+5 lUSDC, -150 USDC". */
function netChange(op: AccountOp, me: string): string {
  const changes = (op as Record<string, unknown>).asset_balance_changes as
    | { asset_type?: string; asset_code?: string; from?: string; to?: string; amount?: string }[]
    | undefined;
  if (!Array.isArray(changes)) return "";
  const net = new Map<string, number>();
  for (const c of changes) {
    const code = assetCode(c.asset_type, c.asset_code);
    const a = Number(c.amount ?? 0);
    if (!Number.isFinite(a)) continue;
    if (c.to === me) net.set(code, (net.get(code) ?? 0) + a);
    if (c.from === me) net.set(code, (net.get(code) ?? 0) - a);
  }
  return [...net.entries()]
    .filter(([, v]) => v !== 0)
    .map(([code, v]) => `${v > 0 ? "+" : "-"}${fmt(Math.abs(v), 4)} ${code}`)
    .join(", ");
}

/** Human label for a Horizon operation of (or touching) the account. */
export function describeOp(op: AccountOp, me: string, contractNames: Map<string, string>): { title: string; detail?: string } {
  const o = op as Record<string, unknown>;
  const amt = (k: string) => fmt(str(o, k), 4);
  switch (op.type) {
    case "payment": {
      const asset = assetCode(o.asset_type, o.asset_code);
      const from = str(o, "from");
      const to = str(o, "to");
      if (from === me && to !== me) return { title: `Payment sent: ${amt("amount")} ${asset}`, detail: `to ${shortAddr(to, 4)}` };
      if (to === me && from !== me) return { title: `Payment received: ${amt("amount")} ${asset}`, detail: `from ${shortAddr(from, 4)}` };
      return { title: `Payment: ${amt("amount")} ${asset}` };
    }
    case "path_payment_strict_send":
    case "path_payment_strict_receive": {
      const src = assetCode(o.source_asset_type, o.source_asset_code);
      const dst = assetCode(o.asset_type, o.asset_code);
      const text = `${amt("source_amount")} ${src} to ${amt("amount")} ${dst}`;
      const from = str(o, "from");
      return { title: `Path payment: ${text}`, detail: from && from !== me ? `sent by ${shortAddr(from, 4)}` : undefined };
    }
    case "manage_sell_offer":
    case "manage_buy_offer":
    case "create_passive_sell_offer": {
      const sell = assetCode(o.selling_asset_type, o.selling_asset_code);
      const buy = assetCode(o.buying_asset_type, o.buying_asset_code);
      const id = str(o, "offer_id");
      const price = fmt(str(o, "price"), 4, 4);
      const cancelled = Number(str(o, "amount")) === 0;
      if (cancelled) return { title: `Offer cancelled${id && id !== "0" ? ` #${id}` : ""}`, detail: `${sell} for ${buy}` };
      const verb = op.type === "manage_buy_offer" ? `buy ${amt("amount")} ${buy} with ${sell}` : `sell ${amt("amount")} ${sell} for ${buy}`;
      const created = !id || id === "0";
      return { title: `Offer ${created ? "created" : `updated #${id}`}: ${verb} @ ${price}`, detail: op.type === "create_passive_sell_offer" ? "passive" : undefined };
    }
    case "change_trust": {
      if (o.asset_type === "liquidity_pool_shares") return { title: "Liquidity pool trustline" };
      const code = assetCode(o.asset_type, o.asset_code);
      return { title: Number(str(o, "limit")) === 0 ? `Trustline removed: ${code}` : `Trustline added: ${code}` };
    }
    case "set_trust_line_flags":
    case "allow_trust": {
      const code = assetCode(o.asset_type, o.asset_code);
      const flags = (o.set_flags_s as string[] | undefined) ?? [];
      return { title: `${code} trustline ${flags.includes("authorized") || op.type === "allow_trust" ? "authorized" : "flags updated"} by the issuer` };
    }
    case "create_account":
      return { title: `Account created with ${fmt(str(o, "starting_balance"), 2)} XLM` };
    case "invoke_host_function": {
      const d = decodeInvoke(op);
      const net = netChange(op, me);
      const source = str(o, "source_account");
      if (!d) return { title: "Contract call", detail: net || undefined };
      const name = contractNames.get(d.contract) ?? shortAddr(d.contract, 4);
      const parts = [name, source && source !== me ? `by ${shortAddr(source, 4)}` : "", net].filter(Boolean);
      return { title: `Contract call: ${d.fn}`, detail: parts.join(" · ") };
    }
    default:
      return { title: op.type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) };
  }
}

type FillTrade = {
  id: string;
  time: string;
  price: number;
  baseAmount: string;
  counterAmount: string;
  baseIsSeller: boolean;
  baseAccount: string;
  counterAccount: string;
  opId: string;
  base: AssetRef;
  counter: AssetRef;
};

/** An order-book fill of the account, e.g. "Fill: sold 52.45 LBOND for 51.92 lUSDC @ 0.9900". */
export function describeFill(t: FillTrade, me: string): { title: string; detail?: string } {
  const meIsBase = t.baseAccount === me;
  const soldBase = meIsBase ? t.baseIsSeller : !t.baseIsSeller;
  const verb = soldBase ? "sold" : "bought";
  return {
    title: `Fill: ${verb} ${fmt(t.baseAmount, 4)} ${t.base.code} ${soldBase ? "for" : "with"} ${fmt(t.counterAmount, 4)} ${t.counter.code}`,
    detail: `@ ${fmt(t.price, 4, 4)} ${t.counter.code}/${t.base.code}`,
  };
}

/** Vault deposit / redeem of this account, from the lotus_vault events. */
export function describeVaultEvent(e: ContractEvent, strategy: Strategy | undefined): { title: string; detail?: string } | null {
  const name = eventName(e);
  const u = strategy?.underlying.code ?? "USDC";
  const r = strategy?.receipt.code ?? "lUSDC";
  if (name === "deposit") {
    const a = eventAmount(e, "amount");
    return { title: `Vault deposit: ${a !== null ? fmt(a, 4) : "?"} ${u} for ${r}`, detail: strategy ? strategy.label : undefined };
  }
  if (name === "redeem") {
    const a = eventAmount(e, "amount");
    const paid = eventAmount(e, "paid");
    return { title: `Vault redeem: ${a !== null ? fmt(a, 4) : "?"} ${r} for ${paid !== null ? fmt(paid, 4) : "?"} ${u}`, detail: strategy ? strategy.label : undefined };
  }
  return null;
}

/** Fixed-format local time for activity rows ("Oct 25, 21:09"). */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
