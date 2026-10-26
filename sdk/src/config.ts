// Config loader. Two sources, same result shape (LotusConfig, src/shared/config-types.ts = web/lib/config-types.ts):
//   - the live app:        GET <appUrl>/api/config   (default https://lotus-stellar.vercel.app)
//   - a deployments dir:   deployments/testnet.{contract,classic,strategies,pool}.json  (public files only;
//                          *.secrets.json are never read)
// The directory parser is a port of web/lib/config.ts loadConfig (same defaults and filters).

import type { AssetCfg, LotusConfig, PoolInstance, PoolStatus, Strategy, StrategyStatus } from "./shared/config-types.ts";
import type { NetCfg } from "./net.ts";

export type { AssetCfg, LotusConfig, PoolInstance, PoolStatus, Strategy, StrategyStatus } from "./shared/config-types.ts";

export const DEFAULT_APP_URL = "https://lotus-stellar.vercel.app";

export type LoadConfigOptions = {
  /** Base URL of a running Lotus app (its /api/config is used). Default DEFAULT_APP_URL unless deploymentsDir is set. */
  appUrl?: string;
  /** Read deployments/*.json from this directory instead of the app (Node only). */
  deploymentsDir?: string;
  /** Override the RPC / Horizon endpoints of the config. */
  rpcUrl?: string;
  horizonUrl?: string;
  /** fetch timeout in ms (default 15000) */
  timeoutMs?: number;
};

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LotusConfig> {
  const cfg = opts.deploymentsDir ? await loadConfigFromDir(opts.deploymentsDir) : await loadConfigFromApp(opts.appUrl ?? DEFAULT_APP_URL, opts.timeoutMs);
  return {
    ...cfg,
    rpc: opts.rpcUrl || cfg.rpc,
    horizon: opts.horizonUrl || cfg.horizon,
  };
}

export const netOf = (c: Pick<LotusConfig, "rpc" | "horizon" | "passphrase">): NetCfg => ({ rpc: c.rpc, horizon: c.horizon, passphrase: c.passphrase });

export async function loadConfigFromApp(appUrl: string, timeoutMs = 15_000): Promise<LotusConfig> {
  const url = `${appUrl.replace(/\/+$/, "")}/api/config`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const j = (await res.json()) as LotusConfig;
  if (!j || typeof j !== "object" || !j.passphrase || !Array.isArray(j.pools)) throw new Error(`GET ${url}: not a Lotus config`);
  return j;
}

// ---------------------------------------------------------------------------
// deployments dir (port of web/lib/config.ts)
// ---------------------------------------------------------------------------

type ContractFile = {
  network?: string;
  rpc?: string;
  horizon?: string;
  passphrase?: string;
  lotus_vault_contract?: string;
  underlying?: AssetCfg;
  receipt?: AssetCfg;
  defindex_vault?: string;
  defindex_strategy?: string;
  blend_pool?: string;
  observed_apr?: { summary?: unknown; measured_on?: unknown; window_b?: { lotus_net_apr_pct?: unknown } };
  accounts?: Record<string, unknown>;
};
type ClassicFile = { rwa?: { code: string; issuer: string }; accounts?: Record<string, unknown> };

const TESTNET_DEFAULTS = {
  network: "testnet",
  rpc: "https://soroban-testnet.stellar.org",
  horizon: "https://horizon-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
};
const NATIVE: AssetCfg = { code: "XLM", issuer: null };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isC = (v: string) => /^C[A-Z2-7]{55}$/.test(v);

function publicAccounts(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const isPub = (v: unknown): v is string => typeof v === "string" && /^G[A-Z2-7]{55}$/.test(v);
  for (const [name, v] of Object.entries(raw ?? {})) {
    if (isPub(v)) out[name] = v;
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const pk = [o.public, o.publicKey, o.public_key, o.address, o.id].find(isPub);
      if (pk) out[name] = pk;
    }
  }
  return out;
}

