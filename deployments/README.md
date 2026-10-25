# deployments/

State of the Lotus testnet deployments. Everything here is testnet only (Test SDF Network ; September 2015).

Two Lotus vault instances exist side by side. They share the same wasm
(`adfd2361a9751a5fd7d98fc25b1e21e8932f404f9e56d58f9b65084ead97354a`, `contracts/lotus_vault`) and differ in
the DeFindex vault they wrap:

| | v1 `usdc-defindex-idle` | v2 `usdc-defindex-blend` |
| --- | --- | --- |
| Lotus contract | `CA5JHSNNGRX3QLLNRLOTDCXYGAYVC3ZRHXX6IWXQAD6YLILZ7TL2AHG6` | `CCCZ6XUDCWTOKZS6AYNECY3QPOFBICGMBBZXM63U4WZQD4EBFYFW2QKG` |
| receipt (classic asset, SAC admin = the contract) | `lUSDC` / `GBBBCE5XIN3KPPNETITZF4ZEC6NG4MZZ3I2CYIQGGGY4GN4DJO73GDL6` | `lUSDCb` / `GC7QBZD2LMPZZ3BT4ZLKPYUR23GJKT47BLYJKMXUY523M7HMUGT64TVO` |
| receipt SAC | `CDQ7HJZGK5RGIHAPWVCE7KVJIDOCQFPJI7CIYLRVNF5RKM62OJXL2HAV` | `CC6YDSEJRF7QH5JL7MVEYEIU3CTMNEHS4XIK5R36DYA5EVUYIP4PAHPG` |
| DeFindex vault | `CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN` (PaltaLabs, we do not control it) | `CDCIDX5FXOENXW4ODR2D7QMRKL4F2NTZYFVZEFF63GTNRVVDXLCQ7EEC` ("Lotus USDC Blend", `LUSDCB`, ours) |
| Blend strategy | `CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY` registered, **allocation 0** | the same strategy, **allocation > 0** (seeded) |
| Blend pool | `CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF` | same |
| yield | none (deposits stay idle in the vault) | real Blend supply interest, see "Observed yield" |

## Files

| file | what | tracked by git |
| --- | --- | --- |
| `testnet.contract.json` | the ACTIVE deployment: what `scripts/*.mjs` and (as fallback) the web app read. Was v1 when these notes were written (`switch-strategy.sh status` tells). Written by the contract workflow, swapped by `switch-strategy.sh` | yes |
| `testnet.contract.v1.json` | frozen copy of the v1 deployment (byte-identical to `testnet.contract.json` as it was on 2026-10-25) | yes |
| `testnet.contract.v2.json` | v2 deployment: same shape as v1 plus `defindex_vault_manager`, `defindex_fee_receiver`, `strategy_id`, fees, tx hashes, measured costs and `observed_apr` | yes |
| `testnet.strategies.json` | the list the strategy picker reads: one entry per Lotus instance (`id`, `label`, `status` live/idle/coming-soon, contract, assets, vault, strategy, pool, notes). Entry ids: `usdc-defindex-idle` (v1), `usdc-defindex-blend` (v2), `xlm-defindex-blend` (announced) | yes |
| `testnet.strategies.secrets.json` | `S...` keys of v2 (`.v2`: vault manager, fee receiver, admin, keeper, issuer, two holders) and, after the first switch, a stash of the v1 admin/keeper/issuer keys (`.v1`) | **no** (`*.secrets.json` is gitignored) |
| `switch-strategy.sh` | `status` / `v1` / `v2` helper, see below | yes |
| `testnet.secrets.json`, `testnet.classic.json`, `testnet.classic.secrets.json` | state of the demo scripts (keys of v1 admin/keeper/issuer, RWA asset, maker/taker accounts, offers). Not touched by the v2 work | secrets no, classic.json yes |
| `testnet.bot.json`, `testnet.bot.secrets.json`, `testnet.pool.json` | written by the bot and pool workflows (not described here) | n/a |

`testnet.strategies.json` is read at request time by the web app (`web/lib/config.ts`); the scripts never read it.

## Pointing the existing scripts at v2

The scripts read exactly one contract file, `deployments/testnet.contract.json`, and look up the `admin`,
`keeper` and `issuer` secrets in `deployments/testnet.secrets.json`. Switching is therefore a file swap plus
those three keys. `switch-strategy.sh` does both, with backups:

```sh
deployments/switch-strategy.sh status      # which deployment is active
deployments/switch-strategy.sh v2          # activate v2
deployments/switch-strategy.sh v1          # go back to v1
deployments/switch-strategy.sh v2 --no-secrets   # swap the contract file only
```

