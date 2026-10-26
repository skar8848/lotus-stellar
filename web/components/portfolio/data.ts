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
  toStroops,
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
  // retired instances too: an owner must still be able to claim / remove positions left there
  return Promise.all(
    [...config.pools, ...(config.retiredPools ?? [])].map(async (inst): Promise<PoolData> => {
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
        // accrued interest not yet distributed (simulation only: the view writes a DeFindex fee report)
        const sur = await simulateView<bigint>(net, s.lotusVault, "surplus").catch(() => null);
        out[`surplus:${s.id}`] = typeof sur === "bigint" ? sur : null;
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
  for (const p of config.retiredPools ?? []) if (p.contract) names.set(p.contract, "Lotus pool (retired)");
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
    const d = describeOp(op, address, names, config.rwa.code);
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

type MintChange = { type?: string; to?: string; amount?: string; asset_code?: string; asset_issuer?: string };
type PaymentRecord = { type: string; source_account?: string; asset_balance_changes?: MintChange[] };

/**
 * Yield paid to `address` per receipt (strategy id -> stroops): the receipt mints it received from keeper `distribute`
 * calls. A deposit is invoked by the holder itself, so only mints from a transaction someone else sent count.
 * Reads the account's last ~600 payment operations on Horizon; `complete` is false when there were more.
 */
export async function loadEarned(config: LotusConfig, address: string): Promise<{ earned: Record<string, bigint>; complete: boolean }> {
  const earned: Record<string, bigint> = {};
  const receipts = config.strategies.filter((s) => s.receipt.issuer);
  let url: string | null = `${config.horizon}/accounts/${address}/payments?order=desc&limit=200`;
  let pages = 0;
  let complete = true;
  while (url && pages < 3) {
    const res = await fetch(url);
    if (!res.ok) break;
    const j = (await res.json()) as { _embedded?: { records?: PaymentRecord[] }; _links?: { next?: { href?: string } } };
    const records = j._embedded?.records ?? [];
    for (const r of records) {
      if (r.type !== "invoke_host_function" || r.source_account === address) continue;
      for (const c of r.asset_balance_changes ?? []) {
        if (c.type !== "mint" || c.to !== address || !c.amount) continue;
        const s = receipts.find((x) => x.receipt.code === c.asset_code && x.receipt.issuer === c.asset_issuer);
        if (s) earned[s.id] = (earned[s.id] ?? 0n) + toStroops(c.amount);
      }
    }
    pages++;
    if (records.length < 200) {
      url = null;
    } else {
      url = j._links?.next?.href ?? null;
      if (pages === 3) complete = false;
    }
  }
  return { earned, complete };
}
