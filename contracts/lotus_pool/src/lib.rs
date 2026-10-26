#![no_std]
//! # Lotus pool
//!
//! A directional range pool for Soroban. Liquidity providers place BASE
//! (`Side::Ask`) or QUOTE (`Side::Bid`) on a grid of price bins. A position is
//! one-way by construction: inventory only goes down as takers fill it, and
//! the proceeds can never be bought back. Optionally the whole QUOTE leg (Bid
//! inventory, Ask proceeds, fees) sits in a DeFindex vault that lends on Blend
//! and is recalled just in time by the taker's own swap.
//!
//! `Mode::TwoWay` positions (pools without a vault only) rest on both sides of
//! their bin's price: a buyer's QUOTE lands in the bin's QUOTE reserve, which
//! then bids at the same price, so the price coming back through the bin
//! refills it, like a DLMM bin. Directional and two-way liquidity share the
//! book: at every price a swap takes the directional bin first, then the
//! two-way bin.
//!
//! The full interface, the invariants and the deployment file shape live in
//! `docs/pool-abi.md`; the build / deploy recipe in `contracts/lotus_pool/README.md`.
//!
//! ## Accounting in one paragraph
//!
//! Every bin keeps `inventory` (what is still for sale), `total_shares` (LP
//! shares) and three per-share accumulators scaled by 1e18: `acc_x` (inventory
//! consumed), `acc_p` (proceeds) and `acc_f` (fees). A position holds `shares`
//! in each of its bins plus the accumulator values at the time it joined (or
//! last claimed). Its pending proceeds are `shares * (acc_p - ckpt_p) / 1e18`,
//! so a late depositor never sees earlier proceeds, and a fill costs one
//! storage write per bin crossed regardless of how many LPs share the bin.
//! A bin that is fully filled and then reused starts a new *generation*: the
//! old accumulators are sealed in their own record so earlier positions keep
//! their claims. All divisions round down for payouts and up for what takers
//! pay, so the pool never owes more than it holds.

mod defindex;
mod math;
mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_vault;

pub use math::Rate;
pub use types::*;

use defindex::DeFindexVaultClient;
use math::{mul_div, price_at_fp};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractevent, contractimpl, panic_with_error, symbol_short, token, vec, Address,
    Env, IntoVal, Vec,
};

pub const DAY_IN_LEDGERS: u32 = 17280;
pub const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const LIFETIME_THRESHOLD: u32 = BUMP_AMOUNT - DAY_IN_LEDGERS;

/// Bumped when the ABI changes.
pub const ABI_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/// Topics: `["position_added", owner]`.
#[contractevent(topics = ["position_added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionAdded {
    #[topic]
    pub owner: Address,
    pub id: u64,
    pub side: Side,
    pub lo_bin: i32,
    pub hi_bin: i32,
    pub amount: i128,
}

/// Topics: `["position_removed", owner]`.
#[contractevent(topics = ["position_removed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionRemoved {
    #[topic]
    pub owner: Address,
    pub id: u64,
    pub base: i128,
    pub quote: i128,
}

/// Topics: `["claimed", owner]`.
#[contractevent(topics = ["claimed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub owner: Address,
    pub id: u64,
    pub base: i128,
    pub quote: i128,
}

/// Topics: `["swap", taker]`. `amount_in` is what was actually pulled from the
/// taker (BASE for a sell, QUOTE incl. fee for a buy), `amount_out` what was
/// sent to the taker, `fee` the QUOTE fee, `last_bin` the last bin touched.
#[contractevent(topics = ["swap"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swapped {
    #[topic]
    pub taker: Address,
    pub buy_base: bool,
    pub amount_in: i128,
    pub amount_out: i128,
    pub fee: i128,
    pub bins_crossed: u32,
    pub last_bin: i32,
}

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn read_active(env: &Env, side: Side) -> ActiveSet {
    env.storage()
        .instance()
        .get(&DataKey::Active(side))
        .unwrap_or(ActiveSet::empty())
}

fn write_active(env: &Env, side: Side, set: &ActiveSet) {
    env.storage().instance().set(&DataKey::Active(side), set);
}

fn read_active_tw(env: &Env, side: Side) -> ActiveSet {
    env.storage()
        .instance()
        .get(&DataKey::ActiveTw(side))
        .unwrap_or(ActiveSet::empty())
}

fn write_active_tw(env: &Env, side: Side, set: &ActiveSet) {
    env.storage().instance().set(&DataKey::ActiveTw(side), set);
}

fn read_tw(env: &Env, bin: i32) -> Option<TwBin> {
    env.storage().persistent().get(&DataKey::TwBin(bin))
}

fn write_tw(env: &Env, bin: i32, t: &TwBin) {
    let key = DataKey::TwBin(bin);
    env.storage().persistent().set(&key, t);
    env.storage()
        .persistent()
        .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn new_tw(env: &Env, cfg: &Config, bin: i32) -> TwBin {
    TwBin {
        price: price_at_fp(env, cfg.bin_step_bps, bin),
        ..TwBin::default()
    }
}

/// Keep the two-way index in step with a bin's reserves: bit set in the Ask
/// set while the bin holds BASE, in the Bid set while it holds QUOTE.
fn sync_tw_sets(ask: &mut ActiveSet, bid: &mut ActiveSet, bin: i32, t: &TwBin) {
    if t.x > 0 {
        ask.insert(bin);
    } else {
        ask.remove(bin);
    }
    if t.y > 0 {
        bid.insert(bin);
    } else {
        bid.remove(bin);
    }
}

/// Value of a two-way bin in BASE at its price, QUOTE converted rounding up
/// (the denominator of share minting, so a depositor never gets extra shares).
fn tw_value_base_up(env: &Env, t: &TwBin) -> i128 {
    t.x + mul_div(env, t.y, PRICE_SCALE, t.price, true)
}

/// Lowest bin `>= from` set in either index.
fn next_up2(a: &ActiveSet, b: &ActiveSet, from: i32) -> Option<i32> {
    match (a.next_up(from), b.next_up(from)) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

/// Highest bin `<= from` set in either index.
fn next_down2(a: &ActiveSet, b: &ActiveSet, from: i32) -> Option<i32> {
    match (a.next_down(from), b.next_down(from)) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, None) => x,
        (None, y) => y,
    }
}

fn read_qs(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::QuoteShares)
        .unwrap_or(0)
}

fn write_qs(env: &Env, v: i128) {
    env.storage().instance().set(&DataKey::QuoteShares, &v);
}

fn read_bin(env: &Env, side: Side, bin: i32) -> Option<BinRec> {
    env.storage().persistent().get(&DataKey::Bin(side, bin))
}

