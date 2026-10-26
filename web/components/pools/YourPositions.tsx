"use client";

// "Your positions" across the four strategies, in the lotus-main dashboard style (owl/web/components/dashboard:
// YourPositionsTable + PositionFilters + PositionsEmptyState): pair glyph + range, status, fill bar, claimable,
// yield, actions. Lotus pool positions get Claim / Remove, SDEX ladders get Cancel (one classic transaction for the
// whole ladder); every row expands to its contract / offer explorer links. Data comes from the /portfolio loaders.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Layers, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExplorerLink, Spinner, TxStatus } from "@/components/common";
import { explorerContract, explorerOffer, explorerTx } from "@/lib/explorer";
import { positionCreationTx } from "@/lib/positionTx";
import { loadPoolPositions } from "@/components/portfolio/data";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { usePolling, useTx } from "@/lib/hooks";
import { decodePayout, getPoolClient } from "@/lib/pool";
import { cancelOfferOp, fetchOffers, fmt, fromStroops, submitClassicChunked, toAssetRef } from "@/lib/stellar";
import { fmtAmt } from "@/lib/vault";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { FillBar, PairGlyph, StatusBadge, type PositionStatus } from "./bits";
import { EARLY_REDEMPTION_LABEL, STRATEGY_LABEL, offerRows, poolPositionLocked, poolRows, type OfferRow, type PoolRow, type PositionRow } from "./positionsModel";

type Filter = "all" | PositionRow["strategy"];

const px = (n: number) => fmt(n, 4, 4);

