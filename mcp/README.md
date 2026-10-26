# Lotus MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that lets an AI agent use Lotus on Stellar
testnet: read the config, markets, order books, pools, positions and offers; build transactions; submit them.
It is built on [`@lotus-stellar/sdk`](../sdk/README.md), which reuses the app's own routing code (`web/lib`), so
an order built by an agent follows the same rules as one built in the app.

Testnet only. Nothing is audited.

## Build

```sh
cd sdk && npm install && npm run build
cd ../mcp && npm install && npm run build      # -> mcp/dist/index.js
npm run smoke                                  # read-only check over stdio (health, markets, book, quote)
```

Node 20 or newer.

## Install in a client

Replace `/path/to/lotus-stellar` with your checkout.

**Claude Code**

```sh
claude mcp add lotus -- node /path/to/lotus-stellar/mcp/dist/index.js
# with options:
claude mcp add lotus -e LOTUS_APP_URL=https://lotus-stellar.vercel.app -- node /path/to/lotus-stellar/mcp/dist/index.js
```

Or commit a project `.mcp.json` (this repo has one at the root, pointing to `mcp/dist/index.js`, so Claude Code
started in the repo picks the server up after the build):

```json
{
  "mcpServers": {
    "lotus": { "type": "stdio", "command": "node", "args": ["/path/to/lotus-stellar/mcp/dist/index.js"] }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.lotus]
command = "node"
args = ["/path/to/lotus-stellar/mcp/dist/index.js"]
env = { LOTUS_APP_URL = "https://lotus-stellar.vercel.app" }
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "lotus": {
      "command": "node",
      "args": ["/path/to/lotus-stellar/mcp/dist/index.js"],
      "env": { "LOTUS_APP_URL": "https://lotus-stellar.vercel.app" }
    }
  }
}
```

## Environment

| variable | default | |
|---|---|---|
| `LOTUS_APP_URL` | `https://lotus-stellar.vercel.app` | the app: its `/api/config` is the config, its `/api/faucet` the faucet |
| `LOTUS_DEPLOYMENTS_DIR` | unset | read `deployments/testnet.*.json` from this directory instead of `/api/config` (public files only; `*.secrets.json` are never read) |
| `STELLAR_RPC_URL` | from the config | override Soroban RPC |
| `HORIZON_URL` | from the config | override Horizon |
| `LOTUS_SECRET` | unset | opt-in autonomous mode, testnet only (below) |

## Signing: two modes

**Default: the user's wallet signs.** Every `lotus_build_*` tool returns unsigned transactions (base64 XDR) with a
one-line summary, warnings, and the network passphrase. Sign them in a wallet (Freighter, xBull, Albedo, Lobstr,
Hana, or `stellar tx sign`) and pass the signed XDR to `lotus_submit`. The server holds no key.

**Opt-in: autonomous testnet agent.** Set `LOTUS_SECRET=S...` for one testnet account. Then:

- build tools accept `submit: true` (sign with that key and submit now), and `account` defaults to that key;
- `lotus_submit` accepts `sign: true`, and a vault footprint race is rebuilt, re-signed and resent automatically.

Safety: the key is honoured only when the loaded config is Stellar testnet (`Test SDF Network ; September 2015`) and
the signer refuses any other passphrase. It is read once, removed from the process environment, kept inside the
signer closure, and scrubbed from every tool output and log line. It only signs transactions whose source is that
account. Use a throwaway friendbot account, never a key that holds anything of value.

## Tools

| tool | what it does |
|---|---|
| `lotus_health` | checks the app URL, `/api/config`, `/api/faucet`, Soroban RPC (health, network, ledger), Horizon, each pool contract (`abi_version`, `get_config`, vault matches the config) and the Lotus vault. Run it first. |
| `lotus_config` | network, endpoints, assets, pools, vault strategies, named public accounts, signing mode |
| `lotus_markets` | the SDEX markets (LBOND/receipt, receipt/USDC, LBOND/USDC) with best bid / ask / mid |
| `lotus_orderbook` | one market's book and recent trades |
| `lotus_pools` | every pool instance: config, TVL, best bid / ask, bins (optional); the Lotus vault; observed APR and, on request, the live Blend APR |
| `lotus_quote_swap` | `quote_swap` simulation on one or every directional pool, best kept |
| `lotus_account` | balances, amounts in offers, trustline authorization |
| `lotus_positions` | open pool positions of an account (all instances, retired included) |
| `lotus_offers` | open SDEX offers of an account |
| `lotus_build_trustlines` | `changeTrust` for the missing USDC / LBOND / receipt |
| `lotus_faucet_claim` | the app's faucet: authorizes LBOND, sends 500 LBOND, 200 USDC, 50 lUSDCb |
| `lotus_build_swap` | pool `swap` with `min_out` from the slippage |
| `lotus_build_range_order` | directional range order, `strategy` = `pool`, `pool-yield`, `sdex`, `sdex-yield`; without `strategy` it evaluates the four |
| `lotus_build_limit_order` | one SDEX `manageSellOffer` |
| `lotus_build_cancel_offer` | cancel one of the account's own offers |
| `lotus_build_claim` / `lotus_build_remove` | `claim` / `remove_position` of a pool position |
| `lotus_build_deposit` / `lotus_build_redeem` | `lotus_vault.deposit` / `redeem` (USDC <-> receipt) |
| `lotus_submit` | submit signed XDR (one, or several in order: each only after the previous succeeded) |

Outputs are compact JSON with stellar.expert links for transactions, accounts, contracts and offers.

## Range orders: the app's rules

`lotus_build_range_order` runs the code of `web/lib/orderRoute.ts` and `web/lib/poolGrid.ts` (byte-identical copies,
checked by the SDK tests):

- each bin is `1.001^bin` USDC per LBOND, at most 64 bins (50 on the SDEX, where each bin is one offer at the bin's
  exact price and amount);
- the reference price is the book the strategy rests on (pool: its bins, then LBOND/USDC; sdex: LBOND/USDC;
  sdex-yield: LBOND/receipt). A sell range must start at or above it, a buy range at or below it;
- curator rule: `pool-yield` refuses a Bid whose top bin is within 10 bins of the reference;
- `sdex-yield` Bid is two transactions: `lotus_vault.deposit` at sequence s+1, then the receipt ladder at s+2. Pass
  both to `lotus_submit` in order; the second is never sent if the first fails.

## Typical agent session

1. `lotus_health`, then `lotus_markets` / `lotus_pools`.
2. New account: fund it with Friendbot, `lotus_build_trustlines`, sign, `lotus_submit`, then `lotus_faucet_claim`.
3. `lotus_quote_swap` then `lotus_build_swap`, or `lotus_build_range_order` (first without `strategy` to compare).
4. `lotus_positions` / `lotus_offers`, then `lotus_build_claim` / `lotus_build_remove` / `lotus_build_cancel_offer`.

A market-making bot trades these testnet markets. Only cancel offers you created.
