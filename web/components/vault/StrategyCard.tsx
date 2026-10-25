"use client";

import { ArrowRight, Check } from "lucide-react";
import type { MouseEvent } from "react";
import { AssetLink, Dot, ExplorerLink, Spinner, Stat } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Strategy, StrategyStatus } from "@/lib/config-types";
import type { VaultStats } from "@/lib/stellar";
import { STATUS_META, fmtAmt, hasContract } from "@/lib/vault";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: StrategyStatus; className?: string }) {
  const m = STATUS_META[status];
  const live = m.tone === "green";
  return (
    <Badge
      variant="outline"
      data-testid="vault-status"
      data-status={status}
      className={cn(
        "gap-1.5 py-1 pl-2 pr-2.5 font-medium",
        live ? "border-green/30 bg-green/10 text-green" : "border-line bg-white/5 text-mutedfg",
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", live ? "animate-pulse bg-green" : "bg-mutedfg")} aria-hidden />
      {m.label}
    </Badge>
  );
}

/** USDC -> Lotus vault -> DeFindex vault -> Blend, as chips. The Blend leg is dimmed when nothing is allocated to it. */
export function Route({ strategy }: { strategy: Strategy }) {
  const idle = strategy.status !== "live";
  const nodes = [
    { label: strategy.underlying.code, dim: false },
    { label: "Lotus vault", dim: false },
    { label: "DeFindex vault", dim: false },
    { label: "Blend", dim: idle },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="vault-route">
      <span className="sr-only">
        {`${strategy.underlying.code} -> Lotus vault -> DeFindex vault -> Blend${idle ? " (not allocated)" : ""}`}
      </span>
      {nodes.map((n, i) => (
        <span key={n.label} className="flex items-center gap-1.5" aria-hidden>
          {i > 0 ? <ArrowRight className={cn("size-3.5 text-mutedfg", n.dim && "opacity-40")} /> : null}
          <span
            title={n.dim ? "No allocation on testnet: the DeFindex vault keeps funds idle" : undefined}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium",
              n.dim ? "border-dashed border-line text-mutedfg/60 line-through decoration-white/20" : "border-line bg-secondary text-foreground",
            )}
          >
            {n.label}
          </span>
        </span>
      ))}
    </div>
  );
}

const stop = (e: MouseEvent) => e.stopPropagation();

export function StrategyCard({
  strategy,
  stats,
  loading,
  selected,
  onSelect,
  network,
}: {
  strategy: Strategy;
  stats: VaultStats | null;
  loading: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  network: string;
}) {
  const selectable = hasContract(strategy);
  const allNull = !!stats && stats.supply === null && stats.vaultValue === null && stats.surplus === null;
  const surplusPct =
    stats && stats.surplus !== null && stats.supply !== null && stats.supply > 0n ? (Number(stats.surplus) / Number(stats.supply)) * 100 : null;
  const u = strategy.underlying;
  const r = strategy.receipt;
  const val = (v: bigint | null | undefined, dp = 2) => (stats ? fmtAmt(v, dp) : loading && selectable ? <Spinner /> : "—");

  return (
    <div
      data-testid={`vault-strategy-${strategy.id}`}
      data-selected={selected ? "true" : "false"}
      onClick={() => selectable && onSelect(strategy.id)}
      className={cn(
        "card flex min-w-0 flex-col gap-4 p-5 transition",
        selectable && "cursor-pointer hover:border-white/20",
        selected && "border-primary/40 ring-1 ring-primary",
        !selectable && "opacity-80",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight">{strategy.label}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={strategy.status} />
            {strategy.status === "live" ? (
              <Badge data-testid="vault-recommended" className="h-6 px-2 text-[10px]">
                Recommended
              </Badge>
            ) : null}
          </div>
        </div>
        {selectable ? (
          <Button
            type="button"
            size="xs"
            variant={selected ? "default" : "outline"}
            data-testid={`vault-select-${strategy.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(strategy.id);
            }}
          >
            {selected ? <Check /> : null}
            {selected ? "Selected" : "Select"}
          </Button>
        ) : (
          <span className="text-xs text-mutedfg">No contract yet</span>
        )}
      </div>

      <Route strategy={strategy} />

      <div className="grid grid-cols-3 gap-3">
        <Stat label="TVL" value={val(stats?.supply)} sub={`${r.code} supply`} />
        <Stat label="Backing" value={val(stats?.vaultValue)} sub={`${u.code} value`} />
        <Stat
          label="Surplus"
          value={<span className={cn(stats?.surplus && stats.surplus > 0n && "text-green")}>{val(stats?.surplus, 4)}</span>}
          sub={surplusPct === null ? "undistributed yield" : `${surplusPct < 0.01 && surplusPct > 0 ? "<0.01" : surplusPct.toFixed(2)}% of supply`}
        />
      </div>
      {strategy.observed ? (
        <div data-testid="vault-observed" className="rounded-xl border border-green/30 bg-green/5 px-3 py-2 text-xs leading-relaxed">
          <span className="font-medium text-green">Observed yield</span>
          <span className="text-mutedfg"> (measured by the deployment team, not computed live here; not a forecast, it moves with testnet Blend utilization)</span>
          <p className="mt-1 text-foreground/90">{strategy.observed.summary}</p>
          <p className="mt-0.5 text-[11px] text-mutedfg">Measured {strategy.observed.measuredOn}</p>
        </div>
      ) : strategy.status === "idle" ? (
        <p className="text-xs text-mutedfg" data-testid="vault-no-yield">
          No yield: the DeFindex testnet vault behind this Lotus vault has no allocation to Blend, so deposits stay idle.
        </p>
      ) : null}
      {allNull ? (
        <p className="-mt-2 flex items-center gap-1.5 text-xs text-mutedfg">
          <Dot ok={false} /> Contract views unavailable right now (RPC).
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-mutedfg" onClick={stop}>
        {hasContract(strategy) ? (
          <span className="flex items-center gap-1.5">
            Lotus vault <ExplorerLink kind="contract" id={strategy.lotusVault} network={network} />
          </span>
        ) : null}
        {strategy.defindexVault ? (
          <span className="flex items-center gap-1.5">
            DeFindex vault <ExplorerLink kind="contract" id={strategy.defindexVault} network={network} />
          </span>
        ) : null}
        {strategy.defindexStrategy ? (
          <span className="flex items-center gap-1.5">
            Strategy <ExplorerLink kind="contract" id={strategy.defindexStrategy} network={network} />
          </span>
        ) : null}
        {strategy.blendPool ? (
          <span className="flex items-center gap-1.5">
            Blend pool <ExplorerLink kind="contract" id={strategy.blendPool} network={network} />
          </span>
        ) : null}
        {r.issuer ? (
          <span className="flex items-center gap-1.5">
            Receipt <AssetLink asset={r} network={network} label={`${r.code} asset`} />
          </span>
        ) : null}
        {r.sac ? (
          <span className="flex items-center gap-1.5">
            SAC <ExplorerLink kind="contract" id={r.sac} network={network} />
          </span>
        ) : null}
      </div>

      {strategy.notes ? (
        <p title={strategy.notes} className="line-clamp-3 text-xs leading-relaxed text-mutedfg/80">
          {strategy.notes}
        </p>
      ) : null}
    </div>
  );
}
