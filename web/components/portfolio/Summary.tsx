"use client";

import { Stat } from "@/components/common";
import { fmtNum } from "./util";

export type PoolTotals = {
  /** USDC-equivalent value of on-chain pool positions (0 when none) */
  value: number;
  excluded: number;
  onchain: number;
  simulated: number;
};

/** Headline numbers. Only priced assets count; the rest are listed as excluded, never guessed. */
export function Summary({
  loading,
  walletValue,
  walletExcluded,
  pools,
  xlmFree,
  offersCount,
}: {
  loading: boolean;
  walletValue: number;
  walletExcluded: number;
  pools: PoolTotals;
  xlmFree: number | null;
  offersCount: number | null;
}) {
  const total = walletValue + pools.value;
  const excluded = walletExcluded + pools.excluded;
  return (
    <section className="card p-5" data-testid="portfolio-summary">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="min-w-0">
          <div className="label">Total value (USDC equivalent)</div>
          <div className="num mt-1 text-4xl font-semibold tracking-tight" data-testid="portfolio-total">
            {loading ? "-" : fmtNum(total)} <span className="text-base font-normal text-mutedfg">USDC</span>
          </div>
          <div className="mt-1 text-xs text-mutedfg" data-testid="portfolio-excluded">
            {loading
              ? "pricing assets..."
              : excluded > 0
                ? `excl. ${excluded} asset${excluded === 1 ? "" : "s"} without a price`
                : "every asset held has a price"}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-5">
          <Stat label="Wallet" value={loading ? "-" : fmtNum(walletValue)} sub="USDC, incl. in offers" />
          <Stat
            label="In pool positions"
            value={pools.onchain === 0 ? "-" : fmtNum(pools.value)}
            sub={pools.onchain === 0 ? (pools.simulated > 0 ? "simulation not counted" : "none") : "USDC, on-chain"}
          />
          <Stat label="XLM free" value={xlmFree === null ? "-" : fmtNum(xlmFree)} sub="after reserve and offers" />
          <Stat
            label="Pool positions"
            value={pools.onchain + pools.simulated}
            sub={pools.simulated > 0 ? `${pools.simulated} simulated` : "Lotus pool"}
          />
          <Stat label="Open offers" value={offersCount ?? "-"} sub="on the SDEX" />
        </div>
      </div>
    </section>
  );
}
