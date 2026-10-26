#!/usr/bin/env node
// Lotus MCP server (stdio). Exposes Lotus on Stellar testnet to any MCP client (Claude Code, Codex, Claude Desktop,
// Cursor, ...) through @lotus-stellar/sdk.
//
// Default mode: every lotus_build_* tool returns UNSIGNED transactions (base64 XDR) for the user's wallet to sign;
// the signed XDR goes back through lotus_submit. Nothing is signed here.
//
// Opt-in autonomous mode: LOTUS_SECRET=S... (TESTNET ONLY). The server then can sign and submit for that one
// account (build tools take `submit: true`, lotus_submit takes `sign: true`). The secret is read once, removed
// from the environment, held only inside the signer closure, and scrubbed from every output.
//
// Env: LOTUS_APP_URL (default https://lotus-stellar.vercel.app), LOTUS_DEPLOYMENTS_DIR (read deployments/*.json
// instead of the app), STELLAR_RPC_URL, HORIZON_URL, LOTUS_SECRET.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_APP_URL,
  Lotus,
  STRATEGIES,
  TESTNET_PASSPHRASE,
  fromSecret,
  fromStroops,
  priceAt,
  rpcServer,
  type BuildResult,
  type SequenceResult,
  type Signer,
} from "@lotus-stellar/sdk";

const VERSION = "0.1.0";
const APP_URL = (process.env.LOTUS_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
const DEPLOYMENTS_DIR = process.env.LOTUS_DEPLOYMENTS_DIR || undefined;
const RPC_URL = process.env.STELLAR_RPC_URL || undefined;
const HORIZON_URL = process.env.HORIZON_URL || undefined;

// ---- secret handling --------------------------------------------------------------------------------------------
const rawSecret = process.env.LOTUS_SECRET?.trim() || "";
delete process.env.LOTUS_SECRET; // never inherited by anything this process spawns
let signer: Signer | null = null;
let signerNote = "off (default): build tools return unsigned XDR for your wallet";
if (rawSecret) {
  try {
    signer = fromSecret(rawSecret);
    signerNote = `on for ${signer.publicKey} (LOTUS_SECRET, testnet only)`;
  } catch (e) {
    signerNote = `LOTUS_SECRET rejected: ${e instanceof Error ? e.message : "invalid"}`;
  }
}
const scrub = (t: string) => (rawSecret ? t.split(rawSecret).join("[redacted]") : t);
const log = (m: string) => process.stderr.write(`[lotus-mcp] ${scrub(m)}\n`);

// ---- lazy config ------------------------------------------------------------------------------------------------
let lotusP: Promise<Lotus> | null = null;
let loadedAt = 0;
async function lotus(refresh = false): Promise<Lotus> {
  if (refresh || !lotusP || Date.now() - loadedAt > 5 * 60_000) {
    loadedAt = Date.now();
    lotusP = Lotus.connect({ appUrl: APP_URL, deploymentsDir: DEPLOYMENTS_DIR, rpcUrl: RPC_URL, horizonUrl: HORIZON_URL }).catch((e) => {
      lotusP = null;
      throw e;
    });
  }
  const l = await lotusP;
  if (signer && l.config.passphrase !== TESTNET_PASSPHRASE) {
    signer = null;
    signerNote = `disabled: the config network is "${l.config.network}", LOTUS_SECRET is only honoured on Stellar testnet`;
    log(signerNote);
  }
  return l;
}

// ---- output helpers ---------------------------------------------------------------------------------------------
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1);
const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: scrub(json(v)) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: scrub(`Error: ${e instanceof Error ? e.message : String(e)}`) }], isError: true });
function tool<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };
}
const amt = (v: bigint) => fromStroops(v);

function requireAccount(account: string | undefined): string {
  const a = account?.trim() || signer?.publicKey;
  if (!a) throw new Error("account is required (G... public key of the wallet that will sign)");
  return a;
}

