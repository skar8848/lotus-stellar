"use client";

// Bottom panel of the exchange layout: Open orders (with Cancel) | Trade history (the account's fills) | Balances.
// On desktop its height is resizable with the drag handle on top.

import { useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useAccount } from "@/lib/account";
import { useConfig } from "@/lib/config-context";
import type { Fill } from "@/lib/book";
import type { Polled } from "@/lib/hooks";
import type { Market } from "@/lib/markets";
import { assetKey, fetchOperationTxHash, fmt, toAssetRef, type AssetRef, type HorizonOffer } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { AssetLink, Empty, ExplorerLink, TokenIcon } from "@/components/common";
import { OpenOffers, useOrderRows } from "./OpenOffers";

type BottomTab = "orders" | "history" | "balances";

const MIN_H = 110;
const DEFAULT_H = 230;

export function BottomPanel({
  markets,
  market,
  offers,
  fills,
  fillsError,
  onChanged,
  resizable,
  maxHeight,
}: {
  markets: Market[];
  market: Market;
  offers: Polled<HorizonOffer[]>;
  /** the account's trades grouped per operation (null while loading or with no wallet) */
  fills: Fill[] | null;
  fillsError: string | null;
  onChanged: () => void;
  /** desktop: fixed, resizable height; mobile: natural height */
  resizable: boolean;
  maxHeight: number;
}) {
  const { network } = useConfig();
  const wallet = useWallet();
  const [tab, setTab] = useState<BottomTab>("orders");
  const [height, setHeight] = useState(DEFAULT_H);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const h = Math.max(MIN_H, Math.min(height, maxHeight));

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      setHeight(Math.max(MIN_H, Math.min(maxHeight, drag.current.h + drag.current.y - e.clientY)));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [maxHeight]);

  // one range order (a ladder posted in one transaction) counts as one order
  const { rows: orderRows } = useOrderRows(markets, offers.data, wallet.address);
  const nOrders = orderRows.length;
  const tabs: { id: BottomTab; label: string }[] = [
    { id: "orders", label: wallet.address && nOrders > 0 ? `Open orders (${nOrders})` : "Open orders" },
    { id: "history", label: "Trade history" },
    { id: "balances", label: "Balances" },
  ];

  return (
    <section className="flex shrink-0 flex-col border-t border-border bg-card" style={resizable ? { height: h } : undefined} data-testid="bottom-panel">
      {resizable ? (
        <div
          onPointerDown={(e) => {
            drag.current = { y: e.clientY, h };
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
          }}
          className="flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center bg-white/[0.02] transition-colors hover:bg-primary/30"
          title="Drag to resize"
          aria-hidden
        >
          <div className="h-0.5 w-8 rounded-full bg-mutedfg/30" />
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border pl-1 pr-3">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto scroll-thin" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              data-testid={`bottom-tab-${t.id}`}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2 text-xs font-medium transition-colors sm:px-4",
                tab === t.id ? "border-primary text-foreground" : "border-transparent text-mutedfg hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {wallet.address ? (
          <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-mutedfg sm:flex">
            Account <ExplorerLink kind="account" id={wallet.address} network={network} className="text-[11px]" />
          </span>
        ) : null}
      </div>
      <div className={cn("min-h-0 flex-1 scroll-thin", resizable ? "overflow-auto" : "")}>
        {tab === "orders" ? <OpenOffers markets={markets} market={market} offers={offers} onChanged={onChanged} bare /> : null}
        {tab === "history" ? <TradeHistory fills={fills} error={fillsError} /> : null}
        {tab === "balances" ? <Balances offers={offers.data} /> : null}
      </div>
    </section>
  );
}

const thCls = "px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-mutedfg";
const trCls = "border-b border-border/50 transition-colors hover:bg-white/[0.03]";

// ---------------------------------------------------------------------------

