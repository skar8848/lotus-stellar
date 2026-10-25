# Lotus testnet bot

A Node program (`scripts/bot/`) that keeps the Lotus testnet markets alive and defends the receipt's peg:
an **arbitrageur** that restores the peg through `lotus_vault`, **market makers** that quote LBOND/receipt and
USDC/receipt on the Stellar DEX (SDEX), a **flow generator** that trades against those quotes, a **keeper step** that
distributes the vault's interest, and, when the Lotus range pool is deployed, **pool legs** (directional pool
positions, pool flow, cross-venue arbitrage). Testnet only: the process refuses to start on any other network.

"The receipt" is whatever `deployments/testnet.contract.json` says: `lUSDC` on Lotus v1, **`lUSDCb` on v2** (the
DeFindex vault seeded into Blend, real interest). Nothing in the bot hard-codes the name; after a switch of deployment
(`deployments/switch-strategy.sh v2`) re-run `npm run bot:setup`.

## Where the volume comes from

Trading activity on the Lotus testnet markets (LBOND/receipt and USDC/receipt on the SDEX, and the LBOND/USDC
Lotus pool) comes from three accounts operated by the Lotus team: two market makers (`mm_a`, `mm_b`) and an
arbitrageur (`arb`). They trade on testnet with assets the team issues (LBOND, issued by `rwa_issuer`) or
mints through `lotus_vault` (the lUSDC / lUSDCb receipt, minted 1:1 against Blend testnet USDC taken from the public
faucet). The trades are real on-chain transactions. The accounts are listed in `deployments/testnet.bot.json`.

## Quick start

```sh
cd scripts
npm install                      # once (shared with the numbered scripts)
npm run bot:setup                # creates and funds mm_a, mm_b, arb (idempotent; re-run after a deployment switch)
npm run bot                      # arbitrageur + market maker + flow (+ pool legs), until Ctrl+C
npm run bot -- --duration 600    # ... for 10 minutes
npm run bot -- --dry-run         # decide and log, send nothing
npm run bot -- --cleanup         # on stop (Ctrl+C), cancel the bot's OWN open offers and close its pool positions
npm run bot:depeg                # stress test: push the receipt under par, watch the arb restore it
npm run bot -- --scenario premium      # mirror image: receipt bid above par
npm run bot:demo                 # ~3 minute scripted run for the video, ends with the keeper step
npm run bot -- --scenario cross-venue  # dislocate the pool price, watch the arb close it against the SDEX
npm run bot -- --scenario keeper       # let mm_a's offers rest (180 s), then distribute the vault interest
npm run bot -- --help            # every option with its default
```

Run order on a fresh checkout: the numbered scripts first (`01` to `04`: accounts, LBOND, receipt, books), then
`bot:setup`, then `bot`. The bot needs `deployments/testnet.contract.json` (the active vault) and, for `bot:setup` and
the keeper step, the `rwa_issuer` and `keeper` secrets of `deployments/testnet.secrets.json`; the pool legs additionally
read `deployments/testnet.pool.json`.

## Accounts and files

| account | role |
| --- | --- |
| `mm_a` | market maker: 4 levels each side on LBOND/receipt (fair value +/- 5 bps, 10 bps apart), the USDC/receipt peg book at 0.9999 / 1.0001, and (pool on) one Ask and one Bid position in the Lotus pool |
| `mm_b` | flow generator: small clips against mm_a's quotes (log-normal sizes, random and clustered timing, both directions, both books, the odd routed USDC -> receipt -> LBOND trade); also the actor that moves the peg in the scenarios |
| `arb` | arbitrageur: peg arbitrage via `deposit`/`redeem`, and the cross-venue arbitrage when the pool is live |

`bot:setup` per account: friendbot XLM; trustlines (the active receipt, LBOND; the USDC trustline is created by the Blend
faucet itself); LBOND authorization signed by `rwa_issuer` (AUTH_REQUIRED asset); LBOND inventory from the issuer (20,000
each for the market makers); 1,000 USDC from the Blend faucet; the receipt minted through `lotus_vault.deposit()` (600
each for the market makers). **After a deployment switch** it also cancels the account's own offers in the previous
receipt (from `deployments/testnet.contract.v1.json`) and redeems that receipt at par on the previous vault, because the
faucet pays USDC only once per account (see Known limits): that USDC is the bot's capital.

