"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { fromStroops } from "@/lib/amount";
import type { PoolInstance } from "@/lib/config-types";
import { useTx, type Polled } from "@/lib/hooks";
import type { PoolClient, Position } from "@/lib/pool";
import { priceAt } from "@/lib/poolGrid";
import { fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { Empty, ExplorerLink, Panel, Spinner, TxStatus } from "@/components/common";

/** Positions of the connected account in this pool, with Claim (keeps the position open) and Remove (closes it). */
export function MyPositions({
  inst,
  client,
  positions,
  network,
  onChanged,
}: {
  inst: PoolInstance;
  client: PoolClient;
  positions: Polled<Position[]>;
  network: string;
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const claimTx = useTx("Claim");
  const removeTx = useTx("Remove position");
  const [busy, setBusy] = useState<string | null>(null);

  const act = (kind: "claim" | "remove", p: Position) => {
    const runner = kind === "claim" ? claimTx : removeTx;
    return runner.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      setBusy(`${kind}-${p.id}`);
      try {
        const ctx = { source: wallet.address, sign: wallet.sign, onStage };
        const r = kind === "claim" ? await client.claim(ctx, p.id) : await client.removePosition(ctx, p.id);
        onChanged();
        return { hash: r.hash, result: r.result, note: `position #${p.id} ${kind === "claim" ? "claimed" : "removed"}${r.simulated ? " (simulated locally, no transaction)" : ""}` };
      } finally {
        setBusy(null);
      }
    });
  };

  const rows = positions.data ?? [];
  // Directional Ask: inventory BASE, proceeds+fees QUOTE. Directional Bid: inventory QUOTE, proceeds BASE, fees QUOTE.
  // Two-way (either side): inventory = BASE held now, pending_proceeds = QUOTE held now, fees QUOTE.
  const unit = (p: Position, what: "inventory" | "proceeds") =>
    p.mode === "TwoWay"
      ? what === "inventory"
        ? inst.base.code
        : inst.quote.code
      : what === "inventory"
        ? p.side === "Ask"
          ? inst.base.code
          : inst.quote.code
        : p.side === "Ask"
          ? inst.quote.code
          : inst.base.code;

  return (
    <Panel
      title="My positions"
      subtitle="Directional positions: inventory only goes down, proceeds only go up. Two-way positions hold both assets and trade both ways. Claim keeps the position (two-way: fees only); Remove closes it and pays everything."
      right={inst.contract ? <ExplorerLink kind="contract" id={inst.contract} network={network} label="pool contract" n={4} className="text-xs" /> : null}
    >
      {!wallet.address ? (
        <Empty>Connect a wallet to see your pool positions.</Empty>
      ) : positions.error ? (
        <Empty>
          <span className="text-destructive">{positions.error}</span>
        </Empty>
      ) : !positions.data ? (
        <Empty>Loading...</Empty>
      ) : rows.length === 0 ? (
        <Empty>No positions in this pool yet. Add one with the builder.</Empty>
      ) : (
        <div className="overflow-x-auto scroll-thin" data-testid="pool-positions">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="label text-left">
                <th className="py-1 pr-2 font-normal">ID</th>
                <th className="py-1 pr-2 font-normal">Side</th>
                <th className="py-1 pr-2 font-normal">Range</th>
                <th className="py-1 pr-2 text-right font-normal">Inventory / held</th>
                <th className="py-1 pr-2 text-right font-normal">Filled</th>
                <th className="py-1 pr-2 text-right font-normal">Pending / fees</th>
                <th className="py-1 text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const twoWay = p.mode === "TwoWay";
                const depCode = p.side === "Ask" ? inst.base.code : inst.quote.code;
                const filledPct = p.deposited > 0n ? Number((p.filled * 1000n) / p.deposited) / 10 : 0;
                const lo = Number(priceAt(p.loBin, inst.binStepBps)) / 1e7;
                const hi = Number(priceAt(p.hiBin, inst.binStepBps)) / 1e7;
                return (
                  <tr key={String(p.id)} className="border-t border-border" data-testid="pool-position-row" data-position-id={String(p.id)}>
                    <td className="num py-1.5 pr-2">#{String(p.id)}</td>
                    <td className={cn("py-1.5 pr-2 font-medium", p.side === "Ask" ? "text-red" : "text-green")}>
                      {p.side}
                      <span className="block text-[10px] font-normal text-mutedfg" data-testid="position-mode">
                        {twoWay ? "two-way" : "directional"}
                      </span>
                    </td>
                    <td className="num py-1.5 pr-2">
                      {fmt(lo, 4, 4)} to {fmt(hi, 4, 4)}
                      <span className="block text-[10px] text-mutedfg">
                        bins {p.loBin}..{p.hiBin}
                        {p.vaulted ? " · USDC in DeFindex" : ""}
                      </span>
                    </td>
                    <td className="num py-1.5 pr-2 text-right" data-testid={twoWay ? "twoway-holdings" : undefined}>
                      {fmt(fromStroops(p.inventory), 2)} {unit(p, "inventory")}
                      {twoWay ? (
                        <span className="block">
                          {fmt(fromStroops(p.pendingProceeds), 2)} {inst.quote.code}
                          <span className="block text-[10px] text-mutedfg">both held now (deposited {fmt(fromStroops(p.deposited), 2)} {depCode})</span>
                        </span>
                      ) : null}
                    </td>
                    <td className="num py-1.5 pr-2 text-right">
                      {twoWay ? (
                        <>
                          {fmt(fromStroops(p.filled), 2)} {inst.base.code}
                          <span className="block text-[10px] text-mutedfg">traded through, both ways</span>
                        </>
                      ) : (
                        <>
                          <span className="text-green">{fmt(filledPct, 1)}%</span>
                          <span className="block text-[10px] text-mutedfg">
                            {fmt(fromStroops(p.filled), 2)} {unit(p, "inventory")}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="num py-1.5 pr-2 text-right">
                      {twoWay ? (
                        <>
                          {fmt(fromStroops(p.pendingFees), 4)} {inst.quote.code}
                          <span className="block text-[10px] text-mutedfg">fees (Claim pays fees only)</span>
                        </>
                      ) : (
                        <>
                          {fmt(fromStroops(p.pendingProceeds), 4)} {unit(p, "proceeds")}
                          <span className="block text-[10px] text-mutedfg">+ {fmt(fromStroops(p.pendingFees), 4)} {inst.quote.code} fees</span>
                        </>
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={claimTx.running || removeTx.running || (twoWay ? p.pendingFees === 0n : p.pendingProceeds === 0n && p.pendingFees === 0n)}
                          onClick={() => act("claim", p)}
                          data-testid={`pool-claim-${p.id}`}
                        >
                          {busy === `claim-${p.id}` ? <Spinner /> : null}
                          Claim
                        </Button>
                        <Button size="xs" variant="outline" disabled={claimTx.running || removeTx.running} onClick={() => act("remove", p)} data-testid={`pool-remove-${p.id}`}>
                          {busy === `remove-${p.id}` ? <Spinner /> : null}
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <TxStatus state={claimTx.state} network={network} onDismiss={claimTx.reset} />
      <TxStatus state={removeTx.state} network={network} onDismiss={removeTx.reset} />
    </Panel>
  );
}
