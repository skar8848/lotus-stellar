// Thin adapter over the lotus_pool ABI (docs/pool-abi.md, v0 draft). Everything the UI knows about
// the contract goes through this file, so an ABI change is a one-file change:
//   - argument encoders   (enumArg, weightsArg, ...)
//   - result decoders     (decodeConfig, decodeBin, decodePosition, decodeQuote, decodeTvl)
//   - LivePoolClient      (Soroban RPC simulate for views, invokeContract for writes)
//   - MockPoolClient      (in-browser simulation used until testnet.pool.json lists a deployed instance)
//
// Units: amounts are i128 stroops (7 dp). Price = QUOTE per BASE, fixed point 1e7.

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SCALE, divRound } from "./amount";
import type { PoolInstance } from "./config-types";
import { MAX_BIN, MIN_BIN, priceAt, type Side } from "./poolGrid";
import { addressArg, i128Arg, invokeContract, simulateView, type NetCfg, type Signer, type TxStage } from "./stellar";

export type { Side } from "./poolGrid";
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

export type TxCtx = { source: string; sign: Signer; onStage?: (s: TxStage, note?: string) => void };
export type TxResult = { hash: string; result?: unknown; simulated?: boolean };

export type AddPositionParams = {
  side: Side;
  mode: Mode;
  loBin: number;
  hiBin: number;
  /** deposit in stroops: BASE for Ask, QUOTE for Bid */
  amount: bigint;
  /** ascending bin order; empty = uniform */
  weights: number[];
};

export interface PoolClient {
  readonly mock: boolean;
  getConfig(): Promise<PoolConfig>;
  tvl(): Promise<Tvl>;
  depth(side: Side, fromBin: number, toBin: number): Promise<BinView[]>;
  positionsOf(owner: string): Promise<Position[]>;
  quoteSwap(buyBase: boolean, amountIn: bigint): Promise<SwapQuote>;
  /** abi_version(): 1 for the contract this adapter targets */
  abiVersion(): Promise<number>;
  addPosition(ctx: TxCtx, p: AddPositionParams): Promise<TxResult>;
  claim(ctx: TxCtx, id: bigint): Promise<TxResult>;
  removePosition(ctx: TxCtx, id: bigint): Promise<TxResult>;
  swap(ctx: TxCtx, buyBase: boolean, amountIn: bigint, minOut: bigint): Promise<TxResult>;
  /** admin only (1..=100); exposed for completeness, the app never calls it */
  setMaxBinsPerSwap(ctx: TxCtx, maxBins: number): Promise<TxResult>;
}

/** The ABI version this adapter was written against (docs/pool-abi.md). */
export const SUPPORTED_ABI = 1;

// ---------------------------------------------------------------------------
// Encoders / decoders (the only place that knows how the ABI types look on the wire)
// ---------------------------------------------------------------------------

/**
 * `#[contracttype] enum Side { Ask, Bid }` (unit variants) travels as Vec[Symbol("Ask")].
 * If the contract switches to a #[repr(u32)] integer enum change this to scvU32(index).
 */
const ENUM_ENCODING: "vec-symbol" | "u32" = "vec-symbol";
const SIDE_NAMES = ["Ask", "Bid"];
const MODE_NAMES = ["Directional", "TwoWay"];

