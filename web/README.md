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
npm run test:unit      # range builder, pool grid, New order routing (plain node, no browser)
```

Node 20+ (tested on Node 25). If another `next dev` already holds `web/.next` (Next takes an exclusive lock
on `<distDir>/lock`), start a second server with its own dist dir: `NEXT_DIST_DIR=.next-3200 npx next dev -p 3200`.

## Routes

| route | what |
| --- | --- |
| `/` | Landing: hero with the ASCII lotus (lazy loaded WebGL, black fallback), how it works, why Stellar, footer |
| `/trade` | The SDEX front. Market selector (`?market=LBOND-lUSDCb`, `USDC-lUSDCb`, one pair per Lotus receipt, plus `LBOND-USDC` in plain USDC), candles + depth panel, order book, cumulative depth, recent trades, order panel (**Swap** / **Limit** / **Range**), open offers with Cancel |
| `/pools` | **Lotus pool** tab: **New order** panel (one directional range limit order, waits in the Lotus pool or on the SDEX, yield off or on), instance picker, depth by price bin, my positions (claim / remove), pool swap with a venue comparison against the SDEX. **Vault & receipt (lUSDC)** tab (`?tab=vault`): strategy cards, deposit / redeem, yield explainer, contract events |
| `/earn` | Redirect to `/pools?tab=vault` (keeps `?strategy=`) |
| `/portfolio` | Balances (available vs in offers), open offers, receipts per vault, pool positions, recent activity, USDC-equivalent summary |
| `/app` | Redirect to `/trade` |
| `/api/config` | The merged deployment config as JSON (public keys only), read at request time |

Vocabulary: the **Lotus pool** is the `lotus_pool` range pool (directional liquidity on a price grid). The
**Lotus vault** is the `lotus_vault` wrapper (USDC to a DeFindex vault, receipt token `lUSDC`, a classic asset
that trades on the SDEX). Never call the vault a pool.

### /trade

- **Swap**: pay asset to receive asset with one `pathPaymentStrictSend`, quoted from Horizon `/paths/strict-send`
  (route, effective price, min received with slippage). `USDC > lUSDC > LBOND` is one transaction. Shows the trustline
  state of the received asset; LBOND is `AUTH_REQUIRED`, so a trustline that the issuer has not authorized gets a
  clear "not authorized by the issuer" message. For USDC/LBOND it adds the **venue comparison** (Lotus pool quote
  next to the SDEX path, better one marked).
- **Limit**: one `manageSellOffer` (ask or bid). Warns when the price crosses the book.
- **Range** (pro): one transaction, one signature, N offers (2 to 50 levels). Modes: *One-way sell* (asks only),
  *One-way buy* (bids only), *Two-sided band* (bids below the split price, asks above). Shapes: uniform, weighted to
  start, weighted to end, with a live preview. Summary: average price, size, offers, XLM base reserve (0.5 per
  offer), balances needed. Stellar allows at most 100 operations per transaction; `submitClassicChunked` splits
  larger lists (the UI caps at 50 levels, so a range is always one transaction). A filled level never flips back
  by itself (unlike an AMM position): re-quote to continue. Offers only set selling liabilities, so funds stay on
  the account; when the receipt is in the offers the page says it keeps earning.
- **Open offers**: from Horizon `/accounts/{id}/offers`, Cancel = `manageSellOffer` with amount 0 and the offer id.

### New order (/pools, main panel)

One flow to create a **range limit order**, directional only: **Ask** sells LBOND as the price rises, **Bid** waits
with USDC to buy LBOND as the price falls (no classic two-way LP here). The range is built with the pool grid
(start / end price snapped to bins, weight shape, live preview). Then two controls, chosen at creation only (there
is no "move" later):

| | Earn yield: off | Earn yield: on |
| --- | --- | --- |
| **Waits in: Lotus pool** | `add_position(Directional)` on the first pool instance without a vault (`lbond-usdc-idle`), 1 signature | `add_position(Directional)` on the first instance with a vault (`lbond-usdc-defindex`, USDC leg in DeFindex/Blend), 1 signature |
| **Waits in: SDEX** | one classic tx, one `manageSellOffer` per bin on LBOND/USDC, 1 signature | quoted in the active receipt (`testnet.contract.json` `receipt`): Ask = one classic tx of offers selling LBOND for the receipt; Bid = `lotus_vault.deposit(USDC)` then the classic ladder buying LBOND with the receipt, **2 signatures** |

- Contract ids come from `testnet.pool.json` / `/api/config` (instance order decides which one is "idle" and which
  one "vault"); the receipt code and issuer from `testnet.contract.json`. Other instances (the separate two-way
  pool) keep the old builder, reachable from the link under the panel (`?pool=lbond-usdc-twoway`). Instances with
  `status: "retired"` and the `retired_pools[]` array are hidden everywhere except /portfolio, where an owner can
  still claim / remove.
- Before signing the panel shows one line, e.g. *Sell 100 LBOND from 1.000 to 1.005 · waits in the Lotus pool ·
  earns Blend yield on proceeds · 1 signature*, plus the details (average price, bins, receive if filled, XLM
  reserve, trustlines added, reference price).
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
  re-signs both (2 times). Deposit ok but offers failed: the UI says you hold the receipt (redeemable at par on the
  Vault tab) and offers **Post the offers again** (one classic tx, fresh sequence). The atomic peg-book
  alternative (pathPaymentStrictReceive USDC -> receipt + offers in one classic tx) is not implemented.
- **Curator rule** (UI only, `PROXIMITY_MIN_BINS = 10` in `lib/orderRoute.ts`): for Bid + Pool, yield "On" is
  disabled when the top bin of the range is less than 10 bins below the reference price ("Too close to the price:
  your USDC would be recalled from the vault by every trade, little yield, more failures"). Reference = mid of the
  SDEX LBOND/receipt book, else LBOND/USDC, else the pool's own mid (best directional bins), else 1.0. Ask and SDEX
  are never blocked (tooltip: Ask yield is on proceeds that wait in the vault; a receipt in an SDEX offer keeps
  earning).
- /trade **Range** links to this panel; it stays the free-form SDEX ladder (any levels, two-sided bands).
- /portfolio lists all four kinds: pool positions per instance (claim / remove), and SDEX offers on LBOND/USDC and
  on LBOND/receipt (tagged "earns" / "proceeds earn" when quoted in the receipt), each with explorer links.

### /pools

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

Position builder: side **Ask** (sell LBOND as the price rises) or **Bid** (buy LBOND as the price falls), price
range converted to grid bins (max 64 bins per position, 0.001 minimum per bin, as in the contract), weight shape,
amount, mode **Directional** (default) or **Two-way LP** (disabled unless the pool reports `supports_two_way`),
summary with average price, bins, fee tier and where the USDC leg is parked.

## Config

At request time `lib/config.ts` reads, in this order, for each file:

1. `$LOTUS_DEPLOYMENTS_DIR/<file>` (optional override)
2. `../deployments/<file>`
3. `web/config.example.json` as a fallback for the two base files

| file | used for |
| --- | --- |
| `testnet.contract.json` | network, Horizon / RPC urls, the active `lotus_vault` contract, USDC and receipt assets |
| `testnet.classic.json` | the LBOND asset and the named demo accounts |
| `testnet.strategies.json` | Lotus vault instances (cards on the Vault tab, one market pair per receipt). Absent: ONE strategy is derived from `testnet.contract.json` and marked idle |
| `testnet.pool.json` | Lotus pool instances (shape in `docs/pool-abi.md`). Absent: one local simulation instance |

The root layout re-reads them on every request and `/api/config` is polled every 20 s by the client, so files
that appear while the app is running show up without a rebuild. Missing values render as "-", never as invented
numbers. No APY is shown anywhere: the testnet vault `usdc-defindex-idle` keeps funds idle (no Blend interest),
and yield figures would need two real snapshots.

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
node e2e/run-flows.mjs                          # SDEX + vault flows on testnet, verified on Horizon
node e2e/pool-flows.mjs                         # directional pool flows (POOL=<instance id> to pick one; live contract or local simulation)
POOL=lbond-usdc-twoway TWOWAY=1 node e2e/pool-flows.mjs   # two-way round trip: add, swap through, swap back, claim fees, remove
node e2e/order-flows.mjs                        # New order: Bid on all 4 destinations + Ask SDEX/receipt (ASKS=1: all Asks), proximity rule, portfolio, cleanup
node e2e/portfolio-check.mjs                    # portfolio UI checks (no transactions)
node e2e/shots.mjs --path /trade --name trade --wallet maker --full   # screenshot helper
```