async function deliver(l: Lotus, built: BuildResult, submit: boolean | undefined) {
  const txs = built.txs.map((t, i) => ({ step: i + 1, label: t.label, kind: t.kind, source: t.source, sequence: t.sequence, fee_stroops: t.fee, xdr: t.xdr }));
  const base = { summary: built.summary, warnings: built.warnings.length ? built.warnings : undefined, details: built.details };
  if (built.txs.length === 0) return { ...base, txs: [], next: "nothing to sign" };
  if (!submit) {
    return {
      ...base,
      network_passphrase: l.config.passphrase,
      txs,
      next:
        txs.length > 1
          ? `Sign all ${txs.length} XDRs with ${txs[0].source}'s wallet, then call lotus_submit with signed_xdr = [tx1, tx2, ...] in this order (tx 2 is only sent if tx 1 succeeds).`
          : `Sign the XDR with ${txs[0].source}'s wallet (testnet), then call lotus_submit with the signed XDR.`,
    };
  }
  if (!signer) throw new Error("submit: true needs the opt-in LOTUS_SECRET (testnet) on this MCP server; otherwise sign the XDR in a wallet and call lotus_submit");
  if (built.txs.some((t) => t.source !== signer!.publicKey)) throw new Error(`submit: true only signs for ${signer.publicKey} (the LOTUS_SECRET account)`);
  const r = await l.signAndSubmit(built, signer, log);
  return { ...base, ...sequenceOut(l, r) };
}

function sequenceOut(l: Lotus, r: SequenceResult) {
  return {
    ok: r.ok,
    submitted: r.results.map((x) => ({ hash: x.hash, kind: x.kind, ledger: x.ledger, result: x.result, link: l.txUrl(x.hash) })),
    failed: r.failed ? { ...r.failed, link: r.failed.hash ? l.txUrl(r.failed.hash) : undefined } : undefined,
    notes: r.notes.length ? r.notes : undefined,
  };
}

// ---- schemas ----------------------------------------------------------------------------------------------------
const G = z.string().regex(/^G[A-Z2-7]{55}$/, "a Stellar account id (G...)");
const accountArg = signer
  ? G.optional().describe(`Source account (G...). Default: the server key ${signer.publicKey}`)
  : G.describe("Source account (G...): the wallet that will sign");
const decimal = z.string().regex(/^\d+(\.\d{1,7})?$/, "a decimal amount with at most 7 decimals, e.g. \"12.5\"");
const submitArg = z
  .boolean()
  .optional()
  .describe("true = sign with the server's LOTUS_SECRET key and submit now (testnet autonomous mode only). Default false: return unsigned XDR.");

// ---- server -----------------------------------------------------------------------------------------------------
const server = new McpServer(
  { name: "lotus", version: VERSION },
  {
    instructions:
      "Lotus on Stellar TESTNET: a directional range pool (lotus_pool, LBOND/USDC on a grid of 10 bps bins) and a yield-bearing receipt (lUSDCb, USDC in DeFindex/Blend) traded on the SDEX. " +
      "Start with lotus_health. Prices are USDC per LBOND. Build tools return unsigned XDR for the user's wallet; pass the signed XDR to lotus_submit. " +
      "New account flow: friendbot -> lotus_build_trustlines -> lotus_faucet_claim (authorizes LBOND, sends LBOND/USDC/lUSDCb) -> trade. " +
      "Never cancel offers that are not the user's own (a market-making bot runs on testnet).",
  },
);

