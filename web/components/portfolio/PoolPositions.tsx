"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, ExplorerLink, Panel, Spinner, TxStatus } from "@/components/common";
import { EARLY_REDEMPTION_LABEL, poolPositionLocked } from "@/components/pools/positionsModel";
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

function PoolSection({ entry, network, actions }: { entry: PoolData; network: string; actions: Actions }) {
  const { inst, positions, error, skipped } = entry;
  const { running, act } = actions;
  const busy = actions.busy?.startsWith(`${inst.id}:`) ? actions.busy.slice(inst.id.length + 1) : null;

  const feeTier = `${fmt(inst.feeBps / 100, 2)}%`;
  const step = `${fmt(inst.binStepBps / 100, 2)}%`;

  return (
    <Panel
      title={inst.label}
      subtitle={
        <>
          Fee tier {feeTier}, bin step {step}. USDC leg:{" "}
          {inst.vault ? (
            <>
              parked in a DeFindex vault <ExplorerLink kind="contract" id={inst.vault} network={network} />
            </>
          ) : (
            "idle in the pool"
          )}
          {inst.contract ? (
            <>
              {" · pool "}
              <ExplorerLink kind="contract" id={inst.contract} network={network} />
            </>
          ) : null}
        </>
      }
      right={
        inst.mock ? (
          <Badge variant="outline" className="gap-1.5 border-primary/40 text-primary">
            <FlaskConical className="size-3" /> Local simulation
          </Badge>
        ) : (
          <Badge variant="outline" className={cn("gap-1.5", inst.status === "live" ? "border-green/30 bg-green/10 text-green" : "border-border text-mutedfg")}>
            {inst.status === "live" ? "Live" : inst.status === "idle" ? "Idle" : inst.status === "retired" ? "Retired" : "Coming soon"}
          </Badge>
        )
      }
      className="min-w-0"
    >
      {inst.status === "retired" ? (
        <p className="mb-3 rounded-xl border border-border bg-secondary/50 px-3 py-2 text-xs text-mutedfg" data-testid="pool-retired-note">
          Retired instance (replaced by a redeploy): it takes no new orders, but you can still claim and remove the positions you left here.
        </p>
      ) : null}
      {inst.mock ? (
        <p className="mb-3 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary" data-testid="pool-mock-note">
          Local simulation (no pool contract deployed yet): nothing here is on-chain. Positions live in this browser only and claim and remove do not send transactions.
        </p>
      ) : null}
      {skipped ? (
        <Empty>This pool is announced but not deployed yet.</Empty>
      ) : error ? (
        <Empty>
          <span className="text-destructive">Positions unavailable: {error}</span>
        </Empty>
      ) : positions.length === 0 ? (
        <Empty>
          No positions in this pool.{" "}
          <Link href="/pools" className="text-primary underline-offset-2 hover:underline">
            Open one on Pools
          </Link>
          .
        </Empty>
      ) : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[860px] text-xs" data-testid={`pool-table-${inst.id}`}>
            <thead>
              <tr className="label text-left">
                <th className="py-1 pr-2 font-normal">Position</th>
                <th className="py-1 pr-2 font-normal">Range ({inst.quote.code} per {inst.base.code})</th>
                <th className="py-1 pr-2 text-right font-normal">Deposited</th>
                <th className="py-1 pr-2 text-right font-normal">Remaining</th>
                <th className="py-1 pr-2 text-right font-normal">Filled</th>
                <th className="py-1 pr-2 text-right font-normal">Proceeds</th>
                <th className="py-1 pr-2 text-right font-normal">Fees</th>
                <th className="py-1 text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const u = positionUnits(p, inst);
                const twoWay = p.mode === "TwoWay";
                const dep = depositAsset(p, inst);
                const filledPct = p.deposited > 0n ? (Number(p.filled) / Number(p.deposited)) * 100 : 0;
                // two-way: claim pays fees only (the reserves leave with Remove)
                const claimable = twoWay ? p.pendingFees > 0n : p.pendingProceeds > 0n || p.pendingFees > 0n;
                const id = String(p.id);
                return (
                  <tr key={id} className="border-t border-border align-top" data-testid="pool-position-row" data-position-id={id}>
                    <td className="py-2 pr-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="num font-medium">#{id}</span>
                        <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", p.side === "Ask" ? "border-red/40 text-red" : "border-green/40 text-green")}>
                          {p.side === "Ask" ? "Ask: sells " : "Bid: buys "}
                          {inst.base.code}
                        </Badge>
                        {p.mode === "TwoWay" ? (
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                            two-way
                          </Badge>
                        ) : null}
                        {p.vaulted ? (
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-mutedfg">
                            USDC in DeFindex
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-mutedfg">
                        bins {p.loBin} to {p.hiBin}
                      </div>
                    </td>
                    <td className="num py-2 pr-2">
                      {priceText(p.loBin, inst.binStepBps)} to {priceText(p.hiBin, inst.binStepBps)}
                    </td>
                    <td className="num py-2 pr-2 text-right">
                      {fmtAmt(p.deposited)} <span className="text-mutedfg">{dep.code}</span>
                    </td>
                    <td className="num py-2 pr-2 text-right" data-testid={twoWay ? "twoway-holdings" : undefined}>
                      {fmtAmt(p.inventory)} <span className="text-mutedfg">{u.inventory.code}</span>
                      {twoWay ? (
                        <div>
                          {fmtAmt(p.pendingProceeds)} <span className="text-mutedfg">{u.proceeds.code}</span>
                          <div className="text-[11px] text-mutedfg">both held now</div>
                        </div>
                      ) : null}
                    </td>
                    <td className="num py-2 pr-2 text-right">
                      {fmtAmt(p.filled)} <span className="text-mutedfg">{u.inventory.code}</span>
                      <div className="text-[11px] text-mutedfg">{twoWay ? "traded through, both ways" : `${fmt(filledPct, 1)}% of deposit`}</div>
                    </td>
                    <td className={cn("num py-2 pr-2 text-right", !twoWay && p.pendingProceeds > 0n && "text-green")}>
                      {twoWay ? (
                        <span className="text-mutedfg">in reserve (paid on Remove)</span>
                      ) : (
                        <>
                          {fmtAmt(p.pendingProceeds)} <span className="text-mutedfg">{u.proceeds.code}</span>
                        </>
                      )}
                    </td>
                    <td className={cn("num py-2 pr-2 text-right", p.pendingFees > 0n && "text-green")}>
                      {fmtAmt(p.pendingFees)} <span className="text-mutedfg">{u.fees.code}</span>
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="xs" variant="outline" disabled={running || !claimable} onClick={() => act("claim", p, inst)} data-testid={`pool-claim-${id}`}>
                          {busy === `claim-${id}` ? <Spinner /> : null}
                          Claim
                        </Button>
                        {poolPositionLocked(p) ? (
                          <Button size="xs" variant="outline" disabled title="Locked until the order is fully filled. Early redemption is coming soon." data-testid={`pool-early-${id}`}>
                            {EARLY_REDEMPTION_LABEL}
                          </Button>
                        ) : (
                          <Button size="xs" variant="outline" disabled={running} onClick={() => act("remove", p, inst)} data-testid={`pool-remove-${id}`}>
                            {busy === `remove-${id}` ? <Spinner /> : null}
                            Remove
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {positions.length > 0 ? (
        <p className="mt-3 text-[11px] text-mutedfg">
          Directional positions only move one way: remaining inventory goes down, proceeds and fees go up and are never re-offered. Claim pays out proceeds and fees and keeps the position open. A directional position is locked until fully filled (early redemption is coming); Remove then closes it.
          Two-way positions trade in both directions: they hold both {inst.base.code} and {inst.quote.code} right now, so you can end up with more of either asset; Claim pays fees only and Remove pays both reserves plus fees.
        </p>
      ) : null}
    </Panel>
  );
}

/** Lotus pool positions of the account, one block per pool instance. */
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
  return (
    <section className="min-w-0 space-y-4" data-testid="portfolio-pool-positions">
      <ActionStatus state={actions.status.state} network={network} onDismiss={actions.status.reset} />
      {data === null ? (
        <Panel title="Lotus pool positions">
          <Empty>Loading...</Empty>
        </Panel>
      ) : data.length === 0 ? (
        <Panel title="Lotus pool positions">
          <Empty>No Lotus pool is configured.</Empty>
        </Panel>
      ) : (
        // a retired instance is only shown when this account still has positions there
        data.filter((d) => d.inst.status !== "retired" || d.positions.length > 0 || !!d.error).map((d) => <PoolSection key={d.inst.id} entry={d} network={network} actions={actions} />)
      )}
    </section>
  );
}
