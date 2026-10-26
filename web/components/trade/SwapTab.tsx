"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowDown, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { AssetField, Spinner, TokenIcon, TxStatus } from "@/components/common";
import { VenueComparison } from "@/components/VenueComparison";
import { TrustlineNotice, useAssetAccess } from "./access";

function bestPath(records: PathRecord[]): PathRecord | null {
  if (records.length === 0) return null;
  return records.reduce((a, b) => (Number(b.destination_amount) > Number(a.destination_amount) ? b : a));
}

function TokenSelect({ value, options, onChange }: { value: AssetRef; options: AssetRef[]; onChange: (a: AssetRef) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className="h-11 shrink-0 gap-2 rounded-full bg-accent pl-2 pr-3 text-base hover:bg-accent/70" data-testid="token-select">
          <TokenIcon code={value.code} size={24} /> {value.code}
          <ChevronDown className="size-4 opacity-60" />
        </Button>
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

  return (
    <div className="space-y-1.5" data-testid="swap-tab">
      <AssetField
        label="Pay"
        testId="swap-pay-amount"
        value={amt}
        onChange={setAmt}
        balance={payAvail !== null ? fmt(payAvail, 2) : wallet.address ? "-" : undefined}
        pill={<TokenSelect value={pay} options={options.filter((o) => assetKey(o) !== assetKey(recv))} onChange={setPay} />}
        hint={payAccess.state === "ok" && payAccess.balance && Number(payAccess.balance.selling_liabilities ?? 0) > 0 ? `${fmt(payAccess.balance.selling_liabilities, 2)} locked in offers` : undefined}
      />
      <div className="relative h-0">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <button onClick={flip} aria-label="Flip" className="grid size-9 place-items-center rounded-xl border-4 border-background bg-secondary text-mutedfg transition hover:text-white">
            <ArrowDown className="size-4" />
          </button>
        </div>
      </div>
      <AssetField
        label="Receive (estimated)"
        testId="swap-receive-amount"
        readOnly
        value={best ? fmt(best.destination_amount, 4) : validAmt && quote.loading ? "..." : ""}
        placeholder="0"
        balance={recvAccess.balance ? fmt(recvAccess.balance.balance, 2) : wallet.address && recvAccess.state !== "loading" ? "-" : undefined}
        pill={<TokenSelect value={recv} options={options.filter((o) => assetKey(o) !== assetKey(pay))} onChange={setRecv} />}
      />

      <div className="rounded-xl border border-border px-3 py-2.5 text-xs" data-testid="swap-details">
        <Line k="Route" v={routeCodes ? routeCodes.join(" > ") : validAmt && quote.data && quote.data.length === 0 ? "no path (book empty?)" : "-"} testId="swap-route" />
        <Line k="Effective price" v={effPrice ? `${fmt(effPrice, 4, 4)} ${pay.code}/${recv.code}` : "-"} />
        <Line k={`Min received (${(slippageBps / 100).toFixed(2)}% slippage)`} v={destMin !== null ? `${fmt(fromStroops(destMin), 4)} ${recv.code}` : "-"} />
        {quote.error ? <p className="mt-1 text-destructive">{quote.error}</p> : null}
      </div>

      <TrustlineNotice asset={recv} access={recvAccess} verb="receive" showOk />
      {payAccess.state === "no-trustline" || payAccess.state === "unauthorized" ? <TrustlineNotice asset={pay} access={payAccess} verb="pay with" /> : null}

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

      <Button className="mt-2 h-12 w-full text-base" onClick={swap} disabled={tx.running || blockedBy !== null} data-testid="swap-submit">
        {tx.running ? <Spinner className="size-5" /> : blockedBy ?? "Swap"}
      </Button>
      <p className="text-[11px] leading-relaxed text-mutedfg">
        One transaction, one signature: Horizon finds the best path through the books (for USDC to LBOND that is USDC &gt; {market.receipt.code} &gt; LBOND). Strict send: you pay exactly what you enter; the swap fails on-chain if the fill would be under the minimum.
      </p>
      <TxStatus state={tx.state} network={config.network} onDismiss={tx.reset} />
    </div>
  );
}

function Line({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-mutedfg">{k}</span>
      <span className="num text-right" data-testid={testId}>
        {v}
      </span>
    </div>
  );
}
