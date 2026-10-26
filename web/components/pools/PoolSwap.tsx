"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { fromStroops, tryStroops } from "@/lib/amount";
import type { PoolInstance } from "@/lib/config-types";
import { useDebounced, usePolling, useTx } from "@/lib/hooks";
import type { PoolClient } from "@/lib/pool";
import { fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { Spinner, TokenIcon, TxStatus } from "@/components/common";
import { TrustlineNotice, useAssetAccess } from "@/components/trade/access";
import { VenueComparison } from "@/components/VenueComparison";

const SLIPS = [0.1, 0.5, 1];

/** Swap against the pool's bins: quote_swap for the preview, swap(min_out) to execute. */
export function PoolSwap({
  inst,
  client,
  horizon,
  network,
  onDone,
}: {
  inst: PoolInstance;
  client: PoolClient;
  horizon: string;
  network: string;
  onDone: () => void;
}) {
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Pool swap");
  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [slip, setSlip] = useState(0.5);
  const debounced = useDebounced(amt, 350);
  const amountIn = useMemo(() => tryStroops(debounced), [debounced]);
  const valid = amountIn !== null && amountIn > 0n;

  const pay = dir === "buy" ? inst.quote : inst.base;
  const recv = dir === "buy" ? inst.base : inst.quote;
  const payAccess = useAssetAccess(pay);
  const recvAccess = useAssetAccess(recv);

  const quoteFn = useCallback(() => client.quoteSwap(dir === "buy", amountIn as bigint), [client, dir, amountIn]);
  const quote = usePolling(quoteFn, 8000, valid);
  const q = quote.data;
  const minOut = q ? (q.amountOut * BigInt(10_000 - Math.round(slip * 100))) / 10_000n : null;
  // the contract's avg_price (fee included) is computed on what is actually spent: on a partial fill only part of the
  // input is pulled, so dividing the full input by the output would overstate the price (fallback: full input)
  const price =
    q && q.amountOut > 0n && amountIn
      ? q.avgPrice > 0n
        ? Number(q.avgPrice) / 1e7
        : dir === "buy"
          ? Number(amountIn) / Number(q.amountOut)
          : Number(q.amountOut) / Number(amountIn)
      : null;
  // what the swap really takes from you on a partial fill (buy: quote spent = out x avg price; sell: base spent = out / avg)
  const spent =
    q && q.partial && q.avgPrice > 0n && q.amountOut > 0n
      ? dir === "buy"
        ? (q.amountOut * q.avgPrice + 9_999_999n) / 10_000_000n
        : (q.amountOut * 10_000_000n + q.avgPrice - 1n) / q.avgPrice
      : null;
  const avail = payAccess.available;
  const insufficient = valid && avail !== null && Number(fromStroops(amountIn as bigint)) > avail + 1e-9;

  const blockedBy = !wallet.address
    ? "Connect a wallet"
    : payAccess.state === "no-trustline" || payAccess.state === "unauthorized"
      ? `${pay.code} trustline needed`
      : recvAccess.state === "no-trustline" || recvAccess.state === "unauthorized"
        ? `${recv.code}: trustline / authorization needed`
        : !valid
          ? "Enter an amount"
          : insufficient
            ? `Insufficient ${pay.code}`
            : !q || q.amountOut <= 0n
              ? quote.loading
                ? "Quoting..."
                : "No liquidity for this swap"
              : null;

  const swap = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (!valid || !q || minOut === null) throw new Error("Enter an amount and wait for a quote");
      const r = await client.swap({ source: wallet.address, sign: wallet.sign, onStage }, dir === "buy", amountIn as bigint, minOut);
      setAmt("");
      acct.refresh();
      onDone();
      return {
        hash: r.hash,
        result: r.result,
        note: `${fmt(fromStroops(amountIn as bigint), 2)} ${pay.code} to about ${fmt(fromStroops(q.amountOut), 4)} ${recv.code}${r.simulated ? " (simulated locally, no transaction)" : ""}`,
      };
    });

  const flip = () => {
    setDir(dir === "buy" ? "sell" : "buy");
    setAmt("");
  };
  const out = q && q.amountOut > 0n ? fmt(fromStroops(q.amountOut), 4) : valid && quote.loading ? "..." : "";

  // lotus-main "lite" swap layout (owl/web/components/app/SwapPanel.tsx): Sell card, flip, Buy card (quoted), one
  // big button; wired to quote_swap / swap(min_out) of the pool and the SDEX venue comparison
  return (
    <div className="space-y-1.5" data-testid="pool-swap" data-dir={dir}>
      {/* direction, kept addressable for the e2e (the flip button toggles it too) */}
      <div className="flex items-center justify-between gap-2 pb-1">
        <div className="flex items-center gap-1 text-lg font-semibold" data-testid="pool-swap-dir">
          {(["buy", "sell"] as const).map((d) => (
            <button
              key={d}
              type="button"
              data-value={d}
              data-active={dir === d ? "1" : "0"}
              onClick={() => d !== dir && flip()}
              className={`px-2 py-1 transition ${dir === d ? "text-white" : "text-mutedfg/60 hover:text-mutedfg"}`}
            >
              {d === "buy" ? `Buy ${inst.base.code}` : `Sell ${inst.base.code}`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-mutedfg" title="Slippage">
          {SLIPS.map((x) => (
            <button key={x} type="button" onClick={() => setSlip(x)} className={`rounded-md px-1.5 py-0.5 font-medium transition ${slip === x ? "bg-white/10 text-white" : "hover:text-white"}`}>
              {x}%
            </button>
          ))}
        </div>
      </div>

      {/* Sell */}
      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="text-sm text-mutedfg">Sell</div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amt}
            onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            data-testid="pool-swap-amount"
            className="w-full min-w-0 bg-transparent text-4xl font-medium tabular-nums outline-none placeholder:text-mutedfg/50"
          />
          <TokenPill code={pay.code} />
        </div>
        <button
          type="button"
          onClick={() => avail !== null && setAmt(String(Math.floor(avail * 1e7) / 1e7))}
          className="mt-1 text-sm tabular-nums text-mutedfg transition hover:text-white"
        >
          {avail !== null ? `Balance: ${fmt(avail, 2)}` : wallet.address ? "Balance: -" : "Connect a wallet to see your balance"}
        </button>
      </div>

      {/* flip */}
      <div className="relative h-0">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <button
            type="button"
            onClick={flip}
            aria-label="Flip"
            data-testid="pool-swap-flip"
            className="grid size-9 place-items-center rounded-xl border-4 border-bg bg-secondary text-mutedfg transition hover:text-white"
          >
            <ArrowDown className="size-4" />
          </button>
        </div>
      </div>

      {/* Buy (quoted) */}
      <div className="rounded-2xl bg-secondary px-4 py-3.5">
        <div className="text-sm text-mutedfg">Buy</div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <input
            readOnly
            tabIndex={-1}
            value={out}
            placeholder="—"
            data-testid="pool-swap-receive"
            className="w-full min-w-0 bg-transparent text-4xl font-medium tabular-nums text-mutedfg outline-none placeholder:text-mutedfg/50"
          />
          <TokenPill code={recv.code} />
        </div>
        <div className="mt-1 text-sm tabular-nums text-mutedfg">
          {price ? `1 ${inst.base.code} ≈ ${fmt(price, 4, 4)} ${inst.quote.code}` : "live Lotus pool quote"}
        </div>
      </div>

      <Button className="mt-2 h-12 w-full text-base" onClick={swap} disabled={tx.running || blockedBy !== null} data-testid="pool-swap-submit">
        {tx.running ? <Spinner className="size-5" /> : (blockedBy ?? "Swap")}
      </Button>

      <div className="rounded-xl border border-line px-3 py-2 text-[11px]" data-testid="pool-swap-details">
        {spent !== null ? <Line k="Input actually used (about)" v={`${fmt(fromStroops(spent), 4)} ${pay.code}`} /> : null}
        <Line k="Bins crossed" v={q ? String(q.binsCrossed) : "-"} />
        <Line k="Fee" v={q ? `${fmt(fromStroops(q.fee), 4)} ${inst.quote.code}` : "-"} />
        <Line k={`Min received (${slip}% slippage)`} v={minOut !== null ? `${fmt(fromStroops(minOut), 4)} ${recv.code}` : "-"} />
        {q?.partial ? <p className="mt-1 text-primary">Pool depth is smaller than this size: only part of your input would be used (the rest is never pulled).</p> : null}
        {quote.error ? <p className="mt-1 text-destructive">{quote.error}</p> : null}
      </div>
      <TrustlineNotice asset={recv} access={recvAccess} verb="receive" />
      <VenueComparison pool={inst} direction={dir} amountIn={amt} base={inst.base} quote={inst.quote} horizon={horizon} compact />
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
    </div>
  );
}

function TokenPill({ code }: { code: string }) {
  return (
    <span className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-white/5 pl-2 pr-3 text-base font-medium">
      <TokenIcon code={code} size={24} /> {code}
    </span>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-mutedfg">{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
}
