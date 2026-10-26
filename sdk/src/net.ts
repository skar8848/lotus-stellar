// Network layer: Horizon reads (plain fetch), Soroban RPC simulation, result-code wording.
// Ported from web/lib/stellar.ts (same behaviour, no React, no browser-only code).

import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";

export type NetCfg = { rpc: string; horizon: string; passphrase: string };

export const TESTNET_PASSPHRASE = Networks.TESTNET;
export const isTestnet = (net: Pick<NetCfg, "passphrase">) => net.passphrase === Networks.TESTNET;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type AssetRef = { code: string; issuer: string | null };

export const isNative = (a: AssetRef): boolean => !a.issuer;
export const assetKey = (a: AssetRef): string => (isNative(a) ? "native" : `${a.code}:${a.issuer}`);
export const assetLabel = (a: AssetRef): string => (isNative(a) ? "XLM" : a.code);
export const sameAsset = (a: AssetRef, b: AssetRef) => a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);
export const toSdkAsset = (a: AssetRef): Asset => (isNative(a) ? Asset.native() : new Asset(a.code, a.issuer as string));
export const isContractId = (id: string | undefined | null): id is string => !!id && /^C[A-Z2-7]{55}$/.test(id);
export const isAccountId = (id: string | undefined | null): id is string => !!id && /^G[A-Z2-7]{55}$/.test(id);

export function assetReady(a: AssetRef | undefined | null): boolean {
  if (!a) return false;
  if (isNative(a)) return true;
  return a.code.length > 0 && a.code.length <= 12 && !!a.issuer && a.issuer.length === 56 && a.issuer.startsWith("G");
}

export function assetParams(prefix: string, a: AssetRef): Record<string, string> {
  if (isNative(a)) return { [`${prefix}_asset_type`]: "native" };
  const type = a.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  return { [`${prefix}_asset_type`]: type, [`${prefix}_asset_code`]: a.code, [`${prefix}_asset_issuer`]: a.issuer as string };
}

type HorizonAssetFields = { asset_type: string; asset_code?: string; asset_issuer?: string };
export const sameHorizonAsset = (f: HorizonAssetFields, a: AssetRef): boolean =>
  f.asset_type === "native" ? isNative(a) : !isNative(a) && f.asset_code === a.code && f.asset_issuer === a.issuer;
export const toAssetRef = (f: HorizonAssetFields): AssetRef =>
  f.asset_type === "native" ? { code: "XLM", issuer: null } : { code: f.asset_code as string, issuer: f.asset_issuer as string };

// ---------------------------------------------------------------------------
// Horizon
// ---------------------------------------------------------------------------

export type HorizonBalance = HorizonAssetFields & {
  balance: string;
  limit?: string;
  selling_liabilities?: string;
  buying_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
};
export type HorizonAccount = { id: string; sequence: string; subentry_count: number; balances: HorizonBalance[] };
export type PriceLevel = { price: string; price_r: { n: number; d: number }; amount: string };
export type OrderBook = { bids: PriceLevel[]; asks: PriceLevel[] };
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

export class HorizonError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HorizonError";
  }
}

