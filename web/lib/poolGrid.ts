// Lotus pool price grid + position planning (pure, BigInt, no React, no SDK).
//
// ABI (docs/pool-abi.md): price_at(bin) = round(1e7 * (1 + bin_step_bps / 10_000) ^ bin), bin in [-200, 200].
// Price = QUOTE (USDC) per BASE (LBOND), fixed point 1e7.
//
// priceAt below is the EXACT rational value rounded half-up. The contract computes the same in integer
// fixed point; tests/pool-grid.test.mts checks this implementation against
// contracts/lotus_pool/test-vectors.json when that file exists, and reports any off-by-one.

import { SCALE, divRound, fromStroops, tryStroops } from "./amount.ts";

export const MIN_BIN = -200;
export const MAX_BIN = 200;
/** A position spans at most this many bins (contract constant MAX_POSITION_BINS = 64). */
export const MAX_POSITION_BINS = 64;
/** Smallest non-zero amount the contract accepts in one bin (MIN_BIN_DEPOSIT = 10_000 stroops = 0.001). */
export const MIN_BIN_DEPOSIT = 10_000n;

export type Side = "Ask" | "Bid";
export type Shape = "uniform" | "start" | "end";

export function priceAt(bin: number, stepBps: number): bigint {
  if (!Number.isInteger(bin)) throw new Error("bin must be an integer");
  const up = BigInt(10_000 + stepBps);
  const den = 10_000n;
  if (bin >= 0) return divRound(SCALE * up ** BigInt(bin), den ** BigInt(bin));
  return divRound(SCALE * den ** BigInt(-bin), up ** BigInt(-bin));
}

/** Nearest bin to a price (quote per base), clamped to the grid. */
export function binForPrice(price: number, stepBps: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const b = Math.round(Math.log(price) / Math.log(1 + stepBps / 10_000));
  return Math.max(MIN_BIN, Math.min(MAX_BIN, b));
}

/** Price (decimal string, 7dp) of a bin. */
export const priceStringAt = (bin: number, stepBps: number): string => fromStroops(priceAt(bin, stepBps));

/** Integer weights from start to end (same shapes as the SDEX range builder). */
export function shapeWeights(shape: Shape, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (shape === "uniform" ? 1 : shape === "start" ? n - i : i + 1));
}

export type PlanInput = {
  side: Side;
  /** price where the position starts (nearest to the market): lowest for Ask, highest for Bid */
  startPrice: string;
  /** price where the position ends: highest for Ask, lowest for Bid */
  endPrice: string;
  shape: Shape;
  /** amount of the SOLD asset in decimal units: BASE for Ask, QUOTE for Bid */
  amount: string;
  stepBps: number;
  feeBps: number;
};

export type PlannedBin = {
  bin: number;
  price: bigint;
  /** weight handed to the contract (ascending bin order) */
  weight: number;
  /** share of the deposit in this bin, in stroops of the deposited asset */
  amount: bigint;
  /** BASE-equivalent size of the bin (Ask: base; Bid: quote / price) in stroops */
  baseSize: bigint;
};

export type PositionPlan = {
  ok: boolean;
  errors: string[];
  side: Side;
  loBin: number;
  hiBin: number;
  bins: PlannedBin[];
  /** weights in ascending bin order, to pass to add_position */
  weights: number[];
  deposit: bigint;
  /** size-weighted average grid price (stroops), null when empty */
  avgPrice: bigint | null;
  /** expected proceeds if every bin fills, in stroops: Ask -> QUOTE, Bid -> BASE (before fees) */
  proceedsIfFilled: bigint;
  /** fee tier in percent (fee_bps / 100) */
  feePct: number;
};

export function planPosition(input: PlanInput): PositionPlan {
  const errors: string[] = [];
  const startP = Number(input.startPrice);
  const endP = Number(input.endPrice);
  const amount = tryStroops(input.amount);
  const base: PositionPlan = {
    ok: false,
    errors,
    side: input.side,
    loBin: 0,
    hiBin: 0,
    bins: [],
    weights: [],
    deposit: 0n,
    avgPrice: null,
    proceedsIfFilled: 0n,
    feePct: input.feeBps / 100,
  };
  if (!(startP > 0)) errors.push("Enter a start price.");
  if (!(endP > 0)) errors.push("Enter an end price.");
  if (amount === null || amount <= 0n) errors.push("Enter an amount.");
  if (errors.length > 0 || amount === null) return base;

  const bStart = binForPrice(startP, input.stepBps);
  const bEnd = binForPrice(endP, input.stepBps);
  if (input.side === "Ask" && bEnd < bStart) errors.push("An ask range runs upward: the end price must be above the start price.");
  if (input.side === "Bid" && bEnd > bStart) errors.push("A bid range runs downward: the end price must be below the start price.");
  const loBin = Math.min(bStart, bEnd);
  const hiBin = Math.max(bStart, bEnd);
  const n = hiBin - loBin + 1;
  if (n > MAX_POSITION_BINS) errors.push(`Range spans ${n} bins; the contract allows at most ${MAX_POSITION_BINS} per position (narrow the range).`);
  if (errors.length > 0) return { ...base, loBin, hiBin };

  // weights from start to end, then mapped to ascending bin order
  const fromStart = shapeWeights(input.shape, n);
  const weights = input.side === "Ask" ? fromStart : [...fromStart].reverse();
  const wSum = BigInt(weights.reduce((a, b) => a + b, 0));
  const shares = weights.map((w) => (amount * BigInt(w)) / wSum);
  const rest = amount - shares.reduce((a, b) => a + b, 0n);
  let heavy = 0;
  weights.forEach((w, i) => {
    if (w > weights[heavy]) heavy = i;
  });
  shares[heavy] += rest;
  if (shares.some((x) => x > 0n && x < MIN_BIN_DEPOSIT)) {
    errors.push(`Too little per bin: the contract needs at least 0.001 in every bin (${n} bins). Use a bigger amount or fewer bins.`);
    return { ...base, loBin, hiBin };
  }

  const bins: PlannedBin[] = weights.map((w, i) => {
    const bin = loBin + i;
    const price = priceAt(bin, input.stepBps);
    const amt = shares[i];
    const baseSize = input.side === "Ask" ? amt : price > 0n ? divRound(amt * SCALE, price) : 0n;
    return { bin, price, weight: w, amount: amt, baseSize };
  });
  const totalBase = bins.reduce((a, b) => a + b.baseSize, 0n);
  const value = bins.reduce((a, b) => a + divRound(b.baseSize * b.price, SCALE), 0n);
  const proceeds =
    input.side === "Ask"
      ? bins.reduce((a, b) => a + divRound(b.amount * b.price, SCALE), 0n)
      : bins.reduce((a, b) => a + b.baseSize, 0n);

  return {
    ok: true,
    errors,
    side: input.side,
    loBin,
    hiBin,
    bins,
    weights,
    deposit: amount,
    avgPrice: totalBase > 0n ? divRound(value * SCALE, totalBase) : null,
    proceedsIfFilled: proceeds,
    feePct: input.feeBps / 100,
  };
}
