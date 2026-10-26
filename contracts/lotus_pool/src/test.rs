#![cfg(test)]
//! Unit tests of the Lotus pool (host side, mock vault, no network).

extern crate std;

use super::*;
use crate::math::price_at_fp;
use crate::test_vault::{TestVault, TestVaultClient};
use mock_vault::{MockVault, MockVaultClient};
use soroban_sdk::testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{vec, Address, Env, Event as _, IntoVal, Vec};
use std::vec::Vec as StdVec;

/// 7 decimals, like every classic Stellar asset.
const ONE: i128 = 10_000_000;

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Fx<'a> {
    env: Env,
    admin: Address,
    base: Address,
    quote: Address,
    vault: Option<Address>,
    pool: Address,
    c: LotusPoolClient<'a>,
}

fn setup_with<'a>(step: u32, fee: u32, with_vault: bool) -> Fx<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let base = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let quote = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let vault = if with_vault {
        Some(env.register(MockVault, (admin.clone(), quote.clone())))
    } else {
        None
    };
    let pool = env.register(
        LotusPool,
        (
            admin.clone(),
            base.clone(),
            quote.clone(),
            vault.clone(),
            step,
            fee,
        ),
    );
    let c = LotusPoolClient::new(&env, &pool);
    Fx {
        env,
        admin,
        base,
        quote,
        vault,
        pool,
        c,
    }
}

fn setup<'a>() -> Fx<'a> {
    setup_with(10, 10, false)
}

/// Pool backed by the private `TestVault` (call counters, failure knobs).
fn setup_test_vault<'a>() -> Fx<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let base = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let quote = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let vault = Some(env.register(TestVault, (admin.clone(), quote.clone())));
    let pool = env.register(
        LotusPool,
        (admin.clone(), base.clone(), quote.clone(), vault.clone(), 10u32, 10u32),
    );
    let c = LotusPoolClient::new(&env, &pool);
    Fx {
        env,
        admin,
        base,
        quote,
        vault,
        pool,
        c,
    }
}

impl<'a> Fx<'a> {
    fn user(&self) -> Address {
        Address::generate(&self.env)
    }
    fn fund_base(&self, to: &Address, amt: i128) {
        StellarAssetClient::new(&self.env, &self.base).mint(to, &amt);
    }
    fn fund_quote(&self, to: &Address, amt: i128) {
        StellarAssetClient::new(&self.env, &self.quote).mint(to, &amt);
    }
    fn bal_base(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.base).balance(who)
    }
    fn bal_quote(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.quote).balance(who)
    }
    fn no_weights(&self) -> Vec<u32> {
        Vec::new(&self.env)
    }
    /// Ask position funded on the fly.
    fn ask(&self, owner: &Address, lo: i32, hi: i32, amount: i128) -> u64 {
        self.fund_base(owner, amount);
        self.c.add_position(
            owner,
            &Side::Ask,
            &Mode::Directional,
            &lo,
            &hi,
            &amount,
            &self.no_weights(),
        )
    }
    /// Bid position funded on the fly.
    fn bid(&self, owner: &Address, lo: i32, hi: i32, amount: i128) -> u64 {
        self.fund_quote(owner, amount);
        self.c.add_position(
            owner,
            &Side::Bid,
            &Mode::Directional,
            &lo,
            &hi,
            &amount,
            &self.no_weights(),
        )
    }
    fn price(&self, bin: i32) -> i128 {
        self.c.price_at(&bin)
    }
    fn bin_rec(&self, side: Side, bin: i32) -> BinRec {
        self.env.as_contract(&self.pool, || {
            self.env
                .storage()
                .persistent()
                .get(&DataKey::Bin(side, bin))
                .unwrap_or_default()
        })
    }
    fn qs(&self) -> i128 {
        self.env.as_contract(&self.pool, || {
            self.env
                .storage()
                .instance()
                .get(&DataKey::QuoteShares)
                .unwrap_or(0)
        })
    }
    fn active(&self, side: Side) -> ActiveSet {
        self.env.as_contract(&self.pool, || read_active(&self.env, side))
    }
    fn active_tw(&self, side: Side) -> ActiveSet {
        self.env.as_contract(&self.pool, || read_active_tw(&self.env, side))
    }
    fn tw_rec(&self, bin: i32) -> TwBin {
        self.env.as_contract(&self.pool, || read_tw(&self.env, bin).unwrap_or_default())
    }
    /// TwoWay position funded on the fly (deposit `side`: Ask = BASE, Bid = QUOTE).
    fn two_way(&self, owner: &Address, side: Side, lo: i32, hi: i32, amount: i128) -> u64 {
        match side {
            Side::Ask => self.fund_base(owner, amount),
            Side::Bid => self.fund_quote(owner, amount),
        }
        self.c.add_position(
            owner,
            &side,
            &Mode::TwoWay,
            &lo,
            &hi,
            &amount,
            &self.no_weights(),
        )
    }
}

/// QUOTE price leg for `x` BASE at `price`, rounded up (what a buyer pays).
fn q_up(x: i128, price: i128) -> i128 {
    (x * price + ONE - 1) / ONE
}
fn q_down(x: i128, price: i128) -> i128 {
    x * price / ONE
}
fn fee_up(q: i128, fee_bps: i128) -> i128 {
    (q * fee_bps + 9_999) / 10_000
}

// ---------------------------------------------------------------------------
// price grid
// ---------------------------------------------------------------------------

/// Tiny extractor for `"<step>":[a,b,c,...]` in test-vectors.json.
fn vectors_for(step: u32) -> StdVec<i128> {
    let raw = include_str!("../test-vectors.json");
    let needle = std::format!("\"{}\": [", step);
    let start = raw.find(&needle).expect("step in vectors") + needle.len();
    let end = start + raw[start..].find(']').unwrap();
    raw[start..end]
        .split(',')
        .map(|s| s.trim().parse::<i128>().unwrap())
        .collect()
}

#[test]
fn price_matches_exact_vectors() {
    let env = Env::default();
    let mut checked = 0;
    for step in [1u32, 5, 10, 20, 25, 50, 100] {
        let v = vectors_for(step);
        assert_eq!(v.len(), 401);
        for (k, expected) in v.iter().enumerate() {
            let bin = MIN_BIN + k as i32;
            assert_eq!(
                price_at_fp(&env, step, bin),
                *expected,
                "step {} bin {}",
                step,
                bin
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 7 * 401);
}

#[test]
fn price_grid_properties() {
    let f = setup();
    assert_eq!(f.price(0), PRICE_SCALE);
    assert_eq!(f.price(1), 10_010_000);
    assert_eq!(f.price(-1), 9_990_010); // 1e7 / 1.001 = 9990009.99
    let mut prev = f.price(MIN_BIN);
    for b in (MIN_BIN + 1)..=MAX_BIN {
        let p = f.price(b);
        assert!(p > prev, "strictly increasing at {}", b);
        prev = p;
    }
    // reciprocal symmetry up to 1 stroop of rounding on each side
    for b in 0..=MAX_BIN {
        let prod = f.price(b) * f.price(-b);
        let want = PRICE_SCALE * PRICE_SCALE;
        assert!(
            (prod - want).abs() <= 2 * f.price(b).max(f.price(-b)),
            "bin {}",
            b
        );
    }
    assert!(f.c.try_price_at(&201).is_err());
    assert!(f.c.try_price_at(&-201).is_err());
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

#[test]
fn config_is_stored() {
    let f = setup();
    let cfg = f.c.get_config();
    assert_eq!(cfg.admin, f.admin);
    assert_eq!(cfg.base, f.base);
    assert_eq!(cfg.quote, f.quote);
    assert_eq!(cfg.vault, None);
    assert_eq!(cfg.bin_step_bps, 10);
    assert_eq!(cfg.fee_bps, 10);
    assert_eq!(cfg.max_bins_per_swap, DEFAULT_MAX_BINS_PER_SWAP);
    assert!(cfg.supports_two_way, "an idle pool offers two-way bins");
    assert_eq!(f.c.abi_version(), ABI_VERSION);
    let tvl = f.c.tvl();
    assert_eq!((tvl.base, tvl.quote_value, tvl.vault_shares), (0, 0, 0));
}

#[test]
fn constructor_rejects_bad_parameters() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let a = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let b = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let none: Option<Address> = None;
    let deploy = |step: u32, fee: u32, base: &Address, quote: &Address| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            env.register(
                LotusPool,
                (
                    admin.clone(),
                    base.clone(),
                    quote.clone(),
                    none.clone(),
                    step,
                    fee,
                ),
            )
        }))
    };
    for (step, fee, base, quote) in [
        (0u32, 10u32, &a, &b),
        (101, 10, &a, &b),
        (10, 1_001, &a, &b),
        (10, 10, &a, &a),
    ] {
        assert!(deploy(step, fee, base, quote).is_err(), "step {} fee {}", step, fee);
    }
    // the documented bounds themselves are accepted
    for (step, fee) in [(1u32, 0u32), (100, 1_000)] {
        assert!(deploy(step, fee, &a, &b).is_ok());
    }
}

#[test]
fn only_admin_sets_max_bins() {
    let f = setup();
    f.c.set_max_bins_per_swap(&7);
    assert_eq!(f.c.get_config().max_bins_per_swap, 7);
    assert!(f.c.try_set_max_bins_per_swap(&0).is_err());
    assert!(f
        .c
        .try_set_max_bins_per_swap(&(HARD_MAX_BINS_PER_SWAP + 1))
        .is_err());
    // a stranger cannot
    let stranger = f.user();
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.pool,
            fn_name: "set_max_bins_per_swap",
            args: (9u32,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.c.try_set_max_bins_per_swap(&9).is_err());
    assert_eq!(f.c.get_config().max_bins_per_swap, 7);
}

// ---------------------------------------------------------------------------
// ask side: the basics
// ---------------------------------------------------------------------------

#[test]
fn ask_partial_fill_claim_and_remove() {
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    let id = f.ask(&maker, 0, 0, 100 * ONE);
    assert_eq!(id, 1);
    assert_eq!(f.bal_base(&maker), 0);
    assert_eq!(f.bal_base(&f.pool), 100 * ONE);
    assert_eq!(f.c.positions_of(&maker), vec![&f.env, 1u64]);

    let bv = f.c.get_bin(&Side::Ask, &0);
    assert_eq!(bv.price, PRICE_SCALE);
    assert_eq!(bv.inventory, 100 * ONE);
    assert_eq!(bv.total_shares, 100 * ONE);
    assert_eq!(bv.filled, 0);

    // 50 BASE at 1.0 + 0.1 percent fee = 50.05 USDC
    f.fund_quote(&taker, 60 * ONE);
    let quote = f.c.quote_swap(&true, &(50 * ONE + ONE / 20));
    assert_eq!(quote.amount_out, 50 * ONE);
    assert_eq!(quote.fee, ONE / 20);
    assert_eq!(quote.bins_crossed, 1);
    assert!(!quote.partial);
    assert_eq!(quote.avg_price, 10_010_000); // 1.001 incl. fee

    let out = f.c.swap(&taker, &true, &(50 * ONE + ONE / 20), &(50 * ONE));
    assert_eq!(out, 50 * ONE);
    assert_eq!(f.bal_base(&taker), 50 * ONE);
    assert_eq!(f.bal_quote(&taker), 60 * ONE - 50 * ONE - ONE / 20);
    assert_eq!(f.bal_quote(&f.pool), 50 * ONE + ONE / 20);

    let p = f.c.get_position(&id);
    assert_eq!(p.deposited, 100 * ONE);
    assert_eq!(p.inventory, 50 * ONE);
    assert_eq!(p.filled, 50 * ONE);
    assert_eq!(p.pending_proceeds, 50 * ONE);
    assert_eq!(p.pending_fees, ONE / 20);
    assert!(!p.vaulted);
    let bv = f.c.get_bin(&Side::Ask, &0);
    assert_eq!((bv.inventory, bv.filled), (50 * ONE, 50 * ONE));

    // claim pays proceeds + fees and keeps the position
    let paid = f.c.claim(&maker, &id);
    assert_eq!((paid.base, paid.quote), (0, 50 * ONE + ONE / 20));
    assert_eq!(f.bal_quote(&maker), 50 * ONE + ONE / 20);
    let p = f.c.get_position(&id);
    assert_eq!((p.pending_proceeds, p.pending_fees), (0, 0));
    assert_eq!(p.inventory, 50 * ONE);
    // a second claim pays nothing
    let again = f.c.claim(&maker, &id);
    assert_eq!((again.base, again.quote), (0, 0));

    // remove returns the unfilled half, exactly once
    let removed = f.c.remove_position(&maker, &id);
    assert_eq!((removed.base, removed.quote), (50 * ONE, 0));
    assert_eq!(f.bal_base(&maker), 50 * ONE);
    assert_eq!(f.bal_base(&f.pool), 0);
    assert_eq!(f.bal_quote(&f.pool), 0);
    assert_eq!(f.c.positions_of(&maker).len(), 0);
    assert!(f.c.try_remove_position(&maker, &id).is_err());
    assert!(f.c.try_get_position(&id).is_err());
    assert!(f.active(Side::Ask).is_empty());
}

#[test]
fn ask_swap_walks_bins_cheapest_first() {
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    f.ask(&maker, 0, 4, 100 * ONE); // 20 BASE per bin
    let depth = f.c.depth(&Side::Ask, &-10, &10);
    assert_eq!(depth.len(), 5);
    for (i, v) in depth.iter().enumerate() {
        assert_eq!(v.bin, i as i32);
        assert_eq!(v.inventory, 20 * ONE);
        assert_eq!(v.price, f.price(i as i32));
    }

    // buy 50 BASE: bins 0 and 1 in full, 10 BASE of bin 2
    let (p0, p1, p2) = (f.price(0), f.price(1), f.price(2));
    let q0 = q_up(20 * ONE, p0);
    let q1 = q_up(20 * ONE, p1);
    let q2 = q_up(10 * ONE, p2);
    let t = q0 + fee_up(q0, 10) + q1 + fee_up(q1, 10) + q2 + fee_up(q2, 10);
    f.fund_quote(&taker, t + ONE);
    let quote = f.c.quote_swap(&true, &t);
    assert_eq!(quote.amount_out, 50 * ONE);
    assert_eq!(quote.bins_crossed, 3);
    assert!(!quote.partial);
    let out = f.c.swap(&taker, &true, &t, &0);
    assert_eq!(out, 50 * ONE);
    assert_eq!(f.bal_quote(&taker), ONE, "exactly the quoted amount was pulled");
    let depth = f.c.depth(&Side::Ask, &-10, &10);
    assert_eq!(depth.len(), 3, "bins 0 and 1 are empty and leave the index");
    assert_eq!(depth.get(0).unwrap().bin, 2);
    assert_eq!(depth.get(0).unwrap().inventory, 10 * ONE);
    assert_eq!(f.c.get_bin(&Side::Ask, &0).inventory, 0);
    assert_eq!(f.c.get_bin(&Side::Ask, &0).filled, 20 * ONE);
    assert!(!f.active(Side::Ask).contains(0));
    assert!(f.active(Side::Ask).contains(2));
}

