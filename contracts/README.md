# Lotus contracts

Soroban contracts for **Lotus**, a yield-bearing receipt token for Stellar's native orderbook (SDEX).

| crate | wasm | purpose |
|---|---|---|
| `contracts/lotus_vault` | `lotus_vault.wasm` (12.3 KB) | the product: admin of the classic receipt asset (`lUSDC`), routes deposits into a DeFindex vault, distributes yield |
| `contracts/mock_vault` | `mock_vault.wasm` (7 KB) | minimal DeFindex-compatible vault with `accrue` / `slash` to simulate yield and losses; used by the unit tests and as a local-demo fallback |

Testnet deployment: see [`../deployments/testnet.contract.json`](../deployments/testnet.contract.json).

## How it works

```
user ──deposit(USDC)──▶ lotus_vault ──deposit([amt],[0],lotus,invest=true)──▶ DeFindex vault ──▶ Blend
     ◀──mint lUSDC 1:1──           ◀──────────────── df shares ────────────────

user ──redeem(lUSDC)──▶ lotus_vault ──withdraw(shares,[0],lotus)──▶ DeFindex vault
     ◀──USDC 1:1 (pro-rata if under-backed)──◀── USDC ──

keeper ──distribute(holders, amounts)──▶ lotus_vault ──mint lUSDC──▶ every holder, capped on-chain
```

* The receipt (`lUSDC`) is a **classic Stellar asset**, so it trades on SDEX like any other asset and is held in ordinary trustlines. Its Stellar Asset Contract (SAC) has `lotus_vault` as admin, so only the contract can `mint` it from Soroban.
* SDEX offers never leave the account (they only create *selling liabilities*), so an open limit order denominated in `lUSDC` keeps receiving yield distributions.
* Yield accrues inside the DeFindex position. The keeper computes the holder list off-chain (Horizon `/accounts?asset=lUSDC:...`) and calls `distribute`; the contract caps each line by `surplus * balance(holder) / supply`, so the keeper can **omit** holders but can never over-pay anybody, itself included.

## Interface (`lotus_vault`)

```rust
__constructor(admin: Address, keeper: Address, underlying: Address, receipt: Address, vault: Address)
deposit(from: Address, amount: i128) -> i128        // from.require_auth(); returns df shares received
redeem(from: Address, amount: i128) -> i128         // from.require_auth(); returns underlying sent
distribute(recipients: Vec<Address>, amounts: Vec<i128>) -> i128   // keeper only; returns total minted
surplus() -> i128        // max(0, vault_value() - supply())
vault_value() -> i128    // underlying value of our df shares + idle underlying held by the contract
supply() -> i128         // receipts minted by this contract and still outstanding
get_config() -> Config   // { admin, keeper, underlying, receipt, vault }
set_keeper(new_keeper: Address)   // admin only
```

`underlying` and `receipt` are SAC addresses (`stellar contract id asset --asset CODE:ISSUER`), `vault` is a single-asset DeFindex vault whose asset is `underlying`. Amounts are in stroops (7 decimals): `100 USDC = 1_000_000_000`.

### Errors (`#[contracterror]`)

| # | name | raised by |
|---|---|---|
| 1 | `NotInitialized` | any call before the constructor ran |
| 2 | `InvalidAmount` | `deposit`/`redeem` with `amount <= 0`, negative `amounts[i]` in `distribute` |
| 3 | `InsufficientSupply` | `redeem` with `amount > supply()` |
| 4 | `LengthMismatch` | `distribute` with `recipients.len() != amounts.len()` |
| 5 | `InsufficientSurplus` | `distribute` with `sum(amounts) > surplus()` |
| 6 | `ExceedsCap` | `distribute` line above `surplus * balance(recipient) / supply` (duplicates are summed) |
| 7 | `ZeroSupply` | `distribute` when nothing is outstanding |
| 8 | `Overflow` | i128 arithmetic overflow (checked everywhere) |
| 9 | `NoVaultPosition` | `redeem` needs underlying from DeFindex but we hold no df shares |

Authorization failures (`from`, `keeper`, `admin`) surface as host `Auth` errors, not contract errors.

### Events (`#[contractevent]`)

| topics | data |
|---|---|
| `["deposit", from]` | `{ amount, shares }` |
| `["redeem", from]` | `{ amount, paid }` |
| `["distribute"]` | `{ total, surplus_before, recipients }` |
| `["set_keeper"]` | `{ keeper }` |

### Storage

Instance storage only (`Config`, `Supply`); TTL is extended to 30 days on every call. The receipt balances live in classic trustlines / the SAC, the df shares in the DeFindex vault.

## Invariants

1. `supply()` = receipts minted by this contract minus receipts burnt through `redeem`.
2. `vault_value()` = `get_asset_amounts_per_shares(balance(lotus))[0]` + `underlying.balance(lotus)`.
3. `surplus()` = `max(0, vault_value() - supply())`.
4. `deposit` and `redeem` leave `surplus()` unchanged (up to rounding dust that always stays in the contract, never leaks to the redeemer). Only yield accrual, donations and `distribute` move it.
5. While `vault_value() >= supply()` every receipt redeems 1:1. If the DeFindex position loses value, `redeem` pays `amount * vault_value / supply` so the last redeemer is never left with an unbacked receipt.
6. `distribute` can only ever mint `<= surplus()`, and each recipient gets `<= surplus * balance / supply` measured **before** the call. After a full pro-rata distribution `surplus()` is 0 and every holder's balance is up by their share.
7. `redeem` pays from idle underlying first and only then withdraws from DeFindex (rounded up by one share), which keeps on-chain costs down and keeps the dust inside the vault.

