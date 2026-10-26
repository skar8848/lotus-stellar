# Overview

> Lotus is directional liquidity and yield-bearing orders for Stellar. One order, chosen once, waits in one of four places. Everything runs on Stellar **testnet**; nothing is on mainnet and nothing is audited.

## What Lotus is

Lotus is two products that work together:

1. **The Lotus pool** (`lotus_pool`, a Soroban contract): a range pool on a grid of price bins where the liquidity provider chooses a direction. A directional position only sells its inventory and only receives proceeds; nothing trades back. The USDC leg can optionally sit in a DeFindex vault that lends on Blend, so resting liquidity earns while it waits and is recalled just in time by the taker's own swap.
2. **The receipt token** (`lotus_vault`, a Soroban contract, plus the classic asset `lUSDCb`): USDC deposited into a DeFindex vault comes back as a classic Stellar asset at 1:1. Classic assets can be quoted on the Stellar DEX (SDEX), and an SDEX offer never moves funds out of the account, so a limit order quoted in the receipt keeps earning Blend interest while it waits in the book.

The market today is `LBOND / USDC`. `LBOND` is a **simulated** tokenized bond issued by the Lotus team with `AUTH_REQUIRED`, `AUTH_REVOCABLE` and clawback, to model a regulated real-world asset.

## The problem

Depth is idle capital. A resting order earns nothing, and an AMM position forces the holder into round trips they do not want: buy low, get sold back the asset higher, hold whatever the market leaves. The holders who own the inventory and the cash, issuers and treasuries, are the ones who could provide depth and have the least reason to.

On Stellar, yield-bearing RWAs already exist (Ondo USDY, Etherfuse Stablebonds). The asset side of a bond pair earns while it sits; the quote side, USDC, does not. Lotus makes the USDC side earn too.

## One order, four places to wait

A liquidity provider creates one **range limit order** (sell LBOND across a price range, or USDC waiting to buy it) and chooses, at creation, where it waits:

| | Yield off | Earn yield (USDC leg in DeFindex on Blend) |
|---|---|---|
| **Lotus pool** | directional position on the idle pool, 1 signature | directional position on the vault-backed pool, 1 signature |
| **Stellar DEX** | ladder of offers quoted in USDC, 1 signature | ladder quoted in the receipt `lUSDCb`, 1 signature (sell) or 2 (buy: deposit, then offers) |

Each bin of the range becomes one SDEX offer at the same price and size, so the order is the same wherever it waits. The choice is made once, at creation: a live position is never migrated between venues. Details in [Concepts](/docs/concepts.md).

## How the pieces connect

```
                Stellar classic layer                         Soroban layer
  +---------------------------------------------+   +-------------------------------------+
  | SDEX order books                            |   | lotus_pool   directional bins       |
  |   LBOND / lUSDCb, USDC / lUSDCb, LBOND/USDC |   |              (optional two-way)     |
  | Classic assets: LBOND, USDC, lUSDCb         |   | lotus_vault  deposit / redeem /     |
  +----------------------^----------------------+   |              distribute, admin of   |
                         | mints / burns lUSDCb     |              the lUSDCb SAC         |
                         +--------------------------+ DeFindex vault --> Blend lending    |
                                                    +-------------------------------------+
  Bot (team accounts): market makers + arbitrageur, quotes and arbitrage across both venues
```

The pool and the SDEX are two venues for the same pair. They are linked on-chain only through shared assets and the DeFindex vault; prices are free to differ and an off-chain arbitrageur closes the gap.

## Status and honest limitations

- **Testnet only.** Network passphrase `Test SDF Network ; September 2015`. No mainnet deployment, no audit, no pause, no upgrade path.
- **Volume is our own.** Trades on the Lotus markets come from accounts run by the Lotus team (two market makers and an arbitrageur). It is market-maker volume, not user volume. See [Bots and volume](/docs/bots-and-volume.md).
- **LBOND is simulated.** Its price follows a simulated US 10-year Treasury model; the only real input is the starting yield.
- **Yield is observed, not promised.** Blend testnet supply interest is real, and its rate follows Blend's testnet utilization. Any APR the app shows is labelled "observed on testnet, not a forecast".
- **Known weaknesses** of the receipt: yield is distributed by a keeper that mints to current holders, so a just-in-time depositor can capture a share it did not earn. The vault-backed pool does not have this problem (it accounts yield in vault shares).
- **Issuer trust.** The LBOND issuer can revoke a trustline, including the pool's; a Bid LP's USDC could then be stuck until re-authorization.
- **Footprint race** on the vault-backed pool: a transaction can fail with `ExceededLimit` when the shared vault changes by a stroop between simulation and inclusion; the app re-simulates and resends.

The full list is on the [FAQ](/docs/faq.md) and in the repository README.

## Where to go next

- [Concepts](/docs/concepts.md): bins, the four strategies, the receipt, the curator rule, locked orders.
- [Using the app](/docs/using-the-app.md): `/swap`, `/pools`, `/trade`, `/portfolio`, `/faucet`.
- [Contracts](/docs/contracts.md): ABI, errors, events and live testnet addresses.
- [Integrate](/docs/integrate.md): SDK, MCP server for AI agents, HTTP endpoints.
- For AI agents: [`/llms.txt`](/llms.txt), [`/llms-full.txt`](/llms-full.txt), and [`/api/health`](/api/health) to check that the deployment works.
