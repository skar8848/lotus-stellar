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
* `vault_value()` relies on DeFindex `get_asset_amounts_per_shares`. Measured on a Blend-backed vault (v2, 2026-10-25) it is **not stale**: the Blend strategy reads `pool.get_reserve`, which accrues interest to the current ledger timestamp, so `vault_value()` moves every ledger with no pool interaction (about +98 stroops per 45 s on 100 USDC at a 6.9% supply rate). It is also **net of the DeFindex vault fee**: DeFindex re-reports on every call and subtracts the locked fee plus the fee on gains not yet locked (verified exactly, 0 stroops of difference on every same-ledger sample; `fetch_total_managed_funds` only subtracts the already-locked part, so it is a few stroops higher). That report update gives `vault_value()` and `surplus()` a one-entry write footprint, so read them with a simulation (`--send=no`, or `simulateTransaction`), never submit them. The 1-stroop rounding of DeFindex share maths right after a deposit makes `vault_value()` temporarily `supply() - 1`, so a redeem in that window pays 1 stroop less than 1:1.
* DeFindex caveat for vault operators (not a Lotus bug): `rebalance`, `rescue` and `distribute_fees` pay the locked vault fee out first, 20% of it to the factory's protocol receiver. On testnet that receiver (`GDOFDSMF...`, PaltaLabs) has **no USDC trustline**, so these three calls revert with "trustline entry is missing" as soon as the vault has a locked fee > 0 (`deposit` and `withdraw`, hence Lotus `deposit`/`redeem`/`distribute`, are unaffected). The v2 vault therefore runs with `vault_fee = 0`; see `deployments/README.md`.
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

### Measured costs with the Blend strategy actually invested (v2, testnet, 2026-10-25)

Second deployment: Lotus `CCCZ6XUD...` on our own DeFindex vault `CDCIDX5F...`, seeded into the Blend USDC strategy. The "~90-100 XLM" row above was **not reproduced**: every Blend-touching call below cost under 0.15 XLM (the largest figure is the first deposit into a fresh vault, which creates ledger entries). Fees are `feeCharged`; CPU is the host's `core_metrics.cpu_insn` of the executed transaction (limit 400M).

| op | tx | fee (XLM) | CPU (instructions) |
|---|---|---|---|
| factory `create_defindex_vault` | `7568e866...` | 0.0366 | 2.9M |
| vault `deposit` 1000 USDC, `invest=false` (first deposit, creates entries) | `51875aa8...` | 0.1433 | 2.3M |
| vault `rebalance` `Invest` 1000 USDC into the Blend strategy | `c72d8224...` | 0.0037 | 5.1M |
| vault `deposit` 10 USDC, `invest=true` (auto-invests, direct) | `c20896d8...` | 0.0505 | 7.1M |
| vault `withdraw` (unwinds from Blend, direct) | `05c1232e...` | 0.0025 | 6.6M |
| Lotus `deposit` 100 USDC (first deposit of this account) | `8c3584f3...` | 0.0373 | 8.1M |
| Lotus `deposit` 50 USDC | `1da1629a...` | 0.0037 | 8.1M |
| Lotus `distribute` 2 recipients, real surplus | `95716ece...` | 0.0015 | 4.7M |
| Lotus `redeem` 50 lUSDCb (Blend withdraw) | `c21698aa...` | 0.0034 | 14.1M |
| Lotus `redeem` full position of the second holder | `7ec13f1f...` | 0.0034 | 14.0M |

Views: `vault_value()` / `surplus()` simulate at about 4.4M instructions (they walk vault -> strategy -> Blend pool), `supply()` at 0.5M.
