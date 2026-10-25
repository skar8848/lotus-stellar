"use client";

import { useCallback } from "react";
import type { LotusConfig } from "@/lib/config";
import { usePolling } from "@/lib/hooks";
import { assetLabel, assetReady, fetchOrderBook } from "@/lib/stellar";
import { Depth } from "./Depth";
import { Dot, Empty, Panel } from "./ui";

export function PegPanel({ config }: { config: LotusConfig }) {
  const ready = assetReady(config.underlying) && assetReady(config.receipt);
  const uLabel = assetLabel(config.underlying);
  const rLabel = config.receipt.code;
  const fn = useCallback(
    () => fetchOrderBook(config.horizon, config.receipt, config.underlying, 8),
    [config.horizon, config.receipt, config.underlying],
  );
  const book = usePolling(fn, 5000, ready);

  return (
    <Panel
      title={
        <>
          Peg <span className="text-muted-fg">·</span> {rLabel}/{uLabel}
        </>
      }
      subtitle={`1 ${rLabel} should trade at 1 ${uLabel}. Exit liquidity without touching the vault.`}
      right={
        <span className="flex items-center gap-1.5 text-[11px] text-muted-fg">
          <Dot ok={book.error ? false : book.data ? true : null} pulse={book.loading} />
          {book.error ? "offline" : "live · 5s"}
        </span>
      }
      className="h-full"
    >
      {!ready ? (
        <Empty>Receipt not deployed yet.</Empty>
      ) : (
        <>
          <Depth book={book.data} baseCode={rLabel} counterCode={uLabel} rows={6} priceDp={4} sizeDp={2} compact />
          {book.error ? <p className="mt-2 text-xs text-red">{book.error}</p> : null}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-fg">
            Bids are {uLabel} waiting to buy {rLabel}; asks are {rLabel} sitting in the book, still earning while they wait.
          </p>
        </>
      )}
    </Panel>
  );
}
