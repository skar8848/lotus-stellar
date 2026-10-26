// Server-side deployment check behind GET /api/health (and the MCP tool lotus_health).
//
// Cheap reads only: Soroban RPC getHealth, the Horizon root, ONE getLedgerEntries for every contract instance
// in the config, and one read-only simulation per Lotus contract (lotus_pool.abi_version(), lotus_vault.supply();
// neither touches DeFindex, so nothing writes a fee report). Nothing is ever submitted.

import { Contract, rpc } from "@stellar/stellar-sdk";
import type { LotusConfig } from "./config-types";
import { explorerContract } from "./explorer";
import { simulateView } from "./stellar";

export type ContractKind = "lotus_pool" | "lotus_vault" | "defindex_vault" | "blend_pool" | "sac";

export type ContractCheck = {
  kind: ContractKind;
  /** config id (pool / strategy id) or asset code */
  id: string;
  contract: string;
  status: string;
  ok: boolean;
  /** the contract instance entry exists on the ledger */
  instance: boolean;
  liveUntilLedger: number | null;
  read?: { method: string; ok: boolean; value?: unknown; error?: string };
  explorer: string;
};

export type Health = {
  status: "ok" | "degraded" | "down";
  checkedAt: string;
  app: { name: string; version: string; commit: string | null; env: string };
  network: { name: string; passphrase: string };
  rpc: { url: string; ok: boolean; latencyMs: number | null; latestLedger: number | null; status: string | null; error?: string };
  horizon: { url: string; ok: boolean; latencyMs: number | null; latestLedger: number | null; error?: string };
  contracts: ContractCheck[];
  summary: { total: number; ok: number; failed: string[] };
};

const TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms))]);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const isC = (id: string | null | undefined): id is string => !!id && /^C[A-Z2-7]{55}$/.test(id);

type Target = { kind: ContractKind; id: string; contract: string; status: string; read?: string; required: boolean };

/** Every contract the app depends on, deduplicated by contract id. */
export function healthTargets(c: LotusConfig): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  const add = (t: Target) => {
    if (!isC(t.contract) || seen.has(t.contract)) return;
    seen.add(t.contract);
    out.push(t);
  };
  for (const p of c.pools) if (!p.mock) add({ kind: "lotus_pool", id: p.id, contract: p.contract, status: p.status, read: "abi_version", required: true });
  for (const p of c.retiredPools) add({ kind: "lotus_pool", id: p.id, contract: p.contract, status: "retired", required: false });
  for (const s of c.strategies) {
    if (s.lotusVault) add({ kind: "lotus_vault", id: s.id, contract: s.lotusVault, status: s.status, read: "supply", required: s.status === "live" });
  }
  for (const s of c.strategies) if (s.defindexVault) add({ kind: "defindex_vault", id: `${s.id}:defindex`, contract: s.defindexVault, status: s.status, required: s.status === "live" });
  for (const p of c.pools) if (p.vault) add({ kind: "defindex_vault", id: `${p.id}:defindex`, contract: p.vault, status: p.status, required: true });
  if (c.blendPool) add({ kind: "blend_pool", id: "blend-pool", contract: c.blendPool, status: "external", required: true });
  const lbondSac = c.pools.find((p) => p.base.code === c.rwa.code && p.base.sac)?.base.sac;
  if (lbondSac) add({ kind: "sac", id: c.rwa.code, contract: lbondSac, status: "asset", required: true });
  if (c.underlying.sac) add({ kind: "sac", id: c.underlying.code, contract: c.underlying.sac, status: "asset", required: true });
  for (const s of c.strategies) if (s.receipt.sac) add({ kind: "sac", id: s.receipt.code, contract: s.receipt.sac, status: "asset", required: s.status === "live" });
  return out;
}

/** The contract instance ledger key, base64 (also the key of the getLedgerEntries result). */
const instanceKey = (contract: string) => new Contract(contract).getFootprint();

const jsonable = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export async function checkHealth(c: LotusConfig, app: Health["app"]): Promise<Health> {
  const server = new rpc.Server(c.rpc, { allowHttp: c.rpc.startsWith("http://") });

  const rpcCheck = (async (): Promise<Health["rpc"]> => {
    const t0 = Date.now();
    try {
      const h = await withTimeout(server.getHealth());
      return { url: c.rpc, ok: h.status === "healthy", latencyMs: Date.now() - t0, latestLedger: h.latestLedger ?? null, status: h.status };
    } catch (e) {
      return { url: c.rpc, ok: false, latencyMs: null, latestLedger: null, status: null, error: errText(e) };
    }
  })();

  const horizonCheck = (async (): Promise<Health["horizon"]> => {
    const t0 = Date.now();
    try {
      const r = await withTimeout(fetch(c.horizon.replace(/\/$/, "") + "/", { cache: "no-store", headers: { Accept: "application/json" } }));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { history_latest_ledger?: number };
      return { url: c.horizon, ok: true, latencyMs: Date.now() - t0, latestLedger: j.history_latest_ledger ?? null };
    } catch (e) {
      return { url: c.horizon, ok: false, latencyMs: null, latestLedger: null, error: errText(e) };
    }
  })();

  const targets = healthTargets(c);
  const instancesCheck = (async (): Promise<Map<string, { liveUntil: number | null }> | Error> => {
    if (targets.length === 0) return new Map();
    try {
      const keys = targets.map((t) => instanceKey(t.contract));
      const byKey = new Map(keys.map((k, i) => [k.toXDR("base64"), targets[i].contract]));
      const res = await withTimeout(server.getLedgerEntries(...keys));
      const found = new Map<string, { liveUntil: number | null }>();
      for (const e of res.entries) {
        const addr = byKey.get(e.key.toXDR("base64"));
        if (addr) found.set(addr, { liveUntil: e.liveUntilLedgerSeq ?? null });
      }
      return found;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  })();

  const net = { rpc: c.rpc, horizon: c.horizon, passphrase: c.passphrase };
  const readsCheck = Promise.all(
    targets.map(async (t) => {
      if (!t.read) return undefined;
      try {
        const v = await withTimeout(simulateView(net, t.contract, t.read));
        return { method: t.read, ok: true, value: jsonable(v) };
      } catch (e) {
        return { method: t.read, ok: false, error: errText(e) };
      }
    }),
  );

  const [rpcRes, horizonRes, instances, reads] = await Promise.all([rpcCheck, horizonCheck, instancesCheck, readsCheck]);

  const contracts: ContractCheck[] = targets.map((t, i) => {
    const inst = instances instanceof Error ? null : instances.get(t.contract);
    const read = reads[i];
    const instance = !!inst;
    return {
      kind: t.kind,
      id: t.id,
      contract: t.contract,
      status: t.status,
      ok: instance && (read ? read.ok : true),
      instance,
      liveUntilLedger: inst?.liveUntil ?? null,
      ...(read ? { read } : {}),
      explorer: explorerContract(t.contract, c.network),
    };
  });

  const failed = contracts.filter((k, i) => !k.ok && targets[i].required).map((k) => `${k.kind}:${k.id}`);
  const status: Health["status"] = !rpcRes.ok || !horizonRes.ok ? "down" : failed.length > 0 ? "degraded" : "ok";
  return {
    status,
    checkedAt: new Date().toISOString(),
    app,
    network: { name: c.network, passphrase: c.passphrase },
    rpc: rpcRes,
    horizon: horizonRes,
    contracts,
    summary: { total: contracts.length, ok: contracts.filter((k) => k.ok).length, failed },
  };
}