Known limits (hackathon scope):

* The receipt **issuer account is not locked**: it can still issue `lUSDC` through classic payments. In production set its master weight to 0 after `set_admin`, so the contract becomes the only possible minter.
* `distribute` aborts entirely if any recipient cannot receive the mint (no trustline, trustline limit, deauthorized). The keeper must filter the holder list.
* `vault_value()` relies on DeFindex `get_asset_amounts_per_shares`, which only reflects Blend interest as of the last pool interaction. The 1-stroop rounding of DeFindex share maths right after a deposit makes `vault_value()` temporarily `supply() - 1`, so a redeem in that window pays 1 stroop less than 1:1.
* No pause / upgrade / emergency exit, no fee switch.

## Build and test

Requirements: Rust >= 1.84 with the `wasm32v1-none` target, `stellar` CLI 28.x.

```sh
cargo test                         # 12 host tests, uses mock_vault
stellar contract build             # -> target/wasm32v1-none/release/{lotus_vault,mock_vault}.wasm
stellar contract optimize --wasm target/wasm32v1-none/release/lotus_vault.wasm
```

Test coverage (`contracts/lotus_vault/src/test.rs`): 1:1 mint on deposit; redeem returns underlying; explicit (non-mocked) auth tree for deposit, which exercises the contract's `authorize_as_current_contract` for the nested `vault -> token.transfer(lotus, vault)` call; yield accrual shows up as surplus and distributes pro-rata; over-cap, duplicate recipient, length mismatch and zero-balance recipient rejected; non-keeper `distribute` and non-admin `set_keeper` rejected; pro-rata redemption after a loss; idle-first redemption; rounding never short-changes a redeemer.

## Deploy (testnet)

```sh
# keys
stellar keys generate lotus-admin  --network testnet --fund
stellar keys generate lotus-keeper --network testnet --fund
stellar keys generate lotus-issuer --network testnet --fund     # receipt issuer

# underlying: Blend testnet USDC (USDC:GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56)
# faucet used by testnet.blend.capital: returns an issuer-signed tx that only needs the user's signature
curl -H "Origin: https://testnet.blend.capital" \
  "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets?userId=$(stellar keys address scratch)" \
  | tr -d '"' | stellar tx sign --sign-with-key scratch --network testnet | stellar tx send --network testnet
# -> 1000 USDC + 5000 BLND + 0.5 wETH + 0.05 wBTC

# receipt asset + its SAC
stellar contract asset deploy --asset lUSDC:$(stellar keys address lotus-issuer) \
  --source-account lotus-issuer --network testnet --alias lusdc-sac

# the vault
stellar contract deploy --wasm target/wasm32v1-none/release/lotus_vault.optimized.wasm \
  --source-account lotus-admin --network testnet --alias lotus-vault -- \
  --admin  $(stellar keys address lotus-admin) \
  --keeper $(stellar keys address lotus-keeper) \
  --underlying CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU \
  --receipt    <lusdc SAC id> \
  --vault      CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN

# hand the receipt to the contract
stellar contract invoke --id <lusdc SAC id> --source-account lotus-issuer --network testnet \
  -- set_admin --new_admin <lotus vault id>

# users: trustline, then deposit / redeem
stellar tx new change-trust --source-account scratch --network testnet --line lUSDC:$(stellar keys address lotus-issuer)
stellar contract invoke --id lotus-vault --source-account scratch --network testnet -- deposit --from $(stellar keys address scratch) --amount 1000000000
stellar contract invoke --id lotus-vault --source-account scratch --network testnet -- redeem  --from $(stellar keys address scratch) --amount 500000000
stellar contract invoke --id lotus-vault --source-account scratch --network testnet -- surplus

# keeper
stellar contract invoke --id lotus-vault --source-account lotus-keeper --network testnet \
  -- distribute --recipients '["G..."]' --amounts '["10000000"]'
```

The CLI simulates every call and builds the auth tree (`from` signs `deposit` + the nested `transfer`, or `redeem` + the nested `burn`), so no manual auth entries are needed.

## Measured costs (testnet, 2026-10-25)

| op | tx | fee charged | note |
|---|---|---|---|
| `deposit` 100 USDC | `1307e6bf…` | 0.036 XLM | DeFindex USDC vault held everything idle (strategy allocation 0), so Blend was not touched |
| `redeem` 50 lUSDC | `d1ec0985…` | 0.0024 XLM | same |
| `distribute` 1 line | `d094e1b6…` | 0.0011 XLM | 1 SAC mint |
| deposit/withdraw when the Blend strategy is active | measured earlier the same day | ~90-100 XLM | ~3.5M CPU instructions, ~13 ledger entries; the fee is almost entirely ledger rent on testnet. Avoid the `blend-v2.1` strategies (one simulated deposit quoted 23,584 XLM) |

Friendbot funds 10k XLM per account, enough for ~100 Blend-touching operations.