export function YourPositions({ version, aprText, onNew }: { version: number; aprText: string | null; onNew: () => void }) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const address = wallet.address;
  const tx = useTx();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const poolsFn = useCallback(() => (address ? loadPoolPositions(config, net, address) : Promise.resolve([])), [config, net, address]);
  const pools = usePolling(poolsFn, 10000, !!address);
  const offersFn = useCallback(() => (address ? fetchOffers(config.horizon, address) : Promise.resolve([])), [config.horizon, address]);
  const offers = usePolling(offersFn, 8000, !!address);
  const { refresh: refreshPools } = pools;
  const { refresh: refreshOffers } = offers;
  const refresh = useCallback(() => {
    refreshPools();
    refreshOffers();
  }, [refreshPools, refreshOffers]);
  useEffect(() => {
    if (version > 0) refresh();
  }, [version, refresh]);

  const rows: PositionRow[] = useMemo(
    () => [...poolRows((pools.data ?? []).filter((d) => !d.error && !d.skipped)), ...offerRows(config, offers.data ?? [])],
    [pools.data, offers.data, config],
  );
  const shown = rows.filter((r) => filter === "all" || r.strategy === filter);
  const loading = !!address && (pools.data === null || offers.data === null) && !pools.error && !offers.error;
  const poolErrors = (pools.data ?? []).filter((d) => d.error);

  type StageFn = Parameters<Parameters<typeof tx.run>[0]>[0];
  const run = (key: string, fn: (onStage: StageFn) => Promise<{ hash: string; hashes?: string[]; result?: unknown; note?: string }>) => {
    setBusy(key);
    return tx.run(async (onStage) => {
      try {
        return await fn(onStage);
      } finally {
        setBusy(null);
        acct.refresh();
        refresh();
      }
    });
  };

  const poolAct = (kind: "claim" | "remove", r: PoolRow) =>
    run(`${kind}:${r.key}`, async (onStage) => {
      if (!address) throw new Error("Connect a wallet first");
      const client = getPoolClient(net, r.inst);
      const ctx = { source: address, sign: wallet.sign, onStage };
      const res = kind === "claim" ? await client.claim(ctx, r.position.id) : await client.removePosition(ctx, r.position.id);
      const p = decodePayout(res.result);
      const paid = [p.base > 0n ? `${fmtAmt(p.base)} ${r.inst.base.code}` : "", p.quote > 0n ? `${fmtAmt(p.quote)} ${r.inst.quote.code}` : ""].filter(Boolean).join(" + ");
      return { hash: res.hash, result: res.result, note: `${STRATEGY_LABEL[r.strategy]} #${r.position.id} ${kind === "claim" ? "claimed" : "removed"}${paid ? `: paid ${paid}` : ""}` };
    });

  // kept for "Early redemption" (the UI is gated: a listed ladder is locked until fully filled)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const cancel = (r: OfferRow) =>
    run(`cancel:${r.key}`, async (onStage) => {
      if (!address) throw new Error("Connect a wallet first");
      const ops = r.offers.map((o) => cancelOfferOp({ id: o.id, selling: toAssetRef(o.selling), buying: toAssetRef(o.buying), price_r: o.price_r }));
      const res = await submitClassicChunked(net, { source: address, sign: wallet.sign, ops, onStage });
      return { hash: res.hashes[res.hashes.length - 1], hashes: res.hashes, note: `cancelled ${r.offers.length} offer${r.offers.length === 1 ? "" : "s"} on ${r.base.code}/${r.quote.code}` };
    });

  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: rows.length };
    for (const r of rows) c[r.strategy] = (c[r.strategy] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <section data-testid="your-positions" data-count={rows.length}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Your positions</h2>
        <span className="text-[11px] text-mutedfg">all four strategies · live from Soroban RPC and Horizon</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" className="gap-1.5" onClick={onNew}>
          <Plus className="h-4 w-4" />
          New
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className={cn("gap-1.5", filter !== "all" && "border-primary/40 text-foreground")} data-testid="positions-filter">
              {filter === "all" ? "All strategies" : STRATEGY_LABEL[filter]}
              <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[14rem]">
            <DropdownMenuLabel>Strategy</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(["all", "pool", "pool-yield", "sdex", "sdex-yield", "two-way"] as Filter[]).map((k) => (
              <DropdownMenuItem key={k} onSelect={() => setFilter(k)} className="justify-between">
                {k === "all" ? "All strategies" : STRATEGY_LABEL[k]}
                <span className="flex items-center gap-2 text-[11px] text-mutedfg">
                  {counts[k] ?? 0}
                  {filter === k ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" className="gap-1.5 text-mutedfg" disabled>
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          <span className="text-foreground">Lotus · Stellar testnet</span>
        </Button>
      </div>

      <TxStatus state={tx.state} network={config.network} onDismiss={tx.reset} />

      {!address ? (
        <EmptyState title="Connect a wallet" body="Connect a wallet (top right) to see your orders in the Lotus pool and on the Stellar DEX." onNew={onNew} />
      ) : loading ? (
        <div className="card flex items-center justify-center gap-2 px-6 py-16 text-sm text-mutedfg">
          <Spinner /> Reading your positions on-chain...
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No positions" body="You have no range order yet. Set a range above, pick where it waits, and it shows up here, whatever the strategy." onNew={onNew} />
      ) : shown.length === 0 ? (
        <div className="card flex flex-col items-center justify-center px-6 py-12 text-center">
          <h3 className="text-sm font-semibold">No positions match this filter</h3>
          <p className="mt-1 max-w-xs text-[13px] text-mutedfg">Clear the strategy filter to see all your orders.</p>
        </div>
      ) : (
        <div className="card mt-3 overflow-hidden">
          <Table className="min-w-[820px]" data-testid="positions-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <Th className="pl-5">Position</Th>
                <Th>Strategy</Th>
                <Th className="w-[150px]">Status</Th>
                <Th className="text-right">Remaining</Th>
                <Th className="text-right">Claimable</Th>
                <Th>Yield</Th>
                <Th className="pr-5 text-right">Actions</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <Fragment key={r.key}>
                  {r.kind === "pool" ? (
                    <PoolTableRow r={r} aprText={aprText} open={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)} busy={busy} running={tx.running} onAct={poolAct} />
                  ) : (
                    <OfferTableRow r={r} aprText={aprText} open={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)} network={config.network} />
                  )}
                  {open === r.key ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="bg-white/[0.02] px-5 py-3">
                        <RowDetails r={r} network={config.network} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {poolErrors.length > 0 ? (
        <p className="mt-2 text-[11px] text-destructive">
          {poolErrors.map((d) => `${d.inst.label}: ${d.error}`).join(" · ")}
        </p>
      ) : null}
      {offers.error ? <p className="mt-2 text-[11px] text-destructive">Offers: {offers.error}</p> : null}
    </section>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <TableHead className={cn("text-[11px] font-medium uppercase tracking-wide text-mutedfg", className)}>{children}</TableHead>;
}

function StrategyBadge({ s }: { s: PositionRow["strategy"] }) {
  const y = s === "pool-yield" || s === "sdex-yield";
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap text-[11px] font-medium", y ? "border-green/30 bg-green/5 text-green" : "border-line text-foreground/80")} data-testid="position-strategy" data-strategy={s}>
      {STRATEGY_LABEL[s]}
    </Badge>
  );
}

function PositionCell({ base, quote, id, side, lo, hi, onToggle, open }: { base: string; quote: string; id: string; side: "Ask" | "Bid"; lo: number; hi: number; onToggle: () => void; open: boolean }) {
  return (
    <button type="button" className="flex items-center gap-2.5 text-left" onClick={onToggle} aria-expanded={open}>
      <PairGlyph base={base} quote={quote} />
      <div>
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-mutedfg">{id}</span>
          {base} <span className="text-mutedfg">/</span> {quote}
          <span className={cn("text-[11px] font-medium", side === "Ask" ? "text-red" : "text-green")}>{side === "Ask" ? "Sell" : "Buy"}</span>
        </div>
        <div className="whitespace-nowrap text-[11px] tabular-nums text-mutedfg">
          {px(lo)} – {px(hi)}
        </div>
      </div>
      {open ? <ChevronDown className="size-4 text-mutedfg" /> : <ChevronRight className="size-4 text-mutedfg" />}
    </button>
  );
}

function YieldCell({ on, aprText }: { on: boolean; aprText: string | null }) {
  if (!on) return <span className="text-[11px] text-mutedfg">none</span>;
  return (
    <div className="max-w-[150px]">
      <div className="text-[11px] tabular-nums text-primary">{aprText ?? "Blend"}</div>
      <div className="truncate text-[11px] text-mutedfg">Blend via DeFindex</div>
    </div>
  );
}

function PoolTableRow({
  r,
  aprText,
  open,
  onToggle,
  busy,
  running,
  onAct,
}: {
  r: PoolRow;
  aprText: string | null;
  open: boolean;
  onToggle: () => void;
  busy: string | null;
  running: boolean;
  onAct: (k: "claim" | "remove", r: PoolRow) => void;
}) {
  const p = r.position;
  const inst = r.inst;
  const twoWay = p.mode === "TwoWay";
  const status: PositionStatus = p.filled === 0n ? "active" : p.inventory === 0n && !twoWay ? "filled" : "filling";
  const invCode = twoWay ? inst.base.code : p.side === "Ask" ? inst.base.code : inst.quote.code;
  const procCode = twoWay ? inst.quote.code : p.side === "Ask" ? inst.quote.code : inst.base.code;
  const claimable = twoWay ? p.pendingFees > 0n : p.pendingProceeds > 0n || p.pendingFees > 0n;
  return (
    <TableRow data-testid="position-row" data-kind="pool" data-strategy={r.strategy} data-position-id={String(p.id)} data-pool={inst.id}>
      <TableCell className="py-3.5 pl-5">
        <PositionCell base={inst.base.code} quote={inst.quote.code} id={`#${p.id}`} side={p.side} lo={r.lo} hi={r.hi} onToggle={onToggle} open={open} />
      </TableCell>
      <TableCell>
        <StrategyBadge s={r.strategy} />
      </TableCell>
      <TableCell>
        <StatusBadge status={status} />
        <FillBar pct={twoWay ? null : r.filledPct} className="mt-1.5 w-[120px]" />
      </TableCell>
      <TableCell className="text-right text-sm tabular-nums">
        {fmt(fromStroops(p.inventory), 2)} <span className="text-[11px] text-mutedfg">{invCode}</span>
      </TableCell>
      <TableCell className="text-right">
        {claimable ? (
          <span className="text-sm font-semibold tabular-nums text-green">
            {twoWay ? fmt(fromStroops(p.pendingFees), 4) : fmt(fromStroops(p.pendingProceeds), 4)} <span className="text-[11px] font-normal">{twoWay ? inst.quote.code : procCode}</span>
            {!twoWay && p.pendingFees > 0n ? <span className="block text-[11px] font-normal">+ {fmt(fromStroops(p.pendingFees), 4)} {inst.quote.code} fees</span> : null}
          </span>
        ) : (
          <span className="text-sm text-mutedfg">—</span>
        )}
      </TableCell>
      <TableCell>
        <YieldCell on={r.strategy === "pool-yield"} aprText={aprText} />
      </TableCell>
      <TableCell className="whitespace-nowrap pr-5 text-right">
        <div className="flex justify-end gap-1.5">
          {claimable ? (
            <Button size="xs" variant="outline" disabled={running} onClick={() => onAct("claim", r)} data-testid={`claim-${inst.id}-${p.id}`}>
              {busy === `claim:${r.key}` ? <Spinner /> : null}
              Claim
            </Button>
          ) : null}
          {poolPositionLocked(p) ? (
            <EarlyRedemption testId={`early-${inst.id}-${p.id}`} />
          ) : (
            <Button size="xs" variant="outline" disabled={running} onClick={() => onAct("remove", r)} data-testid={`remove-${inst.id}-${p.id}`}>
              {busy === `remove:${r.key}` ? <Spinner /> : null}
              Remove
            </Button>
          )}
          <ViewPoolPosition contract={inst.contract} owner={p.owner} id={p.id} testId={`view-${inst.id}-${p.id}`} />
        </div>
      </TableCell>
    </TableRow>
  );
}

function OfferTableRow({
  r,
  aprText,
  open,
  onToggle,
  network,
}: {
  r: OfferRow;
  network: string;
  aprText: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const live = r.receiptOf?.status === "live";
  return (
    <TableRow data-testid="position-row" data-kind="sdex" data-strategy={r.strategy} data-offers={r.offers.length} data-side={r.side} data-quote={r.quote.code}>
      <TableCell className="py-3.5 pl-5">
        <PositionCell base={r.base.code} quote={r.quote.code} id={`${r.offers.length} offer${r.offers.length === 1 ? "" : "s"}`} side={r.side} lo={r.lo} hi={r.hi} onToggle={onToggle} open={open} />
      </TableCell>
      <TableCell>
        <StrategyBadge s={r.strategy} />
      </TableCell>
      <TableCell>
        <StatusBadge status="active" />
        <div className="mt-1.5 text-[10px] text-mutedfg">fills paid to your account</div>
      </TableCell>
      <TableCell className="text-right text-sm tabular-nums">
        {fmt(r.remaining, 2)} <span className="text-[11px] text-mutedfg">{r.side === "Ask" ? r.base.code : r.quote.code}</span>
      </TableCell>
      <TableCell className="text-right">
        <span className="text-sm text-mutedfg" title="SDEX fills are paid to your account at once: nothing to claim">—</span>
      </TableCell>
      <TableCell>
        <YieldCell on={r.strategy === "sdex-yield" && live} aprText={aprText} />
      </TableCell>
      <TableCell className="whitespace-nowrap pr-5 text-right">
        {/* a listed ladder is never fully filled (filled offers leave the book): locked, see poolPositionLocked */}
        <div className="flex justify-end gap-1.5">
          <EarlyRedemption testId={`early-${r.side}-${r.quote.code}`} />
          {r.offers.length === 1 ? (
            <Button size="xs" variant="ghost" asChild>
              <a href={explorerOffer(r.offers[0].id, network)} target="_blank" rel="noreferrer" data-testid={`view-${r.side}-${r.quote.code}`}>
                View offer
              </a>
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={onToggle} data-testid={`view-${r.side}-${r.quote.code}`} title="One link per offer below">
              View {r.offers.length} offers
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function RowDetails({ r, network }: { r: PositionRow; network: string }) {
  if (r.kind === "pool") {
    const p = r.position;
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-mutedfg">
        <span>
          {r.inst.label} · bins {p.loBin} to {p.hiBin} · deposited {fmt(fromStroops(p.deposited), 2)} {p.side === "Ask" ? r.inst.base.code : r.inst.quote.code} · {p.mode === "TwoWay" ? "two-way" : "directional"}
        </span>
        <span className="flex items-center gap-1.5">
          pool <ExplorerLink kind="contract" id={r.inst.contract} network={network} />
        </span>
        {r.inst.vault ? (
          <span className="flex items-center gap-1.5">
            DeFindex vault <ExplorerLink kind="contract" id={r.inst.vault} network={network} />
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="text-[11px] text-mutedfg">
      <p className="mb-1.5">
        One SDEX offer per bin. Fills pay you directly in {r.side === "Ask" ? r.quote.code : r.base.code}; nothing to claim.
        {r.strategy === "sdex-yield" ? ` Quoted in ${r.quote.code}, the Lotus receipt: it stays on your account while it waits and keeps earning; redeem it for USDC in Portfolio.` : ""}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {r.offers.map((o) => {
          const perBase = r.side === "Ask" ? Number(o.price) : 1 / Number(o.price);
          return (
            <span key={o.id} className="flex items-center gap-1.5 tabular-nums">
              {px(perBase)} · {fmt(o.amount, 2)} {r.side === "Ask" ? r.base.code : r.quote.code}
              <ExplorerLink kind="offer" id={o.id} network={network} label={`#${o.id}`} mono={false} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "View position": the stellar.expert page of the add_position transaction (found from the pool's position_added
 * event, lib/positionTx.ts, cached), or the pool contract page while it resolves / when outside RPC retention.
 */
function ViewPoolPosition({ contract, owner, id, testId }: { contract: string; owner: string; id: bigint; testId: string }) {
  const net = useNet();
  const config = useConfig();
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    positionCreationTx(net, contract, owner, id).then((h) => alive && setHash(h));
    return () => {
      alive = false;
    };
  }, [net, contract, owner, id]);
  const href = hash ? explorerTx(hash, config.network) : explorerContract(contract, config.network);
  return (
    <Button size="xs" variant="ghost" asChild>
      <a href={href} target="_blank" rel="noreferrer" data-testid={testId} data-resolved={hash ? "tx" : "contract"} title={hash ? "Transaction that created this position" : "Pool contract (creation tx not found in RPC retention)"}>
        View position
      </a>
    </Button>
  );
}

function EarlyRedemption({ testId }: { testId: string }) {
  return (
    <Button size="xs" variant="outline" disabled title="Locked until the order is fully filled. Early redemption is coming soon." data-testid={testId}>
      {EARLY_REDEMPTION_LABEL}
    </Button>
  );
}

function EmptyState({ title, body, onNew }: { title: string; body: string; onNew: () => void }) {
  return (
    <div className="card mt-3 flex flex-col items-center justify-center px-6 py-14 text-center" data-testid="positions-empty">
      <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-white/[0.03] text-mutedfg">
        <Layers className="h-6 w-6" />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-mutedfg">{body}</p>
      <Button className="mt-6 gap-1.5" onClick={onNew}>
        <Plus className="h-4 w-4" />
        New position
      </Button>
    </div>
  );
}