fn write_bin(env: &Env, side: Side, bin: i32, rec: &BinRec) {
    let key = DataKey::Bin(side, bin);
    env.storage().persistent().set(&key, rec);
    env.storage()
        .persistent()
        .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn read_sealed(env: &Env, side: Side, bin: i32, gen: u32) -> Sealed {
    env.storage()
        .persistent()
        .get(&DataKey::Sealed(side, bin, gen))
        .unwrap_or_default()
}

fn write_sealed(env: &Env, side: Side, bin: i32, gen: u32, s: &Sealed) {
    let key = DataKey::Sealed(side, bin, gen);
    env.storage().persistent().set(&key, s);
    env.storage()
        .persistent()
        .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn read_pos(env: &Env, id: u64) -> PosRec {
    env.storage()
        .persistent()
        .get(&DataKey::Position(id))
        .unwrap_or_else(|| panic_with_error!(env, Error::NoSuchPosition))
}

fn write_pos(env: &Env, pos: &PosRec) {
    let key = DataKey::Position(pos.id);
    env.storage().persistent().set(&key, pos);
    env.storage()
        .persistent()
        .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn read_owner(env: &Env, owner: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::Owner(owner.clone()))
        .unwrap_or(Vec::new(env))
}

fn write_owner(env: &Env, owner: &Address, ids: &Vec<u64>) {
    let key = DataKey::Owner(owner.clone());
    env.storage().persistent().set(&key, ids);
    env.storage()
        .persistent()
        .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn new_bin(env: &Env, cfg: &Config, bin: i32) -> BinRec {
    BinRec {
        price: price_at_fp(env, cfg.bin_step_bps, bin),
        ..BinRec::default()
    }
}

// ---------------------------------------------------------------------------
// vault plumbing (DeFindex)
// ---------------------------------------------------------------------------

/// Deposit `amount` QUOTE (already held by the pool) into the DeFindex vault.
/// Returns the vault shares minted to the pool and records them in `QuoteShares`.
fn vault_deposit(env: &Env, cfg: &Config, vault: &Address, amount: i128) -> i128 {
    let this = env.current_contract_address();
    // DeFindex pulls the underlying with a nested `transfer(pool, vault, amount)`
    // that it invokes itself; we are not the direct invoker, so pre-authorise it.
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: cfg.quote.clone(),
                fn_name: symbol_short!("transfer"),
                args: (this.clone(), vault.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);
    let (_amounts, shares, _alloc) = DeFindexVaultClient::new(env, vault).deposit(
        &vec![env, amount],
        &vec![env, 0],
        &this,
        &true,
    );
    if shares <= 0 {
        panic_with_error!(env, Error::VaultShortfall);
    }
    write_qs(env, read_qs(env) + shares);
    shares
}

/// Burn `shares` vault shares held by the pool and return the QUOTE received.
fn vault_withdraw(env: &Env, vault: &Address, shares: i128) -> i128 {
    let this = env.current_contract_address();
    let qs = read_qs(env);
    if shares > qs {
        panic_with_error!(env, Error::VaultShortfall);
    }
    let out = DeFindexVaultClient::new(env, vault)
        .withdraw(&shares, &vec![env, 0], &this)
        .get(0)
        .unwrap_or(0);
    write_qs(env, qs - shares);
    out
}

/// Assets/units rate for the pool's QUOTE units. Identity without a vault;
/// with one, `get_asset_amounts_per_shares(QuoteShares)` (one read-only vault
/// call). Returns the identity when the pool holds no vault shares at all.
fn quote_rate(env: &Env, cfg: &Config) -> Rate {
    match &cfg.vault {
        None => Rate::identity(),
        Some(vault) => {
            let qs = read_qs(env);
            if qs <= 0 {
                return Rate::identity();
            }
            let v = DeFindexVaultClient::new(env, vault)
                .get_asset_amounts_per_shares(&qs)
                .get(0)
                .unwrap_or(0);
            if v <= 0 {
                panic_with_error!(env, Error::VaultShortfall);
            }
            Rate { v, s: qs }
        }
    }
}

/// Pay `units` QUOTE units to `to`: idle QUOTE directly, vault shares through
/// one withdrawal. Returns the QUOTE assets sent.
fn pay_quote(env: &Env, cfg: &Config, to: &Address, units: i128) -> i128 {
    if units <= 0 {
        return 0;
    }
    let assets = match &cfg.vault {
        None => units,
        Some(vault) => vault_withdraw(env, vault, units),
    };
    if assets > 0 {
        token::TokenClient::new(env, &cfg.quote).transfer(
            &env.current_contract_address(),
            to,
            &assets,
        );
    }
    assets
}

fn pay_base(env: &Env, cfg: &Config, to: &Address, amount: i128) {
    if amount > 0 {
        token::TokenClient::new(env, &cfg.base).transfer(
            &env.current_contract_address(),
            to,
            &amount,
        );
    }
}

// ---------------------------------------------------------------------------
// swap planning (shared by quote_swap and swap)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Fill {
    bin: i32,
    /// 0: directional bin, 1: two-way bin (then `rec` carries the two-way
    /// fields: `inventory` = BASE reserve, and `y` below is the QUOTE reserve)
    kind: u8,
    y: i128,
    /// bin after the fill (inventory and filled updated, accumulators not yet)
    rec: BinRec,
    /// price-leg QUOTE (assets): quantity * price
    q: i128,
    /// fee on the price leg (QUOTE assets)
    fee: i128,
    /// inventory consumed, in value terms (feeds `acc_x`)
    dx: i128,
    /// proceeds credited to the bin's LP shares, in proceeds units
    credit_p: i128,
    /// fees credited to the bin's LP shares, in QUOTE units
    credit_f: i128,
}

struct Walk {
    n: usize,
    fills: [Fill; HARD_MAX_BINS_PER_SWAP as usize],
    /// input consumed (buy: QUOTE incl. fee, sell: BASE)
    spent: i128,
    /// output (buy: BASE, sell: QUOTE net of fee)
    out: i128,
    /// total fee in QUOTE assets
    fee: i128,
    /// sell with vault: shares to withdraw for the taker
    withdraw_units: i128,
    partial: bool,
}

impl Walk {
    fn new() -> Walk {
        Walk {
            n: 0,
            fills: [Fill::default(); HARD_MAX_BINS_PER_SWAP as usize],
            spent: 0,
            out: 0,
            fee: 0,
            withdraw_units: 0,
            partial: false,
        }
    }
}

fn check_amount(env: &Env, amount: i128) {
    if amount <= 0 || amount > MAX_AMOUNT {
        panic_with_error!(env, Error::InvalidAmount);
    }
}

/// What a single bin did to the walk.
#[derive(PartialEq)]
enum Step {
    /// keep walking
    Next,
    /// the input is too small to buy anything more: stop
    Exhausted,
}

/// Buy from a directional Ask bin.
fn fill_buy_dir(
    env: &Env,
    fee_bps: i128,
    bin: i32,
    remaining: &mut i128,
    w: &mut Walk,
) -> Step {
    let mut rec = match read_bin(env, Side::Ask, bin) {
        Some(r) => r,
        None => return Step::Next,
    };
    let p = rec.price;
    // largest quantity whose price leg plus fee fits the remaining budget
    let q_max = mul_div(env, *remaining, BPS, BPS + fee_bps, false);
    let x_budget = mul_div(env, q_max, PRICE_SCALE, p, false);
    let x = rec.inventory.min(x_budget);
    if x <= 0 {
        return Step::Exhausted;
    }
    let q = mul_div(env, x, p, PRICE_SCALE, true);
    let fee = mul_div(env, q, fee_bps, BPS, true);
    let t = q + fee;
    if t > *remaining {
        panic_with_error!(env, Error::Overflow); // unreachable by construction
    }
    let budget_bound = x < rec.inventory;
    rec.inventory -= x;
    rec.filled += x;
    w.fills[w.n] = Fill {
        bin,
        kind: 0,
        y: 0,
        rec,
        q,
        fee,
        dx: x,
        credit_p: 0, // set after settlement (vault shares are only known then)
        credit_f: 0,
    };
    w.n += 1;
    w.spent += t;
    w.out += x;
    w.fee += fee;
    *remaining -= t;
    if budget_bound {
        Step::Exhausted
    } else {
        Step::Next
    }
}

/// Buy from a two-way bin: BASE leaves `x`, the buyer's QUOTE lands in `y`.
fn fill_buy_tw(env: &Env, fee_bps: i128, bin: i32, remaining: &mut i128, w: &mut Walk) -> Step {
    let mut t = match read_tw(env, bin) {
        Some(t) => t,
        None => return Step::Next,
    };
    let p = t.price;
    let q_max = mul_div(env, *remaining, BPS, BPS + fee_bps, false);
    let x_budget = mul_div(env, q_max, PRICE_SCALE, p, false);
    let x = t.x.min(x_budget);
    if x <= 0 {
        return Step::Exhausted;
    }
    let q = mul_div(env, x, p, PRICE_SCALE, true);
    let fee = mul_div(env, q, fee_bps, BPS, true);
    let paid = q + fee;
    if paid > *remaining {
        panic_with_error!(env, Error::Overflow); // unreachable by construction
    }
    let budget_bound = x < t.x;
    t.x -= x;
    t.y += q;
    t.filled += x;
    w.fills[w.n] = Fill {
        bin,
        kind: 1,
        y: t.y,
        rec: tw_to_rec(&t),
        q,
        fee,
        dx: x,
        credit_p: 0,
        credit_f: fee, // idle pools only: units == QUOTE
    };
    w.n += 1;
    w.spent += paid;
    w.out += x;
    w.fee += fee;
    *remaining -= paid;
    if budget_bound {
        Step::Exhausted
    } else {
        Step::Next
    }
}

/// Sell into a directional Bid bin.
fn fill_sell_dir(
    env: &Env,
    fee_bps: i128,
    rate: Rate,
    bin: i32,
    remaining: &mut i128,
    w: &mut Walk,
) -> Step {
    let mut rec = match read_bin(env, Side::Bid, bin) {
        Some(r) => r,
        None => return Step::Next,
    };
    let p = rec.price;
    // QUOTE value of the bin's inventory, then the BASE it can absorb
    let cap = rate.assets_floor(env, rec.inventory);
    let x_cap = mul_div(env, cap, PRICE_SCALE, p, false);
    let x = (*remaining).min(x_cap);
    if x <= 0 {
        return Step::Next; // dust bin
    }
    let q = mul_div(env, x, p, PRICE_SCALE, false);
    let fee = mul_div(env, q, fee_bps, BPS, true);
    let payout = q - fee;
    if payout <= 0 {
        return if x == *remaining {
            Step::Exhausted
        } else {
            Step::Next
        };
    }
    // inventory units consumed (rounded up) and the part paid to the taker
    let sh = rate.units_ceil(env, q);
    let wsh = rate.units_ceil(env, payout);
    let mut inv_used = sh;
    let mut fee_units = sh - wsh;
    // sweep a remainder that could never pay a taker anything (it buys at most
    // a quantity whose price leg does not cover the fee) to the LPs as fee, so a
    // bin never keeps unfillable dust in the book
    let rem_units = rec.inventory - sh;
    if rem_units > 0 {
        let rem_value = rate.assets_floor(env, rem_units);
        let x_rem = mul_div(env, rem_value, PRICE_SCALE, p, false);
        let q_rem = mul_div(env, x_rem, p, PRICE_SCALE, false);
        if q_rem <= mul_div(env, q_rem, fee_bps, BPS, true) {
            inv_used += rem_units;
            fee_units += rem_units;
        }
    }
    rec.inventory -= inv_used;
    rec.filled += q;
    w.fills[w.n] = Fill {
        bin,
        kind: 0,
        y: 0,
        rec,
        q,
        fee,
        dx: q,
        credit_p: x,
        credit_f: fee_units,
    };
    w.n += 1;
    w.spent += x;
    w.out += payout;
    w.fee += fee;
    w.withdraw_units += wsh;
    *remaining -= x;
    Step::Next
}

/// Sell into a two-way bin: QUOTE leaves `y`, the seller's BASE lands in `x`.
fn fill_sell_tw(env: &Env, fee_bps: i128, bin: i32, remaining: &mut i128, w: &mut Walk) -> Step {
    let mut t = match read_tw(env, bin) {
        Some(t) => t,
        None => return Step::Next,
    };
    let p = t.price;
    let x_cap = mul_div(env, t.y, PRICE_SCALE, p, false);
    let x = (*remaining).min(x_cap);
    if x <= 0 {
        return Step::Next;
    }
    let q = mul_div(env, x, p, PRICE_SCALE, false);
    let fee = mul_div(env, q, fee_bps, BPS, true);
    let payout = q - fee;
    if payout <= 0 {
        return if x == *remaining {
            Step::Exhausted
        } else {
            Step::Next
        };
    }
    t.y -= q;
    t.x += x;
    t.filled += x;
    // QUOTE left in the bin that could never pay a taker goes to the LPs as fee
    let mut fee_credit = fee;
    if t.y > 0 {
        let x_rem = mul_div(env, t.y, PRICE_SCALE, p, false);
        let q_rem = mul_div(env, x_rem, p, PRICE_SCALE, false);
        if q_rem <= mul_div(env, q_rem, fee_bps, BPS, true) {
            fee_credit += t.y;
            t.y = 0;
        }
    }
    w.fills[w.n] = Fill {
        bin,
        kind: 1,
        y: t.y,
        rec: tw_to_rec(&t),
        q,
        fee,
        dx: x,
        credit_p: 0,
        credit_f: fee_credit,
    };
    w.n += 1;
    w.spent += x;
    w.out += payout;
    w.fee += fee;
    *remaining -= x;
    Step::Next
}

/// The two-way bin as a `BinRec` (BASE reserve in `inventory`; the QUOTE
/// reserve travels in `Fill.y`).
fn tw_to_rec(t: &TwBin) -> BinRec {
    BinRec {
        gen: 0,
        price: t.price,
        inventory: t.x,
        total_shares: t.total_shares,
        filled: t.filled,
        acc_x: t.acc_x,
        acc_p: 0,
        acc_f: t.acc_f,
    }
}

/// Walk the book and fill `w` without touching storage.
///
/// buy_base: pay QUOTE (`amount_in` is the maximum, fee included), receive BASE,
/// Ask bins from the cheapest price up. Sell: pay BASE, receive QUOTE, Bid bins
/// from the highest price down. Directional bins and two-way bins are two
/// sources at every price level (`set` is the directional index of the side,
/// `set_tw` the two-way index of the side). At most `max_bins_per_swap` bin
/// records are visited.
fn plan(
    env: &Env,
    cfg: &Config,
    buy_base: bool,
    amount_in: i128,
    rate: Rate,
    set: &ActiveSet,
    set_tw: &ActiveSet,
    w: &mut Walk,
) {
    let fee_bps = cfg.fee_bps as i128;
    let max_visit = cfg.max_bins_per_swap.min(HARD_MAX_BINS_PER_SWAP);
    let mut remaining = amount_in;
    let mut visited = 0u32;
    let mut exhausted = false; // the input is too small to buy anything more
    let mut next = if buy_base {
        next_up2(set, set_tw, MIN_BIN)
    } else {
        next_down2(set, set_tw, MAX_BIN)
    };

    'levels: while let Some(bin) = next {
        if remaining <= 0 {
            break;
        }
        next = if buy_base {
            next_up2(set, set_tw, bin + 1)
        } else {
            next_down2(set, set_tw, bin - 1)
        };
        let mut src = 0;
        while src < 2 {
            let is_tw = src == 1;
            src += 1;
            let present = if is_tw { set_tw.contains(bin) } else { set.contains(bin) };
            if !present {
                continue;
            }
            if remaining <= 0 || visited >= max_visit {
                break 'levels;
            }
            visited += 1;
            let step = match (buy_base, is_tw) {
                (true, false) => fill_buy_dir(env, fee_bps, bin, &mut remaining, w),
                (true, true) => fill_buy_tw(env, fee_bps, bin, &mut remaining, w),
                (false, false) => fill_sell_dir(env, fee_bps, rate, bin, &mut remaining, w),
                (false, true) => fill_sell_tw(env, fee_bps, bin, &mut remaining, w),
            };
            if step == Step::Exhausted {
                exhausted = true;
                break 'levels;
            }
        }
    }
    w.partial = remaining > 0 && !exhausted;
}

/// Split the units received for a buy over the crossed bins, proportionally to
/// the QUOTE each bin earned (floor). With an idle pool `units == spent` and the
/// split is exact; with a vault it is `units = shares minted` and the dust stays
/// in the pool.
fn credit_ask_fills(env: &Env, w: &mut Walk, units: i128) {
    let mut i = 0;
    while i < w.n {
        let f = &mut w.fills[i];
        if f.kind == 0 {
            f.credit_p = mul_div(env, units, f.q, w.spent, false);
            f.credit_f = mul_div(env, units, f.fee, w.spent, false);
        }
        i += 1;
    }
}

/// Write the crossed bins (accumulators included) and update the indexes.
fn commit(
    env: &Env,
    side: Side,
    w: &Walk,
    mut set: ActiveSet,
    mut tw_ask: ActiveSet,
    mut tw_bid: ActiveSet,
) {
    let (before, before_ask, before_bid) = (set, tw_ask, tw_bid);
    let mut i = 0;
    while i < w.n {
        let f = &w.fills[i];
        let mut rec = f.rec;
        let ts = rec.total_shares;
        rec.acc_x += mul_div(env, f.dx, ACC_SCALE, ts, false);
        rec.acc_f += mul_div(env, f.credit_f, ACC_SCALE, ts, false);
        if f.kind == 0 {
            rec.acc_p += mul_div(env, f.credit_p, ACC_SCALE, ts, false);
            write_bin(env, side, f.bin, &rec);
            if rec.inventory == 0 {
                set.remove(f.bin);
            }
        } else {
            let t = TwBin {
                price: rec.price,
                x: rec.inventory,
                y: f.y,
                total_shares: ts,
                filled: rec.filled,
                acc_x: rec.acc_x,
                acc_f: rec.acc_f,
            };
            write_tw(env, f.bin, &t);
            sync_tw_sets(&mut tw_ask, &mut tw_bid, f.bin, &t);
        }
        i += 1;
    }
    if set != before {
        write_active(env, side, &set);
    }
    if tw_ask != before_ask {
        write_active_tw(env, Side::Ask, &tw_ask);
    }
    if tw_bid != before_bid {
        write_active_tw(env, Side::Bid, &tw_bid);
    }
}

// ---------------------------------------------------------------------------
// position helpers
// ---------------------------------------------------------------------------

/// `shares * (now - ckpt) / 1e18`, rounded down.
fn accrued(env: &Env, shares: i128, now: i128, ckpt: i128) -> i128 {
    if now <= ckpt {
        return 0;
    }
    mul_div(env, shares, now - ckpt, ACC_SCALE, false)
}

/// Accumulators of the generation an entry belongs to.
fn entry_accs(env: &Env, side: Side, e: &PosEntry, live: &BinRec) -> (i128, i128, i128) {
    if e.gen == live.gen {
        (live.acc_x, live.acc_p, live.acc_f)
    } else {
        let s = read_sealed(env, side, e.bin, e.gen);
        (s.acc_x, s.acc_p, s.acc_f)
    }
}

/// An entry's share of its bin's live inventory (0 for a sealed generation).
fn entry_inventory(e: &PosEntry, live: &BinRec, env: &Env) -> i128 {
    if e.gen != live.gen || live.total_shares <= 0 {
        return 0;
    }
    if e.shares >= live.total_shares {
        return live.inventory;
    }
    mul_div(env, e.shares, live.inventory, live.total_shares, false)
}

/// Spread `amount` over `n` bins by `weights` (empty = uniform). The rounding
/// remainder goes to the last bin with a non-zero weight.
fn split_amount(
    env: &Env,
    amount: i128,
    n: u32,
    weights: &Vec<u32>,
    out: &mut [i128; MAX_POSITION_BINS as usize],
) {
    if !weights.is_empty() && weights.len() != n {
        panic_with_error!(env, Error::InvalidWeights);
    }
    let weight = |i: u32| -> i128 {
        if weights.is_empty() {
            1
        } else {
            weights.get_unchecked(i) as i128
        }
    };
    let mut total_w: i128 = 0;
    let mut last_nonzero = 0u32;
    let mut i = 0;
    while i < n {
        let w = weight(i);
        if w > 0 {
            total_w += w;
            last_nonzero = i;
        }
        i += 1;
    }
    if total_w == 0 {
        panic_with_error!(env, Error::InvalidWeights);
    }
    let mut assigned: i128 = 0;
    i = 0;
    while i < n {
        let w = weight(i);
        let a = mul_div(env, amount, w, total_w, false);
        out[i as usize] = a;
        assigned += a;
        i += 1;
    }
    out[last_nonzero as usize] += amount - assigned;
}

/// Directional deposit: mint shares in each bin of the range and return the
/// position's entries.
fn deposit_directional(
    env: &Env,
    cfg: &Config,
    side: Side,
    lo_bin: i32,
    n: u32,
    amounts: &[i128; MAX_POSITION_BINS as usize],
    amount: i128,
    total_units: i128,
) -> Vec<PosEntry> {
    let mut set = read_active(env, side);
    let mut entries: Vec<PosEntry> = Vec::new(env);
    let mut i = 0usize;
    while i < n as usize {
        if amounts[i] == 0 {
            i += 1;
            continue;
        }
        let bin = lo_bin + i as i32;
        let units = if total_units == amount {
            amounts[i]
        } else {
            mul_div(env, total_units, amounts[i], amount, false)
        };
        if units <= 0 {
            panic_with_error!(env, Error::AmountTooSmall);
        }
        let mut rec = read_bin(env, side, bin).unwrap_or_else(|| new_bin(env, cfg, bin));
        if rec.total_shares > 0 && rec.inventory == 0 {
            // fully filled generation being reused: seal its accumulators
            write_sealed(
                env,
                side,
                bin,
                rec.gen,
                &Sealed {
                    acc_x: rec.acc_x,
                    acc_p: rec.acc_p,
                    acc_f: rec.acc_f,
                },
            );
            rec.gen += 1;
            rec.total_shares = 0;
            rec.acc_x = 0;
            rec.acc_p = 0;
            rec.acc_f = 0;
        }
        let shares = if rec.total_shares == 0 {
            units
        } else {
            match rec.inventory.checked_mul(DILUTION_LIMIT) {
                Some(v) if v >= rec.total_shares => {}
                Some(_) => panic_with_error!(env, Error::BinDust),
                None => {}
            }
            mul_div(env, units, rec.total_shares, rec.inventory, false)
        };
        if shares <= 0 {
            panic_with_error!(env, Error::AmountTooSmall);
        }
        rec.inventory += units;
        rec.total_shares += shares;
        entries.push_back(PosEntry {
            bin,
            gen: rec.gen,
            shares,
            ckpt_x: rec.acc_x,
            ckpt_p: rec.acc_p,
            ckpt_f: rec.acc_f,
        });
        write_bin(env, side, bin, &rec);
        set.insert(bin);
        i += 1;
    }
    write_active(env, side, &set);
    entries
}

/// Two-way deposit (idle pools only): the deposit asset joins the reserve of
/// each bin, shares are minted against the bin's value in BASE at its price,
/// so a deposit into a bin that already holds both assets gets a pro-rata slice
/// of both (the same as joining an active bin of a DLMM pool, without the
/// imbalance fee).
fn deposit_two_way(
    env: &Env,
    cfg: &Config,
    side: Side,
    lo_bin: i32,
    n: u32,
    amounts: &[i128; MAX_POSITION_BINS as usize],
) -> Vec<PosEntry> {
    let mut tw_ask = read_active_tw(env, Side::Ask);
    let mut tw_bid = read_active_tw(env, Side::Bid);
    let mut entries: Vec<PosEntry> = Vec::new(env);
    let mut i = 0usize;
    while i < n as usize {
        let a = amounts[i];
        if a == 0 {
            i += 1;
            continue;
        }
        let bin = lo_bin + i as i32;
        let mut t = read_tw(env, bin).unwrap_or_else(|| new_tw(env, cfg, bin));
        // value of the deposit in BASE at the bin price (QUOTE converted rounding down)
        let value = match side {
            Side::Ask => a,
            Side::Bid => mul_div(env, a, PRICE_SCALE, t.price, false),
        };
        if value <= 0 {
            panic_with_error!(env, Error::AmountTooSmall);
        }
        let shares = if t.total_shares == 0 {
            value
        } else {
            let total_value = tw_value_base_up(env, &t);
            if total_value <= 0 {
                // only fees are left in the bin: wait until its LPs have left
                panic_with_error!(env, Error::BinDust);
            }
            mul_div(env, value, t.total_shares, total_value, false)
        };
        if shares <= 0 {
            panic_with_error!(env, Error::AmountTooSmall);
        }
        match side {
            Side::Ask => t.x += a,
            Side::Bid => t.y += a,
        }
        t.total_shares += shares;
        entries.push_back(PosEntry {
            bin,
            gen: 0,
            shares,
            ckpt_x: t.acc_x,
            ckpt_p: 0,
            ckpt_f: t.acc_f,
        });
        write_tw(env, bin, &t);
        sync_tw_sets(&mut tw_ask, &mut tw_bid, bin, &t);
        i += 1;
    }
    write_active_tw(env, Side::Ask, &tw_ask);
    write_active_tw(env, Side::Bid, &tw_bid);
    entries
}

/// What a two-way position holds right now in one bin: its slice of both reserves.
fn tw_slice(env: &Env, t: &TwBin, shares: i128) -> (i128, i128) {
    if t.total_shares <= 0 {
        return (0, 0);
    }
    if shares >= t.total_shares {
        return (t.x, t.y);
    }
    (
        mul_div(env, shares, t.x, t.total_shares, false),
        mul_div(env, shares, t.y, t.total_shares, false),
    )
}

/// Burn a two-way position's shares: returns (BASE, QUOTE incl. fees) to pay out.
fn withdraw_two_way(env: &Env, pos: &PosRec) -> (i128, i128) {
    let mut tw_ask = read_active_tw(env, Side::Ask);
    let mut tw_bid = read_active_tw(env, Side::Bid);
    let (mut base_out, mut quote_out) = (0i128, 0i128);
    for e in pos.entries.iter() {
        let mut t = read_tw(env, e.bin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NoSuchPosition));
        let (x, y) = tw_slice(env, &t, e.shares);
        let df = accrued(env, e.shares, t.acc_f, e.ckpt_f);
        base_out += x;
        quote_out += y + df;
        t.x -= x;
        t.y -= y;
        t.total_shares -= e.shares;
        write_tw(env, e.bin, &t);
        sync_tw_sets(&mut tw_ask, &mut tw_bid, e.bin, &t);
    }
    write_active_tw(env, Side::Ask, &tw_ask);
    write_active_tw(env, Side::Bid, &tw_bid);
    (base_out, quote_out)
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

#[contract]
pub struct LotusPool;

#[contractimpl]
impl LotusPool {
    /// * `admin`        - may change `max_bins_per_swap`; nothing else.
    /// * `base`/`quote` - SAC addresses of the two assets (BASE is the asset that is sold).
    /// * `vault`        - optional single-asset DeFindex vault of the QUOTE asset. With a
    ///                    vault every QUOTE-denominated balance is held as vault shares.
    /// * `bin_step_bps` - price step between bins, 1..=100 (10 = 0.1 percent).
    /// * `fee_bps`      - fee on the QUOTE leg of every fill, 0..=1000, paid to the bin's LPs.
    pub fn __constructor(
        env: Env,
        admin: Address,
        base: Address,
        quote: Address,
        vault: Option<Address>,
        bin_step_bps: u32,
        fee_bps: u32,
    ) {
        if bin_step_bps == 0 || bin_step_bps > MAX_BIN_STEP_BPS {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        if fee_bps > MAX_FEE_BPS || base == quote {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        // two-way bins hold plain QUOTE, so only pools without a vault offer them
        let supports_two_way = vault.is_none();
        let cfg = Config {
            admin,
            base,
            quote,
            vault,
            bin_step_bps,
            fee_bps,
            max_bins_per_swap: DEFAULT_MAX_BINS_PER_SWAP,
            supports_two_way,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        write_qs(&env, 0);
        write_active(&env, Side::Ask, &ActiveSet::empty());
        write_active(&env, Side::Bid, &ActiveSet::empty());
        extend_instance(&env);
    }

    // ------------------------------------------------------------------ LP

    /// Open a position. Ask deposits `amount` BASE, Bid deposits `amount`
    /// QUOTE, spread over bins `lo_bin..=hi_bin` by `weights` (empty = uniform,
    /// else one weight per bin). Returns the position id.
    pub fn add_position(
        env: Env,
        owner: Address,
        side: Side,
        mode: Mode,
        lo_bin: i32,
        hi_bin: i32,
        amount: i128,
        weights: Vec<u32>,
    ) -> u64 {
        owner.require_auth();
        if lo_bin > hi_bin || lo_bin < MIN_BIN || hi_bin > MAX_BIN {
            panic_with_error!(&env, Error::InvalidRange);
        }
        let n = (hi_bin - lo_bin + 1) as u32;
        if n > MAX_POSITION_BINS {
            panic_with_error!(&env, Error::InvalidRange);
        }
        check_amount(&env, amount);
        extend_instance(&env);
        let cfg = config(&env);
        if mode == Mode::TwoWay && cfg.vault.is_some() {
            // two-way bins hold plain QUOTE: a vault-backed pool is directional only
            panic_with_error!(&env, Error::NotImplemented);
        }

        let mut amounts = [0i128; MAX_POSITION_BINS as usize];
        split_amount(&env, amount, n, &weights, &mut amounts);
        let mut i = 0;
        while i < n as usize {
            if amounts[i] != 0 && amounts[i] < MIN_BIN_DEPOSIT {
                panic_with_error!(&env, Error::AmountTooSmall);
            }
            i += 1;
        }

        let mut owned = read_owner(&env, &owner);
        if owned.len() >= MAX_OWNER_POSITIONS {
            panic_with_error!(&env, Error::TooManyPositions);
        }

        // pull the deposit; a vaulted Bid is invested in one batched deposit
        let this = env.current_contract_address();
        let asset = if side == Side::Ask { &cfg.base } else { &cfg.quote };
        token::TokenClient::new(&env, asset).transfer(&owner, &this, &amount);
        let total_units = match (&cfg.vault, side) {
            (Some(vault), Side::Bid) => vault_deposit(&env, &cfg, vault, amount),
            _ => amount,
        };

        let entries = if mode == Mode::TwoWay {
            deposit_two_way(&env, &cfg, side, lo_bin, n, &amounts)
        } else {
            deposit_directional(&env, &cfg, side, lo_bin, n, &amounts, amount, total_units)
        };

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        write_pos(
            &env,
            &PosRec {
                id,
                owner: owner.clone(),
                side,
                mode,
                lo_bin,
                hi_bin,
                deposited: amount,
                entries,
            },
        );
        owned.push_back(id);
        write_owner(&env, &owner, &owned);

        PositionAdded {
            owner,
            id,
            side,
            lo_bin,
            hi_bin,
            amount,
        }
        .publish(&env);
        id
    }

    /// Pay the position's pending proceeds and fees and keep it open.
    pub fn claim(env: Env, owner: Address, id: u64) -> PositionPayout {
        owner.require_auth();
        extend_instance(&env);
        let cfg = config(&env);
        let mut pos = read_pos(&env, id);
        if pos.owner != owner {
            panic_with_error!(&env, Error::NotOwner);
        }

        let mut base_out: i128 = 0;
        let mut quote_units: i128 = 0;
        let mut entries: Vec<PosEntry> = Vec::new(&env);
        for e in pos.entries.iter() {
            if pos.mode == Mode::TwoWay {
                // a two-way position's proceeds stay in the bin reserves: only fees are claimable
                let t = read_tw(&env, e.bin)
                    .unwrap_or_else(|| panic_with_error!(&env, Error::NoSuchPosition));
                quote_units += accrued(&env, e.shares, t.acc_f, e.ckpt_f);
                entries.push_back(PosEntry {
                    ckpt_f: t.acc_f,
                    ..e
                });
                continue;
            }
            let rec = read_bin(&env, pos.side, e.bin)
                .unwrap_or_else(|| panic_with_error!(&env, Error::NoSuchPosition));
            let (_, ap, af) = entry_accs(&env, pos.side, &e, &rec);
            let dp = accrued(&env, e.shares, ap, e.ckpt_p);
            let df = accrued(&env, e.shares, af, e.ckpt_f);
            match pos.side {
                Side::Ask => quote_units += dp + df,
                Side::Bid => {
                    base_out += dp;
                    quote_units += df;
                }
            }
            entries.push_back(PosEntry {
                ckpt_p: ap,
                ckpt_f: af,
                ..e
            });
        }
        pos.entries = entries;
        write_pos(&env, &pos);

        pay_base(&env, &cfg, &owner, base_out);
        let quote_out = pay_quote(&env, &cfg, &owner, quote_units);
        if base_out > 0 || quote_out > 0 {
            Claimed {
                owner,
                id,
                base: base_out,
                quote: quote_out,
            }
            .publish(&env);
        }
        PositionPayout {
            base: base_out,
            quote: quote_out,
        }
    }

    /// Close the position: pay the unfilled inventory plus pending proceeds
    /// and fees, exactly once.
    pub fn remove_position(env: Env, owner: Address, id: u64) -> PositionPayout {
        owner.require_auth();
        extend_instance(&env);
        let cfg = config(&env);
        let pos = read_pos(&env, id);
        if pos.owner != owner {
            panic_with_error!(&env, Error::NotOwner);
        }

        let mut set = read_active(&env, pos.side);
        let mut base_out: i128 = 0;
        let mut quote_units: i128 = 0;
        if pos.mode == Mode::TwoWay {
            let (b, q) = withdraw_two_way(&env, &pos);
            base_out = b;
            quote_units = q;
        }
        for e in pos.entries.iter() {
            if pos.mode == Mode::TwoWay {
                break;
            }
            let mut rec = read_bin(&env, pos.side, e.bin)
                .unwrap_or_else(|| panic_with_error!(&env, Error::NoSuchPosition));
            let (_, ap, af) = entry_accs(&env, pos.side, &e, &rec);
            let dp = accrued(&env, e.shares, ap, e.ckpt_p);
            let df = accrued(&env, e.shares, af, e.ckpt_f);
            let inv = entry_inventory(&e, &rec, &env);
            match pos.side {
                Side::Ask => {
                    base_out += inv;
                    quote_units += dp + df;
                }
                Side::Bid => {
                    base_out += dp;
                    quote_units += inv + df;
                }
            }
            if e.gen == rec.gen {
                rec.inventory -= inv;
                rec.total_shares -= e.shares;
                // the leaver's share is rounded down, so a Bid bin can keep a few
                // stroops that no sell can fill but that still count against
                // `max_bins_per_swap` (and make new deposits fail with BinDust):
                // credit them to the remaining LPs as fee, exactly as the fill sweep
                // does (units, per share scaled by ACC_SCALE, floor), and let the bin
                // leave the book (its next deposit starts a new generation)
                if pos.side == Side::Bid
                    && rec.total_shares > 0
                    && rec.inventory > 0
                    && rec.inventory < MIN_BIN_DEPOSIT
                {
                    rec.acc_f += mul_div(&env, rec.inventory, ACC_SCALE, rec.total_shares, false);
                    rec.inventory = 0;
                }
                write_bin(&env, pos.side, e.bin, &rec);
                if rec.inventory == 0 {
                    set.remove(e.bin);
                }
            }
        }
        if pos.mode != Mode::TwoWay {
            write_active(&env, pos.side, &set);
        }

        env.storage().persistent().remove(&DataKey::Position(id));
        let owned = read_owner(&env, &owner);
        let mut kept: Vec<u64> = Vec::new(&env);
        for pid in owned.iter() {
            if pid != id {
                kept.push_back(pid);
            }
        }
        write_owner(&env, &owner, &kept);

        pay_base(&env, &cfg, &owner, base_out);
        let quote_out = pay_quote(&env, &cfg, &owner, quote_units);
        PositionRemoved {
            owner,
            id,
            base: base_out,
            quote: quote_out,
        }
        .publish(&env);
        PositionPayout {
            base: base_out,
            quote: quote_out,
        }
    }

    // --------------------------------------------------------------- taker

    /// Read-only: what `swap` would do right now. Never reverts for lack of
    /// liquidity (returns `amount_out = 0`, `partial = true`).
    pub fn quote_swap(env: Env, buy_base: bool, amount_in: i128) -> SwapQuote {
        check_amount(&env, amount_in);
        let cfg = config(&env);
        let side = if buy_base { Side::Ask } else { Side::Bid };
        let set = read_active(&env, side);
        let set_tw = read_active_tw(&env, side);
        let rate = if buy_base || set.is_empty() {
            Rate::identity()
        } else {
            quote_rate(&env, &cfg)
        };
        let mut w = Walk::new();
        plan(&env, &cfg, buy_base, amount_in, rate, &set, &set_tw, &mut w);
        let avg_price = if w.out <= 0 || w.spent <= 0 {
            0
        } else if buy_base {
            mul_div(&env, w.spent, PRICE_SCALE, w.out, false)
        } else {
            mul_div(&env, w.out, PRICE_SCALE, w.spent, false)
        };
        SwapQuote {
            amount_out: w.out,
            fee: w.fee,
            avg_price,
            bins_crossed: w.n as u32,
            partial: w.partial || w.out <= 0,
        }
    }

    /// Swap against the pool. `buy_base`: pay QUOTE, receive BASE (walks Ask
    /// bins from the cheapest price up). Otherwise pay BASE, receive QUOTE
    /// (walks Bid bins from the highest price down). `amount_in` is the
    /// maximum input (fee included); only what is needed is pulled. Reverts
    /// with `SlippageExceeded` if the output is below `min_out`. Returns the
    /// output amount.
    pub fn swap(env: Env, taker: Address, buy_base: bool, amount_in: i128, min_out: i128) -> i128 {
        taker.require_auth();
        extend_instance(&env);
        check_amount(&env, amount_in);
        let cfg = config(&env);
        let this = env.current_contract_address();
        let side = if buy_base { Side::Ask } else { Side::Bid };
        let set = read_active(&env, side);
        let tw_ask = read_active_tw(&env, Side::Ask);
        let tw_bid = read_active_tw(&env, Side::Bid);
        let rate = if buy_base || set.is_empty() {
            Rate::identity()
        } else {
            quote_rate(&env, &cfg)
        };

        let mut w = Walk::new();
        {
            let set_tw = if buy_base { &tw_ask } else { &tw_bid };
            plan(&env, &cfg, buy_base, amount_in, rate, &set, set_tw, &mut w);
        }
        if w.out <= 0 {
            panic_with_error!(&env, Error::NoLiquidity);
        }
        if w.out < min_out {
            panic_with_error!(&env, Error::SlippageExceeded);
        }

        let base = token::TokenClient::new(&env, &cfg.base);
        let quote = token::TokenClient::new(&env, &cfg.quote);
        if buy_base {
            quote.transfer(&taker, &this, &w.spent);
            let units = match &cfg.vault {
                Some(vault) => vault_deposit(&env, &cfg, vault, w.spent),
                None => w.spent,
            };
            credit_ask_fills(&env, &mut w, units);
            commit(&env, side, &w, set, tw_ask, tw_bid);
            base.transfer(&this, &taker, &w.out);
        } else {
            base.transfer(&taker, &this, &w.spent);
            if let Some(vault) = &cfg.vault {
                let got = vault_withdraw(&env, vault, w.withdraw_units);
                if got < w.out {
                    panic_with_error!(&env, Error::VaultShortfall);
                }
            }
            commit(&env, side, &w, set, tw_ask, tw_bid);
            quote.transfer(&this, &taker, &w.out);
        }

        Swapped {
            taker,
            buy_base,
            amount_in: w.spent,
            amount_out: w.out,
            fee: w.fee,
            bins_crossed: w.n as u32,
            last_bin: w.fills[w.n - 1].bin,
        }
        .publish(&env);
        w.out
    }

    // --------------------------------------------------------------- admin

    /// Admin only: change how many bins one swap may visit
    /// (1..=`HARD_MAX_BINS_PER_SWAP`).
    pub fn set_max_bins_per_swap(env: Env, max_bins: u32) {
        let mut cfg = config(&env);
        cfg.admin.require_auth();
        if max_bins == 0 || max_bins > HARD_MAX_BINS_PER_SWAP {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        extend_instance(&env);
        cfg.max_bins_per_swap = max_bins;
        env.storage().instance().set(&DataKey::Config, &cfg);
    }

    // --------------------------------------------------------------- views

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn abi_version(_env: Env) -> u32 {
        ABI_VERSION
    }

    pub fn price_at(env: Env, bin: i32) -> i128 {
        let cfg = config(&env);
        price_at_fp(&env, cfg.bin_step_bps, bin)
    }

    pub fn positions_of(env: Env, owner: Address) -> Vec<u64> {
        read_owner(&env, &owner)
    }

    pub fn get_position(env: Env, id: u64) -> Position {
        let cfg = config(&env);
        let pos = read_pos(&env, id);
        if pos.mode == Mode::TwoWay {
            // two-way position: `inventory` is the BASE it holds right now, `pending_proceeds`
            // the QUOTE it holds right now (both are only withdrawable through
            // `remove_position`), `pending_fees` the claimable fees, `filled` its share of the
            // BASE traded through its bins
            let (mut x_pos, mut y_pos, mut fees, mut filled) = (0i128, 0i128, 0i128, 0i128);
            for e in pos.entries.iter() {
                if let Some(t) = read_tw(&env, e.bin) {
                    let (x, y) = tw_slice(&env, &t, e.shares);
                    x_pos += x;
                    y_pos += y;
                    fees += accrued(&env, e.shares, t.acc_f, e.ckpt_f);
                    filled += accrued(&env, e.shares, t.acc_x, e.ckpt_x);
                }
            }
            return Position {
                id: pos.id,
                owner: pos.owner,
                side: pos.side,
                mode: pos.mode,
                lo_bin: pos.lo_bin,
                hi_bin: pos.hi_bin,
                deposited: pos.deposited,
                inventory: x_pos,
                filled,
                pending_proceeds: y_pos,
                pending_fees: fees,
                vaulted: false,
            };
        }
        let rate = quote_rate(&env, &cfg);
        let mut inv: i128 = 0;
        let mut filled: i128 = 0;
        let mut proceeds: i128 = 0;
        let mut fees: i128 = 0;
        for e in pos.entries.iter() {
            let rec = match read_bin(&env, pos.side, e.bin) {
                Some(r) => r,
                None => continue,
            };
            let (ax, ap, af) = entry_accs(&env, pos.side, &e, &rec);
            inv += entry_inventory(&e, &rec, &env);
            filled += accrued(&env, e.shares, ax, e.ckpt_x);
            proceeds += accrued(&env, e.shares, ap, e.ckpt_p);
            fees += accrued(&env, e.shares, af, e.ckpt_f);
        }
        let (inventory, pending_proceeds) = match pos.side {
            Side::Ask => (inv, rate.assets_floor(&env, proceeds)),
            Side::Bid => (rate.assets_floor(&env, inv), proceeds),
        };
        Position {
            id: pos.id,
            owner: pos.owner,
            side: pos.side,
            mode: pos.mode,
            lo_bin: pos.lo_bin,
            hi_bin: pos.hi_bin,
            deposited: pos.deposited,
            inventory,
            filled,
            pending_proceeds,
            pending_fees: rate.assets_floor(&env, fees),
            vaulted: cfg.vault.is_some(),
        }
    }

    pub fn get_bin(env: Env, side: Side, bin: i32) -> BinView {
        let cfg = config(&env);
        if !(MIN_BIN..=MAX_BIN).contains(&bin) {
            panic_with_error!(&env, Error::InvalidRange);
        }
        let rate = if side == Side::Bid {
            quote_rate(&env, &cfg)
        } else {
            Rate::identity()
        };
        let rec = read_bin(&env, side, bin).unwrap_or_else(|| new_bin(&env, &cfg, bin));
        let mut view = bin_view(&env, side, bin, &rec, rate);
        if let Some(t) = read_tw(&env, bin) {
            // two-way liquidity at this price is offered on both sides
            view.inventory += if side == Side::Ask { t.x } else { t.y };
        }
        view
    }

    /// Non-empty bins of `side` in `from_bin..=to_bin`, ascending by bin
    /// (at most `MAX_DEPTH_BINS` entries, lowest bins first). Two-way liquidity
    /// at a price is added to `inventory` (BASE for Ask, QUOTE for Bid);
    /// `total_shares` and `filled` are those of the directional bin.
    pub fn depth(env: Env, side: Side, from_bin: i32, to_bin: i32) -> Vec<BinView> {
        let cfg = config(&env);
        let set = read_active(&env, side);
        let set_tw = read_active_tw(&env, side);
        let rate = if side == Side::Bid && !set.is_empty() {
            quote_rate(&env, &cfg)
        } else {
            Rate::identity()
        };
        let mut out: Vec<BinView> = Vec::new(&env);
        let mut next = next_up2(&set, &set_tw, from_bin.max(MIN_BIN));
        while let Some(bin) = next {
            if bin > to_bin || out.len() >= MAX_DEPTH_BINS {
                break;
            }
            let mut view = match read_bin(&env, side, bin) {
                Some(rec) => bin_view(&env, side, bin, &rec, rate),
                None => BinView {
                    side,
                    bin,
                    price: price_at_fp(&env, cfg.bin_step_bps, bin),
                    inventory: 0,
                    total_shares: 0,
                    filled: 0,
                },
            };
            if set_tw.contains(bin) {
                if let Some(t) = read_tw(&env, bin) {
                    view.inventory += if side == Side::Ask { t.x } else { t.y };
                }
            }
            if view.inventory > 0 {
                out.push_back(view);
            }
            next = next_up2(&set, &set_tw, bin + 1);
        }
        out
    }

    pub fn tvl(env: Env) -> Tvl {
        let cfg = config(&env);
        let this = env.current_contract_address();
        let base = token::TokenClient::new(&env, &cfg.base).balance(&this);
        let idle_quote = token::TokenClient::new(&env, &cfg.quote).balance(&this);
        let qs = read_qs(&env);
        let vaulted = if qs > 0 {
            quote_rate(&env, &cfg).assets_floor(&env, qs)
        } else {
            0
        };
        Tvl {
            base,
            quote_value: idle_quote + vaulted,
            vault_shares: qs,
        }
    }
}

fn bin_view(env: &Env, side: Side, bin: i32, rec: &BinRec, rate: Rate) -> BinView {
    let inventory = match side {
        Side::Ask => rec.inventory,
        Side::Bid => rate.assets_floor(env, rec.inventory),
    };
    BinView {
        side,
        bin,
        price: rec.price,
        inventory,
        total_shares: rec.total_shares,
        filled: rec.filled,
    }
}