What it does, step by step (so you can do it by hand):

```sh
cd deployments
cp -p testnet.contract.json testnet.contract.backup-$(date -u +%Y%m%dT%H%M%SZ).tmp     # git-ignored (*.tmp)
cp testnet.contract.v2.json testnet.contract.json
cp -p testnet.secrets.json testnet.secrets.backup-$(date -u +%Y%m%dT%H%M%SZ).secrets.json   # git-ignored
# only admin, keeper and issuer are replaced; maker/taker/peg_lp/rwa_issuer/blocked_taker stay
jq --slurpfile v testnet.strategies.secrets.json '. + ($v[0].v2 | {admin, keeper, issuer})' testnet.secrets.json > testnet.secrets.json.new.tmp \
  && mv testnet.secrets.json.new.tmp testnet.secrets.json
```

The first time you leave v1 the script copies the current v1 `admin/keeper/issuer` into
`testnet.strategies.secrets.json` (`.v1`) so `switch-strategy.sh v1` can restore them. Set
`LOTUS_DEPLOY_DIR=/some/dir` to run it on a copy (same override as `scripts/lib/config.mjs`).

After `switch-strategy.sh v2`, the demo accounts of `testnet.classic.json` still hold `lUSDC` and have offers
denominated in `lUSDC`. Re-run the receipt-dependent steps for `lUSDCb`:

```sh
cd scripts
node 00-wait-for-contract.mjs         # prints supply()/vault_value()/surplus() of v2, checks the receipt SAC admin
node 03-mint-receipt.mjs              # trustlines to lUSDCb, deposit(maker), deposit(peg_lp) into v2
node 04-seed-book.mjs --reset         # cancels the old lUSDC offers of peg_lp and maker, posts books in lUSDCb
node 05-demo-take.mjs
node 06-keeper-distribute.mjs         # distributes REAL interest; 07-simulate-yield.mjs is not needed
```

Checked: `06-keeper-distribute.mjs` ran unchanged against v2 (via `LOTUS_DEPLOY_DIR` with a copy of
`testnet.contract.v2.json` as `testnet.contract.json` and the v2 keeper key), see "Verification log" below.
`03`, `04` and `05` were not run against v2 (they own the demo accounts and offers of v1); they only use
`contract.receipt`, `contract.underlying`, `lotus_vault_contract` and the secrets described above, all of which
v2 provides.

Side-by-side rehearsal without touching the active files:
`LOTUS_DEPLOY_DIR=/tmp/lotus-v2 ...` with `testnet.contract.json` = v2 and a `testnet.secrets.json` holding the v2 keeper.

## How v2 gets yield (and why v1 does not)

```
holder --deposit(USDC)--> lotus_vault v2 --deposit([amt],[0],lotus,invest=true)--> DeFindex vault (ours)
                          mints lUSDCb 1:1                                           |  invests proportionally to the
                                                                                     v  EXISTING strategy allocation
                                                             Blend USDC strategy --> Blend pool (supply side)
```

DeFindex `deposit(..., invest=true)` only invests proportionally to the vault's existing strategy allocation
and skips any asset whose `invested_amount` is 0 (`generate_investment_allocations` in `paltalabs/defindex`).
A vault nobody ever seeded therefore stays idle forever, and seeding needs a `rebalance` (`Invest`
instruction) signed by the vault's rebalance manager. On the PaltaLabs vault that is a PaltaLabs key, so v1
cannot be fixed from our side. v2 is our own vault, created through the DeFindex factory
(`CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32`) with our keys as manager, rebalance manager,
emergency manager and fee receiver, and seeded once with 1000 USDC (`deposit(invest=false)` then
`rebalance([Invest(strategy, amount)])`). Since then every `deposit(invest=true)`, including the ones Lotus
issues, goes straight into Blend.

Vault parameters: created with `vault_fee = 100` bps (1% of the *gains*, never of principal; the PaltaLabs vault
uses the same value), **now set to 0** (see "DeFindex vault fees" below for why). DeFindex protocol share of any
locked fee `2000` bps (20% to the DeFindex receiver, 80% to our fee receiver; set by the factory),
`upgradable = false`, Soroswap router `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` (same as the
PaltaLabs vault). The manager changes the fee with `lock_fees(Some(bps))` (`get_fees` returns
`[vault_fee_bps, defindex_protocol_bps]`, currently `[0, 2000]`).

## Operating v2

Keys (names are also stellar CLI identities on the machine that deployed): `lotus2-df-manager` (manager =
rebalance = emergency manager of the DeFindex vault), `lotus2-df-fees`, `lotus2-admin`, `lotus2-keeper`,
`lotus2-issuer`, `lotus2-holder`, `lotus2-holder2`. Secrets: `testnet.strategies.secrets.json`.

