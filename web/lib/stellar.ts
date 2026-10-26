// Client-safe Stellar helpers: assets, amounts, Horizon reads, RPC views and tx flows.
// No node:fs here; everything takes the network config explicitly.

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { DECIMALS, SCALE, fromStroops, normalizeAmount, toStroops } from "./amount";
import { VAULT_RACE_MESSAGE, classifyFailure, stringifyDeep } from "./txErrors";

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type AssetRef = { code: string; issuer: string | null };

export const isNative = (a: AssetRef): boolean => !a.issuer;

/** Human label: "XLM" for native, otherwise the code. */
export const assetLabel = (a: AssetRef): string => (isNative(a) ? "XLM" : a.code);

/** Horizon "CODE:ISSUER" key, or "native". */
export const assetKey = (a: AssetRef): string => (isNative(a) ? "native" : `${a.code}:${a.issuer}`);

/** True when the asset is fully specified (native, or code + plausible issuer). */
export function assetReady(a: AssetRef | undefined | null): boolean {
  if (!a) return false;
  if (isNative(a)) return true;
  return a.code.length > 0 && a.code.length <= 12 && !!a.issuer && a.issuer.length === 56 && a.issuer.startsWith("G");
}

export const isContractId = (id: string | undefined | null): id is string =>
  !!id && id.length === 56 && id.startsWith("C");

export const toSdkAsset = (a: AssetRef): Asset => (isNative(a) ? Asset.native() : new Asset(a.code, a.issuer as string));

/** Query-string params Horizon expects for an asset, e.g. prefix "selling" -> selling_asset_type=... */
export function assetParams(prefix: string, a: AssetRef): Record<string, string> {
  if (isNative(a)) return { [`${prefix}_asset_type`]: "native" };
  const type = a.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  return {
    [`${prefix}_asset_type`]: type,
    [`${prefix}_asset_code`]: a.code,
    [`${prefix}_asset_issuer`]: a.issuer as string,
  };
}

type HorizonAssetFields = { asset_type: string; asset_code?: string; asset_issuer?: string };

export function sameAsset(f: HorizonAssetFields, a: AssetRef): boolean {
  if (f.asset_type === "native") return isNative(a);
  return !isNative(a) && f.asset_code === a.code && f.asset_issuer === a.issuer;
}

// ---------------------------------------------------------------------------
// Amounts (7 decimals everywhere on Stellar)
// ---------------------------------------------------------------------------

export { DECIMALS, SCALE, fromStroops, normalizeAmount, toStroops };

const nf = new Map<string, Intl.NumberFormat>();
function numberFormat(minDp: number, maxDp: number): Intl.NumberFormat {
  const k = `${minDp}:${maxDp}`;
  let f = nf.get(k);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: minDp, maximumFractionDigits: maxDp });
    nf.set(k, f);
  }
  return f;
}

/**
 * Format for display. Accepts decimal strings (Horizon), bigint stroops, or numbers.
 * null/undefined/NaN -> "—" (never fake a number on screen).
 */
export function fmt(v: string | number | bigint | null | undefined, dp = 2, minDp = 0): string {
  if (v === null || v === undefined) return "—";
  let n: number;
  if (typeof v === "bigint") n = Number(v) / Number(SCALE);
  else if (typeof v === "string") {
    if (v.trim() === "") return "—";
    n = Number(v);
  } else n = v;
  if (!Number.isFinite(n)) return "—";
  return numberFormat(minDp, dp).format(n);
}

