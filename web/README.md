# Lotus web

Next.js 16 (App Router, TypeScript, Tailwind v4) front end for Lotus on Stellar testnet. It reads live state from
Horizon and Soroban RPC and signs with any wallet supported by `@creit.tech/stellar-wallets-kit`
(Freighter, xBull, Albedo, Lobstr, Hana, ...), or with a dev-only secret-key signer for headless tests.

The look is ported from the previous EVM front (lotus-main): pure black, soft-pink primary `#F3B1CE`,
shadcn "new-york" components, Inter for the UI, Audiowide only for the wordmark, the ASCII lotus video on
the landing, the range-order builder with draggable Start / End handles over the chart and a depth panel.
No EVM logic was copied (no wagmi, viem, LI.FI, Morpho, Uniswap); only presentation code and assets.

## Run

```sh
cd web
npm install
npm run dev            # http://localhost:3000
npm run build          # production build (must pass)
npm start
npm run lint
npm run test:unit      # range builder, pool grid, New order routing, live yield rate, faucet (plain node, no browser)
```

Node 20+ (tested on Node 25). If another `next dev` already holds `web/.next` (Next takes an exclusive lock
on `<distDir>/lock`), start a second server with its own dist dir: `NEXT_DIST_DIR=.next-3200 npx next dev -p 3200`.

## Routes

