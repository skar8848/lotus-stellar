# Lotus testnet demo scripts

End-to-end demo of **Lotus**, a yield-bearing receipt token for Stellar's native orderbook (SDEX),
on testnet. Everything here is plain Node (`@stellar/stellar-sdk` v17); the Soroban contract lives
in `contracts/lotus_vault` and is deployed by the contract workflow, which writes
`deployments/testnet.contract.json`.

The story the scripts tell, in order:

1. a regulated RWA (`LBOND`, a simulated tokenized T-bill) is issued with Stellar's compliance flags;
2. users deposit the underlying (USDC or XLM) into `lotus_vault` and receive the receipt 1:1; the
   underlying is lent on Blend through a DeFindex vault;
3. the receipt is quoted on the SDEX like any asset: a peg book `underlying/receipt` at 1:1 and a
   maker ladder `LBOND/receipt`;
4. a buyer holding only the underlying buys the bond in ONE path payment through the receipt;
   an account the issuer never whitelisted is rejected by the protocol;
5. a keeper mints the accrued yield to every holder pro-rata, including receipt that is locked in
   open offers: quoted inventory earns yield because SDEX offers never leave the account.

## Setup

```sh
cd scripts && npm install
```

Node 20+ (tested on Node 25). Network endpoints default to testnet
(Horizon `https://horizon-testnet.stellar.org`, RPC `https://soroban-testnet.stellar.org`) and are
overridden by `deployments/testnet.contract.json` when present.

Files (all under `deployments/`):

| file | written by | content |
| --- | --- | --- |
| `testnet.contract.json` | contract workflow | `lotus_vault_contract`, `underlying`, `receipt` (code/issuer/SAC), `defindex_vault`, `accounts.{admin,keeper,issuer}` |
| `testnet.classic.json` | these scripts | demo accounts, `LBOND` asset, offer ids, tx hashes of every step |
| `testnet.secrets.json` | both | `S...` keys (`admin`, `keeper`, `issuer` + `rwa_issuer`, `maker`, `taker`, `peg_lp`, `blocked_taker`). **Gitignored.** |
| `testnet.classic.secrets.json` | these scripts | backup of the keys created here. **Gitignored.** |

Every script is idempotent: re-running skips what is already in place. Set `LOTUS_DEPLOY_DIR=/some/dir`
to rehearse on a separate set of accounts without touching `deployments/`.

## Run order

| # | script | needs contract | what it proves |
| --- | --- | --- | --- |
| 00 | `node 00-wait-for-contract.mjs` | waits for it | polls for `testnet.contract.json` (every 2 min, up to 2 h), prints the contract methods, checks the receipt SAC admin is `lotus_vault`, prints `supply()/vault_value()/surplus()` |
| 01 | `node 01-setup-accounts.mjs` | no | creates and friendbot-funds `rwa_issuer`, `maker`, `taker`, `peg_lp` (10,000 XLM each) |
| 02 | `node 02-issue-rwa.mjs` | no | issues `LBOND` with `AUTH_REQUIRED \| AUTH_REVOCABLE \| AUTH_CLAWBACK_ENABLED` and `home_domain lotus.fi`; authorizes `maker` and `taker` (SetTrustLineFlags); creates `blocked_taker` with a trustline that is NOT authorized; mints 1,000,000 LBOND to the maker |
| 03 | `node 03-mint-receipt.mjs [--maker 100] [--peg 500] [--force]` | yes | if the underlying is Blend testnet USDC, funds `maker`, `peg_lp`, `taker`, `blocked_taker` from the Blend faucet (1,000 USDC each, issuer-signed tx co-signed by the account); trustlines to the receipt; `deposit(from, amount)` for `maker` (100) and `peg_lp` (500). `taker` gets a trustline only: it holds only the underlying. Stops with a clear message if the underlying cannot be obtained |
| 04 | `node 04-seed-book.mjs [--reset] [--peg-size 200] [--level-size 100] [--levels 0.98,0.99,1.00,1.01,1.02]` | yes | `peg_lp` posts the two-sided `underlying/receipt` book (bid 0.9995 / ask 1.0005: same-account offers must not cross); `maker` posts the 5-rung `LBOND -> receipt` ladder in ONE transaction; prints both order books from Horizon `/order_book` |
| 05 | `node 05-demo-take.mjs [--amount 150] [--skip-blocked]` | yes | `taker` does `pathPaymentStrictSend` underlying -> receipt -> LBOND (path = `[receipt]`), prints every fill parsed from the result XDR, then shows `blocked_taker` failing with `op_not_authorized` (a DEX path AND a direct payment) |
| 06 | `node 06-keeper-distribute.mjs [--loop 60] [--dry-run] [--min 0.0000001]` | yes | reads `surplus()`/`supply()`, lists holders via Horizon `/accounts?asset=CODE:ISSUER` (paginated; balances include open-offer liabilities, re-read from RPC ledger entries), computes `floor(surplus * balance_i / supply)` exactly like the contract's on-chain cap, chunks 20 recipients per call, calls `distribute()` signed by `keeper`; prints the maker's balance before/after next to its open offers |
| 07 | `node 07-simulate-yield.mjs [--amount 5] [--from keeper]` | yes | demo lever when Blend testnet yield is ~0: SAC `transfer` of underlying to the contract address. `vault_value()` counts idle underlying held by the contract, so `surplus()` rises by the donated amount and 06 can distribute it |

