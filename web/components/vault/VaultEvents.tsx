"use client";

import { useMemo } from "react";
import { Dot, Empty, ExplorerLink, Panel } from "@/components/common";
import type { Strategy } from "@/lib/config-types";
import type { Polled } from "@/lib/hooks";
import { eventAmount, eventName, type ContractEvent } from "@/lib/stellar";
import { fmtAmt } from "@/lib/vault";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  deposit: "text-green",
  redeem: "text-red",
  distribute: "text-primary",
};

function summary(e: ContractEvent, u: string, r: string): string {
  const name = eventName(e);
  if (name === "deposit") {
    const a = eventAmount(e, "amount");
    return a === null ? "deposit" : `${fmtAmt(a)} ${u} in, ${fmtAmt(a)} ${r} minted`;
  }
  if (name === "redeem") {
    const a = eventAmount(e, "amount");
    const p = eventAmount(e, "paid");
    return a === null ? "redeem" : `${fmtAmt(a)} ${r} burnt${p === null ? "" : `, ${fmtAmt(p)} ${u} paid`}`;
  }
  if (name === "distribute") {
    const t = eventAmount(e, "total");
    const n = eventAmount(e, "recipients");
    return t === null ? "distribute" : `${fmtAmt(t, 4)} ${r} minted to ${n === null ? "?" : n.toString()} holder${n === 1n ? "" : "s"}`;
  }
  return name;
}

/** Recent deposit / redeem / distribute events of the selected vault (Soroban RPC getEvents, best effort). */
export function VaultEvents({ events, strategy, network }: { events: Polled<ContractEvent[]>; strategy: Strategy; network: string }) {
  const mine = useMemo(() => (events.data ?? []).filter((e) => e.contractId === strategy.lotusVault), [events.data, strategy.lotusVault]);
  const dist = mine.filter((e) => eventName(e) === "distribute");
  const distributed = dist.reduce((a, e) => a + (eventAmount(e, "total") ?? 0n), 0n);
  const u = strategy.underlying.code;
  const r = strategy.receipt.code;

  return (
    <Panel
      title="Recent vault events"
      subtitle="deposit, redeem and distribute, read from the contract through Soroban RPC"
      right={
        <span className="flex items-center gap-1.5 text-[11px] text-mutedfg">
          <Dot ok={events.error ? false : events.data ? true : null} pulse={events.loading} />
          {events.error ? "unavailable" : "live · 30s"}
        </span>
      }
    >
      <div className="mb-3 rounded-xl bg-secondary px-3.5 py-2.5 text-xs" data-testid="vault-distributed">
        <span className="text-mutedfg">Distributed (RPC window): </span>
        {events.data ? (
          dist.length > 0 ? (
            <span className="num font-medium text-foreground">
              {fmtAmt(distributed, 4)} {r} <span className="font-normal text-mutedfg">in {dist.length} distribution{dist.length === 1 ? "" : "s"}</span>
            </span>
          ) : (
            <span className="text-foreground">none yet</span>
          )
        ) : (
          <span className="text-mutedfg">—</span>
        )}
        <div className="mt-1 text-[11px] text-mutedfg/80">Counted from events the RPC still retains; this is not an APY.</div>
      </div>

      {events.error ? (
        <Empty>Events unavailable right now ({events.error}).</Empty>
      ) : !events.data ? (
        <Empty>Loading...</Empty>
      ) : mine.length === 0 ? (
        <Empty>No events in the RPC retention window.</Empty>
      ) : (
        <ul className="divide-y divide-line" data-testid="vault-events">
          {mine.slice(0, 10).map((e) => {
            const name = eventName(e);
            const who = typeof e.topics[1] === "string" ? (e.topics[1] as string) : null;
            return (
              <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 text-xs">
                <div className="min-w-0">
                  <span className={cn("mr-2 font-semibold uppercase tracking-wide", TONE[name] ?? "text-mutedfg")}>{name}</span>
                  <span className="num text-foreground/90">{summary(e, u, r)}</span>
                  {who ? (
                    <span className="ml-2 text-mutedfg">
                      by <ExplorerLink kind="account" id={who} network={network} />
                    </span>
                  ) : null}
                </div>
                <div className="num flex shrink-0 items-center gap-2 text-[11px] text-mutedfg">
                  <span>{new Date(e.ledgerClosedAt).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                  <ExplorerLink kind="tx" id={e.txHash} network={network} n={4} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