server.registerTool(
  "lotus_health",
  {
    title: "Health check",
    description: "Checks every endpoint Lotus depends on: the app URL, its /api/config and /api/faucet, Soroban RPC, Horizon, and each pool / vault contract (simulated reads). Run this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const checks: { name: string; ok: boolean; ms: number; detail: string }[] = [];
    const time = async (name: string, f: () => Promise<string>) => {
      const t = Date.now();
      try {
        checks.push({ name, ok: true, ms: Date.now() - t, detail: await f() });
      } catch (e) {
        checks.push({ name, ok: false, ms: Date.now() - t, detail: e instanceof Error ? e.message : String(e) });
      }
      checks[checks.length - 1].ms = Date.now() - t;
    };
    await time(`app ${APP_URL}`, async () => {
      const r = await fetch(APP_URL, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return `HTTP ${r.status}`;
    });
    let l: Lotus | null = null;
    await time(DEPLOYMENTS_DIR ? `config ${DEPLOYMENTS_DIR}` : `config ${APP_URL}/api/config`, async () => {
      l = await lotus(true);
      return `${l.config.network}, ${l.config.pools.length} pools, ${l.config.strategies.length} strategies, receipt ${l.config.receipt.code}`;
    });
    await time(`faucet ${APP_URL}/api/faucet`, async () => {
      const r = await fetch(`${APP_URL}/api/faucet`, { signal: AbortSignal.timeout(15000) });
      const j = (await r.json()) as { enabled?: boolean; assets?: { code: string; configured: boolean }[] };
      if (!r.ok || !j.enabled) throw new Error(`HTTP ${r.status}, enabled=${j.enabled}`);
      return `enabled: ${(j.assets ?? []).map((a) => `${a.code}${a.configured ? "" : " (not configured)"}`).join(", ")}`;
    });
    if (l) {
      const L: Lotus = l;
      await time(`rpc ${L.config.rpc}`, async () => {
        const s = rpcServer(L.config.rpc);
        const [h, n, led] = await Promise.all([s.getHealth(), s.getNetwork(), s.getLatestLedger()]);
        if (n.passphrase !== L.config.passphrase) throw new Error(`network mismatch: ${n.passphrase}`);
        return `${h.status}, ledger ${led.sequence}`;
      });
      await time(`horizon ${L.config.horizon}`, async () => {
        const r = await fetch(L.config.horizon, { signal: AbortSignal.timeout(15000) });
        const j = (await r.json()) as { network_passphrase?: string; history_latest_ledger?: number };
        if (j.network_passphrase !== L.config.passphrase) throw new Error(`network mismatch: ${j.network_passphrase}`);
        return `ledger ${j.history_latest_ledger}`;
      });
      await Promise.all(
        L.pools().map((p) =>
          time(`pool ${p.id} ${p.contract}`, async () => {
            const r = L.reader(p);
            const [abi, c] = await Promise.all([r.abiVersion(), r.getConfig()]);
            if ((c.vault ?? null) !== (p.vault ?? null)) throw new Error(`vault mismatch: contract ${c.vault}, config ${p.vault}`);
            return `abi ${abi}, step ${c.binStepBps} bps, fee ${c.feeBps} bps, ${c.vault ? "vault-backed" : "idle USDC"}${c.supportsTwoWay ? ", two-way" : ""}`;
          }),
        ),
      );
      await time(`lotus_vault ${L.config.lotusVault}`, async () => {
        const v = await L.vaultStats();
        if (v.errors.length) throw new Error(v.errors.join("; "));
        return `supply ${amt(v.supply ?? 0n)} ${L.config.receipt.code}, value ${amt(v.vaultValue ?? 0n)} USDC, surplus ${amt(v.surplus ?? 0n)}`;
      });
    }
    const bad = checks.filter((c) => !c.ok);
    return {
      status: bad.length === 0 ? "all green" : `${bad.length} check(s) failing`,
      signing: signerNote,
      checks: checks.map((c) => `${c.ok ? "OK  " : "FAIL"} ${c.name} (${c.ms} ms): ${c.detail}`),
    };
  }),
);

server.registerTool(
  "lotus_config",
  {
    title: "Deployment config",
    description: "The live deployment config: network, RPC / Horizon, assets (LBOND, USDC, receipt), pool instances, Lotus vault strategies, named public accounts. Public data only.",
    inputSchema: { refresh: z.boolean().optional().describe("re-fetch the config now") },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ refresh }: { refresh?: boolean }) => {
    const l = await lotus(!!refresh);
    const c = l.config;
    return {
      network: c.network,
      passphrase: c.passphrase,
      rpc: c.rpc,
      horizon: c.horizon,
      app: DEPLOYMENTS_DIR ? null : APP_URL,
      assets: { base: c.rwa, quote: c.underlying, receipt: c.receipt },
      lotus_vault: { contract: c.lotusVault, link: l.contractUrl(c.lotusVault), defindex_vault: c.defindexVault, blend_pool: c.blendPool },
      pools: l.pools({ includeRetired: true }).map((p) => ({ id: p.id, label: p.label, status: p.status, contract: p.contract, vault: p.vault, step_bps: p.binStepBps, fee_bps: p.feeBps, two_way: p.supportsTwoWay, link: l.contractUrl(p.contract) })),
      strategies: c.strategies.map((s) => ({ id: s.id, label: s.label, status: s.status, lotus_vault: s.lotusVault || null, receipt: s.receipt.code, observed_apr_pct: s.observed?.aprPct })),
      accounts: c.accounts,
      range_order_strategies: STRATEGIES.map((s) => `${s.id}: ${s.label}`),
      signing: signerNote,
      loaded_at: c.loadedAt,
    };
  }),
);

