"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { useTx, type Polled } from "@/lib/hooks";
import type { Market } from "@/lib/markets";
import {
  assetKey,
  cancelOfferOp,
  fmt,
  submitClassicChunked,
  toAssetRef,
  type AssetRef,
  type HorizonOffer,
} from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { AssetLink, Empty, ExplorerLink, Panel, Segmented, Spinner, TxStatus } from "@/components/common";

type Described = {
  offer: HorizonOffer;
  market: Market | null;
  side: "Ask" | "Bid" | "Offer";
  /** quote per base when the offer belongs to a known market */
  price: number;
  /** base size */
  size: number;
  /** quote total */
  total: number;
  sellCode: string;
  buyCode: string;
};

export function describeOffer(o: HorizonOffer, markets: Market[]): Described {
  const selling = toAssetRef(o.selling);
  const buying = toAssetRef(o.buying);
  const amount = Number(o.amount);
  const p = Number(o.price);
  for (const m of markets) {
    if (assetKey(selling) === assetKey(m.base) && assetKey(buying) === assetKey(m.quote))
      return { offer: o, market: m, side: "Ask", price: p, size: amount, total: amount * p, sellCode: selling.code, buyCode: buying.code };
    if (assetKey(selling) === assetKey(m.quote) && assetKey(buying) === assetKey(m.base))
      return { offer: o, market: m, side: "Bid", price: p > 0 ? 1 / p : 0, size: amount * p, total: amount, sellCode: selling.code, buyCode: buying.code };
  }
  return { offer: o, market: null, side: "Offer", price: p, size: amount, total: amount * p, sellCode: selling.code, buyCode: buying.code };
}

/** Open offers of the connected account, with Cancel (manageSellOffer amount 0 + offer id) and explorer links. */
export function OpenOffers({
  markets,
  market,
  offers,
  onChanged,
}: {
  markets: Market[];
  market: Market | null;
  /** polled by the page so every action can refresh it */
  offers: Polled<HorizonOffer[]>;
  onChanged: () => void;
}) {
  const { network } = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Cancel");
  const [scope, setScope] = useState<"market" | "all">("market");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const described = useMemo(() => (offers.data ?? []).map((o) => describeOffer(o, markets)), [offers.data, markets]);
  const shown = scope === "all" || !market ? described : described.filter((d) => d.market?.id === market.id);

  const cancel = (ds: Described[]) =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      setBusyId(ds.length === 1 ? ds[0].offer.id : "all");
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
        return { hash: r.hashes[0], hashes: r.hashes, note: ds.length === 1 ? `offer #${ds[0].offer.id} cancelled` : `${ds.length} offers cancelled` };
      } finally {
        setBusyId(null);
      }
    });

  return (
    <Panel
      title="Open offers"
      subtitle="Your resting orders on the SDEX. Cancelling frees the balance they lock."
      right={
        <div className="flex items-center gap-2">
          <Segmented value={scope} onChange={setScope} size="sm" className="w-44" options={[{ value: "market", label: market?.label ?? "Market" }, { value: "all", label: "All" }]} />
          {shown.length > 1 ? (
            <Button size="xs" variant="outline" disabled={tx.running} onClick={() => setConfirmAll(true)} data-testid="offers-cancel-all">
              Cancel {shown.length}
            </Button>
          ) : null}
        </div>
      }
    >
      {!wallet.address ? (
        <Empty>Connect a wallet to see your open offers.</Empty>
      ) : offers.error ? (
        <Empty>
          <span className="text-destructive">{offers.error}</span>
        </Empty>
      ) : !offers.data ? (
        <Empty>Loading...</Empty>
      ) : shown.length === 0 ? (
        <Empty>No open offers{scope === "market" && market ? ` on ${market.label}` : ""}.</Empty>
      ) : (
        <div className="overflow-x-auto scroll-thin" data-testid="open-offers">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="label text-left">
                <th className="py-1 pr-2 font-normal">Offer</th>
                <th className="py-1 pr-2 font-normal">Market</th>
                <th className="py-1 pr-2 font-normal">Side</th>
                <th className="py-1 pr-2 text-right font-normal">Price</th>
                <th className="py-1 pr-2 text-right font-normal">Size</th>
                <th className="py-1 pr-2 text-right font-normal">Total</th>
                <th className="py-1 text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.offer.id} className="border-t border-border" data-testid="offer-row" data-offer-id={d.offer.id}>
                  <td className="py-1.5 pr-2">
                    <ExplorerLink kind="offer" id={d.offer.id} network={network} />
                  </td>
                  <td className="py-1.5 pr-2">
                    {d.market ? d.market.label : <AssetLink asset={toAssetRef(d.offer.selling)} network={network} label={`${d.sellCode} > ${d.buyCode}`} />}
                  </td>
                  <td className={cn("py-1.5 pr-2 font-medium", d.side === "Ask" ? "text-red" : d.side === "Bid" ? "text-green" : "text-mutedfg")}>{d.side}</td>
                  <td className="num py-1.5 pr-2 text-right">{fmt(d.price, 4, 4)}</td>
                  <td className="num py-1.5 pr-2 text-right">
                    {fmt(d.size, 2)} {d.market ? d.market.base.code : d.sellCode}
                  </td>
                  <td className="num py-1.5 pr-2 text-right text-mutedfg">
                    {fmt(d.total, 2)} {d.market ? d.market.quote.code : d.buyCode}
                  </td>
                  <td className="py-1.5 text-right">
                    <Button size="xs" variant="outline" disabled={tx.running} onClick={() => cancel([d])} data-testid="offer-cancel">
                      {busyId === d.offer.id ? <Spinner /> : null}
                      Cancel
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {shown.length} offers?</DialogTitle>
            <DialogDescription>
              This cancels every offer listed {scope === "market" && market ? `on ${market.label}` : "across all markets"} in one transaction, including offers you did not place from this page. Cancelling frees the balance they lock; filled amounts are not affected.
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
                cancel(shown);
              }}
            >
              Cancel {shown.length} offers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
