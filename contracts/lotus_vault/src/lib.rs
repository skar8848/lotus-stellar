#![no_std]
//! # Lotus vault
//!
//! A yield-bearing receipt token for Stellar's native orderbook (SDEX).
//!
//! This contract is the Soroban **admin of a classic Stellar asset** (the
//! receipt, e.g. `lUSDC`). Users deposit the underlying (USDC or XLM), the
//! contract parks it in a DeFindex vault (which lends on Blend) and mints the
//! receipt 1:1. Users redeem the receipt to get the underlying back. Yield
//! accrues inside the DeFindex position; a keeper calls [`LotusVault::distribute`]
//! to mint the surplus to receipt holders pro-rata. The holder list is computed
//! off-chain, but every amount is **capped on-chain** by
//! `surplus * receipt.balance(holder) / supply`, so the keeper can only omit
//! holders, never over-pay anybody.
//!
//! Because SDEX offers never leave the account (they only create selling
//! liabilities), an open limit order denominated in the receipt keeps earning
//! yield.
//!
//! ## Invariants
//! * `supply()` == receipts minted by this contract minus receipts burnt.
//! * `vault_value()` == underlying value of our df shares + idle underlying.
//! * `surplus()` == `max(0, vault_value() - supply())`.
//! * `deposit` and `redeem` never change `surplus()` (except rounding dust in
//!   favour of the vault); only yield accrual and `distribute` do.
//! * Every receipt is backed 1:1 while `vault_value() >= supply()`; if the
//!   DeFindex position ever loses value, redemptions pay pro-rata.

mod defindex;
mod test;

use defindex::DeFindexVaultClient;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, token, vec, Address, Env, IntoVal, Map, Vec,
};

pub const DAY_IN_LEDGERS: u32 = 17280;
pub const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub keeper: Address,
    /// SAC of the underlying asset (USDC or native XLM).
    pub underlying: Address,
    /// SAC of the classic receipt asset; this contract must be its admin.
    pub receipt: Address,
    /// DeFindex vault contract holding the underlying.
    pub vault: Address,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Supply,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    InvalidAmount = 2,
    InsufficientSupply = 3,
    LengthMismatch = 4,
    InsufficientSurplus = 5,
    ExceedsCap = 6,
    ZeroSupply = 7,
    Overflow = 8,
    NoVaultPosition = 9,
}

/// Emitted on every deposit. Topics: `["deposit", from]`.
#[contractevent(topics = ["deposit"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposit {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub shares: i128,
}

/// Emitted on every redemption. Topics: `["redeem", from]`.
#[contractevent(topics = ["redeem"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Redeem {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub paid: i128,
}

/// Emitted on every yield distribution. Topics: `["distribute"]`.
#[contractevent(topics = ["distribute"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Distribute {
    pub total: i128,
    pub surplus_before: i128,
    pub recipients: u32,
}

/// Emitted when the admin rotates the keeper. Topics: `["set_keeper"]`.
#[contractevent(topics = ["set_keeper"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetKeeper {
    pub keeper: Address,
}

#[contract]
pub struct LotusVault;

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

fn extend_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn read_supply(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Supply).unwrap_or(0)
}

fn write_supply(env: &Env, supply: i128) {
    env.storage().instance().set(&DataKey::Supply, &supply);
}

/// floor(a * b / c), aborting with `Overflow` instead of wrapping.
fn mul_div(env: &Env, a: i128, b: i128, c: i128) -> i128 {
    a.checked_mul(b)
        .and_then(|x| x.checked_div(c))
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

/// ceil(a * b / c), aborting with `Overflow` instead of wrapping.
fn mul_div_ceil(env: &Env, a: i128, b: i128, c: i128) -> i128 {
    let num = a
        .checked_mul(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow));
    let q = num / c;
    if num % c == 0 {
        q
    } else {
        q + 1
    }
}

// ---------------------------------------------------------------------------
// DeFindex plumbing
// ---------------------------------------------------------------------------

