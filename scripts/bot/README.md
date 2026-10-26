# Lotus testnet bot

A Node program (`scripts/bot/`) that keeps the Lotus testnet markets alive and defends the receipt's peg:
an **arbitrageur** that restores the peg through `lotus_vault`, **market makers** that quote LBOND/receipt,
USDC/receipt and LBOND/USDC on the Stellar DEX (SDEX), a **flow generator** that trades against those quotes, a **keeper step** that
distributes the vault's interest, and, when the Lotus range pool is deployed, **pool legs** (directional pool
positions, pool flow, cross-venue arbitrage). Testnet only: the process refuses to start on any other network.

"The receipt" is whatever `deployments/testnet.contract.json` says: `lUSDC` on Lotus v1, **`lUSDCb` on v2** (the
DeFindex vault seeded into Blend, real interest). Nothing in the bot hard-codes the name; after a switch of deployment
(`deployments/switch-strategy.sh v2`) re-run `npm run bot:setup`.

## Where the volume comes from

Trading activity on the Lotus testnet markets (LBOND/receipt, USDC/receipt and LBOND/USDC on the SDEX, and the
LBOND/USDC Lotus pool) comes from three accounts operated by the Lotus team: two market makers (`mm_a`, `mm_b`) and an
arbitrageur (`arb`). They trade on testnet with assets the team issues (LBOND, issued by `rwa_issuer`) or
mints through `lotus_vault` (the lUSDC / lUSDCb receipt, minted 1:1 against Blend testnet USDC taken from the public
faucet). The trades are real on-chain transactions. The accounts are listed in `deployments/testnet.bot.json`.
The same holds for the LBOND/USDC SDEX book behind the app's "SDEX quoted in USDC" destination: its resting
quotes are mm_a's (plus, if `04-seed-book.mjs --usdc-ladder` was run, a few asks from the team's `maker` account)
and its prints are mm_b's flow and the arbitrageur. Market-maker volume is our own accounts trading with each other.

`npm run bot:live` (below) produces the steady volume behind the /trade charts. That volume also comes from our own
accounts: mm_b trades against mm_a's quotes (and sometimes against the team's demo ladders), the arbitrageur keeps the
books consistent, and every trade is a real testnet transaction. **The LBOND price is a simulation.** It is modelled on
the dynamics of a US 10-year Treasury: a simulated yield, a duration of 7 and carry accrual. The only real input is the
starting point, the latest FRED DGS10 print fetched at first start (4.96% on 2026-10-22, recorded as
`state.yield_ref_source` in `deployments/testnet.bot.json`). Every move after that is random, not market data.

## Quick start

```sh
cd scripts
npm install                      # once (shared with the numbered scripts)
npm run bot:setup                # creates and funds mm_a, mm_b, arb (idempotent; re-run after a deployment switch)
npm run bot                      # arbitrageur + market maker + flow (+ pool legs), until Ctrl+C
npm run bot -- --duration 600    # ... for 10 minutes
npm run bot -- --dry-run         # decide and log, send nothing
npm run bot -- --cleanup         # on stop (Ctrl+C), cancel the bot's OWN open offers and close its pool positions
npm run bot -- --usdc-book off   # do not quote LBOND/USDC (mm_a then cancels its own LBOND/USDC offers)
npm run bot:depeg                # stress test: push the receipt under par, watch the arb restore it
npm run bot -- --scenario premium      # mirror image: receipt bid above par (arb mints and sells)
npm run bot:demo                 # ~3 minute scripted run for the video, ends with the keeper step
npm run bot:cross                # = --scenario cross-venue: dislocate the pool price, watch the arb close it against the SDEX
npm run bot:keeper               # = --scenario keeper: let mm_a's offers rest (180 s), then distribute the vault interest
npm run bot -- --help            # every option with its default
npm run bot:live                 # long-running live mode for the charts (supervised, see "Live mode")
npm run bot:stop                 # stop bot:live cleanly (own offers cancelled, own pool positions closed)
npm run bot:topup -- --to mm_a   # one Blend faucet round through a fresh account, 1,000 USDC forwarded to mm_a
```