| file | content |
| --- | --- |
| `deployments/testnet.bot.json` | public: bot addresses, roles, assets, setup tx hashes, simulated NAV state. Read it to label bot accounts in a UI |
| `deployments/testnet.bot.secrets.json` | `S...` keys of the three accounts, mode 0600. Covered by `deployments/.gitignore` (`*.secrets.json`); `bot:setup` runs `git check-ignore` and refuses to write the file if it is not ignored |
| `scripts/bot/logs/` | one log file per run (git-ignored) |

Nothing in `scripts/0*.mjs`, `scripts/lib/`, `contracts/` is modified; the bot imports from `scripts/lib/`.

## What each component does

### Peg arbitrageur (`arb.mjs`)

`lotus_vault` mints the receipt 1:1 against USDC (`deposit`) and burns it 1:1 (`redeem`) while
`vault_value() >= supply()`. So 1 USDC is the fair price of 1 receipt and every tick the arbitrageur reads the
USDC/receipt book (Horizon `/order_book`):

* **receipt offered under par** by more than `--arb-threshold-bps` (default 2): path payment strict-receive
  USDC -> receipt with a price cap, then `redeem()` for USDC at par.
* **receipt bid above par**: `deposit()` USDC for the receipt at par, then path payment strict-send receipt -> USDC into the bid.

Guards: `vault_value`/`supply` are read (by simulation only, never submitted) before every cycle and the redeem is
**skipped when it would pay pro-rata** (`vault_value < supply`, beyond `--backing-tol-bps` of DeFindex rounding); the
redeem is simulated first so its return value is known before a fee is spent; the cycle size is capped by the book depth
at an acceptable price, `--arb-max-notional`, the USDC balance and `supply()`; receipt left over from an interrupted
cycle is redeemed at the next tick. Every cycle is logged with realised profit and fees and kept in a ledger that the
run summary prints.

### Market maker (`mm.mjs`, `MarketMaker`)

Each tick mm_a reads its own offers and sends at most one transaction that updates only the slots whose price
drifted more than `--requote-bps` (4) from simulated fair value, or whose size is under 60% of target.
**Simulated fair value**: LBOND NAV starts at 1.00, accrues `--nav-apr` (5%) and carries a mean-reverting
(Ornstein-Uhlenbeck) noise of about 3 bps; there is no oracle, the bond is simulated. `--time-scale` accelerates
the accrual (the demo uses x5000; accelerated runs do not persist their NAV).
Quotes never cross another account's offers: they are clamped against the book minus mm_a's own offers, and
operations in a re-quote transaction are ordered so a bid never sits above an ask. `mm_a` never cancels or
modifies an offer it does not own.

**`--ladder leave` (default).** The demo ladder (`maker`'s asks at 0.98 / 0.99 / 1.00 / 1.01 / 1.02) is left alone: mm_a's
bond bids are clamped just under the cheapest ask in the book (0.9799 while the 0.98 level exists, 0.9899 once it is
consumed) and mm_b only sells LBOND on the bond book. `--ladder take` quotes a normal +/- 5 bps book and lets the bot
trade against the stale demo asks like any participant: it consumes the 0.98 to 1.00 levels (about 250 LBOND);
`node scripts/04-seed-book.mjs --reset` re-posts them.

### Flow generator (`mm.mjs`, `Flow`)

mm_b trades at random intervals (exponential around `--flow-min-sec`..`--flow-max-sec`, 10 to 20 s by default, with
occasional short bursts), clip sizes drawn log-normally between `--flow-size-min` and `--flow-size-max` (about a third
snapped to round numbers), alternating direction. It only trades when the top of the book is mm_a's (so it never
touches the demo ladder or `peg_lp`) unless `--flow-touch-foreign` is set, and it keeps both accounts stocked with
plain payments when one runs low. Roughly `--flow-pool-weight` of its trades go to the Lotus pool when it is live.

### Keeper step (`keeper.mjs`)

The v2 vault earns real Blend interest, which shows up as `surplus() = vault_value() - supply()`. The keeper step is
the logic of `scripts/06-keeper-distribute.mjs` (imported from `scripts/lib/lotus.mjs`): holders from Horizon, balances
re-read from RPC, `floor(surplus * balance / supply)` per holder, 20 recipients per `distribute()` call, signed by the
`keeper` key of `deployments/testnet.secrets.json`. It prints every holder's receipt balance before and after and marks
the accounts whose receipt **sits in open SDEX offers** (`mm_a`, `peg_lp`, `maker`): SDEX offers only reserve funds, so
quoted inventory still counts and still earns. `demo` ends with it (`--demo-keeper false` to skip,
`--keeper-wait N` to let the offers rest N more seconds first); `--scenario keeper` is the same step after 180 s of
quoting. All contract views (`supply`, `vault_value`, `surplus`) are read with `simulateTransaction`.

