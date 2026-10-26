# Contracts

> The `lotus_pool` ABI (v1), the `lotus_vault` interface, their errors and events, and the live testnet addresses read from the deployment config at request time.

Both contracts are Soroban (Rust, `soroban-sdk`), deployed on Stellar testnet only, not audited. Errors surface as `Error(Contract, #n)`; authorization failures are host `Auth` errors, not contract errors. Amounts are `i128` stroops (7 decimals).

## Live testnet addresses

The table below is generated from the deployment files (`deployments/testnet.*.json`) every time this page is served, so it always matches what the app uses. If anything else disagrees with it, these files win.

{{deployment}}

## lotus_pool (ABI v1)

### Types

```rust
enum Side { Ask, Bid }              // Ask: sells BASE as price rises. Bid: buys BASE as price falls.
enum Mode { Directional, TwoWay }    // TwoWay: pools without a vault only

struct Config   { admin, base, quote, vault: Option<Address>, bin_step_bps: u32, fee_bps: u32,
                  max_bins_per_swap: u32, supports_two_way: bool }
struct BinView  { side: Side, bin: i32, price: i128, inventory: i128, total_shares: i128, filled: i128 }
struct Position { id: u64, owner, side, mode, lo_bin: i32, hi_bin: i32, deposited: i128,
                  inventory: i128, filled: i128, pending_proceeds: i128, pending_fees: i128, vaulted: bool }
struct PositionPayout { base: i128, quote: i128 }
struct SwapQuote { amount_out: i128, fee: i128, avg_price: i128, bins_crossed: u32, partial: bool }
struct Tvl { base: i128, quote_value: i128, vault_shares: i128 }
```

Encoding: `Side` and `Mode` are unit-variant enums, on the wire `ScVal::Vec([Symbol("Ask")])` (stellar CLI: `--side Ask`; spec-based stellar-sdk clients: `{ tag: "Ask", values: undefined }`). Structs are `ScVal::Map` keyed by field name.

Field notes: for Ask, `inventory` / `deposited` / `filled` are in BASE, `pending_proceeds` and `pending_fees` in QUOTE. For Bid, `inventory` / `deposited` / `filled` are in QUOTE, `pending_proceeds` is BASE bought, `pending_fees` QUOTE. `SwapQuote.avg_price` includes the fee. A removed position disappears: `get_position(id)` then fails with `NoSuchPosition`.

### Functions

```rust
__constructor(admin, base, quote, vault: Option<Address>, bin_step_bps: u32, fee_bps: u32)

// LP
add_position(owner, side: Side, mode: Mode, lo_bin: i32, hi_bin: i32, amount: i128, weights: Vec<u32>) -> u64
    // Ask deposits BASE, Bid deposits QUOTE, spread over lo..=hi by weights (empty = uniform).
    // owner.require_auth(). At most 64 bins; each non-zero bin share >= 10_000 stroops.
claim(owner, id: u64) -> PositionPayout            // pay pending proceeds and fees, keep the position open
remove_position(owner, id: u64) -> PositionPayout  // unfilled inventory + pending proceeds + fees, close it

// Taker
quote_swap(buy_base: bool, amount_in: i128) -> SwapQuote   // read only, never reverts for lack of liquidity
swap(taker, buy_base: bool, amount_in: i128, min_out: i128) -> i128
    // amount_in is a maximum, fee included; partial fills allowed; unspent input is never pulled.

// Admin (the only admin power)
set_max_bins_per_swap(max_bins: u32)       // 1..=100

// Views
get_config() -> Config
get_position(id: u64) -> Position
positions_of(owner) -> Vec<u64>                        // open positions, at most 100 per owner
get_bin(side: Side, bin: i32) -> BinView
depth(side: Side, from_bin: i32, to_bin: i32) -> Vec<BinView>   // non-empty bins, at most 100
tvl() -> Tvl
price_at(bin: i32) -> i128
abi_version() -> u32                                    // 1
```

Client notes:

- On the **vault-backed pool**, `quote_swap` (sell side), `get_position`, `get_bin(Bid)`, `depth(Bid)` and `tvl` call a DeFindex view that writes a fee report. Run them with `simulateTransaction` only and never submit them (stellar CLI: `--send=no`).
- Re-run `quote_swap` right before `swap` and pass `min_out`. A buy needs the taker's QUOTE `transfer` authorized under the `swap` call; a sell signs the BASE `transfer`.
- Calls that withdraw from the shared DeFindex vault can hit a footprint race (`Error(Storage, ExceededLimit)`): re-simulate, re-sign and resend.
- The exact price grid for every bin and step is in `contracts/lotus_pool/test-vectors.json`.

### Errors

