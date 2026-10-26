// Server-only loader for the docs (node:fs). Reads web/content/docs/<slug>.md at request time and fills the
// placeholders from the live deployment config, so contract ids in the docs are never hard-coded:
//   {{origin}}        the site origin of the request (https://lotus-stellar.vercel.app, http://localhost:3000, ...)
//   {{deployment}}    tables of every network endpoint, pool, vault, asset and external contract (lib/config.ts)
//   {{bot-accounts}}  the team's bot accounts from deployments/testnet.bot.json
// Never import this from a client component.

import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AssetCfg, type LotusConfig } from "./config";
import { DOCS, expandPlaceholders, toPage, type DocPage, type DocSlug } from "./docs";
import { explorerAccount, explorerAsset, explorerContract } from "./explorer";

function contentDirs(): string[] {
  return [path.resolve(process.cwd(), "content", "docs"), path.resolve(process.cwd(), "web", "content", "docs")];
}

function readSource(slug: DocSlug): string | null {
  for (const dir of contentDirs()) {
    try {
      // traced explicitly by outputFileTracingIncludes in next.config.ts
      return fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, `${slug}.md`), "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

/** Same lookup order as lib/config.ts. */
function readDeploymentJson(file: string): Record<string, unknown> | null {
  const dirs = [process.env.LOTUS_DEPLOYMENTS_DIR, path.resolve(process.cwd(), "..", "deployments"), path.resolve(process.cwd(), "deployments")];
  for (const d of dirs) {
    if (!d) continue;
    try {
      return JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ d, file), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

/** Origin of the current request, from the forwarded headers (Vercel) or Host. */
export function originFrom(h: Headers): string {
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

const isC = (id: string | null | undefined): id is string => !!id && /^C[A-Z2-7]{55}$/.test(id);
const isG = (id: string | null | undefined): id is string => !!id && /^G[A-Z2-7]{55}$/.test(id);
const cLink = (id: string | null | undefined, net: string) => (isC(id) ? `[\`${id}\`](${explorerContract(id, net)})` : "-");
const gLink = (id: string | null | undefined, net: string) => (isG(id) ? `[\`${id}\`](${explorerAccount(id, net)})` : "-");
const aLink = (a: AssetCfg, net: string) => `[\`${a.code}\`](${explorerAsset(a.code, a.issuer, net)})`;

export function deploymentMarkdown(c: LotusConfig): string {
  const net = c.network;
  const out: string[] = [];
  out.push(
    "| | value |",
    "|---|---|",
    `| network | \`${c.network}\` |`,
    `| passphrase | \`${c.passphrase}\` |`,
    `| Soroban RPC | \`${c.rpc}\` |`,
    `| Horizon | \`${c.horizon}\` |`,
    `| active lotus_vault | ${cLink(c.lotusVault, net)} |`,
    "",
  );

  out.push("### Lotus pool instances (lotus_pool)", "");
  const live = c.pools.filter((p) => !p.mock);
  if (live.length === 0) out.push("No pool instance is deployed in this config (the app runs a local simulation).", "");
  else {
    out.push("| id | status | contract | USDC leg | two-way | bin step / fee |", "|---|---|---|---|---|---|");
    for (const p of live) {
      out.push(
        `| \`${p.id}\` | ${p.status} | ${cLink(p.contract, net)} | ${p.vault ? `DeFindex vault ${cLink(p.vault, net)}` : "idle (held by the pool)"} | ${p.supportsTwoWay ? "yes" : "no"} | ${p.binStepBps} bps / ${p.feeBps} bps |`,
      );
    }
    out.push("");
  }
  if (c.retiredPools.length > 0) {
    out.push(
      `Retired instances (hidden from the app's pool views, still listed on /portfolio so owners can claim or remove): ${c.retiredPools
        .map((p) => `\`${p.id}\` ${cLink(p.contract, net)}`)
        .join(", ")}.`,
      "",
    );
  }

  out.push("### Lotus vaults (lotus_vault) and receipts", "");
  const vaults = c.strategies.filter((s) => s.lotusVault);
  if (vaults.length === 0) out.push("No lotus_vault in this config.", "");
  else {
    out.push("| strategy | status | lotus_vault | receipt (classic asset) | receipt SAC | DeFindex vault |", "|---|---|---|---|---|---|");
    for (const s of vaults) {
      const active = s.lotusVault === c.lotusVault ? " (active)" : "";
      out.push(
        `| \`${s.id}\`${active} | ${s.status} | ${cLink(s.lotusVault, net)} | ${aLink(s.receipt, net)} issuer ${gLink(s.receipt.issuer, net)} | ${cLink(s.receipt.sac, net)} | ${cLink(s.defindexVault, net)} |`,
      );
    }
    out.push("");
    const soon = c.strategies.filter((s) => !s.lotusVault);
    if (soon.length > 0) out.push(`Announced, not deployed: ${soon.map((s) => `\`${s.id}\``).join(", ")}.`, "");
  }

  out.push("### Assets and external contracts", "");
  const lbondSac = c.pools.find((p) => p.base.code === c.rwa.code && p.base.sac)?.base.sac ?? c.rwa.sac;
  out.push(
    "| | asset / contract | issuer | SAC |",
    "|---|---|---|---|",
    `| ${c.rwa.code} (simulated bond, AUTH_REQUIRED, clawback) | ${aLink(c.rwa, net)} | ${gLink(c.rwa.issuer, net)} | ${cLink(lbondSac, net)} |`,
    `| ${c.underlying.code} (Blend testnet) | ${aLink(c.underlying, net)} | ${gLink(c.underlying.issuer, net)} | ${cLink(c.underlying.sac, net)} |`,
    `| ${c.receipt.code} (active receipt) | ${aLink(c.receipt, net)} | ${gLink(c.receipt.issuer, net)} | ${cLink(c.receipt.sac, net)} |`,
    `| DeFindex vault (active) | ${cLink(c.defindexVault, net)} | | |`,
    `| Blend pool | ${cLink(c.blendPool, net)} | | |`,
    "",
    "Machine-readable: `GET /api/config` returns the same values as JSON.",
  );
  return out.join("\n");
}

export function botAccountsMarkdown(network: string): string {
  const bot = readDeploymentJson("testnet.bot.json");
  const accounts = (bot?.accounts ?? {}) as Record<string, unknown>;
  const roles = (bot?.roles ?? {}) as Record<string, unknown>;
  const rows = Object.entries(accounts)
    .map(([name, v]) => {
      const id = typeof v === "string" ? v : v && typeof v === "object" ? ((v as Record<string, unknown>).public as string | undefined) : undefined;
      return isG(id) ? `| \`${name}\` | ${gLink(id, network)} | ${typeof roles[name] === "string" ? roles[name] : ""} |` : null;
    })
    .filter((r): r is string => r !== null);
  if (rows.length === 0) return "The bot accounts file (`deployments/testnet.bot.json`) is not available on this deployment.";
  return ["| account | address | role |", "|---|---|---|", ...rows].join("\n");
}

/** One page, placeholders filled. null when the slug has no source file. */
export function loadDoc(slug: DocSlug, origin: string, config: LotusConfig = loadConfig()): DocPage | null {
  const src = readSource(slug);
  if (src === null) return null;
  const vars: Record<string, string> = { origin: origin.replace(/\/$/, "") };
  if (src.includes("{{deployment}}")) vars.deployment = deploymentMarkdown(config);
  if (src.includes("{{bot-accounts}}")) vars["bot-accounts"] = botAccountsMarkdown(config.network);
  return toPage(slug, expandPlaceholders(src, vars));
}

export function loadAllDocs(origin: string): DocPage[] {
  const config = loadConfig();
  return DOCS.map((d) => loadDoc(d.slug, origin, config)).filter((p): p is DocPage => p !== null);
}