| route | what |
| --- | --- |
| `/` | Landing: hero with the ASCII lotus (lazy loaded WebGL, black fallback), how it works, why Stellar, footer |
| `/trade` | The SDEX front, laid out as a classic exchange terminal: market bar (selector `?market=LBOND-lUSDCb`, `USDC-lUSDCb`, one pair per Lotus receipt, plus `LBOND-USDC` in plain USDC; last, 24h change / high / low / volume, mid, spread, best bid / ask), TradingView-style chart (or cumulative depth), order book / trades tabs, order entry column (**Swap** / **Limit**, plus a "Range orders → Pools" link), bottom tabs (open orders with Cancel, trade history, balances) |
| `/pools` | **New position** (Uniswap-style add-liquidity flow, see below): pair + side, range on the draggable chart over live depth, amount, then **Choose your strategy** (Lotus pool / + Blend yield / Stellar DEX / + Blend yield) and a review modal. Below it, **Your positions** across the four strategies (claim; locked until filled, then remove; View position / offer on stellar.expert). Header: **Swap on the pool** (lotus-main lite swap in a dialog, with the venue comparison) and **Advanced: two-way position** (`?pool=lbond-usdc-twoway`, the previous builder). `?tab=vault` redirects to `/portfolio#receipts` |
| `/earn` | Redirect to `/pools` (old vault links with `?strategy=` go to `/portfolio#receipts`) |
| `/portfolio` | Balances (available vs in offers), open offers, receipts per vault with **Redeem lUSDCb → USDC** (`#receipts`), pool positions, recent activity, USDC-equivalent summary |
| `/app` | Redirect to `/trade` |
| `/api/config` | The merged deployment config as JSON (public keys only), read at request time |
| `/faucet` | Testnet faucet: Friendbot, add the trustlines (one tx), claim LBOND + USDC + the active receipt. See [Faucet](#faucet-testnet) |
| `/api/faucet` | `GET`: faucet status (public info). `POST {address}`: server-side funding of one address |

Vocabulary: the **Lotus pool** is the `lotus_pool` range pool (directional liquidity on a price grid). The
**Lotus vault** is the `lotus_vault` wrapper (USDC to a DeFindex vault, receipt token `lUSDC`, a classic asset
that trades on the SDEX). Never call the vault a pool.

### /trade

Layout: desktop fills the viewport under the nav (market bar, chart | book + trades, resizable bottom panel, order entry in a
full-height right column); below 1024px everything stacks. Every action is signed in the wallet (no session keys, no auto-sign).
Clicking a book level fills the Limit price. Swap and Limit have a Buy / Sell toggle and a % of available balance slider.
Range orders are not on /trade: they are placed from /pools (the order panel links there).

**Chart** (`components/trade/PriceChart.tsx`): laid out like the TradingView Advanced Chart widget, drawn with
TradingView's open-source `lightweight-charts` on our own data (Horizon `/trade_aggregations` of the selected market).
Tenor (the reference front) embeds TradingView's `embed-widget-advanced-chart.js` with `COINBASE:ETHUSD`-type symbols;
that widget only plots TradingView's own feeds, so it cannot show testnet SDEX assets, and Tenor ships no
`charting_library`. Top toolbar: Chart / Depth, intervals 1m 5m 15m 1h 1D 1W (the Horizon resolutions), candles / bars /
line / area, Vol and EMA 9 toggles, zoom, reset, full screen. Legend (always on, the bar under the crosshair or the
last bar): market, interval, O H L C, change, volume, trade count, EMA. Volume histogram at the bottom of the pane,
dashed crosshair with UTC labels. Bottom bar: date ranges 1D 5D 1M 1Y (each also picks an interval) and All, UTC clock,
`%` / `log` / `auto` price-scale modes. Horizon only returns buckets that had trades, so empty buckets are drawn as
flat grey candles at the previous close with zero volume and a "no trades" tag in the legend (`fillCandleGaps` in
`lib/book.ts`, up to 2000 buckets back from now): no trade is invented. The Depth view shows price, size, cumulative size and cumulative total at the nearest level.
Hovering an order-book row highlights it and every level up to the spread, with a summary (levels, size, total, average).
The market selector menu is portalled to `<body>`, so the market bar can never clip it; the low-value stats of the
market bar (mid, spread, 24h high / low) collapse first on narrower screens so it never scrolls at 1280px and up.

- **Swap**: pay asset to receive asset with one `pathPaymentStrictSend`, quoted from Horizon `/paths/strict-send`
  (route, effective price, min received with slippage). `USDC > lUSDC > LBOND` is one transaction. Shows the trustline
  state of the received asset; LBOND is `AUTH_REQUIRED`, so a trustline that the issuer has not authorized gets a
  clear "not authorized by the issuer" message. For USDC/LBOND it adds the **venue comparison** (Lotus pool quote
  next to the SDEX path, better one marked).
- **Limit**: one `manageSellOffer` (ask or bid). Warns when the price crosses the book.
- **Open offers**: from Horizon `/accounts/{id}/offers`, Cancel = `manageSellOffer` with amount 0 and the offer id.
- **Trade history**: one row per user operation (`groupAccountTrades` in `lib/book.ts`). Horizon returns one trade
  per crossed offer, so a path payment `USDC > lUSDCb > LBOND` is two trades sharing the operation id; they are
  grouped by (operation, the account's own offer id on the trade), which merges the hops of a swap (the taker side
  carries one synthetic offer id on every hop) and keeps each resting offer's fill on its own row. The row is shown
  under the market of the assets actually paid and received (LBOND/USDC), side from what was received, with the
  average price, paid, received and the route (`routed USDC → lUSDCb → LBOND`, or `direct`).
- **Trades tab** (next to the order book): Horizon's trades of that book, plus the connected account's own routed
  swaps of this market (tagged `routed`, average price), which never appear in the book's own trades because they
  went through another book. Other accounts' routed swaps are not shown (that would need every account's operations).

### /pools: New position

One page, laid out like the Uniswap v3/v4 "New position" wizard of the previous front (lotus-main, git `a938fc3`,
`web/app/pro1/page.tsx`): breadcrumb, title with **Reset**, a stepper card on the left, the step card on the right.
The receipt / vault is not a page of its own any more: depositing USDC for the receipt is how **Stellar DEX + Blend
yield** works, and held receipts are redeemed from /portfolio. Files: `components/pools/NewPosition.tsx` (wizard),
`LiquidityRangeChart.tsx` (chart), `StrategyCards.tsx`, `ReviewDialog.tsx`, `useOrder.ts` (evaluation of the four
destinations), `YourPositions.tsx` + `positionsModel.ts`, `useBlendApr.ts` + `lib/yieldRate.ts`.

1. **Select pair and side**: LBOND / USDC, and **Sell LBOND** (Ask: sold as the price rises) or **Buy LBOND with
   USDC** (Bid: buys as the price falls). Directional range limit orders only; the classic two-way LP is the
   "Advanced: two-way position" link in the header.