server.registerTool(
  "lotus_markets",
  {
    title: "SDEX markets",
    description: "The SDEX markets of the deployment with best bid / ask / mid: LBOND/receipt (bond), receipt/USDC (peg), LBOND/USDC (cash).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const l = await lotus();
    return Promise.all(
      l.markets().map(async (m) => {
        const ob = await l.orderbook(m.id, 1).catch(() => null);
        const k = (a: { code: string; issuer: string | null }) => (a.issuer ? `${a.code}:${a.issuer}` : a.code);
        return { id: m.id, kind: m.kind, vault: m.strategyId, base: k(m.base), quote: k(m.quote), bid: ob?.bid ?? null, ask: ob?.ask ?? null, mid: ob?.mid ?? null, about: m.blurb };
      }),
    );
  }),
);

server.registerTool(
  "lotus_orderbook",
  {
    title: "Order book",
    description: "Horizon order book of one SDEX market (asks: amount in base; bids: amount in quote, Horizon convention), plus recent trades.",
    inputSchema: {
      market: z.string().describe('market id, e.g. "LBOND-USDC", "LBOND-lUSDCb", "lUSDCb-USDC" (see lotus_markets)'),
      depth: z.number().int().min(1).max(50).optional().describe("levels per side (default 10)"),
      trades: z.number().int().min(0).max(50).optional().describe("recent trades (default 5)"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ market, depth, trades }: { market: string; depth?: number; trades?: number }) => {
    const l = await lotus();
    const ob = await l.orderbook(market, depth ?? 10);
    const tr = (trades ?? 5) > 0 ? await l.trades(market, trades ?? 5).catch(() => []) : [];
    const lv = (x: { price: string; amount: string }) => `${x.price} x ${x.amount}`;
    return {
      market: ob.market.id,
      bid: ob.bid,
      ask: ob.ask,
      mid: ob.mid,
      spread: ob.spread,
      asks: ob.book.asks.map(lv),
      bids: ob.book.bids.map(lv),
      recent_trades: tr.map((t) => `${t.time} ${t.baseIsSeller ? "sell" : "buy"} ${t.baseAmount} @ ${t.price.toFixed(7)}`),
    };
  }),
);

server.registerTool(
  "lotus_pools",
  {
    title: "Pool instances",
    description: "Every Lotus pool instance with its on-chain config, TVL, best bid / ask of its bins and non-empty depth; plus the Lotus vault (supply, value, surplus) and the yield (observed APR; live Blend APR on request).",
    inputSchema: {
      bins: z.boolean().optional().describe("include the non-empty bins (default false)"),
      live_apr: z.boolean().optional().describe("measure the live Blend supply APR (two reads ~12 s apart, slower)"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ bins, live_apr }: { bins?: boolean; live_apr?: boolean }) => {
    const l = await lotus();
    const pools = await Promise.all(
      l.pools().map(async (p) => {
        const r = l.reader(p);
        const [c, tvl, asks, bidsRows] = await Promise.all([r.getConfig(), r.tvl().catch(() => null), r.depth("Ask").catch(() => []), r.depth("Bid").catch(() => [])]);
        return {
          id: p.id,
          label: p.label,
          contract: p.contract,
          link: l.contractUrl(p.contract),
          step_bps: c.binStepBps,
          fee_bps: c.feeBps,
          max_bins_per_swap: c.maxBinsPerSwap,
          vault: c.vault,
          two_way: c.supportsTwoWay,
          tvl: tvl ? { base: amt(tvl.base), quote_value: amt(tvl.quoteValue), vault_shares: amt(tvl.vaultShares) } : null,
          best_ask: asks[0] ? amt(asks[0].price) : null,
          best_bid: bidsRows.length ? amt(bidsRows[bidsRows.length - 1].price) : null,
          ask_bins: asks.length,
          bid_bins: bidsRows.length,
          depth: bins
            ? {
                asks: asks.map((b) => `bin ${b.bin} @ ${amt(b.price)}: ${amt(b.inventory)} ${p.base.code}`),
                bids: bidsRows.map((b) => `bin ${b.bin} @ ${amt(b.price)}: ${amt(b.inventory)} ${p.quote.code}`),
              }
            : undefined,
        };
      }),
    );
    const v = await l.vaultStats().catch(() => null);
    const apr = live_apr ? await l.blendApr().catch((e) => ({ error: e instanceof Error ? e.message : String(e) })) : undefined;
    return {
      pools,
      lotus_vault: v ? { contract: l.config.lotusVault, supply: amt(v.supply ?? 0n), vault_value: amt(v.vaultValue ?? 0n), surplus: amt(v.surplus ?? 0n), receipt: l.config.receipt.code } : null,
      yield: { observed: l.observedApr(), live_blend_apr: apr, note: "testnet observation, not a forecast; BLND emissions not counted" },
      grid: "price(bin) = 1.001^bin USDC per LBOND (10 bps bins, -200..200); a position spans <= 64 bins",
    };
  }),
);