#[test]
fn swap_pulls_only_what_it_needs() {
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    f.ask(&maker, 0, 0, 10 * ONE);
    f.fund_quote(&taker, 1_000 * ONE);
    // budget for 100 BASE, only 10 exist
    let quote = f.c.quote_swap(&true, &(100 * ONE));
    assert_eq!(quote.amount_out, 10 * ONE);
    assert!(quote.partial);
    f.c.swap(&taker, &true, &(100 * ONE), &0);
    let paid = 10 * ONE + fee_up(10 * ONE, 10);
    assert_eq!(f.bal_quote(&taker), 1_000 * ONE - paid);
    assert_eq!(f.bal_base(&taker), 10 * ONE);
    // nothing left: no liquidity
    assert_eq!(f.c.quote_swap(&true, &ONE).amount_out, 0);
    assert!(f.c.quote_swap(&true, &ONE).partial);
    assert!(f.c.try_swap(&taker, &true, &ONE, &0).is_err());
}

#[test]
fn min_out_and_amount_checks() {
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    f.ask(&maker, 0, 0, 10 * ONE);
    f.fund_quote(&taker, 100 * ONE);
    let t = 10 * ONE + fee_up(10 * ONE, 10);
    assert_eq!(
        f.c.try_swap(&taker, &true, &t, &(10 * ONE + 1)),
        Err(Ok(Error::SlippageExceeded.into()))
    );
    assert_eq!(f.bal_quote(&taker), 100 * ONE, "a reverted swap pulls nothing");
    assert_eq!(
        f.c.try_swap(&taker, &true, &0, &0),
        Err(Ok(Error::InvalidAmount.into()))
    );
    assert_eq!(
        f.c.try_swap(&taker, &true, &-5, &0),
        Err(Ok(Error::InvalidAmount.into()))
    );
    assert_eq!(
        f.c.try_swap(&taker, &true, &(MAX_AMOUNT + 1), &0),
        Err(Ok(Error::InvalidAmount.into()))
    );
    assert_eq!(f.c.swap(&taker, &true, &t, &(10 * ONE)), 10 * ONE);
    // nothing to sell into: no bids
    f.fund_base(&taker, ONE);
    assert_eq!(
        f.c.try_swap(&taker, &false, &ONE, &0),
        Err(Ok(Error::NoLiquidity.into()))
    );
}

#[test]
fn max_bins_per_swap_limits_the_walk() {
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    f.ask(&maker, 0, 9, 100 * ONE); // 10 BASE per bin
    f.fund_quote(&taker, 1_000 * ONE);
    f.c.set_max_bins_per_swap(&3);
    let quote = f.c.quote_swap(&true, &(500 * ONE));
    assert_eq!(quote.bins_crossed, 3);
    assert_eq!(quote.amount_out, 30 * ONE);
    assert!(quote.partial);
    assert_eq!(f.c.swap(&taker, &true, &(500 * ONE), &0), 30 * ONE);
    assert_eq!(f.c.depth(&Side::Ask, &0, &9).len(), 7);
    // an order that fits in the cap is not partial
    let small = f.c.quote_swap(&true, &(15 * ONE));
    assert!(!small.partial);
    assert_eq!(small.bins_crossed, 2);
    // raising the cap lets the rest through
    f.c.set_max_bins_per_swap(&20);
    let rest = f.c.swap(&taker, &true, &(500 * ONE), &0);
    assert_eq!(rest, 70 * ONE);
    assert!(f.active(Side::Ask).is_empty());
}

#[test]
fn rounding_favours_the_pool() {
    // price 1.001 (bin 1): buying 1 stroop costs ceil(1.001) = 2 stroops + 1 fee stroop
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    f.ask(&maker, 1, 1, 10 * ONE);
    f.fund_quote(&taker, 100);
    let quote = f.c.quote_swap(&true, &3);
    assert_eq!(quote.amount_out, 1, "3 stroops buy exactly 1 stroop of BASE");
    f.c.swap(&taker, &true, &3, &1);
    assert_eq!(f.bal_quote(&taker), 97);
    assert_eq!(f.bal_base(&taker), 1);
    // 2 stroops cannot buy anything (price leg 2 + fee 1)
    assert_eq!(f.c.quote_swap(&true, &2).amount_out, 0);
    // a bigger odd order: the buyer never pays less than price * quantity
    let before = f.bal_quote(&taker);
    f.fund_quote(&taker, 1_000_000);
    let out = f.c.swap(&taker, &true, &1_000_001, &0);
    let paid = before + 1_000_000 - f.bal_quote(&taker);
    let exact_price_leg = out * f.price(1); // scaled by 1e7
    assert!(paid * ONE >= exact_price_leg, "taker paid at least price * qty");
    assert!(paid <= 1_000_001);
}

#[test]
fn multiple_positions_share_a_bin_pro_rata() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    let ida = f.ask(&a, 0, 0, 100 * ONE);
    let idb = f.ask(&b, 0, 0, 300 * ONE);
    assert_eq!(f.c.get_bin(&Side::Ask, &0).total_shares, 400 * ONE);
    f.fund_quote(&taker, 1_000 * ONE);
    // buy 100 BASE: A sells 25, B sells 75
    let t = 100 * ONE + fee_up(100 * ONE, 10);
    f.c.swap(&taker, &true, &t, &0);
    let (pa, pb) = (f.c.get_position(&ida), f.c.get_position(&idb));
    assert_eq!((pa.filled, pa.inventory), (25 * ONE, 75 * ONE));
    assert_eq!((pb.filled, pb.inventory), (75 * ONE, 225 * ONE));
    assert_eq!(pa.pending_proceeds, 25 * ONE);
    assert_eq!(pb.pending_proceeds, 75 * ONE);
    assert_eq!(pa.pending_fees, fee_up(100 * ONE, 10) / 4);
    assert_eq!(pb.pending_fees, fee_up(100 * ONE, 10) * 3 / 4);
}

#[test]
fn late_depositor_does_not_steal_earlier_proceeds() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    let ida = f.ask(&a, 0, 0, 100 * ONE);
    f.fund_quote(&taker, 1_000 * ONE);
    // 40 BASE sold to A's bin alone
    f.c.swap(&taker, &true, &(40 * ONE + fee_up(40 * ONE, 10)), &0);
    assert_eq!(f.c.get_position(&ida).pending_proceeds, 40 * ONE);

    // B joins the partly filled bin with 100 BASE: A holds 60 BASE of inventory
    let idb = f.ask(&b, 0, 0, 100 * ONE);
    let pb = f.c.get_position(&idb);
    assert_eq!(pb.pending_proceeds, 0, "nothing earlier belongs to B");
    assert_eq!(pb.pending_fees, 0);
    assert!(pb.inventory <= 100 * ONE && pb.inventory >= 100 * ONE - 1, "{}", pb.inventory);
    let pa = f.c.get_position(&ida);
    assert_eq!(pa.pending_proceeds, 40 * ONE);
    assert_eq!(pa.inventory, 60 * ONE);
    let bv = f.c.get_bin(&Side::Ask, &0);
    assert_eq!(bv.inventory, 160 * ONE);

    // 80 more BASE: split 60:100 between A and B
    f.c.swap(&taker, &true, &(80 * ONE + fee_up(80 * ONE, 10)), &0);
    let pa = f.c.get_position(&ida);
    let pb = f.c.get_position(&idb);
    // A: 40 + 30, B: 50 (+/- a few stroops of rounding, never more than owed)
    assert!((pa.pending_proceeds - 70 * ONE).abs() <= 3, "{}", pa.pending_proceeds);
    assert!((pb.pending_proceeds - 50 * ONE).abs() <= 3, "{}", pb.pending_proceeds);
    assert!(pa.pending_proceeds + pb.pending_proceeds <= 120 * ONE);
    assert_eq!(pa.filled + pb.filled <= 120 * ONE, true);
    assert!((pa.inventory - 30 * ONE).abs() <= 3);
    assert!((pb.inventory - 50 * ONE).abs() <= 3);
}

#[test]
fn claim_then_remove_pays_exactly_once() {
    let f = setup();
    let (a, taker) = (f.user(), f.user());
    let id = f.ask(&a, 0, 2, 90 * ONE);
    f.fund_quote(&taker, 1_000 * ONE);
    f.c.swap(&taker, &true, &(50 * ONE), &0);
    let pending = f.c.get_position(&id);
    let claimed = f.c.claim(&a, &id);
    assert_eq!(claimed.base, 0);
    assert_eq!(claimed.quote, pending.pending_proceeds + pending.pending_fees);
    let removed = f.c.remove_position(&a, &id);
    assert_eq!(removed.quote, 0, "already claimed");
    assert_eq!(removed.base, pending.inventory);
    // everything the maker ever received matches what the pool took in
    let got_quote = f.bal_quote(&a);
    assert_eq!(got_quote, claimed.quote);
    assert_eq!(f.bal_base(&a), removed.base);
    // dust only
    assert!(f.bal_quote(&f.pool) <= 3, "{}", f.bal_quote(&f.pool));
    assert!(f.bal_base(&f.pool) <= 3);
    // the same id is gone
    assert!(f.c.try_claim(&a, &id).is_err());
}

#[test]
fn remove_without_claim_pays_everything() {
    let f = setup();
    let (a, taker) = (f.user(), f.user());
    let id = f.ask(&a, 0, 1, 20 * ONE);
    f.fund_quote(&taker, 100 * ONE);
    f.c.swap(&taker, &true, &(12 * ONE), &0);
    let p = f.c.get_position(&id);
    let removed = f.c.remove_position(&a, &id);
    assert_eq!(removed.base, p.inventory);
    assert_eq!(removed.quote, p.pending_proceeds + p.pending_fees);
    assert_eq!(f.bal_base(&a), p.inventory);
    assert_eq!(f.bal_quote(&a), p.pending_proceeds + p.pending_fees);
}

#[test]
fn position_with_weights() {
    let f = setup();
    let a = f.user();
    f.fund_base(&a, 100 * ONE);
    let id = f.c.add_position(
        &a,
        &Side::Ask,
        &Mode::Directional,
        &0,
        &3,
        &(100 * ONE),
        &vec![&f.env, 1u32, 2, 0, 7],
    );
    let d = f.c.depth(&Side::Ask, &0, &3);
    assert_eq!(d.len(), 3, "the zero-weight bin stays empty");
    assert_eq!(d.get(0).unwrap().inventory, 10 * ONE);
    assert_eq!(d.get(1).unwrap().inventory, 20 * ONE);
    assert_eq!(d.get(2).unwrap().bin, 3);
    assert_eq!(d.get(2).unwrap().inventory, 70 * ONE);
    assert_eq!(f.c.get_position(&id).inventory, 100 * ONE);
    // the rounding remainder goes to the last weighted bin
    let b = f.user();
    f.fund_base(&b, 100 * ONE + 1);
    f.c.add_position(
        &b,
        &Side::Ask,
        &Mode::Directional,
        &10,
        &12,
        &(100 * ONE + 1),
        &f.no_weights(),
    );
    let d = f.c.depth(&Side::Ask, &10, &12);
    let total: i128 = d.iter().map(|v| v.inventory).sum();
    assert_eq!(total, 100 * ONE + 1);
    // 1_000_000_001 / 3 = 333_333_333 remainder 2, which lands on the last bin
    assert_eq!(d.get(2).unwrap().inventory, d.get(0).unwrap().inventory + 2);
}

#[test]
fn add_position_validates_input() {
    let f = setup();
    let a = f.user();
    f.fund_base(&a, 1_000 * ONE);
    let w = f.no_weights();
    let add = |lo: i32, hi: i32, amt: i128, w: &Vec<u32>| {
        f.c.try_add_position(&a, &Side::Ask, &Mode::Directional, &lo, &hi, &amt, w)
    };
    assert_eq!(add(3, 2, ONE, &w), Err(Ok(Error::InvalidRange.into())));
    assert_eq!(add(-201, 0, ONE, &w), Err(Ok(Error::InvalidRange.into())));
    assert_eq!(add(0, 201, ONE, &w), Err(Ok(Error::InvalidRange.into())));
    assert_eq!(add(0, 64, ONE, &w), Err(Ok(Error::InvalidRange.into())));
    assert_eq!(add(0, 0, 0, &w), Err(Ok(Error::InvalidAmount.into())));
    assert_eq!(add(0, 0, -1, &w), Err(Ok(Error::InvalidAmount.into())));
    assert_eq!(
        add(0, 0, MAX_AMOUNT + 1, &w),
        Err(Ok(Error::InvalidAmount.into()))
    );
    assert_eq!(
        add(0, 0, MIN_BIN_DEPOSIT - 1, &w),
        Err(Ok(Error::AmountTooSmall.into()))
    );
    assert_eq!(
        add(0, 1, ONE, &vec![&f.env, 1u32]),
        Err(Ok(Error::InvalidWeights.into()))
    );
    assert_eq!(
        add(0, 1, ONE, &vec![&f.env, 0u32, 0]),
        Err(Ok(Error::InvalidWeights.into()))
    );
    // 64 bins is the maximum
    assert!(add(-32, 31, 64 * ONE, &w).is_ok());
    // a failed call leaves no trace
    assert_eq!(f.bal_base(&a), 1_000 * ONE - 64 * ONE);
}