function TradeHistory({ fills, error }: { fills: Fill[] | null; error: string | null }) {
  const { horizon, network } = useConfig();
  const wallet = useWallet();
  const me = wallet.address;
  const [hashes, setHashes] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const ids = [...new Set((fills ?? []).map((f) => f.opId).filter((id) => id && !hashes[id]))].slice(0, 25);
    if (ids.length === 0) return;
    Promise.all(ids.map((id) => fetchOperationTxHash(horizon, id).then((h) => [id, h] as const))).then((pairs) => {
      if (!alive) return;
      setHashes((cur) => {
        const next = { ...cur };
        for (const [id, h] of pairs) if (h) next[id] = h;
        return next;
      });
    });
    return () => {
      alive = false;
    };
    // hashes is only ever extended
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fills, horizon]);

  if (!me) return <Empty>Connect a wallet to see your trade history.</Empty>;
  if (error && !fills) return <Empty><span className="text-destructive">{error}</span></Empty>;
  if (!fills) return <Empty>Loading...</Empty>;
  if (fills.length === 0)
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <p className="text-sm text-mutedfg">No trades yet</p>
        <p className="mt-1 text-xs text-mutedfg/60">Your fills (swaps and filled offers) will appear here</p>
      </div>
    );

  return (
    <div className="overflow-x-auto scroll-thin" data-testid="trade-history">
      <table className="w-full min-w-[760px] text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className={thCls}>Time</th>
            <th className={thCls}>Market</th>
            <th className={thCls}>Side</th>
            <th className={cn(thCls, "text-right")} title="Average price of the operation, quote per base">Avg price</th>
            <th className={cn(thCls, "text-right")}>Paid</th>
            <th className={cn(thCls, "text-right")}>Received</th>
            <th className={thCls}>Route</th>
            <th className={cn(thCls, "text-right")}>Tx</th>
          </tr>
        </thead>
        <tbody>
          {fills.map((f) => (
            <tr key={f.key} className={trCls} data-testid="history-row" data-op={f.opId} data-side={f.side} data-market={f.marketLabel} data-routed={f.routed ? "1" : "0"}>
              <td className="num px-3 py-1.5 text-mutedfg">{new Date(f.time).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</td>
              <td className="px-3 py-1.5">{f.marketLabel}</td>
              <td className={cn("px-3 py-1.5 font-medium", f.side === "Buy" ? "text-green" : "text-red")}>
                {f.side} {f.base.code}
              </td>
              <td className="num px-3 py-1.5 text-right">
                {fmt(f.price, 4, 4)} <span className="text-mutedfg">{f.quote.code}</span>
              </td>
              <td className="num px-3 py-1.5 text-right text-mutedfg">
                {fmt(f.paid.amount, 4)} {f.paid.asset.code}
              </td>
              <td className="num px-3 py-1.5 text-right">
                {fmt(f.received.amount, 4)} {f.received.asset.code}
              </td>
              <td className="px-3 py-1.5 text-mutedfg" title={f.routed ? `One path payment, ${f.tradeIds.length} offers crossed` : f.tradeIds.length > 1 ? `${f.tradeIds.length} offers crossed` : undefined}>
                {f.routed ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="rounded bg-primary/10 px-1 py-px text-[10px] font-medium text-primary">routed</span>
                    {f.route.map((a) => a.code).join(" → ")}
                  </span>
                ) : (
                  "direct"
                )}
              </td>
              <td className="px-3 py-1.5 text-right">{hashes[f.opId] ? <ExplorerLink kind="tx" id={hashes[f.opId]} network={network} /> : <span className="text-mutedfg">...</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Balances({ offers }: { offers: HorizonOffer[] | null }) {
  const { network } = useConfig();
  const wallet = useWallet();
  const acct = useAccount();
  if (!wallet.address) return <Empty>Connect a wallet to see your balances.</Empty>;
  if (!acct.data) return <Empty>{acct.error ? <span className="text-destructive">{acct.error}</span> : "Loading..."}</Empty>;

  const offerCount = (a: AssetRef) => (offers ?? []).filter((o) => assetKey(toAssetRef(o.selling)) === assetKey(a)).length;
  const rows = acct.data.balances
    .filter((b) => b.asset_type !== "liquidity_pool_shares")
    .map((b) => {
      const asset = toAssetRef(b);
      const total = Number(b.balance);
      const inOffers = Number(b.selling_liabilities ?? 0);
      const reserve = asset.issuer ? 0 : (2 + acct.data!.subentry_count) * 0.5;
      return { b, asset, total, inOffers, reserve, available: Math.max(0, total - inOffers - reserve), n: offerCount(asset) };
    })
    // native last, like most exchanges list XLM as the fee asset
    .sort((x, y) => (x.asset.issuer ? 0 : 1) - (y.asset.issuer ? 0 : 1));

  return (
    <div className="overflow-x-auto scroll-thin" data-testid="balances">
      <table className="w-full min-w-[620px] text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className={thCls}>Asset</th>
            <th className={cn(thCls, "text-right")}>Total</th>
            <th className={cn(thCls, "text-right")}>In offers</th>
            <th className={cn(thCls, "text-right")}>Available</th>
            <th className={thCls}>Trustline</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={assetKey(r.asset)} className={trCls} data-testid="balance-row" data-asset={r.asset.code}>
              <td className="px-3 py-1.5">
                <span className="flex items-center gap-2">
                  <TokenIcon code={r.asset.code} size={16} />
                  <AssetLink asset={r.asset} network={network} />
                </span>
              </td>
              <td className="num px-3 py-1.5 text-right">{fmt(r.total, 4)}</td>
              <td className="num px-3 py-1.5 text-right text-mutedfg">
                {r.inOffers > 0 ? `${fmt(r.inOffers, 4)}${r.n > 0 ? ` (${r.n})` : ""}` : "-"}
              </td>
              <td className="num px-3 py-1.5 text-right">{fmt(r.available, 4)}</td>
              <td className="px-3 py-1.5">
                {!r.asset.issuer ? (
                  <span className="text-mutedfg" title="Base reserve: 0.5 XLM per subentry (trustlines, offers) plus 1 XLM">
                    native, {fmt(r.reserve, 1)} XLM reserved
                  </span>
                ) : r.b.is_authorized === false ? (
                  <span className="inline-flex items-center gap-1 text-destructive" title="The issuer has not authorized this trustline (AUTH_REQUIRED)">
                    <ShieldAlert className="size-3.5" /> not authorized by the issuer
                  </span>
                ) : (
                  <span className="text-mutedfg">authorized</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