### Scenarios (`scenarios.mjs`, `pool-scenarios.mjs`)

* `depeg`: mm_b sells enough receipt to eat every bid above `--shock-price` (0.985) and leaves `--shock-rest` (150)
  resting as an ask at that price. The arbitrageur must buy it and redeem. Output: before / after-shock /
  after-arbitrage table (best bid, best ask, mid, last trade, `supply()`, `vault_value()`), the arb cycle with
  timestamps and tx links.
* `premium`: the mirror image, mm_b bids above par (`--premium-price`, 1.004); the arbitrageur mints and sells.
* `demo`: about 3 minutes: normal quoting, a burst of several trades per ledger (one multi-operation transaction),
  the depeg shock at about t = 60 s, arb recovery, normal trading, totals, then the keeper step.
* `cross-venue` and `keeper`: see above and below.

**The profit in these scenarios is a transfer between the team's own accounts**: the arbitrageur is paid by mm_b, which
creates the dislocation. They demonstrate the mechanism (detection time, cycle time, par redemption, cost), not revenue.
**A depeg test also consumes real resting liquidity**, including `peg_lp`'s bid in the demo peg book. That is what a dump
does. `node scripts/04-seed-book.mjs --reset` re-posts the demo books afterwards.

### Lotus pool legs (`pool-legs.mjs`, `lib/pool.mjs`), behind a feature flag

`--pool auto` (default) enables them when `deployments/testnet.pool.json` lists a live LBOND/USDC pool whose ABI
version, bin step, fee and `price_at` match what the adapter expects; otherwise the bot runs exactly as without the
pool. `--pool off` never uses it, `--pool on` makes a missing pool an error, `--pool-id lbond-usdc-defindex` selects
the instance whose USDC sits in DeFindex (default: the first live one, `lbond-usdc-idle`).
The adapter (`lib/pool.mjs`) is the only code that knows the pool: `quote`, `swap`, `addPosition`, `removePosition`,
`depth`, and `priceAt` / `binCeil` / `binFloor`, a bit-exact port of the contract's `price_at(bin)` checked against
all 2,807 vectors of `contracts/lotus_pool/test-vectors.json`.

* **mm_a** keeps one directional **Ask** position (`--pool-ask-size` LBOND) and one **Bid** position
  (`--pool-bid-size` USDC) spread over `--pool-levels` bins starting `--pool-half-spread-bps` from fair value, and
  re-posts them (`remove_position` + `add_position`) when fair value moved `--pool-shift-bins` bins or a side is more
  than 70% filled.
