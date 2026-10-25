#![cfg(test)]

use super::*;
use mock_vault::{MockVault, MockVaultClient};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{vec, Address, Env, IntoVal};

/// 7 decimals, like every classic Stellar asset.
const ONE: i128 = 10_000_000;

struct Fixture {
    admin: Address,
    keeper: Address,
    underlying: Address,
    receipt: Address,
    vault: Address,
    lotus: Address,
}

/// Registers: underlying SAC, receipt SAC (admin handed to the lotus
/// contract), mock DeFindex vault and the lotus vault itself.
fn setup(env: &Env) -> Fixture {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let keeper = Address::generate(env);
    let underlying_issuer = Address::generate(env);
    let receipt_issuer = Address::generate(env);

    let underlying = env
        .register_stellar_asset_contract_v2(underlying_issuer)
        .address();
    let receipt = env
        .register_stellar_asset_contract_v2(receipt_issuer)
        .address();
    let vault = env.register(MockVault, (admin.clone(), underlying.clone()));
    let lotus = env.register(
        LotusVault,
        (
            admin.clone(),
            keeper.clone(),
            underlying.clone(),
            receipt.clone(),
            vault.clone(),
        ),
    );
    // the lotus contract becomes the only minter of the receipt
    StellarAssetClient::new(env, &receipt).set_admin(&lotus);

    Fixture {
        admin,
        keeper,
        underlying,
        receipt,
        vault,
        lotus,
    }
}

fn fund(env: &Env, f: &Fixture, to: &Address, amount: i128) {
    StellarAssetClient::new(env, &f.underlying).mint(to, &amount);
}

fn underlying_bal(env: &Env, f: &Fixture, who: &Address) -> i128 {
    TokenClient::new(env, &f.underlying).balance(who)
}

fn receipt_bal(env: &Env, f: &Fixture, who: &Address) -> i128 {
    TokenClient::new(env, &f.receipt).balance(who)
}

#[test]
fn config_is_stored() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let cfg = lotus.get_config();
    assert_eq!(cfg.admin, f.admin);
    assert_eq!(cfg.keeper, f.keeper);
    assert_eq!(cfg.underlying, f.underlying);
    assert_eq!(cfg.receipt, f.receipt);
    assert_eq!(cfg.vault, f.vault);
    assert_eq!(lotus.supply(), 0);
    assert_eq!(lotus.vault_value(), 0);
    assert_eq!(lotus.surplus(), 0);
}

#[test]
fn deposit_mints_receipt_one_to_one() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let vault = MockVaultClient::new(&env, &f.vault);
    let user = Address::generate(&env);
    fund(&env, &f, &user, 1_000 * ONE);

    let shares = lotus.deposit(&user, &(1_000 * ONE));

    assert_eq!(shares, 1_000 * ONE, "first deposit into an empty mock vault is 1:1");
    assert_eq!(receipt_bal(&env, &f, &user), 1_000 * ONE);
    assert_eq!(underlying_bal(&env, &f, &user), 0);
    assert_eq!(underlying_bal(&env, &f, &f.lotus), 0, "nothing idle: all invested");
    assert_eq!(underlying_bal(&env, &f, &f.vault), 1_000 * ONE);
    assert_eq!(vault.balance(&f.lotus), 1_000 * ONE);
    assert_eq!(lotus.supply(), 1_000 * ONE);
    assert_eq!(lotus.vault_value(), 1_000 * ONE);
    assert_eq!(lotus.surplus(), 0);
}

#[test]
fn deposit_with_explicit_auth_tree() {
    // Same as above but with a real (non-mocked) auth tree for the user, so
    // the contract's own `authorize_as_current_contract` for the nested
    // vault -> token transfer is actually exercised.
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let user = Address::generate(&env);
    fund(&env, &f, &user, 500 * ONE);

    let amount: i128 = 500 * ONE;
    env.mock_auths(&[MockAuth {
        address: &user,
        invoke: &MockAuthInvoke {
            contract: &f.lotus,
            fn_name: "deposit",
            args: (user.clone(), amount).into_val(&env),
            sub_invokes: &[MockAuthInvoke {
                contract: &f.underlying,
                fn_name: "transfer",
                args: (user.clone(), f.lotus.clone(), amount).into_val(&env),
                sub_invokes: &[],
            }],
        },
    }]);
    lotus.deposit(&user, &amount);
    assert_eq!(receipt_bal(&env, &f, &user), amount);
    assert_eq!(lotus.vault_value(), amount);
}