2. **Set price range and deposit**: the lotus-main liquidity range chart (price line of the SDEX LBOND/USDC trades,
   falling back to LBOND/receipt; timeframes 1H / 1D / 1W / 1M) flowing into a depth histogram of **every live pool
   instance's bins plus the SDEX LBOND/USDC and LBOND/receipt books**, snapped to the same grid, in LBOND-equivalent.
   Draggable **min / max** handles (snap to bins), the order being built in pink, current price dashed. Range presets
   (Ask: just above, sell the rip, ladder, wide; Bid: just below, buy the dip, ladder, wide), Min / Max price fields
   with **- / +** steppers (one bin per click), weight (even / front / back), deposit with balance. Hover: crosshair +
   price at the cursor; over the depth panel, the bin's price and size (pool / SDEX / yours).
   **Reference price per strategy** (`lib/orderRoute.ts` `referenceFor`): each strategy reads the book it rests on,
   Lotus pool = the instance's bins then LBOND/USDC, Stellar DEX = LBOND/USDC, DEX + yield = LBOND/receipt (empty
   book: fallbacks). Before a strategy is chosen the range step uses the most conservative one (Ask: highest, Bid:
   lowest), so a preset crosses no venue; once chosen (Edit), the chosen strategy's. **Direction rule**
   (`directionBounds` / `directionError`): a sell range sits at or above that price, a buy range at or below it;
   handles, fields, steppers and presets are clamped, with a short note, and a strategy whose own price breaks the
   rule is unavailable.
3. **Choose your strategy**: four cards, the 2x2 of `lib/orderRoute.ts`, each with a one-line explanation, the
   expected yield, the number of signatures and, when unavailable, why (direction rule, curator rule "Too close to
   the price" with a **Change range** button that moves the top to the reference bin minus `PROXIMITY_MIN_BINS`
   keeping the width, no instance, > 50 SDEX levels). Crossing is re-checked per strategy against its own books
   (pool: its bins + LBOND/USDC) and warned on the card, in step 2 once a strategy is chosen, and in the review.
4. **Review** (wide modal): yield badge top right, pool + explorer link in the header, the one-line summary, details
   (deposit, range, average price, pool fee or XLM reserve, trustlines added), crossing warning, then **Sign**. The two-transaction
   case and the "Post the offers again" retry live in the modal.

| | Yield off | Blend yield |
| --- | --- | --- |
| **Lotus pool** | `add_position(Directional)` on the first pool instance without a vault (`lbond-usdc-idle`), 1 signature | `add_position(Directional)` on the first instance with a vault (`lbond-usdc-defindex`, USDC leg in DeFindex/Blend), 1 signature |
| **Stellar DEX** | one classic tx, one `manageSellOffer` per bin on LBOND/USDC, 1 signature | quoted in the active receipt (`testnet.contract.json` `receipt`): Ask = one classic tx of offers selling LBOND for the receipt; Bid = `lotus_vault.deposit(USDC)` then the classic ladder buying LBOND with the receipt, **2 signatures** |

- **Expected yield**: the Blend USDC supply APR, read **live** by `useBlendApr` (`get_reserve(USDC)` on the Blend
  pool every 15 s, annualized `b_rate` growth between the first read of the session and the latest, `lib/yieldRate.ts`,
  tested against the `observed_apr` window of `testnet.contract.json`). Until two reads 10 s apart exist, the card
  shows the last figure measured by the deployment team (`observed_apr.window_b.lotus_net_apr_pct`). Always labelled
  "observed on testnet, not a forecast"; BLND emissions are not counted. The DeFindex vault fee is 0, so the gross
  Blend rate is what positions net. Both yield strategies use the same DeFindex vault.
