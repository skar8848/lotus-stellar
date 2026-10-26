# Integrate

> Three ways to build on Lotus: the HTTP endpoints of this app, a TypeScript SDK, and an MCP server that lets AI agents (Claude Code, Codex, Cursor, ...) read the markets and build transactions. Testnet only.

## For AI agents: start here

1. Read [`{{origin}}/llms.txt`]({{origin}}/llms.txt) (index) or [`{{origin}}/llms-full.txt`]({{origin}}/llms-full.txt) (every page in one file). Every docs page is also served as raw Markdown at `{{origin}}/docs/<slug>.md`.
2. Call `GET {{origin}}/api/health` to check that the deployment works before relying on it.
3. Call `GET {{origin}}/api/config` for every contract id and asset. Never hard-code ids: they change when a contract is redeployed.
4. Use the MCP server (below) to quote and build transactions. Signing stays with the user's wallet or key.

## HTTP endpoints

All responses are JSON with `Cache-Control: no-store`.

### GET /api/health

Machine-readable deployment check. Reads are cheap: one Soroban RPC `getHealth`, one Horizon root request, one `getLedgerEntries` for every contract instance, and one read-only simulation per Lotus contract (`abi_version()` on each pool, `supply()` on each vault). Results are cached for about 15 seconds.

```jsonc
{
  "status": "ok",              // "ok" | "degraded" (a contract check failed) | "down" (RPC or Horizon unreachable)
  "checkedAt": "2026-10-26T09:00:00.000Z",
  "app": { "name": "lotus-web", "version": "0.1.0", "commit": "abc1234...", "env": "production" },
  "network": { "name": "testnet", "passphrase": "Test SDF Network ; September 2015" },
  "rpc":     { "url": "https://...", "ok": true, "latencyMs": 120, "latestLedger": 123456, "status": "healthy" },
  "horizon": { "url": "https://...", "ok": true, "latencyMs": 90, "latestLedger": 123456 },
  "contracts": [
    { "kind": "lotus_pool", "id": "lbond-usdc-idle", "contract": "C...", "status": "live",
      "ok": true, "instance": true, "liveUntilLedger": 999999,
      "read": { "method": "abi_version", "ok": true, "value": 1 }, "explorer": "https://stellar.expert/..." }
  ],
  "summary": { "total": 9, "ok": 9, "failed": [] }
}
```

HTTP 200 for `ok` and `degraded`, 503 for `down`. `commit` is `null` when the host does not expose it.

### GET /api/config

The merged deployment config, public keys only, re-read from the deployment files at request time.

```jsonc
{
  "network": "testnet", "rpc": "https://...", "horizon": "https://...", "passphrase": "Test SDF Network ; September 2015",
  "lotusVault": "C...",                                   // active lotus_vault
  "underlying": { "code": "USDC", "issuer": "G...", "sac": "C..." },
  "receipt":    { "code": "lUSDCb", "issuer": "G...", "sac": "C..." },
  "rwa":        { "code": "LBOND", "issuer": "G..." },
  "defindexVault": "C...", "blendPool": "C...",
  "strategies": [ { "id": "usdc-defindex-blend", "label": "...", "status": "live", "lotusVault": "C...",
                    "underlying": {}, "receipt": {}, "defindexVault": "C...", "blendPool": "C...", "observed": {} } ],
  "pools": [ { "id": "lbond-usdc-idle", "label": "...", "status": "live", "contract": "C...", "base": {}, "quote": {},
               "vault": null, "binStepBps": 10, "feeBps": 10, "supportsTwoWay": false, "mock": false } ],
  "retiredPools": [],
  "accounts": { "maker": "G...", "...": "G..." },
  "sources": {}, "loadedAt": "2026-10-26T09:00:00.000Z"
}
```

### GET /api/faucet

Faucet status: `{ ok, testnet, enabled, assets: [{ role, code, amount, configured, source }] }`.