Run order on a fresh checkout: the numbered scripts first (`01` to `04`: accounts, LBOND, receipt, books), then
`bot:setup`, then `bot`. The bot needs `deployments/testnet.contract.json` (the active vault) and, for `bot:setup` and
the keeper step, the `rwa_issuer` and `keeper` secrets of `deployments/testnet.secrets.json`; the pool legs additionally
read `deployments/testnet.pool.json`.

## Accounts and files

| account | role |
| --- | --- |
| `mm_a` | market maker: 4 levels each side on LBOND/receipt (fair value +/- 5 bps, 10 bps apart), 3 levels each side on LBOND/USDC (same fair value and spacing, 30 LBOND each), the USDC/receipt peg book at 0.9999 / 1.0001, and (pool on) one Ask and one Bid position in the Lotus pool |
| `mm_b` | flow generator: small clips against mm_a's quotes (log-normal sizes, random and clustered timing, both directions, all three books, the odd routed USDC -> receipt -> LBOND trade); also the actor that moves the peg in the scenarios |
| `arb` | arbitrageur: peg arbitrage via `deposit`/`redeem`, the LBOND/USDC triangular check, and the cross-venue arbitrage when the pool is live |

`bot:setup` per account: friendbot XLM; trustlines (the active receipt, LBOND; the USDC trustline is created by the Blend
faucet itself); LBOND authorization signed by `rwa_issuer` (AUTH_REQUIRED asset); LBOND inventory from the issuer (20,000
each for the market makers); 1,000 USDC from the Blend faucet; the receipt minted through `lotus_vault.deposit()` (600
each for mm_b, 400 for mm_a); **USDC working capital for mm_a** (target 400 USDC for its LBOND/USDC bids): since the
faucet cannot pay twice, the shortfall is taken from mm_a's receipt beyond its 400 target, redeemed at par on
`lotus_vault` (first run: 139 lUSDCb redeemed, tx `eee94d34...`); if there is nothing spare it warns and the bot sizes
its LBOND/USDC bids down. **After a deployment switch** it also cancels the account's own offers in the previous
receipt (from `deployments/testnet.contract.v1.json`) and redeems that receipt at par on the previous vault, because the
faucet pays USDC only once per account (see Known limits): that USDC is the bot's capital.

| file | content |
| --- | --- |
| `deployments/testnet.bot.json` | public: bot addresses, roles, assets, setup tx hashes, simulated NAV state. Read it to label bot accounts in a UI |
| `deployments/testnet.bot.secrets.json` | `S...` keys of the three accounts, mode 0600. Covered by `deployments/.gitignore` (`*.secrets.json`); `bot:setup` runs `git check-ignore` and refuses to write the file if it is not ignored |
| `scripts/bot/logs/` | one log file per run (git-ignored) |

The bot imports from `scripts/lib/` and modifies nothing there or in `contracts/`. The only numbered script it touches
is `scripts/04-seed-book.mjs`, which gained the opt-in `--usdc-ladder` flag (default run unchanged).

## Live mode (`npm run bot:live`)

```sh
cd scripts
nohup npm run bot:live -- --console false >/dev/null 2>&1 &   # unattended
tail -f bot/logs/bot-live.log                                   # watch it
npm run bot:stop                                                # stop (waits for the cleanup)
```

`bot/live.mjs` is a small supervisor. It runs `bot/index.mjs` with the live preset (any bot option given after `--`
overrides it). It refuses to start a second instance (`bot/logs/bot-live.pid`). It restarts the bot after a crash
(15 s backoff, doubling, at most 10 restarts an hour), and never after a guard stop (exit code 3, e.g. XLM under
`--min-xlm`). On SIGTERM or Ctrl+C it forwards one SIGTERM, and the bot then cancels its own offers and closes its own
pool positions (`--cleanup true`). The bot log is `bot/logs/bot-live.log`, rotated at 20 MB with 5 files kept
(`--log-max-mb`, `--log-keep`). Restarts are logged in `bot/logs/bot-live-supervisor.log`. Horizon and RPC hiccups are
retried (5xx, network errors, 429 back-off; Soroban calls fail over to the backup RPC of `scripts/lib/rpc.mjs`). A
component that fails 5 times in a row pauses for 30 s; the other components keep running.