server.registerTool(
  "lotus_quote_swap",
  {
    title: "Quote a pool swap",
    description: "quote_swap (simulation) on the Lotus pool: buy LBOND with USDC (side buy) or sell LBOND for USDC (side sell). Without `pool`, quotes every directional instance and picks the best.",
    inputSchema: {
      side: z.enum(["buy", "sell"]).describe("buy = pay USDC, receive LBOND; sell = pay LBOND, receive USDC"),
      amount_in: decimal.describe("input amount (USDC for buy, LBOND for sell), fee included"),
      pool: z.string().optional().describe("pool id (lotus_pools); default: best directional instance"),
    },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ side, amount_in, pool }: { side: "buy" | "sell"; amount_in: string; pool?: string }) => {
    const l = await lotus();
    const q = await l.quoteSwap({ buyBase: side === "buy", amountIn: amount_in, pool });
    return {
      best: q.best ? q.best.pool.id : null,
      quotes: q.all.map((x) =>
        x.quote
          ? { pool: x.pool.id, amount_out: amt(x.quote.amountOut), fee: amt(x.quote.fee), avg_price: amt(x.quote.avgPrice), bins_crossed: x.quote.binsCrossed, partial: x.quote.partial }
          : { pool: x.pool.id, error: x.error },
      ),
    };
  }),
);

server.registerTool(
  "lotus_account",
  {
    title: "Account balances",
    description: "Balances of an account (available vs committed to offers), trustline authorization, XLM.",
    inputSchema: { account: accountArg },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ account }: { account?: string }) => {
    const l = await lotus();
    const a = requireAccount(account);
    const acct = await l.account(a);
    if (!acct) return { account: a, exists: false, fund: `https://friendbot.stellar.org/?addr=${a}` };
    return {
      account: a,
      link: l.accountUrl(a),
      subentries: acct.subentry_count,
      balances: acct.balances.map((b) => ({
        asset: b.asset_type === "native" ? "XLM" : `${b.asset_code}:${b.asset_issuer}`,
        balance: b.balance,
        in_offers: b.selling_liabilities && Number(b.selling_liabilities) > 0 ? b.selling_liabilities : undefined,
        authorized: b.asset_type === "native" ? undefined : b.is_authorized !== false,
      })),
    };
  }),
);

server.registerTool(
  "lotus_positions",
  {
    title: "Pool positions",
    description: "Open Lotus pool positions of an account on every instance (retired ones included), with fill progress and claimable amounts.",
    inputSchema: { account: accountArg },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ account }: { account?: string }) => {
    const l = await lotus();
    const a = requireAccount(account);
    const { rows, errors } = await l.positions(a);
    return {
      account: a,
      positions: rows.map((p) => {
        const inst = l.pool(p.poolId);
        const [inv, proc] = p.side === "Ask" ? [inst.base.code, inst.quote.code] : [inst.quote.code, inst.base.code];
        const pct = p.deposited > 0n ? Number((p.filled * 10000n) / p.deposited) / 100 : 0;
        return {
          pool: p.poolId,
          id: String(p.id),
          side: p.side,
          mode: p.mode,
          bins: `${p.loBin}..${p.hiBin} (${amt(priceAt(p.loBin, inst.binStepBps))} to ${amt(priceAt(p.hiBin, inst.binStepBps))})`,
          deposited: `${amt(p.deposited)} ${inv}`,
          remaining: `${amt(p.inventory)} ${inv}`,
          filled_pct: pct,
          pending_proceeds: `${amt(p.pendingProceeds)} ${p.mode === "TwoWay" ? inst.quote.code : proc}`,
          pending_fees: `${amt(p.pendingFees)} ${inst.quote.code}`,
          vaulted: p.vaulted,
          retired_pool: p.retired || undefined,
          link: l.contractUrl(p.pool),
        };
      }),
      errors: errors.length ? errors : undefined,
    };
  }),
);

