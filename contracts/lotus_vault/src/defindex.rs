//! Minimal client for the DeFindex vault functions that Lotus calls.
//!
//! Signatures were verified against the testnet USDC vault with
//! `stellar contract info interface --id CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN --network testnet`.
//! The real functions return `Result<T, ContractError>`; a successful
//! cross-contract call hands back the unwrapped `T`, and a failure traps the
//! whole invocation, so the client declares `T` directly. The third element of
//! the `deposit` tuple (`Option<Vec<Option<AssetInvestmentAllocation>>>`) is not
//! modelled: it is declared as an opaque `Val`.

use soroban_sdk::{contractclient, Address, Env, Val, Vec};

#[allow(dead_code)] // only the generated `DeFindexVaultClient` is used
#[contractclient(name = "DeFindexVaultClient")]
pub trait DeFindexVault {
    /// Deposit `amounts_desired` (one entry per vault asset) from `from`.
    /// Returns `(amounts_deposited, df_shares_minted, allocations)`.
    fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        amounts_min: Vec<i128>,
        from: Address,
        invest: bool,
    ) -> (Vec<i128>, i128, Val);

    /// Burn `withdraw_shares` df shares from `from` and pay the underlying.
    /// Returns the amounts paid out (one entry per vault asset).
    fn withdraw(
        env: Env,
        withdraw_shares: i128,
        min_amounts_out: Vec<i128>,
        from: Address,
    ) -> Vec<i128>;

    /// df shares held by `id`.
    fn balance(env: Env, id: Address) -> i128;

    /// Total df shares outstanding.
    fn total_supply(env: Env) -> i128;

    /// Underlying amounts (one entry per vault asset) that `vault_shares` are worth.
    fn get_asset_amounts_per_shares(env: Env, vault_shares: i128) -> Vec<i128>;
}