#[test]
fn exhausted_bin_is_reused_in_a_new_generation() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    let ida = f.ask(&a, 0, 0, 10 * ONE);
    f.fund_quote(&taker, 1_000 * ONE);
    f.c.swap(&taker, &true, &(10 * ONE + fee_up(10 * ONE, 10)), &0);
    assert!(f.active(Side::Ask).is_empty());
    let rec = f.bin_rec(Side::Ask, 0);
    assert_eq!((rec.inventory, rec.gen), (0, 0));
    assert_eq!(rec.total_shares, 10 * ONE, "shares stay until the LP leaves");

    // B reuses the bin: A's generation is sealed and B starts from scratch
    let idb = f.ask(&b, 0, 0, 20 * ONE);
    let rec = f.bin_rec(Side::Ask, 0);
    assert_eq!((rec.gen, rec.total_shares, rec.inventory), (1, 20 * ONE, 20 * ONE));
    assert_eq!(rec.acc_p, 0);
    assert!(f.active(Side::Ask).contains(0));
    // A still sees exactly what it earned, B sees nothing
    let pa = f.c.get_position(&ida);
    assert_eq!(pa.pending_proceeds, 10 * ONE);
    assert_eq!(pa.inventory, 0);
    assert_eq!(pa.filled, 10 * ONE);
    let pb = f.c.get_position(&idb);
    assert_eq!((pb.pending_proceeds, pb.pending_fees, pb.filled), (0, 0, 0));

    // sell 5 of B's BASE; A's claim is unaffected
    f.c.swap(&taker, &true, &(5 * ONE + fee_up(5 * ONE, 10)), &0);
    assert_eq!(f.c.get_position(&ida).pending_proceeds, 10 * ONE);
    assert_eq!(f.c.get_position(&idb).pending_proceeds, 5 * ONE);
    // A leaves from the sealed generation without touching B's inventory
    let ra = f.c.remove_position(&a, &ida);
    assert_eq!(ra.base, 0);
    assert_eq!(ra.quote, 10 * ONE + fee_up(10 * ONE, 10));
    let rec = f.bin_rec(Side::Ask, 0);
    assert_eq!((rec.inventory, rec.total_shares), (15 * ONE, 20 * ONE));
    // B can still remove its 15 remaining BASE
    let rb = f.c.remove_position(&b, &idb);
    assert_eq!(rb.base, 15 * ONE);
    assert_eq!(rb.quote, 5 * ONE + fee_up(5 * ONE, 10));
}

#[test]
fn nearly_filled_bin_refuses_deposits_that_would_dilute_shares() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    f.ask(&a, 0, 0, 100 * ONE);
    f.fund_quote(&taker, 1_000 * ONE);
    // leave 999 stroops: inventory * 1e6 < total_shares (1e9)
    let x = 100 * ONE - 999;
    f.c.swap(&taker, &true, &(x + fee_up(x, 10)), &0);
    assert_eq!(f.bin_rec(Side::Ask, 0).inventory, 999);
    f.fund_base(&b, 10 * ONE);
    assert_eq!(
        f.c.try_add_position(
            &b,
            &Side::Ask,
            &Mode::Directional,
            &0,
            &0,
            &ONE,
            &f.no_weights()
        ),
        Err(Ok(Error::BinDust.into()))
    );
    // anyone can clear the dust, after which the bin is reusable
    f.c.swap(&taker, &true, &1_000, &0);
    assert_eq!(f.bin_rec(Side::Ask, 0).inventory, 0);
    f.c.add_position(
        &b,
        &Side::Ask,
        &Mode::Directional,
        &0,
        &0,
        &ONE,
        &f.no_weights(),
    );
}

// ---------------------------------------------------------------------------
// bid side (mirror)
// ---------------------------------------------------------------------------

#[test]
fn bid_partial_fill_claim_and_remove() {
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    let id = f.bid(&maker, 0, 0, 100 * ONE); // 100 USDC bid at 1.0
    assert_eq!(f.bal_quote(&f.pool), 100 * ONE);
    let bv = f.c.get_bin(&Side::Bid, &0);
    assert_eq!((bv.inventory, bv.total_shares, bv.price), (100 * ONE, 100 * ONE, ONE));

    // sell 50 BASE: gross 50 USDC, fee 0.05 USDC, taker receives 49.95
    f.fund_base(&taker, 60 * ONE);
    let quote = f.c.quote_swap(&false, &(50 * ONE));
    assert_eq!(quote.amount_out, 50 * ONE - ONE / 20);
    assert_eq!(quote.fee, ONE / 20);
    assert_eq!(quote.avg_price, 9_990_000); // 0.999
    assert!(!quote.partial);
    let out = f.c.swap(&taker, &false, &(50 * ONE), &(49 * ONE));
    assert_eq!(out, 50 * ONE - ONE / 20);
    assert_eq!(f.bal_quote(&taker), 50 * ONE - ONE / 20);
    assert_eq!(f.bal_base(&taker), 10 * ONE);
    assert_eq!(f.bal_base(&f.pool), 50 * ONE);
    assert_eq!(f.bal_quote(&f.pool), 50 * ONE + ONE / 20);

    let p = f.c.get_position(&id);
    assert_eq!(p.inventory, 50 * ONE, "50 USDC still bid");
    assert_eq!(p.filled, 50 * ONE, "50 USDC of the bid was used");
    assert_eq!(p.pending_proceeds, 50 * ONE, "BASE bought");
    assert_eq!(p.pending_fees, ONE / 20);
    assert_eq!(p.deposited, 100 * ONE);

    let paid = f.c.claim(&maker, &id);
    assert_eq!((paid.base, paid.quote), (50 * ONE, ONE / 20));
    assert_eq!(f.bal_base(&maker), 50 * ONE);
    assert_eq!(f.bal_quote(&maker), ONE / 20);
    let removed = f.c.remove_position(&maker, &id);
    assert_eq!((removed.base, removed.quote), (0, 50 * ONE));
    assert_eq!(f.bal_quote(&maker), 50 * ONE + ONE / 20);
    assert_eq!(f.bal_quote(&f.pool), 0);
    assert_eq!(f.bal_base(&f.pool), 0);
    assert!(f.active(Side::Bid).is_empty());
}

#[test]
fn bid_swap_walks_bins_highest_price_first() {
    let f = setup();
    let maker = f.user();
    let taker = f.user();
    f.bid(&maker, -4, 0, 100 * ONE); // 20 USDC per bin, bin 0 is the highest price
    let depth = f.c.depth(&Side::Bid, &-10, &10);
    assert_eq!(depth.len(), 5);
    assert_eq!(depth.get(0).unwrap().bin, -4);
    // sell BASE worth ~50 USDC: bin 0 (20), bin -1 (20), part of bin -2
    f.fund_base(&taker, 100 * ONE);
    let q = f.c.quote_swap(&false, &(50 * ONE));
    assert_eq!(q.bins_crossed, 3);
    assert!(!q.partial);
    let out = f.c.swap(&taker, &false, &(50 * ONE), &0);
    assert_eq!(out, q.amount_out);
    assert_eq!(f.bal_base(&taker), 50 * ONE);
    // the highest bins were consumed first
    assert_eq!(f.c.get_bin(&Side::Bid, &0).inventory, 0);
    assert_eq!(f.c.get_bin(&Side::Bid, &-1).inventory, 0);
    assert!(f.c.get_bin(&Side::Bid, &-2).inventory > 0);
    assert_eq!(f.c.get_bin(&Side::Bid, &-4).inventory, 20 * ONE);
    assert!(f.active(Side::Bid).contains(-2) && !f.active(Side::Bid).contains(-1));
    // out is the price leg minus fee; each bin priced as price_at
    let q0 = q_down(20 * ONE, f.price(0));
    assert!(out < 50 * ONE && out > 49 * ONE, "{}", out);
    assert!(q0 <= 20 * ONE);
}

#[test]
fn bid_late_depositor_and_generation() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    let ida = f.bid(&a, 0, 0, 100 * ONE);
    f.fund_base(&taker, 1_000 * ONE);
    f.c.swap(&taker, &false, &(40 * ONE), &0);
    let pa = f.c.get_position(&ida);
    assert_eq!(pa.pending_proceeds, 40 * ONE);
    let idb = f.bid(&b, 0, 0, 100 * ONE);
    let pb = f.c.get_position(&idb);
    assert_eq!((pb.pending_proceeds, pb.pending_fees), (0, 0));
    assert!(pb.inventory <= 100 * ONE && pb.inventory >= 100 * ONE - 1, "{}", pb.inventory);
    f.c.swap(&taker, &false, &(80 * ONE), &0);
    let pa = f.c.get_position(&ida);
    let pb = f.c.get_position(&idb);
    assert!((pa.pending_proceeds - 70 * ONE).abs() <= 3, "{}", pa.pending_proceeds);
    assert!((pb.pending_proceeds - 50 * ONE).abs() <= 3, "{}", pb.pending_proceeds);
    // drain the bin completely, then reuse it
    f.c.swap(&taker, &false, &(500 * ONE), &0);
    assert!(f.active(Side::Bid).is_empty());
    let idc = f.bid(&b, 0, 0, 10 * ONE);
    assert_eq!(f.bin_rec(Side::Bid, 0).gen, 1);
    assert_eq!(f.c.get_position(&idc).pending_proceeds, 0);
    // A's earnings survive the new generation
    let pa2 = f.c.get_position(&ida);
    assert!(pa2.pending_proceeds >= pa.pending_proceeds);
    let ra = f.c.remove_position(&a, &ida);
    assert_eq!((ra.base, ra.quote), (pa2.pending_proceeds, pa2.pending_fees));
    assert_eq!(f.c.get_bin(&Side::Bid, &0).inventory, 10 * ONE);
}

#[test]
fn bid_leaves_no_unfillable_dust_in_the_book() {
    // 100 bps grid, bin 41 prices BASE at ~1.50; no fee, so any fee credit is a swept remainder
    let mut swept_cases = 0;
    for amount in 10_000i128..10_040 {
        let f = setup_with(100, 0, false);
        let (a, taker) = (f.user(), f.user());
        let id = f.bid(&a, 41, 41, amount);
        let p = f.price(41);
        assert!(p > 14_000_000 && p < 16_000_000);
        f.fund_base(&taker, ONE);
        let mut out = f.c.swap(&taker, &false, &ONE, &1);
        // a remainder is either swept or still fillable; one more swap always clears it
        let left = f.bin_rec(Side::Bid, 41).inventory;
        if left > 0 {
            assert!(left <= 2, "amount {}: leftover {}", amount, left);
            assert!(f.active(Side::Bid).contains(41));
            out += f.c.swap(&taker, &false, &ONE, &1);
        }
        assert_eq!(f.bin_rec(Side::Bid, 41).inventory, 0, "amount {}", amount);
        assert!(f.active(Side::Bid).is_empty());
        let pos = f.c.get_position(&id);
        assert_eq!(pos.inventory, 0);
        // nothing is created and at most 1 stroop of accumulator rounding stays in the pool:
        // taker payout + LP fee credit <= the whole bid, and the pool holds what is owed
        let gap = amount - (out + pos.pending_fees);
        assert!((0..=1).contains(&gap), "amount {}: gap {}", amount, gap);
        assert_eq!(f.bal_quote(&f.pool), pos.pending_fees + gap);
        if pos.pending_fees > 0 {
            swept_cases += 1;
        }
    }
    assert!(swept_cases > 0, "the sweep path must be exercised");
}

/// One of two LPs leaves a set of nearly filled Bid bins. Before the fix the
/// few stroops left behind (the remaining LP's share, which the leaver's
/// floor rounding hands it) could not be filled by any sell but still counted
/// against `max_bins_per_swap`, so they blocked every sell behind them, and
/// they made new deposits into those bins fail with `BinDust`. Now the
/// remainder is folded into the remaining LPs' fees and the bin leaves the book.
fn bid_removal_dust_case(with_vault: bool) {
    // 100 bps grid: bins 190..194 price BASE at ~6.6..6.9 QUOTE, so fewer than
    // ~6 stroops of QUOTE cannot buy one stroop of BASE
    let f = setup_with(100, 10, with_vault);
    if with_vault {
        seed_vault(&f, 1_000 * ONE);
    }
    let (a, b, c, taker) = (f.user(), f.user(), f.user(), f.user());
    f.fund_base(&taker, 1_000 * ONE);
    let bins: StdVec<i32> = (190..195).collect();
    let mut ids_a = StdVec::new();
    let mut ids_b = StdVec::new();
    // built upwards so each sell only touches the newest (highest) bin
    for &bin in &bins {
        ids_a.push(f.bid(&a, bin, bin, 10 * ONE));
        ids_b.push(f.bid(&b, bin, bin, 10 * ONE));
        let inv = f.c.get_bin(&Side::Bid, &bin).inventory;
        let p = f.price(bin);
        // sell one stroop of BASE less than the bin can absorb: a fillable remainder stays
        let x_cap = inv * ONE / p;
        f.c.swap(&taker, &false, &(x_cap - 1), &0);
        assert!(f.active(Side::Bid).contains(bin), "bin {} still fillable", bin);
        let r = f.bin_rec(Side::Bid, bin).inventory;
        assert!(r > 0 && r < MIN_BIN_DEPOSIT, "bin {}: remainder {}", bin, r);
    }
    // deep liquidity below the dust bins
    let id_c = f.bid(&c, 0, 0, 100 * ONE);

    // what A's removal leaves behind in each bin (units; 1:1 with QUOTE here)
    let mut folded = 0i128;
    for (i, &bin) in bins.iter().enumerate() {
        let r = f.bin_rec(Side::Bid, bin).inventory;
        let pa = f.c.get_position(&ids_a[i]);
        folded += r - pa.inventory;
    }
    let fees_b_before: i128 = ids_b.iter().map(|id| f.c.get_position(id).pending_fees).sum();
    for id in &ids_a {
        f.c.remove_position(&a, id);
    }

    // no Bid bin keeps 0 < inventory < MIN_BIN_DEPOSIT
    for &bin in &bins {
        let inv = f.bin_rec(Side::Bid, bin).inventory;
        assert!(
            inv == 0 || inv >= MIN_BIN_DEPOSIT,
            "bin {}: dust {} left in the book",
            bin,
            inv
        );
        assert!(!f.active(Side::Bid).contains(bin), "bin {} still active", bin);
    }
    // the remaining LP got the remainder as fees (minus accumulator rounding)
    let fees_b_after: i128 = ids_b.iter().map(|id| f.c.get_position(id).pending_fees).sum();
    let gained = fees_b_after - fees_b_before;
    assert!(
        gained <= folded && gained >= folded - bins.len() as i128,
        "fees gained {} for {} folded",
        gained,
        folded
    );
    for id in &ids_b {
        assert_eq!(f.c.get_position(id).inventory, 0);
    }

    // a sell across the range reaches the deep bin even with a tight bin budget
    f.c.set_max_bins_per_swap(&(bins.len() as u32));
    let out = f.c.swap(&taker, &false, &ONE, &1);
    assert!(out > 0);
    // and a new deposit into a former dust bin starts a fresh generation (no BinDust)
    let d = f.user();
    let id_d = f.bid(&d, 192, 192, 10 * ONE);
    assert_eq!(f.bin_rec(Side::Bid, 192).gen, 1);
    assert_eq!(f.c.get_position(&id_d).inventory, 10 * ONE);

    // B's removal pays inventory + fees; nothing is over-paid
    let mut paid_b = 0i128;
    for (i, id) in ids_b.iter().enumerate() {
        let view = f.c.get_position(id);
        let r = f.c.remove_position(&b, id);
        assert_eq!(r.quote, view.inventory + view.pending_fees, "bin {}", bins[i]);
        paid_b += r.quote;
    }
    assert!(paid_b >= fees_b_after);
    f.c.remove_position(&c, &id_c);
    f.c.remove_position(&d, &id_d);
    // at most ~1 stroop per bin (plus fee rounding) stays in the pool
    let left = if with_vault { f.qs() } else { f.bal_quote(&f.pool) };
    assert!(left >= 0 && left <= 2 * (bins.len() as i128 + 2), "pool keeps {}", left);
    assert!(f.active(Side::Bid).is_empty());
}

