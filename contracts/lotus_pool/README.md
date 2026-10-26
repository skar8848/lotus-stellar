# lotus_pool

The Lotus **directional range pool** for Soroban. Liquidity providers put BASE (`Side::Ask`) or QUOTE (`Side::Bid`) on a grid of price bins. A directional position is one-way by construction: its inventory only goes down as takers fill it, and what it earned can never be bought back. Optionally the whole QUOTE leg (bid inventory, ask proceeds, fees) is held in a DeFindex vault that lends on Blend and is recalled just in time by the taker's own swap.

Prior art: the owner's EVM version (`lotus-main`, one-way ladders with JIT yield recall), Trader Joe LB / Meteora DLMM bins (public ideas only), Aquarius' CLMM interface (only used as a naming reference). Discrete bins, not ticks.

* Interface, types, invariants and the deployments file: [`docs/pool-abi.md`](../../docs/pool-abi.md) (kept in sync with this crate).
* Live instances: [`deployments/testnet.pool.json`](../../deployments/testnet.pool.json) (the front end and the bot poll it).
* Wasm: `lotus_pool.wasm` is 43.9 KB with all four stages (limit 128 KB); the stage A-C build, which `lbond-usdc-defindex` still runs, was 36.5 KB.

| stage | what | state |
|---|---|---|
| A | directional asks, shares + accumulators, sorted-by-bitmap book, `quote_swap`/`swap`, `claim`, `remove_position`, views, events | done, tested, deployed |
| B | directional bids (QUOTE inventory, BASE proceeds), sell swaps | done, tested, deployed |
| C | vault-backed QUOTE leg (DeFindex shares, yield accrues to the owning positions) | done, tested, deployed (own Blend vault) |
| D | `Mode::TwoWay` (crossback LP, DLMM-style bins, pools without a vault) | done, tested, deployed (`lbond-usdc-twoway`) |

## Interface

```rust
__constructor(admin, base, quote, vault: Option<Address>, bin_step_bps: u32, fee_bps: u32)

add_position(owner, side, mode, lo_bin, hi_bin, amount, weights: Vec<u32>) -> u64
claim(owner, id) -> PositionPayout            // pays pending proceeds + fees, position stays open
remove_position(owner, id) -> PositionPayout  // pays unfilled inventory + pending proceeds + fees, closes (the id disappears)

quote_swap(buy_base, amount_in) -> SwapQuote  // read only, never reverts for lack of liquidity
swap(taker, buy_base, amount_in, min_out) -> i128

get_config() / get_position(id) / positions_of(owner) / get_bin(side, bin) / depth(side, from, to)
tvl() / price_at(bin) / abi_version()
set_max_bins_per_swap(max_bins)               // admin only; the admin has no other power
```

Bins are `-200..=200`; a position spans at most 64 bins, each non-zero share of the deposit must be at least `0.001` unit (10_000 stroops) and the amount at most `1e18` stroops. `bin_step_bps` is `1..=100`, `fee_bps` is `0..=1000`.

### Errors

| # | name | when |
|---|---|---|
| 1 | NotInitialized | call before the constructor |
| 2 | InvalidAmount | amount <= 0 or > 1e18 |
| 3 | InvalidRange | lo > hi, outside [-200, 200], more than 64 bins |
| 4 | InvalidWeights | weights length != bins, or all zero |
| 5 | InvalidConfig | constructor / admin parameter out of range |
| 6 | NoSuchPosition | unknown or already removed id |
| 7 | NotOwner | claim/remove by someone who is not the owner |
| 8 | NoLiquidity | the swap would move nothing |
| 9 | SlippageExceeded | amount_out < min_out |
| 10 | NotImplemented | `Mode::TwoWay` on a pool that has a DeFindex vault (or on the stage A-C builds) |
| 11 | Overflow | arithmetic overflow (checked everywhere) |
| 12 | AmountTooSmall | a bin would get < 0.001 unit, or too little to mint a share |
| 13 | BinDust | the bin is almost fully filled (remaining < 1e-6 of its shares): use another bin |
| 14 | VaultShortfall | the DeFindex vault paid less than needed, minted 0 shares, or has a zero share price |
| 15 | TooManyPositions | the owner already has 100 open positions |

Authorization failures (`owner`, `taker`, `admin`) surface as host `Auth` errors.

### Events