function enumArg(name: string, names: string[]): xdr.ScVal {
  if (ENUM_ENCODING === "u32") return xdr.ScVal.scvU32(Math.max(0, names.indexOf(name)));
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
}
const sideArg = (s: Side) => enumArg(s, SIDE_NAMES);
const modeArg = (m: Mode) => enumArg(m, MODE_NAMES);
const i32Arg = (n: number) => nativeToScVal(n, { type: "i32" });
const u64Arg = (n: bigint) => nativeToScVal(n, { type: "u64" });
const boolArg = (b: boolean) => xdr.ScVal.scvBool(b);
const weightsArg = (w: number[]) => xdr.ScVal.scvVec(w.map((x) => nativeToScVal(x, { type: "u32" })));

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
  return {
    side: enumName(o.side, SIDE_NAMES as Side[]),
    bin: num(o.bin),
    price: big(o.price),
    inventory: big(o.inventory),
    totalShares: big(o.total_shares),
    filled: big(o.filled),
  };
};
export const decodePosition = (v: unknown): Position => {
  const o = rec(v);
  return {
    id: big(o.id),
    owner: addr(o.owner) ?? "",
    side: enumName(o.side, SIDE_NAMES as Side[]),
    mode: enumName(o.mode, MODE_NAMES as Mode[]),
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
  return {
    amountOut: big(o.amount_out),
    fee: big(o.fee),
    avgPrice: big(o.avg_price),
    binsCrossed: num(o.bins_crossed),
    partial: o.partial === true,
  };
};
export const decodeTvl = (v: unknown): Tvl => {
  const o = rec(v);
  return { base: big(o.base), quoteValue: big(o.quote_value), vaultShares: big(o.vault_shares) };
};

// ---------------------------------------------------------------------------
// Contract errors (contracts/lotus_pool/src/types.rs, enum Error) so a revert reads in words
// ---------------------------------------------------------------------------

const POOL_ERRORS: Record<number, string> = {
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

/** Replace "Error(Contract, #9)" by its name in a message coming back from the pool. */
export function explainPoolError(message: string): string {
  return message.replace(/Error\(Contract, #(\d+)\)/g, (m, n) => (POOL_ERRORS[Number(n)] ? `${POOL_ERRORS[Number(n)]} [${m}]` : m));
}

// ---------------------------------------------------------------------------
// Live client (Soroban RPC)
// ---------------------------------------------------------------------------

class LivePoolClient implements PoolClient {
  readonly mock = false;
  constructor(
    private net: NetCfg,
    private contract: string,
  ) {}

  private view<T>(method: string, args: xdr.ScVal[] = []) {
    return simulateView<T>(this.net, this.contract, method, args).catch((e) => {
      throw new Error(explainPoolError(e instanceof Error ? e.message : String(e)));
    });
  }
  private async write(ctx: TxCtx, method: string, args: xdr.ScVal[]): Promise<TxResult> {
    try {
      const r = await invokeContract(this.net, {
        contractId: this.contract,
        method,
        args,
        source: ctx.source,
        sign: ctx.sign,
        onStage: (s) => ctx.onStage?.(s, method),
      });
      return { hash: r.hash, result: r.result };
    } catch (e) {
      throw new Error(explainPoolError(e instanceof Error ? e.message : String(e)));
    }
  }

  async getConfig() {
    return decodeConfig(await this.view("get_config"));
  }
  async tvl() {
    return decodeTvl(await this.view("tvl"));
  }
  /** depth() returns at most 100 non-empty bins, lowest first: page until a short page comes back. */
  async depth(side: Side, fromBin: number, toBin: number) {
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
  async positionsOf(owner: string) {
    const ids = await this.view<unknown[]>("positions_of", [addressArg(owner)]);
    const list = Array.isArray(ids) ? ids : [];
    const rows = await Promise.all(list.map((id) => this.view("get_position", [u64Arg(big(id))]).then(decodePosition)));
    return rows.sort((a, b) => (a.id < b.id ? 1 : -1));
  }
  async quoteSwap(buyBase: boolean, amountIn: bigint) {
    return decodeQuote(await this.view("quote_swap", [boolArg(buyBase), i128Arg(amountIn)]));
  }
  addPosition(ctx: TxCtx, p: AddPositionParams) {
    return this.write(ctx, "add_position", [
      addressArg(ctx.source),
      sideArg(p.side),
      modeArg(p.mode),
      i32Arg(p.loBin),
      i32Arg(p.hiBin),
      i128Arg(p.amount),
      weightsArg(p.weights),
    ]);
  }
  claim(ctx: TxCtx, id: bigint) {
    return this.write(ctx, "claim", [addressArg(ctx.source), u64Arg(id)]);
  }
  removePosition(ctx: TxCtx, id: bigint) {
    return this.write(ctx, "remove_position", [addressArg(ctx.source), u64Arg(id)]);
  }
  swap(ctx: TxCtx, buyBase: boolean, amountIn: bigint, minOut: bigint) {
    return this.write(ctx, "swap", [addressArg(ctx.source), boolArg(buyBase), i128Arg(amountIn), i128Arg(minOut)]);
  }
  async abiVersion() {
    return num(await this.view("abi_version"));
  }
  setMaxBinsPerSwap(ctx: TxCtx, maxBins: number) {
    return this.write(ctx, "set_max_bins_per_swap", [nativeToScVal(maxBins, { type: "u32" })]);
  }
}

// ---------------------------------------------------------------------------
// Mock client: a faithful-enough directional pool simulation, persisted in localStorage.
// Used ONLY while no deployed instance exists. The UI labels it as a simulation; no transaction is sent.
// ---------------------------------------------------------------------------

type MockBin = { bin: number; remaining: bigint; filled: bigint };
type MockPos = {
  id: bigint;
  owner: string;
  side: Side;
  mode: Mode;
  loBin: number;
  hiBin: number;
  deposited: bigint;
  bins: MockBin[];
  proceeds: bigint;
  fees: bigint;
  closed: boolean;
};
type MockState = { nextId: bigint; positions: MockPos[] };

const MOCK_KEY = "lotus.pool.mock.v1";
const MOCK_LP = "GMOCKLIQUIDITYPROVIDERSIMULATION00000000000000000000000000";

const ser = (s: MockState) =>
  JSON.stringify(s, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
const de = (raw: string): MockState =>
  JSON.parse(raw, (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

class MockPoolClient implements PoolClient {
  readonly mock = true;
  private state: MockState;
  constructor(private inst: PoolInstance) {
    this.state = this.load();
  }

  private load(): MockState {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(MOCK_KEY) : null;
      if (raw) return de(raw);
    } catch {
      /* fall through to the seed */
    }
    const st: MockState = { nextId: 1n, positions: [] };
    // Seed the simulation with a little depth on both sides so the UI has something to show.
    this.place(st, MOCK_LP, "Ask", 0, 20, 1_000n * SCALE, []);
    this.place(st, MOCK_LP, "Bid", -20, -1, 1_000n * SCALE, []);
    return st;
  }
  private save() {
    try {
      window.localStorage.setItem(MOCK_KEY, ser(this.state));
    } catch {
      /* storage unavailable: keep in memory */
    }
  }
  private place(st: MockState, owner: string, side: Side, lo: number, hi: number, amount: bigint, weights: number[]) {
    const n = hi - lo + 1;
    const w = weights.length === n ? weights : Array.from({ length: n }, () => 1);
    const wSum = BigInt(w.reduce((a, b) => a + b, 0));
    const parts = w.map((x) => (amount * BigInt(x)) / wSum);
    parts[0] += amount - parts.reduce((a, b) => a + b, 0n);
    const pos: MockPos = {
      id: st.nextId++,
      owner,
      side,
      mode: "Directional",
      loBin: lo,
      hiBin: hi,
      deposited: amount,
      bins: parts.map((p, i) => ({ bin: lo + i, remaining: p, filled: 0n })),
      proceeds: 0n,
      fees: 0n,
      closed: false,
    };
    st.positions.push(pos);
    return pos;
  }
  private binTotals(side: Side) {
    const m = new Map<number, { inventory: bigint; filled: bigint }>();
    for (const p of this.state.positions) {
      if (p.closed || p.side !== side) continue;
      for (const b of p.bins) {
        const cur = m.get(b.bin) ?? { inventory: 0n, filled: 0n };
        cur.inventory += b.remaining;
        cur.filled += b.filled;
        m.set(b.bin, cur);
      }
    }
    return m;
  }
  private walk(buyBase: boolean, amountIn: bigint, apply: boolean): SwapQuote {
    const fee = BigInt(this.inst.feeBps);
    const step = this.inst.binStepBps;
    let remaining = amountIn;
    let out = 0n;
    let feeTotal = 0n;
    let crossed = 0;
    const side: Side = buyBase ? "Ask" : "Bid";
    const totals = this.binTotals(side);
    const bins = [...totals.keys()].filter((b) => (totals.get(b) as { inventory: bigint }).inventory > 0n).sort((a, b) => (buyBase ? a - b : b - a));
    let exhausted = true;
    for (const bin of bins) {
      const inv = (totals.get(bin) as { inventory: bigint }).inventory;
      const p = priceAt(bin, step);
      let fillBase: bigint; // BASE units moved
      let quoteGross: bigint;
      if (buyBase) {
        const maxBase = (remaining * SCALE * 10_000n) / (p * (10_000n + fee));
        fillBase = maxBase < inv ? maxBase : inv;
        quoteGross = divRound(fillBase * p, SCALE);
      } else {
        const maxBase = (inv * SCALE) / p;
        fillBase = remaining < maxBase ? remaining : maxBase;
        quoteGross = (fillBase * p) / SCALE;
      }
      if (fillBase <= 0n || quoteGross <= 0n) {
        exhausted = false;
        break;
      }
      const feeQ = (quoteGross * fee + 9_999n) / 10_000n;
      if (buyBase) {
        remaining -= quoteGross + feeQ;
        out += fillBase;
      } else {
        remaining -= fillBase;
        out += quoteGross - feeQ;
      }
      feeTotal += feeQ;
      crossed++;
      if (apply) this.applyFill(side, bin, buyBase ? fillBase : quoteGross, buyBase ? quoteGross : fillBase, feeQ);
      const binDone = buyBase ? fillBase >= inv : quoteGross >= inv;
      if (!binDone) {
        exhausted = false;
        break;
      }
      if (remaining <= 0n) {
        exhausted = false;
        break;
      }
    }
    const spent = amountIn - remaining;
    const avg = out > 0n ? (buyBase ? divRound(spent * SCALE, out) : divRound(out * SCALE, spent > 0n ? spent : 1n)) : 0n;
    return { amountOut: out, fee: feeTotal, avgPrice: avg, binsCrossed: crossed, partial: exhausted && remaining > 0n };
  }
  /** consumed: units of the bin's inventory asset taken; proceeds: what LPs receive in the other asset. */
  private applyFill(side: Side, bin: number, consumed: bigint, proceeds: bigint, feeQ: bigint) {
    const holders = this.state.positions.filter((p) => !p.closed && p.side === side && p.bins.some((b) => b.bin === bin && b.remaining > 0n));
    const total = holders.reduce((a, p) => a + (p.bins.find((b) => b.bin === bin) as MockBin).remaining, 0n);
    if (total <= 0n) return;
    let cLeft = consumed;
    let pLeft = proceeds;
    let fLeft = feeQ;
    holders.forEach((p, i) => {
      const b = p.bins.find((x) => x.bin === bin) as MockBin;
      const last = i === holders.length - 1;
      const c = last ? cLeft : (consumed * b.remaining) / total;
      const pr = last ? pLeft : (proceeds * b.remaining) / total;
      const f = last ? fLeft : (feeQ * b.remaining) / total;
      b.remaining -= c > b.remaining ? b.remaining : c;
      b.filled += c;
      p.proceeds += pr;
      p.fees += f;
      cLeft -= c;
      pLeft -= pr;
      fLeft -= f;
    });
  }
  private toPosition(p: MockPos): Position {
    return {
      id: p.id,
      owner: p.owner,
      side: p.side,
      mode: p.mode,
      loBin: p.loBin,
      hiBin: p.hiBin,
      deposited: p.deposited,
      inventory: p.bins.reduce((a, b) => a + b.remaining, 0n),
      filled: p.bins.reduce((a, b) => a + b.filled, 0n),
      pendingProceeds: p.proceeds,
      pendingFees: p.fees,
      vaulted: false,
    };
  }

  async getConfig(): Promise<PoolConfig> {
    return {
      admin: MOCK_LP,
      base: this.inst.base.sac ?? "",
      quote: this.inst.quote.sac ?? "",
      vault: null,
      binStepBps: this.inst.binStepBps,
      feeBps: this.inst.feeBps,
      maxBinsPerSwap: 100,
      supportsTwoWay: false,
    };
  }
  async tvl(): Promise<Tvl> {
    const asks = this.binTotals("Ask");
    const bids = this.binTotals("Bid");
    const base = [...asks.values()].reduce((a, b) => a + b.inventory, 0n);
    const quote = [...bids.values()].reduce((a, b) => a + b.inventory, 0n);
    let askValue = 0n;
    for (const [bin, t] of asks) askValue += divRound(t.inventory * priceAt(bin, this.inst.binStepBps), SCALE);
    return { base, quoteValue: quote + askValue, vaultShares: 0n };
  }
  async depth(side: Side, fromBin: number, toBin: number): Promise<BinView[]> {
    const totals = this.binTotals(side);
    return [...totals.entries()]
      .filter(([bin, t]) => bin >= fromBin && bin <= toBin && t.inventory > 0n)
      .sort((a, b) => a[0] - b[0])
      .map(([bin, t]) => ({ side, bin, price: priceAt(bin, this.inst.binStepBps), inventory: t.inventory, totalShares: t.inventory, filled: t.filled }));
  }
  async positionsOf(owner: string): Promise<Position[]> {
    return this.state.positions
      .filter((p) => !p.closed && p.owner === owner)
      .map((p) => this.toPosition(p))
      .sort((a, b) => (a.id < b.id ? 1 : -1));
  }
  async quoteSwap(buyBase: boolean, amountIn: bigint): Promise<SwapQuote> {
    return this.walk(buyBase, amountIn, false);
  }
  async abiVersion() {
    return SUPPORTED_ABI;
  }
  async setMaxBinsPerSwap(): Promise<TxResult> {
    throw new Error("admin only: not available in the local simulation");
  }
  async addPosition(ctx: TxCtx, p: AddPositionParams): Promise<TxResult> {
    if (p.mode === "TwoWay") throw new Error("NotImplemented (two-way positions are not available in the local simulation)");
    if (p.loBin < MIN_BIN || p.hiBin > MAX_BIN || p.hiBin < p.loBin) throw new Error("bin outside the grid");
    const pos = this.place(this.state, ctx.source, p.side, p.loBin, p.hiBin, p.amount, p.weights);
    this.save();
    return { hash: "", result: pos.id, simulated: true };
  }
  async claim(ctx: TxCtx, id: bigint): Promise<TxResult> {
    const p = this.state.positions.find((x) => x.id === id && x.owner === ctx.source && !x.closed);
    if (!p) throw new Error("position not found");
    const payout = p.side === "Ask" ? { base: 0n, quote: p.proceeds + p.fees } : { base: p.proceeds, quote: p.fees };
    p.proceeds = 0n;
    p.fees = 0n;
    this.save();
    return { hash: "", result: payout, simulated: true };
  }
  async removePosition(ctx: TxCtx, id: bigint): Promise<TxResult> {
    const p = this.state.positions.find((x) => x.id === id && x.owner === ctx.source && !x.closed);
    if (!p) throw new Error("position not found");
    const left = p.bins.reduce((a, b) => a + b.remaining, 0n);
    const payout =
      p.side === "Ask"
        ? { base: left, quote: p.proceeds + p.fees }
        : { base: p.proceeds, quote: left + p.fees };
    p.closed = true;
    this.save();
    return { hash: "", result: payout, simulated: true };
  }
  async swap(_ctx: TxCtx, buyBase: boolean, amountIn: bigint, minOut: bigint): Promise<TxResult> {
    const q = this.walk(buyBase, amountIn, false);
    if (q.amountOut < minOut) throw new Error("slippage: output below min_out");
    if (q.amountOut <= 0n) throw new Error("no liquidity to fill this swap");
    const done = this.walk(buyBase, amountIn, true);
    this.save();
    return { hash: "", result: done.amountOut, simulated: true };
  }
}

/** Reset the local simulation (dev helper, also exposed in the UI of the simulated instance). */
export function resetMockPool() {
  try {
    window.localStorage.removeItem(MOCK_KEY);
  } catch {
    /* ignore */
  }
}

const clients = new Map<string, PoolClient>();
/** One client per instance (the mock keeps state, so it must be a singleton). */
export function getPoolClient(net: NetCfg, inst: PoolInstance): PoolClient {
  const key = `${inst.id}:${inst.contract}:${inst.mock}`;
  let c = clients.get(key);
  if (!c) {
    c = inst.mock || !inst.contract ? new MockPoolClient(inst) : new LivePoolClient(net, inst.contract);
    clients.set(key, c);
  }
  return c;
}

