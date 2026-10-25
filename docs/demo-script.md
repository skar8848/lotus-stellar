# Lotus: demo video script

Target length: 3:00 or less. Screen recording with voice-over. Everything shown is on Stellar testnet.

Numbers below (amounts, prices) are examples. Use whatever `scripts/` actually seeds and keep the on-screen values consistent with the voice-over.

## Before recording

Accounts and state (names as in `scripts/`, created by `npm run setup`):

- `maker`: funded, trustlines to USDC, lUSDC and LBOND; LBOND trustline authorized by `rwa_issuer`.
- `taker`: funded, trustlines to USDC and LBOND; LBOND trustline authorized. Holds only USDC.
- `blocked_taker`: funded, trustline to USDC and LBOND, LBOND trustline not authorized. Holds USDC.
- `peg_lp`: seeds the USDC/lUSDC peg book at 1:1 (`npm run seed`).
- Keeper account funded. Fees are small: 0.0015 to 0.14 XLM per contract call on testnet, including the calls that touch Blend.
- Yield to show: the active deployment is Lotus v2 (`lUSDCb`), backed by our own DeFindex vault seeded into Blend, so interest accrues for real. Deposit as early as possible before recording so `surplus()` has visible digits; the dry run `node 06-keeper-distribute.mjs --dry-run` shows what a distribution would pay. `npm run yield` (a USDC transfer to the contract) is only a fallback lever and, if used, must be announced on camera as a top-up.

Browser tabs, in order:

1. The app (`web/`), deposit screen.
2. stellar.expert, maker account: `https://stellar.expert/explorer/testnet/account/<MAKER_G>`.
3. Horizon orderbook for LBOND/lUSDC (both codes are 5 characters, so the type is `credit_alphanum12`):
   `https://horizon-testnet.stellar.org/order_book?selling_asset_type=credit_alphanum12&selling_asset_code=LBOND&selling_asset_issuer=<LBOND_ISSUER_G>&buying_asset_type=credit_alphanum12&buying_asset_code=lUSDC&buying_asset_issuer=<LUSDC_ISSUER_G>`
4. stellar.expert, LBOND asset page showing the flags: `https://stellar.expert/explorer/testnet/asset/LBOND-<LBOND_ISSUER_G>`.
5. stellar.expert, `lotus_vault` contract page: `https://stellar.expert/explorer/testnet/contract/<CONTRACT_C>`.
6. A terminal in `scripts/` with the commands ready: `npm run seed -- --reset` (cancels the maker's and peg provider's existing offers, then posts a fresh ladder and peg book; testnet already holds the offers from the first run), `npm run take` (the taker's path payment, then the blocked taker's attempt, in the same run), `npm run yield` (simulated accrual, required on testnet), `npm run keeper` (distribution).

Have stellar.expert transaction pages ready to open from each script's printed hash.

## Script

### 0:00 - 0:20. Hook

On screen: title card "Lotus. Yield-bearing liquidity for Stellar's orderbook", then cut to the Horizon orderbook tab showing the LBOND/lUSDC book.

Say: "Orderbooks need depth, and depth is capital that earns nothing while it waits. On Stellar, an offer does not move funds out of your account. Lotus uses that: a dollar that earns Blend yield, in a form the orderbook understands. Here is the whole flow on testnet."

### 0:20 - 0:45. Deposit USDC, receive lUSDC

On screen: the app, connected with your own testnet wallet (Freighter). Enter 100 USDC, confirm, wait for the transaction. Then open the transaction on stellar.expert and point at the two effects: USDC leaving your account, lUSDC minted to it. Briefly show the contract page.

Say: "I deposit one hundred USDC into the Lotus contract. The contract puts it in a DeFindex vault built to lend on Blend, and mints one hundred lUSDC to me, one to one. lUSDC is a classic Stellar asset; the Soroban contract is the admin of its asset contract and the only minter."

### 0:45 - 1:15. Maker posts a ladder on LBOND/lUSDC

On screen: terminal, `npm run seed -- --reset`. It posts the USDC/lUSDC peg book (bid 0.9995, ask 1.0005, from `peg_lp`) and the maker's ladder: five asks of 100 LBOND at 0.98, 0.99, 1.00, 1.01 and 1.02 lUSDC, in one transaction. Then the Horizon orderbook tab: refresh, show the five asks. Then the maker's stellar.expert account page: point at the LBOND balance and its selling liabilities.

