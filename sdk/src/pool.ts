// lotus_pool ABI v1 (docs/pool-abi.md): argument encoders, result decoders, error names and a read-only client.
// Encoders / decoders are a port of web/lib/pool.ts (same wire format). Every read is a simulation, never submitted.

import { nativeToScVal, xdr, Address } from "@stellar/stellar-sdk";
import { MAX_BIN, MIN_BIN, type Side } from "./shared/poolGrid.ts";
import { simulateView, type NetCfg } from "./net.ts";

export type { Side } from "./shared/poolGrid.ts";
export type Mode = "Directional" | "TwoWay";

export type PoolConfig = {
  admin: string;
  base: string;
  quote: string;
  vault: string | null;
  binStepBps: number;
  feeBps: number;
  maxBinsPerSwap: number;
  supportsTwoWay: boolean;
};
export type BinView = { side: Side; bin: number; price: bigint; inventory: bigint; totalShares: bigint; filled: bigint };
export type Position = {
  id: bigint;
  owner: string;
  side: Side;
  mode: Mode;
  loBin: number;
  hiBin: number;
  deposited: bigint;
  inventory: bigint;
  filled: bigint;
  pendingProceeds: bigint;
  pendingFees: bigint;
  vaulted: boolean;
};
export type PositionPayout = { base: bigint; quote: bigint };
export type SwapQuote = { amountOut: bigint; fee: bigint; avgPrice: bigint; binsCrossed: number; partial: boolean };
export type Tvl = { base: bigint; quoteValue: bigint; vaultShares: bigint };

export const SUPPORTED_ABI = 1;

// ---- encoders ----------------------------------------------------------------------------------------------------
const enumArg = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
export const sideArg = (s: Side) => enumArg(s);
export const modeArg = (m: Mode) => enumArg(m);
export const i32Arg = (n: number) => nativeToScVal(n, { type: "i32" });
export const u32Arg = (n: number) => nativeToScVal(n, { type: "u32" });
export const u64Arg = (n: bigint) => nativeToScVal(n, { type: "u64" });
export const i128Arg = (v: bigint) => nativeToScVal(v, { type: "i128" });
export const boolArg = (b: boolean) => xdr.ScVal.scvBool(b);
export const addressArg = (g: string) => new Address(g).toScVal();
export const weightsArg = (w: number[]) => xdr.ScVal.scvVec(w.map((x) => nativeToScVal(x, { type: "u32" })));

// ---- decoders ----------------------------------------------------------------------------------------------------
const big = (v: unknown): bigint =>
  typeof v === "bigint" ? v : typeof v === "number" ? BigInt(Math.trunc(v)) : typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : 0n;
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0));
const addr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
function enumName<T extends string>(v: unknown, names: readonly T[]): T {
  let n: unknown = v;
  if (Array.isArray(n)) n = n[0];
  if (typeof n === "number" || typeof n === "bigint") return names[Number(n)] ?? names[0];
  if (n && typeof n === "object" && "tag" in (n as object)) n = (n as { tag: unknown }).tag;
  return (names as readonly string[]).includes(String(n)) ? (String(n) as T) : names[0];
}
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const SIDES = ["Ask", "Bid"] as const;
const MODES = ["Directional", "TwoWay"] as const;

export const decodeConfig = (v: unknown): PoolConfig => {
  const o = rec(v);
  return {
    admin: addr(o.admin) ?? "",
    base: addr(o.base) ?? "",
    quote: addr(o.quote) ?? "",
    vault: addr(o.vault),
    binStepBps: num(o.bin_step_bps),
    feeBps: num(o.fee_bps),
    maxBinsPerSwap: num(o.max_bins_per_swap),
    supportsTwoWay: o.supports_two_way === true,
  };
};
export const decodeBin = (v: unknown): BinView => {
  const o = rec(v);
  return { side: enumName(o.side, SIDES), bin: num(o.bin), price: big(o.price), inventory: big(o.inventory), totalShares: big(o.total_shares), filled: big(o.filled) };
};
export const decodePosition = (v: unknown): Position => {
  const o = rec(v);
  return {
    id: big(o.id),
    owner: addr(o.owner) ?? "",
    side: enumName(o.side, SIDES),
    mode: enumName(o.mode, MODES),
    loBin: num(o.lo_bin),
    hiBin: num(o.hi_bin),
    deposited: big(o.deposited),
    inventory: big(o.inventory),
    filled: big(o.filled),
    pendingProceeds: big(o.pending_proceeds),
    pendingFees: big(o.pending_fees),
    vaulted: o.vaulted === true,
  };
};
export const decodePayout = (v: unknown): PositionPayout => {
  const o = rec(v);
  return { base: big(o.base), quote: big(o.quote) };
};
export const decodeQuote = (v: unknown): SwapQuote => {
  const o = rec(v);
  return { amountOut: big(o.amount_out), fee: big(o.fee), avgPrice: big(o.avg_price), binsCrossed: num(o.bins_crossed), partial: o.partial === true };
};
export const decodeTvl = (v: unknown): Tvl => {
  const o = rec(v);
  return { base: big(o.base), quoteValue: big(o.quote_value), vaultShares: big(o.vault_shares) };
};

