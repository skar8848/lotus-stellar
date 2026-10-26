// Adapter for the Lotus range pool (contracts/lotus_pool, ABI in docs/pool-abi.md, instances in
// deployments/testnet.pool.json). Everything pool-specific the bot needs lives here, so the rest of the bot
// only sees: quote(), swap(), addPosition(), removePosition(), depth(), priceAt(), binCeil(), binFloor().
//
// The pool is LBOND/USDC (QUOTE is plain USDC, not lUSDC). Amounts are i128 stroops, prices are USDC per
// LBOND. Enums are encoded as the Soroban SDK does for #[contracttype] unit-variant enums: a one-element
// vec holding the variant symbol, e.g. Side::Ask -> Vec[Symbol("Ask")].
//
// Fees (fee_bps of the QUOTE leg): a buyer pays price + fee on top, a seller receives price - fee, so a
// buy/sell round trip through the pool costs 2 * fee_bps. quote_swap()'s avg_price already includes it.

import path from 'node:path';
import { xdr } from '@stellar/stellar-sdk';
import { DEPLOY_DIR, readJson } from '../../lib/config.mjs';
import { addr, i128 } from '../../lib/stellar.mjs';

export const POOL_JSON = path.join(DEPLOY_DIR, 'testnet.pool.json');
export const MIN_BIN = -200;
export const MAX_BIN = 200;
export const MIN_BIN_DEPOSIT = 10_000n; // stroops per bin (contract constant)

const E7 = 1e7;

// ------------------------------------------------------------------ price grid (port of math.rs price_at_fp)

const S18 = 10n ** 18n;
const BPS_18 = 10n ** 14n;
const TO_PRICE = 10n ** 11n;
const mul18 = (a, b) => (a * b + S18 / 2n) / S18;

/** price_at(bin) as BigInt, 1e7 fixed point, bit-exact with the contract and gen_test_vectors.py. */
export function priceAtFp(stepBps, bin) {
  if (bin < MIN_BIN || bin > MAX_BIN) throw new Error(`bin ${bin} out of range`);
  const f = S18 + BigInt(stepBps) * BPS_18;
  let e = Math.abs(bin);
  let result = S18;
  let base = f;
  while (e > 0) {
    if (e & 1) result = mul18(result, base);
    e >>= 1;
    if (e > 0) base = mul18(base, base);
  }
  const p18 = bin >= 0 ? result : (S18 * S18 + result / 2n) / result;
  return (p18 + TO_PRICE / 2n) / TO_PRICE;
}

/** Smallest bin whose price is >= `price` (an ask must not be cheaper than intended). */
export function binCeil(stepBps, price) {
  let b = Math.round(Math.log(price) / Math.log(1 + stepBps / 1e4));
  b = Math.max(MIN_BIN, Math.min(MAX_BIN, b));
  const target = BigInt(Math.round(price * E7));
  while (b < MAX_BIN && priceAtFp(stepBps, b) < target) b++;
  while (b > MIN_BIN && priceAtFp(stepBps, b - 1) >= target) b--;
  return b;
}

/** Largest bin whose price is <= `price` (a bid must not pay more than intended). */
export function binFloor(stepBps, price) {
  let b = Math.round(Math.log(price) / Math.log(1 + stepBps / 1e4));
  b = Math.max(MIN_BIN, Math.min(MAX_BIN, b));
  const target = BigInt(Math.round(price * E7));
  while (b > MIN_BIN && priceAtFp(stepBps, b) > target) b--;
  while (b < MAX_BIN && priceAtFp(stepBps, b + 1) <= target) b++;
  return b;
}

// ------------------------------------------------------------------ deployment file

export const DEFAULT_POOL_ID = 'lbond-usdc-idle';
const isLbondUsdc = (p) => p.contract && p.base?.code === 'LBOND' && p.quote?.code === 'USDC';

function readPoolFile() {
  try {
    return readJson(POOL_JSON, null) ?? {};
  } catch {
    return {}; // half-written file (another process redeploying): treat as "not there yet"
  }
}
const readPools = () => readPoolFile().pools ?? [];
/** Retired instances: the top-level `retired_pools[]`, plus any entry of `pools[]` whose status is not live. */
const readRetired = () => {
  const j = readPoolFile();
  return [...(j.retired_pools ?? []), ...(j.pools ?? []).filter((p) => p.status !== 'live')];
};

