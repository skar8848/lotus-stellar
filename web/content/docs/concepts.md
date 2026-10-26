# Concepts

> The directional range pool and its bins, the four places an order can wait, the receipt token and its redemption at par, the curator rule, and why orders are locked until filled.

## Units

All on-chain amounts are `i128` stroops (7 decimals: `1 USDC = 10_000_000`). Pool prices are QUOTE per BASE in fixed point `1e7` (`1.0000000 = 10_000_000`). BASE is `LBOND`, QUOTE is `USDC` (Blend testnet USDC).

## The directional range pool

`lotus_pool` keeps liquidity on a grid of **bins**. The price of bin `n` is

```
price_at(n) = round_half_up(1e7 * (1 + bin_step_bps / 10_000) ^ n)
```

with bins from `-200` to `200`. The live instances use `bin_step_bps = 10` (0.1 percent per bin), so bins `-20..20` cover about 0.98 to 1.02. A position covers at most 64 bins, each non-empty bin share must be at least `10_000` stroops, and a swap walks at most `max_bins_per_swap` (100) bins.

A position has a **side**:

- `Ask`: deposits BASE (LBOND) and sells it as the price rises through its bins; it receives USDC.
- `Bid`: deposits QUOTE (USDC) and buys LBOND as the price falls; it receives LBOND.

and a **mode**:

- `Directional` (the default and the product): inventory only goes down, proceeds only come in, and proceeds are never re-offered. The position never trades back.
- `TwoWay` (opt-in, only on pools without a vault): DLMM-style bins that hold both assets, so liquidity crosses back when the price returns, like a classic AMM LP. Directional and two-way liquidity share the same book; at each price, the swap takes directional liquidity first.

**Fees**: 10 bps (`fee_bps = 10`), charged on top of the price leg and credited to the bin's LPs. The LP always receives its exact limit price. A buyer pays `ceil(q) + ceil(q * fee_bps / 10000)`, a seller receives `floor(q) - ceil(q * fee_bps / 10000)`, where `q = quantity * bin_price`.

**Yield vault (optional, per pool instance)**: a pool instance can hold its whole USDC leg (bid inventory, ask proceeds, fees) as DeFindex vault shares, so it earns Blend interest without a keeper. A buy swap deposits the taker's USDC into the vault; a sell swap withdraws exactly what the taker is owed, just in time. The yield strategy is a property of the instance, so there is one instance per strategy (idle, vault-backed, two-way).

## The four strategies

One order, chosen once:

| | Yield off | Earn yield |
|---|---|---|
| **Lotus pool** | `add_position(Directional)` on the idle pool instance. 1 signature. | `add_position(Directional)` on the vault-backed instance (USDC leg in DeFindex on Blend). 1 signature. |
| **Stellar DEX** | One classic transaction, one `manageSellOffer` per bin, quoted in USDC. 1 signature. | Offers quoted in the receipt `lUSDCb`. Sell: 1 signature. Buy: `lotus_vault.deposit(USDC)` then the offers, 2 signatures. |

- **Ladder mapping.** Each bin becomes one SDEX offer at `price_at(bin)` with the bin's own amount. The SDEX ladder is capped at 50 levels (the pool allows 64), so the order plus up to two trustlines fit in one transaction.
- **Why two transactions for a receipt buy.** A Soroban call must be the only operation of its transaction, so the deposit and the offers cannot be atomic. The app has both signed up front and only submits the offers once the deposit has succeeded. If the deposit fails nothing moves; if the offers fail, the user simply holds the receipt, redeemable at par, and can post the offers again.
- **Where yield comes from.** Blend testnet supply interest, through a DeFindex vault the Lotus team created and seeded into the Blend strategy. Accrual is real; the rate follows Blend's testnet utilization, so it is an observation, not a forecast. BLND emissions are not counted.

## The receipt: lUSDCb

`lUSDCb` is a **classic Stellar asset**. The admin of its Stellar Asset Contract (SAC) is the `lotus_vault` Soroban contract, which mints on deposit and distribution, burns on redeem, and tracks supply.