// ---- errors ------------------------------------------------------------------------------------------------------
export const POOL_ERRORS: Record<number, string> = {
  1: "NotInitialized",
  2: "InvalidAmount (zero, negative or above the cap)",
  3: "InvalidRange (bins outside -200..200, lo > hi or more than 64 bins)",
  4: "InvalidWeights (one weight per bin required)",
  5: "InvalidConfig",
  6: "NoSuchPosition",
  7: "NotOwner",
  8: "NoLiquidity (nothing to fill for this swap)",
  9: "SlippageExceeded (output below min_out: re-quote)",
  10: "NotImplemented (two-way positions are not available)",
  11: "Overflow",
  12: "AmountTooSmall (every bin needs at least 0.001)",
  13: "BinDust (a nearly filled bin refuses deposits: pick another bin)",
  14: "VaultShortfall (the DeFindex vault paid less than needed: retry)",
  15: "TooManyPositions (100 per owner)",
};
export function explainPoolError(message: string): string {
  return message.replace(/Error\(Contract, #(\d+)\)/g, (m, n) => (POOL_ERRORS[Number(n)] ? `${POOL_ERRORS[Number(n)]} [${m}]` : m));
}

// ---- read-only client --------------------------------------------------------------------------------------------
export class PoolReader {
  constructor(
    readonly net: NetCfg,
    readonly contract: string,
  ) {}

  private view<T>(method: string, args: xdr.ScVal[] = []): Promise<T> {
    return simulateView<T>(this.net, this.contract, method, args).catch((e) => {
      throw new Error(explainPoolError(e instanceof Error ? e.message : String(e)));
    });
  }
  async getConfig(): Promise<PoolConfig> {
    return decodeConfig(await this.view("get_config"));
  }
  async abiVersion(): Promise<number> {
    return num(await this.view("abi_version"));
  }
  async tvl(): Promise<Tvl> {
    return decodeTvl(await this.view("tvl"));
  }
  async priceAt(bin: number): Promise<bigint> {
    return big(await this.view("price_at", [i32Arg(bin)]));
  }
  /** depth() returns at most 100 non-empty bins, lowest first: page until a short page comes back. */
  async depth(side: Side, fromBin = MIN_BIN, toBin = MAX_BIN): Promise<BinView[]> {
    const out: BinView[] = [];
    let from = fromBin;
    for (let page = 0; page < 5 && from <= toBin; page++) {
      const rows = await this.view<unknown[]>("depth", [sideArg(side), i32Arg(from), i32Arg(toBin)]);
      const got = (Array.isArray(rows) ? rows : []).map(decodeBin);
      out.push(...got);
      if (got.length < 100) break;
      from = got[got.length - 1].bin + 1;
    }
    return out;
  }
  async positionIds(owner: string): Promise<bigint[]> {
    const ids = await this.view<unknown[]>("positions_of", [addressArg(owner)]);
    return (Array.isArray(ids) ? ids : []).map(big);
  }
  async getPosition(id: bigint): Promise<Position> {
    return decodePosition(await this.view("get_position", [u64Arg(id)]));
  }
  async positionsOf(owner: string): Promise<Position[]> {
    const ids = await this.positionIds(owner);
    const rows = await Promise.all(ids.map((id) => this.getPosition(id)));
    return rows.sort((a, b) => (a.id < b.id ? 1 : -1));
  }
  async quoteSwap(buyBase: boolean, amountIn: bigint): Promise<SwapQuote> {
    return decodeQuote(await this.view("quote_swap", [boolArg(buyBase), i128Arg(amountIn)]));
  }
  /** Best bid / ask of the pool's own bins (decimal QUOTE per BASE), as NewPosition.tsx poolTop. */
  async top(): Promise<{ bid: number | null; ask: number | null }> {
    const [asks, bids] = await Promise.all([this.depth("Ask").catch(() => []), this.depth("Bid").catch(() => [])]);
    return {
      ask: asks[0] ? Number(asks[0].price) / 1e7 : null,
      bid: bids.length ? Number(bids[bids.length - 1].price) / 1e7 : null,
    };
  }
}

// ---- lotus_vault reads -------------------------------------------------------------------------------------------
export type VaultStats = { vaultValue: bigint | null; supply: bigint | null; surplus: bigint | null; config: Record<string, unknown> | null; errors: string[] };

export async function readVaultStats(net: NetCfg, contractId: string): Promise<VaultStats> {
  const [vv, sp, su, cf] = await Promise.allSettled([
    simulateView<bigint>(net, contractId, "vault_value"),
    simulateView<bigint>(net, contractId, "supply"),
    simulateView<bigint>(net, contractId, "surplus"),
    simulateView<Record<string, unknown>>(net, contractId, "get_config"),
  ]);
  const pick = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
  const errors = [vv, sp, su, cf].filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.message ?? r));
  const asBig = (v: unknown): bigint | null => (typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : null);
  return { vaultValue: asBig(pick(vv)), supply: asBig(pick(sp)), surplus: asBig(pick(su)), config: pick(cf), errors };
}

/** What redeem(amount) pays (contract rule): 1:1 while vault_value >= supply, else pro rata (floor). */
export function redeemEstimate(amount: bigint, vaultValue: bigint | null, supply: bigint | null): bigint | null {
  if (vaultValue === null || supply === null || supply <= 0n || amount <= 0n) return null;
  return vaultValue >= supply ? amount : (amount * vaultValue) / supply;
}
