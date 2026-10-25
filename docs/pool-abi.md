# Lotus pool: ABI v1 (implemented by `contracts/lotus_pool`, testnet instances live)

The Lotus pool is a Soroban range pool, directional by design. It is NOT replaced by the receipt token: both exist.

- `lotus_pool` (this document): LPs place liquidity on a price grid of bins. A directional position can never trade back: inventory only goes down, proceeds only go up. Optional two-way (crossback) positions exist on pools without a vault (see "Mode::TwoWay").
- `lotus_vault` (done): wraps a DeFindex vault and mints the receipt token `lUSDC`, a classic asset that trades on the SDEX.

The pool and the SDEX are two venues for the same asset (LBOND). The only on-chain link is DeFindex (the pool can park its USDC leg in a DeFindex vault) and the shared assets. Arbitrage between venues is off-chain (the bot).

This file was written first as a draft (v0) and is now the contract's real interface (v1), kept in sync by the contract agent. Front end and bot code against it through a thin adapter. Crate README (build, deploy, measured costs, limits): `contracts/lotus_pool/README.md`. Ground truth for `price_at`: `contracts/lotus_pool/test-vectors.json`.

## Pair and units

- BASE = `LBOND` (classic asset, AUTH_REQUIRED + REVOCABLE + CLAWBACK, issuer `rwa_issuer`). The pool contract address must be authorized by the issuer to hold it (SAC `set_authorized`; done for both live instances), and makers and takers need an authorized trustline. Compliance comes from the asset, not from pool code.
- QUOTE = `USDC` (Blend testnet USDC SAC `CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU`).
- LBOND SAC (deployed for the pool): `CAVDLKQ2T4XBIQNY2WBUZKWQM6YDQ6NVX2N3HQ3P5Z2SBQ3VNZCBVBKE`.
- All amounts are i128 stroops (7 decimals). Price = QUOTE per BASE, fixed point 1e7 (1.0000000 = 10_000_000). `quote = base * price / 1e7`.

## Price grid

`price_at(bin) = round_half_up(1e7 * (1 + bin_step_bps / 10_000) ^ bin)`, bin in [-200, 200], `bin_step_bps` in 1..=100 (default 10 = 0.1 percent, so bins -20..20 cover about 0.98 to 1.02).

Integer algorithm, identical in Rust and for a BigInt port:

1. `f = 1e18 + bin_step_bps * 1e14`
2. `p = f ^ |bin|` by binary exponentiation (`result = 1e18`; loop on the bits of |bin|: multiply `result` by `base` when the bit is set, then square `base` while bits remain) with `mul(a, b) = (a * b + 5e17) / 1e18` (integer division of non-negative numbers)
3. bin < 0: `p = (1e36 + p / 2) / p`
4. `price = (p + 5e10) / 1e11`

`contracts/lotus_pool/test-vectors.json` has the exact price of every bin from -200 to 200 for steps 1, 5, 10, 20, 25, 50 and 100 bps (computed with exact rational arithmetic, independent of the algorithm above; the Rust test asserts all 2807 values). Verify the TypeScript port against it. A client can also call `price_at(bin)`.

## Types

```rust
enum Side { Ask, Bid }       // Ask: sells BASE as price rises. Bid: buys BASE as price falls.
enum Mode { Directional, TwoWay }   // TwoWay: pools without a vault only, see "Mode::TwoWay"

struct Config   { admin, base, quote, vault: Option<Address>, bin_step_bps: u32, fee_bps: u32, max_bins_per_swap: u32, supports_two_way: bool }
struct BinView  { side: Side, bin: i32, price: i128, inventory: i128, total_shares: i128, filled: i128 }
struct Position { id: u64, owner, side, mode, lo_bin: i32, hi_bin: i32, deposited: i128,
                  inventory: i128, filled: i128, pending_proceeds: i128, pending_fees: i128, vaulted: bool }
struct PositionPayout { base: i128, quote: i128 }     // what remove_position / claim paid out
struct SwapQuote { amount_out: i128, fee: i128, avg_price: i128, bins_crossed: u32, partial: bool }
struct Tvl { base: i128, quote_value: i128, vault_shares: i128 }
```

Encoding: `Side` / `Mode` are unit-variant enums, on the wire `ScVal::Vec([Symbol("Ask")])` (stellar CLI: `--side Ask`; stellar-sdk spec-based clients: `{ tag: "Ask", values: undefined }`). Structs are `ScVal::Map` with the field names above; i128 are strings in the CLI JSON.

Meaning of the fields:

- `BinView.inventory`: BASE still for sale (Ask bins) or the QUOTE value of what is still bid (Bid bins; with a vault, vault shares converted at the current share price, rounded down). `filled`: cumulative inventory consumed in the same unit (BASE for Ask, QUOTE for Bid), only ever increases, never reset. `total_shares`: LP shares of the live generation (internal unit, equal to the first deposit's amount).
- `Position.deposited`: BASE (Ask) or QUOTE (Bid) put in at creation. `inventory`: unfilled remainder in the same unit (QUOTE value for Bid). `filled`: this position's share of the consumed inventory, same unit. Ask: `pending_proceeds` = QUOTE earned, `pending_fees` = QUOTE fees. Bid: `pending_proceeds` = BASE bought, `pending_fees` = QUOTE fees. `vaulted`: the QUOTE leg is held as vault shares (pool `vault` is set); the amounts above are still reported in QUOTE.
- A removed position disappears: `get_position(id)` then fails with `NoSuchPosition` (#6) and `positions_of` no longer lists it.
- `SwapQuote.amount_out`: BASE received (buy) or QUOTE received net of fee (sell). `fee`: total fee in QUOTE. `avg_price`: effective QUOTE per BASE incl. fee (`quote_total * 1e7 / base_total`, rounded down, 0 when nothing is filled). `bins_crossed`: bins that gave liquidity. `partial`: the walk stopped for lack of liquidity or `max_bins_per_swap` before the input was used up (false when the leftover input is too small to buy one more stroop).
- `Tvl.base`: BASE balance of the pool. `quote_value`: idle QUOTE plus the vault shares the pool holds at the current price. `vault_shares`: shares the pool holds in the vault (0 without a vault).

## Functions

```rust
__constructor(admin: Address, base: Address, quote: Address, vault: Option<Address>, bin_step_bps: u32, fee_bps: u32)
    // bin_step_bps 1..=100, fee_bps 0..=1000, base != quote; max_bins_per_swap starts at 100

// LP
add_position(owner: Address, side: Side, mode: Mode, lo_bin: i32, hi_bin: i32, amount: i128, weights: Vec<u32>) -> u64
    // Ask deposits `amount` BASE, Bid deposits `amount` QUOTE, spread over bins lo..=hi by weights
    // (empty weights = uniform, otherwise len == hi - lo + 1; the rounding remainder goes to the last bin with a non-zero weight).
    // owner.require_auth(). At most 64 bins; a bin that gets a non-zero share must get >= 10_000 stroops; amount <= 1e18.
claim(owner: Address, id: u64) -> PositionPayout           // pay pending proceeds and fees, keep the position open
remove_position(owner: Address, id: u64) -> PositionPayout // pay unfilled inventory + pending proceeds + fees, close the position

// Taker
quote_swap(buy_base: bool, amount_in: i128) -> SwapQuote   // read only; buy_base: pay QUOTE, receive BASE; never reverts for lack of liquidity
swap(taker: Address, buy_base: bool, amount_in: i128, min_out: i128) -> i128
    // Consumes only what it needs (partial fills allowed, unspent input is never pulled); returns amount_out.
    // buy_base walks Ask bins from the cheapest price up; sell walks Bid bins from the highest price down.
    // Reverts with SlippageExceeded if amount_out < min_out, NoLiquidity if it would move nothing.
    // At most max_bins_per_swap bins are visited per call. amount_in is the maximum input, fee included.

// Admin (only power of the admin)
set_max_bins_per_swap(max_bins: u32)       // 1..=100

// Views (for the app and the bot)
get_config() -> Config
get_position(id: u64) -> Position
positions_of(owner: Address) -> Vec<u64>                         // open positions, at most 100 per owner
get_bin(side: Side, bin: i32) -> BinView                          // empty bins return zeros and the price
depth(side: Side, from_bin: i32, to_bin: i32) -> Vec<BinView>     // non-empty bins only, ascending bin, at most 100 entries (lowest bins first)
tvl() -> Tvl
price_at(bin: i32) -> i128
abi_version() -> u32                                              // 1
```

Fee and fill rules (exact, for client-side quoting): see "Fees and rounding" in `contracts/lotus_pool/README.md`. Short version: the fee is `fee_bps` of the price leg `q = quantity * bin_price`, charged on top of it. A buyer pays `ceil(q) + ceil(q * fee_bps / 10000)`, a seller receives `floor(q) - ceil(q * fee_bps / 10000)`; the LPs of the bin get `q` as proceeds (Ask) or spend `q` of inventory (Bid), and the fee goes to the same LPs through the fee accumulator.

## Errors (`#[contracterror]`, surface as `Error(Contract, #n)`)

| # | name | when |
|---|---|---|
| 1 | NotInitialized | call before the constructor |
| 2 | InvalidAmount | amount <= 0 or > 1e18 |
| 3 | InvalidRange | lo > hi, outside [-200, 200], more than 64 bins, `get_bin`/`price_at` out of the grid |
| 4 | InvalidWeights | weights length != bins, or all zero |
| 5 | InvalidConfig | constructor / admin parameter out of range |
| 6 | NoSuchPosition | unknown or already removed id |
| 7 | NotOwner | claim/remove by an address that is not the owner |
| 8 | NoLiquidity | the swap would move nothing |
| 9 | SlippageExceeded | amount_out < min_out |
| 10 | NotImplemented | `Mode::TwoWay` on a pool whose `supports_two_way` is false (it has a vault, or it is a stage A-C build) |
| 11 | Overflow | arithmetic overflow |
| 12 | AmountTooSmall | a bin would get < 0.001 unit or too little to mint a share |
| 13 | BinDust | the bin is almost fully filled (remaining < 1e-6 of its shares): use another bin |
| 14 | VaultShortfall | the vault paid less than needed, minted 0 shares, or has a zero share price |
| 15 | TooManyPositions | the owner already has 100 open positions |

Authorization failures are host `Auth` errors, not contract errors.

## Events (`#[contractevent]`, data is a map keyed by field name)

| topics | data |
|---|---|
| `["position_added", owner]` | `id: u64, side: Side, lo_bin: i32, hi_bin: i32, amount: i128` (the event does not carry the mode: read `get_position(id).mode`) |
| `["position_removed", owner]` | `id: u64, base: i128, quote: i128` |
| `["claimed", owner]` | `id: u64, base: i128, quote: i128` (not emitted when nothing is paid) |
| `["swap", taker]` | `buy_base: bool, amount_in: i128` (pulled from the taker), `amount_out: i128` (sent to the taker), `fee: i128` (QUOTE), `bins_crossed: u32, last_bin: i32` |

Token `transfer` events of the two SACs are emitted as well (pool <-> account).

## Rules and invariants (all unit-tested, see the crate README)

1. Directional: per bin, `inventory` never increases after a fill, `filled` never decreases, proceeds and fees accumulators never decrease. Proceeds are never re-offered as liquidity.
2. Solvency: pool token balances (plus vault shares at current value) are always at least the sum of remaining inventory plus all pending claims. Tested after every operation of pseudo-random sequences of adds, swaps, claims and removals (idle, two-way, and vault pools with yield and loss injected while positions are open); see "Known limitations from review" in the crate README for what the pool does not protect against.
3. Rounding always favors the pool; no payout exceeds what the position is owed (at most about 1 stroop per bin per fill or claim stays in the pool as dust).
4. Fees: `fee_bps` of the QUOTE price leg of each fill, credited to the bin's LPs pro rata to bin shares (same accumulator mechanism as proceeds).
5. Per-bin accounting is share based: `total_shares` per bin, `shares` per position per bin, accumulators `proceeds_per_share` and `fees_per_share` (internal scale 1e18, was drafted as 1e12); a late depositor into a partly filled bin must not steal earlier proceeds. A fully filled bin that is reused starts a new generation.
6. Vault (optional, pool level): if `vault` is set, ALL QUOTE-denominated balances (Bid inventory, proceeds, fees) are held as DeFindex vault shares and accounted in shares, so vault yield accrues to the owning positions without any keeper. A swap does one state-changing vault call (buy: one `deposit`; sell: one `withdraw`, preceded by one read-only `get_asset_amounts_per_shares` for the price). If a withdrawal fails or pays less than needed the swap reverts. If `vault` is None everything is held idle in the pool.
7. Position ids are monotonic from 1; `remove_position` after a partial fill returns the unfilled remainder plus claimable amounts exactly once.
8. Events: `position_added`, `position_removed`, `claimed`, `swap` (topics include owner or taker).

## Client notes

- Vault pool views: `quote_swap` (sell side), `get_position`, `get_bin` (Bid), `depth` (Bid) and `tvl` call the DeFindex `get_asset_amounts_per_shares`, which updates a fee report inside the vault. Run them with `simulateTransaction` and never submit them (the stellar CLI auto-submits when a simulation is not read-only; use `--send=no`). They are cheap to simulate (about 10 M instructions).
- A buy needs the taker's QUOTE transfer authorized under the swap call (the simulation records the auth tree: `taker` signs `swap` and the nested `transfer(taker, pool, amount)` on the QUOTE SAC; a sell signs the BASE `transfer`). `add_position` is the same with the deposited asset.
- `amount_in` of a buy is a maximum that includes the fee; the pool pulls less if the book or `max_bins_per_swap` ends first. Re-run `quote_swap` right before `swap` and pass `min_out`.
- Bins an LP can use must be on the side of the market it wants: crossed books are allowed (an Ask below a Bid), the pool does not prevent them.
- Quote a client-side depth chart from `depth(Ask, lo, hi)` and `depth(Bid, lo, hi)`, at most 100 bins per call.
- Concurrency: every call reads the instance entry; a swap, deposit or removal that empties or fills a bin also writes it (the book bitmap lives there), and every swap writes the bins it crosses. Transactions that touch the same bins or write the instance entry in the same ledger are serialised by the network.

## Mode::TwoWay

Available when `Config.supports_two_way` is true (pools without a vault, stage D build: `lbond-usdc-twoway`). A two-way position rests on both sides of each bin's price (DLMM style): the bin holds a BASE reserve that is for sale at the bin price and a QUOTE reserve that bids for BASE at the same price. A buyer's QUOTE lands in the QUOTE reserve, a seller's BASE in the BASE reserve, so the price coming back through the bin refills it. `add_position(owner, side, TwoWay, lo, hi, amount, weights)`: `side` = the asset deposited (`Ask` = BASE for bins above the market, `Bid` = QUOTE for bins below it); amounts, weights, limits and errors as for directional positions.

Fields of a two-way `Position`: `inventory` = BASE held now, `pending_proceeds` = QUOTE held now (reserves, only `remove_position` pays them out), `pending_fees` = claimable fees (QUOTE), `filled` = BASE traded through the position's bins in either direction, `deposited` = the amount put in. `claim` pays fees only (`PositionPayout.base` is 0); `remove_position` pays the position's slice of both reserves plus fees. Directional and two-way liquidity share the book (directional first at each price); `get_bin` / `depth` include the two-way reserve in `inventory`. Details and limits: `contracts/lotus_pool/README.md`, "Two-way mode".

## Deployments

`deployments/testnet.pool.json` lists pool instances (one contract per pair and yield strategy):

```json
{"network":"testnet","rpc":"...","horizon":"...","passphrase":"...","abi":"docs/pool-abi.md","abi_version":1,"updated_at":"...",
 "pools":[{"id":"lbond-usdc-idle","label":"LBOND / USDC (idle USDC)","status":"live","contract":"C...",
  "base":{"code":"LBOND","issuer":"G...","sac":"C..."},"quote":{"code":"USDC","issuer":"G...","sac":"C..."},
  "vault":null,"strategy_id":null,"bin_step_bps":10,"fee_bps":10,"max_bins_per_swap":100,"supports_two_way":false,
  "admin":"G...","wasm_hash":"...","deploy_txs":{},"smoke_test_txs":[],"measurement_txs":{},"demo_book":{},"notes":"..."},
 {"id":"lbond-usdc-defindex","label":"LBOND / USDC (USDC in DeFindex -> Blend)","status":"live","contract":"C...","vault":"C...","strategy_id":"usdc-defindex-blend","...":"..."},
 {"id":"lbond-usdc-twoway","label":"LBOND / USDC (idle USDC, two-way LPs enabled)","status":"live","supports_two_way":true,"...":"..."}]}
```

`strategy_id` refers to an entry of `deployments/testnet.strategies.json` when the DeFindex vault comes from one (`usdc-defindex-blend`, our own vault on the Blend USDC strategy, status live). Fields beyond the ones in the v0 draft (`rpc`, `horizon`, `passphrase`, `max_bins_per_swap`, `admin`, `wasm_hash`, `deploy_txs`, `smoke_test_txs`, `measurement_txs`, `demo_book`) are additive.

## Changes from the v0 draft

- Constructor, functions, types, error semantics and events are as drafted. `Mode::TwoWay` is implemented for pools without a vault. Added: `set_max_bins_per_swap`, `abi_version`, the error table, the event data shapes, `positions_of` cap, `depth` cap (100 bins), the amount and range limits.
- Accumulator scale is 1e18 (drafted as 1e12); it is internal and not visible through the ABI.
- The book index is a 401-bit bitmap per side in instance storage, not a sorted `Vec<i32>`.
- The fee is charged on top of the price leg (buyer pays more, seller receives less); the LP keeps its exact limit price.
- `max_bins_per_swap` starts at 100 (measured: 100-bin swaps use 12 to 15 percent of the CPU budget and 54 to 63 percent of the ledger-entry budget).
- `fee_bps` in the live instances is 10 (the draft example used 30).