The browser tests use Playwright with the locally cached Chromium (`e2e/browser.mjs`); `BASE_URL` defaults to
`http://localhost:3200`. They send real testnet transactions with small amounts and write
`e2e/results/*.json` (git-ignored) and screenshots under `.screenshots/` (git-ignored).

## Layout

```
web/
  app/              layout, landing, trade, pools, earn (redirect), portfolio, app (redirect), api/config
  app/fonts/        Inter variable (inter-ui 4.1.1 latin subset, SIL OFL) for the cv05 "l with a tail"
  components/ui/    shadcn primitives copied from lotus-main
  components/       Nav, SiteChrome, common (links, tx status, token icon, inputs), VenueComparison
  components/trade/ chart (lightweight-charts), book panels, swap / limit / range tabs, open offers
  components/pools/ pool page, depth chart, position builder, positions, pool swap
  components/vault/ Vault & receipt tab
  components/portfolio/, components/landing/, components/wallet/
  lib/stellar.ts    assets, amounts, Horizon fetchers, RPC views, tx flows (classic, chunked, Soroban)
  lib/range.ts      SDEX range builder math (BigInt)
  lib/poolGrid.ts   pool price grid + position planning (BigInt)
  lib/orderRoute.ts New order routing: bins -> SDEX ladder, proximity rule, signatures, summary line (pure)
  lib/orderTx.ts    New order execution per destination (pool, SDEX, deposit + SDEX)
  lib/pool.ts       lotus_pool adapter: live client + local simulation
  lib/config*.ts    deployment config (server loader + shared types + client context)
  lib/explorer.ts   stellar.expert links (tx, account, asset, contract, offer, liquidity-pool)
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
