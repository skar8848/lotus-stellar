# Using the app

> A walk through every screen: get test tokens on `/faucet`, swap or place one-price and range orders on `/swap`, build a position across the four strategies on `/pools`, trade the SDEX books on `/trade`, and manage everything on `/portfolio`.

Every action is signed in your own wallet. Any wallet supported by Stellar Wallets Kit works (Freighter, xBull, Albedo, Lobstr, Hana, ...). Set the wallet to **testnet**. There are no session keys and no auto-signing.

## /faucet: get started in about a minute

1. **Fund**: if the account does not exist yet, the Friendbot button funds it with test XLM.
2. **Add trustlines**: one classic transaction adds every missing `changeTrust` (LBOND, USDC, the active receipt). Each row shows the code, issuer, `CODE:ISSUER` with copy buttons and an explorer link.
3. **Claim test tokens**: the server authorizes your LBOND trustline (LBOND is `AUTH_REQUIRED`) and sends LBOND, Blend testnet USDC and the active receipt, one transaction per asset, with the hash of each.

The amounts are set by the server; `GET /api/faucet` returns them. One claim per address and asset, and a light rate limit per network. A thin "Get test tokens" line appears under the nav on every page while your wallet is not ready.

## /swap: Lite and Pro

One page with a **Lite / Pro** switch (`/swap`, `/swap?mode=pro`).

- **Swap** (Lite and Pro): against the directional Lotus pool only. Every live directional instance is quoted (`quote_swap`) and the best one is kept. The details box shows the route, pool price, price impact, minimum received (with your slippage setting), pool fee and bins crossed. If the size is larger than the pool depth, it tells you how much would really fill. Execution re-quotes, then calls `swap(min_out)`.
- **Limit** (Lite): Sell or Buy, "When 1 LBOND is worth" with market and percentage presets. One price is one bin. Orders have no expiry ("Until filled"). Then choose a strategy and confirm.
- **Range** (Pro): the liquidity chart with draggable range handles next to Selling / Buying, start price and range end, presets, the strategy picker, then **Get started**.
- DCA is visible but disabled ("Coming soon").

Limit and Range are the same order as `/pools` New position: same data, same strategy picker, same review dialog.

## /pools: New position

A four-step wizard:

1. **Pair and side**: LBOND / USDC, **Sell LBOND** (Ask) or **Buy LBOND with USDC** (Bid).
2. **Price range and deposit**: draggable Start / End handles on a chart of SDEX trades (1H to 1Y) next to a depth histogram of every live pool instance's bins plus the SDEX books, all on the same grid. Presets, min / max fields with one-bin steppers, weight shape (even, front, back) and the deposit.
3. **Choose your strategy**: four cards (Lotus pool, Lotus pool + Blend yield, Stellar DEX, Stellar DEX + Blend yield), each with the expected yield, the number of signatures and, when unavailable, why (direction rule, curator rule, no instance, more than 50 SDEX levels).
4. **Review**: deposit, range, average price, fee or XLM reserve, trustlines added, crossing warning, then **Sign**. The two-transaction case (receipt buy) is handled here, including "Post the offers again" if the second step fails.

The expected yield is the Blend USDC supply APR read live from the Blend pool (annualized growth of `b_rate` between two reads); until two reads exist the card shows the last figure measured by the team. Always labelled "observed on testnet, not a forecast".

**Your positions** lists pool positions of every instance and your SDEX ladders, grouped per pair and side: status, fill bar, remaining, claimable proceeds and fees, **Claim**, and **View position** (the creating transaction on stellar.expert). Directional orders are locked until filled (see [Concepts](/docs/concepts.md#locked-orders)).

Header actions: **Swap on the pool** and **Advanced: two-way position** (`?pool=lbond-usdc-twoway`), the builder for `Mode::TwoWay` LP positions.

## /trade: the SDEX terminal

A classic exchange layout for the Stellar DEX books:

- **Market bar**: `?market=LBOND-lUSDCb`, `USDC-lUSDCb` (the peg book), `LBOND-USDC`; last price, 24h change, high, low, volume, mid, spread.
- **Chart**: candles from Horizon trade aggregations (1m to 1W), or cumulative depth. Empty buckets are drawn as flat grey candles at the previous close with zero volume: no trade is invented.
- **Order book and trades**. Clicking a level fills the Limit price.
- **Swap**: one `pathPaymentStrictSend` quoted from Horizon (`USDC -> lUSDCb -> LBOND` is one transaction). For LBOND/USDC, a venue comparison shows the Lotus pool quote next to the SDEX path.
- **Limit**: one `manageSellOffer`, with a warning when the price crosses the book.
- **Bottom panel**: open orders with Cancel, trade history (one row per operation, routed hops merged), balances.

Range orders are placed from `/pools`; the order panel links there.

## /portfolio

Balances (available versus committed to offers), open offers, **receipts per vault** with **Redeem lUSDCb to USDC** (`/portfolio#receipts`), pool positions per instance, recent activity and a USDC-equivalent summary. Every address, asset, offer and transaction links to stellar.expert (testnet).

## Common errors

| message | meaning |
|---|---|
| Not authorized by the issuer | your LBOND trustline is not authorized yet: claim from `/faucet` |
| No liquidity in the Lotus pool at this size | the pool has no bins on that side; try a smaller size or the SDEX |
| The vault state changed while signing, retry | footprint race on the shared DeFindex vault; the app already retried |
| Too close to the price | curator rule: move the Bid range at least 10 bins below the price, or pick another strategy |
| `op_not_authorized` | protocol-level rejection of an unauthorized LBOND trustline |
