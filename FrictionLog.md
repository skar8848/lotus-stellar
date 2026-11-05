# Friction log: Lotus on Stellar (HackMeridian 2026)

## The pitch: a new DEX primitive where efficiency is the design

On most DEXs, resting liquidity is idle. A limit order earns nothing while it waits, and an AMM position forces the provider into round trips they never asked for.

**Lotus is a new primitive: the directional range order.** A maker sells (or buys) across a price range, one way only, and the capital behind the order **works while it waits**. I designed it around four ideas:

- **Efficiency in the design, not bolted on.** The quote leg of an order sits in a DeFindex vault lending on Blend, so a maker earns lending yield on resting liquidity on top of their limit price. An open SDEX offer keeps earning too, because an offer moves no funds.
- **It plugs into the SDEX instead of competing with it.** The SDEX already has the volume share, the traders, and the market makers, who generally prefer an order book to Uniswap-style pools. Lotus orders and receipts are native SDEX citizens, routable by path payment, so takers keep the liquidity they already know. Makers get more reasons to quote there:
  - **On the SDEX**, they get their limit price plus the Blend yield on their idle capital, through the receipt token.
  - **In the Lotus pool**, they are also paid for making: fees (10 bps) are credited to the liquidity providers of each bin, on top of the yield.
- **Curators get information that generic vaults never have.** A normal lending vault must keep blind buffers, because it cannot know when a depositor will leave. Behind a limit order, the curator knows the price, the range, and the distance to the market. Capital behind orders about to fill stays liquid (`lUSDC`); capital behind orders that can wait is lent (`lUSDCb`). The limit order is the information that allows a more complex, better-hedged, more lucrative strategy without more risk. Today this routing is a curator rule in the app (no pool yield for a bid within about 1 % of the price). **Fully automatic routing by distance to the price is the next step.**
- **The best of both layers.** Classic Stellar (SDEX, path payments, asset flags, offers as liabilities) gives the liquidity and the compliance. Soroban (the pool, the vault, the SAC admin) gives the programmability.

**Why not a simpler "JIT wall" design?** The simpler idea is to lend the liquidity and withdraw it when the price gets near the target, so depth appears just in time. It creates liquidity walls that show up and vanish around the price. That is toxic for market makers, who cannot trust the depth they see, and it is a selling-pressure signal for the market. In Lotus the order is a real limit order, posted at its price and visible from the start. It never moves. Only the place where the idle funds are stored (the vault) is recalled, and only at the moment a trade fills it.

Built solo in 24 hours at HackMeridian. Everything is on testnet; nothing is audited. See [README.md](README.md) for the full design and its limitations.

## What I built, and with which Stellar tools

| Tool | How I used it |
|---|---|
| Soroban (Rust SDK) | 2 production contracts (`lotus_pool`, `lotus_vault`) and a mock DeFindex vault for tests. 72 tests. The pool's wasm is 43.9 KB. |
| Stellar CLI (28.1.0) | `contract build`, deploy and invoke. `--send=no` and `--cost` to simulate and measure resources. |
| JS SDK (`@stellar/stellar-sdk` 17) | Scripts, bots, web app, SDK and MCP server: transaction building, simulation, `manage_sell_offer` ladders, `path_payment_strict_send`. |
| Horizon + Soroban RPC | Order books, trades, offers and liabilities through Horizon. Simulation and submission through RPC. |
| SDEX, classic assets | A simulated RWA (LBOND) with `AUTH_REQUIRED`, `AUTH_REVOCABLE` and clawback. Path payment USDC -> receipt -> LBOND. |
| Stellar Asset Contract | A contract as admin of a classic asset's SAC: it mints and burns the receipt. |
| Stellar Wallets Kit / Freighter | Wallet connection and signing in the app. Automated tests used a dev-only secret-key signer, so wallet signing was not covered by my headless e2e. |
| DeFindex, Blend (testnet) | My own DeFindex vault seeded into a Blend strategy. Real interest observed, about 7 % APR (not a forecast). |
| Raven MCP (`stellar-raven`) | Docs search (`stellarDocs`) to confirm SAC-admin and single-operation rules, and ecosystem search (`scout`, `lumenloop`) to find prior art (Aquarius CLMM, Soroswap/LumAgg routing). |
| stellar.expert | Explorer links across the app. |