function normalizeAsset(a: Partial<AssetCfg> | undefined, fallback: AssetCfg): AssetCfg {
  if (!a) return fallback;
  const issuer = a.issuer && a.issuer.length > 0 ? a.issuer : null;
  const code = a.code && a.code.length > 0 ? a.code : issuer ? fallback.code : "XLM";
  return { code, issuer, sac: a.sac ?? "" };
}

function parseStrategy(raw: unknown, idx: number, fu: AssetCfg, fr: AssetCfg): Strategy | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const lotusVault = str(o.lotus_vault_contract) || str(o.lotusVault) || str(o.contract);
  const rawStatus = str(o.status);
  const status: StrategyStatus = rawStatus === "live" || rawStatus === "idle" || rawStatus === "coming-soon" ? rawStatus : "idle";
  if (!isC(lotusVault) && status !== "coming-soon") return null;
  const u = normalizeAsset(o.underlying as Partial<AssetCfg> | undefined, fu);
  const r = normalizeAsset(o.receipt as Partial<AssetCfg> | undefined, fr);
  const stratRaw = o.defindex_strategy ?? o.defindexStrategy;
  return {
    id: str(o.id) || `strategy-${idx + 1}`,
    label: str(o.label) || `${u.code} vault ${idx + 1}`,
    status,
    lotusVault: isC(lotusVault) ? lotusVault : "",
    underlying: u,
    receipt: r,
    defindexVault: str(o.defindex_vault) || str(o.defindexVault),
    defindexStrategy: typeof stratRaw === "string" && stratRaw.length > 0 ? stratRaw : null,
    blendPool: str(o.blend_pool) || str(o.blendPool),
    notes: str(o.notes),
    origin: "file",
  };
}

function parsePool(raw: unknown, idx: number, fb: AssetCfg, fq: AssetCfg): PoolInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const contract = str(o.contract) || str(o.pool_contract) || str(o.lotus_pool_contract);
  const rawStatus = str(o.status);
  const status: PoolStatus = rawStatus === "live" || rawStatus === "idle" || rawStatus === "coming-soon" || rawStatus === "retired" ? rawStatus : "live";
  if (!isC(contract) && status !== "coming-soon") return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const vault = str(o.vault);
  return {
    id: str(o.id) || `pool-${idx + 1}`,
    label: str(o.label) || `Lotus pool ${idx + 1}`,
    status,
    contract: isC(contract) ? contract : "",
    base: normalizeAsset(o.base as Partial<AssetCfg> | undefined, fb),
    quote: normalizeAsset(o.quote as Partial<AssetCfg> | undefined, fq),
    vault: isC(vault) ? vault : null,
    strategyId: str(o.strategy_id) || null,
    binStepBps: num(o.bin_step_bps, 10),
    feeBps: num(o.fee_bps, 30),
    supportsTwoWay: o.supports_two_way === true,
    mock: false,
  };
}

