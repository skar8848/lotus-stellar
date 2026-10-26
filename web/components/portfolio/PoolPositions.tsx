"use client";

import Link from "next/link";
import { useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Spinner, TokenIcon, TxStatus } from "@/components/common";
import { poolPositionLocked } from "@/components/pools/positionsModel";
import { useAccount } from "@/lib/account";
import { useNet } from "@/lib/config-context";
import type { PoolInstance } from "@/lib/config-types";
import { useTx, type TxState } from "@/lib/hooks";
import { decodePayout, getPoolClient, type Position } from "@/lib/pool";
import { priceAt } from "@/lib/poolGrid";
import { fmt, fromStroops } from "@/lib/stellar";
import { fmtAmt } from "@/lib/vault";
import { explorerTx } from "@/lib/explorer";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import type { PoolData } from "./data";
import { depositAsset, positionUnits } from "./model";

/** TxStatus for on-chain actions; a simulated action (empty hash) never shows a link or says "Confirmed". */
function ActionStatus({ state, network, onDismiss }: { state: TxState; network: string; onDismiss: () => void }) {
  if (state.stage === "success" && !state.hash) {
    return (
      <div
        data-testid="tx-simulated"
        className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-xs"
      >
        <span className="min-w-0 break-words">
          <Check className="mr-1 inline size-3.5 text-primary" aria-hidden />
          <span className="text-primary">Simulated locally</span>
          <span className="text-mutedfg"> · no transaction was sent{state.note ? ` · ${state.note}` : ""}</span>
        </span>
        <button className="shrink-0 text-mutedfg hover:text-foreground" onClick={onDismiss} aria-label="Dismiss">
          x
        </button>
      </div>
    );
  }
  return <TxStatus state={state} network={network} onDismiss={onDismiss} />;
}

function payoutNote(result: unknown, inst: PoolInstance): string {
  const p = decodePayout(result);
  const parts: string[] = [];
  if (p.base > 0n) parts.push(`${fmtAmt(p.base)} ${inst.base.code}`);
  if (p.quote > 0n) parts.push(`${fmtAmt(p.quote)} ${inst.quote.code}`);
  return parts.length > 0 ? `paid out ${parts.join(" + ")}` : "nothing to pay out";
}

const priceText = (bin: number, step: number) => fmt(fromStroops(priceAt(bin, step)), 4, 4);

type Actions = {
  running: boolean;
  busy: string | null;
  act: (kind: "claim" | "remove", p: Position, inst: PoolInstance) => void;
};

/**
 * Claim / remove runners shared by every pool section: ONE status line for the whole list, so a later action in
 * another section (or after a section disappears, e.g. a retired pool emptied by its last removal) never leaves an
 * older success banner on screen.
 */
function usePoolActions(address: string, network: string, onChanged: () => void): Actions & { status: ReturnType<typeof useTx> } {
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (kind: "claim" | "remove", p: Position, inst: PoolInstance) => {
    setBusy(`${inst.id}:${kind}-${p.id}`);
    try {
      const r = await tx.run(async (onStage) => {
        const client = getPoolClient(net, inst);
        const ctx = { source: address, sign: wallet.sign, onStage };
        const res = kind === "claim" ? await client.claim(ctx, p.id) : await client.removePosition(ctx, p.id);
        onChanged();
        acct.refresh();
        return { hash: res.hash, result: res.result, note: `${inst.label} position #${p.id} ${kind === "claim" ? "claimed" : "removed"}: ${payoutNote(res.result, inst)}` };
      });
      if (r && inst.mock) toast.success(kind === "claim" ? "Claim simulated" : "Position removal simulated", { description: "Local simulation: no transaction was sent." });
      else if (r) {
        const hash = r.hash;
        toast.success(kind === "claim" ? "Claim confirmed" : "Remove position confirmed", {
          description: `${inst.label} #${p.id}`,
          action: hash ? { label: "View tx", onClick: () => window.open(explorerTx(hash, network), "_blank", "noopener,noreferrer") } : undefined,
        });
      }
    } finally {
      setBusy(null);
    }
  };
  return { running: tx.running, busy, act, status: tx };
}