server.registerTool(
  "lotus_offers",
  {
    title: "Open SDEX offers",
    description: "Open SDEX offers of an account (Horizon).",
    inputSchema: { account: accountArg },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ account }: { account?: string }) => {
    const l = await lotus();
    const a = requireAccount(account);
    const offers = await l.offers(a);
    return {
      account: a,
      count: offers.length,
      offers: offers.map((o) => ({ id: o.id, sell: `${o.amount} ${o.selling.code}`, for: o.buying.code, price: o.price, link: l.offerUrl(o.id) })),
    };
  }),
);

// ---- builders ---------------------------------------------------------------------------------------------------

server.registerTool(
  "lotus_build_trustlines",
  {
    title: "Build trustlines",
    description: "changeTrust for the assets the account is missing (default: USDC, LBOND and the active receipt), one classic transaction. LBOND is AUTH_REQUIRED: lotus_faucet_claim then authorizes it.",
    inputSchema: {
      account: accountArg,
      assets: z.array(z.string()).optional().describe('asset codes to add, e.g. ["USDC","LBOND"] (default: all three)'),
      submit: submitArg,
    },
  },
  tool(async ({ account, assets, submit }: { account?: string; assets?: string[]; submit?: boolean }) => {
    const l = await lotus();
    const all = l.assets();
    const pick = assets?.length
      ? assets.map((code) => {
          const a = [all.quote, all.base, all.receipt, ...l.config.strategies.map((s) => ({ code: s.receipt.code, issuer: s.receipt.issuer }))].find((x) => x.code.toLowerCase() === code.toLowerCase() && x.issuer);
          if (!a) throw new Error(`unknown asset code ${code}`);
          return a;
        })
      : undefined;
    return deliver(l, await l.buildTrustlines({ account: requireAccount(account), assets: pick }), submit);
  }),
);

server.registerTool(
  "lotus_faucet_claim",
  {
    title: "Testnet faucet",
    description: "Calls the app's /api/faucet for an account: authorizes the LBOND trustline and sends 500 LBOND, 200 USDC and 50 of the active receipt (once per address). The account needs the trustlines first (lotus_build_trustlines).",
    inputSchema: { account: accountArg },
  },
  tool(async ({ account }: { account?: string }) => {
    const l = await lotus();
    const a = requireAccount(account);
    const r = await Lotus.faucetClaim(APP_URL, a);
    return {
      ok: r.ok,
      status: r.status,
      error: r.error,
      results: (r.results ?? []).map((x) => ({ asset: x.code, amount: x.amount, status: x.status, message: x.message, link: x.hash ? l.txUrl(x.hash) : undefined })),
    };
  }),
);

server.registerTool(
  "lotus_build_swap",
  {
    title: "Build a pool swap",
    description: "swap() on the Lotus pool, re-quoted now with min_out from the slippage. buy = pay USDC for LBOND, sell = pay LBOND for USDC. Needs authorized trustlines for both assets.",
    inputSchema: {
      account: accountArg,
      side: z.enum(["buy", "sell"]),
      amount_in: decimal.describe("maximum input (USDC for buy, LBOND for sell), fee included"),
      slippage_bps: z.number().int().min(0).max(5000).optional().describe("default 50 (0.5%)"),
      pool: z.string().optional().describe("pool id; default: best quote among the directional instances"),
      submit: submitArg,
    },
  },
  tool(async (a: { account?: string; side: "buy" | "sell"; amount_in: string; slippage_bps?: number; pool?: string; submit?: boolean }) => {
    const l = await lotus();
    return deliver(l, await l.buildSwap({ account: requireAccount(a.account), buyBase: a.side === "buy", amountIn: a.amount_in, slippageBps: a.slippage_bps, pool: a.pool }), a.submit);
  }),
);

