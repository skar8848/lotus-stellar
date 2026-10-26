"use client";

// Review modal of the New position flow (lotus-main Dialog style): the one-line summary of lib/orderRoute.ts,
// the details, then sign. Execution is lib/orderTx.ts placeOrder / repostOffers, unchanged.

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ExplorerLink, Spinner, TxStatus } from "@/components/common";
import { TrustlineNotice } from "@/components/trade/access";
import { useAccount } from "@/lib/account";
import { fromStroops } from "@/lib/amount";
import { useNet } from "@/lib/config-context";
import { errMsg, useTx } from "@/lib/hooks";
import { getPoolClient } from "@/lib/pool";
import type { PositionPlan, Side } from "@/lib/poolGrid";
import { PairError, placeOrder, repostOffers } from "@/lib/orderTx";
import { fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { PairGlyph } from "./bits";
import { crossText, type Destination, type OrderEnv } from "./useOrder";

type Pending = { side: Side; offers: OrderEnv["ladder"]["offers"]; firstHash: string | null; amount: bigint };

const TITLE: Record<Destination["id"], string> = {
  pool: "Lotus pool",
  "pool-yield": "Lotus pool + Blend yield",
  sdex: "Stellar DEX",
  "sdex-yield": "Stellar DEX + Blend yield",
};

export function ReviewDialog({
  open,
  onOpenChange,
  dest,
  env,
  plan,
  side,
  aprText,
  onDone,
  onSuccessClose,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dest: Destination;
  env: OrderEnv;
  plan: PositionPlan;
  side: Side;
  aprText: string | null;
  onDone: () => void;
  onSuccessClose: () => void;
}) {
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("New position");
  const retryTx = useTx("Post offers");
  const [pending, setPending] = useState<Pending | null>(null);
  const { base, quote, receipt, ladder, config } = env;
  const network = config.network;
  const sq = dest.sdexQuote;
  const lo = plan.bins[0];
  const hi = plan.bins[plan.bins.length - 1];
  const sold = side === "Ask" ? base : quote;
  const done = tx.state.stage === "success";

  const submit = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      setPending(null);
      const ctx = { source: wallet.address, sign: wallet.sign, onStage };
      try {
        const r = await placeOrder(net, ctx, {
          side,
          venue: dest.venue,
          yieldOn: dest.yieldOn,
          plan,
          offers: ladder.offers,
          base,
          quote,
          receipt,
          lotusVault: config.lotusVault,
          pool: dest.venue === "pool" && dest.inst ? getPoolClient(net, dest.inst) : null,
          addTrust: dest.needsReceiptTrustline ? [receipt, ...dest.addTrust] : dest.addTrust,
        });
        return { hash: r.hashes[r.hashes.length - 1] ?? "", hashes: r.hashes, result: r.result, note: `${TITLE[dest.id]}: ${r.note}` };
      } catch (e) {
        if (e instanceof PairError && e.phase === "second") {
          setPending({ side, offers: ladder.offers, firstHash: e.firstHash, amount: plan.deposit });
          throw new Error(
            `The deposit went through but the offers did not (${e.message}). You hold ${fromStroops(plan.deposit)} ${receipt.code}, redeemable at par in Portfolio; you can post the offers again below.`,
          );
        }
        throw e instanceof Error ? e : new Error(errMsg(e));
      } finally {
        acct.refresh();
        onDone();
      }
    });

  const repost = () =>
    retryTx.run(async (onStage) => {
      if (!wallet.address || !pending) throw new Error("Nothing to post");
      const r = await repostOffers(net, { source: wallet.address, sign: wallet.sign, onStage }, { side: pending.side, offers: pending.offers, base, receipt });
      setPending(null);
      tx.reset();
      acct.refresh();
      onDone();
      return { hash: r.hashes[0], hashes: r.hashes, note: r.note };
    });

  const close = (v: boolean) => {
    onOpenChange(v);
    if (!v) {
      if (done) onSuccessClose();
      tx.reset();
      retryTx.reset();
    }
  };

  const busy = tx.running || retryTx.running;

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? undefined : close(v))}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl" data-testid="review-dialog" data-strategy={dest.id}>
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center justify-between gap-2 pr-8">
            <span className="flex items-center gap-2.5">
              <PairGlyph base={base.code} quote={quote.code} size={24} />
              Review position
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                dest.yieldOn ? "border-green/40 bg-green/5 text-green" : "border-line text-mutedfg",
              )}
              data-testid="order-yield-badge"
              title={dest.yieldOn ? "observed on testnet, not a forecast" : undefined}
            >
              {dest.yieldOn ? `${dest.yieldName}${aprText ? ` · ${aprText}` : ""}` : "No yield"}
            </span>
          </DialogTitle>
          <DialogDescription className="inline-flex flex-wrap items-center gap-1.5">
            {side === "Ask" ? `Sell ${base.code}` : `Buy ${base.code} with ${quote.code}`} · {TITLE[dest.id]}
            {dest.venue === "pool" && dest.inst ? (
              <>
                {" "}
                · {dest.inst.label} <ExplorerLink kind="contract" id={dest.inst.contract} network={network} />
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {dest.summary ? (
          <p className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-xs leading-relaxed text-foreground" data-testid="order-summary-line">
            {dest.summary}
          </p>
        ) : null}

        <div className="rounded-xl border border-line px-3 py-2.5 text-xs" data-testid="order-details">
          <Row k="Deposit" v={plan.ok ? `${fmt(fromStroops(plan.deposit), 7)} ${sold.code}` : "-"} />
          <Row k="Price range" v={plan.ok && lo && hi ? `${fmt(Number(lo.price) / 1e7, 4, 4)} to ${fmt(Number(hi.price) / 1e7, 4, 4)} ${dest.venue === "sdex" ? sq.code : quote.code}` : "-"} />
          <Row k="Average price" v={plan.ok && plan.avgPrice !== null ? fmt(Number(plan.avgPrice) / 1e7, 4, 4) : "-"} />
          {dest.venue === "pool" && dest.inst ? <Row k="Pool fee" v={`${fmt(dest.inst.feeBps / 100, 2)}% of the ${quote.code} leg of each fill`} /> : null}
          {dest.venue === "sdex" ? <Row k="XLM base reserve" v={`${fmt(dest.reserveXlm, 1)} XLM (0.5 per offer or trustline)`} /> : null}
          {dest.addTrust.length > 0 || dest.needsReceiptTrustline ? (
            <Row k="Adds trustline" v={[...(dest.needsReceiptTrustline ? [receipt] : []), ...dest.addTrust].map((a) => a.code).join(", ")} />
          ) : null}
        </div>

        {dest.signatures > 1 && plan.ok ? (
          <p className="px-1 text-[11px] leading-relaxed text-primary" data-testid="order-two-signatures">
            Your wallet will ask for {dest.signatures} signatures, one after the other
            {dest.needsReceiptTrustline ? ` (${receipt.code} trustline, then the deposit, then the offers)` : " (the deposit, then the offers)"}. A Soroban call cannot share a transaction
            with offers: nothing is sent before you have signed both, and the offers are dropped if the deposit fails.
          </p>
        ) : null}
        {dest.crossing > 0 ? (
          <p className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2 text-[11px] text-primary" data-testid="order-crosses">
            {crossText(dest, side, base.code, quote.code, receipt.code, plan.ok ? plan.bins.length : 0)}
          </p>
        ) : null}

        <TrustlineNotice asset={base} access={env.access.base} verb={side === "Ask" ? "sell" : "receive"} />
        {dest.venue === "pool" || side === "Bid" ? <TrustlineNotice asset={quote} access={env.access.quote} verb="hold" /> : null}

        {done ? (
          <Button className="h-12 w-full text-base" variant="secondary" onClick={() => close(false)} data-testid="review-done">
            Done · see it in Your positions
          </Button>
        ) : (
          <Button className="h-12 w-full text-base" onClick={submit} disabled={busy || dest.blockedBy !== null} data-testid="review-sign">
            {tx.running ? <Spinner className="size-5" /> : (dest.blockedBy ?? (dest.signatures > 1 ? `Sign ${dest.signatures} transactions` : "Create position · 1 signature"))}
          </Button>
        )}
        <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />

        {pending ? (
          <div className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5 text-xs" data-testid="order-pending">
            <p className="text-foreground">
              You hold {fromStroops(pending.amount)} {receipt.code}
              {pending.firstHash ? (
                <>
                  {" "}
                  (deposit <ExplorerLink kind="tx" id={pending.firstHash} network={network} />)
                </>
              ) : null}
              . It is redeemable at par in{" "}
              <Link href="/portfolio#receipts" className="underline underline-offset-2 hover:text-primary">
                Portfolio
              </Link>
              , or you can post the {pending.offers.length} offers again (one signature).
            </p>
            <Button size="sm" className="mt-2" onClick={repost} disabled={retryTx.running} data-testid="order-repost">
              {retryTx.running ? <Spinner /> : null}
              Post the offers again
            </Button>
            <TxStatus state={retryTx.state} network={network} onDismiss={retryTx.reset} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Row({ k, v, testId }: { k: string; v: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="shrink-0 text-mutedfg">{k}</span>
      <span className="num text-right" data-testid={testId}>
        {v}
      </span>
    </div>
  );
}