/**
 * The live LBOND/USDC pool entry of deployments/testnet.pool.json, or null. Only `status: "live"` counts: a
 * `retired` instance (an old contract replaced by a redeploy, possibly under the same id) is never traded.
 * Default: the live `lbond-usdc-idle` instance, else the first live one.
 */
export function loadPoolEntry({ id } = {}) {
  const live = readPools().filter((p) => p.status === 'live' && isLbondUsdc(p));
  if (!live.length) return null;
  if (id) return live.find((p) => p.id === id) ?? null;
  return live.find((p) => p.id === DEFAULT_POOL_ID) ?? live[0];
}

/**
 * LBOND/USDC instances that are no longer live (`retired_pools[]`, or a non-live entry of `pools[]`), never one whose
 * contract is also listed live, nor `exceptContract`. Used only to close the bot's own leftover positions.
 */
export function loadRetiredPoolEntries({ exceptContract } = {}) {
  const liveContracts = new Set(readPools().filter((p) => p.status === 'live').map((p) => p.contract));
  const seen = new Set();
  return readRetired().filter((p) => {
    if (!isLbondUsdc(p) || p.contract === exceptContract || liveContracts.has(p.contract) || seen.has(p.contract)) return false;
    seen.add(p.contract);
    return true;
  });
}

const sideVal = (side) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(side === 'Bid' ? 'Bid' : 'Ask')]);
const modeDirectional = () => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Directional')]);
const i32 = (n) => xdr.ScVal.scvI32(n);
const u32 = (n) => xdr.ScVal.scvU32(n);

// ------------------------------------------------------------------ adapter

export class PoolAdapter {
  constructor(bot, entry) {
    this.bot = bot;
    this.entry = entry;
    this.contractId = entry.contract;
    this.step = entry.bin_step_bps;
    this.feeBps = entry.fee_bps;
    this.maxBins = entry.max_bins_per_swap ?? 25;
    this.label = entry.id;
  }

  /** Verify the deployed contract matches what we code against; throws with a clear reason otherwise. */
  async init() {
    const { chain } = this.bot;
    const abi = await chain.simulate({ contractId: this.contractId, method: 'abi_version' });
    if (Number(abi) !== 1) throw new Error(`pool ${this.label}: ABI version ${abi}, this bot codes against 1 (docs/pool-abi.md)`);
    const cfg = await chain.simulate({ contractId: this.contractId, method: 'get_config' });
    if (Number(cfg.bin_step_bps) !== this.step || Number(cfg.fee_bps) !== this.feeBps) {
      throw new Error(`pool ${this.label}: on-chain config (step ${cfg.bin_step_bps}, fee ${cfg.fee_bps}) differs from testnet.pool.json`);
    }
    // the grid must agree with our port, or every bin we compute would be wrong
    for (const b of [-30, -1, 0, 1, 17]) {
      const onchain = BigInt(await chain.simulate({ contractId: this.contractId, method: 'price_at', args: [i32(b)] }));
      if (onchain !== priceAtFp(this.step, b)) throw new Error(`pool ${this.label}: price_at(${b}) on-chain ${onchain} != local ${priceAtFp(this.step, b)}`);
    }
    return { abi: Number(abi), step: this.step, fee: this.feeBps, maxBins: Number(cfg.max_bins_per_swap) };
  }

  priceAt(bin) {
    return Number(priceAtFp(this.step, bin)) / E7;
  }
  binCeil(price) {
    return binCeil(this.step, price);
  }
  binFloor(price) {
    return binFloor(this.step, price);
  }

  // ---------------------------------------------------------------- reads

