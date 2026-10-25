// Reference BigInt implementation of the Lotus pool price grid, checked against test-vectors.json.
// Usage: node price-reference.mjs            (exits 1 on any mismatch)
// Copy `priceAt` into the front end / bot; it reproduces the contract bit for bit.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const S18 = 10n ** 18n;
const BPS_18 = 10n ** 14n;

/** price(bin) = round_half_up(1e7 * (1 + stepBps / 10000) ^ bin), QUOTE per BASE with 7 decimals. */
export function priceAt(stepBps, bin) {
  if (bin < -200 || bin > 200) throw new RangeError('bin outside [-200, 200]');
  const mul18 = (a, b) => (a * b + S18 / 2n) / S18;
  let result = S18;
  let base = S18 + BigInt(stepBps) * BPS_18;
  let e = Math.abs(bin);
  while (e > 0) {
    if (e & 1) result = mul18(result, base);
    e >>= 1;
    if (e > 0) base = mul18(base, base);
  }
  const p18 = bin >= 0 ? result : (S18 * S18 + result / 2n) / result;
  return (p18 + 5n * 10n ** 10n) / 10n ** 11n;
}

/** QUOTE price leg of `base` stroops at `price`, rounded up (what a buyer pays) or down (what a seller gets). */
export const quoteUp = (base, price) => (base * price + 9_999_999n) / 10_000_000n;
export const quoteDown = (base, price) => (base * price) / 10_000_000n;
/** fee on a price leg: ceil(q * feeBps / 10000) */
export const feeOn = (q, feeBps) => (q * BigInt(feeBps) + 9_999n) / 10_000n;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const vec = JSON.parse(readFileSync(join(here, 'test-vectors.json'), 'utf8'));
  let n = 0;
  let bad = 0;
  for (const [step, prices] of Object.entries(vec.steps)) {
    prices.forEach((want, k) => {
      const bin = vec.min_bin + k;
      const got = priceAt(Number(step), bin);
      n++;
      if (got !== BigInt(want)) {
        bad++;
        if (bad < 10) console.error(`step ${step} bin ${bin}: got ${got} want ${want}`);
      }
    });
  }
  console.log(`${n} prices checked, ${bad} mismatches`);
  process.exit(bad ? 1 : 0);
}