#[test]
fn bid_removal_leaves_no_unfillable_dust() {
    bid_removal_dust_case(false);
}

#[test]
fn vault_bid_removal_leaves_no_unfillable_dust() {
    bid_removal_dust_case(true);
}

#[test]
fn claim_and_remove_require_the_owner() {
    let f = setup();
    let (a, stranger, taker) = (f.user(), f.user(), f.user());
    let id = f.ask(&a, 0, 0, 10 * ONE);
    f.fund_quote(&taker, 100 * ONE);
    f.c.swap(&taker, &true, &(5 * ONE), &0);
    // a signed stranger is not the owner
    assert_eq!(
        f.c.try_claim(&stranger, &id),
        Err(Ok(Error::NotOwner.into()))
    );
    assert_eq!(
        f.c.try_remove_position(&stranger, &id),
        Err(Ok(Error::NotOwner.into()))
    );
    assert_eq!(
        f.c.try_claim(&a, &99),
        Err(Ok(Error::NoSuchPosition.into()))
    );
    // naming the owner without the owner's signature fails
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.pool,
            fn_name: "claim",
            args: (a.clone(), id).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.c.try_claim(&a, &id).is_err());
    f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &f.pool,
            fn_name: "remove_position",
            args: (a.clone(), id).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.c.try_remove_position(&a, &id).is_err());
    assert_eq!(f.bal_base(&stranger), 0);
    assert_eq!(f.bal_quote(&stranger), 0);
    assert_eq!(f.c.get_position(&id).owner, a);
}

