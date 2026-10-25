# Lotus web

Next.js (App Router, TypeScript, Tailwind v4) front end for the Lotus vault on Stellar testnet.
Reads live state from Horizon and Soroban RPC, signs with any wallet supported by
`@creit.tech/stellar-wallets-kit` (Freighter, xBull, Albedo, Lobstr, Hana, ...).

## Run

```sh
cd web
npm install
npm run dev        # http://localhost:3000
npm run build      # production build (must pass)
npm start          # serve the production build
npm run lint
```

Node 20+ (tested on Node 25).

## Config

No `.env` is required. At request time `lib/config.ts` reads, in this order:

1. `$LOTUS_DEPLOYMENTS_DIR/testnet.contract.json` and `testnet.classic.json` (optional override)
2. `../deployments/testnet.contract.json` and `../deployments/testnet.classic.json` (written by the deploy scripts)
3. `web/config.example.json` as a per-file fallback

The two deployment files are merged into one `LotusConfig` (network, Horizon/RPC URLs, passphrase,
`lotus_vault` contract id, underlying / receipt / RWA assets, named demo accounts). Both `/` and `/app`
are rendered dynamically, so a fresh deploy shows up on reload without rebuilding. When a file is missing
or an id is empty the app still builds and runs; a banner says what is missing and the dependent widgets
show `—` instead of inventing numbers.

Asset codes are never hardcoded: if the deployment fell back to native XLM as the underlying
(`"issuer": null`), every label, Horizon query (`asset_type=native`) and path payment adapts.

| Env var | Purpose |
| --- | --- |
| `LOTUS_DEPLOYMENTS_DIR` | Directory holding the two deployment JSON files (default `../deployments`) |

## Pages

### `/` Landing

Wordmark, tagline, three cards (deposit and earn / trade on SDEX / regulated RWAs), CTA to `/app`.

### `/app` Main app

**Vault** (`components/VaultPanel.tsx`)

- `vault_value()`, `supply()`, `surplus()`, `get_config()` read through RPC `simulateTransaction`
  (null source account, decoded with `scValToNative`), refreshed every 10 s. Surplus is also shown as
  a percentage of supply (accrued, not yet distributed yield). No APY is displayed: a single snapshot does
  not give a rate, and we do not show fake numbers.
- Wallet balances of the underlying and the receipt from Horizon, including the part locked in offers
  (`selling_liabilities`).
- **Deposit**: if the account has no trustline to the receipt, a `ChangeTrust` transaction is submitted
  first (classic tx via Horizon), then `deposit(from, amount)` is simulated, assembled with
  `rpc.assembleTransaction`, signed by the wallet, sent with `sendTransaction` and polled with
  `getTransaction`. The minted amount (i128 return value) is shown with a stellar.expert link.
- **Redeem**: same flow for `redeem(from, amount)`.

**Book LBOND/receipt** (`components/BookPanel.tsx`)

- Horizon `/order_book` for the RWA priced in the receipt, refreshed every 5 s, bids and asks with
  cumulative depth bars. Horizon reports bid amounts in the counter asset and ask amounts in the base
  asset; the view normalises both to base size and counter total.
- **Ladder** (maker): N levels (start price, step, size) become ONE transaction with N
  `manageSellOffer` operations. "Sell LBOND" places asks (LBOND for receipt); "Buy LBOND" places bids
  (receipt for LBOND, exact rational inverse price). A missing trustline to the asset being bought is
  added in the same transaction. Warnings cover unauthorized LBOND trustlines and insufficient balance.
- **Buy with underlying** (taker): quote from Horizon `/paths/strict-send`, then one
  `pathPaymentStrictSend` underlying → LBOND with `path = [receipt]` and a configurable slippage
  (default 1 %). Shows the LBOND trustline authorization state, since LBOND is `AUTH_REQUIRED`: the
  issuer must authorize the taker before the path payment can succeed.

**Peg receipt/underlying** (`components/PegPanel.tsx`)

Small live view of the 1:1 book from Horizon (5 s).

**Holders** (`components/HoldersStrip.tsx`)

- Horizon `/accounts?asset=CODE:ISSUER` for receipt holders (top 12 by balance), with the amount
  resting in offers (`selling_liabilities`) and the open-offer count from `/accounts/{id}/offers`.
  Named demo accounts from the deployment files (maker, taker, peg_lp, ...) are labelled.
- Recent `lotus_vault` contract events through RPC `getEvents` (best effort: shows "unavailable" when
  the RPC retention window has nothing).

## Layout

```
web/
  app/            layout, landing (/), /app page, icon.svg
  components/     panels, depth view, header, small UI primitives
  lib/config.ts   server-only loader for the deployment JSON (fs), with fallback
  lib/stellar.ts  assets, amounts, Horizon fetchers, RPC views, tx flows, op builders
  lib/wallet.tsx  wallets-kit v2 React provider (connect / sign / disconnect)
  lib/account.tsx polled Horizon account of the connected wallet
  lib/hooks.ts    usePolling, useTx, useDebounced
  config.example.json
```

## Notes for the demo

- Testnet wallet: fund with Friendbot, set the wallet's network to Testnet.
- A classic transaction cannot mix with a Soroban invocation, which is why "add trustline + deposit" is
  two signatures.
- Every explorer link points at `https://stellar.expert/explorer/testnet/...`.