/** Parse the four public deployment files (already read) into a LotusConfig. Pure, unit-tested. */
export function parseDeployments(files: {
  contract?: ContractFile | null;
  classic?: ClassicFile | null;
  strategies?: { strategies?: unknown[] } | null;
  pools?: { pools?: unknown[]; retired_pools?: unknown[] } | null;
  sources?: Partial<LotusConfig["sources"]>;
}): LotusConfig {
  const c: ContractFile = files.contract ?? {};
  const k: ClassicFile = files.classic ?? {};
  const underlying = normalizeAsset(c.underlying, NATIVE);
  const receipt = normalizeAsset(c.receipt, NATIVE);

  let strategies: Strategy[] = [];
  if (files.strategies && Array.isArray(files.strategies.strategies)) {
    const seen = new Set<string>();
    strategies = files.strategies.strategies
      .map((s, i) => parseStrategy(s, i, underlying, receipt))
      .filter((s): s is Strategy => s !== null)
      .map((s, i) => {
        let id = s.id;
        while (seen.has(id)) id = `${s.id}-${i + 1}`;
        seen.add(id);
        return { ...s, id };
      });
  }
  if (strategies.length === 0 && isC(c.lotus_vault_contract || "")) {
    strategies = [
      {
        id: "usdc-vault-v1",
        label: `${underlying.code} vault v1`,
        status: "idle",
        lotusVault: c.lotus_vault_contract as string,
        underlying,
        receipt,
        defindexVault: c.defindex_vault || "",
        defindexStrategy: c.defindex_strategy || null,
        blendPool: c.blend_pool || "",
        notes: "Derived from testnet.contract.json.",
        origin: "derived",
      },
    ];
  }
  const obs = c.observed_apr;
  if (obs && typeof obs.summary === "string" && typeof obs.measured_on === "string") {
    strategies = strategies.map((st) =>
      st.lotusVault && st.lotusVault === c.lotus_vault_contract
        ? {
            ...st,
            observed: {
              summary: obs.summary as string,
              measuredOn: obs.measured_on as string,
              aprPct: typeof obs.window_b?.lotus_net_apr_pct === "number" ? (obs.window_b.lotus_net_apr_pct as number) : undefined,
            },
          }
        : st,
    );
  }

  const rwa: AssetCfg = { code: k.rwa?.code || "LBOND", issuer: k.rwa?.issuer || null };
  let pools: PoolInstance[] = [];
  let retiredPools: PoolInstance[] = [];
  if (files.pools && Array.isArray(files.pools.pools)) {
    const parsed = files.pools.pools.map((p, i) => parsePool(p, i, rwa, underlying)).filter((p): p is PoolInstance => p !== null);
    pools = parsed.filter((p) => p.status !== "retired");
    retiredPools = parsed.filter((p) => p.status === "retired");
  }
  if (files.pools && Array.isArray(files.pools.retired_pools)) {
    retiredPools = [
      ...retiredPools,
      ...files.pools.retired_pools
        .map((p, i) => parsePool(p, i, rwa, underlying))
        .filter((p): p is PoolInstance => p !== null)
        .map((p) => ({ ...p, status: "retired" as const })),
    ];
  }

  return {
    network: c.network || TESTNET_DEFAULTS.network,
    rpc: c.rpc || TESTNET_DEFAULTS.rpc,
    horizon: c.horizon || TESTNET_DEFAULTS.horizon,
    passphrase: c.passphrase || TESTNET_DEFAULTS.passphrase,
    lotusVault: c.lotus_vault_contract || "",
    underlying,
    receipt,
    rwa,
    defindexVault: c.defindex_vault || "",
    blendPool: c.blend_pool || "",
    strategies,
    pools,
    retiredPools,
    accounts: { ...publicAccounts(c.accounts), ...publicAccounts(k.accounts) },
    sources: {
      contract: files.sources?.contract ?? "none",
      classic: files.sources?.classic ?? "none",
      strategies: files.sources?.strategies ?? "none",
      pools: files.sources?.pools ?? "none",
    },
    loadedAt: new Date().toISOString(),
  };
}

export async function loadConfigFromDir(dir: string): Promise<LotusConfig> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (f: string) => {
    if (/secrets/i.test(f)) throw new Error("refusing to read a secrets file");
    const p = path.join(dir, f);
    try {
      return fs.existsSync(p) ? { data: JSON.parse(fs.readFileSync(p, "utf8")), source: p } : null;
    } catch {
      return null;
    }
  };
  const contract = read("testnet.contract.json");
  if (!contract) throw new Error(`${path.join(dir, "testnet.contract.json")} not found or unreadable`);
  const classic = read("testnet.classic.json");
  const strategies = read("testnet.strategies.json");
  const pools = read("testnet.pool.json");
  return parseDeployments({
    contract: contract.data,
    classic: classic?.data,
    strategies: strategies?.data,
    pools: pools?.data,
    sources: { contract: contract.source, classic: classic?.source, strategies: strategies?.source, pools: pools?.source },
  });
}
