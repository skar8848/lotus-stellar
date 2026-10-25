# Lotus: demo video script

Target length: 3:00 or less. Screen recording with voice-over. Everything shown is on Stellar testnet. Say "testnet" at least once, "simulated" for LBOND, and "market makers" for the volume.

Numbers below are examples. Use what the scripts actually seed and keep the on-screen values consistent with the voice-over.

## Before recording

1. Re-seed the books: `cd scripts && node 04-seed-book.mjs --reset`. Then `npm run bot:demo -- --ladder take` is used only for a dry rehearsal; for the recording keep the bot off, or run it in a second terminal for background flow.
2. Deposit into the active vault (v2, `lUSDCb`) at least 10 minutes before the keeper step, so `surplus()` has visible digits. `node 06-keeper-distribute.mjs --dry-run` shows what a distribution would pay.
3. App: `cd web && npm run dev`, wallet connected (Freighter, funded testnet account with trustlines to USDC, LBOND, lUSDCb; LBOND authorized by `rwa_issuer`). `taker`, `blocked_taker`, `maker`, `peg_lp` and the bot accounts are in `deployments/`.
4. One Lotus pool position ready to show: an Ask position on `lbond-usdc-defindex`, so the vault-backed USDC leg is visible.
5. Tabs in order: the app (`/trade`), `/pools`, `/portfolio`; stellar.expert maker account; Horizon order book for LBOND/lUSDCb (`credit_alphanum12` for both codes); LBOND asset page (flags); `lotus_vault` and pool contract pages.

Fees are small: 0.0015 to 0.14 XLM per contract call on testnet.

## Script

### 0:00 - 0:20. Hook

On screen: title card "Lotus. Directional liquidity and yield-bearing orders for Stellar", then the app's `/trade` page.

Say: "A resting order is dead capital. Lotus fixes that two ways on Stellar: a directional range pool on Soroban, and a receipt token that lets a limit order on the SDEX keep earning while it waits. Everything here is testnet."

### 0:20 - 0:55. The pool

On screen: `/pools`, the Lotus pool tab, the `lbond-usdc-defindex` instance. Show depth by bin. In the range builder choose Ask, a range of five bins around par, 100 LBOND, confirm with the wallet. Show the position appear, then the explorer link.

Say: "This is the Lotus pool. I put one hundred LBOND, a simulated tokenized bond, on five price bins. Directional means inventory only goes down and proceeds only come in: if the price comes back, nothing trades back. The pool can also be two-way, and the USDC side can sit in a DeFindex vault on Blend, recalled just in time by the taker's swap."

### 0:55 - 1:25. A swap takes it

On screen: still on `/pools`, the swap panel with the venue comparison against the SDEX. Buy LBOND with 50 USDC. Show the result, the average price and bins crossed. Then `/portfolio`: the position shows proceeds.

Say: "A taker buys with USDC. The quote shows the pool next to the SDEX path, and the better venue is marked. My position receives USDC and keeps earning on it."

### 1:25 - 1:55. The receipt token and the SDEX

On screen: the vault tab, deposit 100 USDC, receive `lUSDCb`. Then terminal `npm run seed -- --reset` (or already seeded) and the Horizon order book: five LBOND asks quoted in lUSDCb. The maker's stellar.expert page: the LBOND balance has not moved, only selling liabilities.

Say: "On the classic side, I deposit USDC and get `lUSDCb`, a Stellar asset the vault contract mints one to one. The vault lends it on Blend through DeFindex. An SDEX offer does not move funds, so the order quoted in this receipt keeps earning. And a taker with only USDC buys LBOND in one path payment through it."

### 1:55 - 2:15. Path payment, and a failure that is on purpose

On screen: `/trade`, Swap tab, USDC to LBOND, route USDC -> lUSDCb -> LBOND. Then `npm run take` output with the blocked taker failing `op_not_authorized`.

Say: "One transaction. The buyer never touches the receipt. And a buyer who is not authorized by the issuer fails at the protocol level, because LBOND is authorization-required with clawback."

### 2:15 - 2:40. Bots keep the price honest

On screen: terminal with `npm run bot:depeg` (or the recorded output): the receipt pushed to 0.985, the arbitrageur restoring it in about ten seconds with the tx links.

Say: "Our two market makers and an arbitrageur are three accounts we run, so this volume is market-maker volume, not users. When the receipt drops under par, the arbitrageur buys it and redeems at par on the vault. Ten seconds."

### 2:40 - 3:00. Yield and close

On screen: `npm run keeper` output (surplus, holders, amounts minted, including accounts whose receipt sits in open offers), then the README architecture diagram and the repo link.

Say: "The interest is real Blend interest on testnet, around seven percent at the moment, small here because we only let it run for minutes. Two products, one stack: a directional pool, and a receipt that makes the SDEX earn. Testnet only, no audit, limits are in the README."

## Timing summary

| Segment | Start | Length |
|---|---|---|
| Hook | 0:00 | 20 s |
| Pool | 0:20 | 35 s |
| Swap | 0:55 | 30 s |
| Receipt and SDEX | 1:25 | 30 s |
| Path payment and blocked taker | 1:55 | 20 s |
| Bots, peg | 2:15 | 25 s |
| Yield and close | 2:40 | 20 s |

## Recording notes

- Zoom stellar.expert pages so balances and liabilities read at 1080p.
- Pre-run each action once so Horizon has indexed; cut and resume on the confirmed page if a Blend-touching transaction is slow.
- The vault-backed pool can fail a transaction with `ExceededLimit` if the vault's idle balance changes between simulation and inclusion; the app re-simulates and resends. If you see it, wait for the retry or send again.
- A depeg run consumes real resting liquidity, including `peg_lp`'s bid. Re-run `node 04-seed-book.mjs --reset` afterwards.
- Do not claim mainnet or audits. Do not quote the yield as a forecast. Do not say "users" for bot volume.
