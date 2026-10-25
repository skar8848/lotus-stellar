# Lotus: questions judges will ask

Short, honest answers. Everything described runs on Stellar testnet unless stated otherwise. Nothing is audited.

## 1. Aquarius already has concentrated liquidity on Soroban. What is new?

Ranges are not the innovation; bins and ranges are a known design (Trader Joe LB, Meteora DLMM, Aquarius CLMM). What Lotus adds is direction as the product: a position is one-way by construction (inventory only goes down, proceeds only come in, nothing trades back) and two-way is an explicit opt-in. On top of that the USDC leg can sit in a DeFindex vault on Blend and is recalled just in time by the taker's own swap. Aquarius pools are complementary: the receipt pair can be listed on Aquarius too.

## 2. Why a receipt token if you have a pool?

Because the SDEX is where Stellar's liquidity and routers already are. A Blend position or a DeFindex share is a Soroban token: it cannot sit in an SDEX offer or be a path-payment hop. `lUSDCb` is a classic asset, so it can be the quote of a ladder and the middle leg of a path payment, and an SDEX offer does not move funds, so the order keeps earning while it waits. A Stellar core engineer we spoke to also preferred staying on the SDEX over Soroban liquidity walls that appear near the price when a trade comes in. So we kept the pool and made the yield tradable on the SDEX.

## 3. Is the volume real?

The transactions are real and on-chain. The source is not users: it is three accounts we run (two market makers and an arbitrageur) trading assets we issue (LBOND) or mint through the vault (the receipt). Their addresses are in `deployments/testnet.bot.json`. We describe it as market-maker volume everywhere, and the arbitrage profit in the demo scenarios is a transfer between our own accounts. There are no users on a hackathon testnet; the point is to exercise the mechanism under load. Measured: depeg restored in 10 to 12 s, cross-venue dislocation closed in 26 s, two 10-minute runs with 0 failed transactions.

## 4. Where does the yield come from, and why did earlier testnet vaults show none?

Blend supply interest, through a DeFindex vault we created and seeded ourselves. The existing PaltaLabs testnet vault earned nothing because DeFindex invests a deposit in proportion to the vault's existing allocation and skips an asset with nothing invested; only the vault's rebalance manager could seed it. We observed about 6.9 percent APR over 34 minutes, which follows Blend's testnet utilization (88.7 percent then; about 1.6 percent at 70 percent utilization). It is an observation, not a forecast.

## 5. Who runs the keeper, and what can it do wrong?

We do. `distribute` is keeper-only and the admin can rotate the keeper. The contract caps every mint at `surplus x balance / supply` using balances before any minting, and the total cannot exceed the surplus, so the keeper can omit a holder or be late but cannot over-mint or move one holder's share to another. The known cost of the simple design is **JIT yield capture**: someone who deposits just before a distribution and redeems after captures a pro-rata share they did not earn, and a holder who redeems early forfeits accrued yield. The fix is an exchange-rate token; until then the keeper should run often. The vault-backed pool does not have this issue, since yield accrues in vault shares held by the positions.

## 6. How is the receipt's peg kept?

By redemption at par. `deposit` and `redeem` are permissionless and 1:1, so if the receipt trades under one USDC anyone can buy and redeem, and above one anyone can deposit and sell. In the demo our arbitrageur does this: a depeg to 0.985 was restored in 10 to 12 seconds. The `USDC/lUSDCb` book needs a resting liquidity provider; today that is us.

## 7. What if Blend is illiquid?

Redemption waits, and the receipt would trade at a discount until liquidity returns. If the vault position ever loses value, redemptions pay pro rata rather than at par, so nobody drains the backing ahead of others. Same risk as any lending receipt. Roadmap: a liquidity buffer outside the vault.

## 8. What can the LBOND issuer do to the pool?

LBOND is `AUTH_REQUIRED`, `AUTH_REVOCABLE` and clawback-enabled on purpose (it models a regulated RWA). The issuer must authorize the pool's trustline through the LBOND SAC, and could revoke it. If that happens, swaps that deliver LBOND fail, and a Bid LP's USDC cannot be exchanged for LBOND until the issuer re-authorizes. A quote-only exit for Bid LPs is on the roadmap. This is an issuer-trust property of RWAs on Stellar, not something a venue can remove.

## 9. What did the adversarial review of the pool find?

No solvency or overpay bug. Findings and what we did: the vault pool can hit a footprint race (the vault's idle USDC flips by a stroop between simulation and inclusion), so the client re-simulates and resends; Bid LP USDC can be trapped if the LBOND leg is undeliverable (documented); a dead yield branch in the fuzz test (fixed); a fee-free mixed-bin swap in two-way mode (documented, low severity); junk-bin griefing (mitigated by minimum bin size and `max_bins_per_swap`). Two of the three live instances were deployed from an earlier build of the same source; redeploying them is on the list. Details in `contracts/lotus_pool/README.md`.

## 10. What will fees look like on mainnet?

Unmeasured. On testnet, calls that touch Blend through our vault cost between 0.0015 and 0.14 XLM, and a strategy withdraw used about 3.5M CPU instructions of 400M and 13 of 200 ledger entries. An earlier measurement of about 100 XLM did not reproduce and is retracted. Mainnet rent differs and needs measuring.

## 11. Why Stellar rather than an EVM chain?

Three protocol features we could not replicate elsewhere: an orderbook whose offers reserve funds as liabilities, path payments that cross two books atomically, and asset-level authorization and clawback enforced by the network. Plus the SAC: a Soroban contract can administer a classic asset, which is how the receipt exists. The RWA issuers we want first (USDY, Etherfuse Stablebonds) already trade here.

## 12. What is the adoption path?

One issuer and one treasury, not retail. An RWA issuer distributes on a ladder (SDEX) or a directional pool position; a treasury accumulating the asset posts bids whose USDC earns while waiting. Takers keep paying in USDC through path payments and routers that cover the SDEX. Market makers on RWA pairs come next, with Aquarius market incentives as the complement.

## 13. Regulatory angle?

We are not lawyers and this is a testnet prototype. The contract holds the funds, not us; the yield is a pass-through from a transparent lending market; the Stellar asset model lets an issuer require authorization and use clawback for compliance. A yield-bearing dollar token raises securities and e-money questions that a mainnet launch would need to analyse per jurisdiction.

## 14. Security and audit plan?

Small contracts with written invariants and tests: supply never exceeds vault value, distributions are capped on-chain, pool accounting is checked for solvency after every operation of randomized sequences. No audit yet, no pause, no timelock, no upgrade path, and the testnet receipt issuers are not locked. Before mainnet: external audit with OpenZeppelin's audited Stellar library as the base for access control and pausing, lock the receipt issuer after `set_admin`, add a pause and a timelock, and a bug bounty.
