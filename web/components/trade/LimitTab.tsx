"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { divRound, SCALE, tryStroops, fromStroops } from "@/lib/amount";
import { bestPrices, midPrice } from "@/lib/book";
import { useTx } from "@/lib/hooks";
import type { Market } from "@/lib/markets";
import { fmt, manageSellOfferOp, priceArg, submitClassic, type OrderBook } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { AssetField, Segmented, Spinner, TxStatus } from "@/components/common";
import { TrustlineNotice, useAssetAccess } from "./access";

export type PricePick = { price: string; nonce: number } | null;

/** One manageSellOffer: sell the base (ask) or buy the base by selling the quote (bid). */
export function LimitTab({ market, book, pick, onDone }: { market: Market; book: OrderBook | null; pick: PricePick; onDone: () => void }) {
  const { network } = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Limit order");

  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  // adopt a price clicked in the order book (adjust state while rendering, no effect needed)
  const [seen, setSeen] = useState<number | null>(null);
  if (pick && pick.nonce !== seen) {
    setSeen(pick.nonce);
    setPrice(pick.price);
  }

  const baseAccess = useAssetAccess(market.base);
  const quoteAccess = useAssetAccess(market.quote);
  const { bid, ask } = bestPrices(book);
  const mid = midPrice(book);

  const p = tryStroops(price);
  const a = tryStroops(amount);
  const valid = p !== null && p > 0n && a !== null && a > 0n;
  const quoteTotal = valid ? divRound(a * p, SCALE) : null;

  const sellAsset = side === "sell" ? market.base : market.quote;
  const sellAccess = side === "sell" ? baseAccess : quoteAccess;
  const sellAmount = side === "sell" ? a : quoteTotal;
  const insufficient = valid && sellAccess.available !== null && sellAmount !== null && Number(fromStroops(sellAmount)) > sellAccess.available + 1e-9;
  const crosses = valid && Number(price) > 0 && (side === "sell" ? bid !== null && Number(price) <= bid : ask !== null && Number(price) >= ask);

  const blockedBy = !wallet.address
    ? "Connect a wallet"
    : baseAccess.state === "no-trustline" || baseAccess.state === "unauthorized"
      ? `${market.base.code} trustline needed`
      : quoteAccess.state === "no-trustline" || quoteAccess.state === "unauthorized"
        ? `${market.quote.code} trustline needed`
        : !valid
          ? "Enter price and amount"
          : insufficient
            ? `Insufficient ${sellAsset.code}`
            : null;

  const submit = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (!valid || a === null || p === null || quoteTotal === null) throw new Error("Enter price and amount");
      const op =
        side === "sell"
          ? manageSellOfferOp({ selling: market.base, buying: market.quote, amount: fromStroops(a), price: priceArg(price) })
          : manageSellOfferOp({ selling: market.quote, buying: market.base, amount: fromStroops(quoteTotal), price: priceArg(price, true) });
      const r = await submitClassic(net, { source: wallet.address, ops: [op], sign: wallet.sign, onStage });
      acct.refresh();
      onDone();
      setAmount("");
      return { ...r, note: `${side === "sell" ? "Ask" : "Bid"} ${fmt(fromStroops(a), 2)} ${market.base.code} @ ${fmt(price, 4, 4)}` };
    });

  const quick = useMemo(
    () => [
      { label: "Best bid", v: bid },
      { label: "Mid", v: mid },
      { label: "Best ask", v: ask },
    ],
    [bid, mid, ask],
  );

  return (
    <div className="space-y-1.5" data-testid="limit-tab">
      <Segmented
        value={side}
        onChange={setSide}
        testId="limit-side"
        options={[
          { value: "buy", label: `Buy ${market.base.code}` },
          { value: "sell", label: `Sell ${market.base.code}` },
        ]}
      />
      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="flex items-center justify-between text-sm text-mutedfg">
          <span>
            Price ({market.quote.code} per {market.base.code})
          </span>
          <span className="flex gap-1">
            {quick.map((q) => (
              <button
                key={q.label}
                disabled={q.v === null}
                onClick={() => q.v !== null && setPrice(String(Number(q.v.toFixed(7))))}
                className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] font-medium text-mutedfg transition hover:text-white disabled:opacity-40"
              >
                {q.label}
              </button>
            ))}
          </span>
        </div>
        <input
          data-testid="limit-price"
          inputMode="decimal"
          value={price}
          placeholder={mid !== null ? String(Number(mid.toFixed(4))) : "0.0000"}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
          className="mt-1 w-full min-w-0 bg-transparent text-3xl font-medium tabular-nums outline-none placeholder:text-mutedfg/50 sm:text-4xl"
        />
      </div>
      <AssetField
        label={`Amount (${market.base.code})`}
        testId="limit-amount"
        value={amount}
        onChange={setAmount}
        asset={market.base}
        balance={sellAccess.available !== null && side === "sell" ? fmt(sellAccess.available, 2) : undefined}
        hint={quoteTotal !== null ? `= ${fmt(fromStroops(quoteTotal), 4)} ${market.quote.code}` : undefined}
      />
      {side === "buy" ? (
        <p className="px-1 text-[11px] text-mutedfg">
          A bid sells {market.quote.code} for {market.base.code}. Free {market.quote.code}: <span className="num">{quoteAccess.available !== null ? fmt(quoteAccess.available, 2) : "-"}</span>
          {market.quote.code === market.receipt.code ? ". The receipt in your bid keeps earning while it waits." : "."}
        </p>
      ) : null}
      {crosses ? (
        <p className="rounded-xl border border-primary/40 bg-primary/5 px-3 py-2 text-[11px] text-primary" data-testid="limit-crosses">
          This price crosses the book: the order fills immediately against the best {side === "sell" ? "bid" : "ask"} (you are the taker) and only the rest rests.
        </p>
      ) : null}
      <TrustlineNotice asset={market.base} access={baseAccess} verb={side === "buy" ? "receive" : "sell"} showOk />
      <Button className="mt-2 h-12 w-full text-base" onClick={submit} disabled={tx.running || blockedBy !== null} data-testid="limit-submit">
        {tx.running ? <Spinner className="size-5" /> : blockedBy ?? (side === "sell" ? `Place ask` : `Place bid`)}
      </Button>
      <p className="text-[11px] leading-relaxed text-mutedfg">
        One manageSellOffer. The offer only sets a selling liability: the {sellAsset.code} stays in your account until a taker fills it.
      </p>
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
    </div>
  );
}
