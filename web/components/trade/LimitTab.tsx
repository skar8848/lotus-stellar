"use client";

import { useMemo, useState } from "react";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { divRound, SCALE, tryStroops, fromStroops } from "@/lib/amount";
import { bestPrices, midPrice } from "@/lib/book";
import { useTx } from "@/lib/hooks";
import type { Market } from "@/lib/markets";
import { fmt, manageSellOfferOp, priceArg, submitClassic, type OrderBook } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { Spinner, TxStatus } from "@/components/common";
import { TrustlineNotice, useAssetAccess } from "./access";
import { ActionButton, ExField, PctSlider, SideToggle, SummaryBox, SumRow, SumSep, Warn, type Side } from "./form";

export type PricePick = { price: string; nonce: number } | null;

const floorStroops = (n: number): bigint => (Number.isFinite(n) && n > 0 ? BigInt(Math.floor(n * 1e7)) : 0n);

/** One manageSellOffer: sell the base (ask) or buy the base by selling the quote (bid). Signed in the wallet. */
export function LimitTab({ market, book, pick, onDone }: { market: Market; book: OrderBook | null; pick: PricePick; onDone: () => void }) {
  const { network } = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Limit order");

  const [side, setSide] = useState<Side>("buy");
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

  // max base size: the free base (ask) or the free quote at this price (bid), in stroops
  const maxBase: bigint | null = (() => {
    if (sellAccess.available === null) return null;
    if (side === "sell") return floorStroops(sellAccess.available);
    if (p === null || p <= 0n) return null;
    return (floorStroops(sellAccess.available) * SCALE) / p;
  })();
  const pct = maxBase && maxBase > 0n && a !== null ? Number((a * 10000n) / maxBase) / 100 : 0;
  const setPct = (v: number) => {
    if (!maxBase || maxBase <= 0n) return;
    const s = (maxBase * BigInt(Math.round(v * 100))) / 10000n;
    setAmount(s > 0n ? fromStroops(s) : "");
  };

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
      { label: "Bid", v: bid },
      { label: "Mid", v: mid },
      { label: "Ask", v: ask },
    ],
    [bid, mid, ask],
  );

  const receiptQuoted = market.quote.code === market.receipt.code && market.kind !== "cash";

  return (
    <div className="space-y-2.5" data-testid="limit-tab">
      <SideToggle value={side} onChange={setSide} testId="limit-side" buyLabel={`Buy ${market.base.code}`} sellLabel={`Sell ${market.base.code}`} />

      <ExField
        label={`Price (${market.quote.code} per ${market.base.code})`}
        testId="limit-price"
        value={price}
        onChange={setPrice}
        placeholder={mid !== null ? String(Number(mid.toFixed(4))) : "0.0000"}
        unit={market.quote.code}
        right={
          <span className="flex gap-1">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                disabled={q.v === null}
                onClick={() => q.v !== null && setPrice(String(Number(q.v.toFixed(7))))}
                className="rounded bg-secondary px-1.5 py-px text-[10px] font-medium text-mutedfg transition hover:text-foreground disabled:opacity-40"
              >
                {q.label}
              </button>
            ))}
          </span>
        }
      />

      <div>
        <ExField
          label={`Size (${market.base.code})`}
          testId="limit-amount"
          value={amount}
          onChange={setAmount}
          placeholder="0"
          unit={market.base.code}
          right={
            maxBase !== null && maxBase > 0n ? (
              <span className="text-[10px]">
                Max: <span className="num text-foreground">{fmt(fromStroops(maxBase), 2)}</span>
              </span>
            ) : null
          }
        />
        <PctSlider pct={pct} onPct={setPct} disabled={!wallet.address || !maxBase || maxBase <= 0n} />
      </div>

      <SummaryBox testId="limit-summary">
        {wallet.address ? (
          <SumRow k="Available" v={sellAccess.available !== null ? `${fmt(sellAccess.available, 2)} ${sellAsset.code}` : "-"} />
        ) : null}
        <SumRow k="Order value" v={quoteTotal !== null ? `${fmt(fromStroops(quoteTotal), 4)} ${market.quote.code}` : "--"} />
        <SumRow k={side === "sell" ? "You sell" : "You pay"} v={sellAmount !== null && valid ? `${fmt(fromStroops(sellAmount), 4)} ${sellAsset.code}` : "--"} />
        <SumSep />
        <SumRow k="Operation" v="manageSellOffer" />
        <SumRow k="Reserve" v="0.5 XLM per offer" title="Each open offer is an account subentry and locks 0.5 XLM of base reserve until it is filled or cancelled" />
        <SumRow k="Network fee" v="0.0001 XLM" />
        {receiptQuoted ? (
          <SumRow
            k="Yield"
            className="text-primary"
            v={side === "buy" ? `${market.quote.code} keeps earning` : `proceeds earn in ${market.quote.code}`}
            title={`${market.quote.code} is the Lotus receipt: an offer only sets a selling liability, so the receipt stays in your account and keeps earning`}
          />
        ) : null}
      </SummaryBox>

      {crosses ? (
        <div data-testid="limit-crosses">
          <Warn>
            This price crosses the book: it fills at once against the best {side === "sell" ? "bid" : "ask"} (you are the taker) and only the rest rests.
          </Warn>
        </div>
      ) : null}

      <TrustlineNotice asset={market.base} access={baseAccess} verb={side === "buy" ? "receive" : "sell"} showOk />
      {quoteAccess.state === "no-trustline" || quoteAccess.state === "unauthorized" ? <TrustlineNotice asset={market.quote} access={quoteAccess} verb={side === "buy" ? "pay with" : "receive"} /> : null}

      <ActionButton side={side} onClick={submit} disabled={tx.running || blockedBy !== null} blocked={blockedBy !== null && !tx.running} testId="limit-submit">
        {tx.running ? <Spinner className="size-4" /> : blockedBy ?? `${side === "buy" ? "Buy" : "Sell"} ${market.base.code}`}
      </ActionButton>
      <p className="text-[10px] leading-relaxed text-mutedfg">
        One offer, one wallet signature. The offer only sets a selling liability: the {sellAsset.code} stays in your account until a taker fills it.
      </p>
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
    </div>
  );
}