export const shortAddr = (a: string, n = 4): string => (a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

// ---------------------------------------------------------------------------
// Horizon (plain fetch, typed just enough)
// ---------------------------------------------------------------------------

export type HorizonBalance = HorizonAssetFields & {
  balance: string;
  limit?: string;
  selling_liabilities?: string;
  buying_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
};

export type HorizonAccount = {
  id: string;
  sequence: string;
  subentry_count: number;
  balances: HorizonBalance[];
};

export type PriceLevel = { price: string; price_r: { n: number; d: number }; amount: string };
export type OrderBook = { bids: PriceLevel[]; asks: PriceLevel[] };

export type PathRecord = {
  source_amount: string;
  destination_amount: string;
  path: HorizonAssetFields[];
};

export type HorizonOffer = {
  id: string;
  seller: string;
  selling: HorizonAssetFields;
  buying: HorizonAssetFields;
  amount: string;
  price: string;
  price_r: { n: number; d: number };
  last_modified_time?: string;
};

/** Horizon asset fields -> AssetRef. */
export const toAssetRef = (f: HorizonAssetFields): AssetRef =>
  f.asset_type === "native" ? { code: "XLM", issuer: null } : { code: f.asset_code as string, issuer: f.asset_issuer as string };

export type Trade = {
  id: string;
  time: string;
  /** quote per base */
  price: number;
  baseAmount: string;
  counterAmount: string;
  baseIsSeller: boolean;
  baseAccount: string;
  counterAccount: string;
  /** Horizon operation id (resolve to a tx hash with fetchOperationTxHash). */
  opId: string;
  /** offer ids of both sides (a taker's side is a synthetic id shared by every hop of its operation) */
  baseOfferId?: string;
  counterOfferId?: string;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number };

export type AccountOp = {
  id: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction_successful: boolean;
  source_account: string;
  // type-specific fields (payment: from/to/amount/asset_*, manage_sell_offer: amount/price/selling_*/buying_*, ...)
  [k: string]: unknown;
};

export type AssetFlags = { authRequired: boolean; authRevocable: boolean; clawback: boolean; homeDomain: string | null };

async function hget<T>(horizon: string, pathAndQuery: string): Promise<T> {
  const res = await fetch(`${horizon}${pathAndQuery}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = (await res.json()) as { title?: string; detail?: string; extras?: { result_codes?: unknown } };
      detail = j.detail || j.title || detail;
    } catch {
      /* ignore */
    }
    const err = new Error(`Horizon ${detail}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** null when the account does not exist (unfunded). */
export async function fetchAccount(horizon: string, id: string): Promise<HorizonAccount | null> {
  try {
    return await hget<HorizonAccount>(horizon, `/accounts/${id}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

export const findBalance = (acct: HorizonAccount | null | undefined, a: AssetRef): HorizonBalance | undefined =>
  acct?.balances.find((b) => sameAsset(b, a));

/** Order book for `selling` priced in `buying`. Asks amount = selling units; bids amount = buying units (Horizon convention). */
export async function fetchOrderBook(horizon: string, selling: AssetRef, buying: AssetRef, limit = 20): Promise<OrderBook> {
  const q = qs({ ...assetParams("selling", selling), ...assetParams("buying", buying), limit: String(limit) });
  const ob = await hget<OrderBook>(horizon, `/order_book?${q}`);
  return { bids: ob.bids ?? [], asks: ob.asks ?? [] };
}

export async function fetchStrictSendPaths(
  horizon: string,
  source: AssetRef,
  sourceAmount: string,
  dest: AssetRef,
): Promise<PathRecord[]> {
  const q = qs({
    ...assetParams("source", source),
    source_amount: sourceAmount,
    destination_assets: assetKey(dest),
  });
  const r = await hget<{ _embedded: { records: PathRecord[] } }>(horizon, `/paths/strict-send?${q}`);
  return r._embedded?.records ?? [];
}

/** Accounts holding (a trustline to) a classic asset. */
export async function fetchHolders(horizon: string, asset: AssetRef, limit = 50): Promise<HorizonAccount[]> {
  if (isNative(asset)) return [];
  const r = await hget<{ _embedded: { records: HorizonAccount[] } }>(
    horizon,
    `/accounts?${qs({ asset: assetKey(asset), limit: String(limit) })}`,
  );
  return r._embedded?.records ?? [];
}

export async function fetchOffers(horizon: string, accountId: string): Promise<HorizonOffer[]> {
  const r = await hget<{ _embedded: { records: HorizonOffer[] } }>(horizon, `/accounts/${accountId}/offers?limit=200`);
  return r._embedded?.records ?? [];
}

type RawTrade = {
  id: string;
  ledger_close_time: string;
  base_amount: string;
  counter_amount: string;
  base_is_seller: boolean;
  base_account?: string;
  counter_account?: string;
  base_offer_id?: string;
  counter_offer_id?: string;
  price: { n: string; d: string };
  _links?: { operation?: { href?: string } };
};

function mapTrade(t: RawTrade): Trade {
  const n = Number(t.price?.n);
  const d = Number(t.price?.d);
  const opId = (t._links?.operation?.href ?? "").split("/").pop() ?? "";
  return {
    id: t.id,
    time: t.ledger_close_time,
    price: d > 0 ? n / d : NaN,
    baseAmount: t.base_amount,
    counterAmount: t.counter_amount,
    baseIsSeller: t.base_is_seller,
    baseAccount: t.base_account ?? "",
    counterAccount: t.counter_account ?? "",
    opId,
    baseOfferId: t.base_offer_id,
    counterOfferId: t.counter_offer_id,
  };
}

/** Recent trades of a market, newest first. price = counter (quote) per base. */
export async function fetchTrades(horizon: string, base: AssetRef, counter: AssetRef, limit = 30): Promise<Trade[]> {
  const q = qs({ ...assetParams("base", base), ...assetParams("counter", counter), order: "desc", limit: String(limit) });
  const r = await hget<{ _embedded: { records: RawTrade[] } }>(horizon, `/trades?${q}`);
  return (r._embedded?.records ?? []).map(mapTrade);
}

/** An account's recent trades (any market), newest first. Records carry the base/counter asset fields. */
export async function fetchAccountTrades(horizon: string, accountId: string, limit = 20) {
  type R = RawTrade & {
    base_asset_type: string;
    base_asset_code?: string;
    base_asset_issuer?: string;
    counter_asset_type: string;
    counter_asset_code?: string;
    counter_asset_issuer?: string;
  };
  const r = await hget<{ _embedded: { records: R[] } }>(horizon, `/accounts/${accountId}/trades?order=desc&limit=${limit}`);
  return (r._embedded?.records ?? []).map((t) => ({
    ...mapTrade(t),
    base: toAssetRef({ asset_type: t.base_asset_type, asset_code: t.base_asset_code, asset_issuer: t.base_asset_issuer }),
    counter: toAssetRef({ asset_type: t.counter_asset_type, asset_code: t.counter_asset_code, asset_issuer: t.counter_asset_issuer }),
  }));
}

/** OHLC candles from /trade_aggregations (only buckets with trades exist), oldest first. */
export async function fetchCandles(
  horizon: string,
  base: AssetRef,
  counter: AssetRef,
  resolutionMs: number,
  limit = 200,
): Promise<Candle[]> {
  const q = qs({
    ...assetParams("base", base),
    ...assetParams("counter", counter),
    resolution: String(resolutionMs),
    start_time: "0",
    end_time: String(Date.now() + resolutionMs),
    order: "desc",
    limit: String(limit),
  });
  type R = { timestamp: string; trade_count: string; base_volume: string; open: string; high: string; low: string; close: string };
  const r = await hget<{ _embedded: { records: R[] } }>(horizon, `/trade_aggregations?${q}`);
  return (r._embedded?.records ?? [])
    .map((a) => ({
      time: Math.floor(Number(a.timestamp) / 1000),
      open: Number(a.open),
      high: Number(a.high),
      low: Number(a.low),
      close: Number(a.close),
      volume: Number(a.base_volume),
      trades: Number(a.trade_count),
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close))
    .reverse();
}

const opHashCache = new Map<string, string>();
/** Horizon trade records only link the operation; resolve (and cache) its transaction hash. */
export async function fetchOperationTxHash(horizon: string, opId: string): Promise<string | null> {
  if (!opId) return null;
  const hit = opHashCache.get(opId);
  if (hit) return hit;
  try {
    const op = await hget<{ transaction_hash: string }>(horizon, `/operations/${opId}`);
    if (op.transaction_hash) opHashCache.set(opId, op.transaction_hash);
    return op.transaction_hash ?? null;
  } catch {
    return null;
  }
}

/** Operations of an account, newest first (payments, path payments, offers, trustlines, contract calls...). */
export async function fetchAccountOps(horizon: string, accountId: string, limit = 25): Promise<AccountOp[]> {
  const r = await hget<{ _embedded: { records: AccountOp[] } }>(
    horizon,
    `/accounts/${accountId}/operations?order=desc&limit=${limit}&include_failed=false`,
  );
  return r._embedded?.records ?? [];
}

const flagsCache = new Map<string, Promise<AssetFlags | null>>();
/** Authorization flags of an asset's issuer (AUTH_REQUIRED etc.), cached per issuer. */
export function fetchAssetFlags(horizon: string, issuer: string): Promise<AssetFlags | null> {
  let p = flagsCache.get(issuer);
  if (!p) {
    p = hget<{ flags?: { auth_required?: boolean; auth_revocable?: boolean; auth_clawback_enabled?: boolean }; home_domain?: string }>(
      horizon,
      `/accounts/${issuer}`,
    )
      .then((a) => ({
        authRequired: !!a.flags?.auth_required,
        authRevocable: !!a.flags?.auth_revocable,
        clawback: !!a.flags?.auth_clawback_enabled,
        homeDomain: a.home_domain ?? null,
      }))
      .catch(() => {
        flagsCache.delete(issuer);
        return null;
      });
    flagsCache.set(issuer, p);
  }
  return p;
}

/** Submit a signed classic transaction to Horizon; throws with result codes on failure. */
export async function submitHorizon(horizon: string, signedXdr: string): Promise<{ hash: string }> {
  const res = await fetch(`${horizon}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ tx: signedXdr }).toString(),
  });
  const j = (await res.json()) as {
    hash?: string;
    successful?: boolean;
    title?: string;
    detail?: string;
    extras?: { result_codes?: { transaction?: string; operations?: string[] } };
  };
  if (!res.ok || j.successful === false) {
    const rc = j.extras?.result_codes;
    const ops = rc?.operations?.filter((c) => c !== "op_success");
    const msg = rc ? [rc.transaction, ...(ops ?? [])].filter(Boolean).join(" / ") : j.detail || j.title || `HTTP ${res.status}`;
    throw new Error(explainResultCode(msg));
  }
  return { hash: j.hash as string };
}

/** Friendlier wording for the result codes a demo is likely to hit. */
export function explainResultCode(code: string): string {
  const map: Record<string, string> = {
    op_no_trust: "no trustline for the asset (add it first)",
    op_not_authorized: "trustline not authorized by the issuer (LBOND is AUTH_REQUIRED)",
    op_underfunded: "insufficient balance",
    op_too_few_offers: "not enough liquidity in the book for this amount",
    op_under_dest_min: "fill would be below your minimum (slippage)",
    op_low_reserve: "below the XLM minimum reserve (each trustline/offer needs 0.5 XLM)",
    op_line_full: "destination trustline limit reached",
    op_no_destination: "destination account does not exist",
    op_over_sendmax: "the path would cost more than the maximum you allowed",
    op_src_no_trust: "no trustline for the asset you are paying with",
    op_src_not_authorized: "you are not authorized to hold the asset you are paying with",
    op_sell_no_trust: "no trustline for the asset you are selling",
    op_buy_no_trust: "no trustline for the asset you are buying (add it first)",
    op_sell_not_authorized: "you are not authorized to hold the asset you are selling",
    op_buy_not_authorized: "you are not authorized by the issuer to hold the asset you are buying",
    op_cross_self: "this offer would cross one of your own offers (cancel it or move the price)",
    op_not_found: "offer not found (already filled or cancelled)",
    op_malformed: "malformed operation (check price and amount)",
    op_no_issuer: "the asset issuer account does not exist",
    tx_bad_seq: "bad sequence number (retry)",
    tx_insufficient_fee: "fee too low (network congested)",
    tx_bad_auth: "signature rejected",
    tx_failed: "an operation failed",
    txBadSeq: "bad sequence number (retry)",
    txInsufficientFee: "fee too low (network congested)",
    txBadAuth: "signature rejected",
    txFailed: "an operation failed",
    txNoAccount: "source account does not exist",
    txInsufficientBalance: "not enough XLM for fees/reserve",
    txSorobanInvalid: "invalid Soroban transaction (re-simulate and retry)",
  };
  return code
    .split(" / ")
    .map((c) => (map[c] ? `${c}: ${map[c]}` : c))
    .join(" / ");
}

// ---------------------------------------------------------------------------
// Soroban RPC: views
// ---------------------------------------------------------------------------

export type NetCfg = { rpc: string; horizon: string; passphrase: string };

/** All-zero public key; valid as a simulation source for read-only invocations. */
export const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export async function simulateView<T = unknown>(
  net: NetCfg,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  source: string = SIM_SOURCE,
): Promise<T> {
  const server = new rpc.Server(net.rpc);
  const tx = new TransactionBuilder(new Account(source, "0"), { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(prettySimError(sim.error));
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("simulation returned no result");
  return scValToNative(sim.result.retval) as T;
}

export type VaultStats = {
  vaultValue: bigint | null;
  supply: bigint | null;
  surplus: bigint | null;
  config: Record<string, unknown> | null;
  errors: string[];
};

export async function readVaultStats(net: NetCfg, contractId: string, source?: string): Promise<VaultStats> {
  const src = source ?? SIM_SOURCE;
  const [vv, sp, su, cf] = await Promise.allSettled([
    simulateView<bigint>(net, contractId, "vault_value", [], src),
    simulateView<bigint>(net, contractId, "supply", [], src),
    simulateView<bigint>(net, contractId, "surplus", [], src),
    simulateView<Record<string, unknown>>(net, contractId, "get_config", [], src),
  ]);
  const pick = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  const errors = [vv, sp, su, cf].filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r));
  const asBig = (v: unknown): bigint | null => (typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : null);
  return {
    vaultValue: asBig(pick(vv)),
    supply: asBig(pick(sp)),
    surplus: asBig(pick(su)),
    config: pick(cf),
    errors,
  };
}

/**
 * Name of the top-level TransactionResultCode (e.g. "tx_bad_seq", "txBadSeq", "tx_failed").
 * Duck-typed: SDK v17 exposes `result.type`, other versions `.result().switch()` or `{ code }`.
 */
export function txResultCode(res: unknown): string | undefined {
  try {
    const r = res as { result?: unknown };
    const inner = typeof r?.result === "function" ? (r.result as () => unknown)() : r?.result;
    // SDK v17 exposes the union as { type: "tx_bad_seq" | "tx_failed" | ... }
    const t = (inner as { type?: unknown } | undefined)?.type;
    if (typeof t === "string") return t;
    const u = inner as { code?: unknown; switch?: () => unknown } | undefined;
    const code = u?.code ?? (typeof u?.switch === "function" ? u.switch() : undefined);
    if (code === undefined || code === null) return undefined;
    if (typeof code === "number") return TX_RESULT_CODES[code] ?? String(code);
    const c = code as { name?: string; value?: number };
    if (typeof c === "object" && c.name) return c.name;
    if (typeof c === "object" && typeof c.value === "number") return TX_RESULT_CODES[c.value] ?? String(c.value);
    return String(code);
  } catch {
    return undefined;
  }
}

const TX_RESULT_CODES: Record<number, string> = {
  1: "txFeeBumpInnerSuccess",
  0: "txSuccess",
  [-1]: "txFailed",
  [-2]: "txTooEarly",
  [-3]: "txTooLate",
  [-4]: "txMissingOperation",
  [-5]: "txBadSeq",
  [-6]: "txBadAuth",
  [-7]: "txInsufficientBalance",
  [-8]: "txNoAccount",
  [-9]: "txInsufficientFee",
  [-10]: "txBadAuthExtra",
  [-11]: "txInternalError",
  [-12]: "txNotSupported",
  [-13]: "txFeeBumpInnerFailed",
  [-14]: "txBadSponsorship",
  [-15]: "txBadMinSeqAgeOrGap",
  [-16]: "txMalformed",
  [-17]: "txSorobanInvalid",
  [-18]: "txFrozenKeyAccessed",
};

function prettySimError(e: string): string {
  // Pull the contract's own error / panic message out of the diagnostic blob when present.
  const m = e.match(/Error\(Contract, #(\d+)\)/) || e.match(/HostError: (.+?)(\n|$)/);
  if (m) return m[0].length > 160 ? m[0].slice(0, 160) + "…" : m[0];
  return e.length > 200 ? e.slice(0, 200) + "…" : e;
}

// ---------------------------------------------------------------------------
// Transaction flows
// ---------------------------------------------------------------------------

export type Signer = (xdr: string) => Promise<string>;
export type TxStage = "building" | "simulating" | "signing" | "sending" | "confirming" | "done";

export type InvokeParams = {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  source: string;
  sign: Signer;
  onStage?: (s: TxStage, note?: string) => void;
};

/** True when an error means "the sequence number was already used" (another tx from the same account got in first). */
export const isBadSeq = (e: unknown): boolean => /txBadSeq|tx_bad_seq|bad sequence/i.test(e instanceof Error ? e.message : String(e));

/** Human text for a failed sendTransaction: decoded result code when possible, otherwise the raw XDR so it is diagnosable. */
function describeSendError(sent: { status: string; errorResult?: unknown }): string {
  const code = txResultCode(sent.errorResult);
  if (code) return explainResultCode(code);
  try {
    const raw = (sent.errorResult as { toXDR?: (f: string) => string } | undefined)?.toXDR?.("base64");
    return raw ? `result ${raw.slice(0, 40)}` : sent.status;
  } catch {
    return sent.status;
  }
}

/**
 * simulate -> assemble -> sign -> send -> poll. Returns the tx hash and decoded return value.
 * One automatic retry on a bad sequence number (a concurrent transaction from the same account, e.g. a bot or
 * another tab, can consume it between our read and our submit); a hardware or extension wallet will ask to sign again.
 */
export async function invokeContract(net: NetCfg, p: InvokeParams): Promise<{ hash: string; result: unknown }> {
  let badSeqRetried = false;
  let footprintRetries = 0;
  for (;;) {
    try {
      // every attempt simulates again right before signing: no cached simulation is ever reused
      return await invokeOnce(net, p);
    } catch (e) {
      const kind = (e as { failureKind?: string })?.failureKind ?? (isBadSeq(e) ? "bad-seq" : "other");
      if (kind === "bad-seq" && !badSeqRetried) {
        badSeqRetried = true;
        p.onStage?.("building");
        continue;
      }
      if (kind === "footprint") {
        // shared-vault footprint race: re-simulate, re-sign and resend (twice), then say what happened
        if (footprintRetries < 2) {
          footprintRetries++;
          await new Promise((r) => setTimeout(r, 1200 * footprintRetries));
          p.onStage?.("building", "vault state changed, retrying");
          continue;
        }
        throw new Error(VAULT_RACE_MESSAGE);
      }
      throw e;
    }
  }
}

/** Account object at the current Horizon sequence (Horizon, not RPC: a classic tx just confirmed there may lag on RPC). */
async function sourceAccount(net: NetCfg, source: string): Promise<Account> {
  const acct = await fetchAccount(net.horizon, source);
  if (!acct) throw new Error("source account not found on testnet (fund it with Friendbot first)");
  return new Account(source, acct.sequence);
}

/**
 * Build, simulate and assemble ONE contract invocation on `account` (its sequence is bumped by one, so a second
 * transaction built on the same Account object gets the next sequence number). Returns the unsigned transaction.
 */
export async function prepareInvoke(
  net: NetCfg,
  account: Account,
  call: { contractId: string; method: string; args: xdr.ScVal[] },
): Promise<ReturnType<TransactionBuilder["build"]>> {
  const server = new rpc.Server(net.rpc);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(new Contract(call.contractId).call(call.method, ...call.args))
    .setTimeout(180)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(prettySimError(sim.error));
  return rpc.assembleTransaction(tx, sim).build();
}

/** A classic transaction on `account` (sequence bumped by one). */
export function buildClassicTx(net: NetCfg, account: Account, ops: xdr.Operation[], feePerOp = "1000") {
  const builder = new TransactionBuilder(account, { fee: feePerOp, networkPassphrase: net.passphrase });
  for (const op of ops) builder.addOperation(op);
  return builder.setTimeout(180).build();
}

async function invokeOnce(net: NetCfg, p: InvokeParams): Promise<{ hash: string; result: unknown }> {
  p.onStage?.("building");
  const account = await sourceAccount(net, p.source);
  p.onStage?.("simulating");
  const prepared = await prepareInvoke(net, account, p);
  p.onStage?.("signing");
  const signedXdr = await p.sign(prepared.toXDR());
  return sendSorobanSigned(net, signedXdr, p.onStage);
}

/**
 * Send a signed Soroban transaction through RPC and wait for it. Throws with `failureKind` set
 * ("footprint" / "bad-seq" / "other") and `included` = true when the transaction made it into a ledger
 * (its sequence number is then consumed even though it failed).
 */
export async function sendSorobanSigned(
  net: NetCfg,
  signedXdr: string,
  onStage?: (s: TxStage, note?: string) => void,
): Promise<{ hash: string; result: unknown }> {
  const server = new rpc.Server(net.rpc);
  const signed = TransactionBuilder.fromXDR(signedXdr, net.passphrase);
  const p = { onStage };
  p.onStage?.("sending");
  let sent = await server.sendTransaction(signed);
  // TRY_AGAIN_LATER = the node is busy: resend the SAME signed transaction (no new signature needed)
  for (let i = 1; i <= 3 && sent.status === "TRY_AGAIN_LATER"; i++) {
    await new Promise((r) => setTimeout(r, 1500 * i));
    sent = await server.sendTransaction(signed);
  }
  // DUPLICATE means the node already has this exact transaction: keep polling its hash
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new Error(`send failed (${sent.status}: ${describeSendError(sent)})`);
  }

  p.onStage?.("confirming");
  // poll past the transaction's 180 s time bound (prepareInvoke), so a slow inclusion is never reported as
  // "nothing moved": after the bound the status is final either way
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const got = await server.getTransaction(sent.hash);
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      p.onStage?.("done");
      let result: unknown = undefined;
      try {
        result = got.returnValue ? scValToNative(got.returnValue) : undefined;
      } catch {
        /* non-decodable return */
      }
      return { hash: sent.hash, result };
    }
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
      const code = txResultCode(got.resultXdr);
      const detail = stringifyDeep([got.resultXdr, (got as { diagnosticEventsXdr?: unknown }).diagnosticEventsXdr]);
      const kind = classifyFailure({ txCode: code, detail });
      throw Object.assign(new Error(code ? `failed on-chain: ${explainResultCode(code)}` : "transaction failed on-chain"), {
        failureKind: kind,
        included: true,
        hash: sent.hash,
      });
    }
  }
  throw new Error(`timed out waiting for ${sent.hash}`);
}