- `deposit(from, amount)`: USDC goes into the DeFindex vault (which lends on Blend); `amount` of the receipt is minted 1:1.
- `redeem(from, amount)`: the receipt is burned, the vault is withdrawn from, USDC is returned. **1:1 while fully backed**; pro rata (`amount * vault_value / supply`) if the vault position ever lost value, so the last redeemer is never left holding an unbacked receipt.
- `distribute(recipients, amounts)` (keeper only): the keeper submits holders and amounts; each line is capped on-chain at `surplus * balance / supply` and the total cannot exceed the surplus. The keeper can omit a holder or be late; it cannot over-mint or redirect yield. Balances locked in open SDEX offers count, because an offer is a selling liability, not a transfer.

**Par redemption keeps the peg.** `deposit` and `redeem` are permissionless and 1:1. If the receipt trades under 1 USDC anyone can buy it and redeem; above 1, anyone can deposit and sell. The `USDC / lUSDCb` book is that peg book. Redemption depends on Blend having liquidity: if Blend is fully utilized, redemption waits and the receipt can trade at a discount.

**Why a receipt and a pool.** A Blend position or a DeFindex share is a Soroban token: it cannot sit in an SDEX offer or be a path-payment hop. `lUSDCb` can be the quote of a ladder and the middle leg of a path payment (`USDC -> lUSDCb -> LBOND` in one transaction), so a taker holding only USDC never has to know the receipt exists.

Known limitation: **just-in-time yield capture**. Distribution mints to current balances, so someone who deposits right before a distribution and redeems right after captures a share they did not earn. The planned fix is an exchange-rate (share-price) token.

## The buffer: lUSDC

`lUSDC` is the same receipt design on a second `lotus_vault` whose DeFindex vault is **never lent**: the USDC stays available, so it comes out instantly and redemptions never wait on Blend. It is made for orders close to the price, about to fill, and for the working capital a market maker keeps at hand. It earns nothing; `lUSDCb` is for orders that can wait.

**Why two receipts.** A generic lending vault keeps blind buffers because it never knows when a depositor will withdraw. The Lotus curator does: every dollar sits behind a limit order with a known price, range and distance to the market. Capital behind orders about to fill stays unlent (`lUSDC`); capital behind orders that can wait is lent on Blend (`lUSDCb`). That is more yield for the same liquidity risk, and it lets large providers keep their yield while they post depth on Stellar. Today the split is enforced by the curator rule below; routing every order automatically by its distance to the price is the next step.

## The curator rule

Yield is not offered for a **pool Bid** whose range starts within 10 bins (about 1 percent) of the reference price, because every trade would recall that USDC from the vault: little yield, more failure risk. In the app, the "Lotus pool + Blend yield" card is then disabled with "Too close to the price" and a **Change range** button.

- Sell orders are never blocked (their yield is on proceeds that wait).
- Receipt orders on the SDEX are never blocked (a receipt in an open offer keeps earning).
- The rule lives in the app (`PROXIMITY_MIN_BINS = 10`); the contracts do not enforce it.

## Direction rule

A sell range sits at or above the reference price of the venue it rests on; a buy range sits at or below it. The app clamps handles and presets and marks a strategy unavailable when its own reference price breaks the rule. The contract does not prevent crossed books (an Ask below a Bid).

## Locked orders

In the app, a **directional order is locked until it is fully filled**: you can **Claim** proceeds and fees at any time, but Remove is replaced by "Early redemption, soon". The same holds for SDEX ranges quoted in a Lotus receipt. Two-way LP positions keep Remove.

This is a product rule enforced by the UI only. On-chain, the pool contract's `remove_position` works at any time for the owner, and SDEX offers belong to the user's account and can be cancelled by any Stellar client.

## Compliance from the asset

`LBOND` is `AUTH_REQUIRED`, `AUTH_REVOCABLE` and clawback-enabled. Makers and takers need a trustline authorized by the issuer, and the pool contract itself is authorized through the LBOND SAC. An unauthorized taker's trade fails at the protocol level with `op_not_authorized`. Compliance comes from the asset, not from pool code; the faucet authorizes testnet trustlines for you.