| topics | data (map) |
|---|---|
| `["position_added", owner]` | `id, side, lo_bin, hi_bin, amount` (read `get_position(id).mode` to tell a two-way position) |
| `["position_removed", owner]` | `id, base, quote` |
| `["claimed", owner]` | `id, base, quote` (only emitted when something was paid) |
| `["swap", taker]` | `buy_base, amount_in, amount_out, fee, bins_crossed, last_bin` |

`Side` and `Mode` are unit-variant enums: they travel as `ScVal::Vec([Symbol("Ask")])` etc. (`--side Ask` on the CLI).

## How the accounting works

Every bin keeps `inventory`, `total_shares` and three per-share accumulators scaled by 1e18: `acc_x` (inventory consumed), `acc_p` (proceeds), `acc_f` (fees). A position holds `shares` in each of its bins plus the accumulator values at the time it joined (or last claimed). Pending proceeds are `shares * (acc_p - ckpt_p) / 1e18`. Consequences:

* a fill costs one storage write per bin crossed, however many LPs share the bin; positions are not touched by swaps;
* a late depositor into a partly filled bin gets `amount * total_shares / inventory` shares and the current checkpoints, so it never sees earlier proceeds;
* `claim` writes only the position; `remove_position` burns the shares and pays `shares * inventory / total_shares`;
* a bin that is fully filled and then reused starts a new generation: the old accumulators are sealed in their own record and earlier positions keep reading them (the bin record is never deleted, so generations never collide);
* the book is walked through a bitmap of non-empty bins per side (401 bits in the instance entry), because Soroban storage cannot be iterated.

Invariants (each has a unit test):