* **mm_b** sends a share of its flow to the pool (`swap`), only when the price it would get proves it is touching mm_a's bins.
* **Cross-venue arbitrage** (`CrossArb`): every `--cross-interval-sec` the arb prices LBOND on both venues, on the
  pool with `quote_swap` (fee included: a buyer pays price + fee, a seller receives price - fee) and on the SDEX along
  LBOND <-> receipt <-> USDC (walking both books). If the **net** edge exceeds `--cross-min-edge-bps` (8) and
  `--cross-min-profit`, it executes the pool swap and the opposite path payment. With `--ladder leave` it only trades
  against mm_a's SDEX quotes, which also means the "buy on the SDEX, sell to the pool" direction needs `--ladder take`
  (the demo ladder's cheaper asks are in the way).
* **`--scenario cross-venue`**: mm_b plants a pool position `--cross-shock-bps` (80) off the SDEX price (`--cross-dir cheap`:
  a cheap Ask, works in `leave` mode; `rich`: a rich Bid, needs `--ladder take`; `both`), the arbitrageur closes the
  gap, mm_b removes what is left of its position. Output: a table of both venues' prices before / dislocated / after,
  the ledger, tx links.

## Safety

* **Testnet only**: refuses unless the network passphrase is `Test SDF Network ; September 2015` and the Horizon and
  RPC URLs are testnet endpoints.
* **Own accounts only**: offers and pool positions are listed per bot account and only those are cancelled or closed.
  `maker`, `peg_lp`, `taker` and the issuers are never written to (the issuer is used by `bot:setup` only, to authorize
  and fund the bot accounts; the keeper key signs `distribute()` in the keeper step).
* **Kill switch**: Ctrl+C (SIGINT/SIGTERM) stops all loops; with `--cleanup` the bot's own offers are cancelled and its
  pool positions closed first (tested with a real SIGINT: 2 positions closed, 10 offers cancelled, nothing left). A
  second Ctrl+C exits immediately.
* **XLM guard**: the bot stops when any bot account falls under `--min-xlm` (200).
* **Caps**: `--max-tx-per-min` (20), `--max-ops-per-min` (60), and request budgets `--http-per-min` (150) /
  `--rpc-per-min` (150). Hitting a cap makes the bot wait, not fail.
* **Rate limits**: an HTTP 429 pauses all calls to that service for the `Retry-After` time (or 4 s doubling), is
  counted, and is reported in the run summary; 5xx and network errors are retried.
* **`--dry-run`**: reads the books and contract, logs every action it would take, submits nothing.
* One log line per action with a `https://stellar.expert/explorer/testnet/tx/<hash>` link where there is a transaction.

## What the testnet runs showed (2026-10-25)

All numbers below come from real runs on testnet; the full logs are in `scripts/bot/logs/` and every transaction is
linked in them.

| | Lotus v1 (idle vault) | Lotus v2 (Blend, `lUSDCb`) |
| --- | --- | --- |
| `bot:depeg`: shock | 450 lUSDC dumped: mm_a's bid (100) and `peg_lp`'s bid (200.1) eaten, 150 left as an ask at 0.985 (-150 bps) | 443 lUSDCb dumped: mm_a's bid (93) and `peg_lp`'s bid (200.1) eaten, 150 left at 0.985 |
| arbitrage cycle | detect T+1.3 s, buy confirmed T+4.7 s, redeem confirmed T+9.6 s | detect T+1.4 s, buy T+5.0 s, redeem T+10.3 s |
| gross profit / fees | +2.2500000 USDC / 0.00239 XLM | +2.2500000 USDC / 0.00343 XLM |
| peg restored (best ask back above 1 - 2 bps) | T+11.2 s | T+12.0 s (standalone rerun: T+10.3 s) |
| `redeem()` return value | exactly the amount burnt (par) in every cycle | exactly the amount burnt (par) in every cycle |
| `bot:premium` | mint 150.4465 + sell into 1.004 bid: +0.6018 USDC, 9.4 s, 0.00227 XLM | not rerun |
| `cross-venue` (cheap pool Ask 80 bps off) | +0.3475 and +0.1634 USDC, gap closed T+31.8 s | +0.3475 and +0.1636 USDC, gap closed T+26.1 s |
| keeper step | n/a (no interest) | 0.0006671 lUSDCb minted to 6 holders; mm_a's 292 lUSDCb in open offers earned 0.0002123 |

Reading: **yes, redeeming at par restores the peg**, and it takes about one polling interval plus two ledgers
(roughly 10 s with 1.5 s polling in the scenarios; add up to the 5 s poll in normal mode). It works because the vault is
fully backed (`vault_value >= supply` in every run), the redemption is not rate limited and costs a few thousandths of
an XLM. Capacity is bounded by the arbitrageur's USDC (1,000), `--arb-max-notional` (250 per cycle) and the vault's
liquidity; larger sizes than 150 were not tested. The two legs are separate transactions, so a competitor could take the
cheap offers between detection and the buy; the buy is then a failed transaction that costs 0.00001 XLM.

## Known limits

* The classic leg and the contract leg of an arbitrage cycle are separate transactions (Soroban allows one operation
  per transaction), so a cycle is not atomic. The risk window is one to two ledgers; a half-done cycle leaves receipt
  (redeemed at the next tick) or LBOND.
* Horizon's `/order_book` reports **bid amounts in counter-asset units** (a 99.99 USDC bid for the receipt is listed as
  `0.9999 x 99.99`, it is 100 receipt); the bot converts, anything else reading that endpoint should too.
* The Blend testnet faucet pays an asset only to an account that has **no trustline** for it yet (one call = 1,000 USDC,
  plus BLND, wETH, wBTC) and answers an empty transaction (`tx_missing_operation`) otherwise. `bot:setup` therefore never
  opens the USDC trustline itself.
* Operations that touch Blend are cheap on testnet: measured `redeem` 0.0034 XLM, `deposit` 0.0036, `distribute` 0.0028,
  a pool `add_position` about 0.05. Classic operations cost 0.00001 XLM. The 200 XLM guard is therefore far from binding.
* Flow is sequential per account and each transaction waits for a ledger (about 5 s), so one account cannot print more
  than one transaction per ledger; bursts are therefore sent as one multi-operation transaction.
* LBOND is a simulated bond: its price comes from the model above, not from any market.