- **Your positions** (`YourPositions.tsx`, lotus-main dashboard table + filters + empty state): pool positions of
  every instance (incl. retired ones, two-way rows tagged "Two-way LP (advanced)") via the /portfolio loader, and SDEX
  ladders: the account's offers selling LBOND for USDC or a receipt, or the reverse, grouped per (pair, side) into
  one row. Pool rows: status, fill bar, remaining, claimable proceeds + fees, **Claim**; a directional order is
  **locked until fully filled** (`poolPositionLocked`): "Early redemption · soon" (disabled) instead of Remove, which
  comes back once filled (two-way LP keeps Remove). SDEX ladders are always locked (a filled offer leaves the book).
  Same rule on /portfolio. **View position**: the add_position tx on stellar.expert, found from the pool's
  `position_added` event via RPC `getEvents` (`lib/positionTx.ts`, cached; pool contract page when outside RPC
  retention); SDEX rows link each offer (`/offer/<id>`). One status line for the whole table.
- **Swap on the pool**: dialog with an instance picker (idle / vault-backed) and `PoolSwap` in the lotus-main lite
  layout (Sell card, flip, quoted Buy card, one button; `quote_swap` / `swap(min_out)`), then the venue comparison.

- **Ladder mapping** (`lib/orderRoute.ts`, tested in `tests/order-route.test.mts`): each bin is one SDEX offer at
  `price_at(bin)` with the bin's own amount (same `planPosition` weights as the pool). Ask = `manageSellOffer(LBOND
  -> quote, price p/1e7)`, Bid = `manageSellOffer(quote -> LBOND, price 1e7/p)`. `p` is an integer number of
  stroops, so both prices are exact rationals (reduced, they fit int32 on the whole grid): no rounding beyond the
  grid itself (`price_at` rounds half-up like the contract) and the amount split (floor per bin, remainder on the
  heaviest bin). Fills are rounded by stellar-core in favour of the offer owner. At most 50 levels on the SDEX (the
  pool allows 64), so the order plus up to two `changeTrust` is one transaction.
- Missing trustlines: an Ask on the SDEX bundles the trustline of what it receives (USDC or the receipt) in front of
  the offers. A Bid with yield needs the receipt trustline before the deposit (the vault mints to it), so it is
  its own first transaction (then 3 signatures, announced). LBOND is AUTH_REQUIRED: without an authorized trustline
  the panel shows the "not authorized by the issuer" notice and the button stays disabled.
- **2-transaction case** (`submitSorobanThenClassic` in `lib/stellar.ts`): a Soroban transaction holds exactly one
  operation, so the deposit and the offers cannot be atomic. Both are built up front (deposit at sequence s+1,
  assembled from a fresh simulation; offers at s+2), the wallet signs both one after the other, the deposit is
  sent and awaited, and the offers are sent **only if the deposit succeeded**; otherwise the signed offers are
  dropped (a deposit included but failed consumes s+1, so they would be valid: they never leave the function) and
  the UI says nothing moved. A footprint race on the deposit (`ExceededLimit`, `lib/txErrors.ts`) rebuilds and
  re-signs both (2 times). Deposit ok but offers failed: the modal says you hold the receipt (redeemable at par in
  /portfolio) and offers **Post the offers again** (one classic tx, fresh sequence). The atomic peg-book
  alternative (pathPaymentStrictReceive USDC -> receipt + offers in one classic tx) is not implemented.
- **Curator rule** (UI only, `PROXIMITY_MIN_BINS = 10` in `lib/orderRoute.ts`): for a Bid, the **Lotus pool + Blend
  yield** card is disabled when the top bin of the range is less than 10 bins below the reference price ("Too close to the price:
  your USDC would be recalled from the vault by every trade, little yield, more failures"). Reference = mid of the
  SDEX LBOND/receipt book, else LBOND/USDC, else the pool's own mid (best directional bins), else 1.0. Ask and SDEX
  are never blocked (the card explains it: Ask yield is on proceeds that wait in the vault; a receipt in an SDEX offer
  keeps earning, so the Stellar DEX + Blend yield card stays open). The "Buy the dip" preset keeps every card open.
- /trade has no Range tab any more: its order panel links to /pools.
- /portfolio also lists all four kinds: pool positions per instance (claim / remove), and SDEX offers on LBOND/USDC and
  on LBOND/receipt, each with explorer links, plus the receipts with their **Redeem** action.

### Lotus pool adapter

`lib/pool.ts` is a thin adapter over the `lotus_pool` ABI (`docs/pool-abi.md`): argument encoders, result
decoders, a live client (Soroban RPC) and a **local simulation** client. Until `deployments/testnet.pool.json`
lists an instance the page runs the simulation (clearly labelled, nothing is sent on-chain); once the file
exists the same UI talks to the contract. `lib/poolGrid.ts` replicates `price_at(bin) = round(1e7 * (1 + step/10000)^bin)`
with BigInt and is checked against `contracts/lotus_pool/test-vectors.json` by `npm run test:unit`.

Pool instances (`testnet.pool.json`): `lbond-usdc-idle`, `lbond-usdc-defindex` (USDC parked in our DeFindex vault) and
`lbond-usdc-twoway`. Fees follow ABI v1: charged on top of the price leg (a buyer pays ceil(q) + fee, a seller gets
floor(q) - fee), so the pool quote and the venue comparison use the contract's own `quote_swap` (`avg_price` includes
the fee). `max_bins_per_swap` (100) comes from `get_config`, `abi_version()` is checked (a banner appears if it is not 1).

**Two-way LP** (`Mode::TwoWay`, classic LP with crossback): the switch in the builder is enabled per instance from
`supports_two_way`, and only on pools without a DeFindex vault (the contract answers `NotImplemented` otherwise;
the UI says why). Copy is explicit: a two-way position earns fees in both directions and bins refill when the price
comes back, but it can end up holding mostly the other asset; directional positions never flip back. In My positions
and on /portfolio a two-way row shows both holdings (`inventory` = BASE held now, `pending_proceeds` = QUOTE held now),
the traded volume and the fees; Claim pays fees only, Remove pays both reserves plus fees.

Position builder (Advanced: two-way position, `?pool=<instance>`): side **Ask** (sell LBOND as the price rises) or **Bid** (buy LBOND as the price falls), price
range converted to grid bins (max 64 bins per position, 0.001 minimum per bin, as in the contract), weight shape,
amount, mode **Directional** (default) or **Two-way LP** (disabled unless the pool reports `supports_two_way`),
summary with average price, bins, fee tier and where the USDC leg is parked.

## Faucet (testnet)

`/faucet` gets a judge with a fresh wallet from zero to a funded account in about a minute. A thin "Get test tokens"
line also appears under the nav on every app page while the connected wallet is not on testnet yet or lacks one of
the trustlines (`components/faucet/FaucetHint.tsx`, hidden on `/faucet`).

1. **Fund**: when the account does not exist, a Friendbot button (`friendbot.stellar.org`, 10,000 test XLM).
2. **Add trustlines**: one classic transaction with every missing `changeTrust`, signed by the wallet. Each row shows
   code, issuer (copy button), `CODE:ISSUER` (copy button), explorer link and the trustline state.
3. **Claim test tokens**: `POST /api/faucet`. The server authorizes the LBOND trustline (`setTrustLineFlags authorized`,
   LBOND is AUTH_REQUIRED) and sends **500 LBOND** from the LBOND issuer, **200 USDC** (Blend testnet) from the
   `blocked_taker` demo account and **50** of the active receipt (`testnet.contract.json` `receipt`, e.g. lUSDCb) from
   `maker`. Each asset is its own transaction; the page lists the hash per asset with explorer links.

Assets come from the config (`lib/faucet.ts` `faucetAssets`: `underlying`, `rwa`, `receipt`), never from constants.

**Keys (server only, `lib/faucet-server.ts`, imported only by `app/api/faucet/route.ts`)**: read at request time with
`fs` from `deployments/testnet.secrets.json` (keys `rwa_issuer`, `blocked_taker`, `maker`) when present, else from
env vars `FAUCET_RWA_ISSUER_SECRET`, `FAUCET_USDC_SECRET`, `FAUCET_RECEIPT_SECRET` (for a hosted deploy). Never
`NEXT_PUBLIC_*`, never logged, never returned; error messages are scrubbed of anything shaped like a secret. The LBOND
key must be the LBOND issuer (checked). A production build made without the dev signer contains no `S...` key in
`.next/static` (checked by scanning the build output for the strkey pattern and for the exact secret values).

**Guards**: network passphrase must be `Test SDF Network ; September 2015` (403 otherwise); address validated with
`StrKey.isValidEd25519PublicKey`; account must exist (else "fund it with Friendbot first"); one claim per address and
asset, kept in memory (resets on a server restart) and backed by a skip when the address already holds at least the
faucet amount; one claim at a time per address; 6 requests per 10 min per IP (`x-forwarded-for`) and 120 per hour
overall. A source account without enough *available* balance (balance minus open-offer liabilities) gives "the faucet
is empty for X, ask the team to refill it"; `op_underfunded` / `tx_insufficient_balance` are explained the same way.

## Config

At request time `lib/config.ts` reads, in this order, for each file:

1. `$LOTUS_DEPLOYMENTS_DIR/<file>` (optional override)
2. `../deployments/<file>`
3. `web/config.example.json` as a fallback for the two base files

| file | used for |
| --- | --- |
| `testnet.contract.json` | network, Horizon / RPC urls, the active `lotus_vault` contract, USDC and receipt assets |
| `testnet.classic.json` | the LBOND asset and the named demo accounts |
| `testnet.strategies.json` | Lotus vault instances (receipt rows on /portfolio, one market pair per receipt, the yield strategy of /pools). Absent: ONE strategy is derived from `testnet.contract.json` and marked idle |
| `testnet.pool.json` | Lotus pool instances (shape in `docs/pool-abi.md`). Absent: one local simulation instance |

The root layout re-reads them on every request and `/api/config` is polled every 20 s by the client, so files
that appear while the app is running show up without a rebuild. Missing values render as "-", never as invented
numbers. The only APY shown is the Blend supply rate on the /pools strategy cards, measured live from two on-chain
reads (or, until then, the `observed_apr` written by the deployment team), labelled as observed on testnet, not a
forecast. The v1 vault `usdc-defindex-idle` keeps funds idle (no Blend interest) and is never credited with a yield.

## Dev signer (testnet only)

`lib/wallet.tsx` adds a "Dev wallet (testnet secret key)" entry to the Connect menu, compiled in only when
`NEXT_PUBLIC_DEV_SIGNER=1`. Keys come from `web/.env.local` (git-ignored, see `.env.example`):

```
NEXT_PUBLIC_DEV_SIGNER=1
NEXT_PUBLIC_DEV_SECRET=maker=S...,taker=S...        # or a single S... key
```

`NEXT_PUBLIC_*` variables are **inlined into the client bundle**: use throwaway testnet keys only and never ship a
build made with the signer enabled (with `NEXT_PUBLIC_DEV_SIGNER` unset the code and the keys are dead-code
eliminated from production builds). `node e2e/setup-env.mjs` writes `.env.local` from
`../deployments/testnet*.secrets.json` (also git-ignored) and prints public keys only.

## Tests

```sh
npm run test:unit                              # range + pool grid math
NEXT_DIST_DIR=.next-3200 npx next dev -p 3200 & # a dev server for the browser tests
node e2e/setup-env.mjs                          # once: dev keys into .env.local
node e2e/run-flows.mjs                          # /trade SDEX flows on testnet, verified on Horizon (receipt deposit / redeem: position-flows)
node e2e/pool-flows.mjs                         # pool flows via New position + swap dialog (POOL=<instance id>); unfilled positions removed on chain (E2E_DEV_SECRET)
POOL=lbond-usdc-twoway TWOWAY=1 node e2e/pool-flows.mjs   # two-way round trip: add, swap through, swap back, claim fees, remove
E2E_DEV_SECRET=<label=S...> node e2e/position-flows.mjs   # /pools New position: Ask + Bid on all 4 strategies, Your positions (locked, View position = creation tx), curator rule + Change range, on-chain cleanup of this run's orders (e2e/chain-cleanup.mjs), redeem from /portfolio
node e2e/order-flows.mjs                        # /pools reference price + direction rule + crossing per strategy (UI only, no transaction)
node e2e/portfolio-check.mjs                    # portfolio UI checks (no transactions)
node e2e/shots.mjs --path /trade --name trade --wallet maker --full   # screenshot helper
```

The browser tests use Playwright with the locally cached Chromium (`e2e/browser.mjs`); `BASE_URL` defaults to
`http://localhost:3200`. They send real testnet transactions with small amounts and write
`e2e/results/*.json` (git-ignored) and screenshots under `.screenshots/` (git-ignored).

