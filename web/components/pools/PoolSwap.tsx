"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { fromStroops, tryStroops } from "@/lib/amount";
import type { PoolInstance } from "@/lib/config-types";
import { useDebounced, usePolling, useTx } from "@/lib/hooks";
import type { PoolClient } from "@/lib/pool";
import { fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { AssetField, Segmented, Spinner, TxStatus } from "@/components/common";
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
  const price = q && q.amountOut > 0n && amountIn ? (dir === "buy" ? Number(amountIn) / Number(q.amountOut) : Number(q.amountOut) / Number(amountIn)) : null;
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

  return (
    <div className="space-y-2" data-testid="pool-swap">
      <Segmented
        value={dir}
        onChange={(d) => {
          setDir(d);
          setAmt("");
        }}
        testId="pool-swap-dir"
        options={[
          { value: "buy", label: `Buy ${inst.base.code}` },
          { value: "sell", label: `Sell ${inst.base.code}` },
        ]}
      />
      <AssetField
        label="Pay"
        testId="pool-swap-amount"
        value={amt}
        onChange={setAmt}
        asset={pay}
        balance={avail !== null ? fmt(avail, 2) : wallet.address ? "-" : undefined}
      />
      <AssetField
        label="Receive (estimated)"
        readOnly
        value={q && q.amountOut > 0n ? fmt(fromStroops(q.amountOut), 4) : valid && quote.loading ? "..." : ""}
        testId="pool-swap-receive"
        asset={recv}
      />
      <div className="rounded-xl border border-border px-3 py-2.5 text-xs" data-testid="pool-swap-details">
        <Line k="Effective price" v={price ? `${fmt(price, 4, 4)} ${inst.quote.code}/${inst.base.code}` : "-"} />
        <Line k="Bins crossed" v={q ? String(q.binsCrossed) : "-"} />
        <Line k="Fee" v={q ? `${fmt(fromStroops(q.fee), 4)} ${inst.quote.code}` : "-"} />
        <Line k={`Min out (${slip}% slippage)`} v={minOut !== null ? `${fmt(fromStroops(minOut), 4)} ${recv.code}` : "-"} />
        {q?.partial ? <p className="mt-1 text-primary">Pool depth is smaller than this size: only part of your input would be used (the rest is never pulled).</p> : null}
        {quote.error ? <p className="mt-1 text-destructive">{quote.error}</p> : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-mutedfg">
        <span>Slippage</span>
        <div className="flex gap-1">
          {SLIPS.map((s) => (
            <button
              key={s}
              onClick={() => setSlip(s)}
              className={`rounded-md px-2 py-1 font-medium transition ${slip === s ? "bg-white/10 text-white" : "hover:text-white"}`}
            >
              {s}%
            </button>
          ))}
        </div>
      </div>
      <TrustlineNotice asset={recv} access={recvAccess} verb="receive" showOk />
      <VenueComparison pool={inst} direction={dir} amountIn={amt} base={inst.base} quote={inst.quote} horizon={horizon} />
      <Button className="mt-1 h-12 w-full text-base" onClick={swap} disabled={tx.running || blockedBy !== null} data-testid="pool-swap-submit">
        {tx.running ? <Spinner className="size-5" /> : blockedBy ?? "Swap on the pool"}
      </Button>
      <p className="text-[11px] leading-relaxed text-mutedfg">
        The pool walks its bins from the best price outward and reverts if you would receive less than min out. Unspent input is never pulled.
      </p>
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
    </div>
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