server.registerTool(
  "lotus_build_range_order",
  {
    title: "Build a range limit order",
    description:
      "One directional range limit order over a price range (10 bps bins), placed where you choose: " +
      "pool (Lotus pool, USDC idle), pool-yield (vault-backed pool, USDC leg earns Blend), sdex (one SDEX offer per bin on LBOND/USDC), sdex-yield (offers quoted in the receipt; a Bid deposits USDC first = 2 transactions). " +
      "Same rules as the app: a sell (Ask) range at or above the venue's price, a buy (Bid) range at or below it; pool-yield refuses a Bid within 10 bins of the price; at most 64 bins (50 on the SDEX). " +
      "Omit `strategy` to only evaluate the four destinations.",
    inputSchema: {
      account: accountArg,
      side: z.enum(["Ask", "Bid"]).describe("Ask = sell LBOND as the price rises; Bid = buy LBOND with USDC as the price falls"),
      start_price: decimal.describe("price nearest to the market (lowest for Ask, highest for Bid), USDC per LBOND"),
      end_price: decimal.describe("far end of the range (highest for Ask, lowest for Bid)"),
      amount: decimal.describe("amount sold: LBOND for Ask, USDC for Bid"),
      strategy: z.enum(["pool", "pool-yield", "sdex", "sdex-yield"]).optional(),
      shape: z.enum(["uniform", "start", "end"]).optional().describe("weight: uniform (default), heavier at the start, or at the end"),
      submit: submitArg,
    },
  },
  tool(async (a: { account?: string; side: "Ask" | "Bid"; start_price: string; end_price: string; amount: string; strategy?: "pool" | "pool-yield" | "sdex" | "sdex-yield"; shape?: "uniform" | "start" | "end"; submit?: boolean }) => {
    const l = await lotus();
    const input = { account: requireAccount(a.account), side: a.side, startPrice: a.start_price, endPrice: a.end_price, amount: a.amount, shape: a.shape };
    if (!a.strategy) {
      const ev = await l.evaluateRangeOrder(input);
      return {
        plan: ev.plan.ok
          ? { bins: `${ev.plan.loBin}..${ev.plan.hiBin}`, count: ev.plan.bins.length, lo_price: amt(ev.plan.bins[0].price), hi_price: amt(ev.plan.bins[ev.plan.bins.length - 1].price), deposit: amt(ev.plan.deposit) }
          : { errors: ev.plan.errors },
        strategies: ev.destinations.map((d) => ({ strategy: d.id, available: !d.blockedBy, why_not: d.blockedBy ?? undefined, signatures: d.signatures, reference: { price: Number(d.ref.price.toFixed(7)), source: d.ref.source }, crossing_levels: d.crossing || undefined, summary: d.summary })),
      };
    }
    return deliver(l, await l.buildRangeOrder({ ...input, strategy: a.strategy }), a.submit);
  }),
);

server.registerTool(
  "lotus_build_limit_order",
  {
    title: "Build an SDEX limit order",
    description: "One manageSellOffer on an SDEX market: sell or buy `amount` base at `price` (quote per base).",
    inputSchema: {
      account: accountArg,
      market: z.string().describe('market id, e.g. "LBOND-USDC" (lotus_markets)'),
      side: z.enum(["buy", "sell"]),
      price: decimal.describe("quote per base"),
      amount: decimal.describe("amount of base"),
      submit: submitArg,
    },
  },
  tool(async (a: { account?: string; market: string; side: "buy" | "sell"; price: string; amount: string; submit?: boolean }) => {
    const l = await lotus();
    return deliver(l, await l.buildLimitOrder({ account: requireAccount(a.account), market: a.market, side: a.side, price: a.price, amount: a.amount }), a.submit);
  }),
);

server.registerTool(
  "lotus_build_cancel_offer",
  {
    title: "Build an offer cancel",
    description: "Cancel one of the account's OWN open SDEX offers (lotus_offers). Refuses an offer id that is not the account's.",
    inputSchema: { account: accountArg, offer_id: z.string().regex(/^\d+$/), submit: submitArg },
  },
  tool(async (a: { account?: string; offer_id: string; submit?: boolean }) => {
    const l = await lotus();
    return deliver(l, await l.buildCancelOffer({ account: requireAccount(a.account), offerId: a.offer_id }), a.submit);
  }),
);