#[test]
fn swap_and_deposit_need_the_callers_signature() {
    let f = setup();
    let (maker, taker, other) = (f.user(), f.user(), f.user());
    f.ask(&maker, 0, 0, 10 * ONE);
    f.fund_quote(&taker, 100 * ONE);
    f.fund_base(&other, 10 * ONE);
    let amount = 5 * ONE;

    // only `other` signs a swap that names `taker`
    f.env.mock_auths(&[MockAuth {
        address: &other,
        invoke: &MockAuthInvoke {
            contract: &f.pool,
            fn_name: "swap",
            args: (taker.clone(), true, amount, 0i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.c.try_swap(&taker, &true, &amount, &0).is_err());
    assert_eq!(f.bal_quote(&taker), 100 * ONE);

    // the taker signs the swap and the nested QUOTE transfer (explicit auth tree)
    f.env.mock_auths(&[MockAuth {
        address: &taker,
        invoke: &MockAuthInvoke {
            contract: &f.pool,
            fn_name: "swap",
            args: (taker.clone(), true, amount, 0i128).into_val(&f.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &f.quote,
                fn_name: "transfer",
                args: (taker.clone(), f.pool.clone(), fee_up_cost(amount)).into_val(&f.env),
                sub_invokes: &[],
            }],
        },
    }]);
    // The exact amount pulled is price leg + fee for the BASE that `amount` buys.
    assert!(f.c.try_swap(&taker, &true, &amount, &0).is_ok());
    assert!(f.bal_base(&taker) > 0);

    // add_position needs the owner's auth for the nested token transfer
    f.env.mock_auths(&[MockAuth {
        address: &maker,
        invoke: &MockAuthInvoke {
            contract: &f.pool,
            fn_name: "add_position",
            args: (
                other.clone(),
                Side::Ask,
                Mode::Directional,
                0i32,
                0i32,
                ONE,
                f.no_weights(),
            )
                .into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .c
        .try_add_position(
            &other,
            &Side::Ask,
            &Mode::Directional,
            &0,
            &0,
            &ONE,
            &f.no_weights()
        )
        .is_err());
    assert_eq!(f.bal_base(&other), 10 * ONE);
}

/// Total the taker pays for a budget of `amount` at price 1.0 and fee 10 bps:
/// the largest price leg q with q + ceil(q * 10 / 10000) <= amount, plus its fee.
fn fee_up_cost(amount: i128) -> i128 {
    let q_max = amount * 10_000 / 10_010;
    q_max + fee_up(q_max, 10)
}

// ---------------------------------------------------------------------------
// events and views
// ---------------------------------------------------------------------------

#[test]
fn events_are_emitted() {
    let f = setup();
    let (maker, taker) = (f.user(), f.user());
    let id = f.ask(&maker, 0, 1, 20 * ONE);
    // add_position published exactly one pool event: PositionAdded
    f.fund_base(&maker, 20 * ONE);
    let id2 = f.c.add_position(
        &maker,
        &Side::Ask,
        &Mode::Directional,
        &0,
        &1,
        &(20 * ONE),
        &f.no_weights(),
    );
    let expected = PositionAdded {
        owner: maker.clone(),
        id: id2,
        side: Side::Ask,
        lo_bin: 0,
        hi_bin: 1,
        amount: 20 * ONE,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool),
        [expected.to_xdr(&f.env, &f.pool)]
    );

    f.fund_quote(&taker, 100 * ONE);
    let t = 5 * ONE + fee_up(5 * ONE, 10);
    f.c.swap(&taker, &true, &t, &0);
    let expected = Swapped {
        taker: taker.clone(),
        buy_base: true,
        amount_in: t,
        amount_out: 5 * ONE,
        fee: fee_up(5 * ONE, 10),
        bins_crossed: 1,
        last_bin: 0,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool),
        [expected.to_xdr(&f.env, &f.pool)]
    );

    let paid = f.c.claim(&maker, &id);
    let expected = Claimed {
        owner: maker.clone(),
        id,
        base: 0,
        quote: paid.quote,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool),
        [expected.to_xdr(&f.env, &f.pool)]
    );

    let removed = f.c.remove_position(&maker, &id);
    let expected = PositionRemoved {
        owner: maker.clone(),
        id,
        base: removed.base,
        quote: removed.quote,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool),
        [expected.to_xdr(&f.env, &f.pool)]
    );
}

#[test]
fn views_for_empty_and_filled_bins() {
    let f = setup();
    let (maker, taker) = (f.user(), f.user());
    let v = f.c.get_bin(&Side::Ask, &5);
    assert_eq!(
        (v.inventory, v.total_shares, v.filled, v.price),
        (0, 0, 0, f.price(5))
    );
    assert!(f.c.try_get_bin(&Side::Ask, &201).is_err());
    assert_eq!(f.c.depth(&Side::Ask, &-200, &200).len(), 0);
    assert_eq!(f.c.positions_of(&maker).len(), 0);

    f.ask(&maker, -3, 3, 70 * ONE);
    f.bid(&maker, -9, -5, 50 * ONE);
    assert_eq!(f.c.positions_of(&maker).len(), 2);
    assert_eq!(f.c.depth(&Side::Ask, &-200, &200).len(), 7);
    assert_eq!(f.c.depth(&Side::Ask, &0, &1).len(), 2);
    assert_eq!(f.c.depth(&Side::Bid, &-200, &200).len(), 5);
    assert_eq!(f.c.depth(&Side::Bid, &-6, &-5).len(), 2);
    let tvl = f.c.tvl();
    assert_eq!((tvl.base, tvl.quote_value, tvl.vault_shares), (70 * ONE, 50 * ONE, 0));
    f.fund_quote(&taker, 10 * ONE);
    f.c.swap(&taker, &true, &(10 * ONE), &0);
    let tvl = f.c.tvl();
    assert!(tvl.base < 70 * ONE && tvl.quote_value > 50 * ONE);
}

// ---------------------------------------------------------------------------
// invariants and solvency
// ---------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + self.below((hi - lo + 1) as u64) as i64
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
struct BinSnap {
    gen: u32,
    inventory: i128,
    total_shares: i128,
    filled: i128,
    acc_x: i128,
    acc_p: i128,
    acc_f: i128,
}

fn snapshot(f: &Fx, lo: i32, hi: i32) -> StdVec<(Side, i32, BinSnap)> {
    let mut v = StdVec::new();
    for side in [Side::Ask, Side::Bid] {
        for bin in lo..=hi {
            let r = f.bin_rec(side, bin);
            v.push((
                side,
                bin,
                BinSnap {
                    gen: r.gen,
                    inventory: r.inventory,
                    total_shares: r.total_shares,
                    filled: r.filled,
                    acc_x: r.acc_x,
                    acc_p: r.acc_p,
                    acc_f: r.acc_f,
                },
            ));
        }
    }
    v
}

/// What the pool owes in each asset right now, from the public views only:
/// remaining inventory plus pending proceeds and fees of every open position.
fn liabilities(f: &Fx, ids: &StdVec<u64>) -> (i128, i128) {
    let (mut base, mut quote) = (0i128, 0i128);
    for id in ids {
        let p = f.c.get_position(id);
        if p.mode == Mode::TwoWay {
            // BASE held in `inventory`, QUOTE held in `pending_proceeds`
            base += p.inventory;
            quote += p.pending_proceeds + p.pending_fees;
            continue;
        }
        match p.side {
            Side::Ask => {
                base += p.inventory;
                quote += p.pending_proceeds + p.pending_fees;
            }
            Side::Bid => {
                quote += p.inventory + p.pending_fees;
                base += p.pending_proceeds;
            }
        }
    }
    (base, quote)
}

fn assert_solvent(f: &Fx, ids: &StdVec<u64>, ctx: &str) {
    let (owed_base, owed_quote) = liabilities(f, ids);
    let have_base = f.bal_base(&f.pool);
    let t = f.c.tvl();
    assert!(
        have_base >= owed_base,
        "{}: BASE balance {} < owed {}",
        ctx,
        have_base,
        owed_base
    );
    assert!(
        t.quote_value >= owed_quote,
        "{}: QUOTE value {} < owed {}",
        ctx,
        t.quote_value,
        owed_quote
    );
}

/// Run a deterministic pseudo-random sequence of operations and check after
/// every one: solvency, monotonic accounting, and (at the end) that a full
/// wind-down pays everybody and leaves only dust.
fn random_walk(f: &Fx, seed: u64, steps: usize, accrue: bool) {
    random_walk_modes(f, seed, steps, accrue, false)
}

fn random_walk_modes(f: &Fx, seed: u64, steps: usize, accrue: bool, two_way: bool) {
    let mut rng = Rng(seed);
    let makers: StdVec<Address> = (0..4).map(|_| f.user()).collect();
    let takers: StdVec<Address> = (0..3).map(|_| f.user()).collect();
    let mut open: StdVec<(u64, Address)> = StdVec::new();
    let donor = f.user();
    let mut swaps = 0;
    let mut fills = 0;
    let mut paid_out_base = 0i128;
    let mut paid_out_quote = 0i128;
    let mut paid_in_base = 0i128;
    let mut paid_in_quote = 0i128;
    // with a vault the views convert shares with a conservative (floored) rate, so a real
    // withdrawal can be worth a couple of stroops more than the view said
    let tol: i128 = if f.vault.is_some() { 3 } else { 0 };

    for step in 0..steps {
        let before = snapshot(f, -8, 8);
        let op = rng.below(100);
        let ctx = std::format!("seed {} step {} op {}", seed, step, op);
        // vault yield and loss while positions are open (the accrue branch further down is only
        // reached when no position is open, so it injects nothing in the interesting states)
        if accrue && rng.below(100) < 10 {
            if let Some(v) = &f.vault {
                if rng.below(8) == 0 {
                    // a small loss: the vault gives up about 0.3 percent of its underlying
                    let bal = f.bal_quote(v);
                    let amt = bal / (300 + rng.below(300) as i128);
                    if amt > 0 {
                        MockVaultClient::new(&f.env, v).slash(&amt);
                    }
                } else {
                    let amt = rng.range(1, 50) as i128 * ONE / 10;
                    f.fund_quote(&donor, amt);
                    MockVaultClient::new(&f.env, v).accrue(&donor, &amt);
                }
            }
        }
        if op < 25 && open.len() < 40 {
            // add an Ask or a Bid position
            let owner = makers[rng.below(4) as usize].clone();
            let lo = rng.range(-5, 4) as i32;
            let hi = lo + rng.range(0, 4) as i32;
            let amount = (rng.range(1, 200) as i128) * ONE / 4 + rng.range(0, 999) as i128;
            let ask = rng.below(2) == 0;
            let n = (hi - lo + 1) as u32;
            let weights = if rng.below(3) == 0 {
                let mut w = Vec::new(&f.env);
                for _ in 0..n {
                    w.push_back(rng.range(1, 9) as u32);
                }
                w
            } else {
                f.no_weights()
            };
            if ask {
                f.fund_base(&owner, amount);
            } else {
                f.fund_quote(&owner, amount);
            }
            let side = if ask { Side::Ask } else { Side::Bid };
            let mode = if two_way && rng.below(2) == 0 {
                Mode::TwoWay
            } else {
                Mode::Directional
            };
            match f.c.try_add_position(&owner, &side, &mode, &lo, &hi, &amount, &weights) {
                Ok(Ok(id)) => {
                    open.push((id, owner));
                    if ask {
                        paid_in_base += amount;
                    } else {
                        paid_in_quote += amount;
                    }
                }
                Ok(Err(_)) | Err(_) => {
                    // BinDust / AmountTooSmall are legitimate rejections; refund the funding
                    if ask {
                        TokenClient::new(&f.env, &f.base).transfer(&owner, &donor, &amount);
                    } else {
                        TokenClient::new(&f.env, &f.quote).transfer(&owner, &donor, &amount);
                    }
                }
            }
        } else if op < 65 {
            // swap
            let taker = takers[rng.below(3) as usize].clone();
            let buy = rng.below(2) == 0;
            let amount = (rng.range(1, 400) as i128) * ONE / 10 + rng.range(0, 99) as i128;
            if buy {
                f.fund_quote(&taker, amount);
            } else {
                f.fund_base(&taker, amount);
            }
            let (qb, qq) = (f.bal_base(&taker), f.bal_quote(&taker));
            let quote = f.c.quote_swap(&buy, &amount);
            let res = f.c.try_swap(&taker, &buy, &amount, &0);
            match res {
                Ok(Ok(out)) => {
                    swaps += 1;
                    fills += quote.bins_crossed;
                    assert_eq!(out, quote.amount_out, "{}: quote == swap", ctx);
                    let (db, dq) = (f.bal_base(&taker) - qb, f.bal_quote(&taker) - qq);
                    if buy {
                        assert_eq!(db, out, "{}", ctx);
                        assert!(-dq <= amount && dq < 0, "{}: pulled {} of {}", ctx, -dq, amount);
                        paid_in_quote += -dq;
                        paid_out_base += db;
                    } else {
                        assert_eq!(dq, out, "{}", ctx);
                        assert!(-db <= amount && db < 0, "{}", ctx);
                        paid_in_base += -db;
                        paid_out_quote += dq;
                    }
                }
                other => {
                    assert_eq!(quote.amount_out, 0, "{}: reverted although quotable: {:?}", ctx, other);
                }
            }
            // wash the taker's leftovers so balances do not grow without bound
            let (lb, lq) = (f.bal_base(&taker), f.bal_quote(&taker));
            if lb > 0 {
                TokenClient::new(&f.env, &f.base).transfer(&taker, &donor, &lb);
            }
            if lq > 0 {
                TokenClient::new(&f.env, &f.quote).transfer(&taker, &donor, &lq);
            }
        } else if op < 80 && !open.is_empty() {
            // claim
            let k = rng.below(open.len() as u64) as usize;
            let (id, owner) = open[k].clone();
            let pre = f.c.get_position(&id);
            let (b0, q0) = (f.bal_base(&owner), f.bal_quote(&owner));
            let paid = f.c.claim(&owner, &id);
            assert!(
                paid.base <= pre.pending_proceeds.max(pre.pending_fees) + pre.pending_proceeds + pre.pending_fees,
                "{}",
                ctx
            );
            if pre.mode == Mode::TwoWay {
                // proceeds stay in the bin reserves: a claim pays fees only
                assert_eq!(paid.base, 0, "{}", ctx);
                assert!(paid.quote <= pre.pending_fees, "{}", ctx);
            } else {
                match pre.side {
                    Side::Ask => {
                        assert!(paid.quote <= pre.pending_proceeds + pre.pending_fees + tol, "{}", ctx);
                        assert_eq!(paid.base, 0);
                    }
                    Side::Bid => {
                        assert!(paid.base <= pre.pending_proceeds, "{}", ctx);
                        assert!(paid.quote <= pre.pending_fees + tol, "{}", ctx);
                    }
                }
            }
            assert_eq!(f.bal_base(&owner) - b0, paid.base);
            assert_eq!(f.bal_quote(&owner) - q0, paid.quote);
            paid_out_base += paid.base;
            paid_out_quote += paid.quote;
            let post = f.c.get_position(&id);
            if pre.mode == Mode::TwoWay {
                assert_eq!(post.pending_proceeds, pre.pending_proceeds, "{}", ctx);
            } else {
                assert_eq!(post.pending_proceeds, 0, "{}", ctx);
            }
            // (with a vault, the views convert shares at a floored rate that moves by a stroop
            // when the claim withdraws shares)
            assert!(post.pending_fees <= tol, "{}", ctx);
            assert!((post.inventory - pre.inventory).abs() <= tol, "{}", ctx);
            assert_eq!(post.filled, pre.filled, "{}", ctx);
        } else if !open.is_empty() {
            // remove
            let k = rng.below(open.len() as u64) as usize;
            let (id, owner) = open.remove(k);
            let pre = f.c.get_position(&id);
            let paid = f.c.remove_position(&owner, &id);
            if pre.mode == Mode::TwoWay || pre.side == Side::Ask {
                // (a two-way position holds BASE in `inventory` and QUOTE in `pending_proceeds`)
                assert!(paid.base <= pre.inventory, "{}", ctx);
                assert!(paid.quote <= pre.pending_proceeds + pre.pending_fees + tol, "{}", ctx);
            } else {
                assert!(paid.base <= pre.pending_proceeds, "{}", ctx);
                assert!(paid.quote <= pre.inventory + pre.pending_fees + tol, "{}", ctx);
            }
            paid_out_base += paid.base;
            paid_out_quote += paid.quote;
            assert!(f.c.try_get_position(&id).is_err());
        } else if accrue && op >= 95 {
            // vault yield
            if let Some(v) = &f.vault {
                let amt = rng.range(1, 50) as i128 * ONE / 10;
                f.fund_quote(&donor, amt);
                MockVaultClient::new(&f.env, v).accrue(&donor, &amt);
            }
        }

        // ---- invariants after every operation ----
        let after = snapshot(f, -8, 8);
        for ((side, bin, b), (_, _, a)) in before.iter().zip(after.iter()) {
            assert!(a.filled >= b.filled, "{}: filled fell on {:?} {}", ctx, side, bin);
            if a.gen == b.gen {
                assert!(a.acc_x >= b.acc_x && a.acc_p >= b.acc_p && a.acc_f >= b.acc_f,
                    "{}: accumulator fell on {:?} {}", ctx, side, bin);
            } else {
                assert!(a.gen > b.gen, "{}: generation went back", ctx);
            }
            if op >= 25 && op < 65 {
                // swaps only consume
                assert!(a.inventory <= b.inventory, "{}: inventory grew in a swap on {:?} {}", ctx, side, bin);
                assert_eq!(a.total_shares, b.total_shares, "{}", ctx);
            }
        }
        let ids: StdVec<u64> = open.iter().map(|(id, _)| *id).collect();
        assert_solvent(f, &ids, &ctx);
        // the two-way index matches the two-way reserves
        {
            let (tw_ask, tw_bid) = (f.active_tw(Side::Ask), f.active_tw(Side::Bid));
            for bin in -8..=8 {
                let t = f.tw_rec(bin);
                assert_eq!(tw_ask.contains(bin), t.x > 0, "{}: two-way ask index {}", ctx, bin);
                assert_eq!(tw_bid.contains(bin), t.y > 0, "{}: two-way bid index {}", ctx, bin);
            }
        }
        // the active index matches the bins
        for side in [Side::Ask, Side::Bid] {
            let set = f.active(side);
            for bin in -8..=8 {
                let live = f.bin_rec(side, bin).inventory > 0;
                assert_eq!(set.contains(bin), live, "{}: index of {:?} {}", ctx, side, bin);
            }
        }
    }

    // wind down: everybody leaves, then only dust may remain
    for (id, owner) in open.clone() {
        let paid = f.c.remove_position(&owner, &id);
        paid_out_base += paid.base;
        paid_out_quote += paid.quote;
    }
    // makers' own balances are their payouts; the pool keeps only rounding dust
    let dust_base = f.bal_base(&f.pool);
    let dust_quote = f.tvl_quote();
    assert!(swaps > 5 && fills > 5, "the walk must exercise swaps ({} swaps)", swaps);
    assert!(dust_base >= 0 && dust_quote >= 0);
    assert!(
        dust_base <= 200,
        "BASE dust {} (in {} out {})",
        dust_base,
        paid_in_base,
        paid_out_base
    );
    assert!(
        dust_quote <= 200 + if f.vault.is_some() { 5_000 } else { 0 },
        "QUOTE dust {} (in {} out {})",
        dust_quote,
        paid_in_quote,
        paid_out_quote
    );
    // conservation: nothing was created
    if f.vault.is_none() {
        assert_eq!(paid_in_base - paid_out_base, dust_base);
        assert_eq!(paid_in_quote - paid_out_quote, dust_quote);
    }
}

impl<'a> Fx<'a> {
    fn tvl_quote(&self) -> i128 {
        self.c.tvl().quote_value
    }
}

#[test]
fn random_operations_stay_solvent_and_monotonic() {
    for seed in [1u64, 7, 42, 2026, 31337] {
        let f = setup();
        random_walk(&f, seed, 220, false);
    }
}

#[test]
fn random_operations_with_zero_fee_and_coarse_grid() {
    // a different fee and grid change every rounding path
    for (seed, step, fee) in [(5u64, 100u32, 0u32), (6, 1, 1000), (9, 50, 37)] {
        let f = setup_with(step, fee, false);
        random_walk(&f, seed, 160, false);
    }
}

#[test]
fn inventory_never_rises_and_filled_never_falls_across_a_ladder() {
    let f = setup();
    let (maker, taker) = (f.user(), f.user());
    f.ask(&maker, 0, 9, 1_000 * ONE);
    f.fund_quote(&taker, 100_000 * ONE);
    let mut last = snapshot(&f, 0, 9);
    for step in 0..40 {
        let amt = (step % 7 + 1) * ONE;
        let _ = f.c.try_swap(&taker, &true, &amt, &0);
        let now = snapshot(&f, 0, 9);
        for ((_, bin, b), (_, _, a)) in last.iter().zip(now.iter()) {
            assert!(a.inventory <= b.inventory, "bin {}", bin);
            assert!(a.filled >= b.filled, "bin {}", bin);
            assert!(a.acc_p >= b.acc_p && a.acc_f >= b.acc_f && a.acc_x >= b.acc_x);
        }
        last = now;
    }
}

#[test]
fn bid_multiple_positions_share_a_bin_pro_rata() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    let ida = f.bid(&a, 0, 0, 100 * ONE);
    let idb = f.bid(&b, 0, 0, 300 * ONE);
    assert_eq!(f.c.get_bin(&Side::Bid, &0).total_shares, 400 * ONE);
    f.fund_base(&taker, 1_000 * ONE);
    // sell 100 BASE at price 1.0: A's bid takes a quarter, B's three quarters
    f.c.swap(&taker, &false, &(100 * ONE), &0);
    let (pa, pb) = (f.c.get_position(&ida), f.c.get_position(&idb));
    assert_eq!((pa.filled, pa.inventory), (25 * ONE, 75 * ONE));
    assert_eq!((pb.filled, pb.inventory), (75 * ONE, 225 * ONE));
    assert_eq!((pa.pending_proceeds, pb.pending_proceeds), (25 * ONE, 75 * ONE));
    assert_eq!(pa.pending_fees, fee_up(100 * ONE, 10) / 4);
    assert_eq!(pb.pending_fees, fee_up(100 * ONE, 10) * 3 / 4);
    // each leaves with exactly its part
    let ra = f.c.remove_position(&a, &ida);
    assert_eq!((ra.base, ra.quote), (25 * ONE, 75 * ONE + pa.pending_fees));
    let rb = f.c.remove_position(&b, &idb);
    assert_eq!((rb.base, rb.quote), (75 * ONE, 225 * ONE + pb.pending_fees));
    assert_eq!(f.bal_base(&f.pool), 0);
    assert_eq!(f.bal_quote(&f.pool), 0);
}

#[test]
fn bid_min_out_bin_cap_and_rounding() {
    let f = setup();
    let (maker, taker) = (f.user(), f.user());
    f.bid(&maker, -9, 0, 100 * ONE); // 10 USDC per bin
    f.fund_base(&taker, 1_000 * ONE);
    // min_out
    let q = f.c.quote_swap(&false, &(5 * ONE));
    assert_eq!(
        f.c.try_swap(&taker, &false, &(5 * ONE), &(q.amount_out + 1)),
        Err(Ok(Error::SlippageExceeded.into()))
    );
    assert_eq!(f.bal_base(&taker), 1_000 * ONE, "a reverted sell pulls nothing");
    // max_bins_per_swap: 3 bins of ~10 USDC
    f.c.set_max_bins_per_swap(&3);
    let q = f.c.quote_swap(&false, &(500 * ONE));
    assert_eq!((q.bins_crossed, q.partial), (3, true));
    let out = f.c.swap(&taker, &false, &(500 * ONE), &0);
    assert_eq!(out, q.amount_out);
    assert!(out < 30 * ONE && out > 29 * ONE, "{}", out);
    assert_eq!(f.c.depth(&Side::Bid, &-9, &0).len(), 7);
    // a small order fits in the cap and is not partial
    assert!(!f.c.quote_swap(&false, &(5 * ONE)).partial);

    // rounding at price 0.999 (bin -1): the seller never gets more than q - fee, tiny sales pay nothing
    let f = setup();
    let (maker, taker) = (f.user(), f.user());
    f.bid(&maker, -1, -1, 10 * ONE);
    f.fund_base(&taker, 100);
    assert_eq!(f.c.quote_swap(&false, &1).amount_out, 0);
    assert_eq!(f.c.quote_swap(&false, &2).amount_out, 0, "price leg 1, fee 1, nothing left");
    assert_eq!(f.c.quote_swap(&false, &3).amount_out, 1, "price leg 2, fee 1");
    assert_eq!(
        f.c.try_swap(&taker, &false, &1, &0),
        Err(Ok(Error::NoLiquidity.into()))
    );
    let p = f.price(-1);
    for x in [3i128, 10, 37, 99] {
        let out = f.c.quote_swap(&false, &x).amount_out;
        let q = q_down(x, p);
        assert_eq!(out, q - fee_up(q, 10), "x = {}", x);
        assert!(out * ONE <= x * p, "the seller never receives more than the exact price leg");
    }
}

// ---------------------------------------------------------------------------
// stage C: QUOTE leg held in a DeFindex vault
// ---------------------------------------------------------------------------

/// Put `amount` of third-party money in the vault so that its share price stays near 1
/// (a vault with a handful of shares and a donated balance has absurd rounding).
fn seed_vault(f: &Fx, amount: i128) {
    let v = f.vault.as_ref().unwrap();
    let whale = f.user();
    f.fund_quote(&whale, amount);
    let _: (Vec<i128>, i128, Option<Vec<i128>>) = f.env.invoke_contract(
        v,
        &soroban_sdk::Symbol::new(&f.env, "deposit"),
        (vec![&f.env, amount], vec![&f.env, 0i128], whale, true).into_val(&f.env),
    );
}

fn mock_vault<'a>(f: &'a Fx) -> MockVaultClient<'a> {
    MockVaultClient::new(&f.env, f.vault.as_ref().unwrap())
}

fn test_vault<'a>(f: &'a Fx) -> TestVaultClient<'a> {
    TestVaultClient::new(&f.env, f.vault.as_ref().unwrap())
}

fn assert_close(got: i128, want: i128, tol: i128, what: &str) {
    assert!((got - want).abs() <= tol, "{}: got {} want {} (+/- {})", what, got, want, tol);
}

#[test]
fn vault_config_and_empty_views() {
    let f = setup_with(10, 10, true);
    let cfg = f.c.get_config();
    assert_eq!(cfg.vault, f.vault);
    // nothing vaulted yet: views do not need the vault
    let t = f.c.tvl();
    assert_eq!((t.base, t.quote_value, t.vault_shares), (0, 0, 0));
    assert_eq!(f.c.depth(&Side::Bid, &-10, &10).len(), 0);
    assert_eq!(f.c.quote_swap(&false, &ONE).amount_out, 0);
    assert!(f.c.quote_swap(&false, &ONE).partial);
}