## Layout

```
web/
  app/              layout, landing, trade, pools, earn (redirect), portfolio, faucet, app (redirect), api/config, api/faucet
  app/fonts/        Inter variable (inter-ui 4.1.1 latin subset, SIL OFL) for the cv05 "l with a tail"
  components/ui/    shadcn primitives copied from lotus-main
  components/       Nav, SiteChrome, common (links, tx status, token icon, inputs), VenueComparison
  components/trade/ chart (lightweight-charts), book panels, swap / limit tabs, open offers
  components/pools/ New position wizard, range chart, strategy cards, review modal, Your positions, pool swap,
                    two-way builder (advanced)
  components/vault/ StrategyCard (status badge, still used by /portfolio receipts)
  components/portfolio/, components/landing/, components/wallet/, components/faucet/ (page + nav hint)
  lib/stellar.ts    assets, amounts, Horizon fetchers, RPC views, tx flows (classic, chunked, Soroban)
  lib/range.ts      SDEX range builder math (BigInt)
  lib/poolGrid.ts   pool price grid + position planning (BigInt)
  lib/orderRoute.ts New order routing: bins -> SDEX ladder, proximity rule, signatures, summary line (pure)
  lib/orderTx.ts    New order execution per destination (pool, SDEX, deposit + SDEX)
  lib/yieldRate.ts  live Blend supply APR from two b_rate reads (pure, tested)
  lib/pool.ts       lotus_pool adapter: live client + local simulation
  lib/config*.ts    deployment config (server loader + shared types + client context)
  lib/explorer.ts   stellar.expert links (tx, account, asset, contract, offer, liquidity-pool)
  lib/faucet.ts     faucet assets from config, trustline state, claim plan, rate limiter (pure, tested)
  lib/faucet-server.ts  faucet keys + funding txs (server only)
  e2e/, tests/      Playwright scripts and plain-node unit tests
```

