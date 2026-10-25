// Server-only config loader.
//
// Reads ../deployments/testnet.contract.json and ../deployments/testnet.classic.json
// (produced by the deploy scripts) and falls back, per file, to web/config.example.json
// so the app always builds and runs even before anything is deployed.
//
// Never import this from a client component: it uses node:fs. Pages read it on the
// server and pass the resulting `LotusConfig` down as props.

import fs from "node:fs";
import path from "node:path";
import example from "../config.example.json";

export type AssetCfg = {
  /** Asset code. For the native asset this is typically "XLM" and `issuer` is null. */
  code: string;
  /** Classic issuer (G...). null => native XLM. */
  issuer: string | null;
  /** Stellar Asset Contract id (C...), when known. */
  sac?: string;
};

export type ContractFile = {
  network: string;
  rpc: string;
  horizon: string;
  passphrase: string;
  lotus_vault_contract: string;
  underlying: AssetCfg;
  receipt: AssetCfg;
  defindex_vault?: string;
  blend_pool?: string;
  accounts?: Record<string, unknown>;
};

export type ClassicFile = {
  rwa: { code: string; issuer: string };
  accounts?: Record<string, unknown>;
};

export type LotusConfig = {
  network: string;
  rpc: string;
  horizon: string;
  passphrase: string;
  /** lotus_vault contract id (C...). Empty string when not deployed. */
  lotusVault: string;
  underlying: AssetCfg;
  receipt: AssetCfg;
  rwa: AssetCfg;
  defindexVault: string;
  blendPool: string;
  /** Named demo accounts (maker, taker, peg_lp, rwa_issuer, ...) merged from both files. */
  accounts: Record<string, string>;
  /** Where each half came from: an absolute file path, or "example". */
  sources: { contract: string; classic: string };
};

const CONTRACT_FILE = "testnet.contract.json";
const CLASSIC_FILE = "testnet.classic.json";

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

/** Load the merged config. Cheap enough to call on every request. */
export function loadConfig(): LotusConfig {
  const ex = example as { contract: ContractFile; classic: ClassicFile };

  const contract = readJson<ContractFile>(CONTRACT_FILE);
  const classic = readJson<ClassicFile>(CLASSIC_FILE);

  const c = contract?.data ?? ex.contract;
  const k = classic?.data ?? ex.classic;

  return {
    network: c.network || ex.contract.network,
    rpc: c.rpc || ex.contract.rpc,
    horizon: c.horizon || ex.contract.horizon,
    passphrase: c.passphrase || ex.contract.passphrase,
    lotusVault: c.lotus_vault_contract || "",
    underlying: normalizeAsset(c.underlying, ex.contract.underlying),
    receipt: normalizeAsset(c.receipt, ex.contract.receipt),
    rwa: { code: k.rwa?.code || "LBOND", issuer: k.rwa?.issuer || null },
    defindexVault: c.defindex_vault || "",
    blendPool: c.blend_pool || "",
    accounts: { ...publicAccounts(c.accounts), ...publicAccounts(k.accounts) },
    sources: {
      contract: contract?.source ?? "example",
      classic: classic?.source ?? "example",
    },
  };
}