#[test]
fn vault_bid_inventory_grows_with_yield() {
    let f = setup_with(10, 10, true);
    let (maker, taker, donor) = (f.user(), f.user(), f.user());
    let id = f.bid(&maker, 0, 0, 100 * ONE);
    // the QUOTE went to the vault, none is idle in the pool
    assert_eq!(f.bal_quote(&f.pool), 0);
    assert_eq!(f.bal_quote(f.vault.as_ref().unwrap()), 100 * ONE);
    assert_eq!(f.qs(), 100 * ONE);
    assert_eq!(f.c.tvl().vault_shares, 100 * ONE);
    assert_eq!(f.c.get_position(&id).inventory, 100 * ONE);
    assert!(f.c.get_position(&id).vaulted);

    // 10 percent yield lands in the vault: the bid is now worth 110 USDC
    f.fund_quote(&donor, 10 * ONE);
    mock_vault(&f).accrue(&donor, &(10 * ONE));
    assert_eq!(f.c.get_position(&id).inventory, 110 * ONE);
    assert_eq!(f.c.get_bin(&Side::Bid, &0).inventory, 110 * ONE);
    assert_eq!(f.c.tvl().quote_value, 110 * ONE);
    assert_eq!(f.c.depth(&Side::Bid, &-5, &5).get(0).unwrap().inventory, 110 * ONE);

    // the bid absorbs up to 110 BASE at 1.0: a 50 BASE sell is paid out of vault shares
    f.fund_base(&taker, 50 * ONE);
    let q = f.c.quote_swap(&false, &(50 * ONE));
    assert_eq!(q.amount_out, 50 * ONE - ONE / 20);
    let out = f.c.swap(&taker, &false, &(50 * ONE), &0);
    assert_eq!(out, q.amount_out);
    assert_eq!(f.bal_quote(&taker), 50 * ONE - ONE / 20);
    // 60 USDC of the bid (value) is left, plus the fee credited to the LP
    let p = f.c.get_position(&id);
    assert_close(p.inventory, 60 * ONE, 2, "remaining bid value");
    assert_close(p.pending_fees, ONE / 20, 2, "fee value");
    assert_eq!(p.pending_proceeds, 50 * ONE);
    assert_close(p.filled, 50 * ONE, 0, "filled in QUOTE value");

    // removing pays more than the 50.05 USDC of principal that was not sold
    let r = f.c.remove_position(&maker, &id);
    assert_eq!(r.base, 50 * ONE);
    assert_close(r.quote, 60 * ONE + ONE / 20, 3, "quote paid");
    assert!(r.quote > 50 * ONE + ONE / 20, "the owner earned the yield");
    assert_eq!(f.bal_quote(&maker), r.quote);
    // the pool keeps (almost) nothing
    assert!(f.qs() <= 2, "{}", f.qs());
    assert!(f.bal_quote(&f.pool) <= 2);
}

#[test]
fn vault_ask_proceeds_grow_with_yield() {
    let f = setup_with(10, 10, true);
    let (maker, taker, donor) = (f.user(), f.user(), f.user());
    let id = f.ask(&maker, 0, 0, 100 * ONE);
    assert_eq!(f.qs(), 0, "an ask holds BASE only");
    f.fund_quote(&taker, 100 * ONE);
    let t = 50 * ONE + fee_up(50 * ONE, 10);
    f.c.swap(&taker, &true, &t, &0);
    // the taker's QUOTE went straight into the vault
    assert_eq!(f.bal_quote(&f.pool), 0);
    assert_eq!(f.bal_quote(f.vault.as_ref().unwrap()), t);
    assert_eq!(f.qs(), t);
    let p = f.c.get_position(&id);
    assert_eq!((p.pending_proceeds, p.pending_fees), (50 * ONE, fee_up(50 * ONE, 10)));

    // yield: 5 USDC on top of the 50.05 deposited
    f.fund_quote(&donor, 5 * ONE);
    mock_vault(&f).accrue(&donor, &(5 * ONE));
    let p = f.c.get_position(&id);
    let value = p.pending_proceeds + p.pending_fees;
    assert_close(value, t + 5 * ONE, 3, "proceeds grew with the vault");
    let paid = f.c.claim(&maker, &id);
    assert_eq!(paid.base, 0);
    assert_close(paid.quote, t + 5 * ONE, 3, "claimed value");
    assert!(paid.quote > t, "the maker received more than the taker paid");
    assert_eq!(f.bal_quote(&maker), paid.quote);
    assert_eq!(f.qs(), 0, "every share was withdrawn");
    // the unfilled half of the BASE is returned untouched
    let r = f.c.remove_position(&maker, &id);
    assert_eq!((r.base, r.quote), (50 * ONE, 0));
}

#[test]
fn vault_yield_is_shared_pro_rata_by_lps() {
    let f = setup_with(10, 10, true);
    let (a, b, donor) = (f.user(), f.user(), f.user());
    let ida = f.bid(&a, -3, -3, 100 * ONE);
    let idb = f.bid(&b, -3, -3, 300 * ONE);
    f.fund_quote(&donor, 40 * ONE);
    mock_vault(&f).accrue(&donor, &(40 * ONE));
    assert_close(f.c.get_position(&ida).inventory, 110 * ONE, 2, "a");
    assert_close(f.c.get_position(&idb).inventory, 330 * ONE, 2, "b");
    // a late LP buys in at the current share price and gets no part of the old yield
    let c = f.user();
    let idc = f.bid(&c, -3, -3, 110 * ONE);
    assert_close(f.c.get_position(&idc).inventory, 110 * ONE, 2, "c");
    assert_close(f.c.get_position(&ida).inventory, 110 * ONE, 3, "a unchanged");
    let ra = f.c.remove_position(&a, &ida);
    assert_close(ra.quote, 110 * ONE, 3, "a payout");
    let rc = f.c.remove_position(&c, &idc);
    assert_close(rc.quote, 110 * ONE, 3, "c payout");
}

#[test]
fn vault_calls_per_operation() {
    let f = setup_test_vault();
    let v = test_vault(&f);
    let (maker, taker) = (f.user(), f.user());
    let calls = || v.calls();

    v.reset_calls();
    let ida = f.ask(&maker, 0, 5, 60 * ONE);
    assert_eq!(calls(), (0, 0, 0), "an ask never touches the vault");

    v.reset_calls();
    let idb = f.bid(&maker, -6, -1, 60 * ONE);
    assert_eq!(calls(), (1, 0, 0), "a bid is invested in one deposit");

    // buy through four bins: one deposit, no price query
    f.fund_quote(&taker, 1_000 * ONE);
    v.reset_calls();
    let q = f.c.quote_swap(&true, &(40 * ONE));
    assert!(q.bins_crossed >= 3);
    assert_eq!(calls(), (0, 0, 0), "buy quotes need no vault call");
    v.reset_calls();
    f.c.swap(&taker, &true, &(40 * ONE), &0);
    assert_eq!(calls(), (1, 0, 0), "buy: exactly one deposit");

    // sell through several bins: one price query, one withdrawal
    f.fund_base(&taker, 100 * ONE);
    v.reset_calls();
    let q = f.c.quote_swap(&false, &(35 * ONE));
    assert!(q.bins_crossed >= 3);
    assert_eq!(calls(), (0, 0, 1), "sell quote: one read-only price query");
    v.reset_calls();
    f.c.swap(&taker, &false, &(35 * ONE), &0);
    assert_eq!(calls(), (0, 1, 1), "sell: one price query and one withdrawal");

    v.reset_calls();
    f.c.claim(&maker, &ida);
    assert_eq!(calls(), (0, 1, 0), "claim: one withdrawal");
    v.reset_calls();
    f.c.remove_position(&maker, &idb);
    assert_eq!(calls(), (0, 1, 0), "remove: one withdrawal");
    v.reset_calls();
    f.c.remove_position(&maker, &ida);
    assert_eq!(calls(), (0, 0, 0), "remove of an ask already claimed: nothing to withdraw");
}

#[test]
fn failing_vault_withdrawal_reverts_the_swap() {
    let f = setup_test_vault();
    let v = test_vault(&f);
    let (maker, taker) = (f.user(), f.user());
    let id = f.bid(&maker, -2, 0, 90 * ONE);
    f.fund_base(&taker, 50 * ONE);
    f.fund_quote(&taker, 10 * ONE);
    // one sell works while the vault pays, so the position has fees to claim
    f.c.swap(&taker, &false, &(10 * ONE), &0);
    let before = (
        f.bal_base(&taker),
        f.bal_quote(&taker),
        f.bal_base(&f.pool),
        f.qs(),
        f.bin_rec(Side::Bid, 0),
        f.bin_rec(Side::Bid, -1),
    );
    let pos_before = f.c.get_position(&id);

    v.set_fail_withdraw(&true);
    assert!(f.c.try_swap(&taker, &false, &(20 * ONE), &0).is_err());
    assert!(f.c.try_claim(&maker, &id).is_err());
    assert!(f.c.try_remove_position(&maker, &id).is_err());
    // nothing moved
    let after = (
        f.bal_base(&taker),
        f.bal_quote(&taker),
        f.bal_base(&f.pool),
        f.qs(),
        f.bin_rec(Side::Bid, 0),
        f.bin_rec(Side::Bid, -1),
    );
    assert_eq!(before, after);
    assert_eq!(f.c.get_position(&id), pos_before);

    // the deposit path is independent of the withdrawal path
    f.ask(&maker, 1, 1, 10 * ONE);
    assert!(f.c.try_swap(&taker, &true, &(5 * ONE), &0).is_ok());

    // once the vault works again the swap goes through
    v.set_fail_withdraw(&false);
    assert!(f.c.try_swap(&taker, &false, &(20 * ONE), &0).is_ok());
    assert!(f.c.try_claim(&maker, &id).is_ok());
}

#[test]
fn underpaying_vault_reverts_the_swap() {
    let f = setup_test_vault();
    let v = test_vault(&f);
    let (maker, taker) = (f.user(), f.user());
    f.bid(&maker, 0, 0, 100 * ONE);
    f.fund_base(&taker, 50 * ONE);
    v.set_payout_pct(&50);
    assert_eq!(
        f.c.try_swap(&taker, &false, &(20 * ONE), &0),
        Err(Ok(Error::VaultShortfall.into()))
    );
    assert_eq!(f.bal_base(&taker), 50 * ONE);
    v.set_payout_pct(&0);
    assert!(f.c.try_swap(&taker, &false, &(20 * ONE), &0).is_ok());
}

#[test]
fn vault_asking_for_more_shares_than_exist_is_never_attempted() {
    // TestVault panics on get_asset_amounts_per_shares(shares > supply), like DeFindex does.
    let f = setup_test_vault();
    let (maker, taker) = (f.user(), f.user());
    f.bid(&maker, 0, 3, 40 * ONE);
    f.fund_base(&taker, 100 * ONE);
    for _ in 0..4 {
        // every sell queries the price with the pool's own share count
        let _ = f.c.try_swap(&taker, &false, &(7 * ONE), &0);
        let _ = f.c.quote_swap(&false, &ONE);
        let _ = f.c.tvl();
        let _ = f.c.depth(&Side::Bid, &0, &3);
    }
}

#[test]
fn vault_loss_is_shared_pro_rata() {
    let f = setup_with(10, 10, true);
    let (maker, taker) = (f.user(), f.user());
    let id = f.bid(&maker, 0, 0, 100 * ONE);
    // the vault loses 20 USDC of the 100 held
    mock_vault(&f).slash(&(20 * ONE));
    assert_close(f.c.get_position(&id).inventory, 80 * ONE, 1, "after loss");
    // a seller can only dump what 80 USDC buys
    f.fund_base(&taker, 100 * ONE);
    let q = f.c.quote_swap(&false, &(100 * ONE));
    assert!(q.partial);
    let out = f.c.swap(&taker, &false, &(100 * ONE), &0);
    assert_close(out, 80 * ONE - 80 * ONE / 1000, 3 * ONE / 100, "payout");
    assert!(f.bal_base(&taker) > 0, "the unsold BASE stays with the taker");
    let r = f.c.remove_position(&maker, &id);
    assert_close(r.base, 80 * ONE, ONE / 10, "BASE bought");
    assert!(r.quote < ONE, "nothing but fees left: {}", r.quote);
}

#[test]
fn vault_random_operations_stay_solvent() {
    for seed in [3u64, 11, 99, 4242] {
        let f = setup_with(10, 10, true);
        seed_vault(&f, 10_000 * ONE);
        random_walk(&f, seed, 200, true);
        // the pool never claimed more shares than it can redeem
        let held = mock_vault(&f).balance(&f.pool);
        assert!(held >= f.qs(), "seed {}: vault shares {} < accounted {}", seed, held, f.qs());
    }
}

#[test]
fn vault_random_operations_with_a_dumb_vault() {
    // the private vault prices shares the same way but rounds differently
    let f = setup_test_vault();
    seed_vault(&f, 10_000 * ONE);
    random_walk(&f, 77, 160, true);
}

// ---------------------------------------------------------------------------
// stage D: Mode::TwoWay (two-sided bins with crossback)
// ---------------------------------------------------------------------------

