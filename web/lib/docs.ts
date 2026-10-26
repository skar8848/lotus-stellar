// Docs manifest and the pure builders behind /docs, /docs/<slug>.md, /llms.txt and /llms-full.txt.
// The Markdown sources live in web/content/docs/<slug>.md (loaded by lib/docs-server.ts). Pure: tested in
// tests/docs.test.mts without Next.

import { docTitleAndSummary } from "./markdown.ts";

/** Order = sidebar order = llms.txt order. `label` is the short sidebar name. */
export const DOCS = [
  { slug: "overview", label: "Overview" },
  { slug: "concepts", label: "Concepts" },
  { slug: "using-the-app", label: "Using the app" },
  { slug: "contracts", label: "Contracts" },
  { slug: "integrate", label: "Integrate (SDK, MCP)" },
  { slug: "bots-and-volume", label: "Bots and volume" },
  { slug: "faq", label: "FAQ" },
] as const;

export type DocSlug = (typeof DOCS)[number]["slug"];
export type DocPage = { slug: DocSlug; label: string; title: string; summary: string; markdown: string };

export const isDocSlug = (s: string): s is DocSlug => DOCS.some((d) => d.slug === s);

/** Replace `{{name}}` placeholders; unknown names are left as they are (so a typo is visible, not silent). */
export function expandPlaceholders(md: string, vars: Record<string, string>): string {
  return md.replace(/\{\{([a-z0-9-]+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function toPage(slug: DocSlug, markdown: string): DocPage {
  const meta = DOCS.find((d) => d.slug === slug)!;
  const { title, summary } = docTitleAndSummary(markdown);
  return { slug, label: meta.label, title: title || meta.label, summary, markdown };
}

export const LLMS_SUMMARY =
  "Lotus is directional liquidity and yield-bearing orders for Stellar: a Soroban range pool (lotus_pool) where a position only sells its inventory and never trades back, and a yield-bearing receipt (lUSDCb, minted 1:1 by lotus_vault against USDC lent on Blend through DeFindex) that can be quoted on the Stellar DEX. One order, four places to wait. Stellar testnet only, not audited.";

export type ApiDoc = { method: "GET" | "POST"; path: string; summary: string };

export const API_DOCS: ApiDoc[] = [
  {
    method: "GET",
    path: "/api/health",
    summary:
      'deployment check. Response: { status: "ok"|"degraded"|"down", checkedAt, app: { name, version, commit|null, env }, network: { name, passphrase }, rpc: { url, ok, latencyMs, latestLedger, status }, horizon: { url, ok, latencyMs, latestLedger }, contracts: [{ kind, id, contract, status, ok, instance, liveUntilLedger, read?: { method, ok, value|error }, explorer }], summary: { total, ok, failed[] } }. HTTP 200 for ok/degraded, 503 for down.',
  },
  {
    method: "GET",
    path: "/api/config",
    summary:
      "deployment config, public keys only, read at request time. Response: { network, rpc, horizon, passphrase, lotusVault, underlying: { code, issuer, sac }, receipt: { code, issuer, sac }, rwa: { code, issuer }, defindexVault, blendPool, strategies: [{ id, label, status, lotusVault, underlying, receipt, defindexVault, blendPool, observed? }], pools: [{ id, label, status, contract, base, quote, vault|null, binStepBps, feeBps, supportsTwoWay, mock }], retiredPools, accounts: { name: G... }, sources, loadedAt }. Read contract ids from here, never hard-code them.",
  },
  {
    method: "GET",
    path: "/api/faucet",
    summary: "faucet status. Response: { ok, testnet, enabled, assets: [{ role, code, amount, configured, source }] }.",
  },
  {
    method: "POST",
    path: "/api/faucet",
    summary:
      'testnet tokens. Body: { "address": "G..." } (account must exist and hold the trustlines). Response: { ok, address, results: [{ role, code, amount, status: "sent"|"skipped"|"error", hash?, message? }], error? }. Errors 400 / 403 / 409 / 429 / 502. One claim per address and asset, 6 requests per 10 minutes per IP.',
  },
];

/** llms.txt (https://llmstxt.org): H1, blockquote summary, details, then H2 sections of links. */
export function buildLlmsTxt(origin: string, pages: DocPage[]): string {
  const o = origin.replace(/\/$/, "");
  const lines = [
    "# Lotus",
    "",
    `> ${LLMS_SUMMARY}`,
    "",
    "Network: Stellar testnet (passphrase `Test SDF Network ; September 2015`). Market: LBOND / USDC, where LBOND is a simulated tokenized bond issued by the Lotus team (AUTH_REQUIRED, clawback). Trading volume comes from market-maker accounts run by the team, not from users.",
    "",
    `Agents: check \`GET ${o}/api/health\` first, read every contract id from \`GET ${o}/api/config\` (never hard-code ids), and run vault-backed pool views and lotus_vault vault_value()/surplus() by simulation only. Every page below is raw Markdown; the same content is rendered for humans at ${o}/docs.`,
    "",
    "## Docs",
    "",
    ...pages.map((p) => `- [${p.title}](${o}/docs/${p.slug}.md): ${p.summary}`),
    "",
    "## API",
    "",
    ...API_DOCS.map((a) => `- [${a.method} ${a.path}](${o}${a.path}): ${a.summary}`),
    "",
    "## Optional",
    "",
    `- [Full documentation in one file](${o}/llms-full.txt): every page above, concatenated.`,
    "- SDK and MCP server: `sdk/README.md` and `mcp/README.md` in the Lotus repository (tools lotus_health, lotus_config, lotus_markets, lotus_orderbook, lotus_pools, lotus_quote_swap, lotus_positions, lotus_offers, lotus_build_*, lotus_faucet_claim, lotus_submit).",
    "",
  ];
  return lines.join("\n");
}

/** llms-full.txt: a short header, then every page in order, each preceded by its raw URL. */
export function buildLlmsFull(origin: string, pages: DocPage[]): string {
  const o = origin.replace(/\/$/, "");
  const head = [
    "# Lotus documentation (full)",
    "",
    `> ${LLMS_SUMMARY}`,
    "",
    `Generated from the same Markdown as ${o}/docs. Index: ${o}/llms.txt. Deployment check: ${o}/api/health.`,
    "",
  ].join("\n");
  const body = pages.map((p) => `<!-- source: ${o}/docs/${p.slug}.md -->\n\n${p.markdown.trim()}\n`).join("\n---\n\n");
  return `${head}\n---\n\n${body}`;
}