Preset: `--flow-mode live --ladder take --peg-noise-bps 1.5 --requote-bps 1.5 --level-size 60 --usdc-levels 4
--usdc-level-size 60 --peg-size 550 --liq true --pool-extra-ids lbond-usdc-defindex --pool-shift-bins 2 --max-tx-per-min 40 --max-ops-per-min 150 --http-per-min 140 --tri-interval-sec 20
--cross-interval-sec 10 --cleanup true`.

**LBOND fair value (`lib/nav.mjs`, `--nav-model tsy`, also the default of `npm run bot`).** The price is that of a
simulated 10-year Treasury:

* yield `y`: Ornstein-Uhlenbeck around the reference yield `y_ref`, daily volatility `--yield-vol-bp-day` 6.5 bp
  (real 10Y: about 5 to 8 bp a day), scaled to each time step by sqrt(dt). Mean reversion half-life
  `--yield-half-life-days` 30. Poisson jumps, `--yield-jumps-per-day` 3, each 0.5x to 1.5x `--yield-jump-bp` 3 bp,
  random sign.
* `price = nav - duration * (y - y_ref)`, with `--duration-yrs` 7. The NAV accrues carry at the simulated yield
  (`--carry-pct` to force a rate). A tiny OU micro noise of `--nav-noise-bps` 1 bp sits on top.
* The yield is reflected so the price stays in `[--price-min 0.96, --price-max 1.03]`, which keeps the demo ladders
  and pool ranges meaningful.
* Real time, no acceleration (`--time-scale` only speeds up the carry, and only the demo scenario uses it).
* `y_ref`: the latest FRED DGS10 value fetched at first start (no key needed), else `--yield-fallback` 4.2. The state
  (`nav`, `yield_pct`, `yield_ref_pct`, source) is saved every 30 s in `deployments/testnet.bot.json`, so a restart
  continues the same path. `--yield-refresh` refetches FRED and re-bases the NAV so the price does not jump.
  `--nav-model flat` restores the previous model.
* Order of magnitude: 7 x 6.5 bp, about 45 bps of price per day, about 30 bps over 10 hours; a jump moves it 10 to
  30 bps.

**Receipt price (lUSDCb/USDC): par, plus a few bps of noise, never a drift.** `lotus_vault` mints the receipt 1:1
against USDC and redeems it 1:1 while fully backed, and the vault's yield is paid out by minting more receipt to the
holders (keeper `distribute()`), not by raising the price of a receipt. A receipt is therefore always worth exactly
1 USDC. Above par anyone mints and sells; below par anyone buys and redeems, and the arbitrageur does exactly that at
2 bps (`--arb-threshold-bps`). So the receipt cannot drift above par the way a share-price token would. mm_a centres its
peg quotes on `1 + noise` (OU, `--peg-noise-bps` 1.5, at most `--peg-noise-max-bps` 3, half-life 180 s, in 0.5 bp
steps), 1 bp either side, and keeps its ask above `1 - threshold` and its bid below `1 + threshold`. Prints therefore
land between about 0.9996 and 1.0004, and the peg arbitrage only fires when somebody else offers the receipt off par.

**Consistency.** mm_a quotes LBOND/USDC around `fair` and LBOND/lUSDCb around `fair / peg_mid`, so
LBOND/lUSDCb = LBOND/USDC / lUSDCb/USDC by construction. The triangular check (round trip at about -15 bps after the
spreads) does not fire. mm_a re-centres its pool Ask/Bid positions when fair value has moved 2 bins (20 bps), and the
cross-venue arbitrage keeps the pool and the SDEX aligned in between. The arbitrageur's legs only use bot or team depth: if that depth is gone before the second leg, it keeps the LBOND (the rebalance hands it back to mm_b) instead of selling into anyone else's offers.

