# Agent guide: Lotus on Stellar

Guide for coding agents (Claude Code, Codex, Cursor, ...) working in this repository. Product docs for humans and
LLMs live in the web app: `/docs`, `/llms.txt`, `/llms-full.txt` (sources in `web/content/docs/*.md`).

Lotus = a directional range pool (`lotus_pool`) plus a yield-bearing receipt (`lotus_vault`, classic asset `lUSDCb`)
quoted on the Stellar DEX. **Testnet only.** Nothing is on mainnet, nothing is audited. Never point any code at
mainnet.

## Layout

```
contracts/          Soroban workspace (Cargo.toml at the repo root)
  lotus_pool/       range pool, ABI in docs/pool-abi.md, accounting notes in its README, test-vectors.json
  lotus_vault/      receipt wrapper over a DeFindex vault (interface in contracts/README.md)
  mock_vault/       DeFindex-like vault for unit tests
scripts/            Node 20+ testnet scripts (01..07), lib/, bot/ (market makers, arbitrageur, keeper)
sdk/                TypeScript SDK (see sdk/README.md)
mcp/                MCP server for AI agents (see mcp/README.md)
web/                Next.js 16 app (App Router, Tailwind v4): /swap /trade /pools /portfolio /faucet /docs
  content/docs/     Markdown sources of /docs, /docs/<slug>.md, /llms.txt, /llms-full.txt
deployments/        testnet addresses (public *.json) and keys (*.secrets.json, git-ignored)
docs/               pool ABI, pitch deck, demo script, submission answers, FAQ for judges
```

## Build and test

| package | commands (run from the package directory) |
|---|---|
| contracts (repo root) | `stellar contract build` (never plain `cargo build --target wasm32v1-none`), `cargo test --workspace`, one crate: `cargo test -p lotus_pool`. Needs Rust >= 1.84 + `rustup target add wasm32v1-none`, stellar CLI |
| `web/` | `npm install`, `npm run dev`, `npm run build` (must pass: Vercel fails on type errors), `npm run lint`, `npm run test:unit` (plain node, no browser), `npx tsc --noEmit` |
| `scripts/` | `npm install`, numbered scripts via `npm run setup / issue / mint / seed / take / keeper`, bot via `npm run bot`, `bot:demo`, `bot:live` (see scripts/bot/README.md) |
| `sdk/` | `npm run build`, `npm run typecheck`, `npm test` |
| `mcp/` | `npm run build`, `npm start`, `npm run smoke` |

Before reporting web work as done: `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`, `npm run build`.

## Dev servers, ports and `NEXT_DIST_DIR`

- Ports in use by convention: `3000` (main `next dev`), `3200` (the e2e test server, `BASE_URL` default of
  `web/e2e/*.mjs`). Pick another free port (for example `4400`) for your own server, and check with
  `lsof -iTCP -sTCP:LISTEN -P | grep node` first.
- Next takes an exclusive lock on `<distDir>/lock`, so a second server in `web/` needs its own dist dir:
  `NEXT_DIST_DIR=.next-4400 npx next dev -p 4400` (also works for builds: `NEXT_DIST_DIR=.next-build npm run build`).
- `next dev` / `next build` auto-edit `web/tsconfig.json` (adds `.next-<x>/types` includes) and `web/next-env.d.ts`.
  Revert those edits, and delete your `.next-*` dir when you are done.
- Never kill node processes you did not start: other agents and the user run servers and bots in parallel. Stop yours
  by its port (`lsof -tiTCP:<port> -sTCP:LISTEN`).
- Next.js 16 differs from older versions: read `web/node_modules/next/dist/docs/` before using an unfamiliar API
  (see `web/AGENTS.md`). Route params are Promises; middleware is called `proxy`.

## Config: where addresses live

- `deployments/testnet.contract.json` (active `lotus_vault`, network, RPC / Horizon, USDC and receipt assets),
  `testnet.strategies.json` (every vault), `testnet.pool.json` (pool instances, `retired_pools`),
  `testnet.classic.json` (LBOND, demo accounts), `testnet.bot.json` (bot accounts). If a README disagrees with these
  files, the files win.
- The web app reads them at request time (`web/lib/config.ts`, override dir `LOTUS_DEPLOYMENTS_DIR`); hosted builds
  copy the public ones into `web/deployments/` (`web/scripts/copy-deployments.mjs`, never `*.secrets.json`).
  `GET /api/config` returns the merged config.
- **Never hard-code contract ids or issuers** in app code or docs. In `web/content/docs/*.md` use the placeholders
  `{{deployment}}`, `{{bot-accounts}}`, `{{origin}}` (filled by `web/lib/docs-server.ts`); a unit test rejects any
  `C...` id in the docs sources.

## Secrets

- Never commit, print or copy `deployments/*.secrets.json`, `web/.env*` (except `web/.env.example`), or anything
  holding an `S...` key or an RPC URL with an API key (`testnet.rpc.secrets.json`). Check `git status` before
  committing.
- `NEXT_PUBLIC_*` variables are inlined into the client bundle: only throwaway testnet keys, only for local tests.
- Faucet keys are server-only (`web/lib/faucet-server.ts`, env `FAUCET_*_SECRET` on Vercel); never log or return them.

## End-to-end tests with the dev signer

```sh
cd web
node e2e/setup-env.mjs                              # writes .env.local (NEXT_PUBLIC_DEV_SIGNER=1, keys) from ../deployments/*.secrets.json
NEXT_DIST_DIR=.next-3200 npx next dev -p 3200 &     # test server (or BASE_URL=http://localhost:<port>)
node e2e/run-flows.mjs                               # /trade SDEX flows, verified on Horizon
node e2e/pool-flows.mjs                              # pool flows (POOL=<instance id>)
E2E_DEV_SECRET=<label=S...> node e2e/position-flows.mjs   # /pools New position, all four strategies
node e2e/shots.mjs --path /trade --name trade --wallet maker --full   # screenshots
```

They send real testnet transactions with small amounts. Never build or deploy with `NEXT_PUBLIC_DEV_SIGNER` set.

## Verify a deployment

`GET /api/health` (for example `https://lotus-stellar.vercel.app/api/health`) returns JSON:
`status` = `ok` | `degraded` | `down`, app version and commit, RPC and Horizon reachability with latest ledger, and
one entry per contract (pools, vaults, DeFindex vaults, Blend pool, SACs) with instance existence, TTL and a
read-only simulated call (`abi_version()` on pools, `supply()` on vaults). HTTP 503 when RPC or Horizon is down.

```sh
curl -s localhost:3000/api/health | jq '{status, summary}'
```

## Soroban gotchas

- A Soroban invocation must be the only operation of its transaction (trustline + deposit = two transactions).
- Vault-backed pool views (`quote_swap` sell, `get_position`, `get_bin`/`depth` on Bid, `tvl`) and
  `lotus_vault.vault_value()` / `surplus()` write a DeFindex fee report: simulate only, never submit
  (`--send=no` with the CLI).
- Calls that withdraw from the shared DeFindex vault can fail with `Error(Storage, ExceededLimit)` (footprint race):
  re-simulate, re-sign, resend.
- LBOND is `AUTH_REQUIRED`: trustlines must be authorized by the issuer (the faucet does it).

## Conventions

- Plain, factual wording; say "testnet", say where volume comes from (team-run market makers), label yields as
  observed, not forecast.
- Keep the Lotus look in `web/`: black background, pink primary `#F3B1CE`, existing `components/ui` primitives.
- Do not commit unless asked.
