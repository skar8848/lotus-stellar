#!/usr/bin/env python3
"""Generate test-vectors.json for Lotus pool `price_at`.

Ground truth, independent of the Rust code: exact rational arithmetic,

    price(bin) = round_half_up(1e7 * (1 + step/10000) ** bin)

for bin in [-200, 200]. The Rust unit test `price_matches_exact_vectors` and the
TypeScript BigInt port must both reproduce these numbers exactly.

Usage: python3 gen_test_vectors.py > test-vectors.json
"""
import json
from fractions import Fraction

STEPS = [1, 5, 10, 20, 25, 50, 100]
MIN_BIN, MAX_BIN = -200, 200
SCALE = 10**7


def price(step_bps: int, bin_: int) -> int:
    r = Fraction(10000 + step_bps, 10000) ** bin_
    v = r * SCALE
    # round half up (value is positive)
    return (v.numerator * 2 + v.denominator) // (v.denominator * 2)


def main() -> None:
    out = {
        "description": "Lotus pool price grid: price(bin) = round_half_up(1e7 * (1 + step_bps/10000)^bin), QUOTE per BASE with 7 decimals. "
        "Computed with exact rational arithmetic (gen_test_vectors.py). prices[k] is the price of bin MIN_BIN + k.",
        "scale": SCALE,
        "min_bin": MIN_BIN,
        "max_bin": MAX_BIN,
        "algorithm": "f = 1e18 + step_bps*1e14; p = f^|bin| by binary exponentiation with mul(a,b) = (a*b + 5e17) / 1e18 "
        "(integer division); bin < 0: p = (1e36 + p/2) / p; price = (p + 5e10) / 1e11. "
        "Agrees with the exact value for every bin of every step listed here.",
        "steps": {str(s): [price(s, b) for b in range(MIN_BIN, MAX_BIN + 1)] for s in STEPS},
    }
    # one line per top-level key, one line per step array (diff friendly)
    steps = out.pop("steps")
    lines = ["{"]
    for k, v in out.items():
        lines.append(f"  {json.dumps(k)}: {json.dumps(v)},")
    lines.append('  "steps": {')
    items = list(steps.items())
    for i, (k, v) in enumerate(items):
        comma = "," if i + 1 < len(items) else ""
        lines.append(f'    {json.dumps(k)}: {json.dumps(v, separators=(",", ":"))}{comma}')
    lines.append("  }")
    lines.append("}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