## Notes

- Every address, contract, asset, tx hash and offer id links to stellar.expert (testnet) with an external-link
  icon (`lib/explorer.ts`, `ExplorerLink` / `AssetLink` in `components/common.tsx`).
- Vault-pool views (`quote_swap` sell, `get_position`, `get_bin` Bid, `depth` Bid, `tvl`) and `vault_value()`/`surplus()`
  call a DeFindex view that writes a fee report: the app only ever runs them through `simulateTransaction`.
- **Retries in `invokeContract` (`lib/stellar.ts`, classification in `lib/txErrors.ts`, tested in `tests/tx-errors.test.mts`)**:
  every attempt simulates again right before signing. `txBadSeq` is retried once, `TRY_AGAIN_LATER` resends the same signed
  transaction up to 3 times, and a `tx_failed` caused by a footprint race (`Error(Storage, ExceededLimit)` / trapped) is
  re-simulated, re-signed and resent up to 2 times, then reported as "The vault state changed while signing, retry".
  Why: calls that withdraw from the SHARED DeFindex vault (pool sell swaps, claim and remove on the vault pool, lotus_vault
  redeem) read an entry other users also change (the vault's idle USDC flips between 0 and 1 stroop), so the transaction can
  touch a ledger entry outside the simulated footprint. A hardware or extension wallet asks to sign again on such a retry.
- A classic transaction cannot mix with a Soroban invocation, which is why "add trustline + deposit" is two signatures
  (and "deposit + receipt offers" in New order is two transactions, see above).
- Horizon quirk handled in `lib/book.ts`: order-book bid amounts are in the counter asset, ask amounts in the base.
- `deposit()` on the Lotus vault returns DeFindex shares, not the minted amount: the UI states the 1:1 mint from
  the amount you typed.
- `getEvents` only scans about 10k ledgers per call, so `lib/vault.ts` pages through three 9000-ledger windows.
