// Stellar amounts: 7 decimals everywhere, handled as BigInt stroops so nothing drifts.
// No imports on purpose: this file is shared by the app and by plain-node tests.

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

/** Like toStroops but returns null instead of throwing. */
export function tryStroops(s: string | null | undefined): bigint | null {
  if (s === null || s === undefined || s.trim() === "") return null;
  try {
    return toStroops(s);
  } catch {
    return null;
  }
}

export const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

/** Integer division rounding to nearest, ties away from zero. b must be non-zero. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b < 0n) {
    a = -a;
    b = -b;
  }
  const half = b / 2n;
  return a >= 0n ? (a + half) / b : -((-a + half) / b);
}
