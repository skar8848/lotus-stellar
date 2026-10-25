# Lotus: submission answers (draft)

Draft answers for the HackMeridian submission form. Placeholders in angle brackets are filled at submission time.

## Project name

Lotus

## One-liner (140 characters max)

Yield-bearing liquidity for Stellar's orderbook: lUSDC earns Blend yield while your limit orders wait in the book.

(114 characters.)

## Description (300 words max)

Orderbooks need depth, and depth is resting capital that earns nothing. The holders who could provide it, RWA issuers with inventory and treasuries with cash, have the least incentive to park money in a book. Stellar makes a different answer possible: an SDEX offer does not move funds, it records a liability on the account. If the quote asset itself bears yield, every resting order earns while it waits.

Lotus is that quote asset. `lUSDC` is a classic Stellar asset minted 1:1 against USDC by a Soroban contract, `lotus_vault`, which is the admin of the asset's Stellar Asset Contract and its only minter. Deposited USDC is lent on Blend through a DeFindex vault. Redemption is at par. A keeper calls `distribute`; the contract mints each holder's share of accrued yield, capped on-chain at `surplus x balance / supply`, so the keeper can omit a holder but never over-mint or redirect funds. Because a holder's balance includes amounts committed to open offers, makers earn on their resting bids.

On testnet we seed two SDEX books: `LBOND/lUSDC`, where LBOND is a simulated tokenized bond issued with AUTH_REQUIRED, AUTH_REVOCABLE and clawback (an unauthorized taker's trade fails at the protocol level), and `USDC/lUSDC`, a peg book kept honest by par redemption. A taker holding only USDC buys LBOND in a single path payment USDC -> lUSDC -> LBOND, so lUSDC is invisible to buyers.

Users: issuers distributing an RWA on a ladder of asks, treasuries accumulating with a ladder of bids, and market makers on RWA pairs. Yield-bearing RWAs already trade on Stellar (USDY, Etherfuse Stablebonds); Lotus makes the other side of those pairs earn too.

The design follows HackMeridian mentor feedback: a Stellar core engineer preferred SDEX over a Soroban pool with just-in-time withdrawals; the DeFindex team endorsed the tokenization approach.

(Under 300 words.)

## Tracks

Both.

Stellar Unlocked. The product only works because of core protocol features: SDEX offers that reserve funds as liabilities instead of moving them, path payments across two books in one transaction, classic assets whose SAC admin is a Soroban contract, and issuer authorization and clawback flags that enforce compliance without venue logic. We removed our own AMM design in favour of the native orderbook because the protocol already provides one-way, fund-preserving orders.

Stellar Composed. The yield is composed from two ecosystem protocols: the contract deposits into a DeFindex vault, which lends on Blend. Horizon and stellar.expert are used for the orderbook view and verification in the app and the demo.

## Stellar features used

- SDEX: `manage_sell_offer` / `manage_buy_offer` ladders; selling liabilities keep funds in the account.
- Path payments: `path_payment_strict_send` USDC -> lUSDC -> LBOND.
- Classic assets and the Stellar Asset Contract: lUSDC is a classic asset; `set_admin` hands minting to the `lotus_vault` contract.
- Asset flags: `AUTH_REQUIRED`, `AUTH_REVOCABLE`, `AUTH_CLAWBACK_ENABLED` on LBOND.
- Soroban: `lotus_vault` contract (deposit, redeem, capped distribute, supply accounting, vault integration), with a mock vault for tests.
- Horizon: orderbook, offers, trades and account liabilities.

## Ecosystem tools used

- DeFindex (vault that holds the USDC backing and allocates to a Blend strategy).
- Blend (lending market where the backing earns).
- stellar.expert and Horizon for verification; stellar CLI for build and deploy.

## What was built during the hackathon, and what existed before

Before: the idea and the name. Lotus started as a one-way directional-liquidity AMM built by a team at ETHGlobal New York 2026, where it won the Uniswap track. That codebase is EVM and is not reused here.

During HackMeridian, on Stellar, from scratch: the `lotus_vault` Soroban contract and its tests, the classic-asset setup (lUSDC with the contract as SAC admin, LBOND with authorization and clawback flags), the DeFindex and Blend integration on testnet, the SDEX seeding scripts for both books, the path-payment demo, the distribution keeper, the Next.js app, and all documentation. The design itself changed on site after mentor conversations: the custom pool was dropped for SDEX.

## How to run

See the README at the repository root and the per-folder READMEs (`contracts/`, `scripts/`, `web/`). In outline: `stellar contract build` and `cargo test` for the contract; in `scripts/`, `npm install` then `npm run setup`, `issue`, `mint`, `seed`, `take`, `keeper` (and `yield` to simulate accrual: the DeFindex testnet USDC vault currently keeps deposits idle, so no Blend interest accrues on testnet); `npm install` and `npm run dev` in `web/`. Testnet addresses are in `deployments/testnet.contract.json` and `deployments/testnet.classic.json`.

## Team

Alban Derouin, solo. Product and integration profile. GitHub: skar8848.

## Links

- Repository: <GITHUB_URL>
- Demo video (3 min): <VIDEO_URL>
- Pitch deck: `docs/pitch-deck.md` in the repository, or <DECK_URL>
- Live app (testnet): <APP_URL>
- `lotus_vault` on stellar.expert (testnet): <CONTRACT_URL>
- lUSDC asset on stellar.expert (testnet): <ASSET_URL>

## What we would do with three more months

First, remove the trusted keeper: replace `distribute` with per-holder claims against a snapshot or merkle root, or move to an exchange-rate design, so yield reaches holders without anyone running a job. Second, get to mainnet properly: measure the real fee and rent profile of Blend-touching operations (around 100 XLM per transaction on testnet today), work with DeFindex on a production USDC vault, and scope an audit with OpenZeppelin's Stellar practice using their audited Stellar contracts library as the base for access control and pausing. Third, land one pilot: an RWA issuer on Stellar distributing on an lUSDC ladder with weekly distributions, and a treasury accumulating on the other side, with Soroswap or LumAgg routing takers through the pair. In parallel, add EURC as a second underlying and start the privacy work (hidden maker identity via commitments, with ZK proofs on the Protocol 25 host functions as a later step).