#[test]
fn redeem_returns_underlying() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let user = Address::generate(&env);
    fund(&env, &f, &user, 1_000 * ONE);
    lotus.deposit(&user, &(1_000 * ONE));

    let paid = lotus.redeem(&user, &(400 * ONE));

    assert_eq!(paid, 400 * ONE);
    assert_eq!(receipt_bal(&env, &f, &user), 600 * ONE);
    assert_eq!(underlying_bal(&env, &f, &user), 400 * ONE);
    assert_eq!(lotus.supply(), 600 * ONE);
    assert_eq!(lotus.vault_value(), 600 * ONE);
    assert_eq!(lotus.surplus(), 0);

    // redeem the rest
    assert_eq!(lotus.redeem(&user, &(600 * ONE)), 600 * ONE);
    assert_eq!(receipt_bal(&env, &f, &user), 0);
    assert_eq!(underlying_bal(&env, &f, &user), 1_000 * ONE);
    assert_eq!(lotus.supply(), 0);
    assert_eq!(lotus.vault_value(), 0);
}

#[test]
fn redeem_more_than_supply_is_rejected() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let user = Address::generate(&env);
    fund(&env, &f, &user, 100 * ONE);
    lotus.deposit(&user, &(100 * ONE));
    assert_eq!(
        lotus.try_redeem(&user, &(101 * ONE)),
        Err(Ok(Error::InsufficientSupply.into()))
    );
    assert_eq!(lotus.try_deposit(&user, &0), Err(Ok(Error::InvalidAmount.into())));
}

#[test]
fn yield_accrues_as_surplus_and_is_distributed_pro_rata() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let vault = MockVaultClient::new(&env, &f.vault);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let donor = Address::generate(&env);
    fund(&env, &f, &alice, 600 * ONE);
    fund(&env, &f, &bob, 400 * ONE);
    fund(&env, &f, &donor, 100 * ONE);
    lotus.deposit(&alice, &(600 * ONE));
    lotus.deposit(&bob, &(400 * ONE));
    assert_eq!(lotus.surplus(), 0);

    // 10% yield lands in the DeFindex position
    vault.accrue(&donor, &(100 * ONE));
    assert_eq!(lotus.vault_value(), 1_100 * ONE);
    assert_eq!(lotus.supply(), 1_000 * ONE);
    assert_eq!(lotus.surplus(), 100 * ONE);

    // keeper distributes exactly pro-rata
    let minted = lotus.distribute(
        &vec![&env, alice.clone(), bob.clone()],
        &vec![&env, 60 * ONE, 40 * ONE],
    );
    assert_eq!(minted, 100 * ONE);
    assert_eq!(receipt_bal(&env, &f, &alice), 660 * ONE);
    assert_eq!(receipt_bal(&env, &f, &bob), 440 * ONE);
    assert_eq!(lotus.supply(), 1_100 * ONE);
    assert_eq!(lotus.vault_value(), 1_100 * ONE);
    assert_eq!(lotus.surplus(), 0);

    // and everybody can redeem their yield-inflated balance 1:1
    assert_eq!(lotus.redeem(&alice, &(660 * ONE)), 660 * ONE);
    assert_eq!(underlying_bal(&env, &f, &alice), 660 * ONE);
    assert_eq!(lotus.redeem(&bob, &(440 * ONE)), 440 * ONE);
    assert_eq!(underlying_bal(&env, &f, &bob), 440 * ONE);
    assert_eq!(lotus.supply(), 0);
}

