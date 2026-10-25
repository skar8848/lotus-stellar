// Server-only config loader.
//
// Reads ../deployments/testnet.contract.json, testnet.classic.json and (optionally)
// testnet.strategies.json at REQUEST time, and falls back, per file, to web/config.example.json
// so the app always builds and runs even before anything is deployed.
//
// Never import this from a client component: it uses node:fs. Server components and the
// /api/config route read it and hand the result to the client as plain JSON.

import fs from "node:fs";
import path from "node:path";
import example from "../config.example.json";
import type { AssetCfg, LotusConfig, PoolInstance, PoolStatus, Strategy, StrategyStatus } from "./config-types";

export type { AssetCfg, LotusConfig, PoolInstance, PoolStatus, Strategy, StrategyStatus } from "./config-types";

type ContractFile = {
  network: string;
  rpc: string;
  horizon: string;
  passphrase: string;
  lotus_vault_contract: string;
  underlying: AssetCfg;
  receipt: AssetCfg;
  defindex_vault?: string;
  defindex_strategy?: string;
  blend_pool?: string;
  observed_apr?: { summary?: unknown; measured_on?: unknown };
  accounts?: Record<string, unknown>;
};

type ClassicFile = {
  rwa: { code: string; issuer: string };
  accounts?: Record<string, unknown>;
};

const CONTRACT_FILE = "testnet.contract.json";
const CLASSIC_FILE = "testnet.classic.json";
const STRATEGIES_FILE = "testnet.strategies.json";
const POOLS_FILE = "testnet.pool.json";

function candidateDirs(): string[] {
  const dirs = [
    process.env.LOTUS_DEPLOYMENTS_DIR,
    // `next dev` / `next build` run from web/
    path.resolve(process.cwd(), "..", "deployments"),
    // in case the app is launched from the repo root
    path.resolve(process.cwd(), "deployments"),
  ];
  return dirs.filter((d): d is string => Boolean(d));
}

function readJson<T>(file: string): { data: T; source: string } | null {
  for (const dir of candidateDirs()) {
    const p = path.join(dir, file);
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      return { data: JSON.parse(raw) as T, source: p };
    } catch {
      // unreadable / half-written file while another agent is deploying: try the next candidate
      continue;
    }
  }
  return null;
}

/**
 * Keep only public keys. The deploy scripts may store `{ public, secret }` objects or
 * bare strings per account; this config is passed to client components, so secrets
 * must never get through.
 */
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

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A strategy entry from testnet.strategies.json. Defensive: anything malformed is skipped. */
function parseStrategy(raw: unknown, idx: number, fallbackU: AssetCfg, fallbackR: AssetCfg): Strategy | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const lotusVault = str(o.lotus_vault_contract) || str(o.lotusVault) || str(o.contract);
  const rawStatus = str(o.status);
  const status: StrategyStatus = rawStatus === "live" || rawStatus === "idle" || rawStatus === "coming-soon" ? rawStatus : "idle";
  const validContract = /^C[A-Z2-7]{55}$/.test(lotusVault);
  // An unknown status with no contract is an announcement, not a pool.
  if (!validContract && status !== "coming-soon") return null;
  const u = normalizeAsset(o.underlying as Partial<AssetCfg> | undefined, fallbackU);
  const r = normalizeAsset(o.receipt as Partial<AssetCfg> | undefined, fallbackR);
  const stratRaw = o.defindex_strategy ?? o.defindexStrategy;
  return {
    id: str(o.id) || `strategy-${idx + 1}`,
    label: str(o.label) || `${u.code} vault ${idx + 1}`,
    status,
    lotusVault: validContract ? lotusVault : "",
    underlying: u,
    receipt: r,
    defindexVault: str(o.defindex_vault) || str(o.defindexVault),
    defindexStrategy: typeof stratRaw === "string" && stratRaw.length > 0 ? stratRaw : null,
    blendPool: str(o.blend_pool) || str(o.blendPool),
    notes: str(o.notes),
    origin: "file",
  };
}

/** A pool entry from testnet.pool.json (shape in docs/pool-abi.md). Anything malformed is skipped. */
function parsePool(raw: unknown, idx: number, fallbackBase: AssetCfg, fallbackQuote: AssetCfg): PoolInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const contract = str(o.contract) || str(o.pool_contract) || str(o.lotus_pool_contract);
  const rawStatus = str(o.status);
  const status: PoolStatus =
    rawStatus === "live" || rawStatus === "idle" || rawStatus === "coming-soon" ? rawStatus : "live";
  const validContract = /^C[A-Z2-7]{55}$/.test(contract);
  if (!validContract && status !== "coming-soon") return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const vault = str(o.vault);
  const strategy = str(o.strategy_id);
  return {
    id: str(o.id) || `pool-${idx + 1}`,
    label: str(o.label) || `Lotus pool ${idx + 1}`,
    status,
    contract: validContract ? contract : "",
    base: normalizeAsset(o.base as Partial<AssetCfg> | undefined, fallbackBase),
    quote: normalizeAsset(o.quote as Partial<AssetCfg> | undefined, fallbackQuote),
    vault: /^C[A-Z2-7]{55}$/.test(vault) ? vault : null,
    strategyId: strategy || null,
    binStepBps: num(o.bin_step_bps, 10),
    feeBps: num(o.fee_bps, 30),
    supportsTwoWay: o.supports_two_way === true,
    mock: false,
  };
}

