#![no_std]
//! `mock_vault` - a minimal DeFindex-compatible single-asset vault.
//!
//! It exposes the subset of the DeFindex vault interface that `lotus_vault`
//! relies on (`deposit`, `withdraw`, `balance`, `total_supply`,
//! `get_asset_amounts_per_shares`) with identical signatures, plus two helpers
//! to simulate yield (`accrue`) and losses (`slash`). The share price is
//! simply `token.balance(vault) / total_shares`, so sending underlying into the
//! vault raises the price of every share, exactly like interest accruing in a
//! lending position.
//!
//! Used by the `lotus_vault` unit tests and as a fallback for local demos.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, vec, Address,
    Env, Vec,
};

const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const LIFETIME_THRESHOLD: u32 = BUMP_AMOUNT - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Underlying,
    TotalShares,
    Shares(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MockError {
    InvalidAmount = 1,
    InsufficientShares = 2,
    SlippageExceeded = 3,
    ArgsMismatch = 4,
    Overflow = 5,
}

#[contract]
pub struct MockVault;

fn extend_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

fn underlying(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Underlying).unwrap()
}

fn total_shares(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalShares)
        .unwrap_or(0)
}

fn shares_of(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Shares(id.clone()))
        .unwrap_or(0)
}

fn set_shares(env: &Env, id: &Address, amount: i128) {
    let key = DataKey::Shares(id.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage()
        .persistent()
        .extend_ttl(&key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
}

/// Underlying actually held by the vault = the only source of truth for value.
fn total_assets(env: &Env) -> i128 {
    token::TokenClient::new(env, &underlying(env)).balance(&env.current_contract_address())
}

fn mul_div(env: &Env, a: i128, b: i128, c: i128) -> i128 {
    a.checked_mul(b)
        .and_then(|x| x.checked_div(c))
        .unwrap_or_else(|| panic_with_error!(env, MockError::Overflow))
}

#[contractimpl]
impl MockVault {
    pub fn __constructor(env: Env, admin: Address, underlying: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Underlying, &underlying);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        extend_ttl(&env);
    }

    /// DeFindex-compatible deposit (single asset: `amounts_desired[0]`).
    /// Returns `(amounts_deposited, shares_minted, None)`.
    pub fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        amounts_min: Vec<i128>,
        from: Address,
        _invest: bool,
    ) -> (Vec<i128>, i128, Option<Vec<i128>>) {
        from.require_auth();
        extend_ttl(&env);
        if amounts_desired.len() != 1 || amounts_min.len() != 1 {
            panic_with_error!(&env, MockError::ArgsMismatch);
        }
        let amount = amounts_desired.get_unchecked(0);
        if amount <= 0 {
            panic_with_error!(&env, MockError::InvalidAmount);
        }

        let assets_before = total_assets(&env);
        let supply = total_shares(&env);
        let shares = if supply == 0 || assets_before == 0 {
            amount
        } else {
            mul_div(&env, amount, supply, assets_before)
        };

        token::TokenClient::new(&env, &underlying(&env))
            .transfer(&from, &env.current_contract_address(), &amount);

        set_shares(&env, &from, shares_of(&env, &from) + shares);
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(supply + shares));

        (vec![&env, amount], shares, None)
    }

    /// DeFindex-compatible withdraw: burns `withdraw_shares` and pays the
    /// pro-rata underlying to `from`. Returns `[amount_out]`.
    pub fn withdraw(
        env: Env,
        withdraw_shares: i128,
        min_amounts_out: Vec<i128>,
        from: Address,
    ) -> Vec<i128> {
        from.require_auth();
        extend_ttl(&env);
        let held = shares_of(&env, &from);
        if withdraw_shares <= 0 {
            panic_with_error!(&env, MockError::InvalidAmount);
        }
        if withdraw_shares > held {
            panic_with_error!(&env, MockError::InsufficientShares);
        }
        let supply = total_shares(&env);
        let amount = mul_div(&env, withdraw_shares, total_assets(&env), supply);
        let min_out = min_amounts_out.get(0).unwrap_or(0);
        if amount < min_out {
            panic_with_error!(&env, MockError::SlippageExceeded);
        }

        set_shares(&env, &from, held - withdraw_shares);
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(supply - withdraw_shares));
        token::TokenClient::new(&env, &underlying(&env))
            .transfer(&env.current_contract_address(), &from, &amount);

        vec![&env, amount]
    }

    /// Vault shares held by `id`.
    pub fn balance(env: Env, id: Address) -> i128 {
        shares_of(&env, &id)
    }

    /// Total vault shares outstanding.
    pub fn total_supply(env: Env) -> i128 {
        total_shares(&env)
    }

    /// Underlying value of `vault_shares`, as `[amount]`.
    pub fn get_asset_amounts_per_shares(env: Env, vault_shares: i128) -> Vec<i128> {
        let supply = total_shares(&env);
        if supply == 0 {
            return vec![&env, 0];
        }
        vec![&env, mul_div(&env, vault_shares, total_assets(&env), supply)]
    }

    /// Simulate yield: anyone can push `amount` of underlying into the vault,
    /// which raises the share price for every holder.
    pub fn accrue(env: Env, from: Address, amount: i128) {
        from.require_auth();
        extend_ttl(&env);
        if amount <= 0 {
            panic_with_error!(&env, MockError::InvalidAmount);
        }
        token::TokenClient::new(&env, &underlying(&env))
            .transfer(&from, &env.current_contract_address(), &amount);
    }

    /// Simulate a loss: the admin pulls `amount` of underlying out of the
    /// vault, which lowers the share price for every holder.
    pub fn slash(env: Env, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        extend_ttl(&env);
        if amount <= 0 {
            panic_with_error!(&env, MockError::InvalidAmount);
        }
        token::TokenClient::new(&env, &underlying(&env))
            .transfer(&env.current_contract_address(), &admin, &amount);
    }
}