| # | name | when |
|---|---|---|
| 1 | NotInitialized | call before the constructor |
| 2 | InvalidAmount | amount <= 0 or > 1e18 |
| 3 | InvalidRange | lo > hi, outside [-200, 200], more than 64 bins |
| 4 | InvalidWeights | weights length != bins, or all zero |
| 5 | InvalidConfig | constructor or admin parameter out of range |
| 6 | NoSuchPosition | unknown or already removed id |
| 7 | NotOwner | claim or remove by an address that is not the owner |
| 8 | NoLiquidity | the swap would move nothing |
| 9 | SlippageExceeded | amount_out < min_out |
| 10 | NotImplemented | `Mode::TwoWay` on a pool whose `supports_two_way` is false |
| 11 | Overflow | arithmetic overflow |
| 12 | AmountTooSmall | a bin would get too little to mint a share |
| 13 | BinDust | the bin is almost fully filled: use another bin |
| 14 | VaultShortfall | the vault paid less than needed, minted 0 shares, or has a zero share price |
| 15 | TooManyPositions | the owner already has 100 open positions |

### Events

| topics | data |
|---|---|
| `["position_added", owner]` | `id, side, lo_bin, hi_bin, amount` (mode: read `get_position(id).mode`) |
| `["position_removed", owner]` | `id, base, quote` |
| `["claimed", owner]` | `id, base, quote` (not emitted when nothing is paid) |
| `["swap", taker]` | `buy_base, amount_in, amount_out, fee, bins_crossed, last_bin` |

The two SACs also emit their token `transfer` events.

### Invariants (unit-tested)

1. Directional: per bin, inventory never increases after a fill and proceeds are never re-offered.
2. Solvency: pool balances (plus vault shares at current value) always cover remaining inventory plus all pending claims; checked after every operation of randomized sequences.
3. Rounding always favors the pool; no payout exceeds what a position is owed.
4. Late depositors into a partly filled bin cannot take earlier proceeds (share-based accounting per bin).

## lotus_vault

The admin of the receipt's Stellar Asset Contract. Routes deposits into a single-asset DeFindex vault and distributes yield.

```rust
__constructor(admin, keeper, underlying: Address, receipt: Address, vault: Address)
deposit(from, amount: i128) -> i128       // from.require_auth(); mints `amount` receipt 1:1; returns DeFindex shares received
redeem(from, amount: i128) -> i128        // from.require_auth(); burns the receipt; returns underlying sent
distribute(recipients: Vec<Address>, amounts: Vec<i128>) -> i128   // keeper only; returns total minted
surplus() -> i128        // max(0, vault_value() - supply())
vault_value() -> i128    // value of the DeFindex shares + idle underlying held by the contract
supply() -> i128         // receipts minted by this contract and still outstanding
get_config() -> Config   // { admin, keeper, underlying, receipt, vault }
set_keeper(new_keeper)   // admin only
```

`vault_value()` and `surplus()` call DeFindex `get_asset_amounts_per_shares`, which updates a fee report: read them by simulation only. `supply()` and `get_config()` are plain instance reads.

### Errors

| # | name | raised by |
|---|---|---|
| 1 | NotInitialized | any call before the constructor |
| 2 | InvalidAmount | `deposit` / `redeem` with amount <= 0, negative amount in `distribute` |
| 3 | InsufficientSupply | `redeem` with amount > `supply()` |
| 4 | LengthMismatch | `distribute` with different list lengths |
| 5 | InsufficientSurplus | `distribute` with sum(amounts) > `surplus()` |
| 6 | ExceedsCap | a `distribute` line above `surplus * balance / supply` (duplicates are summed) |
| 7 | ZeroSupply | `distribute` when nothing is outstanding |
| 8 | Overflow | i128 overflow |
| 9 | NoVaultPosition | `redeem` needs DeFindex funds but the contract holds no shares |

### Events

| topics | data |
|---|---|
| `["deposit", from]` | `{ amount, shares }` |
| `["redeem", from]` | `{ amount, paid }` |
| `["distribute"]` | `{ total, surplus_before, recipients }` |
| `["set_keeper"]` | `{ keeper }` |

### Invariants

- `deposit` and `redeem` leave `surplus()` unchanged (rounding dust stays in the contract).
- While `vault_value() >= supply()` every receipt redeems 1:1; otherwise `redeem` pays `amount * vault_value / supply`.
- `distribute` can mint at most `surplus()`, each recipient at most `surplus * balance / supply` measured before the call.

Known limits: the testnet receipt issuer accounts are not locked (on mainnet the issuer would be locked after `set_admin`, so the contract is the only minter); `distribute` aborts if any recipient cannot receive (the keeper filters the list); no pause, no upgrade, no fee switch.

## Source

Contract sources and tests live in the Lotus repository under `contracts/lotus_pool` and `contracts/lotus_vault`; the full pool ABI is `docs/pool-abi.md`, the accounting notes `contracts/lotus_pool/README.md`.
