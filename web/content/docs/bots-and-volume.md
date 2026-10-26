# Bots and volume

> The trades on the Lotus testnet markets come from accounts run by the Lotus team. They are real on-chain transactions, but it is market-maker volume, not user volume. The LBOND price is simulated.

## Where the volume comes from

Three accounts operated by the Lotus team keep the testnet markets alive:

- `mm_a`, a **market maker**: quotes `LBOND / lUSDCb`, `LBOND / USDC` and the `USDC / lUSDCb` peg book on the SDEX.
- `mm_b`, a **flow generator**: trades against those quotes (and sometimes against the team's demo ladders); it is also the account that moves the peg in stress scenarios.
- `arb`, an **arbitrageur**: buys the receipt under 1 USDC and redeems it at par, or mints it at par and sells above 1, and closes gaps between the Lotus pool and the SDEX.

They trade assets the team issues (`LBOND`) or mints through `lotus_vault` (the receipt, minted 1:1 against Blend testnet USDC from the public faucet). Every trade is a real testnet transaction. **Nobody else uses these markets yet**: it is a hackathon testnet, and the point is to exercise the mechanism under load. Arbitrage profit in the demo scenarios is a transfer between our own accounts, not revenue.

The bot accounts, read from `deployments/testnet.bot.json` when this page is served:

{{bot-accounts}}

## The LBOND price is simulated

There is no oracle and no market data. The LBOND fair value follows a simulated US 10-year Treasury:

- a yield `y` that follows an Ornstein-Uhlenbeck process around a reference yield, with a daily volatility of about 6.5 bp (a real 10Y moves about 5 to 8 bp a day);
- `price = nav - duration * (y - y_ref)` with a duration of 7 years, and a NAV that accrues carry at the simulated yield, plus a tiny micro-noise.

The only real input is the starting point: the latest FRED DGS10 print fetched at first start. Every move after that is random. Market makers quote around this simulated fair value.

## The receipt price stays at par

The receipt is minted and redeemed 1:1 by `lotus_vault`, so its price on `USDC / lUSDCb` is par plus a few bps of noise, never a drift. The arbitrageur acts when the book moves more than a couple of bps away from par.

## Measured runs (testnet, 25 October 2026)

- A depeg of the receipt to 0.985 was restored by the arbitrageur in 10 to 12 seconds, on both vault deployments.
- A cross-venue dislocation between the pool and the SDEX was closed in 26 seconds.
- The scripted demo run lasts about 167 seconds with 25 flow trades and ends with a keeper distribution that minted real interest to 6 holders.
- Two 10-minute runs: 0 failed transactions, 0 HTTP 429, about 0.52 XLM spent in total.

## Running it

The bot is a Node program in the repository under `scripts/bot/` (documented in `scripts/bot/README.md`). It refuses to start on any network other than testnet, and its keys live in git-ignored `*.secrets.json` files.