#[test]
fn two_way_crossback_round_trip() {
    let f = setup();
    let (lp, buyer, seller) = (f.user(), f.user(), f.user());
    // 100 BASE over bins 0..4, 20 per bin, as a two-way position
    let id = f.two_way(&lp, Side::Ask, 0, 4, 100 * ONE);
    let p = f.c.get_position(&id);
    assert_eq!(p.mode, Mode::TwoWay);
    assert_eq!((p.inventory, p.pending_proceeds, p.pending_fees), (100 * ONE, 0, 0));
    assert_eq!(f.c.depth(&Side::Ask, &0, &4).len(), 5);
    assert_eq!(f.c.depth(&Side::Bid, &0, &4).len(), 0, "nothing to sell into yet");
    assert!(f.active_tw(Side::Ask).contains(0) && !f.active_tw(Side::Bid).contains(0));

    // buy 20 BASE at bin 0 and 10 BASE at bin 1
    let (p0, p1) = (f.price(0), f.price(1));
    let (q0, q1) = (q_up(20 * ONE, p0), q_up(10 * ONE, p1));
    let budget = q0 + fee_up(q0, 10) + q1 + fee_up(q1, 10);
    f.fund_quote(&buyer, budget);
    let out = f.c.swap(&buyer, &true, &budget, &(30 * ONE));
    assert_eq!(out, 30 * ONE);
    assert_eq!(f.bal_quote(&buyer), 0);

    // the proceeds stayed in the bins as QUOTE reserves: bins 0 and 1 now bid
    let p = f.c.get_position(&id);
    assert_eq!(p.inventory, 70 * ONE, "BASE still held");
    assert_eq!(p.pending_proceeds, q0 + q1, "QUOTE now held (not claimable, it is a reserve)");
    assert_eq!(p.pending_fees, fee_up(q0, 10) + fee_up(q1, 10));
    assert_eq!(p.filled, 30 * ONE);
    assert!(!f.active_tw(Side::Ask).contains(0), "bin 0 sold out");
    assert!(f.active_tw(Side::Ask).contains(1) && f.active_tw(Side::Bid).contains(0));
    assert!(f.active_tw(Side::Bid).contains(1));
    let asks = f.c.depth(&Side::Ask, &0, &4);
    assert_eq!(asks.len(), 4);
    assert_eq!((asks.get(0).unwrap().bin, asks.get(0).unwrap().inventory), (1, 10 * ONE));
    let bids = f.c.depth(&Side::Bid, &0, &4);
    assert_eq!(bids.len(), 2);
    assert_eq!((bids.get(0).unwrap().bin, bids.get(0).unwrap().inventory), (0, q0));
    assert_eq!((bids.get(1).unwrap().bin, bids.get(1).unwrap().inventory), (1, q1));

    // the price comes back: a seller sells 15 BASE, highest bid first (bin 1 then bin 0)
    f.fund_base(&seller, 15 * ONE);
    let quote = f.c.quote_swap(&false, &(15 * ONE));
    assert_eq!(quote.bins_crossed, 2);
    assert!(!quote.partial);
    let back = f.c.swap(&seller, &false, &(15 * ONE), &0);
    assert_eq!(back, quote.amount_out);
    let (qa, qb) = (q_down(10 * ONE, p1), q_down(5 * ONE, p0));
    let payout = (qa - fee_up(qa, 10)) + (qb - fee_up(qb, 10));
    assert_eq!(back, payout);
    assert_eq!(f.bal_quote(&seller), payout);

    // crossback happened: bin 1 holds BASE again (20), bin 0 holds 5 BASE and 15 QUOTE
    let (t0, t1) = (f.tw_rec(0), f.tw_rec(1));
    assert_eq!((t1.x, t1.y), (20 * ONE, 0));
    assert_eq!((t0.x, t0.y), (5 * ONE, q0 - qb));
    assert!(!f.active_tw(Side::Bid).contains(1) && f.active_tw(Side::Bid).contains(0));
    let p = f.c.get_position(&id);
    assert_eq!(p.inventory, 5 * ONE + 20 * ONE + 60 * ONE);
    assert_eq!(p.pending_proceeds, q0 - qb);
    let fees = fee_up(q0, 10) + fee_up(q1, 10) + fee_up(qa, 10) + fee_up(qb, 10);
    assert_eq!(p.pending_fees, fees);
    assert_eq!(p.filled, 30 * ONE + 15 * ONE, "volume in both directions");

    // claim pays the fees only; the holdings stay
    let c = f.c.claim(&lp, &id);
    assert_eq!((c.base, c.quote), (0, fees));
    let p = f.c.get_position(&id);
    assert_eq!((p.inventory, p.pending_proceeds, p.pending_fees), (85 * ONE, q0 - qb, 0));
    let again = f.c.claim(&lp, &id);
    assert_eq!((again.base, again.quote), (0, 0));

    // removal pays both reserves, once
    let r = f.c.remove_position(&lp, &id);
    assert_eq!((r.base, r.quote), (85 * ONE, q0 - qb));
    assert_eq!(f.bal_base(&lp), 85 * ONE);
    assert_eq!(f.bal_quote(&lp), fees + q0 - qb);
    assert!(f.c.try_remove_position(&lp, &id).is_err());
    // the LP took everything the pool held: 100 - 30 sold + 15 bought back = 85 BASE
    assert_eq!(f.bal_base(&f.pool), 0);
    assert_eq!(f.bal_quote(&f.pool), 0);
    assert!(f.active_tw(Side::Ask).is_empty() && f.active_tw(Side::Bid).is_empty());
    // flat round trip: the LP holds 85 BASE + 15 QUOTE (= 100 of value at price ~1.0) plus the fees
    assert_eq!(f.bal_quote(&lp), fees + (q0 - qb));
    assert!(f.bal_quote(&lp) > fees + 14 * ONE && f.bal_quote(&lp) < fees + 16 * ONE);
}

#[test]
fn two_way_and_directional_liquidity_share_a_price() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    let ida = f.ask(&a, 0, 0, 10 * ONE);
    let idb = f.two_way(&b, Side::Ask, 0, 0, 10 * ONE);
    assert_eq!(f.c.get_bin(&Side::Ask, &0).inventory, 20 * ONE, "both are offered at bin 0");
    let d = f.c.depth(&Side::Ask, &0, &0);
    assert_eq!((d.len(), d.get(0).unwrap().inventory), (1, 20 * ONE));
    // a bin that only holds two-way liquidity is in the depth too
    f.two_way(&b, Side::Ask, 3, 3, 5 * ONE);
    assert_eq!(f.c.depth(&Side::Ask, &0, &5).len(), 2);

    // buy 15 BASE: the directional bin goes first, then the two-way bin
    f.fund_quote(&taker, 100 * ONE);
    let budget = 15 * ONE + fee_up(15 * ONE, 10);
    let quote = f.c.quote_swap(&true, &budget);
    assert_eq!((quote.amount_out, quote.bins_crossed), (15 * ONE, 2));
    assert_eq!(f.c.swap(&taker, &true, &budget, &0), 15 * ONE);
    assert_eq!(f.c.get_position(&ida).pending_proceeds, 10 * ONE);
    assert_eq!(f.c.get_position(&ida).inventory, 0);
    let pb = f.c.get_position(&idb);
    assert_eq!((pb.inventory, pb.pending_proceeds), (5 * ONE, 5 * ONE));
    assert_eq!(f.c.get_bin(&Side::Ask, &0).inventory, 5 * ONE);
    assert_eq!(f.c.get_bin(&Side::Bid, &0).inventory, 5 * ONE, "the two-way QUOTE now bids at the same price");

    // the directional ask LP can leave with its proceeds; the two-way LP is unaffected
    let ra = f.c.remove_position(&a, &ida);
    assert_eq!((ra.base, ra.quote), (0, 10 * ONE + fee_up(10 * ONE, 10)));
    let pb2 = f.c.get_position(&idb);
    assert_eq!((pb2.inventory, pb2.pending_proceeds), (5 * ONE, 5 * ONE));
}

#[test]
fn two_way_late_depositor_gets_a_value_share_and_no_old_fees() {
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    let ida = f.two_way(&a, Side::Ask, 0, 0, 100 * ONE);
    f.fund_quote(&taker, 100 * ONE);
    f.c.swap(&taker, &true, &(50 * ONE + fee_up(50 * ONE, 10)), &0);
    let t = f.tw_rec(0);
    assert_eq!((t.x, t.y), (50 * ONE, 50 * ONE));
    let fee_before = f.c.get_position(&ida).pending_fees;
    assert_eq!(fee_before, fee_up(50 * ONE, 10));

    // B adds 50 BASE: the bin is worth 100 BASE at price 1.0, B brings 50, so B owns a third
    let idb = f.two_way(&b, Side::Ask, 0, 0, 50 * ONE);
    let (pa, pb) = (f.c.get_position(&ida), f.c.get_position(&idb));
    assert_eq!(pb.pending_fees, 0, "B does not get A's fees");
    assert_eq!(pa.pending_fees, fee_before);
    assert!((pb.inventory - 100 * ONE / 3).abs() <= 1, "{}", pb.inventory);
    assert!((pb.pending_proceeds - 50 * ONE / 3).abs() <= 1, "{}", pb.pending_proceeds);
    assert!((pa.inventory - 200 * ONE / 3).abs() <= 1, "{}", pa.inventory);
    assert!((pa.pending_proceeds - 100 * ONE / 3).abs() <= 1, "{}", pa.pending_proceeds);
    // the sum of the slices never exceeds the reserves
    let t = f.tw_rec(0);
    assert!(pa.inventory + pb.inventory <= t.x && pa.pending_proceeds + pb.pending_proceeds <= t.y);

    // new fees are shared 2:1
    let seller = f.user();
    f.fund_base(&seller, 30 * ONE);
    f.c.swap(&seller, &false, &(30 * ONE), &0);
    let (pa2, pb2) = (f.c.get_position(&ida), f.c.get_position(&idb));
    let new_fee_a = pa2.pending_fees - fee_before;
    assert!((new_fee_a - 2 * pb2.pending_fees).abs() <= 2, "{} vs {}", new_fee_a, pb2.pending_fees);
    // both can leave and the pool keeps only dust
    f.c.remove_position(&a, &ida);
    f.c.remove_position(&b, &idb);
    assert!(f.bal_base(&f.pool) <= 3 && f.bal_quote(&f.pool) <= 3);
}

#[test]
fn two_way_quote_deposit_into_a_mixed_bin() {
    // a QUOTE deposit is valued in BASE at the bin price
    let f = setup();
    let (a, b, taker) = (f.user(), f.user(), f.user());
    f.two_way(&a, Side::Ask, 0, 0, 100 * ONE);
    f.fund_quote(&taker, 100 * ONE);
    f.c.swap(&taker, &true, &(40 * ONE + fee_up(40 * ONE, 10)), &0);
    // bin 0: 60 BASE + 40 QUOTE = 100 BASE of value; B brings 50 QUOTE = 50 BASE of value
    let idb = f.two_way(&b, Side::Bid, 0, 0, 50 * ONE);
    let pb = f.c.get_position(&idb);
    let value_b = pb.inventory + pb.pending_proceeds; // price 1.0
    assert!((value_b - 50 * ONE).abs() <= 2, "{}", value_b);
    assert_eq!(f.tw_rec(0).y, 90 * ONE);
    // a QUOTE-only deposit into a fresh bin below: a resting bid that flips into an ask when hit
    let idc = f.two_way(&b, Side::Bid, -3, -1, 30 * ONE);
    let pc = f.c.get_position(&idc);
    assert_eq!((pc.inventory, pc.pending_proceeds), (0, 30 * ONE));
    let seller = f.user();
    f.fund_base(&seller, 5 * ONE);
    // the highest bid is bin 0 (90 QUOTE reserve): the sale goes there, not to bins -1..-3
    f.c.swap(&seller, &false, &(5 * ONE), &0);
    assert_eq!(f.tw_rec(-1).y, 10 * ONE);
    assert!(f.tw_rec(0).x > 60 * ONE);
}

#[test]
fn two_way_is_not_available_with_a_vault() {
    let f = setup_with(10, 10, true);
    assert!(!f.c.get_config().supports_two_way);
    let a = f.user();
    f.fund_base(&a, 10 * ONE);
    assert_eq!(
        f.c.try_add_position(&a, &Side::Ask, &Mode::TwoWay, &0, &0, &(10 * ONE), &f.no_weights()),
        Err(Ok(Error::NotImplemented.into()))
    );
    assert_eq!(f.bal_base(&a), 10 * ONE);
}

#[test]
fn two_way_swap_respects_the_bin_cap_and_slippage() {
    let f = setup();
    let (lp, taker) = (f.user(), f.user());
    f.two_way(&lp, Side::Ask, 0, 9, 100 * ONE);
    f.fund_quote(&taker, 1_000 * ONE);
    f.c.set_max_bins_per_swap(&4);
    let q = f.c.quote_swap(&true, &(500 * ONE));
    assert_eq!((q.bins_crossed, q.amount_out, q.partial), (4, 40 * ONE, true));
    assert_eq!(
        f.c.try_swap(&taker, &true, &(500 * ONE), &(41 * ONE)),
        Err(Ok(Error::SlippageExceeded.into()))
    );
    assert_eq!(f.c.swap(&taker, &true, &(500 * ONE), &(40 * ONE)), 40 * ONE);
    // the sold-out bins are now bids, the rest still asks
    assert_eq!(f.c.depth(&Side::Bid, &0, &9).len(), 4);
    assert_eq!(f.c.depth(&Side::Ask, &0, &9).len(), 6);
}

#[test]
fn two_way_random_operations_stay_solvent() {
    for seed in [8u64, 21, 555, 9001, 123456] {
        let f = setup();
        random_walk_modes(&f, seed, 220, false, true);
    }
}

#[test]
fn two_way_random_operations_with_other_fees_and_grids() {
    for (seed, step, fee) in [(31u64, 100u32, 0u32), (32, 1, 1000), (33, 50, 37), (34, 10, 10)] {
        let f = setup_with(step, fee, false);
        random_walk_modes(&f, seed, 180, false, true);
    }
}

/// Deeper fuzzing, off by default: `cargo test -p lotus_pool deep_random_walks -- --ignored`
/// (a few minutes). Directional + two-way on an idle pool, and directional on a vault pool
/// with yield.
#[test]
#[ignore = "slow: run explicitly with -- --ignored"]
fn deep_random_walks() {
    for seed in 1000..1014u64 {
        let f = setup();
        random_walk_modes(&f, seed, 300, false, true);
        let f = setup_with(10, 10, true);
        seed_vault(&f, 10_000 * ONE);
        random_walk_modes(&f, seed + 500, 250, true, false);
        let f = setup_with(25, 7, false);
        random_walk_modes(&f, seed + 900, 250, false, true);
    }
}

// ===========================================================================
// Extreme fuzz (from the independent review) (full grid, huge fee, overlapping LPs, tiny/huge amounts,
// vault yield AND loss while positions are open)
// ===========================================================================

fn log_uniform(rng: &mut Rng, lo: i128, hi: i128) -> i128 {
    // log-uniform integer in [lo, hi]
    let (l, h) = ((lo as f64).ln(), (hi as f64).ln());
    let u = (rng.below(1_000_000) as f64) / 1_000_000.0;
    let v = (l + (h - l) * u).exp() as i128;
    v.clamp(lo, hi)
}

fn extreme_walk(f: &Fx, seed: u64, steps: usize, vault_moves: bool) {
    extreme_walk_tw(f, seed, steps, vault_moves, false)
}