/** One position as a Uniswap-style row: pair, side, range, progress, what it pays out, one action. */
function PositionRow({ inst, p, actions }: { inst: PoolInstance; p: Position; actions: Actions }) {
  const { running, act } = actions;
  const busy = actions.busy?.startsWith(`${inst.id}:`) ? actions.busy.slice(inst.id.length + 1) : null;
  const u = positionUnits(p, inst);
  const twoWay = p.mode === "TwoWay";
  const dep = depositAsset(p, inst);
  const filledPct = p.deposited > 0n ? Math.min(100, (Number(p.filled) / Number(p.deposited)) * 100) : 0;
  // two-way: claim pays fees only (the reserves leave with Remove)
  const claimable = twoWay ? p.pendingFees > 0n : p.pendingProceeds > 0n || p.pendingFees > 0n;
  const id = String(p.id);
  const sell = p.side === "Ask";
  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between" data-testid="pool-position-row" data-position-id={id}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex -space-x-1.5">
            <TokenIcon code={inst.base.code} size={22} className="ring-2 ring-card" />
            <TokenIcon code={inst.quote.code} size={22} className="ring-2 ring-card" />
          </span>
          <span className="text-sm font-medium">
            {inst.base.code} / {inst.quote.code}
          </span>
          <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium", sell ? "bg-red/10 text-red" : "bg-green/10 text-green")}>
            {twoWay ? "Two-way" : sell ? `Sell ${inst.base.code}` : `Buy ${inst.base.code}`}
          </span>
          {p.vaulted ? <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">Earning yield</span> : null}
          {inst.status === "retired" ? <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-mutedfg">Retired pool</span> : null}
          {inst.mock ? <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-mutedfg">Simulated</span> : null}
        </div>
        <div className="num mt-2 text-xs text-mutedfg">
          {priceText(p.loBin, inst.binStepBps)} ↔ {priceText(p.hiBin, inst.binStepBps)} {inst.quote.code} · {fmtAmt(p.deposited)} {dep.code}
        </div>
        {twoWay ? null : (
          <div className="mt-2.5 flex max-w-sm items-center gap-2.5">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary" style={{ width: `${filledPct}%` }} />
            </div>
            <span className="num text-[11px] text-mutedfg">{fmt(filledPct, 0)}% filled</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-4 sm:justify-end">
        {!twoWay && p.pendingProceeds > 0n ? (
          <div className="text-right">
            <div className="num text-sm text-green">
              {fmtAmt(p.pendingProceeds)} {u.proceeds.code}
            </div>
            <div className="text-[11px] text-mutedfg">to claim</div>
          </div>
        ) : null}
        <div className="flex gap-1.5">
          {claimable ? (
            <Button size="xs" disabled={running} onClick={() => act("claim", p, inst)} data-testid={`pool-claim-${id}`}>
              {busy === `claim-${id}` ? <Spinner /> : null}
              Claim
            </Button>
          ) : null}
          {poolPositionLocked(p) ? (
            <span className="rounded-md border border-border px-2 py-1 text-[11px] text-mutedfg" title="Locked until the order is fully filled. Early redemption is coming soon." data-testid={`pool-early-${id}`}>
              Locked until filled
            </span>
          ) : (
            <Button size="xs" variant="outline" disabled={running} onClick={() => act("remove", p, inst)} data-testid={`pool-remove-${id}`}>
              {busy === `remove-${id}` ? <Spinner /> : null}
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Lotus pool positions of the account, all pools in one list. */
export function PoolPositions({
  data,
  address,
  network,
  onChanged,
}: {
  data: PoolData[] | null;
  address: string;
  network: string;
  onChanged: () => void;
}) {
  const actions = usePoolActions(address, network, onChanged);
  const rows = (data ?? []).flatMap((d) => d.positions.map((p) => ({ inst: d.inst, p })));
  const errors = (data ?? []).filter((d) => d.error);
  return (
    <section className="min-w-0" data-testid="portfolio-pool-positions">
      <ActionStatus state={actions.status.state} network={network} onDismiss={actions.status.reset} />
      <Panel title="Pool positions" right={rows.length > 0 ? <span className="text-xs text-mutedfg">{rows.length}</span> : undefined} className="min-w-0">
        {data === null ? (
          <Empty>Loading...</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            No pool positions.{" "}
            <Link href="/pools" className="text-primary underline-offset-2 hover:underline">
              Open one on Pools
            </Link>
            .
          </Empty>
        ) : (
          <div className="-mx-4 divide-y divide-border">
            {rows.map(({ inst, p }) => (
              <PositionRow key={`${inst.id}:${p.id}`} inst={inst} p={p} actions={actions} />
            ))}
          </div>
        )}
        {errors.map((d) => (
          <p key={d.inst.id} className="mt-2 text-xs text-destructive">
            {d.inst.label}: positions unavailable ({d.error})
          </p>
        ))}
      </Panel>
    </section>
  );
}