**Flow (`Flow.liveTick`, `--flow-mode live`).** Each SDEX market (LBOND/USDC, LBOND/lUSDCb, lUSDCb/USDC) has its own
arrival process: exponential gaps at 2 to 4 trades a minute (`--flow-live-rate-min/max`, re-drawn every 3 to 8 minutes),
and never more than `--flow-live-max-gap-sec` 40 s without a print. Every 1-minute candle therefore gets at least one
trade, and usually several, which gives it a body and wicks. Markets that fall due together go into one transaction
(mm_b lands at most one transaction per ledger). Sizes are log-normal: LBOND 1 to 40 (`--flow-bond-size-min/max`),
receipt 5 to 100 (`--flow-peg-size-min/max`). Direction starts at 50/50, tilted towards the fair-value move since that
market's last trade (`--flow-trend` 0.15), and towards keeping mm_b's own USDC and receipt near 350
(`--flow-inv-bias` 0.3). That restoring force is what lets it run for hours without one side running dry. About 10% of
LBOND/lUSDCb trades are routed USDC -> lUSDCb -> LBOND. Pool swaps: `--flow-pool-per-min` 0.3. Trades larger than a
level (60 LBOND) walk into the next one, 10 bps further.

**Every minute, every market.** On top of the random arrivals there is a hard guarantee: if a market has no trade
landed in the current UTC minute by second `--flow-force-at-sec` (35), mm_b sends a small forced trade there. It goes
in the direction of the fair-value drift and is retried every 3 s until one lands. Pool swaps are held back in that
window so they do not block mm_b's sequence number.

**Liquidity guard (`lib/guard.mjs`, `--liq true` in the preset).** Every 60 s it checks both sides of every book:

* LBOND/USDC and LBOND/lUSDCb: at least `--liq-bond-min` 200 LBOND within `--liq-band-pct` 1% of fair value.
* lUSDCb/USDC: at least `--liq-peg-min` 500 within `--liq-peg-band-bps` 10 bps of par.
* Each pool mm_a quotes (the idle pool, plus the vault-backed `lbond-usdc-defindex` through `--pool-extra-ids`): an
  Ask and a Bid position with inventory, whose first bin is within 1% of fair value.

Each check is one `liq check:` log line. When a side is short, mm_a's inventory is topped up first: LBOND issued by
`rwa_issuer`; USDC from the treasury `blocked_taker` only above its 3,000 floor (`--liq-treasury-keep`), else a Blend
faucet round through a fresh account (`--liq-topup-max` 8 per 24 h, counted from `testnet.bot.json`); lUSDCb minted
with `lotus_vault.deposit()`. Then the guard re-quotes at full size and re-posts the missing pool positions. Every
top-up is logged with its tx link. The preset sizes mm_a's quotes so the minimums hold with margin: 4 levels of
60 LBOND on each LBOND book, and 550 lUSDCb on each side of the peg.

**Inventory for 10+ hours.** Every 90 s, plain payments (no trade prints) move USDC, lUSDCb and LBOND between mm_a,
mm_b and arb when one of them runs low. The arbitrageur keeps `--arb-keep-usdc` 600 and hands the surplus back. If the
three accounts together hold less than `--topup-below-usdc` 900 USDC, the bot runs one Blend faucet round through a
fresh account (`lib/topup.mjs`: friendbot, faucet, forward 1,000 USDC). It does this at most `--topup-max` 3 times
per run, 10 minutes apart, and records each round in `testnet.bot.json` under `setup.topups`. The treasury
`blocked_taker` is never touched.

**Whose offers it trades against (`lib/owners.mjs`).** There are three kinds of offers. Own: mm_a and mm_b. Team: the
demo liquidity accounts `maker` and `peg_lp`. Others: everybody else, including app users. The bot never cancels or
modifies an offer it does not own. Its quotes are clamped on all three books so they never cross another account's
offers. Its takers (flow, triangular and cross-venue arbitrage) stop at the first book level holding liquidity they
cannot attribute to own or team offers. With `--ladder take` (live preset) the team's stale demo levels are the one
exception: they may be traded through like any participant would, for example mm_b buying maker's 1.00 LBOND/lUSDCb
ask, or a quote of mm_a's filling against it on posting. `node scripts/04-seed-book.mjs --reset` re-posts them. The
peg arbitrage is unchanged: it buys any receipt offered under par and redeems it, which is the peg mechanism itself.

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
**Simulated fair value**: the simulated 10-year Treasury described under "Live mode" (`--nav-model tsy`, the
default), or with `--nav-model flat` the previous model (NAV accruing at `--nav-apr`, OU noise). There is no oracle;
the bond is simulated. `--time-scale` accelerates the accrual only (the demo uses x5000; accelerated runs do not
persist their state).
Quotes never cross another account's offers: they are clamped against the book minus mm_a's own offers, and
operations in a re-quote transaction are ordered so a bid never sits above an ask. `mm_a` never cancels or
modifies an offer it does not own.

