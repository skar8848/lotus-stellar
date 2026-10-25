// Pure helpers for the Lotus vault tab (no React). The "vault" is the lotus_vault wrapper contract:
// USDC -> Lotus vault -> DeFindex vault -> Blend, minting the classic receipt (lUSDC) 1:1.

import { rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import type { Strategy, StrategyStatus } from "./config-types";
import { fmt, isContractId, toStroops, fromStroops, type ContractEvent, type HorizonBalance, type NetCfg } from "./stellar";

export const STATUS_META: Record<StrategyStatus, { label: string; short: string; tone: "green" | "muted" }> = {
  live: { label: "Live yield (Blend)", short: "Live", tone: "green" },
  idle: { label: "Idle (testnet vault not allocated)", short: "Idle", tone: "muted" },
  "coming-soon": { label: "Coming soon", short: "Soon", tone: "muted" },
};

/** True when the strategy has a deployed lotus_vault we can call (and is not just announced). */
export const hasContract = (s: Strategy): boolean => isContractId(s.lotusVault) && s.status !== "coming-soon";

/** Amount for display. Small non-zero values keep more decimals so they never read as 0. */
export function fmtAmt(v: bigint | null | undefined, maxDp = 2): string {
  if (v === null || v === undefined) return "—";
  if (v === 0n) return "0";
  const abs = v < 0n ? -v : v;
  const dp = abs < 100_000n ? 7 : abs < 10_000_000n ? 4 : maxDp;
  return fmt(v, dp);
}

/** Spendable part of a Horizon balance as an exact 7dp string (balance - selling liabilities - reserve). */
export function spendable(bal: HorizonBalance | undefined, reserveXlm = 0): string | null {
  if (!bal) return null;
  try {
    const total = toStroops(bal.balance);
    const locked = toStroops(bal.selling_liabilities ?? "0");
    const reserve = BigInt(Math.round(reserveXlm * 1e7));
    const v = total - locked - reserve;
    return fromStroops(v > 0n ? v : 0n);
  } catch {
    return null;
  }
}

/** Amount committed to open SDEX offers (selling liabilities) as a bigint of stroops, 0n if none. */
export function inOffers(bal: HorizonBalance | undefined): bigint {
  if (!bal?.selling_liabilities) return 0n;
  try {
    return toStroops(bal.selling_liabilities);
  } catch {
    return 0n;
  }
}

/**
 * What redeem(amount) pays, mirroring the contract: 1:1 while vault_value >= supply, otherwise
 * amount * vault_value / supply (floor). null when the inputs are unknown.
 */
export function redeemEstimate(amount: bigint, vaultValue: bigint | null, supply: bigint | null): bigint | null {
  if (vaultValue === null || supply === null || supply <= 0n || amount <= 0n) return null;
  return vaultValue >= supply ? amount : (amount * vaultValue) / supply;
}

/**
 * Recent events of the given lotus_vault contracts, newest first.
 *
 * Soroban RPC getEvents only scans about 10,000 ledgers from `startLedger` per call and returns an
 * empty page (plus a cursor) when nothing falls in that stretch, so one call with a long lookback
 * silently misses recent events. This walks back in explicit `endLedger` windows instead
 * (3 x 9,000 ledgers, roughly 37 hours) and merges them. Best effort: a failing window is skipped.
 */
export async function fetchVaultEvents(
  net: NetCfg,
  contractIds: string[],
  opts: { windows?: number; windowLedgers?: number } = {},
): Promise<ContractEvent[]> {
  if (contractIds.length === 0) return [];
  const windows = opts.windows ?? 3;
  const size = opts.windowLedgers ?? 9000;
  const server = new rpc.Server(net.rpc);
  const latest = (await server.getLatestLedger()).sequence;
  const decode = (v: xdr.ScVal): unknown => {
    try {
      return scValToNative(v);
    } catch {
      return v.toXDR("base64");
    }
  };
  const jobs: Promise<ContractEvent[]>[] = [];
  for (const id of contractIds) {
    for (let w = 0; w < windows; w++) {
      const end = latest + 1 - w * size;
      const start = Math.max(1, end - size);
      jobs.push(
        server
          .getEvents({ startLedger: start, endLedger: end, filters: [{ type: "contract", contractIds: [id] }], limit: 200 })
          .then((r) =>
            (r.events ?? []).map((e) => ({
              id: e.id,
              ledger: e.ledger,
              ledgerClosedAt: e.ledgerClosedAt,
              topics: (e.topic ?? []).map(decode),
              value: decode(e.value),
              txHash: e.txHash,
              contractId: id,
            })),
          )
          .catch(() => [] as ContractEvent[]),
      );
    }
  }
  const seen = new Set<string>();
  return (await Promise.all(jobs))
    .flat()
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => b.ledger - a.ledger || (a.id < b.id ? 1 : -1));
}