  /** quote_swap: buyBase=true pays `amountInStroops` USDC (fee included) for LBOND; false sells that much LBOND. */
  async quote(buyBase, amountInStroops) {
    const r = await this.bot.chain.simulate({ contractId: this.contractId, method: 'quote_swap', args: [xdr.ScVal.scvBool(Boolean(buyBase)), i128(amountInStroops)] });
    const out = BigInt(r.amount_out);
    return {
      out,
      fee: BigInt(r.fee),
      avgPrice: Number(r.avg_price) / E7, // USDC per LBOND, fee included (buy: paid/received, sell: received/sold)
      bins: Number(r.bins_crossed),
      partial: Boolean(r.partial),
    };
  }

  /** Non-empty bins of one side between two bins (inclusive), ascending. */
  async depth(side, fromBin = -60, toBin = 60) {
    const rows = await this.bot.chain.simulate({ contractId: this.contractId, method: 'depth', args: [sideVal(side), i32(fromBin), i32(toBin)] });
    return (rows ?? []).map((b) => ({ bin: Number(b.bin), price: Number(b.price) / E7, inventory: Number(b.inventory) / E7, filled: Number(b.filled) / E7 }));
  }

  /** Best ask (cheapest LBOND for sale) and best bid (highest USDC bid) of the pool. */
  async topOfBook() {
    const [asks, bids] = await Promise.all([this.depth('Ask'), this.depth('Bid')]);
    const ask = asks.find((b) => b.inventory > 0) ?? null; // ascending: first = cheapest
    const bid = [...bids].reverse().find((b) => b.inventory > 0) ?? null; // last = highest price
    return { ask, bid, asks, bids };
  }

  async positionsOf(pub) {
    const ids = await this.bot.chain.simulate({ contractId: this.contractId, method: 'positions_of', args: [addr(pub)] });
    return (ids ?? []).map((x) => BigInt(x));
  }

  async getPosition(id) {
    const p = await this.bot.chain.simulate({ contractId: this.contractId, method: 'get_position', args: [xdr.ScVal.scvU64(xdr.Uint64.fromString(String(id)))] });
    const side = Array.isArray(p.side) ? p.side[0] : String(p.side);
    return {
      id: BigInt(p.id),
      side,
      lo: Number(p.lo_bin),
      hi: Number(p.hi_bin),
      deposited: BigInt(p.deposited),
      inventory: BigInt(p.inventory),
      filled: BigInt(p.filled),
      pendingProceeds: BigInt(p.pending_proceeds),
      pendingFees: BigInt(p.pending_fees),
    };
  }

  // ---------------------------------------------------------------- writes (signed by a bot account)

  /** swap(taker, buy_base, amount_in, min_out) -> amount_out (stroops) */
  async swap(label, buyBase, amountInStroops, minOutStroops) {
    const { chain, acct } = this.bot;
    const res = await chain.invoke({
      label,
      contractId: this.contractId,
      method: 'swap',
      args: [addr(acct[label].pub), xdr.ScVal.scvBool(Boolean(buyBase)), i128(amountInStroops), i128(minOutStroops)],
    });
    return res.dryRun ? res : { ...res, out: BigInt(res.returnValue) };
  }

  /** add_position(owner, side, Directional, lo, hi, amount, weights=[]) -> position id */
  async addPosition(label, side, lo, hi, amountStroops, weights = []) {
    const { chain, acct } = this.bot;
    const res = await chain.invoke({
      label,
      contractId: this.contractId,
      method: 'add_position',
      args: [
        addr(acct[label].pub),
        sideVal(side),
        modeDirectional(),
        i32(lo),
        i32(hi),
        i128(amountStroops),
        xdr.ScVal.scvVec(weights.map((w) => u32(w))),
      ],
    });
    return res.dryRun ? res : { ...res, id: BigInt(res.returnValue) };
  }

  /** remove_position(owner, id) -> {base, quote} paid out (unfilled inventory + proceeds + fees) */
  async removePosition(label, id) {
    const { chain, acct } = this.bot;
    const res = await chain.invoke({
      label,
      contractId: this.contractId,
      method: 'remove_position',
      args: [addr(acct[label].pub), xdr.ScVal.scvU64(xdr.Uint64.fromString(String(id)))],
    });
    if (res.dryRun) return res;
    const p = res.returnValue ?? {};
    return { ...res, base: BigInt(p.base ?? 0), quote: BigInt(p.quote ?? 0) };
  }
}