### POST /api/faucet

Body `{ "address": "G..." }`. The account must exist (Friendbot) and hold the trustlines. The server authorizes the LBOND trustline and sends each faucet asset in its own transaction.

```json
{ "ok": true, "address": "G...",
  "results": [ { "role": "rwa", "code": "LBOND", "amount": "500", "status": "sent", "hash": "...", "message": "trustline authorized by the issuer" },
               { "role": "underlying", "code": "USDC", "amount": "200", "status": "skipped", "message": "already claimed by this address" } ],
  "error": "only when nothing was sent" }
```

Errors: 400 invalid address / account missing / no trustline, 403 not testnet, 409 claim already running, 429 rate limited, 502 Horizon unavailable. Limits: one claim per address and asset, 6 requests per 10 minutes per IP.

## TypeScript SDK

The SDK lives in the repository at `sdk/` and is documented in `sdk/README.md`, which is the reference (install, configuration, function list). It wraps the same building blocks the app uses: reading the config, quoting the pool, reading positions and offers, and building unsigned transactions for the pool, the vault and the SDEX.

## MCP server (for AI agents)

The MCP server lives at `mcp/` and is documented in `mcp/README.md`, which is the reference for the exact command, environment variables and signing options. It exposes Lotus as tools:

| tool | purpose |
|---|---|
| `lotus_health` | the deployment check (same data as `/api/health`) |
| `lotus_config` | contract ids, assets, network (same data as `/api/config`) |
| `lotus_markets` | the markets and their state |
| `lotus_orderbook` | an SDEX order book |
| `lotus_pools` | Lotus pool instances and their depth |
| `lotus_quote_swap` | quote a swap on the pool |
| `lotus_positions` | an account's pool positions |
| `lotus_offers` | an account's SDEX offers |
| `lotus_build_swap` | build a swap transaction |
| `lotus_build_range_order` | build a range order (pool position or SDEX ladder) |
| `lotus_build_limit_order` | build a one-price limit order |
| `lotus_build_claim` | build a claim of proceeds and fees |
| `lotus_build_remove` | build a position removal |
| `lotus_build_deposit` | build a `lotus_vault` deposit (USDC to receipt) |
| `lotus_build_redeem` | build a `lotus_vault` redeem (receipt to USDC) |
| `lotus_build_trustlines` | build the missing trustlines |
| `lotus_faucet_claim` | claim testnet tokens through `/api/faucet` |
| `lotus_submit` | submit a signed transaction |

The `lotus_build_*` tools produce transactions to be signed by the user; read `mcp/README.md` for how signing is handled before you submit anything.

Build it once (`cd mcp && npm install && npm run build`); at the time of writing the server is started with `node mcp/dist/index.js`. If `mcp/README.md` says otherwise, follow it.

### Install in Claude Code

```sh
claude mcp add lotus -- node /absolute/path/to/lotus-stellar/mcp/dist/index.js
claude mcp list            # check that "lotus" is connected
```

### Install in Codex

Add a server entry to `~/.codex/config.toml`:

```toml
[mcp_servers.lotus]
command = "node"
args = ["/absolute/path/to/lotus-stellar/mcp/dist/index.js"]
```

### Other clients

Cursor, ChatGPT and other MCP clients take the same command and arguments in their own MCP settings. Without MCP, an agent can still use the HTTP endpoints above with Horizon and Soroban RPC directly; the [Contracts](/docs/contracts.md) page has the full ABI.

## Rules for integrators

- Testnet only: check `network.passphrase` is `Test SDF Network ; September 2015`.
- Read contract ids from `/api/config` (or the deployment files), never from copies in docs.
- Run vault-backed pool views and `lotus_vault.vault_value()` / `surplus()` by simulation only, never submit them.
- Re-quote right before a swap and always pass `min_out`.
- A Soroban call must be the only operation of its transaction: trustlines and deposits are separate transactions.