export async function hget<T>(horizon: string, pathAndQuery: string): Promise<T> {
  const res = await fetch(`${horizon}${pathAndQuery}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = (await res.json()) as { title?: string; detail?: string };
      detail = j.detail || j.title || detail;
    } catch {
      /* ignore */
    }
    throw new HorizonError(`Horizon ${detail}`, res.status);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** null when the account does not exist (unfunded). */
export async function fetchAccount(horizon: string, id: string): Promise<HorizonAccount | null> {
  try {
    return await hget<HorizonAccount>(horizon, `/accounts/${id}`);
  } catch (e) {
    if (e instanceof HorizonError && e.status === 404) return null;
    throw e;
  }
}

export const findBalance = (acct: HorizonAccount | null | undefined, a: AssetRef): HorizonBalance | undefined =>
  acct?.balances.find((b) => sameHorizonAsset(b, a));

/** Order book for `selling` priced in `buying`. Asks amount = selling units; bids amount = buying units (Horizon convention). */
export async function fetchOrderBook(horizon: string, selling: AssetRef, buying: AssetRef, limit = 20): Promise<OrderBook> {
  const q = qs({ ...assetParams("selling", selling), ...assetParams("buying", buying), limit: String(limit) });
  const ob = await hget<OrderBook>(horizon, `/order_book?${q}`);
  return { bids: ob.bids ?? [], asks: ob.asks ?? [] };
}

/** Best bid / ask (QUOTE per BASE, decimal) of a Horizon book, null per empty side. Same as web/lib/book.ts bestPrices. */
export function bestPrices(book: OrderBook | null): { bid: number | null; ask: number | null } {
  const bid = book?.bids[0] ? Number(book.bids[0].price) : null;
  const ask = book?.asks[0] ? Number(book.asks[0].price) : null;
  return { bid: bid !== null && Number.isFinite(bid) ? bid : null, ask: ask !== null && Number.isFinite(ask) ? ask : null };
}

export async function fetchOffers(horizon: string, accountId: string): Promise<HorizonOffer[]> {
  const r = await hget<{ _embedded: { records: HorizonOffer[] } }>(horizon, `/accounts/${accountId}/offers?limit=200`);
  return r._embedded?.records ?? [];
}

export type Trade = { id: string; time: string; price: number; baseAmount: string; counterAmount: string; baseIsSeller: boolean };

/** Recent trades of a market, newest first. price = counter (quote) per base. */
export async function fetchTrades(horizon: string, base: AssetRef, counter: AssetRef, limit = 20): Promise<Trade[]> {
  type R = { id: string; ledger_close_time: string; base_amount: string; counter_amount: string; base_is_seller: boolean; price: { n: string; d: string } };
  const q = qs({ ...assetParams("base", base), ...assetParams("counter", counter), order: "desc", limit: String(limit) });
  const r = await hget<{ _embedded: { records: R[] } }>(horizon, `/trades?${q}`);
  return (r._embedded?.records ?? []).map((t) => ({
    id: t.id,
    time: t.ledger_close_time,
    price: Number(t.price.d) > 0 ? Number(t.price.n) / Number(t.price.d) : NaN,
    baseAmount: t.base_amount,
    counterAmount: t.counter_amount,
    baseIsSeller: t.base_is_seller,
  }));
}

export type AssetFlags = { authRequired: boolean; authRevocable: boolean; clawback: boolean };
const flagsCache = new Map<string, Promise<AssetFlags | null>>();
/** Authorization flags of an asset issuer (cached per issuer). */
export function fetchAssetFlags(horizon: string, issuer: string): Promise<AssetFlags | null> {
  let p = flagsCache.get(issuer);
  if (!p) {
    p = hget<{ flags?: { auth_required?: boolean; auth_revocable?: boolean; auth_clawback_enabled?: boolean } }>(horizon, `/accounts/${issuer}`)
      .then((a) => ({ authRequired: !!a.flags?.auth_required, authRevocable: !!a.flags?.auth_revocable, clawback: !!a.flags?.auth_clawback_enabled }))
      .catch(() => {
        flagsCache.delete(issuer);
        return null;
      });
    flagsCache.set(issuer, p);
  }
  return p;
}

/** Friendlier wording for common result codes (same table as web/lib/stellar.ts). */
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
    tx_bad_seq: "bad sequence number (rebuild the transaction)",
    tx_insufficient_fee: "fee too low (network congested)",
    tx_bad_auth: "signature rejected (signed by the wrong key or for the wrong network)",
    tx_failed: "an operation failed",
    tx_too_late: "transaction expired (rebuild it)",
    txBadSeq: "bad sequence number (rebuild the transaction)",
    txInsufficientFee: "fee too low (network congested)",
    txBadAuth: "signature rejected (signed by the wrong key or for the wrong network)",
    txFailed: "an operation failed",
    txTooLate: "transaction expired (rebuild it)",
    txNoAccount: "source account does not exist",
    txInsufficientBalance: "not enough XLM for fees/reserve",
    txSorobanInvalid: "invalid Soroban transaction (re-simulate and retry)",
  };
  return code
    .split(" / ")
    .map((c) => (map[c] ? `${c}: ${map[c]}` : c))
    .join(" / ");
}

export const isBadSeq = (e: unknown): boolean => /txBadSeq|tx_bad_seq|bad sequence/i.test(e instanceof Error ? e.message : String(e));

/** Name of the top-level TransactionResultCode, duck-typed across SDK versions (web/lib/stellar.ts txResultCode). */
export function txResultCode(res: unknown): string | undefined {
  try {
    const r = res as { result?: unknown };
    const inner = typeof r?.result === "function" ? (r.result as () => unknown)() : r?.result;
    const t = (inner as { type?: unknown } | undefined)?.type;
    if (typeof t === "string") return t;
    const u = inner as { code?: unknown; switch?: () => unknown } | undefined;
    const code = u?.code ?? (typeof u?.switch === "function" ? u.switch() : undefined);
    if (code === undefined || code === null) return undefined;
    const c = code as { name?: string; value?: number };
    if (typeof c === "object" && c.name) return c.name;
    return String(code);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Soroban RPC
// ---------------------------------------------------------------------------

/** All-zero public key; valid as a simulation source for read-only invocations. */
export const SIM_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const servers = new Map<string, rpc.Server>();
export function rpcServer(url: string): rpc.Server {
  let s = servers.get(url);
  if (!s) {
    s = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
    servers.set(url, s);
  }
  return s;
}

export function prettySimError(e: string): string {
  const m = e.match(/Error\(Contract, #(\d+)\)/) || e.match(/HostError: (.+?)(\n|$)/);
  if (m) return m[0].length > 160 ? m[0].slice(0, 160) + "…" : m[0];
  return e.length > 300 ? e.slice(0, 300) + "…" : e;
}

/**
 * Read-only contract call by simulation (never submitted). Vault-backed pool views touch DeFindex state, so they
 * MUST only ever be simulated (docs/pool-abi.md "Client notes").
 */
export async function simulateView<T = unknown>(net: NetCfg, contractId: string, method: string, args: xdr.ScVal[] = [], source: string = SIM_SOURCE): Promise<T> {
  const tx = new TransactionBuilder(new Account(source, "0"), { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await rpcServer(net.rpc).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(prettySimError(sim.error));
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("simulation returned no result");
  return scValToNative(sim.result.retval) as T;
}