fn extreme_walk_tw(f: &Fx, seed: u64, steps: usize, vault_moves: bool, tw: bool) {
    let mut rng = Rng(seed);
    let makers: StdVec<Address> = (0..6).map(|_| f.user()).collect();
    let takers: StdVec<Address> = (0..3).map(|_| f.user()).collect();
    let donor = f.user();
    let mut open: StdVec<(u64, Address)> = StdVec::new();
    let hot: [i32; 3] = [-3, 0, 5]; // few hot bins so that many LPs overlap
    let tol: i128 = if f.vault.is_some() { 4 } else { 0 };
    let (mut pin_b, mut pout_b, mut pin_q, mut pout_q) = (0i128, 0i128, 0i128, 0i128);
    let mut slashed = 0i128;
    let mut accrued_total = 0i128;
    for step in 0..steps {
        f.env.cost_estimate().budget().reset_unlimited();
        let op = rng.below(100);
        let ctx = std::format!("seed {} step {} op {}", seed, step, op);
        if vault_moves && rng.below(100) < 8 {
            if let Some(v) = &f.vault {
                if rng.below(3) == 0 {
                    // loss (only the mock-ish vault: take a bit of the underlying)
                    let bal = f.bal_quote(v);
                    let amt = bal / (200 + rng.below(800) as i128);
                    if amt > 0 {
                        test_vault(f).slash(&amt);
                        slashed += amt;
                    }
                } else {
                    let amt = log_uniform(&mut rng, 1, 5 * ONE);
                    f.fund_quote(&donor, amt);
                    test_vault(f).accrue(&donor, &amt);
                    accrued_total += amt;
                }
            }
        }
        if op < 30 && open.len() < 60 {
            let owner = makers[rng.below(6) as usize].clone();
            let (lo, hi) = if rng.below(2) == 0 {
                let c = hot[rng.below(3) as usize];
                (c - rng.range(0, 2) as i32, c + rng.range(0, 2) as i32)
            } else {
                let lo = rng.range(-200, 200) as i32;
                let w = rng.range(0, 63) as i32;
                (lo, (lo + w).min(200))
            };
            let n = (hi - lo + 1) as u32;
            let amount = log_uniform(&mut rng, 10_000, 100_000 * ONE);
            let ask = rng.below(2) == 0;
            let weights = if rng.below(3) == 0 {
                let mut w = Vec::new(&f.env);
                for _ in 0..n {
                    w.push_back(if rng.below(4) == 0 { 0 } else { rng.range(1, 1000) as u32 });
                }
                w
            } else {
                f.no_weights()
            };
            if ask { f.fund_base(&owner, amount) } else { f.fund_quote(&owner, amount) }
            let side = if ask { Side::Ask } else { Side::Bid };
            let mode = if tw && rng.below(2) == 0 { Mode::TwoWay } else { Mode::Directional };
            match f.c.try_add_position(&owner, &side, &mode, &lo, &hi, &amount, &weights) {
                Ok(Ok(id)) => {
                    open.push((id, owner));
                    if ask { pin_b += amount } else { pin_q += amount }
                }
                _ => {
                    if ask {
                        TokenClient::new(&f.env, &f.base).transfer(&owner, &donor, &amount);
                    } else {
                        TokenClient::new(&f.env, &f.quote).transfer(&owner, &donor, &amount);
                    }
                }
            }
        } else if op < 70 {
            let taker = takers[rng.below(3) as usize].clone();
            let buy = rng.below(2) == 0;
            let amount = log_uniform(&mut rng, 1, 50_000 * ONE);
            if buy { f.fund_quote(&taker, amount) } else { f.fund_base(&taker, amount) }
            let (qb, qq) = (f.bal_base(&taker), f.bal_quote(&taker));
            let quote = f.c.quote_swap(&buy, &amount);
            match f.c.try_swap(&taker, &buy, &amount, &0) {
                Ok(Ok(out)) => {
                    assert_eq!(out, quote.amount_out, "{}: quote==swap", ctx);
                    let (db, dq) = (f.bal_base(&taker) - qb, f.bal_quote(&taker) - qq);
                    if buy {
                        assert_eq!(db, out, "{}", ctx);
                        pin_q += -dq; pout_b += db;
                    } else {
                        assert_eq!(dq, out, "{}", ctx);
                        pin_b += -db; pout_q += dq;
                    }
                }
                other => {
                    assert_eq!(quote.amount_out, 0, "{}: reverted but quotable {:?}", ctx, other);
                }
            }
            let (lb, lq) = (f.bal_base(&taker), f.bal_quote(&taker));
            if lb > 0 { TokenClient::new(&f.env, &f.base).transfer(&taker, &donor, &lb); }
            if lq > 0 { TokenClient::new(&f.env, &f.quote).transfer(&taker, &donor, &lq); }
        } else if op < 85 && !open.is_empty() {
            let k = rng.below(open.len() as u64) as usize;
            let (id, owner) = open[k].clone();
            let pre = f.c.get_position(&id);
            let paid = f.c.claim(&owner, &id);
            if pre.mode == Mode::TwoWay {
                assert_eq!(paid.base, 0, "{}", ctx);
                assert!(paid.quote <= pre.pending_fees, "{} tw claim {:?} {:?}", ctx, paid, pre);
            } else { match pre.side {
                Side::Ask => assert!(paid.quote <= pre.pending_proceeds + pre.pending_fees + tol, "{} claim ask {:?} {:?}", ctx, paid, pre),
                Side::Bid => {
                    assert!(paid.base <= pre.pending_proceeds, "{}", ctx);
                    assert!(paid.quote <= pre.pending_fees + tol, "{}", ctx);
                }
            } }
            pout_b += paid.base; pout_q += paid.quote;
        } else if !open.is_empty() {
            let k = rng.below(open.len() as u64) as usize;
            let (id, owner) = open.remove(k);
            let pre = f.c.get_position(&id);
            let paid = f.c.remove_position(&owner, &id);
            if pre.mode == Mode::TwoWay {
                assert!(paid.base <= pre.inventory, "{}", ctx);
                assert!(paid.quote <= pre.pending_proceeds + pre.pending_fees, "{} tw rm {:?} {:?}", ctx, paid, pre);
            } else { match pre.side {
                Side::Ask => {
                    assert!(paid.base <= pre.inventory, "{}", ctx);
                    assert!(paid.quote <= pre.pending_proceeds + pre.pending_fees + tol, "{} rm ask {:?} {:?}", ctx, paid, pre);
                }
                Side::Bid => {
                    assert!(paid.base <= pre.pending_proceeds, "{}", ctx);
                    assert!(paid.quote <= pre.inventory + pre.pending_fees + tol, "{} rm bid {:?} {:?}", ctx, paid, pre);
                }
            } }
            pout_b += paid.base; pout_q += paid.quote;
        }
        let ids: StdVec<u64> = open.iter().map(|(id, _)| *id).collect();
        assert_solvent(f, &ids, &ctx);
        // bitmap matches live bins on the touched bins
        for side in [Side::Ask, Side::Bid] {
            let set = f.active(side);
            for bin in [-200, -199, -3, 0, 5, 199, 200] {
                let live = f.bin_rec(side, bin).inventory > 0;
                assert_eq!(set.contains(bin), live, "{}: index {:?} {}", ctx, side, bin);
            }
        }
        let (tw_ask, tw_bid) = (f.active_tw(Side::Ask), f.active_tw(Side::Bid));
        for bin in [-200, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 200] {
            let t = f.tw_rec(bin);
            assert_eq!(tw_ask.contains(bin), t.x > 0, "{}: tw ask idx {}", ctx, bin);
            assert_eq!(tw_bid.contains(bin), t.y > 0, "{}: tw bid idx {}", ctx, bin);
        }
    }
    for (id, owner) in open.clone() {
        let paid = f.c.remove_position(&owner, &id);
        pout_b += paid.base; pout_q += paid.quote;
    }
    let dust_b = f.bal_base(&f.pool);
    let dust_q = f.tvl_quote();
    std::println!(
        "extreme seed {}: dust base {} quote {} (in b {} q {}, out b {} q {}) slashed {} accrued {}",
        seed, dust_b, dust_q, pin_b, pin_q, pout_b, pout_q, slashed, accrued_total
    );
    assert!(dust_b >= 0 && dust_q >= 0);
    if f.vault.is_none() {
        assert_eq!(pin_b - pout_b, dust_b);
        assert_eq!(pin_q - pout_q, dust_q);
    }
}

#[test]
fn extreme_idle_walks() {
    for (seed, step, fee) in [(1u64, 100u32, 1000u32), (2, 1, 0), (3, 10, 10), (4, 50, 333), (5, 100, 0)] {
        let f = setup_with(step, fee, false);
        extreme_walk(&f, seed, 400, false);
    }
}

#[test]
fn extreme_vault_walks_with_yield_and_loss() {
    for seed in [11u64, 12, 13] {
        let f = setup_test_vault();
        seed_vault(&f, 50 * ONE); // small vault so rounding bites
        extreme_walk(&f, seed, 300, true);
    }
}

#[test]
fn extreme_two_way_walks() {
    for (seed, step, fee) in [(21u64, 100u32, 1000u32), (22, 1, 0), (23, 10, 10), (24, 50, 333)] {
        let f = setup_with(step, fee, false);
        extreme_walk_tw(&f, seed, 400, false, true);
    }
}

// ===========================================================================
// Documented limitations (from the independent review): these tests assert the
// CURRENT behaviour so that it cannot change unnoticed; see "Known limitations
// from review" in contracts/lotus_pool/README.md.
// ===========================================================================
use soroban_sdk::testutils::{IssuerFlags, StellarAssetContract as _};

/// Pool whose BASE asset has AUTH_REQUIRED + REVOCABLE (like LBOND).
fn setup_regulated<'a>() -> (Fx<'a>, soroban_sdk::testutils::StellarAssetContract) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let base_sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    base_sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    base_sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    base_sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    let base = base_sac.address();
    let quote = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let pool = env.register(LotusPool, (admin.clone(), base.clone(), quote.clone(), None::<Address>, 10u32, 10u32));
    let c = LotusPoolClient::new(&env, &pool);
    // issuer authorises the pool
    StellarAssetClient::new(&env, &base).set_authorized(&pool, &true);
    (Fx { env, admin, base, quote, vault: None, pool, c }, base_sac)
}

/// LIMITATION (a): a Bid LP whose LBOND leg cannot be delivered (trustline revoked, or the
/// pool's own LBOND balance was clawed back) cannot recover its USDC either, because
/// `remove_position` / `claim` pay BASE first and the whole call reverts.
#[test]
fn limitation_bid_lp_usdc_trapped_when_base_proceeds_cannot_be_delivered() {
    let (f, _sac) = setup_regulated();
    let (lp, taker) = (f.user(), f.user());
    let sac = StellarAssetClient::new(&f.env, &f.base);
    sac.set_authorized(&lp, &true);
    sac.set_authorized(&taker, &true);
    let id = f.bid(&lp, -5, -1, 100 * ONE);
    f.fund_base(&taker, 10 * ONE);
    f.c.swap(&taker, &false, &(10 * ONE), &0); // taker sells 10 LBOND into the bid: LP earns BASE
    // issuer revokes the LP's LBOND authorization (compliance event)
    sac.set_authorized(&lp, &false);
    assert!(f.c.try_claim(&lp, &id).is_err(), "claim reverts");
    let r = f.c.try_remove_position(&lp, &id);
    assert!(r.is_err(), "remove_position reverts: ~90 USDC of inventory is stuck until re-authorised");
    // sanity: after re-authorisation it works
    sac.set_authorized(&lp, &true);
    let paid = f.c.remove_position(&lp, &id);
    assert!(paid.quote > 85 * ONE && paid.base > 9 * ONE);
}

/// LIMITATION (a): pool's LBOND balance clawed back -> every Bid LP with BASE proceeds is stuck,
/// every Ask LP cannot remove (claim of Ask proceeds still works).
#[test]
fn limitation_clawback_of_pool_balance_blocks_bid_and_ask_removals() {
    let (f, _sac) = setup_regulated();
    let (bid_lp, ask_lp, taker) = (f.user(), f.user(), f.user());
    let sac = StellarAssetClient::new(&f.env, &f.base);
    for a in [&bid_lp, &ask_lp, &taker] { sac.set_authorized(a, &true); }
    let bid = f.bid(&bid_lp, -5, -1, 100 * ONE);
    let ask = f.ask(&ask_lp, 1, 5, 100 * ONE);
    f.fund_base(&taker, 10 * ONE);
    f.c.swap(&taker, &false, &(10 * ONE), &0);
    // issuer claws back the pool's whole LBOND balance
    let bal = f.bal_base(&f.pool);
    sac.clawback(&f.pool, &bal);
    assert!(f.c.try_remove_position(&bid_lp, &bid).is_err());
    assert!(f.c.try_remove_position(&ask_lp, &ask).is_err());
    // a claim of an Ask without proceeds is fine; bid claim reverts
    assert!(f.c.try_claim(&bid_lp, &bid).is_err());
}

/// LIMITATION (d): 100 one-cent Bid bins above the real liquidity eat the whole bin budget.
#[test]
fn limitation_junk_bins_eat_the_swap_bin_budget() {
    let f = setup_with(10, 10, false);
    let (honest, spammer, taker) = (f.user(), f.user(), f.user());
    f.bid(&honest, -10, -1, 1000 * ONE);
    // attacker: 100 owners' worth of positions: 64 + 36 bins at the highest prices, 0.001 each
    let a = f.bid(&spammer, 137, 200, 64 * 10_000);
    let b = f.bid(&spammer, 101, 136, 36 * 10_000);
    let _ = (a, b);
    f.fund_base(&taker, 500 * ONE);
    let q = f.c.quote_swap(&false, &(500 * ONE));
    assert_eq!(q.bins_crossed, 100);
    assert!(q.partial);
    assert!(q.amount_out < ONE, "everything went to the junk bins");
}

/// LIMITATION (c): a TwoWay deposit into a bin that holds the other asset is a
/// fee-free swap at the bin price, and the existing LP loses the fee it would have earned.
#[test]
fn limitation_two_way_deposit_withdraw_is_a_fee_free_swap() {
    let f = setup_with(10, 10, false);
    let (lp1, buyer, lp2) = (f.user(), f.user(), f.user());
    let _id1 = f.two_way(&lp1, Side::Ask, 0, 0, 100 * ONE);
    f.fund_quote(&buyer, 200 * ONE);
    f.c.swap(&buyer, &true, &(100 * ONE), &0); // bin now holds ~99.9 USDC, ~0.1 BASE left
    let t = f.tw_rec(0);
    // LP2 deposits BASE and leaves straight away: a sell of ~half of it at the bin price
    let id2 = f.two_way(&lp2, Side::Ask, 0, 0, 100 * ONE);
    let paid = f.c.remove_position(&lp2, &id2);
    // a taker selling the same BASE would have paid fee_bps (0.1 percent)
    assert!(paid.quote > 49 * ONE, "lp2 sold ~50 BASE at the bin price without fee");
}