One-liner once the contract json exists:

```sh
cd scripts
node 00-wait-for-contract.mjs && node 03-mint-receipt.mjs && node 04-seed-book.mjs && \
node 05-demo-take.mjs && node 06-keeper-distribute.mjs
# if 06 reports surplus 0:
node 07-simulate-yield.mjs --amount 5 && node 06-keeper-distribute.mjs
```

## Why the pro-rata math has to be exact

`distribute(recipients, amounts)` panics with `ExceedsCap` if any line is above
`surplus * receipt.balance(holder) / supply` (integer division) and with `InsufficientSurplus` if the
sum exceeds `surplus`. The keeper therefore:

- uses the same `floor(surplus * balance / supply)` with BigInt stroops;
- reads each balance from RPC (`getLedgerEntries` on the trustline) so it matches what the contract
  sees, falling back to Horizon;
- drops zero lines, so the dust stays in the vault;
- recomputes caps for every chunk after the first (the previous call shrank `surplus` and grew `supply`).

The holder list is the only off-chain input; a wrong list can only omit someone, never over-pay.

## Links to show judges

Live testnet run of 2026-10-25 (every hash is also in `deployments/testnet.classic.json`):

| what | link |
| --- | --- |
| `lotus_vault` contract | https://stellar.expert/explorer/testnet/contract/CA5JHSNNGRX3QLLNRLOTDCXYGAYVC3ZRHXX6IWXQAD6YLILZ7TL2AHG6 |
| receipt `lUSDC` (classic asset, SAC admin = the contract) | https://stellar.expert/explorer/testnet/asset/lUSDC-GBBBCE5XIN3KPPNETITZF4ZEC6NG4MZZ3I2CYIQGGGY4GN4DJO73GDL6 |
| receipt holders, balances include open offers (Horizon) | https://horizon-testnet.stellar.org/accounts?asset=lUSDC%3AGBBBCE5XIN3KPPNETITZF4ZEC6NG4MZZ3I2CYIQGGGY4GN4DJO73GDL6&limit=200 |
| LBOND asset (flags, holders) | https://stellar.expert/explorer/testnet/asset/LBOND-GCMNI332OEZL2AVBKJVDZ2IPREWMEYRENGFFVEGXS4JVXUWJEIAT5EQF |
| LBOND issuer (`auth_required`, `auth_revocable`, `auth_clawback_enabled`, `home_domain lotus.fi`) | https://stellar.expert/explorer/testnet/account/GCMNI332OEZL2AVBKJVDZ2IPREWMEYRENGFFVEGXS4JVXUWJEIAT5EQF |
| 02: issuer flags tx | https://stellar.expert/explorer/testnet/tx/fb45b34f0deb40af94387f9e28366cf35b50c8a2f99275e670cd081e00e15145 |
| 03: `deposit(maker, 100 USDC)` | https://stellar.expert/explorer/testnet/tx/2679a8b720b5329459eea54137c55750c361319fbc081b495ba9784f480635f3 |
| 03: `deposit(peg_lp, 500 USDC)` | https://stellar.expert/explorer/testnet/tx/a8f722eb2e2c321eb0f0faa5f50e6360cbf152eb5893e2c3b31593a68aa03de6 |
| 04: peg book (2 offers, one tx) | https://stellar.expert/explorer/testnet/tx/1a0f6912ef7d535599d17ea85fa24a39cc0649f4904483b626a38a0ea665a241 |
| 04: bond ladder (5 offers, one tx) | https://stellar.expert/explorer/testnet/tx/96fbbecd3f94b760148c94a0d9efa8527494ca5d1a20d079dac496f1e7bbaafb |
| order book lUSDC/USDC (peg) | https://horizon-testnet.stellar.org/order_book?selling_asset_type=credit_alphanum12&selling_asset_code=lUSDC&selling_asset_issuer=GBBBCE5XIN3KPPNETITZF4ZEC6NG4MZZ3I2CYIQGGGY4GN4DJO73GDL6&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56 |
| order book LBOND/lUSDC (ladder) | https://horizon-testnet.stellar.org/order_book?selling_asset_type=credit_alphanum12&selling_asset_code=LBOND&selling_asset_issuer=GCMNI332OEZL2AVBKJVDZ2IPREWMEYRENGFFVEGXS4JVXUWJEIAT5EQF&buying_asset_type=credit_alphanum12&buying_asset_code=lUSDC&buying_asset_issuer=GBBBCE5XIN3KPPNETITZF4ZEC6NG4MZZ3I2CYIQGGGY4GN4DJO73GDL6 |
| 05: path payment 150 USDC -> lUSDC -> LBOND, 3 fills, 152.4495327 LBOND delivered | https://stellar.expert/explorer/testnet/tx/6bf2153be4a4ad5e8779accb7f0b7b843e53218cb3be07a4f975f033135660a7 |
| 07: 5 USDC donated to the contract (simulated yield) | https://stellar.expert/explorer/testnet/tx/ffad300f9226b9af6cacca4294f394a998060351d337bf136a9a113682550749 |
| 06: `distribute()` to 3 holders, 4.9999997 lUSDC minted | https://stellar.expert/explorer/testnet/tx/7842f608fa817854c3712a8f8e48f9f7a87940ea0e50b8d59c04a0de4f25f64a |
| maker (ladder stays open, lUSDC balance grew 249.9250374 -> 251.8445844) | https://stellar.expert/explorer/testnet/account/GCJUR67CI37SF5QD3AYRVARR3SVFTINQHBSFGICSZEHXDZV2BZEQ46RV |
| maker's open offers (Horizon) | https://horizon-testnet.stellar.org/accounts/GCJUR67CI37SF5QD3AYRVARR3SVFTINQHBSFGICSZEHXDZV2BZEQ46RV/offers |
| peg_lp (50 lUSDC locked in its ask still earned yield) | https://stellar.expert/explorer/testnet/account/GANIQO23R5TLEYAGHCARVGXSLFI4ET27R4TCIOHC7MDQAWZB3LDRCMBH |
| taker (holds USDC and LBOND, never held lUSDC) | https://stellar.expert/explorer/testnet/account/GAEC3F4ZKGYV4QPTBKN2TTRNQ5SEUAZRNE7AXFQPB4UWMWC4JYW36SI7 |
| blocked_taker (`is_authorized: false` on its LBOND trustline; both attempts rejected with `op_not_authorized`) | https://stellar.expert/explorer/testnet/account/GCNPUYYI4MGJJ2MTEXYDEFQR5QG5B2L5DSMWCABL24NEOB2IQMNC7R5V |