```sh
# views are simulations: ALWAYS --send=no (vault_value()/surplus() carry a 1-entry write footprint
# because DeFindex updates its fee report inside get_asset_amounts_per_shares, so the default
# `--send=default` would SUBMIT them as transactions)
stellar contract invoke --id CCCZ6XUDCWTOKZS6AYNECY3QPOFBICGMBBZXM63U4WZQD4EBFYFW2QKG --network testnet --source-account lotus2-keeper --send=no -- surplus

# Blend testnet USDC for a new holder (1000 USDC + BLND/wETH/wBTC), see testnet.contract.json notes / scripts/lib/blend-faucet.mjs
# trustline: stellar tx new change-trust --source-account <holder> --network testnet --line lUSDCb:GC7QBZD2LMPZZ3BT4ZLKPYUR23GJKT47BLYJKMXUY523M7HMUGT64TVO

# deposit / redeem / distribute
stellar contract invoke --id CCCZ6XUD... --network testnet --source-account <holder> -- deposit --from <holder G> --amount 1000000000   # 100 USDC
stellar contract invoke --id CCCZ6XUD... --network testnet --source-account <holder> -- redeem  --from <holder G> --amount 500000000
node scripts/06-keeper-distribute.mjs        # with v2 active (or LOTUS_DEPLOY_DIR), signs with the v2 keeper

# re-seed / rebalance the DeFindex vault (rebalance manager only)
stellar contract invoke --id CDCIDX5F... --network testnet --source-account lotus2-df-manager -- rebalance \
  --caller <manager G> --instructions '[{"Invest":["CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY","<stroops>"]}]'
# collect the locked vault fees (fee receiver or manager)
stellar contract invoke --id CDCIDX5F... --network testnet --source-account lotus2-df-fees -- distribute_fees --caller <fee receiver G>
```

Run the keeper on v2 without switching the active files (what was done for the verification):

```sh
D=/tmp/lotus-v2 && mkdir -p $D && chmod 700 $D
cp deployments/testnet.contract.v2.json $D/testnet.contract.json
jq '.v2 | {admin, keeper, issuer}' deployments/testnet.strategies.secrets.json > $D/testnet.secrets.json && chmod 600 $D/testnet.secrets.json
echo '{"network":"testnet","accounts":{"maker":"<any funded G account>"},"tx":{}}' > $D/testnet.classic.json   # 06 prints this account's before/after
LOTUS_DEPLOY_DIR=$D node scripts/06-keeper-distribute.mjs --loop 300
```

Other contracts can use the same vault (`CDCIDX5F...`, `LUSDCB` shares, asset = Blend USDC) as a yield leg, for
example the pool's USDC leg (`testnet.pool.json` `vault` + `strategy_id: "usdc-defindex-blend"`). A contract
depositing must do what Lotus does: `authorize_as_current_contract` for the nested `transfer(contract -> vault, amount)`
and call `deposit([amount], [0], contract, true)`.

## Observed yield (2026-10-25, ledgers 5387707 to 5388112)

Full detail, method and caveats: `testnet.contract.v2.json` > `observed_apr`.

| window | vault fee | ledger time | Blend supply APR (gross) | Lotus net APR | net / gross |
| --- | --- | --- | --- | --- | --- |
| A, 21:02:02 to 21:18:32 UTC | 1% of gains (100 bps) | 990 s | **6.914%** | **6.849%** | 0.9906 (expected 0.9900) |
| B, 21:20:02 to 21:35:02 UTC | 0 | 900 s | **6.914%** | **6.910%** | 0.9994 (expected 1.0000) |

- Gross = growth of the Blend pool's `b_rate` (`get_reserve(USDC).data.b_rate`, 1e12 scale) between two reads,
  annualized: `(b1/b0 - 1) * 31_536_000 / (t1 - t0)`, `t = data.last_time`. Net = growth of Lotus' price per
  DeFindex share, `vault_value() / df_shares`, which deposits, redeems and `distribute` do not move. 46 samples,
  one every 45 s (9 ledgers), all reads on the same ledger. During the sampling there were 2 deposits, 2 redeems
  and 2 `distribute` calls of ours, plus a 1 USDC deposit and redeem by another agent's account on v2
  (txs `0e1e9dec...` / `c3e35b2b...`), which left 1 stroop of idle USDC in the contract and does not affect the price.
- It matches Blend's own rate model: utilization 88.7% (target 70%), `ir_mod` 0.8245 -> borrow 8.67% -> supply
  `8.67% * 0.887 * 0.9 = 6.93%`; first 45 s interval measured 6.937%.