Say: "Now I act as an issuer distributing LBOND, a simulated tokenized bond, on a ladder of five asks around par, in one transaction. Look at the account. The LBOND balance has not moved. The offers are recorded as selling liabilities; the funds never left. That is the property Lotus is built on: whatever sits in an offer stays in the account, so if it is lUSDC it keeps earning."

### 1:15 - 1:45. Taker buys LBOND with USDC via path payment

On screen: terminal, `npm run take`. The first part runs as `taker`: 150 USDC in, about 152.4 LBOND out, three fills (the peg book, then the 0.98 and 0.99 rungs). Open the transaction on stellar.expert: show the single operation, the path USDC -> lUSDC -> LBOND, and the trade effects. Refresh the Horizon orderbook: the 0.98 ask is gone and the 0.99 ask is partly filled.

Say: "A buyer who holds only USDC lifts the first asks. One transaction, one path payment: USDC into lUSDC on the peg book, lUSDC into LBOND on the bond book. The buyer never touches lUSDC, so quoting in lUSDC costs the taker nothing in usability."

### 1:45 - 2:05. Unauthorized taker fails

On screen: the LBOND asset page with `AUTH_REQUIRED`, `AUTH_REVOCABLE` and clawback enabled. Then the terminal: the second part of the same `npm run take` run, the same path payment as `blocked_taker`. Show the failure and the result code `op_not_authorized`.

Say: "LBOND is issued with authorization required and clawback enabled. This second buyer is not on the issuer's list. Same transaction, and it fails at the protocol level. No contract code is checking this; the asset itself is compliant."

### 2:05 - 2:40. Keeper distributes; the maker earns while offers stay open

On screen: the maker's stellar.expert page, lUSDC balance before (the lUSDC it received from the fills). Terminal: `npm run keeper` (the interest is real, no top-up needed). Show its output: the surplus read from the contract, each holder's cap and the amount minted, including `peg_lp`, whose lUSDC is committed to its open ask. Refresh the maker's account page: the lUSDC balance has grown; the four remaining LBOND asks are still listed under the account. Refresh the Horizon orderbook: the remaining ladder is unchanged.

Say: "The vault is now worth more than the lUSDC in circulation. The keeper calls distribute with the list of holders. The contract caps every amount on-chain at the holder's share of the surplus, so the keeper can forget someone but can never over-mint or redirect yield. The maker's proceeds earned from the moment of the fill, its remaining asks are still in the book, and the peg provider earned on lUSDC that is sitting in an open offer."

Then add: "The interest is real Blend supply interest on testnet, roughly seven percent a year at the moment; the amount you see is small because we only let it run for a few minutes." Let the deposits sit at least 10 minutes before recording the keeper step so the amounts show digits.

### 2:40 - 3:00. Close

On screen: the architecture diagram from the README, then the title card with the repository link.

Say: "Lotus is one small Soroban contract, a classic asset with a contract as admin, and Stellar's own orderbook and path payments, composed with DeFindex and Blend. Issuers earn on their proceeds, treasuries earn on their bids, and takers keep paying in USDC. Everything you saw is on testnet and in the repo."

## Timing summary

| Segment | Start | Length |
|---|---|---|
| Hook | 0:00 | 20 s |
| Deposit | 0:20 | 25 s |
| Ladder | 0:45 | 30 s |
| Path payment | 1:15 | 30 s |
| Unauthorized taker | 1:45 | 20 s |
| Distribution | 2:05 | 35 s |
| Close | 2:40 | 20 s |

## Recording notes

- Keep every stellar.expert page zoomed so balances and liabilities are readable at 1080p.
- Pre-run each script once so Horizon has indexed the state; the recording should not wait on confirmations longer than a few seconds. If a Blend-touching transaction is slow, cut and resume on the confirmed page.
- Do not claim mainnet or audits, and do not quote the yield as a forecast: it is what Blend paid on testnet during our measurement. Say "testnet" at least once and "simulated" for LBOND.
