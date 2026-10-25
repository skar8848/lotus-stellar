//! Fixed-point helpers: overflow-safe mul-div, the price grid, and the
//! assets/shares rate used for the vault-backed QUOTE leg.

use crate::types::{Error, MAX_BIN, MIN_BIN};
use soroban_sdk::{panic_with_error, Env, U256};

/// `floor(a * b / c)` (or `ceil` when `up`), all operands non-negative and
/// `c > 0`. Takes the cheap i128 path when `a * b` fits and falls back to
/// 256-bit arithmetic otherwise; aborts with `Overflow` if the result does not
/// fit an i128.
pub fn mul_div(env: &Env, a: i128, b: i128, c: i128, up: bool) -> i128 {
    if a < 0 || b < 0 || c <= 0 {
        panic_with_error!(env, Error::Overflow);
    }
    if let Some(p) = a.checked_mul(b) {
        let q = p / c;
        return if up && p % c != 0 { q + 1 } else { q };
    }
    let p = U256::from_u128(env, a as u128).mul(&U256::from_u128(env, b as u128));
    let cc = U256::from_u128(env, c as u128);
    let mut q = p.div(&cc);
    if up && p.rem_euclid(&cc) != U256::from_u32(env, 0) {
        q = q.add(&U256::from_u32(env, 1));
    }
    match q.to_u128() {
        Some(v) if v <= i128::MAX as u128 => v as i128,
        _ => panic_with_error!(env, Error::Overflow),
    }
}

// ---------------------------------------------------------------------------
// price grid
// ---------------------------------------------------------------------------

const S18: i128 = 1_000_000_000_000_000_000; // 1e18 internal scale
const S18_HALF: i128 = S18 / 2;
/// 1 bps = 1e14 in the 1e18 scale
const BPS_18: i128 = 100_000_000_000_000;
/// 1e18 -> 1e7 conversion
const TO_PRICE: i128 = 100_000_000_000; // 1e11
const TO_PRICE_HALF: i128 = TO_PRICE / 2;

/// `round(1e18 * a * b / 1e18)` with ties rounded up: the 1e18 fixed-point product.
fn mul18(env: &Env, a: i128, b: i128) -> i128 {
    match a.checked_mul(b) {
        Some(p) => (p + S18_HALF) / S18,
        None => panic_with_error!(env, Error::Overflow),
    }
}

/// Price of `bin` as QUOTE per BASE with 7 decimals:
///
/// `price_at(bin) = round_half_up(1e7 * (1 + step_bps / 10_000) ^ bin)`
///
/// Algorithm (every operation is plain integer arithmetic, so a BigInt port
/// reproduces it bit for bit):
///
/// 1. `f = 1e18 + step_bps * 1e14` (the growth factor in 1e18 fixed point, exact)
/// 2. `p = f ^ |bin|` by binary exponentiation, every product rounded to
///    nearest with `mul18(a, b) = (a * b + 5e17) / 1e18`
/// 3. for a negative bin, `p = (1e36 + p / 2) / p` (rounded reciprocal)
/// 4. `price = (p + 5e10) / 1e11` (round half up to 7 decimals)
///
/// The accumulated error of steps 1-3 is below 1e-16 relative, so the result
/// equals the exact rational rounding for every bin of the grid (checked for
/// steps 1, 5, 10, 20, 25, 50 and 100 bps against `test-vectors.json`, which
/// is produced with exact rational arithmetic).
pub fn price_at_fp(env: &Env, step_bps: u32, bin: i32) -> i128 {
    if !(MIN_BIN..=MAX_BIN).contains(&bin) {
        panic_with_error!(env, Error::InvalidRange);
    }
    let f = S18 + (step_bps as i128) * BPS_18;
    let mut e = bin.unsigned_abs();
    let mut result = S18;
    let mut base = f;
    while e > 0 {
        if e & 1 == 1 {
            result = mul18(env, result, base);
        }
        e >>= 1;
        if e > 0 {
            base = mul18(env, base, base);
        }
    }
    let p18 = if bin >= 0 {
        result
    } else {
        // S18 * S18 = 1e36 < i128::MAX
        (S18 * S18 + result / 2) / result
    };
    (p18 + TO_PRICE_HALF) / TO_PRICE
}

// ---------------------------------------------------------------------------
// assets <-> QUOTE units
// ---------------------------------------------------------------------------

/// Exchange rate between QUOTE assets and QUOTE units: `v` assets are worth
/// `s` units. Identity (1, 1) when the pool has no vault (units are QUOTE
/// stroops); with a vault, units are DeFindex shares and
/// `v = get_asset_amounts_per_shares(s)`.
#[derive(Clone, Copy, Debug)]
pub struct Rate {
    pub v: i128,
    pub s: i128,
}

impl Rate {
    pub const fn identity() -> Rate {
        Rate { v: 1, s: 1 }
    }

    /// Assets that `units` are worth, rounded down.
    pub fn assets_floor(&self, env: &Env, units: i128) -> i128 {
        if self.v == 1 && self.s == 1 {
            return units;
        }
        mul_div(env, units, self.v, self.s, false)
    }

    /// Units needed to be worth at least `assets`, rounded up.
    pub fn units_ceil(&self, env: &Env, assets: i128) -> i128 {
        if self.v == 1 && self.s == 1 {
            return assets;
        }
        mul_div(env, assets, self.s, self.v, true)
    }
}