**`--ladder` (see also "Whose offers it trades against").** `take` now only concerns the team's demo accounts
(`maker`, `peg_lp`); app users' offers are clamped against and never taken, whatever the setting.
**`--ladder leave` (default).** The demo ladder (`maker`'s asks at 0.98 / 0.99 / 1.00 / 1.01 / 1.02) is left alone: mm_a's
bond bids are clamped just under the cheapest ask in the book (0.9799 while the 0.98 level exists, 0.9899 once it is
consumed) and mm_b only sells LBOND on the bond book. `--ladder take` quotes a normal +/- 5 bps book and lets the bot
trade against the stale demo asks like any participant: its first bids take the 0.98 and 0.99 levels (200 LBOND) and its
flow buys then eat the 1.00 level; `node scripts/04-seed-book.mjs --reset` re-posts them.

### LBOND/USDC book (`--usdc-book on`, the default)

The app offers four destinations at order creation; "SDEX quoted in USDC" needs a live LBOND/USDC book. mm_a quotes it
from the **same simulated fair value** as LBOND/receipt (1 receipt = 1 USDC at par): `--usdc-levels` (3) levels per side,
`--usdc-level-size` (30) LBOND each, `--half-spread-bps` / `--spacing-bps` shared with the receipt ladder. The same
re-quote rule (one transaction per tick, only drifted or consumed slots), the same ordering (a bid never sits above
an ask), and the same rule on other accounts' offers: quotes are clamped against the book minus mm_a's own offers
and nothing mm_a does not own is cancelled or modified. On this book the clamp applies **whatever `--ladder` says**:
app users rest orders here, `--ladder take` only concerns the stale demo ladder of LBOND/receipt.

* **USDC budget**: USDC funds the peg bid first (it defends the receipt peg), then the LBOND/USDC bids get what is left,
  after keeping `--pool-bid-size` x 1.1 aside while mm_a has no pool Bid position. When short, bid sizes are scaled
  down and levels under 1 LBOND are dropped (a warning says by how much, at most once a minute). Asks only need LBOND.
* **Flow**: about `--flow-usdc-weight` (35%) of mm_b's trades go to LBOND/USDC first (buy or sell LBOND, direct path
  payment, only against mm_a's top of book); otherwise the book is a fallback after the receipt books. Bursts send a
  third of their bond clips there.
* **Consistency (`arb`)**: every `--tri-interval-sec` (10 s), when the peg needs nothing, the arbitrageur prices round
  trips USDC -> LBOND -> USDC through LBOND/USDC one way and LBOND <-> receipt <-> USDC the other way, for 5 to 160 LBOND.
  A round trip clearing `--tri-min-edge-bps` (6) is sent as **one circular path payment from arb to itself**
  (`USDC -> [LBOND, receipt] -> USDC` or `USDC -> [receipt, LBOND] -> USDC`), with `destMin` = cost + half the expected
  edge: atomic, it lands or fails as a whole (0.00001 XLM). With `--ladder leave` it only counts offers of the bot's
  accounts. The run summary prints the number of checks and the best/worst round trip seen.
* **Cross-venue**: the pool arbitrage also treats the direct LBOND/USDC book as an SDEX venue and uses whichever SDEX
  leg (direct, or via the receipt) prices better.
* `--usdc-book off`: mm_a quotes nothing there and cancels its own LBOND/USDC offers on its next tick; flow and the
  triangular check skip the book.

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
does. `node scripts/04-seed-book.mjs --reset` re-posts the demo books afterwards (it cancels all of `peg_lp`'s and
`maker`'s offers first; add `--usdc-ladder` to also re-post maker's optional LBOND/USDC asks at 1.005 / 1.01 / 1.02,
50 LBOND each, priced outside mm_a's quotes so they never bind its clamps). Without `--usdc-ladder`, script 04
behaves exactly as before and ignores LBOND/USDC.

### Lotus pool legs (`pool-legs.mjs`, `lib/pool.mjs`), behind a feature flag

`--pool auto` (default) enables them when `deployments/testnet.pool.json` lists a live LBOND/USDC pool whose ABI
version, bin step, fee and `price_at` match what the adapter expects; otherwise the bot runs exactly as without the
pool. `--pool off` never uses it, `--pool on` makes a missing pool an error, `--pool-id lbond-usdc-defindex` selects
the instance whose USDC sits in DeFindex (default: the live `lbond-usdc-idle`, else the first live one).
**Only `status: "live"` entries are used**: an instance marked `retired` (an old contract replaced by a redeploy, even
under the same id) is never quoted or traded. At start the bot warns if one of its accounts still has positions in
a retired instance, and `--cleanup` closes those (own positions only) so the LBOND/USDC comes back.
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
  `--cleanup` cancels every open offer of mm_a and mm_b, so the LBOND/USDC quotes go too.
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
| `--scenario premium` | mint 150.4465 + sell into 1.004 bid: +0.6018 USDC, 9.4 s, 0.00227 XLM | not rerun |
| `cross-venue` (cheap pool Ask 80 bps off) | +0.3475 and +0.1634 USDC, gap closed T+31.8 s | +0.3475 and +0.1636 USDC, gap closed T+26.1 s |
| keeper step | n/a (no interest) | 0.0006671 lUSDCb minted to 6 holders; mm_a's 292 lUSDCb in open offers earned 0.0002123 |

Normal mode, 10 minutes each (default settings, no scenario):

| | v1 (`lUSDC`, SDEX only) | v2 (`lUSDCb`, SDEX + pool legs) |
| --- | --- | --- |
| duration / transactions | 604 s / 36 ok, 0 failed | 605 s / 40 ok, 0 failed |
| component error rate | 0% on 211 ticks | 0% on 339 ticks |
| flow trades / fills / volume | 28 / 28 / about 178 | 32 (13 on the pool) / 34 / about 178 |
| Horizon requests | 438 (44 per minute) | 496 (49 per minute) |
| Soroban RPC requests | about 0 | about 534 (pool quotes and cross-venue scans) |
| HTTP 429 incidents | 0 | 0 |
| XLM spent in fees | 0.00047 | 0.0202 (mostly pool swaps and position posts) |

Reading: **yes, redeeming at par restores the peg**, and it takes about one polling interval plus two ledgers
(roughly 10 s with 1.5 s polling in the scenarios; add up to the 5 s poll in normal mode). It works because the vault is
fully backed (`vault_value >= supply` in every run), the redemption is not rate limited and costs a few thousandths of
an XLM. Capacity is bounded by the arbitrageur's USDC (1,000), `--arb-max-notional` (250 per cycle) and the vault's
liquidity; larger sizes than 150 were not tested. The two legs are separate transactions, so a competitor could take the
cheap offers between detection and the buy; the buy then fails, and a failed classic transaction costs 0.00001 XLM
(observed: a failed quote update was ledgered with a 100-stroop fee).

### With the LBOND/USDC book (2026-10-26, v2 `lUSDCb`, default settings)

| | normal, 270 s + `--cleanup` | `bot:depeg` | normal, 210 s (new `lbond-usdc-idle` pool) |
| --- | --- | --- | --- |
| transactions | 24 ok, 0 failed | 6 ok, 0 failed | 19 ok, 0 failed |
| component error rate | 0% on 148 ticks | 0% on 9 ticks | 0% on 121 ticks |
| flow trades (on LBOND/USDC) | 16 (1) | n/a | 15 (3) |
| Horizon requests | 325 (68 per minute) | 47 | 276 (76 per minute) |
| HTTP 429 incidents | 0 | 0 | 0 |
| XLM spent in fees | 0.139 (pool positions) | 0.0037 | 0.117 |
| triangular checks | 23, best round trip -106.9 bps, 0 sent | 2 | 18, best -107.3 bps, 0 sent |

* mm_a's first re-quote added the 6 LBOND/USDC offers in the same transaction as the receipt books (10 operations).
  Example LBOND/USDC prints: mm_b sold 6.87 LBOND at 0.99966 (tx `21fcd0ee...`) and bought 2 LBOND at 1.00054
  (tx `45e39fa4...`), both against mm_a.
* `--cleanup` cancelled all 16 of mm_a's offers (8 LBOND/receipt, 6 LBOND/USDC, 2 peg) and closed its 2 pool positions.
* depeg: same result as before the change. 150 lUSDCb bought at 0.985 and redeemed at par, +2.25 USDC, peg restored
  at T+11.3 s. The shock eats mm_a's 100 USDC peg bid, so after it mm_a's LBOND/USDC bids were scaled to 49% (USDC
  budget warning); re-running `bot:setup` restored the 400 USDC from spare lUSDCb (142 redeemed, tx `8d9e6556...`).
* Triangular check: with `--ladder leave` and maker's 0.99 / 1.00 demo asks on top of LBOND/receipt, mm_a's receipt
  bids are clamped to 0.9899, so selling LBOND along the receipt route is about 1% worse than LBOND/USDC (-107 bps).
  Buying along the route cannot be priced on bot-owned depth because the demo asks are on top. Nothing to arbitrage.
  The circular transaction shape was checked once by hand: 1 USDC from `arb` to itself via [LBOND, lUSDCb], 3 fills
  all against mm_a, 0.9892666 USDC back (tx `eecd1ca8f333db1e175be6df0f83d09217677d116bc8a4863fab5ba0f3a855b3`).

### Live mode on testnet (2026-10-26)

Four supervised runs on testnet between 04:10 and 04:53 UTC (10 min, 10 min, 11 min ended by `npm run bot:stop`,
10 min with the guard and the forced trades). Horizon `/trade_aggregations`, 1-minute resolution:

| | LBOND/USDC | LBOND/lUSDCb | lUSDCb/USDC |
| --- | --- | --- | --- |
| last run (9 full minutes, 04:44 to 04:53) | 9/9 minutes, 27 trades (2 to 5 a minute) | 9/9, 26 trades (2 to 5) | 9/9, 24 trades (1 to 4) |
| candles with a body / a wick, last run | 7 / 7 of 9 | 7 / 8 | 7 / 7 |
| whole span, 04:10 to 04:53 | 41/43 minutes, 138 trades | 41/43, 103 trades | 41/43, 126 trades |
| price range | 0.99831 to 1.00258 | 0.99833 to 1.00241 | 0.99970 to 1.00050 |

The two empty minutes of the whole span are the restarts between runs. The single 1.0005 print on lUSDCb/USDC was
peg_lp's demo ask, taken before the par band filter was added. Last run: 126 transactions, 0 failed, 0 HTTP 429,
86 Horizon requests a minute, about 67 Soroban RPC requests a minute, 5 forced end-of-minute trades. Fees were
0.222 XLM in 10 minutes, mostly first-time pool positions in two pools and one deposit. Steady state is under about
1.3 XLM an hour: classic trades and re-quotes cost 0.00001 XLM per operation, pool swaps about 0.003 XLM, position
re-posts about 0.05 XLM. That is noise against the 10,000 XLM per account and the 200 XLM guard. Errors over all
runs: 4 failed re-quotes (`op_underfunded` x2 before the guard existed, `op_offer_not_found` x2 when a quote was
consumed between read and update; the next tick re-posts). The guard found the peg bid and all 4 pool sides short at
start and fixed them in 35 s: 1,000 USDC from the faucet through a fresh account (tx `14d70b2b...`), 432 lUSDCb
minted (tx `50676566...`), 4 positions posted. The treasury `blocked_taker` held 2,973 USDC, under its 3,000 floor,
so it was not used. The SIGTERM stop cancelled all of mm_a's offers and closed its pool positions.

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
* LBOND is a simulated bond: its price comes from the model above (a simulated 10Y yield that starts at a real FRED
  DGS10 print), not from any market.
* LBOND/USDC depth is bounded by mm_a's USDC (about 400 working capital, shared with the peg bid and the pool Bid).
  The faucet pays once per account, so `bot:setup` can only top it up from mm_a's spare receipt. After a depeg test,
  re-run `bot:setup` or let the bids run smaller.
* The triangular arbitrage has never fired inside a bot run (the books stayed consistent). Only its transaction shape
  was checked on-chain, by hand (see above).
* `04-seed-book.mjs --reset` re-posts `peg_lp`'s 200 USDC bid. On 2026-10-26 `peg_lp` held 150.09 USDC (its bid had
  been eaten by earlier depeg tests), so pass `--peg-size 150` or less, or the script stops after cancelling.
