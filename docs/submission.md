# Lotus: submission answers (draft)

Draft answers for the HackMeridian submission form. Placeholders in angle brackets are filled at submission time.

## Project name

Lotus

## One-liner (140 characters max)

Directional range pools on Soroban plus a Blend-yield receipt token whose SDEX orders keep earning while they wait.

(112 characters.)

## Description (300 words max)

A resting order is dead capital, and the holders who could provide depth, RWA issuers and treasuries, have the least reason to. Lotus has two products that use the same stack.

The Lotus pool (`lotus_pool`, Soroban) is a range pool on price bins where a liquidity provider picks a direction. A directional position only sells its inventory and only receives proceeds; nothing trades back. Two-way mode with crossback is an opt-in. The USDC leg can sit in a DeFindex vault that lends on Blend, recalled just in time by the taker's swap, so waiting liquidity earns. The yield strategy is the choice of pool instance; three are live on testnet.

The receipt token brings the same yield to Stellar's native orderbook. `lUSDCb` is a classic asset minted 1:1 against USDC by `lotus_vault`, the admin of its Stellar Asset Contract, backed by our own DeFindex vault on Blend. An SDEX offer does not move funds, so a limit order quoted in `lUSDCb` keeps earning. A taker with only USDC buys the simulated RWA LBOND, issued with authorization and clawback flags, in one path payment USDC -> `lUSDCb` -> LBOND.

Yield on testnet is real: about 6.9 percent APR observed over 34 minutes from Blend supply interest, a rate that follows testnet utilization and is not a forecast. A local bot (two market makers and an arbitrageur) generates the trading activity: that is market-maker volume, not users, and we say so. It restores a peg break in 10 to 12 seconds and closes a pool-versus-SDEX dislocation in 26.

The app has Trade, Pools and Portfolio pages with explorer links throughout. Limits are in the README: JIT yield capture in `distribute`, issuer trust on LBOND, no audit.

The design follows HackMeridian mentor feedback: a Stellar core engineer preferred the SDEX over just-in-time liquidity walls, and the DeFindex team endorsed tokenization, so we kept the pool and made the yield tradable on the SDEX.

(About 290 words.)

## Tracks

Both.

Stellar Unlocked. The product depends on core protocol features: SDEX offers that reserve funds as liabilities, path payments across two books in one transaction, classic assets whose SAC admin is a Soroban contract, and issuer authorization and clawback flags that enforce compliance without venue logic, plus two Soroban contracts.

Stellar Composed. The yield is composed from DeFindex (a vault we created and seeded through the testnet factory) and Blend (lending), consumed both by the receipt vault and by the pool. Horizon and stellar.expert serve the order book and verification.

## Stellar features used

- SDEX: `manage_sell_offer` ladders (up to 50 levels per transaction in the app); selling liabilities keep funds in the account.
- Path payments: `path_payment_strict_send` USDC -> `lUSDCb` -> LBOND.
- Classic assets and the Stellar Asset Contract: the receipt is a classic asset with `lotus_vault` as SAC admin; the pool is authorized for LBOND through the SAC.
- Asset flags: `AUTH_REQUIRED`, `AUTH_REVOCABLE`, `AUTH_CLAWBACK_ENABLED` on LBOND.
- Soroban: `lotus_pool` (bins, shares and accumulators, bitmap book, optional vault, two-way mode) and `lotus_vault`, with a mock vault for tests.
- Horizon: order book, offers, trades, liabilities.

## Ecosystem tools used

- DeFindex (our own vault, seeded into a Blend strategy, backing both products).
- Blend (the lending market where the USDC earns).
- stellar.expert and Horizon for verification; stellar CLI for build and deploy; Stellar Wallets Kit in the app.

## What was built during the hackathon, and what existed before

Before: the idea and the name. Lotus started as a one-way directional-liquidity AMM built by a team at ETHGlobal New York 2026, where it won the Uniswap track. That codebase is EVM; only the look of the front end (colors, buttons, range-builder presentation) was carried over, no EVM logic.

During HackMeridian, solo, on Stellar: the `lotus_pool` Soroban contract (58 tests, randomized solvency fuzz, adversarial review), the `lotus_vault` contract (12 tests), the classic-asset setup, the DeFindex vault and Blend integration with real yield, three live pool instances, the SDEX seeding and path-payment scripts, the keeper, the market-maker and arbitrage bot, the Next.js app (Trade, Pools, Portfolio), and all documentation. The design changed on site after mentor conversations: the SDEX became a first-class venue through the receipt token, and the pool stayed.

## How to run

See the README at the repository root and the per-folder READMEs. In outline: `stellar contract build` and `cargo test --workspace`; in `scripts/`, `npm install` then `npm run setup`, `issue`, `mint`, `seed`, `take`, `keeper`, `bot`; in `web/`, `npm install` and `npm run dev`. Testnet addresses are in `deployments/`.

## Team

Alban Derouin, solo. Product and integration profile. GitHub: skar8848.

## Links

- Repository: <GITHUB_URL> (private until submission; judges are invited)
- Demo video (3 min): <VIDEO_URL>
- Pitch deck: `docs/pitch-deck.md` in the repository, or <DECK_URL>
- Live app (testnet): <APP_URL>
- `lotus_vault` v2 on stellar.expert: https://stellar.expert/explorer/testnet/contract/CCCZ6XUDCWTOKZS6AYNECY3QPOFBICGMBBZXM63U4WZQD4EBFYFW2QKG
- Pool `lbond-usdc-defindex` on stellar.expert: https://stellar.expert/explorer/testnet/contract/CDNG7T2KSDQ7ZYXHSDAM63RLLVPCQ5V6T5GRTXOOX47EZEMU636ZFPNG
- `lUSDCb` asset on stellar.expert: https://stellar.expert/explorer/testnet/asset/lUSDCb-GC7QBZD2LMPZZ3BT4ZLKPYUR23GJKT47BLYJKMXUY523M7HMUGT64TVO

## Disclosures

Testnet only, no audit. Trading activity is generated by our own market makers and arbitrageur (addresses in `deployments/testnet.bot.json`), with assets we issue or mint. Known limitations (JIT yield capture, LBOND issuer powers, footprint race, no pause or upgrade path) are listed in the README.

## What we would do with three more months

First, remove the trusted keeper with an exchange-rate receipt token, and add a quote-only exit for Bid LPs on the pool. Second, get to mainnet properly: measure the real fee and rent profile of Blend-touching operations, work with DeFindex on a production USDC vault, and scope an audit with OpenZeppelin's Stellar practice. Third, land one pilot: an RWA issuer on Stellar distributing on a ladder or a pool position, a treasury accumulating on the other side, with Soroswap or LumAgg routing takers. In parallel, add EURC as a second underlying, a second yield strategy per pool, and start the privacy work (hidden maker identity via commitments, ZK on the Protocol 25 host functions).