## Where it got hard, and how I got through it

Each of these cost me time. Each one is solved in the repo and live on testnet. Durations are rough estimates.

1. **DeFindex testnet vault that never earned** (about 4-5 h). The existing USDC vault left deposits idle, and no doc said why. I read the DeFindex source: it invests in proportion to the existing allocation and skips an asset with nothing invested, and only the rebalance manager can seed it. I created my own vault through the factory and seeded it. **Result: real Blend interest, about 7 % APR observed.**
2. **Testnet USDC** (about 1 h). Friendbot only gives XLM, and the Blend faucet pays once per account. I chained disposable accounts and classic payments, which also stocked a faucet for judges.
3. **One Soroban operation per transaction** (about 1-2 h of redesign). A deposit plus SDEX offers cannot be atomic, and a contract cannot own SDEX offers. I pre-sign two transactions and only submit the second if the first succeeds. If the second fails, the user holds a receipt redeemable at par.
4. **`ExceededLimit` footprint race** (about 1-2 h). The vault's idle balance can change by a stroop between simulation and inclusion. The app re-simulates and resends. This is unit-tested but not yet exercised live.
5. **DeFindex views write state** (about 30 min). I treat them as simulate-only everywhere.
6. **RPC saturation and sequence collisions** (about 1-2 h). I added retries, one account per bot, and an automatic fallback RPC. After that, two 10-minute bot runs had 0 failed transactions and 0 HTTP 429.
7. **A fee number that did not reproduce** (about 30 min). A measurement said about 100 XLM per Blend call. Later measurements gave 0.0015-0.14 XLM. I retracted it in the repo and never found the cause.
8. **Reproducible builds** (about 1 h). The same source gave different wasm hashes across redeploys. Only 2 of the 4 deployed contracts can be rebuilt to their deployed hashes today. The README says so, and the toolchain is not pinned yet.
9. **Thin integration docs for Blend and DeFindex** (about 1 h). A Raven docs search for Blend supply and withdraw returned dashboards, not integration docs, so I learned the integrations from their code.
10. **RWA authorization** (about 1 h). `AUTH_REQUIRED` means every trustline and the pool contract need the issuer. On testnet the faucet stands in for a compliance desk.

## A note on fit with the ecosystem

I want to be straight about this, in a constructive way. Mentors told me they preferred things to stay on the SDEX and were wary of JIT liquidity walls. I took that seriously and spent a large share of the 24 hours finding the cleanest way to use the SDEX: the receipt token, the path payments, the offers that keep earning. What I noticed afterwards is that the ecosystem today leans toward on-chain TradFi (RWAs, regulated assets) more than toward DeFi composability, and the DeFi building blocks (vaults, lending, curated strategies) are thinner on testnet and in the docs.

I did not reshape the idea to fit what seemed easier to judge, and I did not switch to a more classic project. I kept the design and found the best way to implement it on Stellar. That is also why I think Stellar is a good place for it: the SDEX has the volume and the market makers, and a primitive that makes their capital more efficient adds to it.

## What worked well

- Fast Soroban iteration: small wasm, cheap testnet calls, `--send=no` and `--cost` to measure before sending.
- A contract as SAC admin of a classic asset: the receipt is a normal SDEX asset, and offers keep earning through selling liabilities.
- Path payments: USDC -> receipt -> LBOND in one transaction, without the taker knowing the receipt exists.
- Protocol-level compliance: `op_not_authorized` comes for free.
- Raven: doc confirmation and prior-art discovery in one call.

## What would make building easier

- A seeded, documented DeFindex testnet vault, and a doc on the proportional-allocation rule.
- A repeatable Blend testnet USDC faucet.
- A doc page on footprint races for contracts calling vaults.
- A way to batch a Soroban call with classic operations, or contracts that can place SDEX offers.
- Rate-limit guidance and several documented endpoints for the public testnet RPC.
- Pinned toolchain and reproducible-build tooling in the contract templates.
- Better docs for DeFi building blocks (Blend, DeFindex) and for composing them with the classic layer.