- Noise: one stroop of `vault_value()` is 0.0064% APR on window A and 0.0023% on window B; the gaps to the
  fee-adjusted expectation are 0.6 stroop (A) and 1.8 stroops (B). Interval-to-interval spread of the gross rate: 6.906% to 6.938%.
- This is a snapshot of a shared testnet pool, not a forecast: the rate follows other users' borrowing (about 1.6%
  at 70% utilization; withdrawals are limited by the pool's free liquidity, about 16,000 USDC then, and the strategy
  holds about 68,000 USDC of which 1,150 are ours). BLND emissions are not included (the strategy's keeper is
  PaltaLabs'). 100 USDC earns about 0.019 USDC per day, so the interesting part is the live accrual and the on-chain
  surplus -> distribute loop, not the size.
- Reading the live rate from chain (no Lotus call needed): simulate `get_reserve` on the pool
  (`CCEBVDYM...`, arg = USDC SAC) twice, 60 s apart, and apply the formula above. `vault_value()` also moves every
  ledger, no pool interaction is needed (Blend's `get_reserve` accrues to the current ledger).

## DeFindex vault fees and Lotus' `vault_value()`

Question: does `get_asset_amounts_per_shares` (what `vault_value()` uses) include or net the vault fee?
Answer, from the source and verified on-chain: it **nets** it. The call re-runs the vault's fee report, so the
value excludes (a) the fee already locked and (b) the fee on the gains accrued since the last report. Check on all
46 samples (23 with fee 100 bps, then fee 0), e.g. gross strategy balance `11000008478`, locked fee `47`,
pending gain `3629` -> pending fee `36`, net total `11000008395`: Lotus' reported `vault_value()` equalled
`floor(net_total * lotus_shares / df_supply) + idle` with a difference of **0 stroops on every sample** (idle = the
contract's own USDC, 1 stroop of dust). `fetch_total_managed_funds` (the public view) only subtracts the locked
part, so it reads `11000008431`, a few stroops higher.

Consequences for Lotus:

- `surplus()`, `distribute` and `redeem` stay consistent: they all use the net value, and holders see the
  yield after fees (6.849% vs 6.914% gross at 1%).
- No misbehaviour of `redeem` or `distribute` was found, no contract change was needed (`contracts/` code untouched,
  12/12 tests pass).
- **Operational hazard (found, fixed on v2):** `rebalance`, `rescue` and `distribute_fees` pay the locked fee out
  first, 20% of it to the factory's protocol receiver `GDOFDSMFRPOYTOLWODK4O6BZTGDJ4GRHLHX5THXN4TIFE2SXASQYFLPJ`.
  That account has **no USDC trustline** on testnet, so as soon as a locked fee exists these calls revert
  ("trustline entry is missing for account", `transfer(vault, GDOFDS..., 58)`). Reproduced on the live vault
  with `Unwind`, `rescue` and `distribute_fees`; `pause_strategy`, `deposit` and `withdraw` are unaffected, so Lotus
  keeps working. The seed `Invest` worked only because it ran before any fee was locked. Fix applied by the manager:
  `lock_fees(Some(0))` (tx `2280d2e4...`) then `release_fees(strategy, 291)` (tx `bdd32307...`); `Unwind`, `rescue`
  and `distribute_fees` simulate fine afterwards. The same trap applies to any vault created from this factory with a
  non-zero fee; it also means the vault fee currently cannot be paid out on testnet. To charge a fee again, the
  protocol receiver needs a USDC trustline (not ours to add) or the factory receiver must change; until then keep
  `vault_fee = 0`.

## Costs measured (testnet, fee charged, CPU = executed instructions, limit 400M)

Every Blend-touching call cost between 0.0015 and 0.14 XLM, not the 90 to 100 XLM quoted in `scripts/README.md`
and `testnet.contract.v1.json` (not reproduced; most of the larger numbers here are rent for newly created ledger
entries). All v2 keys together spent under 0.5 XLM.

| op | tx | fee (XLM) | CPU |
| --- | --- | --- | --- |
| factory `create_defindex_vault` | `7568e866...` | 0.0366 | 2.9M |
| vault `deposit` 1000 USDC, `invest=false` (first deposit) | `51875aa8...` | 0.1433 | 2.3M |
| vault `rebalance` `Invest` 1000 USDC | `c72d8224...` | 0.0037 | 5.1M |
| receipt SAC deploy / Lotus v2 deploy / `set_admin` | `63b3dd47...` / `b415ea95...` / `8f6dece6...` | 0.0052 / 0.0209 / 0.0004 | 0.1M / 0.9M / 0.2M |
| vault `deposit` 10 USDC `invest=true` (direct) / `withdraw` | `c20896d8...` / `05c1232e...` | 0.0505 / 0.0025 | 7.1M / 6.6M |
| Lotus `deposit` 100 USDC (first deposit of the account) | `8c3584f3...` | 0.0373 | 8.1M |
| Lotus `deposit` 50 USDC / 100 USDC | `1da1629a...` / `071b6f19...` | 0.0037 / 0.0037 | 8.1M |
| Lotus `distribute`, 2 recipients (real surplus) | `95716ece...`, `56e2b761...` | 0.0015 | 4.7M |
| Lotus `redeem` 50 lUSDCb / full exit | `c21698aa...` / `7ec13f1f...` | 0.0034 / 0.0034 | 14.1M / 14.0M |
| `lock_fees(0)` / `release_fees` | `2280d2e4...` / `bdd32307...` | 0.0004 / 0.0004 | 1.1M / 1.0M |

Views: `vault_value()` and `surplus()` simulate at about 4.4M instructions (vault -> strategy -> Blend pool).

## Verification log (all on testnet, 2026-10-25)

1. Factory call created the vault: assets = Blend USDC SAC + strategy `CALLOM5I...`, `get_fees` = `[100, 2000]`,
   roles as above, name `DeFindex-Vault-Lotus USDC Blend`, symbol `LUSDCB`, not upgradable.
2. Seed: `deposit(1000 USDC, invest=false)` then `rebalance([Invest(strategy, 1000 USDC)])`:
   `fetch_total_managed_funds` -> `idle 0`, `invested_amount 10000000109`, strategy allocation `10000000109`.
3. **Subsequent `deposit(invest=true)` auto-invests**, both directly on the vault (10 USDC: returned allocation
   `[{strategy, 100000000}]`, idle stays 0, invested +10 USDC) and through Lotus (100, 50 and 100 USDC).
4. Lotus v2 deployed with the installed wasm (no re-upload), receipt SAC `set_admin` -> contract (`admin` returns
   the contract id), `get_config` correct.
5. `deposit` 100 USDC: 100 lUSDCb minted 1:1, vault `invested_amount` +100 USDC, `vault_value()` 1 stroop below
   `supply()` (known DeFindex share rounding; with live yield the gap closes within seconds: 100 USDC accrues about 11 stroops per ledger).
6. Accrual: `surplus()` grew by about 98 stroops per 45 s on 100 USDC (see "Observed yield").
7. `distribute` (unchanged `scripts/06-keeper-distribute.mjs`, v2 keeper): surplus `0.0002715` USDC minted
   pro-rata to two holders (66.7% / 33.3%), then `0.0003243` after the fee change.
8. `redeem` 50 lUSDCb paid exactly 50.0000000 USDC through the Blend withdraw; the second holder's full exit
   (50.0000905 lUSDCb) paid 50.0000905 USDC. Dust-size redeems (1 to 1000 stroops) simulate fine; a 1-stroop
   deposit reverts with DeFindex `#117` (0 shares), 2 stroops and up work.
9. State at 21:35:56 UTC when our measurements stopped: Lotus v2 `supply 150.0005053`, `vault_value 150.0005103`,
   `surplus 0.0000050`; DeFindex vault `1150.0055796 USDC` invested, idle 0, locked fee 0. The DeFindex vault is
   shared: at 21:39 another agent had added 320 USDC to it (not through Lotus), which does not change Lotus'
   accounting (it tracks its own DeFindex shares).

## Decisions for the owner

- Which deployment is the default for the demo. v2 is the only one with real interest; v1 stays as the "idle"
  comparison and is untouched (the demo scripts, and the bot setup in `testnet.bot.json`, are on it). `switch-strategy.sh v2` is reversible.
- Vault fee: it is 0 on v2 (see the trustline hazard). Do not raise it on testnet unless the DeFindex protocol
  receiver gets a USDC trustline.
- Whether to top up the seed or the demo balances: a 1000 USDC faucet call funds an account, and the seed itself
  (1000 USDC of the manager) is only there to create the allocation; it can stay.
- The receipt issuer `lotus2-issuer` is not locked (same as v1): it could still issue `lUSDCb` with a classic
  payment. Setting its master weight to 0 removes that path but also the ability to hand the SAC to a redeployed
  Lotus contract, so do it only once v2 is final.
- The owner of the `lotus2-*` keys is this machine's stellar CLI and `testnet.strategies.secrets.json`; back up
  that file if v2 is meant to outlive the hackathon.
