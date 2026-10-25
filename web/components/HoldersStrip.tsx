"use client";

import { useCallback, useMemo } from "react";
import type { LotusConfig } from "@/lib/config";
import { usePolling } from "@/lib/hooks";
import {
  assetReady,
  fetchContractEvents,
  fetchHolders,
  fetchOffers,
  findBalance,
  fmt,
  fromStroops,
  isContractId,
  sameAsset,
  type NetCfg,
} from "@/lib/stellar";
import { AddrLink, Dot, Empty, Panel, TxLink } from "./ui";

type HolderRow = { id: string; balance: string; inOffers: string; offers: number; receiptOffers: number };

export function HoldersStrip({ config }: { config: LotusConfig }) {
  const receiptOk = assetReady(config.receipt);
  const contractOk = isContractId(config.lotusVault);
  const rLabel = config.receipt.code;
  const net: NetCfg = { rpc: config.rpc, horizon: config.horizon, passphrase: config.passphrase };

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(config.accounts)) if (typeof v === "string") m.set(v, k.replace(/_/g, " "));
    if (isContractId(config.lotusVault)) m.set(config.lotusVault, "vault");
    return m;
  }, [config.accounts, config.lotusVault]);

  const holdersFn = useCallback(async (): Promise<HolderRow[]> => {
    const accounts = await fetchHolders(config.horizon, config.receipt, 50);
    const withBal = accounts
      .map((a) => ({ id: a.id, bal: findBalance(a, config.receipt) }))
      .filter((x): x is { id: string; bal: NonNullable<typeof x.bal> } => !!x.bal)
      .sort((a, b) => Number(b.bal.balance) - Number(a.bal.balance))
      .slice(0, 12);
    const offers = await Promise.all(withBal.map((h) => fetchOffers(config.horizon, h.id).catch(() => [])));
    return withBal.map((h, i) => ({
      id: h.id,
      balance: h.bal.balance,
      inOffers: h.bal.selling_liabilities ?? "0",
      offers: offers[i].length,
      receiptOffers: offers[i].filter((o) => sameAsset(o.selling, config.receipt)).length,
    }));
  }, [config.horizon, config.receipt]);
  const holders = usePolling(holdersFn, 15000, receiptOk);

  const eventsFn = useCallback(() => fetchContractEvents(net, config.lotusVault), [config.rpc, config.horizon, config.passphrase, config.lotusVault]); // eslint-disable-line react-hooks/exhaustive-deps
  const events = usePolling(eventsFn, 30000, contractOk);

  const rows = holders.data ?? [];
  const totalHeld = rows.reduce((a, r) => a + Number(r.balance), 0);
  const totalInOffers = rows.reduce((a, r) => a + Number(r.inOffers), 0);
  const pctInOffers = totalHeld > 0 ? (totalInOffers / totalHeld) * 100 : null;

  return (
    <Panel
      id="holders"
      title={
        <>
          Holders <span className="text-muted-fg">·</span> {rLabel}
        </>
      }
      subtitle={`Who holds the receipt, how much of it is resting in offers, and the vault's recent events.`}
      right={
        <span className="flex items-center gap-1.5 text-[11px] text-muted-fg">
          <Dot ok={holders.error ? false : holders.data ? true : null} pulse={holders.loading} />
          {holders.error ? "offline" : "live · 15s"}
        </span>
      }
      className="h-full"
    >
      {!receiptOk ? (
        <Empty>Receipt not deployed yet.</Empty>
      ) : (
        <div className="grid gap-5 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-3">
            <div className="label mb-1 grid grid-cols-4 gap-2 px-1">
              <span>Account</span>
              <span className="text-right">{rLabel}</span>
              <span className="text-right">In offers</span>
              <span className="text-right">Open offers</span>
            </div>
            {rows.length === 0 ? (
              <Empty>{holders.error ? holders.error : holders.data ? `No ${rLabel} holders yet.` : "Loading…"}</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((r) => {
                  const name = names.get(r.id);
                  const pct = Number(r.balance) > 0 ? (Number(r.inOffers) / Number(r.balance)) * 100 : 0;
                  return (
                    <li key={r.id} className="relative grid grid-cols-4 gap-2 px-1 py-1.5 text-xs">
                      <span aria-hidden className="absolute inset-y-0 left-0 bg-green/8" style={{ width: `${Math.min(100, pct)}%` }} />
                      <span className="relative min-w-0 truncate">
                        {name ? <span className="mr-1.5 rounded border border-line px-1 text-[10px] uppercase tracking-wide text-muted-fg">{name}</span> : null}
                        <AddrLink id={r.id} network={config.network} />
                      </span>
                      <span className="num relative text-right">{fmt(r.balance, 2)}</span>
                      <span className={`num relative text-right ${Number(r.inOffers) > 0 ? "text-green" : "text-muted-fg"}`}>{fmt(r.inOffers, 2)}</span>
                      <span className="num relative text-right text-muted-fg">
                        {r.offers}
                        {r.receiptOffers > 0 ? <span className="text-green"> ({r.receiptOffers} {rLabel})</span> : null}
                      </span>
                    </li>
                  );
                })}
                <li className="num grid grid-cols-4 gap-2 px-1 py-1.5 text-xs">
                  <span className="text-muted-fg">Top {rows.length}</span>
                  <span className="text-right">{fmt(totalHeld, 2)}</span>
                  <span className="text-right text-green">{fmt(totalInOffers, 2)}</span>
                  <span className="text-right text-muted-fg">{pctInOffers === null ? "—" : `${fmt(pctInOffers, 1)}% earning in book`}</span>
                </li>
              </ul>
            )}
          </div>

          <div className="min-w-0 lg:col-span-2">
            <div className="label mb-1 px-1">Vault events</div>
            {!contractOk ? (
              <Empty>Vault not deployed.</Empty>
            ) : events.error ? (
              <Empty>Events unavailable.</Empty>
            ) : !events.data ? (
              <Empty>Loading…</Empty>
            ) : events.data.length === 0 ? (
              <Empty>No events in the RPC retention window.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {events.data.slice(0, 6).map((e) => (
                  <li key={e.id} className="min-w-0 px-1 py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{e.topics.map(topicText).join(" · ") || "event"}</span>
                      <span className="num shrink-0 text-[11px] text-muted-fg">{new Date(e.ledgerClosedAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="num mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-fg">
                      <span className="min-w-0 truncate">{valueText(e.value)}</span>
                      <span className="shrink-0">
                        <TxLink hash={e.txHash} network={config.network} label="tx" />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function topicText(t: unknown): string {
  if (typeof t === "string") return t.length > 14 && /^[GC][A-Z2-7]{55}$/.test(t) ? `${t.slice(0, 4)}…${t.slice(-4)}` : t;
  if (typeof t === "bigint") return fromStroops(t);
  if (t && typeof t === "object" && "toString" in t) {
    const s = String(t);
    return s.length > 14 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
  }
  return String(t);
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return fromStroops(v);
  if (Array.isArray(v)) return v.map(valueText).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${valueText(x)}`)
      .join(" · ");
  }
  const s = String(v);
  return s.length > 20 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