#[test]
fn distribute_may_omit_holders_but_never_overpay() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let vault = MockVaultClient::new(&env, &f.vault);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let donor = Address::generate(&env);
    fund(&env, &f, &alice, 600 * ONE);
    fund(&env, &f, &bob, 400 * ONE);
    fund(&env, &f, &donor, 100 * ONE);
    lotus.deposit(&alice, &(600 * ONE));
    lotus.deposit(&bob, &(400 * ONE));
    vault.accrue(&donor, &(100 * ONE));

    // 1 stroop over alice's cap -> rejected
    assert_eq!(
        lotus.try_distribute(
            &vec![&env, alice.clone(), bob.clone()],
            &vec![&env, 60 * ONE + 1, 40 * ONE - 1],
        ),
        Err(Ok(Error::ExceedsCap.into()))
    );
    // duplicates are summed against the same cap
    assert_eq!(
        lotus.try_distribute(
            &vec![&env, alice.clone(), alice.clone()],
            &vec![&env, 60 * ONE, 1],
        ),
        Err(Ok(Error::ExceedsCap.into()))
    );
    // mismatched lengths
    assert_eq!(
        lotus.try_distribute(&vec![&env, alice.clone()], &vec![&env, 1, 1]),
        Err(Ok(Error::LengthMismatch.into()))
    );
    // a stranger with no receipts has a cap of zero
    let stranger = Address::generate(&env);
    assert_eq!(
        lotus.try_distribute(&vec![&env, stranger], &vec![&env, 1]),
        Err(Ok(Error::ExceedsCap.into()))
    );
    assert_eq!(lotus.surplus(), 100 * ONE, "nothing was minted");

    // omitting bob is allowed (he just keeps his claim in the surplus)
    assert_eq!(
        lotus.distribute(&vec![&env, alice.clone()], &vec![&env, 60 * ONE]),
        60 * ONE
    );
    assert_eq!(receipt_bal(&env, &f, &alice), 660 * ONE);
    assert_eq!(receipt_bal(&env, &f, &bob), 400 * ONE);
    assert_eq!(lotus.surplus(), 40 * ONE);
    // bob's cap is now 40 * 400 / 1060 (surplus shrank, supply grew)
    let cap = 40 * ONE * 400 * ONE / (1_060 * ONE);
    assert_eq!(
        lotus.try_distribute(&vec![&env, bob.clone()], &vec![&env, cap + 1]),
        Err(Ok(Error::ExceedsCap.into()))
    );
    assert_eq!(lotus.distribute(&vec![&env, bob.clone()], &vec![&env, cap]), cap);
}

