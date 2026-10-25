# Lotus: questions judges will ask

Twelve hard questions and short answers. Everything described runs on Stellar testnet unless stated otherwise.

## 1. Why not an AMM?

Because the users we target do not want two-way liquidity. An issuer distributing a bond wants to sell down a ladder and keep the proceeds; a treasury accumulating wants to buy down a ladder and keep the bonds. An AMM forces both into round trips and leaves them holding whatever the market sells them. An orderbook gives one-way, price-explicit liquidity natively, and on Stellar it also keeps the funds in the maker's account. Lotus adds the one thing the book lacks: the quote capital earns while it waits. We built the AMM version of this idea at ETHGlobal New York; on Stellar the protocol makes it unnecessary.

## 2. Why not use Aquarius concentrated liquidity on Soroban?

Aquarius already runs CLMM pools on Soroban and we do not compete with them on ranges. A concentrated position is still two-way and still custodied by the pool. Our users want their inventory in their own account, under their own compliance flags, with explicit prices, and they want the idle half of the position to earn. A Stellar core engineer we spoke to at the event also preferred this over a Soroban pool with just-in-time withdrawals: liquidity walls that appear next to the price when a trade comes in are a bad signal for takers. If anything, lUSDC pairs on Aquarius or in its SDEX market incentives are complementary.

## 3. Is this not just a wrapped aToken?

In backing, yes: lUSDC is a receipt for a lending position. The difference is the form. A Blend position or a DeFindex vault share is a Soroban token; it cannot sit in an SDEX offer or be a path-payment hop. lUSDC is a classic asset, so it can be the selling asset of a ladder and the middle leg of a path payment. It is also kept at par: yield is distributed by minting to holders rather than by a drifting exchange rate, so books stay quoted in dollars. And the distribution reaches balances locked as selling liabilities, which is the whole point.

## 4. Who runs the keeper, and what can it do wrong?

Today, we do, from `scripts/`. `distribute` is a keeper-only entry point and the admin can rotate the keeper. What it can do wrong is bounded by the contract: each mint is capped at `surplus x balance / supply` using balances snapshotted before any minting, the total cannot exceed the surplus, supply is tracked by the contract as sole minter, and surplus is read from the vault. The keeper can omit holders or be late; it cannot over-mint, and it cannot move one holder's share to another. A holder who redeems between distributions forfeits yield accrued since the last one to the remaining holders, which is a known cost of the simple design. The roadmap replaces the keeper with per-holder claims from a snapshot or merkle root, or with an exchange-rate token.

## 5. How is the peg kept?

By redemption at par. `deposit` and `redeem` are permissionless and 1:1, so if lUSDC trades below one USDC on the peg book anyone can buy it and redeem; if it trades above, anyone can deposit and sell. The `USDC/lUSDC` book needs a resting LP to make path payments smooth; in the demo that is us, and the spread is bounded by the fee of a deposit or redeem round trip.

## 6. What if Blend is illiquid?

Then redemption waits. The contract withdraws from the DeFindex vault, which withdraws from Blend; if the pool is fully utilized the withdraw fails or is partial, and lUSDC would trade at a discount on the peg book until liquidity returns. If the vault position ever loses value, redemptions pay pro-rata rather than at par, so no holder can drain the backing ahead of the others. This is the same risk any lending receipt carries, and we state it rather than hide it. Mitigations on the roadmap: a liquidity buffer kept outside the vault, and vault parameters that cap how much of the backing is deployed.

## 7. What is the regulatory angle of lUSDC?

We are not lawyers and this is a testnet prototype. What we can say about the design: the contract holds the funds, not us; the yield is a pass-through from a transparent lending market; and the Stellar asset model lets the lUSDC issuer be a regulated entity if needed, with `AUTH_REQUIRED` limiting holders to a known set and clawback available for compliance, the same tools the RWA issuers on Stellar already use. A yield-bearing dollar token raises securities and e-money questions in several jurisdictions, and a mainnet launch would need that analysis per market.

## 8. What will fees look like on mainnet?

Unmeasured, and we say so. On testnet, operations that touch Blend through DeFindex cost around 100 XLM, most likely driven by ledger-entry rent (not isolated), while compute is small (a withdraw used about 3.5M CPU instructions of the 400M limit and 13 of 200 ledger entries). Mainnet rent parameters differ and the figure needs measuring. The economics also favour the intended users: deposits are treasury-sized, and the keeper amortizes a distribution across all holders in a batch. Posting and filling SDEX offers remain classic operations with classic fees.

## 9. Why Stellar rather than an EVM chain?

Three protocol features we could not replicate elsewhere: an orderbook where offers reserve funds as liabilities instead of moving them, path payments that cross two books in one atomic operation, and asset-level authorization and clawback enforced by the network. On an EVM chain we had to build a custom pool and escrow yield-bearing tokens inside it. The RWA issuers we want as first users are also here: USDY, Etherfuse Stablebonds and sovereign issuances already trade on SDEX.

## 10. How does "one-way" differ from a normal limit order?

It does not. A limit order is one-way: when it fills, it is gone, and nothing trades back. "One-way directional liquidity" was the name we gave at ETHGlobal New York to the behaviour big holders want and AMMs do not provide. On Stellar the orderbook provides it natively, so Lotus does not change order semantics at all. It changes what the capital does while the order waits.

## 11. What is the adoption path?

One issuer and one treasury, not retail. Step one: an RWA issuer on Stellar quotes a ladder of asks in lUSDC instead of USDC; the pitch is that proceeds earn from the moment they hit the book. Step two: a treasury accumulating that asset posts bids in lUSDC; its cash earns while it waits. Takers keep paying in USDC through path payments and never see lUSDC, and Soroswap and LumAgg already route through SDEX, so the pair is reachable by aggregator users. Market makers on RWA pairs come next, with Aquarius market incentives as the complement.

## 12. What is the security and audit plan?

The contract is deliberately small: deposit, redeem, distribute, and one invariant: a distribution can never push lUSDC supply above vault value. If the vault ever loses value, redemptions pay pro-rata instead of at par. The mint cap is enforced on-chain and supply is tracked by the contract as sole minter. Before mainnet: an external audit, with OpenZeppelin's audited Stellar contracts library as the reference for access control, pausing and upgrade patterns rather than hand-rolled versions; the lUSDC issuer key locked after `set_admin` so no one can mint outside the contract; a pause switch and a timelock on admin operations; and a bug bounty. On testnet the issuer key is kept for recovery and none of this has been audited.
