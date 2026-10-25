// Async loaders for /portfolio (polled by the page). Each one degrades per source instead of throwing,
// so one unavailable endpoint never blanks the whole page.

import type { LotusConfig, PoolInstance } from "@/lib/config-types";
import { errMsg } from "@/lib/hooks";
import { getPoolClient, type Position } from "@/lib/pool";
import {
  eventName,
  fetchAccountOps,
  fetchAccountTrades,
  fetchOperationTxHash,
  simulateView,
  type NetCfg,
} from "@/lib/stellar";
import { fetchVaultEvents, hasContract } from "@/lib/vault";
import { describeFill, describeOp, describeVaultEvent, type ActivityRow } from "./model";

// ---------------------------------------------------------------------------
// Pool positions (one entry per pool instance, errors kept per instance)
// ---------------------------------------------------------------------------

export type PoolData = {
  inst: PoolInstance;
  positions: Position[];
  error: string | null;
  /** announced but not deployed: nothing to read */
  skipped?: boolean;
};

export async function loadPoolPositions(config: LotusConfig, net: NetCfg, address: string): Promise<PoolData[]> {
  return Promise.all(
    config.pools.map(async (inst): Promise<PoolData> => {
      if (!inst.mock && !inst.contract) return { inst, positions: [], error: null, skipped: true };
      try {
        return { inst, positions: await getPoolClient(net, inst).positionsOf(address), error: null };
      } catch (e) {
        return { inst, positions: [], error: errMsg(e) };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Receipt supply per Lotus vault (for "% of supply")
// ---------------------------------------------------------------------------

export async function loadSupplies(config: LotusConfig, net: NetCfg): Promise<Record<string, bigint | null>> {
  const out: Record<string, bigint | null> = {};
  await Promise.all(
    config.strategies.filter(hasContract).map(async (s) => {
      try {
        const v = await simulateView<bigint>(net, s.lotusVault, "supply");
        out[s.id] = typeof v === "bigint" ? v : null;
      } catch {
        out[s.id] = null;
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Recent activity: Horizon operations + fills + this account's lotus_vault events, merged newest first
// ---------------------------------------------------------------------------

export type ActivityData = { rows: ActivityRow[]; unavailable: string[] };

const MAX_ROWS = 25;

export async function loadActivity(config: LotusConfig, net: NetCfg, address: string): Promise<ActivityData> {
  const unavailable: string[] = [];
  const names = new Map<string, string>();
  for (const s of config.strategies) if (s.lotusVault) names.set(s.lotusVault, `Lotus vault ${s.receipt.code}`);
  for (const p of config.pools) if (p.contract) names.set(p.contract, "Lotus pool");
  const vaults = config.strategies.filter(hasContract);

  const [ops, fills, events] = await Promise.all([
    fetchAccountOps(net.horizon, address, MAX_ROWS).catch(() => {
      unavailable.push("operations");
      return null;
    }),
    fetchAccountTrades(net.horizon, address, 15).catch(() => {
      unavailable.push("fills");
      return null;
    }),
    vaults.length > 0
      ? fetchVaultEvents(net, vaults.map((s) => s.lotusVault)).catch(() => {
          unavailable.push("vault events");
          return null;
        })
      : Promise.resolve([]),
  ]);

  const rows: ActivityRow[] = [];

  // this account's deposit / redeem events (topics: [name, account])
  const mine = (events ?? []).filter((e) => (eventName(e) === "deposit" || eventName(e) === "redeem") && e.topics[1] === address);
  const vaultTx = new Set(mine.map((e) => e.txHash));
  for (const e of mine) {
    const strategy = config.strategies.find((s) => s.lotusVault === e.contractId);
    const d = describeVaultEvent(e, strategy);
    if (d) rows.push({ id: `ev-${e.id}`, time: e.ledgerClosedAt, kind: "vault", title: d.title, detail: d.detail, tx: e.txHash });
  }

  for (const op of ops ?? []) {
    // the event row above says more than the bare contract call of the same transaction
    if (op.type === "invoke_host_function" && vaultTx.has(op.transaction_hash)) continue;
    const d = describeOp(op, address, names);
    rows.push({ id: `op-${op.id}`, time: op.created_at, kind: "op", title: d.title, detail: d.detail, tx: op.transaction_hash });
  }

  // trade records only link the operation: resolve (cached) transaction hashes
  const hashes = await Promise.all((fills ?? []).map((t) => fetchOperationTxHash(net.horizon, t.opId)));
  (fills ?? []).forEach((t, i) => {
    const d = describeFill(t, address);
    rows.push({ id: `fill-${t.id}`, time: t.time, kind: "fill", title: d.title, detail: d.detail, tx: hashes[i] });
  });

  rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return { rows: rows.slice(0, MAX_ROWS), unavailable };
}