#[test]
fn distribute_requires_keeper_auth() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let vault = MockVaultClient::new(&env, &f.vault);
    let alice = Address::generate(&env);
    let donor = Address::generate(&env);
    fund(&env, &f, &alice, 1_000 * ONE);
    fund(&env, &f, &donor, 100 * ONE);
    lotus.deposit(&alice, &(1_000 * ONE));
    vault.accrue(&donor, &(100 * ONE));

    // only the attacker signs: the keeper's require_auth must fail
    let attacker = Address::generate(&env);
    let recipients = vec![&env, alice.clone()];
    let amounts = vec![&env, 100 * ONE];
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.lotus,
            fn_name: "distribute",
            args: (recipients.clone(), amounts.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(lotus.try_distribute(&recipients, &amounts).is_err());
    assert_eq!(receipt_bal(&env, &f, &alice), 1_000 * ONE);

    // the keeper itself succeeds
    env.mock_auths(&[MockAuth {
        address: &f.keeper,
        invoke: &MockAuthInvoke {
            contract: &f.lotus,
            fn_name: "distribute",
            args: (recipients.clone(), amounts.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(lotus.distribute(&recipients, &amounts), 100 * ONE);
    assert_eq!(receipt_bal(&env, &f, &alice), 1_100 * ONE);
}

#[test]
fn set_keeper_requires_admin() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let new_keeper = Address::generate(&env);

    let attacker = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &f.lotus,
            fn_name: "set_keeper",
            args: (new_keeper.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(lotus.try_set_keeper(&new_keeper).is_err());
    assert_eq!(lotus.get_config().keeper, f.keeper);

    env.mock_auths(&[MockAuth {
        address: &f.admin,
        invoke: &MockAuthInvoke {
            contract: &f.lotus,
            fn_name: "set_keeper",
            args: (new_keeper.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    lotus.set_keeper(&new_keeper);
    assert_eq!(lotus.get_config().keeper, new_keeper);
}

#[test]
fn redeem_pays_pro_rata_when_vault_lost_value() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let vault = MockVaultClient::new(&env, &f.vault);
    let user = Address::generate(&env);
    fund(&env, &f, &user, 1_000 * ONE);
    lotus.deposit(&user, &(1_000 * ONE));

    // the position loses 20%
    vault.slash(&(200 * ONE));
    assert_eq!(lotus.vault_value(), 800 * ONE);
    assert_eq!(lotus.supply(), 1_000 * ONE);
    assert_eq!(lotus.surplus(), 0);

    // redeeming half the receipts pays half the remaining value
    let paid = lotus.redeem(&user, &(500 * ONE));
    assert_eq!(paid, 400 * ONE);
    assert_eq!(underlying_bal(&env, &f, &user), 400 * ONE);
    assert_eq!(receipt_bal(&env, &f, &user), 500 * ONE);
    assert_eq!(lotus.supply(), 500 * ONE);
    assert_eq!(lotus.vault_value(), 400 * ONE);

    // and the rest pays the rest: nobody is left holding an unbacked receipt
    assert_eq!(lotus.redeem(&user, &(500 * ONE)), 400 * ONE);
    assert_eq!(underlying_bal(&env, &f, &user), 800 * ONE);
    assert_eq!(lotus.supply(), 0);
    assert_eq!(lotus.vault_value(), 0);
}

#[test]
fn redeem_uses_idle_underlying_first_and_keeps_dust_as_surplus() {
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let vault = MockVaultClient::new(&env, &f.vault);
    let user = Address::generate(&env);
    let donor = Address::generate(&env);
    fund(&env, &f, &user, 1_000 * ONE);
    fund(&env, &f, &donor, 300 * ONE);
    lotus.deposit(&user, &(1_000 * ONE));

    // a donation straight to the contract counts as idle value / surplus
    TokenClient::new(&env, &f.underlying).transfer(&donor, &f.lotus, &(300 * ONE));
    assert_eq!(lotus.vault_value(), 1_300 * ONE);
    assert_eq!(lotus.surplus(), 300 * ONE);

    // redeeming 200 is served from idle: the DeFindex position is untouched
    assert_eq!(lotus.redeem(&user, &(200 * ONE)), 200 * ONE);
    assert_eq!(vault.balance(&f.lotus), 1_000 * ONE);
    assert_eq!(underlying_bal(&env, &f, &f.lotus), 100 * ONE);
    assert_eq!(lotus.supply(), 800 * ONE);
    assert_eq!(lotus.surplus(), 300 * ONE, "redeem never changes the surplus");

    // redeeming 500 drains idle (100) and pulls 400 from the vault
    assert_eq!(lotus.redeem(&user, &(500 * ONE)), 500 * ONE);
    assert_eq!(lotus.supply(), 300 * ONE);
    assert_eq!(lotus.surplus(), 300 * ONE);
    assert_eq!(underlying_bal(&env, &f, &user), 700 * ONE);
}

#[test]
fn redeem_rounding_never_shortchanges_the_user() {
    // odd share price (3 assets per 2 shares) so that share maths rounds
    let env = Env::default();
    let f = setup(&env);
    let lotus = LotusVaultClient::new(&env, &f.lotus);
    let vault = MockVaultClient::new(&env, &f.vault);
    let user = Address::generate(&env);
    let donor = Address::generate(&env);
    fund(&env, &f, &user, 1_000);
    fund(&env, &f, &donor, 500);
    lotus.deposit(&user, &1_000);
    vault.accrue(&donor, &500);
    assert_eq!(lotus.surplus(), 500);

    let mut total = 0i128;
    for amount in [1i128, 7, 333, 659] {
        total += lotus.redeem(&user, &amount);
    }
    assert_eq!(total, 1_000, "every receipt was paid 1:1");
    assert_eq!(lotus.supply(), 0);
    assert!(lotus.vault_value() >= 500, "the yield stayed in the vault");
}