/** Load the merged config. Cheap enough to call on every request. */
export function loadConfig(): LotusConfig {
  const ex = example as { contract: ContractFile; classic: ClassicFile };

  const contract = readJson<ContractFile>(CONTRACT_FILE);
  const classic = readJson<ClassicFile>(CLASSIC_FILE);
  const stratFile = readJson<{ network?: string; strategies?: unknown[] }>(STRATEGIES_FILE);

  const c = contract?.data ?? ex.contract;
  const k = classic?.data ?? ex.classic;

  const underlying = normalizeAsset(c.underlying, ex.contract.underlying);
  const receipt = normalizeAsset(c.receipt, ex.contract.receipt);

  // Strategies: the file wins when it yields at least one usable entry; otherwise derive ONE
  // from testnet.contract.json. The v1 pool deployed on testnet keeps its DeFindex allocation
  // idle (see deployments/testnet.contract.json notes), so the derived status is "idle", never "live".
  let strategies: Strategy[] = [];
  let strategiesSource = "none";
  if (stratFile && Array.isArray(stratFile.data.strategies)) {
    strategies = stratFile.data.strategies
      .map((s, i) => parseStrategy(s, i, underlying, receipt))
      .filter((s): s is Strategy => s !== null);
    // unique ids
    const seen = new Set<string>();
    strategies = strategies.map((s, i) => {
      let id = s.id;
      while (seen.has(id)) id = `${s.id}-${i + 1}`;
      seen.add(id);
      return { ...s, id };
    });
    if (strategies.length > 0) strategiesSource = stratFile.source;
  }
  if (strategies.length === 0 && /^C[A-Z2-7]{55}$/.test(c.lotus_vault_contract || "")) {
    strategies = [
      {
        id: "usdc-vault-v1",
        label: `${underlying.code} vault v1`,
        status: "idle",
        lotusVault: c.lotus_vault_contract,
        underlying,
        receipt,
        defindexVault: c.defindex_vault || "",
        defindexStrategy: c.defindex_strategy || null,
        blendPool: c.blend_pool || "",
        notes: "Derived from testnet.contract.json. The testnet DeFindex vault keeps funds idle: no Blend interest accrues on this vault.",
        origin: "derived",
      },
    ];
    strategiesSource = contract ? `derived from ${contract.source}` : "derived";
  }

  // Observed yield: written by the deployment workflow next to the ACTIVE vault in testnet.contract.json.
  const obs = c.observed_apr;
  if (obs && typeof obs.summary === "string" && typeof obs.measured_on === "string") {
    strategies = strategies.map((st) =>
      st.lotusVault && st.lotusVault === c.lotus_vault_contract ? { ...st, observed: { summary: obs.summary as string, measuredOn: obs.measured_on as string } } : st,
    );
  }

  // Pools: testnet.pool.json when it yields at least one usable entry; otherwise ONE local simulation
  // instance so the pool UI is usable before the contract is deployed (clearly flagged `mock`).
  const rwa: AssetCfg = { code: k.rwa?.code || "LBOND", issuer: k.rwa?.issuer || null };
  const poolFile = readJson<{ pools?: unknown[] }>(POOLS_FILE);
  let pools: PoolInstance[] = [];
  let poolsSource = "none";
  if (poolFile && Array.isArray(poolFile.data.pools)) {
    pools = poolFile.data.pools.map((p, i) => parsePool(p, i, rwa, underlying)).filter((p): p is PoolInstance => p !== null);
    if (pools.length > 0) poolsSource = poolFile.source;
  }
  if (pools.length === 0) {
    pools = [
      {
        id: "local-simulation",
        label: `${rwa.code} / ${underlying.code} (idle ${underlying.code}) - local simulation`,
        status: "idle",
        contract: "",
        base: rwa,
        quote: underlying,
        vault: null,
        strategyId: null,
        binStepBps: 10,
        feeBps: 30,
        supportsTwoWay: false,
        mock: true,
      },
    ];
    poolsSource = "simulation (no testnet.pool.json yet)";
  }

  return {
    network: c.network || ex.contract.network,
    rpc: c.rpc || ex.contract.rpc,
    horizon: c.horizon || ex.contract.horizon,
    passphrase: c.passphrase || ex.contract.passphrase,
    lotusVault: c.lotus_vault_contract || "",
    underlying,
    receipt,
    rwa,
    defindexVault: c.defindex_vault || "",
    blendPool: c.blend_pool || "",
    strategies,
    pools,
    accounts: { ...publicAccounts(c.accounts), ...publicAccounts(k.accounts) },
    sources: {
      contract: contract?.source ?? "example",
      classic: classic?.source ?? "example",
      strategies: strategiesSource,
      pools: poolsSource,
    },
    loadedAt: new Date().toISOString(),
  };
}
