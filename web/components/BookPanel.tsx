"use client";

import { useCallback, useMemo, useState } from "react";
import type { LotusConfig } from "@/lib/config";
import { useAccount } from "@/lib/account";
import { useDebounced, usePolling, useTx } from "@/lib/hooks";
import {
  assetLabel,
  assetReady,
  buildLadder,
  changeTrustOp,
  fetchOrderBook,
  fetchStrictSendPaths,
  findBalance,
  fmt,
  ladderOps,
  normalizeAmount,
  pathPaymentStrictSendOp,
  priceArg,
  submitClassic,
  toStroops,
  type NetCfg,
  type OrderBook,
  type PathRecord,
} from "@/lib/stellar";
import type { xdr } from "@stellar/stellar-sdk";
import { useWallet } from "@/lib/wallet";
import { Depth } from "./Depth";
import { AmountInput, Dot, Empty, Panel, Spinner, TxStatus } from "./ui";

export function BookPanel({ config }: { config: LotusConfig }) {
  const ready = assetReady(config.rwa) && assetReady(config.receipt);
  const rwa = config.rwa.code;
  const rLabel = config.receipt.code;
  const fn = useCallback(() => fetchOrderBook(config.horizon, config.rwa, config.receipt, 12), [config.horizon, config.rwa, config.receipt]);
  const book = usePolling(fn, 5000, ready);
  const net: NetCfg = { rpc: config.rpc, horizon: config.horizon, passphrase: config.passphrase };

  return (
    <Panel
      id="book"
      title={
        <>
          Book <span className="text-muted-fg">·</span> {rwa}/{rLabel}
        </>
      }
      subtitle={`${rwa}: tokenized bond (AUTH_REQUIRED + CLAWBACK) quoted in the yield-bearing ${rLabel}.`}
      right={
        <span className="flex items-center gap-1.5 text-[11px] text-muted-fg">
          <Dot ok={book.error ? false : book.data ? true : null} pulse={book.loading} />
          {book.error ? "offline" : "live · 5s"}
        </span>
      }
      className="h-full"
    >
      {!ready ? (
        <Empty>Waiting for {rwa} and {rLabel} to be deployed.</Empty>
      ) : (
        <>
          <Depth book={book.data} baseCode={rwa} counterCode={rLabel} rows={10} priceDp={4} sizeDp={2} />
          {book.error ? <p className="mt-2 text-xs text-red">{book.error}</p> : null}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-fg">
            An SDEX offer only sets a <span className="text-foreground">selling liability</span>; the balance never leaves the account. {rLabel} received by
            makers, and {rLabel} resting in bids, keep earning vault yield the whole time they sit here.
          </p>

          <div className="hairline my-4" />

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="min-w-0">
              <Ladder config={config} net={net} book={book.data} onDone={book.refresh} />
            </div>
            <div className="min-w-0">
              <Taker config={config} net={net} onDone={book.refresh} />
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Maker: ladder of N offers in one transaction
// ---------------------------------------------------------------------------

function Ladder({ config, net, book, onDone }: { config: LotusConfig; net: NetCfg; book: OrderBook | null; onDone: () => void }) {
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx();
  const rwa = config.rwa.code;
  const rLabel = config.receipt.code;

  const [side, setSide] = useState<"sell" | "buy">("sell");
  const [n, setN] = useState("5");
  const [start, setStart] = useState("");
  const [step, setStep] = useState("0.25");
  const [size, setSize] = useState("10");

  const bestAsk = book?.asks[0]?.price;
  const bestBid = book?.bids[0]?.price;
  const placeholder = side === "sell" ? bestAsk ?? bestBid ?? "100" : bestBid ?? bestAsk ?? "100";

  const levels = useMemo(() => {
    const count = Math.max(1, Math.min(20, Number(n) || 0));
    const signedStep = side === "sell" ? step : String(-Number(step || 0));
    return buildLadder(start, signedStep, size, count);
  }, [n, start, step, size, side]);

  const totalBase = levels.reduce((a, l) => a + Number(l.amount), 0);
  const totalCounter = levels.reduce((a, l) => a + Number(l.amount) * Number(l.price), 0);

  const rwaBal = findBalance(acct.data, config.rwa);
  const rBal = findBalance(acct.data, config.receipt);
  const sellingBal = side === "sell" ? rwaBal : rBal;
  const buyingBal = side === "sell" ? rBal : rwaBal;
  const buyingAsset = side === "sell" ? config.receipt : config.rwa;
  const sellingLabel = side === "sell" ? rwa : rLabel;
  const buyingLabel = side === "sell" ? rLabel : rwa;

  const warnings: string[] = [];
  if (wallet.address && acct.data) {
    if (!sellingBal) warnings.push(`No ${sellingLabel} trustline on this account.`);
    else if (sellingBal.is_authorized === false) warnings.push(`${sellingLabel} trustline is not authorized by the issuer.`);
    else if (Number(sellingBal.balance) - Number(sellingBal.selling_liabilities ?? 0) < (side === "sell" ? totalBase : totalCounter))
      warnings.push(`Not enough free ${sellingLabel} (${fmt(Number(sellingBal.balance) - Number(sellingBal.selling_liabilities ?? 0), 2)}).`);
    if (!buyingBal) warnings.push(`No ${buyingLabel} trustline: one will be added in the same transaction${side === "buy" ? " (issuer must authorize it)" : ""}.`);
  }

  const place = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (levels.length === 0) throw new Error("Enter a start price, step and size");
      const ops: xdr.Operation[] = [];
      if (!buyingBal) ops.push(changeTrustOp(buyingAsset));
      if (side === "sell") {
        ops.push(...ladderOps(config.rwa, config.receipt, levels.map((l) => ({ price: priceArg(l.price), amount: l.amount }))));
      } else {
        // bid ladder: sell receipt for LBOND; amount in receipt, price = LBOND per receipt (exact inverse)
        ops.push(
          ...ladderOps(
            config.receipt,
            config.rwa,
            levels.map((l) => ({ price: priceArg(l.price, true), amount: (Number(l.amount) * Number(l.price)).toFixed(7) })),
          ),
        );
      }
      const r = await submitClassic(net, { source: wallet.address, ops, sign: wallet.sign, onStage });
      acct.refresh();
      onDone();
      return { ...r, note: `${levels.length} offers placed in one tx` };
    });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold">Ladder</h3>
        <div className="flex rounded-md border border-line p-0.5 text-[11px]">
          <button
            className={`rounded px-2 py-0.5 ${side === "sell" ? "bg-red/20 text-red" : "text-muted-fg hover:text-foreground"}`}
            onClick={() => setSide("sell")}
          >
            Sell {rwa}
          </button>
          <button
            className={`rounded px-2 py-0.5 ${side === "buy" ? "bg-green/20 text-green" : "text-muted-fg hover:text-foreground"}`}
            onClick={() => setSide("buy")}
          >
            Buy {rwa}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">Levels</span>
          <input className="field mt-1" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="block">
          <span className="label">Start price ({rLabel})</span>
          <input
            className="field mt-1"
            inputMode="decimal"
            placeholder={placeholder}
            value={start}
            onChange={(e) => setStart(e.target.value.replace(/[^0-9.]/g, ""))}
          />
        </label>
        <label className="block">
          <span className="label">Step ({side === "sell" ? "+" : "−"})</span>
          <input className="field mt-1" inputMode="decimal" value={step} onChange={(e) => setStep(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
        <label className="block">
          <span className="label">Size per level ({rwa})</span>
          <input className="field mt-1" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
      </div>

      {levels.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-md border border-line">
          <div className="label grid grid-cols-3 gap-2 border-b border-line bg-card-2 px-2 py-1">
            <span>Price</span>
            <span className="text-right">{rwa}</span>
            <span className="text-right">{rLabel}</span>
          </div>
          <ul className="max-h-32 overflow-y-auto">
            {levels.map((l, i) => (
              <li key={i} className="num grid grid-cols-3 gap-2 px-2 py-0.5 text-xs">
                <span className={side === "sell" ? "text-red" : "text-green"}>{fmt(l.price, 4, 4)}</span>
                <span className="text-right">{fmt(l.amount, 2)}</span>
                <span className="text-right text-muted-fg">{fmt(Number(l.amount) * Number(l.price), 2)}</span>
              </li>
            ))}
          </ul>
          <div className="num grid grid-cols-3 gap-2 border-t border-line px-2 py-1 text-xs">
            <span className="text-muted-fg">Total</span>
            <span className="text-right">{fmt(totalBase, 2)}</span>
            <span className="text-right">{fmt(totalCounter, 2)}</span>
          </div>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-muted-fg">
          {warnings.map((w) => (
            <li key={w}>· {w}</li>
          ))}
        </ul>
      ) : null}

      <button
        className={`btn mt-3 w-full ${side === "sell" ? "" : ""}`}
        onClick={wallet.address ? place : wallet.connect}
        disabled={tx.running || (!!wallet.address && levels.length === 0)}
      >
        {tx.running ? <Spinner /> : null}
        {wallet.address ? `Place ${levels.length} offer${levels.length === 1 ? "" : "s"} in one tx` : "Connect wallet"}
      </button>
      <p className="mt-2 text-[11px] text-muted-fg">
        {side === "sell"
          ? `Proceeds arrive as ${rLabel} and start earning immediately.`
          : `The ${rLabel} backing these bids stays in your account and keeps earning until filled.`}
      </p>
      <TxStatus state={tx.state} network={config.network} onDismiss={tx.reset} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Taker: buy LBOND with the underlying through the receipt, one path payment
// ---------------------------------------------------------------------------

function bestPath(records: PathRecord[], receiptCode: string): PathRecord | null {
  if (records.length === 0) return null;
  const viaReceipt = records.filter((r) => r.path.some((p) => p.asset_code === receiptCode));
  const pool = viaReceipt.length > 0 ? viaReceipt : records;
  return pool.reduce((a, b) => (Number(b.destination_amount) > Number(a.destination_amount) ? b : a));
}

function Taker({ config, net, onDone }: { config: LotusConfig; net: NetCfg; onDone: () => void }) {
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx();
  const tlTx = useTx();
  const uLabel = assetLabel(config.underlying);
  const rwa = config.rwa.code;
  const rLabel = config.receipt.code;

  const [amt, setAmt] = useState("");
  const [slippage, setSlippage] = useState("1");
  const debounced = useDebounced(amt, 400);
  const validAmt = useMemo(() => {
    try {
      return toStroops(debounced) > 0n ? normalizeAmount(debounced) : null;
    } catch {
      return null;
    }
  }, [debounced]);

  const quoteFn = useCallback(
    () => fetchStrictSendPaths(config.horizon, config.underlying, validAmt as string, config.rwa),
    [config.horizon, config.underlying, config.rwa, validAmt],
  );
  const quote = usePolling(quoteFn, 5000, !!validAmt);
  const best = quote.data ? bestPath(quote.data, rLabel) : null;
  const estOut = best ? Number(best.destination_amount) : null;
  const price = estOut && validAmt ? Number(validAmt) / estOut : null;
  const destMin = estOut !== null ? (estOut * (1 - (Number(slippage) || 0) / 100)).toFixed(7) : null;
  const pathLabel = best ? [uLabel, ...best.path.map((p) => (p.asset_type === "native" ? "XLM" : p.asset_code)), rwa].join(" → ") : null;

  const rwaBal = findBalance(acct.data, config.rwa);
  const uBal = findBalance(acct.data, config.underlying);
  const uAvail = uBal ? Math.max(0, Number(uBal.balance) - Number(uBal.selling_liabilities ?? 0) - (config.underlying.issuer ? 0 : 2)) : null;

  const addTrustline = () =>
    tlTx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      const r = await submitClassic(net, { source: wallet.address, ops: [changeTrustOp(config.rwa)], sign: wallet.sign, onStage });
      acct.refresh();
      return { ...r, note: `${rwa} trustline added; waiting for issuer authorization` };
    });

  const buy = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (!validAmt || !destMin) throw new Error("Enter an amount and wait for a quote");
      const op = pathPaymentStrictSendOp({
        sendAsset: config.underlying,
        sendAmount: validAmt,
        destination: wallet.address,
        destAsset: config.rwa,
        destMin,
        path: [config.receipt],
      });
      const r = await submitClassic(net, { source: wallet.address, ops: [op], sign: wallet.sign, onStage });
      setAmt("");
      acct.refresh();
      onDone();
      return { ...r, note: `bought ≈ ${fmt(estOut, 2)} ${rwa} with ${fmt(validAmt, 2)} ${uLabel}` };
    });

  const authState: "none" | "pending" | "ok" | null = !wallet.address || !acct.data ? null : !rwaBal ? "none" : rwaBal.is_authorized === false ? "pending" : "ok";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold">Buy {rwa} with {uLabel}</h3>
        <span className="text-[11px] text-muted-fg">path payment · strict send</span>
      </div>
      <AmountInput value={amt} onChange={setAmt} max={uAvail !== null ? (Math.floor(uAvail * 100) / 100).toString() : null} suffix={uLabel} disabled={tx.running} />

      <div className="mt-3 rounded-md border border-line bg-card-2 px-3 py-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-fg">You receive</span>
          <span className="num font-medium">
            {quote.loading && !best ? <Spinner /> : null} {validAmt ? `≈ ${fmt(estOut, 4)} ${rwa}` : "—"}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-muted-fg">Effective price</span>
          <span className="num">{price ? `${fmt(price, 4)} ${uLabel}/${rwa}` : "—"}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-muted-fg">Route</span>
          <span className="num">{pathLabel ?? (validAmt && quote.data && quote.data.length === 0 ? "no path (books empty?)" : "—")}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-muted-fg">Min received</span>
          <span className="num flex items-center gap-1">
            {destMin ? `${fmt(destMin, 4)} ${rwa}` : "—"}
            <span className="text-muted-fg">·</span>
            <input
              className="w-9 border-b border-line bg-transparent text-right outline-none"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ""))}
              aria-label="Slippage %"
            />
            <span className="text-muted-fg">%</span>
          </span>
        </div>
        {quote.error ? <p className="mt-1 text-red">{quote.error}</p> : null}
      </div>

      {authState ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
          <span className="flex items-center gap-1.5 text-muted-fg">
            <Dot ok={authState === "ok" ? true : authState === "pending" ? null : false} />
            {authState === "ok"
              ? `${rwa} trustline authorized by the issuer`
              : authState === "pending"
                ? `${rwa} trustline awaiting issuer authorization`
                : `No ${rwa} trustline. ${rwa} is AUTH_REQUIRED: the issuer must authorize you.`}
          </span>
          {authState === "none" ? (
            <button className="btn btn-sm shrink-0" onClick={addTrustline} disabled={tlTx.running}>
              {tlTx.running ? <Spinner /> : null}
              Add trustline
            </button>
          ) : null}
        </div>
      ) : null}
      <TxStatus state={tlTx.state} network={config.network} onDismiss={tlTx.reset} />

      <button
        className="btn btn-primary mt-3 w-full"
        onClick={wallet.address ? buy : wallet.connect}
        disabled={tx.running || (!!wallet.address && (!validAmt || !best || authState !== "ok"))}
      >
        {tx.running ? <Spinner /> : null}
        {wallet.address ? `Buy ${rwa}` : "Connect wallet"}
      </button>
      <p className="mt-2 text-[11px] text-muted-fg">
        One transaction: {uLabel} → {rLabel} on the peg book, {rLabel} → {rwa} on this book. The taker never holds {rLabel}; the maker who filled you now does.
      </p>
      <TxStatus state={tx.state} network={config.network} onDismiss={tx.reset} />
    </div>
  );
}