export type ClassicParams = {
  source: string;
  ops: xdr.Operation[];
  sign: Signer;
  onStage?: (s: TxStage, note?: string) => void;
  /** Fee per operation in stroops (default 1000 = 0.0001 XLM). */
  feePerOp?: string;
};

/** Stellar's hard limit: at most 100 operations per transaction. */
export const MAX_OPS_PER_TX = 100;

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Build a classic (non-Soroban) tx from Horizon account state, sign, submit to Horizon (one retry on a bad sequence number). */
export async function submitClassic(net: NetCfg, p: ClassicParams): Promise<{ hash: string }> {
  try {
    return await submitClassicOnce(net, p);
  } catch (e) {
    if (!isBadSeq(e)) throw e;
    return await submitClassicOnce(net, p);
  }
}

async function submitClassicOnce(net: NetCfg, p: ClassicParams): Promise<{ hash: string }> {
  p.onStage?.("building");
  const acct = await fetchAccount(net.horizon, p.source);
  if (!acct) throw new Error("source account not found on testnet (fund it with Friendbot first)");
  const builder = new TransactionBuilder(new Account(p.source, acct.sequence), {
    fee: p.feePerOp ?? "1000",
    networkPassphrase: net.passphrase,
  });
  for (const op of p.ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();

  p.onStage?.("signing");
  const signedXdr = await p.sign(tx.toXDR());

  p.onStage?.("sending");
  const r = await submitHorizon(net.horizon, signedXdr);
  p.onStage?.("done");
  return r;
}

/**
 * Same as submitClassic but splits `ops` into transactions of at most `chunkSize` (<= 100, the
 * network limit), submitted one after the other (one signature each). A failure in a later chunk
 * leaves the earlier ones on-chain; the error says how many were placed.
 */
export async function submitClassicChunked(
  net: NetCfg,
  p: ClassicParams & { chunkSize?: number },
): Promise<{ hashes: string[] }> {
  const size = Math.min(MAX_OPS_PER_TX, Math.max(1, p.chunkSize ?? MAX_OPS_PER_TX));
  const parts = chunk(p.ops, size);
  const hashes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const tag = parts.length > 1 ? `tx ${i + 1}/${parts.length}` : undefined;
    try {
      const r = await submitClassic(net, { ...p, ops: parts[i], onStage: (s) => p.onStage?.(s, tag) });
      hashes.push(r.hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (hashes.length > 0) throw new Error(`${hashes.length} of ${parts.length} transactions went through; tx ${i + 1} failed: ${msg}`);
      throw e;
    }
  }
  return { hashes };
}

/** Error of submitSorobanThenClassic: which phase failed, and the first hash when the first phase went through. */
export class PairError extends Error {
  constructor(
    message: string,
    readonly phase: "first" | "second",
    readonly firstHash: string | null,
  ) {
    super(message);
    this.name = "PairError";
  }
}

async function waitSequenceAbove(net: NetCfg, source: string, seq: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const a = await fetchAccount(net.horizon, source).catch(() => null);
    if (a && BigInt(a.sequence) > BigInt(seq)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Two transactions that cannot be atomic (a Soroban transaction carries exactly one operation, so a contract call
 * and classic offers never share a transaction): tx1 = the contract call at sequence s+1, tx2 = the classic ops at
 * s+2. Both are built and signed up front (two signatures, one after the other), then tx1 is sent and awaited, and
 * tx2 is sent ONLY if tx1 succeeded. If tx1 failed, tx2 is dropped and never sent (a tx1 that was included but
 * failed consumed s+1, so tx2 would otherwise be valid: it must not leave this function). A footprint race on tx1
 * (shared DeFindex vault, see txErrors.ts) rebuilds and re-signs BOTH, up to 2 times.
 */
export async function submitSorobanThenClassic(
  net: NetCfg,
  p: {
    source: string;
    sign: Signer;
    call: { contractId: string; method: string; args: xdr.ScVal[] };
    ops: xdr.Operation[];
    onStage?: (s: TxStage, note?: string) => void;
    labels?: [string, string];
  },
): Promise<{ hashes: [string, string]; result: unknown }> {
  const [l1, l2] = p.labels ?? ["tx 1/2", "tx 2/2"];
  let footprintRetries = 0;
  let badSeqRetried = false;
  for (;;) {
    p.onStage?.("building", l1);
    const account = await sourceAccount(net, p.source);
    const startSeq = account.sequenceNumber();
    p.onStage?.("simulating", l1);
    let tx1: Awaited<ReturnType<typeof prepareInvoke>>;
    try {
      tx1 = await prepareInvoke(net, account, p.call); // s+1
    } catch (e) {
      // simulation failed: nothing was signed or sent. #10 is the token contract's balance error
      const raw = e instanceof Error ? e.message : String(e);
      const msg = /Error\(Contract, #10\)/.test(raw) ? "insufficient balance for the deposit" : raw;
      throw new PairError(`${l1} failed in simulation, nothing moved and ${l2} was not sent: ${msg}`, "first", null);
    }
    const tx2 = buildClassicTx(net, account, p.ops); // s+2
    p.onStage?.("signing", `${l1} (signature 1 of 2)`);
    const s1 = await p.sign(tx1.toXDR());
    p.onStage?.("signing", `${l2} (signature 2 of 2)`);
    const s2 = await p.sign(tx2.toXDR());

    let r1: { hash: string; result: unknown };
    try {
      r1 = await sendSorobanSigned(net, s1, (s) => p.onStage?.(s, l1));
    } catch (e) {
      const kind = (e as { failureKind?: string })?.failureKind ?? (isBadSeq(e) ? "bad-seq" : "other");
      const included = (e as { included?: boolean })?.included === true;
      // tx2 (signed, sequence s+2) is dropped here in every case: it is never sent after a failed tx1
      if (kind === "footprint" && footprintRetries < 2) {
        footprintRetries++;
        if (included) await waitSequenceAbove(net, p.source, startSeq);
        await new Promise((r) => setTimeout(r, 1200 * footprintRetries));
        p.onStage?.("building", "vault state changed, rebuilding both transactions");
        continue;
      }
      if (kind === "bad-seq" && !badSeqRetried) {
        badSeqRetried = true;
        continue;
      }
      const msg = kind === "footprint" ? VAULT_RACE_MESSAGE : e instanceof Error ? e.message : String(e);
      throw new PairError(`${l1} failed, nothing moved and ${l2} was not sent: ${msg}`, "first", null);
    }

    try {
      const r2 = await submitHorizonResend(net.horizon, s2, (s) => p.onStage?.(s, l2));
      p.onStage?.("done");
      return { hashes: [r1.hash, r2.hash], result: r1.result };
    } catch (e) {
      throw new PairError(`${l2} failed: ${e instanceof Error ? e.message : String(e)}`, "second", r1.hash);
    }
  }
}

/** Submit a signed classic tx; on tx_bad_seq (Horizon/core one ledger behind the previous tx) resend the same XDR. */
async function submitHorizonResend(horizon: string, signedXdr: string, onStage?: (s: TxStage) => void): Promise<{ hash: string }> {
  onStage?.("sending");
  for (let i = 0; ; i++) {
    try {
      return await submitHorizon(horizon, signedXdr);
    } catch (e) {
      if (!isBadSeq(e) || i >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// Operation / argument builders
// ---------------------------------------------------------------------------

export const changeTrustOp = (asset: AssetRef): xdr.Operation => Operation.changeTrust({ asset: toSdkAsset(asset) });

export const addressArg = (g: string): xdr.ScVal => new Address(g).toScVal();
export const i128Arg = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

export type LadderLevel = { price: string; amount: string };
export type OfferSpec = { price: string | { n: number; d: number }; amount: string };

/** N manageSellOffer ops: sell `selling` for `buying` at each level. New offers (offerId 0). */
export function ladderOps(selling: AssetRef, buying: AssetRef, levels: OfferSpec[]): xdr.Operation[] {
  const s = toSdkAsset(selling);
  const b = toSdkAsset(buying);
  return levels.map((l) =>
    Operation.manageSellOffer({ selling: s, buying: b, amount: normalizeAmount(l.amount), price: l.price, offerId: "0" }),
  );
}

/**
 * Price argument for manageSellOffer. Exact reduced rational when it fits int32
 * (`invert` gives 1/price without rounding); otherwise a decimal string and the SDK
 * picks the best int32 approximation.
 */
export function priceArg(price: string, invert = false): string | { n: number; d: number } {
  let n = toStroops(price);
  let d = SCALE;
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const g = gcd(n, d);
  n /= g;
  d /= g;
  if (invert) [n, d] = [d, n];
  const MAX = 2147483647n;
  if (n <= 0n || d <= 0n || n > MAX || d > MAX) return invert ? (1 / Number(price)).toPrecision(12) : price;
  return { n: Number(n), d: Number(d) };
}

export function pathPaymentStrictSendOp(p: {
  sendAsset: AssetRef;
  sendAmount: string;
  destination: string;
  destAsset: AssetRef;
  destMin: string;
  path: AssetRef[];
}): xdr.Operation {
  return Operation.pathPaymentStrictSend({
    sendAsset: toSdkAsset(p.sendAsset),
    sendAmount: normalizeAmount(p.sendAmount),
    destination: p.destination,
    destAsset: toSdkAsset(p.destAsset),
    destMin: normalizeAmount(p.destMin),
    path: p.path.map(toSdkAsset),
  });
}

/** Build the ladder levels from the maker form. */
export function buildLadder(start: string, step: string, size: string, n: number): LadderLevel[] {
  const s = Number(start);
  const st = Number(step);
  if (!Number.isFinite(s) || !Number.isFinite(st) || s <= 0 || n < 1) return [];
  const out: LadderLevel[] = [];
  for (let i = 0; i < n; i++) {
    const price = s + st * i;
    if (price <= 0) break;
    out.push({ price: price.toFixed(7).replace(/0+$/, "").replace(/\.$/, ""), amount: size });
  }
  return out;
}

// Explorer links live in lib/explorer.ts.
export { explorerTx, explorerAccount, explorerContract } from "./explorer";

/** One manageSellOffer: sell `selling` for `buying`. offerId "0" creates; an existing id updates (amount "0" cancels). */
export function manageSellOfferOp(p: {
  selling: AssetRef;
  buying: AssetRef;
  amount: string;
  price: string | { n: number; d: number };
  offerId?: string;
}): xdr.Operation {
  return Operation.manageSellOffer({
    selling: toSdkAsset(p.selling),
    buying: toSdkAsset(p.buying),
    amount: normalizeAmount(p.amount),
    price: p.price,
    offerId: p.offerId ?? "0",
  });
}

/** Cancel an existing offer: same assets and price, amount 0, its id. */
export function cancelOfferOp(o: { id: string; selling: AssetRef; buying: AssetRef; price_r: { n: number; d: number } }): xdr.Operation {
  return manageSellOfferOp({ selling: o.selling, buying: o.buying, amount: "0", price: o.price_r, offerId: o.id });
}

// ---------------------------------------------------------------------------
// RPC events (best effort)
// ---------------------------------------------------------------------------

export type ContractEvent = {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  topics: unknown[];
  value: unknown;
  txHash: string;
  /** The lotus_vault contract that emitted it (set by fetchContractEventsMulti). */
  contractId?: string;
};

/** Events of several contracts merged, newest first. Best effort: contracts that fail are skipped. */
export async function fetchContractEventsMulti(net: NetCfg, contractIds: string[], lookbackLedgers = 17000): Promise<ContractEvent[]> {
  const all = await Promise.all(
    contractIds.map((id) =>
      fetchContractEvents(net, id, lookbackLedgers)
        .then((evs) => evs.map((e) => ({ ...e, contractId: id })))
        .catch(() => [] as ContractEvent[]),
    ),
  );
  return all.flat().sort((a, b) => (a.ledgerClosedAt < b.ledgerClosedAt ? 1 : a.ledgerClosedAt > b.ledgerClosedAt ? -1 : 0));
}

/** Event name from topics[0] ("deposit" | "redeem" | "distribute" | ...). */
export const eventName = (e: ContractEvent): string => (typeof e.topics[0] === "string" ? (e.topics[0] as string) : "event");

/** Read an i128 field out of a decoded event value ({amount, shares, ...}). */
export function eventAmount(e: ContractEvent, field: string): bigint | null {
  const v = e.value as Record<string, unknown> | null;
  const x = v && typeof v === "object" ? v[field] : undefined;
  return typeof x === "bigint" ? x : typeof x === "number" ? BigInt(x) : null;
}

/** Recent events emitted by the vault contract; empty on any failure (retention, no events...). */
export async function fetchContractEvents(net: NetCfg, contractId: string, lookbackLedgers = 17000): Promise<ContractEvent[]> {
  const server = new rpc.Server(net.rpc);
  const latest = await server.getLatestLedger();
  const tryFrom = async (from: number) => {
    const r = await server.getEvents({
      startLedger: Math.max(1, from),
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: 50,
    });
    return r.events ?? [];
  };
  let events: Awaited<ReturnType<typeof tryFrom>> = [];
  try {
    events = await tryFrom(latest.sequence - lookbackLedgers);
  } catch {
    // outside retention window: try a much shorter one
    events = await tryFrom(latest.sequence - 2000);
  }
  return events
    .map((e) => {
      const safe = (v: xdr.ScVal): unknown => {
        try {
          return scValToNative(v);
        } catch {
          return v.toXDR("base64");
        }
      };
      return {
        id: e.id,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt,
        topics: (e.topic ?? []).map(safe),
        value: safe(e.value),
        txHash: e.txHash,
      };
    })
    .reverse();
}