/// Underlying value of our DeFindex position plus any idle underlying held by
/// this contract (dust from redemptions, direct donations).
fn vault_value_inner(env: &Env, cfg: &Config) -> i128 {
    let this = env.current_contract_address();
    let vault = DeFindexVaultClient::new(env, &cfg.vault);
    let shares = vault.balance(&this);
    let position = if shares > 0 {
        vault
            .get_asset_amounts_per_shares(&shares)
            .get(0)
            .unwrap_or(0)
    } else {
        0
    };
    let idle = token::TokenClient::new(env, &cfg.underlying).balance(&this);
    position
        .checked_add(idle)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn surplus_inner(env: &Env, cfg: &Config) -> i128 {
    let value = vault_value_inner(env, cfg);
    let supply = read_supply(env);
    if value > supply {
        value - supply
    } else {
        0
    }
}

/// Deposit `amount` underlying (already held by this contract) into DeFindex.
/// Returns the df shares minted to us.
fn vault_deposit(env: &Env, cfg: &Config, amount: i128) -> i128 {
    let this = env.current_contract_address();
    // DeFindex pulls the underlying from `from` (= us) with a nested
    // `transfer(this, vault, amount)` that it invokes itself. We are not the
    // direct invoker of that token call, so we have to pre-authorise it.
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: cfg.underlying.clone(),
                fn_name: symbol_short!("transfer"),
                args: (this.clone(), cfg.vault.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);
    let (_amounts, shares, _allocations) = DeFindexVaultClient::new(env, &cfg.vault).deposit(
        &vec![env, amount],
        &vec![env, 0],
        &this,
        &true,
    );
    shares
}

/// Withdraw enough df shares to receive at least `need` underlying (rounded
/// up by one share so rounding never short-changes the redeemer; any excess
/// stays in the contract and counts towards `surplus()`).
fn vault_withdraw_at_least(env: &Env, cfg: &Config, need: i128) -> i128 {
    let this = env.current_contract_address();
    let vault = DeFindexVaultClient::new(env, &cfg.vault);
    let held = vault.balance(&this);
    if held <= 0 {
        panic_with_error!(env, Error::NoVaultPosition);
    }
    let position = vault
        .get_asset_amounts_per_shares(&held)
        .get(0)
        .unwrap_or(0);
    let mut shares = if position <= 0 || need >= position {
        held
    } else {
        mul_div_ceil(env, need, held, position) + 1
    };
    if shares > held {
        shares = held;
    }
    vault
        .withdraw(&shares, &vec![env, 0], &this)
        .get(0)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

#[contractimpl]
impl LotusVault {
    /// * `admin`      - can rotate the keeper.
    /// * `keeper`     - the only address allowed to call `distribute`.
    /// * `underlying` - SAC address of the deposit asset (USDC or native XLM).
    /// * `receipt`    - SAC address of the classic receipt asset. After
    ///                  deployment the issuer must `set_admin` it to this
    ///                  contract, otherwise `deposit` cannot mint.
    /// * `vault`      - DeFindex vault whose single asset is `underlying`.
    pub fn __constructor(
        env: Env,
        admin: Address,
        keeper: Address,
        underlying: Address,
        receipt: Address,
        vault: Address,
    ) {
        let cfg = Config {
            admin,
            keeper,
            underlying,
            receipt,
            vault,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage().instance().set(&DataKey::Supply, &0i128);
        extend_ttl(&env);
    }

    /// Deposit `amount` underlying from `from`, invest it in DeFindex and mint
    /// `amount` receipt to `from`. Returns the df shares received.
    pub fn deposit(env: Env, from: Address, amount: i128) -> i128 {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        extend_ttl(&env);
        let cfg = config(&env);
        let this = env.current_contract_address();

        // 1. pull the underlying from the user
        token::TokenClient::new(&env, &cfg.underlying).transfer(&from, &this, &amount);

        // 2. invest it
        let shares = vault_deposit(&env, &cfg, amount);

        // 3. mint the receipt 1:1 (we are the SAC admin, so no signature needed)
        token::StellarAssetClient::new(&env, &cfg.receipt).mint(&from, &amount);
        let supply = read_supply(&env)
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        write_supply(&env, supply);

        Deposit {
            from,
            amount,
            shares,
        }
        .publish(&env);
        shares
    }

    /// Burn `amount` receipt from `from` and pay back the underlying.
    /// Pays 1:1 while the position is fully backed, pro-rata otherwise.
    /// Returns the underlying actually sent.
    pub fn redeem(env: Env, from: Address, amount: i128) -> i128 {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        extend_ttl(&env);
        let cfg = config(&env);
        let this = env.current_contract_address();
        let supply = read_supply(&env);
        if amount > supply {
            panic_with_error!(&env, Error::InsufficientSupply);
        }

        // value the position *before* changing anything
        let value = vault_value_inner(&env, &cfg);
        let owed = if value >= supply {
            amount
        } else {
            mul_div(&env, amount, value, supply)
        };

        // burn the receipt (needs `from`'s auth, nested under this call)
        token::TokenClient::new(&env, &cfg.receipt).burn(&from, &amount);
        write_supply(&env, supply - amount);

        let mut paid = 0i128;
        if owed > 0 {
            let underlying = token::TokenClient::new(&env, &cfg.underlying);
            // pay from idle underlying first, pull the rest out of DeFindex
            let idle = underlying.balance(&this);
            if idle < owed {
                vault_withdraw_at_least(&env, &cfg, owed - idle);
            }
            let available = underlying.balance(&this);
            paid = if available < owed { available } else { owed };
            if paid > 0 {
                underlying.transfer(&this, &from, &paid);
            }
        }

        Redeem { from, amount, paid }.publish(&env);
        paid
    }

    /// Keeper-only: mint accrued yield to receipt holders.
    ///
    /// `amounts[i]` is minted to `recipients[i]`. The call aborts unless
    /// `sum(amounts) <= surplus()` and, for every recipient, the cumulative
    /// amount `<= surplus() * receipt.balance(recipient) / supply()` measured
    /// before any minting. Returns the total minted.
    pub fn distribute(env: Env, recipients: Vec<Address>, amounts: Vec<i128>) -> i128 {
        let cfg = config(&env);
        cfg.keeper.require_auth();
        extend_ttl(&env);
        if recipients.len() != amounts.len() {
            panic_with_error!(&env, Error::LengthMismatch);
        }
        let supply = read_supply(&env);
        if supply <= 0 {
            panic_with_error!(&env, Error::ZeroSupply);
        }
        let surplus = surplus_inner(&env, &cfg);
        let receipt_token = token::TokenClient::new(&env, &cfg.receipt);

        // pass 1: validate every line against the on-chain cap, using balances
        // snapshotted before any mint and summing duplicates per recipient
        let mut total: i128 = 0;
        let mut given: Map<Address, i128> = Map::new(&env);
        for i in 0..amounts.len() {
            let amt = amounts.get_unchecked(i);
            let to = recipients.get_unchecked(i);
            if amt < 0 {
                panic_with_error!(&env, Error::InvalidAmount);
            }
            let cum = given
                .get(to.clone())
                .unwrap_or(0)
                .checked_add(amt)
                .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
            let cap = mul_div(&env, surplus, receipt_token.balance(&to), supply);
            if cum > cap {
                panic_with_error!(&env, Error::ExceedsCap);
            }
            given.set(to, cum);
            total = total
                .checked_add(amt)
                .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        }
        if total > surplus {
            panic_with_error!(&env, Error::InsufficientSurplus);
        }

        // pass 2: mint
        let receipt = token::StellarAssetClient::new(&env, &cfg.receipt);
        for i in 0..amounts.len() {
            let amt = amounts.get_unchecked(i);
            if amt > 0 {
                receipt.mint(&recipients.get_unchecked(i), &amt);
            }
        }
        write_supply(&env, supply + total);

        Distribute {
            total,
            surplus_before: surplus,
            recipients: amounts.len(),
        }
        .publish(&env);
        total
    }

    /// `max(0, vault_value() - supply())`: yield not yet distributed.
    pub fn surplus(env: Env) -> i128 {
        let cfg = config(&env);
        surplus_inner(&env, &cfg)
    }

    /// Underlying value of our DeFindex shares plus idle underlying held here.
    pub fn vault_value(env: Env) -> i128 {
        let cfg = config(&env);
        vault_value_inner(&env, &cfg)
    }

    /// Receipts minted by this contract and still outstanding.
    pub fn supply(env: Env) -> i128 {
        read_supply(&env)
    }

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    /// Admin-only: rotate the keeper.
    pub fn set_keeper(env: Env, new_keeper: Address) {
        let mut cfg = config(&env);
        cfg.admin.require_auth();
        extend_ttl(&env);
        cfg.keeper = new_keeper.clone();
        env.storage().instance().set(&DataKey::Config, &cfg);
        SetKeeper { keeper: new_keeper }.publish(&env);
    }
}
