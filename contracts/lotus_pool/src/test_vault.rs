#![cfg(test)]
//! Private DeFindex-compatible vault used by the pool tests: same surface as
//! `mock_vault`, plus knobs to make it misbehave and call counters.

use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec, Address, Env, Vec,
};

#[contracttype]
#[derive(Clone)]
enum K {
    Admin,
    Underlying,
    Supply,
    Shares(Address),
    FailWithdraw,
    PayoutPct,
    Deposits,
    Withdraws,
    Views,
}

#[contract]
pub struct TestVault;

fn get_i(env: &Env, k: &K) -> i128 {
    env.storage().instance().get(k).unwrap_or(0)
}
fn put_i(env: &Env, k: &K, v: i128) {
    env.storage().instance().set(k, &v);
}
fn underlying(env: &Env) -> Address {
    env.storage().instance().get(&K::Underlying).unwrap()
}
fn assets(env: &Env) -> i128 {
    token::TokenClient::new(env, &underlying(env)).balance(&env.current_contract_address())
}
fn shares_of(env: &Env, a: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&K::Shares(a.clone()))
        .unwrap_or(0)
}

#[contractimpl]
impl TestVault {
    pub fn __constructor(env: Env, admin: Address, underlying: Address) {
        env.storage().instance().set(&K::Admin, &admin);
        env.storage().instance().set(&K::Underlying, &underlying);
    }

    pub fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        _amounts_min: Vec<i128>,
        from: Address,
        _invest: bool,
    ) -> (Vec<i128>, i128, Option<Vec<i128>>) {
        from.require_auth();
        put_i(&env, &K::Deposits, get_i(&env, &K::Deposits) + 1);
        let amount = amounts_desired.get_unchecked(0);
        let supply = get_i(&env, &K::Supply);
        let before = assets(&env);
        let shares = if supply == 0 || before == 0 {
            amount
        } else {
            amount * supply / before
        };
        token::TokenClient::new(&env, &underlying(&env)).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        env.storage()
            .persistent()
            .set(&K::Shares(from.clone()), &(shares_of(&env, &from) + shares));
        put_i(&env, &K::Supply, supply + shares);
        (vec![&env, amount], shares, None)
    }

    pub fn withdraw(
        env: Env,
        withdraw_shares: i128,
        _min_amounts_out: Vec<i128>,
        from: Address,
    ) -> Vec<i128> {
        from.require_auth();
        put_i(&env, &K::Withdraws, get_i(&env, &K::Withdraws) + 1);
        if env.storage().instance().get(&K::FailWithdraw).unwrap_or(false) {
            panic!("vault withdrawal disabled");
        }
        let supply = get_i(&env, &K::Supply);
        let mut amount = withdraw_shares * assets(&env) / supply;
        let pct = get_i(&env, &K::PayoutPct);
        if pct > 0 {
            amount = amount * pct / 100;
        }
        env.storage().persistent().set(
            &K::Shares(from.clone()),
            &(shares_of(&env, &from) - withdraw_shares),
        );
        put_i(&env, &K::Supply, supply - withdraw_shares);
        token::TokenClient::new(&env, &underlying(&env)).transfer(
            &env.current_contract_address(),
            &from,
            &amount,
        );
        vec![&env, amount]
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        shares_of(&env, &id)
    }

    pub fn total_supply(env: Env) -> i128 {
        get_i(&env, &K::Supply)
    }

    pub fn get_asset_amounts_per_shares(env: Env, vault_shares: i128) -> Vec<i128> {
        put_i(&env, &K::Views, get_i(&env, &K::Views) + 1);
        let supply = get_i(&env, &K::Supply);
        // like DeFindex: asking for more than the total supply is an error
        if vault_shares > supply {
            panic!("amount over total supply");
        }
        if supply == 0 {
            return vec![&env, 0];
        }
        vec![&env, vault_shares * assets(&env) / supply]
    }

    // ---- test knobs ----

    pub fn accrue(env: Env, from: Address, amount: i128) {
        from.require_auth();
        token::TokenClient::new(&env, &underlying(&env)).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
    }

    pub fn slash(env: Env, amount: i128) {
        let admin: Address = env.storage().instance().get(&K::Admin).unwrap();
        token::TokenClient::new(&env, &underlying(&env)).transfer(
            &env.current_contract_address(),
            &admin,
            &amount,
        );
    }

    pub fn set_fail_withdraw(env: Env, fail: bool) {
        env.storage().instance().set(&K::FailWithdraw, &fail);
    }

    /// pay only `pct` percent of what a withdrawal is worth (a broken vault)
    pub fn set_payout_pct(env: Env, pct: i128) {
        put_i(&env, &K::PayoutPct, pct);
    }

    /// (deposit calls, withdraw calls, get_asset_amounts_per_shares calls)
    pub fn calls(env: Env) -> (i128, i128, i128) {
        (
            get_i(&env, &K::Deposits),
            get_i(&env, &K::Withdraws),
            get_i(&env, &K::Views),
        )
    }

    pub fn reset_calls(env: Env) {
        put_i(&env, &K::Deposits, 0);
        put_i(&env, &K::Withdraws, 0);
        put_i(&env, &K::Views, 0);
    }
}