The failed compliance attempts are not on-chain (Horizon rejects a `tx_failed` transaction at
submission, so nothing is ledgered); 05 prints the result codes live, which is the point.

Scripts 03 to 07 print all of these links as they run. The patterns:

- transaction: `https://stellar.expert/explorer/testnet/tx/<hash>`
- contract: `https://stellar.expert/explorer/testnet/contract/<C...>`
- order book: `https://horizon-testnet.stellar.org/order_book?selling_asset_type=...&buying_asset_type=...`
  (04 prints the exact URL for both books)

## Notes and gotchas

- **Fees.** Soroban calls that touch Blend/DeFindex cost ~90-100 XLM on testnet. The invoke helper
  simulates, then bumps the resource fee by 25% (the refundable part comes back) and uses a 0.01 XLM
  inclusion fee. Keep >= 2,000 XLM on `maker`, `peg_lp` and `keeper`.
- **USDC underlying.** `testnet.contract.json` points at Blend testnet USDC
  (`USDC:GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56`); friendbot only gives XLM. 03 and 07
  top accounts up from the Blend faucet (`lib/blend-faucet.mjs`: GET
  `https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets?userId=G...` with
  `Origin: https://testnet.blend.capital`, co-sign the returned XDR, submit). If the faucet is down, 03
  stops with a message naming the accounts to fund by hand.
- **Other receipt holders.** The keeper pays everyone with a balance, including the contract agent's
  `smoke_test_user`; accounts with a trustline and a zero balance (`admin`, `taker`) are skipped.
- **Peg book spread.** Two offers of the same account at exactly 1.0 would cross each other
  (`MANAGE_SELL_OFFER_CROSS_SELF`), hence the 5 bps on each side.
- **Receipt balances include offers.** Horizon's `balance` is the trustline balance; open offers only
  add `selling_liabilities`. That is the whole point: the maker's quoted inventory earns yield.
- **Re-seeding.** `04 --reset` cancels all offers of `peg_lp` and `maker` before posting fresh ones.
- **Rehearsal.** `LOTUS_DEPLOY_DIR=/tmp/rehearsal node 01-setup-accounts.mjs` etc. keeps a dry run on
  separate throwaway accounts.
