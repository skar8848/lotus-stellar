"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowDownUp, ChevronDown, Check } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { useDebounced, usePolling, useTx } from "@/lib/hooks";
import type { Market } from "@/lib/markets";
import {
  assetKey,
  fetchStrictSendPaths,
  fmt,
  fromStroops,
  normalizeAmount,
  pathPaymentStrictSendOp,
  submitClassic,
  toAssetRef,
  toStroops,
  type AssetRef,
  type PathRecord,
} from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { Spinner, TokenIcon, TxStatus } from "@/components/common";
import { VenueComparison } from "@/components/VenueComparison";
import { TrustlineNotice, useAssetAccess } from "./access";
import { ActionButton, PctSlider, SideToggle, SummaryBox, SumRow, SumSep, Warn, type Side } from "./form";

function bestPath(records: PathRecord[]): PathRecord | null {
  if (records.length === 0) return null;
  return records.reduce((a, b) => (Number(b.destination_amount) > Number(a.destination_amount) ? b : a));
}

function TokenSelect({ value, options, onChange }: { value: AssetRef; options: AssetRef[]; onChange: (a: AssetRef) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent pl-1.5 pr-2 text-xs font-medium transition hover:bg-white/10"
          data-testid="token-select"
        >
          <TokenIcon code={value.code} size={16} /> {value.code}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {options.map((o) => (
          <DropdownMenuItem key={assetKey(o)} onClick={() => onChange(o)} data-testid={`token-option-${o.code}`}>
            <TokenIcon code={o.code} size={18} /> {o.code}
            {assetKey(o) === assetKey(value) ? <Check className="ml-auto size-4 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compact amount box with a token selector inside, exchange style. */
function TokenField({
  label,
  right,
  value,
  onChange,
  readOnly,
  testId,
  pill,
  placeholder = "0.00",
}: {
  label: string;
  right?: React.ReactNode;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  testId: string;
  pill: React.ReactNode;
  placeholder?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-mutedfg">
        <span>{label}</span>
        {right}
      </div>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary py-1 pl-3 pr-1 transition-colors focus-within:border-primary">
        <input
          data-testid={testId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={(e) => onChange?.(e.target.value.replace(/[^0-9.]/g, ""))}
          className={cn("num w-full min-w-0 bg-transparent py-1 text-sm outline-none placeholder:text-mutedfg/50", readOnly && "text-mutedfg")}
        />
        {pill}
      </div>
    </div>
  );
}

/** Taker: pay asset -> receive asset with ONE pathPaymentStrictSend, quoted from Horizon /paths/strict-send. */
export function SwapTab({ market, slippageBps, onDone }: { market: Market; slippageBps: number; onDone: () => void }) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Swap");

  const options = useMemo(() => {
    const seen = new Set<string>();
    return [market.underlying, market.receipt, config.rwa].filter((a) => {
      const k = assetKey(a);
      if (seen.has(k)) return false;
      seen.add(k);
      return !!a.issuer;
    });
  }, [market, config.rwa]);

  // Buy the base with: the quote on the peg book (receipt/USDC), plain USDC otherwise (routed through the receipt
  // book when needed). Sell the base for the same asset.
  const counter = market.kind === "peg" ? market.quote : market.underlying;
  const [pay, setPay] = useState<AssetRef>(market.underlying);
  const [recv, setRecv] = useState<AssetRef>(market.kind === "peg" ? market.receipt : market.base);
  const [amt, setAmt] = useState("");
  const debounced = useDebounced(amt, 400);
  const validAmt = useMemo(() => {
    try {
      return toStroops(debounced) > 0n ? normalizeAmount(debounced) : null;
    } catch {
      return null;
    }
  }, [debounced]);

  const side: Side | null = assetKey(recv) === assetKey(market.base) ? "buy" : assetKey(pay) === assetKey(market.base) ? "sell" : null;
  const setSide = (s: Side) => {
    if (s === "buy") {
      setPay(counter);
      setRecv(market.base);
    } else {
      setPay(market.base);
      setRecv(counter);
    }
  };

  const same = assetKey(pay) === assetKey(recv);
  const quoteFn = useCallback(() => fetchStrictSendPaths(config.horizon, pay, validAmt as string, recv), [config.horizon, pay, recv, validAmt]);
  const quote = usePolling(quoteFn, 5000, !!validAmt && !same);
  const best = quote.data ? bestPath(quote.data) : null;

  const payAccess = useAssetAccess(pay);
  const recvAccess = useAssetAccess(recv);

  const estOut = best ? toStroops(best.destination_amount) : null;
  const destMin = estOut !== null ? (estOut * BigInt(10_000 - slippageBps)) / 10_000n : null;
  const effPrice = estOut && validAmt ? Number(validAmt) / Number(best?.destination_amount) : null;
  const routeCodes = best ? [pay.code, ...best.path.map((p) => toAssetRef(p).code), recv.code] : null;

  const payAvail = payAccess.available;
  const insufficient = validAmt !== null && payAvail !== null && Number(validAmt) > payAvail + 1e-9;
  const pct = payAvail && payAvail > 0 && Number(amt) > 0 ? (Number(amt) / payAvail) * 100 : 0;
  const setPct = (v: number) => {
    if (!payAvail || payAvail <= 0) return;
    const s = BigInt(Math.floor(payAvail * 1e7 * (v / 100)));
    setAmt(s > 0n ? fromStroops(s) : "");
  };

  const blockedBy =
    !wallet.address
      ? "Connect a wallet"
      : same
        ? "Pick two different assets"
        : payAccess.state === "no-trustline" || payAccess.state === "unauthorized"
          ? `Fix the ${pay.code} trustline`
          : recvAccess.state === "no-trustline"
            ? `Add the ${recv.code} trustline first`
            : recvAccess.state === "unauthorized"
              ? `${recv.code}: issuer authorization required`
              : !validAmt
                ? "Enter an amount"
                : insufficient
                  ? `Insufficient ${pay.code}`
                  : !best
                    ? quote.loading
                      ? "Quoting..."
                      : "No path for this size"
                    : null;

  const flip = () => {
    setPay(recv);
    setRecv(pay);
  };

  const swap = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (!validAmt || !best || destMin === null) throw new Error("Enter an amount and wait for a quote");
      const op = pathPaymentStrictSendOp({
        sendAsset: pay,
        sendAmount: validAmt,
        destination: wallet.address,
        destAsset: recv,
        destMin: fromStroops(destMin),
        path: best.path.map(toAssetRef),
      });
      const r = await submitClassic(net, { source: wallet.address, ops: [op], sign: wallet.sign, onStage });
      setAmt("");
      acct.refresh();
      onDone();
      return { ...r, note: `${fmt(validAmt, 2)} ${pay.code} to about ${fmt(best.destination_amount, 4)} ${recv.code}` };
    });

  // the pool trades LBOND against USDC; show the venue comparison for that pair only
  const poolPair =
    config.pools[0] &&
    ((pay.code === config.pools[0].quote.code && recv.code === config.pools[0].base.code) ||
      (pay.code === config.pools[0].base.code && recv.code === config.pools[0].quote.code));

  const locked = payAccess.state === "ok" && payAccess.balance && Number(payAccess.balance.selling_liabilities ?? 0) > 0 ? Number(payAccess.balance.selling_liabilities) : 0;

  return (
    <div className="space-y-2.5" data-testid="swap-tab">
      <SideToggle value={side} onChange={setSide} testId="swap-side" buyLabel={`Buy ${market.base.code}`} sellLabel={`Sell ${market.base.code}`} />

      <div>
        <TokenField
          label="Pay"
          testId="swap-pay-amount"
          value={amt}
          onChange={setAmt}
          right={
            payAvail !== null ? (
              <button type="button" onClick={() => setPct(100)} className="text-[10px] transition hover:text-foreground" title="Use the full available balance">
                Available: <span className="num text-foreground">{fmt(payAvail, 2)}</span>
                {locked > 0 ? <span className="text-mutedfg"> ({fmt(locked, 2)} in offers)</span> : null}
              </button>
            ) : null
          }
          pill={<TokenSelect value={pay} options={options.filter((o) => assetKey(o) !== assetKey(recv))} onChange={setPay} />}
        />
        <PctSlider pct={pct} onPct={setPct} disabled={!wallet.address || !payAvail} />
      </div>

      <div className="flex justify-center">
        <button type="button" onClick={flip} aria-label="Flip" className="grid size-7 place-items-center rounded-md border border-border bg-secondary text-mutedfg transition hover:text-foreground">
          <ArrowDownUp className="size-3.5" />
        </button>
      </div>

      <TokenField
        label="Receive (estimated)"
        testId="swap-receive-amount"
        readOnly
        value={best ? fmt(best.destination_amount, 4) : validAmt && quote.loading ? "..." : ""}
        placeholder="0"
        right={recvAccess.balance ? <span className="text-[10px]">Balance: <span className="num text-foreground">{fmt(recvAccess.balance.balance, 2)}</span></span> : null}
        pill={<TokenSelect value={recv} options={options.filter((o) => assetKey(o) !== assetKey(pay))} onChange={setRecv} />}
      />

      <SummaryBox testId="swap-details">
        <SumRow k="Route" v={routeCodes ? routeCodes.join(" > ") : validAmt && quote.data && quote.data.length === 0 ? "no path (book empty?)" : "-"} testId="swap-route" />
        <SumRow k="Avg price" v={effPrice ? `${fmt(effPrice, 4, 4)} ${pay.code}/${recv.code}` : "--"} />
        <SumRow k={`Min received`} v={destMin !== null ? `${fmt(fromStroops(destMin), 4)} ${recv.code}` : "--"} />
        <SumSep />
        <SumRow k="Slippage" v={`${(slippageBps / 100).toFixed(2)}%`} />
        <SumRow k="Operation" v="pathPaymentStrictSend" />
        <SumRow k="Network fee" v="0.0001 XLM" />
        {quote.error ? <p className="text-[11px] text-destructive">{quote.error}</p> : null}
      </SummaryBox>

      <TrustlineNotice asset={recv} access={recvAccess} verb="receive" showOk />
      {payAccess.state === "no-trustline" || payAccess.state === "unauthorized" ? <TrustlineNotice asset={pay} access={payAccess} verb="pay with" /> : null}
      {validAmt && quote.data && quote.data.length === 0 ? <Warn tone="info">No path through the books for this size. Try a smaller amount or place a Limit order.</Warn> : null}

      {poolPair ? (
        <VenueComparison
          pool={config.pools[0]}
          direction={pay.code === config.pools[0].quote.code ? "buy" : "sell"}
          amountIn={amt}
          base={config.pools[0].base}
          quote={config.pools[0].quote}
          horizon={config.horizon}
          compact
        />
      ) : null}

      <ActionButton side={side} onClick={swap} disabled={tx.running || blockedBy !== null} blocked={blockedBy !== null && !tx.running} testId="swap-submit">
        {tx.running ? <Spinner className="size-4" /> : blockedBy ?? (side ? `${side === "buy" ? "Buy" : "Sell"} ${market.base.code}` : "Swap")}
      </ActionButton>
      <p className="text-[10px] leading-relaxed text-mutedfg">
        One transaction, one wallet signature: Horizon finds the best path through the books ({market.underlying.code} to {config.rwa.code} goes {market.underlying.code} &gt; {market.receipt.code} &gt; {config.rwa.code}). Strict send: you pay exactly what you enter; it fails on-chain if the fill would be under the minimum.
      </p>
      <TxStatus state={tx.state} network={config.network} onDismiss={tx.reset} />
    </div>
  );
}
