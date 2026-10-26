# @lotus-stellar/sdk

TypeScript SDK for Lotus on Stellar testnet. ESM, Node 20+, `@stellar/stellar-sdk` 17, typed.

- Config from the live app (`/api/config`) or a local `deployments/` directory.
- Reads: markets, Horizon order books and trades, accounts, offers, `lotus_pool` (`get_config`, `depth`, `tvl`,
  `positions_of`, `get_position`, `quote_swap`) and `lotus_vault` (`supply`, `vault_value`, `surplus`), all by
  simulation only; the observed APR and a live Blend APR read.
- Builders that return **unsigned XDR**: pool swap, range order (4 strategies), claim, remove, SDEX limit offer and
  cancel, vault deposit and redeem, trustlines.
- `submit(signedXdr | signedXdr[])`: Soroban through RPC, classic through Horizon, in order, stopping at the first
  failure; with a signer, a footprint race on the shared DeFindex vault is re-simulated, re-signed and resent.
- `fromSecret()`: a signer for testnet scripts (refuses any other network).

The SDK does not re-implement the app's rules. `src/shared/` holds byte-identical copies of the pure files of
`web/lib` (`amount.ts`, `poolGrid.ts`, `orderRoute.ts`, `txErrors.ts`, `yieldRate.ts`, `config-types.ts`):
bins to offers, the direction rule, the curator rule (`PROXIMITY_MIN_BINS`), the failure classification.
`npm run build` re-copies them, and a unit test fails if they differ. The range-order evaluation (`src/order.ts`) is a
port of `web/components/pools/useOrder.ts` without React; the builders follow `web/lib/orderTx.ts`.

## Build and test

```sh
cd sdk
npm install
npm run build   # sync src/shared from web/lib, then tsc -> dist/
npm test        # build + node:test (pure parts, no network)
```

## Examples

```ts
import { Lotus, fromSecret } from "@lotus-stellar/sdk";

const lotus = await Lotus.connect(); // https://lotus-stellar.vercel.app/api/config
// const lotus = await Lotus.connect({ deploymentsDir: "../deployments" });

lotus.markets().map((m) => m.id);                        // ["LBOND-lUSDCb", "lUSDCb-USDC", "LBOND-USDC", ...]
const { bid, ask } = await lotus.orderbook("LBOND-USDC");
const q = await lotus.quoteSwap({ buyBase: true, amountIn: "10" }); // best directional pool
const { rows } = await lotus.positions("G...");
await lotus.vaultStats();                                 // supply, vaultValue, surplus
await lotus.blendApr({ windowSeconds: 12 });              // live Blend supply APR (testnet snapshot)
```

Build, sign in a wallet, submit:

```ts
const built = await lotus.buildSwap({ account: "G...", buyBase: true, amountIn: "5", slippageBps: 50 });
console.log(built.summary, built.warnings);
const signed = await wallet.signTransaction(built.txs[0].xdr, { networkPassphrase: built.txs[0].networkPassphrase });
const r = await lotus.submit(signed);
console.log(r.ok, r.results.map((x) => lotus.txUrl(x.hash)));
```

Range limit order (evaluate the four strategies, then build one):

```ts
const input = { account: "G...", side: "Ask" as const, startPrice: "1.03", endPrice: "1.035", amount: "5" };
const { destinations } = await lotus.evaluateRangeOrder(input);
destinations.map((d) => [d.id, d.blockedBy ?? "ok", d.summary]);

const order = await lotus.buildRangeOrder({ ...input, strategy: "pool" }); // pool | pool-yield | sdex | sdex-yield
// sdex-yield + Bid returns two transactions (deposit at s+1, offers at s+2): sign both, submit([tx1, tx2]);
// tx 2 is only sent when tx 1 succeeded.
```

Testnet automation with a throwaway key:

```ts
const signer = fromSecret(process.env.TESTNET_SECRET!);
const trust = await lotus.buildTrustlines({ account: signer.publicKey });
await lotus.signAndSubmit(trust, signer);
await Lotus.faucetClaim("https://lotus-stellar.vercel.app", signer.publicKey);
const pos = await lotus.buildRangeOrder({ account: signer.publicKey, side: "Ask", startPrice: "1.03", endPrice: "1.035", amount: "5", strategy: "pool" });
const res = await lotus.signAndSubmit(pos, signer); // res.results[0].result = the position id
```

Other builders: `buildClaim` / `buildRemove({ account, pool, positionId })`, `buildLimitOrder({ account, market,
side, price, amount })`, `buildCancelOffer({ account, offerId })` (own offers only), `buildDeposit` /
`buildRedeem({ account, amount, strategy? })`.

## API notes

- Amounts are decimal strings with at most 7 decimals; prices are QUOTE (USDC) per BASE (LBOND).
- Every builder checks the account first (exists, trustlines authorized, balance) and throws a plain message.
  Missing trustlines are not added silently, except the proceeds trustline of an SDEX Ask, bundled as in the app.
- A `BuildResult` is `{ txs: BuiltTx[], summary, warnings, details }`; each `BuiltTx` carries `xdr`, `kind`
  (`soroban` | `classic`), `label`, `source`, `sequence`, `fee` and `networkPassphrase`. Several txs are sequential.
- Soroban transactions are assembled from a fresh simulation with a 300 s time bound. Rebuild instead of resubmitting
  a stale one.
- Vault-backed pool views touch DeFindex state: they are always simulated, never submitted.
