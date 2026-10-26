"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EARLY_REDEMPTION_LABEL } from "@/components/pools/positionsModel";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { useTx, type Polled } from "@/lib/hooks";
import type { Market } from "@/lib/markets";
import { describeOffer, earnTag, groupOffers, rangeLocked, type Described, type OrderRow, type OriginIndex, type RangeOrderRow } from "@/lib/offerGroups";
import { loadOfferOrigins } from "@/lib/offerOrigin";
import { cancelOfferOp, fmt, submitClassicChunked, toAssetRef, type AssetRef, type HorizonOffer } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { AssetLink, Empty, ExplorerLink, Panel, Segmented, Spinner, TxStatus } from "@/components/common";

export { describeOffer };

/**
 * Open offers of `address` grouped as orders: the offers one transaction created on one pair are one range row
 * (lib/offerGroups.ts). `ready` is false until the creating transactions have been looked up once (or failed).
 */
export function useOrderRows(markets: Market[], offers: HorizonOffer[] | null, address: string | null) {
  const { horizon } = useConfig();
  const [origins, setOrigins] = useState<{ key: string; index: OriginIndex | null } | null>(null);
  const ids = useMemo(() => (offers ?? []).map((o) => o.id).sort(), [offers]);
  const idsKey = `${address}|${ids.join(",")}`;

  useEffect(() => {
    if (!address || !offers || ids.length === 0) return;
    let alive = true;
    loadOfferOrigins(horizon, address, ids)
      .then((index) => {
        if (alive) setOrigins({ key: idsKey, index });
      })
      .catch(() => {
        // fallback: every offer stays a single row (or keeps the last known grouping)
        if (alive) setOrigins((cur) => ({ key: idsKey, index: cur?.index ?? null }));
      });
    return () => {
      alive = false;
    };
    // ids / offers are captured through idsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon, idsKey]);

  const described = useMemo(() => (offers ?? []).map((o) => describeOffer(o, markets)), [offers, markets]);
  const rows = useMemo(() => groupOffers(described, origins?.index ?? null), [described, origins]);
  // after the first lookup, a new offer set keeps showing the previous grouping until its own lookup lands
  const ready = ids.length === 0 || origins !== null;
  return { rows, ready, described };
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function EarlyRedemption({ testId }: { testId: string }) {
  return (
    <Button size="xs" variant="outline" disabled title="Locked until the order is fully filled. Early redemption is coming soon." data-testid={testId}>
      {EARLY_REDEMPTION_LABEL}
    </Button>
  );
}

/**
 * Open orders of the connected account: single offers and range orders (one row per ladder, expandable to its
 * offers). Cancel = manageSellOffer amount 0 + offer id; a range cancels in one transaction. `locked` (/portfolio)
 * hides every Cancel. A range quoted in a Lotus receipt (DEX + Blend yield) is always locked (UI rule).
 */
export function OpenOffers({
  markets,
  market,
  offers,
  onChanged,
  bare = false,
  locked = false,
}: {
  markets: Market[];
  market: Market | null;
  /** polled by the page so every action can refresh it */
  offers: Polled<HorizonOffer[]>;
  onChanged: () => void;
  /** exchange layout (/trade bottom panel): no card, flat table, toolbar inline */
  bare?: boolean;
  /** no cancel at all (portfolio rule: resting orders are locked until filled) */
  locked?: boolean;
}) {
  const { network } = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Cancel");
  const [scope, setScope] = useState<"market" | "all">("market");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const { rows, ready } = useOrderRows(markets, offers.data, wallet.address);
  const rowMarket = (r: OrderRow) => (r.kind === "range" ? r.market : r.d.market);
  const shown = scope === "all" || !market ? rows : rows.filter((r) => rowMarket(r)?.id === market.id);
  const cancellable = locked ? [] : shown.flatMap((r) => (rangeLocked(r) ? [] : r.kind === "range" ? r.offers : [r.d]));

  const cancel = (ds: Described[], busy: string, what?: string) =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      setBusyId(busy);
      try {
        const ops = ds.map((d) =>
          cancelOfferOp({
            id: d.offer.id,
            selling: toAssetRef(d.offer.selling) as AssetRef,
            buying: toAssetRef(d.offer.buying) as AssetRef,
            price_r: d.offer.price_r,
          }),
        );
        const r = await submitClassicChunked(net, { source: wallet.address, ops, sign: wallet.sign, onStage });
        offers.refresh();
        acct.refresh();
        onChanged();
        return { hash: r.hashes[0], hashes: r.hashes, note: what ?? (ds.length === 1 ? `offer #${ds[0].offer.id} cancelled` : `${ds.length} offers cancelled`) };
      } finally {
        setBusyId(null);
      }
    });

  const toolbar = (
    <div className="flex items-center gap-2">
      {!locked ? (
        <Segmented value={scope} onChange={setScope} size="sm" className="w-44" options={[{ value: "market", label: market?.label ?? "Market" }, { value: "all", label: "All" }]} />
      ) : null}
      {cancellable.length > 1 ? (
        <Button size="xs" variant="outline" disabled={tx.running} onClick={() => setConfirmAll(true)} data-testid="offers-cancel-all">
          Cancel {cancellable.length}
        </Button>
      ) : null}
    </div>
  );
  const th = bare ? "px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-mutedfg" : "py-1 pr-2 font-normal";
  const td = bare ? "px-3 py-1.5" : "py-1.5 pr-2";
  const rowCls = bare ? "border-b border-border/50 transition-colors hover:bg-white/[0.03]" : "border-t border-border";

  const marketCell = (m: Market | null, side: Described["side"], d: Described) => (
    <>
      {m ? m.label : <AssetLink asset={toAssetRef(d.offer.selling)} network={network} label={`${d.sellCode} > ${d.buyCode}`} />}
      {(() => {
        const tag = earnTag(m, side);
        return tag ? (
          <span className="ml-1.5 text-[10px] text-primary" title={tag.title} data-testid="offer-earning">
            {tag.label}
          </span>
        ) : null;
      })()}
    </>
  );
  const sideCls = (side: Described["side"]) => cn("font-medium", side === "Ask" ? "text-red" : side === "Bid" ? "text-green" : "text-mutedfg");
  const filledCell = (p: number | null) => (p === null ? <span className="text-mutedfg">-</span> : `${fmt(p, p > 0 && p < 1 ? 2 : 1)}%`);
  const sizeUnit = (d: Described) => (d.market ? d.market.base.code : d.sellCode);
  const totalUnit = (d: Described) => (d.market ? d.market.quote.code : d.buyCode);

  const cancelBtn = (ds: Described[], busy: string, testId: string, label: string, what?: string) => (
    <Button size="xs" variant="outline" disabled={tx.running} onClick={() => cancel(ds, busy, what)} data-testid={testId}>
      {busyId === busy ? <Spinner /> : null}
      {label}
    </Button>
  );

  const rangeRow = (r: RangeOrderRow) => {
    const isOpen = !!open[r.key];
    const lockedRange = rangeLocked(r);
    const first = r.offers[0];
    return (
      <Fragment key={r.key}>
        <tr className={rowCls} data-testid="range-row" data-tx={r.tx.hash} data-levels={r.levels} data-open={r.open} data-locked={lockedRange ? "1" : "0"}>
          <td className={td}>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-left font-medium hover:text-primary"
              onClick={() => setOpen((cur) => ({ ...cur, [r.key]: !isOpen }))}
              aria-expanded={isOpen}
              data-testid="range-toggle"
            >
              {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              Range
              <span className="font-normal text-mutedfg" title={`${r.open} of the ${r.levels} offers this transaction created are still open`}>
                {r.open === r.levels ? `${r.levels} levels` : `${r.open}/${r.levels} levels`}
              </span>
            </button>
          </td>
          <td className={td}>{marketCell(r.market, r.side, first)}</td>
          <td className={cn(td, sideCls(r.side))}>{r.side}</td>
          <td className={cn(td, "num text-right")}>
            {fmt(r.lo, 4, 4)} – {fmt(r.hi, 4, 4)}
          </td>
          <td className={cn(td, "num text-right")}>
            {fmt(r.size, 2)} {sizeUnit(first)}
          </td>
          <td className={cn(td, "num text-right text-mutedfg")}>
            {fmt(r.total, 2)} {totalUnit(first)}
          </td>
          <td className={cn(td, "num text-right")} data-testid="range-filled">
            {filledCell(r.filledPct)}
          </td>
          <td className={cn(td, "whitespace-nowrap text-mutedfg")}>
            <span className="num">{fmtTime(r.tx.createdAt)}</span> <ExplorerLink kind="tx" id={r.tx.hash} network={network} title="Transaction that created this range" />
          </td>
          <td className={cn(td, "text-right")}>
            {lockedRange ? (
              <EarlyRedemption testId="range-early" />
            ) : locked ? null : (
              cancelBtn(r.offers, r.key, "range-cancel", "Cancel range", `range cancelled (${r.offers.length} offers)`)
            )}
          </td>
        </tr>
        {isOpen
          ? r.offers.map((d) => (
              <tr key={d.offer.id} className={cn(rowCls, "bg-white/[0.015]")} data-testid="range-offer-row" data-offer-id={d.offer.id}>
                <td className={cn(td, "pl-8")}>
                  <ExplorerLink kind="offer" id={d.offer.id} network={network} />
                </td>
                <td className={td} />
                <td className={cn(td, sideCls(d.side))}>{d.side}</td>
                <td className={cn(td, "num text-right")}>{fmt(d.price, 4, 4)}</td>
                <td className={cn(td, "num text-right")}>
                  {fmt(d.size, 2)} {sizeUnit(d)}
                </td>
                <td className={cn(td, "num text-right text-mutedfg")}>
                  {fmt(d.total, 2)} {totalUnit(d)}
                </td>
                <td className={td} />
                <td className={td} />
                <td className={cn(td, "text-right")}>{locked || lockedRange ? null : cancelBtn([d], d.offer.id, "offer-cancel", "Cancel")}</td>
              </tr>
            ))
          : null}
      </Fragment>
    );
  };

  const body = (
    <>
      {!wallet.address ? (
        <Empty>Connect a wallet to see your open offers.</Empty>
      ) : offers.error ? (
        <Empty>
          <span className="text-destructive">{offers.error}</span>
        </Empty>
      ) : !offers.data || !ready ? (
        <Empty>Loading...</Empty>
      ) : shown.length === 0 ? (
        <Empty>No open orders{scope === "market" && market ? ` on ${market.label}` : ""}.</Empty>
      ) : (
        <div className="overflow-x-auto scroll-thin" data-testid="open-offers">
          <table className="w-full min-w-[820px] text-xs">
            <thead>
              <tr className={cn("text-left", bare ? "border-b border-border" : "label")}>
                <th className={th}>Order</th>
                <th className={th}>Market</th>
                <th className={th}>Side</th>
                <th className={cn(th, "text-right")}>Price</th>
                <th className={cn(th, "text-right")}>Size</th>
                <th className={cn(th, "text-right")}>Total</th>
                <th className={cn(th, "text-right")} title="Share of the amount posted at creation that has been filled">
                  Filled
                </th>
                <th className={th}>Created</th>
                <th className={cn(th, "text-right")} />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) =>
                r.kind === "range" ? (
                  rangeRow(r)
                ) : (
                  <tr key={r.key} className={rowCls} data-testid="offer-row" data-offer-id={r.d.offer.id}>
                    <td className={td}>
                      <ExplorerLink kind="offer" id={r.d.offer.id} network={network} />
                    </td>
                    <td className={td}>{marketCell(r.d.market, r.d.side, r.d)}</td>
                    <td className={cn(td, sideCls(r.d.side))}>{r.d.side}</td>
                    <td className={cn(td, "num text-right")}>{fmt(r.d.price, 4, 4)}</td>
                    <td className={cn(td, "num text-right")}>
                      {fmt(r.d.size, 2)} {sizeUnit(r.d)}
                    </td>
                    <td className={cn(td, "num text-right text-mutedfg")}>
                      {fmt(r.d.total, 2)} {totalUnit(r.d)}
                    </td>
                    <td className={cn(td, "num text-right")}>{filledCell(r.filledPct)}</td>
                    <td className={cn(td, "whitespace-nowrap text-mutedfg")}>
                      {r.tx ? (
                        <>
                          <span className="num">{fmtTime(r.tx.createdAt)}</span> <ExplorerLink kind="tx" id={r.tx.hash} network={network} />
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={cn(td, "text-right")}>{locked ? null : cancelBtn([r.d], r.d.offer.id, "offer-cancel", "Cancel")}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {cancellable.length} offers?</DialogTitle>
            <DialogDescription>
              This cancels every cancellable offer listed {scope === "market" && market ? `on ${market.label}` : "across all markets"}, including offers you did not place from this page. Ranges quoted in a Lotus receipt stay locked until filled. Cancelling frees the balance they lock; filled amounts are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAll(false)}>
              Keep offers
            </Button>
            <Button
              variant="destructive"
              data-testid="offers-cancel-all-confirm"
              onClick={() => {
                setConfirmAll(false);
                cancel(cancellable, "all");
              }}
            >
              Cancel {cancellable.length} offers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (bare) {
    return (
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3 px-3 py-1.5">
          <span className="hidden text-[11px] text-mutedfg sm:inline">Resting orders on the SDEX (a range order = one row). Cancelling frees the balance they lock.</span>
          {toolbar}
        </div>
        {body}
      </div>
    );
  }
  return (
    <Panel title="Open orders" subtitle="Your resting orders on the SDEX; a range order placed in one transaction is one row." right={toolbar}>
      {body}
    </Panel>
  );
}
