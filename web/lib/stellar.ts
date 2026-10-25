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

export const DECIMALS = 7;
export const SCALE = 10_000_000n;

/** "12.5" -> 125000000n. Throws on malformed input. */
export function toStroops(s: string): bigint {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") throw new Error("Invalid amount");
  const [i, f = ""] = t.split(".");
  if (f.length > DECIMALS) throw new Error(`Max ${DECIMALS} decimals`);
  return BigInt(i || "0") * SCALE + BigInt((f + "0".repeat(DECIMALS)).slice(0, DECIMALS));
}

/** 125000000n -> "12.5" (trailing zeros trimmed, at least "0"). */
export function fromStroops(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const i = abs / SCALE;
  const f = (abs % SCALE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i.toString()}${f ? "." + f : ""}`;
}

/** Normalise a user-entered amount to a Stellar-valid 7dp string. */
export const normalizeAmount = (s: string): string => fromStroops(toStroops(s));

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
};

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
 * Name of the top-level TransactionResultCode (e.g. "txBadSeq", "txFailed").
 * Duck-typed: SDK v17 exposes unions as `{ code }` properties, older versions as `.result().switch()`.
 */
export function txResultCode(res: unknown): string | undefined {
  try {
    const r = res as { result?: unknown };
    const inner = typeof r?.result === "function" ? (r.result as () => unknown)() : r?.result;
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
  onStage?: (s: TxStage) => void;
};

/** simulate -> assemble -> sign -> send -> poll. Returns the tx hash and decoded return value. */
export async function invokeContract(net: NetCfg, p: InvokeParams): Promise<{ hash: string; result: unknown }> {
  const server = new rpc.Server(net.rpc);
  p.onStage?.("building");
  // Sequence from Horizon: a classic tx (e.g. the ChangeTrust before a first deposit) may have
  // just been confirmed there, and RPC can lag it by a ledger.
  const acct = await fetchAccount(net.horizon, p.source);
  if (!acct) throw new Error("source account not found on testnet (fund it with Friendbot first)");
  const account = new Account(p.source, acct.sequence);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(new Contract(p.contractId).call(p.method, ...p.args))
    .setTimeout(120)
    .build();

  p.onStage?.("simulating");
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(prettySimError(sim.error));
  const prepared = rpc.assembleTransaction(tx, sim).build();

  p.onStage?.("signing");
  const signedXdr = await p.sign(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, net.passphrase);

  p.onStage?.("sending");
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR" || sent.status === "DUPLICATE" || sent.status === "TRY_AGAIN_LATER") {
    let why = sent.status as string;
    const code = txResultCode(sent.errorResult);
    if (code) why = `${why}: ${explainResultCode(code)}`;
    throw new Error(`send failed (${why})`);
  }

  p.onStage?.("confirming");
  for (let i = 0; i < 60; i++) {
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
      throw new Error(code ? `failed on-chain: ${explainResultCode(code)}` : "transaction failed on-chain");
    }
  }
  throw new Error(`timed out waiting for ${sent.hash}`);
}

export type ClassicParams = {
  source: string;
  ops: xdr.Operation[];
  sign: Signer;
  onStage?: (s: TxStage) => void;
  /** Fee per operation in stroops (default 1000 = 0.0001 XLM). */
  feePerOp?: string;
};

/** Build a classic (non-Soroban) tx from Horizon account state, sign, submit to Horizon. */
export async function submitClassic(net: NetCfg, p: ClassicParams): Promise<{ hash: string }> {
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

export const explorerTx = (hash: string, network = "testnet") => `https://stellar.expert/explorer/${network}/tx/${hash}`;
export const explorerAccount = (id: string, network = "testnet") => `https://stellar.expert/explorer/${network}/account/${id}`;
export const explorerContract = (id: string, network = "testnet") => `https://stellar.expert/explorer/${network}/contract/${id}`;

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
};

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