const positionArgs = {
  account: accountArg,
  pool: z.string().describe("pool id or contract (from lotus_positions)"),
  position_id: z.string().regex(/^\d+$/),
  submit: submitArg,
};
server.registerTool(
  "lotus_build_claim",
  {
    title: "Build a claim",
    description: "claim(): pay a pool position's pending proceeds and fees, keep the position open.",
    inputSchema: positionArgs,
  },
  tool(async (a: { account?: string; pool: string; position_id: string; submit?: boolean }) => {
    const l = await lotus();
    return deliver(l, await l.buildClaim({ account: requireAccount(a.account), pool: a.pool, positionId: a.position_id }), a.submit);
  }),
);
server.registerTool(
  "lotus_build_remove",
  {
    title: "Build a remove",
    description: "remove_position(): pay the unfilled inventory + pending proceeds + fees and close the position. Works on-chain at any fill level (the app's lock until filled is UI only).",
    inputSchema: positionArgs,
  },
  tool(async (a: { account?: string; pool: string; position_id: string; submit?: boolean }) => {
    const l = await lotus();
    return deliver(l, await l.buildRemove({ account: requireAccount(a.account), pool: a.pool, positionId: a.position_id }), a.submit);
  }),
);

const vaultArgs = {
  account: accountArg,
  amount: decimal,
  strategy: z.string().optional().describe("Lotus vault strategy id (default: the active vault)"),
  submit: submitArg,
};
server.registerTool(
  "lotus_build_deposit",
  {
    title: "Build a vault deposit",
    description: "lotus_vault.deposit: USDC into the Lotus vault (DeFindex -> Blend), the receipt (lUSDCb) minted 1:1. Needs the receipt trustline.",
    inputSchema: vaultArgs,
  },
  tool(async (a: { account?: string; amount: string; strategy?: string; submit?: boolean }) => {
    const l = await lotus();
    return deliver(l, await l.buildDeposit({ account: requireAccount(a.account), amount: a.amount, strategy: a.strategy }), a.submit);
  }),
);
server.registerTool(
  "lotus_build_redeem",
  {
    title: "Build a vault redeem",
    description: "lotus_vault.redeem: burn the receipt, receive USDC (1:1 while fully backed).",
    inputSchema: vaultArgs,
  },
  tool(async (a: { account?: string; amount: string; strategy?: string; submit?: boolean }) => {
    const l = await lotus();
    return deliver(l, await l.buildRedeem({ account: requireAccount(a.account), amount: a.amount, strategy: a.strategy }), a.submit);
  }),
);

server.registerTool(
  "lotus_submit",
  {
    title: "Submit signed transaction(s)",
    description:
      "Submit signed XDR (Soroban via RPC, classic via Horizon) and wait for the result. Pass several in order for a multi-transaction build: each is sent only after the previous succeeded. " +
      "With LOTUS_SECRET, `sign: true` signs unsigned XDR of that account first and a vault footprint race is rebuilt and re-signed automatically.",
    inputSchema: {
      signed_xdr: z.union([z.string(), z.array(z.string()).min(1).max(5)]).describe("one signed transaction envelope (base64), or several in order"),
      sign: z.boolean().optional().describe("sign with the server key first (LOTUS_SECRET mode only)"),
    },
  },
  tool(async ({ signed_xdr, sign }: { signed_xdr: string | string[]; sign?: boolean }) => {
    const l = await lotus();
    let list = Array.isArray(signed_xdr) ? signed_xdr : [signed_xdr];
    if (sign) {
      if (!signer) throw new Error("sign: true needs LOTUS_SECRET (testnet) on this MCP server");
      const sg = signer;
      list = await Promise.all(list.map((x) => sg.sign(x, l.config.passphrase)));
    }
    return sequenceOut(l, await l.submit(list, { signer: signer ?? undefined }));
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (v${VERSION}, config ${DEPLOYMENTS_DIR ?? `${APP_URL}/api/config`}, signing ${signer ? `on for ${signer.publicKey}` : "off"})`);
