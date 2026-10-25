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
npm run test:unit      # range builder + pool grid math (plain node, no browser)
```

Node 20+ (tested on Node 25). If another `next dev` already holds `web/.next` (Next takes an exclusive lock
on `<distDir>/lock`), start a second server with its own dist dir: `NEXT_DIST_DIR=.next-3200 npx next dev -p 3200`.

## Routes

| route | what |
| --- | --- |
| `/` | Landing: hero with the ASCII lotus (lazy loaded WebGL, black fallback), how it works, why Stellar, footer |
| `/trade` | The SDEX front. Market selector (`?market=LBOND-lUSDC`, `USDC-lUSDC`, one pair per Lotus receipt), candles + depth panel, order book, cumulative depth, recent trades, order panel (**Swap** / **Limit** / **Range**), open offers with Cancel |
| `/pools` | **Lotus pool** tab (range pool on Soroban): instance picker, depth by price bin, range position builder, my positions (claim / remove), pool swap with a venue comparison against the SDEX. **Vault & receipt (lUSDC)** tab (`?tab=vault`): strategy cards, deposit / redeem, yield explainer, contract events |
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

### /pools

`lib/pool.ts` is a thin adapter over the `lotus_pool` ABI (`docs/pool-abi.md`): argument encoders, result
decoders, a live client (Soroban RPC) and a **local simulation** client. Until `deployments/testnet.pool.json`
lists an instance the page runs the simulation (clearly labelled, nothing is sent on-chain); once the file
exists the same UI talks to the contract. `lib/poolGrid.ts` replicates `price_at(bin) = round(1e7 * (1 + step/10000)^bin)`
with BigInt and is checked against `contracts/lotus_pool/test-vectors.json` by `npm run test:unit`.

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
node e2e/pool-flows.mjs                         # pool flows (live contract, or the local simulation)
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
  lib/pool.ts       lotus_pool adapter: live client + local simulation
  lib/config*.ts    deployment config (server loader + shared types + client context)
  lib/explorer.ts   stellar.expert links (tx, account, asset, contract, offer, liquidity-pool)
  e2e/, tests/      Playwright scripts and plain-node unit tests
```

## Notes

- Every address, contract, asset, tx hash and offer id links to stellar.expert (testnet) with an external-link
  icon (`lib/explorer.ts`, `ExplorerLink` / `AssetLink` in `components/common.tsx`).
- A classic transaction cannot mix with a Soroban invocation, which is why "add trustline + deposit" is two signatures.
- Horizon quirk handled in `lib/book.ts`: order-book bid amounts are in the counter asset, ask amounts in the base.
- `deposit()` on the Lotus vault returns DeFindex shares, not the minted amount: the UI states the 1:1 mint from
  the amount you typed.
- `getEvents` only scans about 10k ledgers per call, so `lib/vault.ts` pages through three 9000-ledger windows.