1. per bin, `inventory` never increases in a fill, `filled` and the accumulators never decrease (a new generation resets the accumulators but bumps `gen`);
2. solvency: the pool's BASE balance covers every open position's remaining inventory plus pending BASE proceeds, and its QUOTE balance (plus vault shares at the current price) covers every Bid inventory, Ask proceeds and fees; checked after every operation of deterministic pseudo-random sequences of adds, swaps, claims and removals: idle pools, pools with two-way positions, and vault pools where yield and small losses (a slash of the vault's underlying) are injected while positions are open. Extreme walks (`extreme_*`) cover the full grid, steps 1 to 100 bps, fees 0 to 1000 bps, 64-bin positions, zero weights, log-uniform amounts from 0.001 to 100,000 units, overlapping LPs on a few hot bins, and a vault seeded with only 50 USDC with yield and loss. There is no per-position fairness oracle (each payout is only checked to be at most what the view showed, and the pool to be solvent); building one would need a reference model of the whole book;
3. every division rounds in the pool's favour: takers pay `ceil`, payouts are `floor`, accumulators are `floor`; the cost is at most about 1 stroop per bin per fill or claim, which stays in the pool as dust (never negative);
4. `claim` then `remove_position` pays exactly once; a removed id cannot be claimed or removed again;
5. `quote_swap` and `swap` share the same planner, so the quote is the swap result (asserted in the random walk).

### Fees and rounding (what a client needs to replicate a quote)

`fee_bps` is charged on the QUOTE price leg `q = quantity * bin_price` of every fill and credited to the bin's LPs through the fee accumulator. The LP still gets its exact limit price.

* **buy** (`buy_base = true`, Ask bins from the lowest price): for each bin with price `P`, inventory `I`, remaining budget `R`: `q_max = floor(R * 10000 / (10000 + fee_bps))`, `x = min(I, floor(q_max * 1e7 / P))`, stop if `x == 0`; `q = ceil(x * P / 1e7)`, `fee = ceil(q * fee_bps / 10000)`, the taker pays `q + fee`; stop after a bin that the budget could not empty. The taker pays at most `amount_in`, only what is needed is pulled.
* **sell** (`buy_base = false`, Bid bins from the highest price): remaining BASE `B`, bin QUOTE value `cap` (the inventory in QUOTE; with a vault `floor(units * V / S)` from `get_asset_amounts_per_shares`): `x = min(B, floor(cap * 1e7 / P))`, skip the bin if `x == 0`; `q = floor(x * P / 1e7)`, `fee = ceil(q * fee_bps / 10000)`, the taker receives `q - fee` (a bin that would pay 0 is skipped). A remainder that could never pay anything is swept to the bin's LPs as fee so no unfillable dust stays in the book.
* `avg_price = total_quote * 1e7 / base_amount` where total_quote is what the taker pays (buy, fee included) or receives (sell, net of fee), rounded down.
* `partial` is true when the walk stopped for lack of liquidity or because `max_bins_per_swap` was reached before the input was used up; it is false when the leftover input is too small to buy one more stroop.
* at most `max_bins_per_swap` bins are visited per call (visited bins that are skipped count).

### Price grid

`price_at(bin) = round_half_up(1e7 * (1 + bin_step_bps / 10000) ^ bin)`, `bin in [-200, 200]`. Integer algorithm (a BigInt port reproduces it bit for bit): `f = 1e18 + step_bps * 1e14`; `p = f^|bin|` by binary exponentiation with `mul(a, b) = (a * b + 5e17) / 1e18`; for a negative bin `p = (1e36 + p / 2) / p`; `price = (p + 5e10) / 1e11`. [`test-vectors.json`](test-vectors.json) holds the exact prices for steps 1, 5, 10, 20, 25, 50 and 100 bps (generated by [`gen_test_vectors.py`](gen_test_vectors.py) with exact rational arithmetic, not with this algorithm); the unit test `price_matches_exact_vectors` checks all 2807 values, and the TypeScript port should check the same file.

### Vault mode (stage C)

With `vault = Some(v)` the pool keeps **QUOTE units** instead of QUOTE stroops: bid inventory, ask proceeds and fees are counted in DeFindex vault shares and the share price moves with Blend interest, so the owning positions earn it without a keeper. Views convert units to QUOTE with `get_asset_amounts_per_shares(shares_held_by_the_pool)` (rounded down).

* buy swap: one `deposit` of the taker's QUOTE, the minted shares are split over the crossed bins in proportion to what each earned;
* sell swap: one read-only `get_asset_amounts_per_shares` (the price) and one `withdraw`; the number of shares withdrawn is rounded up so the vault always pays at least what the taker is owed, and the swap reverts (`VaultShortfall`) if it pays less or if the withdrawal fails;
* `add_position(Bid)`: one deposit; `claim` / `remove_position`: one withdrawal when there is QUOTE to pay; an Ask `add_position` and BASE payouts never call the vault.
* the nested transfer that DeFindex performs on a deposit is pre-authorised with `authorize_as_current_contract`, exactly as in `lotus_vault`.
* yield and losses are shared pro rata by the positions holding the shares; a vault that loses value lowers Bid inventory and Ask proceeds alike.

DeFindex `get_asset_amounts_per_shares` updates a fee report inside the vault. From outside the contract, `quote_swap` (sell side), `get_position`, `get_bin` (Bid), `depth` (Bid) and `tvl` on a vault pool must be run with `simulateTransaction` and **never submitted** (the `stellar` CLI submits automatically when a simulation is not read-only: pass `--send=no`).

## Two-way mode (stage D)

`add_position(.., Mode::TwoWay, ..)` puts liquidity on both sides of each bin's price, like a Trader Joe LB / Meteora DLMM bin. A two-way bin holds a BASE reserve `x` and a QUOTE reserve `y` at one price `P`: `x` is for sale at `P` and `y` bids for BASE at `P`. A buyer's QUOTE lands in `y` (and the bin's BASE leaves `x`); a seller's BASE lands in `x` (and QUOTE leaves `y`). So when the price comes back through a bin that was sold through, the QUOTE it received buys the BASE back and the bin is refilled, and the LPs earn fees in both directions. This is the opposite of the directional mode, where proceeds are never re-offered.

* `side` says which asset is deposited: `Ask` = BASE, `Bid` = QUOTE. A BASE deposit is meant for bins above the market, a QUOTE deposit for bins below it, which gives the DLMM layout (BASE above, QUOTE below, both only in the bin the price is crossing). The pool has no global "current price", so it does not check this; a deposit into a bin that already holds both assets gets a pro-rata slice of both (shares are minted against the bin's value in BASE at its price; the depositor effectively trades a bit of its deposit at the bin price without paying the fee, which only costs the other LPs some fee revenue, never principal).
* Directional and two-way liquidity share the book. At each price the swap takes the directional bin first, then the two-way bin; each record counts as one bin for `max_bins_per_swap`. `get_bin` / `depth` add the two-way reserve to `inventory` (BASE on the Ask side, QUOTE on the Bid side); `total_shares` and `filled` are the directional bin's.
* `Position` fields for a two-way position: `inventory` = BASE held now, `pending_proceeds` = QUOTE held now (both are reserves, only `remove_position` pays them out), `pending_fees` = claimable fees, `filled` = BASE traded through the position's bins in either direction. `claim` pays fees only; `remove_position` pays the position's slice of both reserves plus fees.
* Fees, rounding and the dust sweep are the same as for directional bins; the fee is credited through the same per-share accumulator. There is no generation or `BinDust` concept for two-way bins (value is only moved between the two reserves), except that a bin that holds nothing but unclaimed fees refuses deposits until its LPs leave.
* Only pools without a vault support it (`Config.supports_two_way`); on a vault pool `add_position` returns `NotImplemented`.
* Tested: the crossback round trip with exact numbers (`two_way_crossback_round_trip`, reproduced on testnet in the same ledger-by-ledger numbers), merging with directional liquidity, late depositors, QUOTE deposits, the bin cap and slippage, and the same pseudo-random solvency walk as for the directional mode with two-way positions in the mix (5 seeds, plus coarse and fine grids and extreme fees).

## Build, test, deploy

Requirements: Rust >= 1.84 with `wasm32v1-none`, `stellar` CLI 28.x.

```sh
cargo test -p lotus_pool                  # 58 host tests (about 4 minutes, the random walks dominate); `-- --ignored` adds a deeper fuzz run
cargo test                                # whole workspace
stellar contract build --package lotus_pool
stellar contract optimize --wasm target/wasm32v1-none/release/lotus_pool.wasm
```

Deploy on testnet (the recipe used for the live instances; `lotus-pool-admin` is a funded key):

```sh
stellar keys generate lotus-pool-admin --network testnet --fund

# BASE = the classic asset LBOND (AUTH_REQUIRED + AUTH_REVOCABLE + CLAWBACK, issuer rwa_issuer). Deploy its SAC once:
stellar contract asset deploy --asset LBOND:GCMNI332OEZL2AVBKJVDZ2IPREWMEYRENGFFVEGXS4JVXUWJEIAT5EQF \
  --network testnet --source-account lotus-pool-admin            # -> CAVDLKQ2T4XBIQNY2WBUZKWQM6YDQ6NVX2N3HQ3P5Z2SBQ3VNZCBVBKE

# idle USDC variant
stellar contract deploy --wasm target/wasm32v1-none/release/lotus_pool.optimized.wasm \
  --source-account lotus-pool-admin --network testnet --alias lotus-pool-idle -- \
  --admin $(stellar keys address lotus-pool-admin) \
  --base CAVDLKQ2T4XBIQNY2WBUZKWQM6YDQ6NVX2N3HQ3P5Z2SBQ3VNZCBVBKE \
  --quote CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU \
  --bin_step_bps 10 --fee_bps 10

# vault-backed variant: Option<Address> arguments are JSON, so quote the address
#   ... --vault '"CDCIDX5FXOENXW4ODR2D7QMRKL4F2NTZYFVZEFF63GTNRVVDXLCQ7EEC"' ...

# the issuer must authorise the pool contract to hold LBOND (see "LBOND and the SAC" below)
stellar contract invoke --id CAVDLKQ2T4XBIQNY2WBUZKWQM6YDQ6NVX2N3HQ3P5Z2SBQ3VNZCBVBKE \
  --source-account <rwa_issuer> --network testnet -- set_authorized --id <pool> --authorize true
```

Using it (the CLI simulates every call and builds the auth tree, so `--source-account` must be the `owner` / `taker` itself):

```sh
POOL=C...; ME=$(stellar keys address lotus-pool-maker)
# 100 LBOND over bins 0..4, uniform
stellar contract invoke --id $POOL --source-account lotus-pool-maker --network testnet -- add_position \
  --owner $ME --side Ask --mode Directional --lo_bin 0 --hi_bin 4 --amount 1000000000 --weights '[]'
# buy up to 50 USDC worth of LBOND
stellar contract invoke --id $POOL --source-account lotus-pool-taker --network testnet -- swap \
  --taker $(stellar keys address lotus-pool-taker) --buy_base true --amount_in 500000000 --min_out 0
stellar contract invoke --id $POOL --source-account lotus-pool-maker --network testnet -- get_position --id 1
stellar contract invoke --id $POOL --source-account lotus-pool-maker --network testnet -- claim --owner $ME --id 1
stellar contract invoke --id $POOL --source-account lotus-pool-maker --network testnet -- remove_position --owner $ME --id 1
# views on the vault pool: --send=no
stellar contract invoke --id $VAULT_POOL --source-account lotus-pool-maker --network testnet --send=no -- quote_swap --buy_base false --amount_in 200000000
```

### LBOND and the SAC

LBOND has `AUTH_REQUIRED`. For a contract holder the Stellar Asset Contract treats a missing balance as **not authorized** when the issuer requires authorization, so the first `transfer` into a fresh pool fails with `balance is deauthorized` until the issuer calls `set_authorized(pool, true)` (this creates a zero balance entry flagged authorized, and with `CLAWBACK` enabled also flagged clawback-able). Verified on testnet: `authorized(pool)` is `false` after deploy and `true` after the call. Makers and takers still need an authorized LBOND trustline. Compliance comes from the asset, not from pool code: the issuer can revoke the pool (`set_authorized(pool, false)`, the asset is `AUTH_REVOCABLE`) or claw LBOND back out of it, which would break the pool's solvency for BASE. That is the intended trust model for a regulated asset, not something the pool can defend against.

## Testnet instances and measured costs

Addresses and tx hashes are in `deployments/testnet.pool.json`: `lbond-usdc-defindex` runs the stage A-C build; `lbond-usdc-idle` (redeployed on 26 October 2026, the earlier instance is listed under `retired_pools`) and `lbond-usdc-twoway` run the final build (a superset; same swap costs within a few percent). Costs below are `simulateTransaction` with zero instruction leeway on testnet (limits per transaction: 400,000,000 instructions, 200 ledger entries read, 200 written, 132 KB); `fee` is the fee actually charged on-chain.

Idle pool (`vault = null`):

| operation | bins | CPU instructions | entries read / written | bytes written | on-chain fee |
|---|---|---|---|---|---|
| buy | 1 | 2.5 M | 9 / 5 | 1.1 KB | 0.0018 XLM (2 bins) |
| buy | 5 | 3.8 M | 13 / 10 | 3.6 KB | 0.0025 XLM (6 bins) |
| buy | 20 | 9.1 M | 28 / 25 | 9.7 KB | 0.0049 XLM |
| buy | 60 | 27.0 M | 68 / 65 | 25.9 KB | |
| buy | 79-100 | 37.8 M (80) - 49.8 M (100) | 88 / 85 - 108 / 105 | 33.9 - 42.0 KB | 0.0155 XLM (79 bins, on-chain) |
| sell | 1 / 5 / 20 | 2.7 M / 3.9 M / 9.4 M | 10 / 13 / 28 read | | 0.0050 XLM (20 bins) |
| sell | 94 | 47.4 M | 102 / 99 | 39.6 KB | 0.0182 XLM (on-chain) |
| `add_position` | 5 / 20 / 64 | 2.7 M / 7.1 M / 25.1 M | 12 / 27 / 71 read | 4.8 / 13.8 / 40.2 KB | 0.15 XLM for 5 bins (new entries pay rent) |

Vault-backed pool (own DeFindex vault on Blend):

| operation | bins | CPU instructions | entries read / written | bytes written | on-chain fee |
|---|---|---|---|---|---|
| buy (1 deposit) | 1 / 5 / 20 / 60 / 100 | 10.4 M / 11.8 M / 17.6 M / 36.7 M / 60.6 M | 26 / 30 / 45 / 85 / 125 read | 5.9 - 45.9 KB | 0.0050 XLM (6 bins), 0.0074 XLM (20 bins) |
| sell (1 price query + 1 withdraw) | 1 / 5 / 20 / 59 | 12.5 M / 13.5 M / 20.4 M / 40.4 M | 25 / 29 / 44 / 83 read | 5.4 - 28.9 KB | 0.0218 XLM (100 bins, on-chain) |
| `add_position(Bid)` | 10 | 12.0 M | 35 / 25 | 11.7 KB | |

Chosen `max_bins_per_swap = 100` (also the compile-time ceiling): a 100-bin swap uses 12 percent of the CPU budget and about 55 percent of the ledger-entry budget on the idle pool, 15 percent and 63 percent with the vault, and 79- and 94-bin swaps (idle) and a 100-bin sell (vault) were executed on testnet. Cost is linear: about 0.5 M instructions and 1 read + 1 write per bin on top of a base of 2 M (idle) or 10 M (vault). The admin can lower it with `set_max_bins_per_swap` without a redeploy.

Vault call count per swap, read from the diagnostic events of the on-chain transactions (`tx 931081e2...` buy, `66772c2a...` sell): buy = one DeFindex `deposit`; sell = one `get_asset_amounts_per_shares` and one `withdraw`. The unit test `vault_calls_per_operation` asserts the same counts.

## Known limits and risks

See also "Known limitations from review" below.

* **Asset trust**: LBOND's issuer can freeze or claw back the pool's BASE (see above). USDC (Blend testnet) has no such flags.
* **Vault liveness**: if the DeFindex vault cannot withdraw (Blend illiquid, vault paused), sells, `claim` and `remove_position` revert as a whole, including the removal of an Ask whose unfilled BASE is not in the vault, as soon as QUOTE is owed. There is no emergency exit. Buys still work (deposit path).
* **Vault share price**: a vault with a tiny supply and a large donated balance mints zero shares for small deposits; the pool then reverts with `VaultShortfall` instead of crediting nothing. The testnet vault holds about 1,150 USDC in shares at a price close to 1.
* **Rounding dust**: up to about 1 stroop per bin per fill or claim stays in the pool and belongs to nobody; with a vault, the excess a withdrawal returns over the conservative estimate also stays as idle QUOTE.
* **Griefing**: a permissionless book can be padded with many tiny bins (minimum 0.001 unit each) so that a swap spends its `max_bins_per_swap` on them; the taker repeats the call. The `BinDust` guard stops a bin from being griefed into share-price overflow.
* **Crossed books are allowed**: an Ask below a Bid is a limit-order crossing, not an error; whoever takes both legs gets the better prices and the LPs get their limit prices.
* **State rent**: persistent entries are bumped to 30 days on every touch; a bin or position untouched for longer is archived and must be restored before it can be used (an archived sealed generation blocks `claim` of the positions that read it until restored).
* **No upgrade, no pause, no fee switch**: the admin can only change `max_bins_per_swap`.
* Concurrent signers: the demo accounts are shared by several agents on testnet, so a CLI call can fail with `tx_bad_seq`; retry.
* Not audited.

## Stage status

A, B, C and D are implemented, unit-tested (58 tests, 8 of them for two-way, 4 documenting limitations, plus an ignored deep fuzz) and deployed on testnet. Not done: two-way positions on a vault-backed pool, an emergency exit when the vault is illiquid, any upgrade path, an audit.

`price-reference.mjs` is a BigInt reference for `price_at` (`node price-reference.mjs` checks all 2807 test vectors, 0 mismatches) that the front end and the bot can copy.

## Known limitations from review

An independent adversarial review found no solvency or payout bug. It found these limits, which are real and are not fixed in this build (tests named `limitation_*` assert the current behaviour):

* **(a) LBOND leg dependency.** `claim` and `remove_position` pay BASE first and revert as a whole. A Bid LP whose LBOND authorization is revoked, or any Bid LP with BASE proceeds after the issuer claws back the pool's LBOND, cannot withdraw even the USDC leg until it is re-authorized (an Ask LP cannot remove either after a clawback). This follows from the issuer's compliance powers over LBOND. Roadmap fix: a quote-only exit, or an unpaid-BASE credit.
* **(b) Shared-vault footprint race.** A transaction that withdraws from the shared DeFindex vault (sell, `claim`, `remove_position` on a vault pool) can fail with `Error(Storage, ExceededLimit)` when the vault's idle USDC flips between 0 and 1 stroop between simulation and inclusion (other users of the same vault, such as `lotus_vault`, change the footprint). This explains the failed `remove_position` `a05a511e...` on `lbond-usdc-defindex`. Clients must simulate right before signing, and re-simulate and resend once or twice on that error.
* **(c) Two-way fee sniping.** Depositing into a mixed two-way bin and withdrawing right away is a fee-free swap at the bin price (just-in-time liquidity). It costs the other LPs fee income, not principal.
* **(d) Junk bins.** Dust bins (0.001 unit each) count against `max_bins_per_swap`, so a spammer can make a swap spend its whole bin budget on them. Takers are protected by `min_out`; they can retry until the junk is consumed.
* **(e) Accounting edges.** The pool's tracked vault shares (`QuoteShares`) are not reconciled with `vault.balance(pool)`, so excess withdrawal proceeds stay as unaccounted idle QUOTE. `quote_rate` panics (`VaultShortfall`) if the pool's shares are worth less than 1 stroop. Persistent entries are only bumped on write, so a bin that is only read (for example by `claim`) is not extended.
* **(f) Source of the two older instances.** `lbond-usdc-idle` and `lbond-usdc-defindex` were deployed from an earlier build of this crate without `TwoWay`, and their exact source is not preserved in git (the repository was first committed after they were deployed). Only `lbond-usdc-twoway` is built from the committed source (wasm hash `e3e966eb...`). The tests cover the committed source; the older instances differ from it in the two-way code and the planner refactor, which the same unit tests were run against before and after.
