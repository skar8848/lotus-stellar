"use client";

import { useCallback, useEffect, useState } from "react";
import { useNet } from "@/lib/config-context";
import type { Strategy } from "@/lib/config-types";
import { usePolling } from "@/lib/hooks";
import { addressArg, isContractId, simulateView } from "@/lib/stellar";
import { aprFromSamples, pushSample, sampleFromReserve, type ReserveSample } from "@/lib/yieldRate";

export type LiveApr = {
  /** live supply APR in percent, measured over `windowS` seconds of this session; null while measuring */
  aprPct: number | null;
  windowS: number;
  /** last figure measured by the deployment team (testnet.contract.json observed_apr), if any */
  observedPct: number | null;
  observedOn: string | null;
  error: string | null;
  /** strategy is live (allocated to Blend) */
  live: boolean;
};

/**
 * Supply APR of the Blend pool behind a Lotus strategy, read live from chain: `get_reserve(USDC)` every 15 s,
 * annualized b_rate growth between the first read of the session and the latest one (lib/yieldRate.ts).
 */
export function useBlendApr(strategy: Strategy | null): LiveApr {
  const net = useNet();
  const pool = strategy?.blendPool ?? "";
  const asset = strategy?.underlying.sac ?? "";
  const live = strategy?.status === "live";
  const enabled = live && isContractId(pool) && isContractId(asset);
  const fn = useCallback(async () => sampleFromReserve(await simulateView(net, pool, "get_reserve", [addressArg(asset)])), [net, pool, asset]);
  const q = usePolling(fn, 15000, enabled);
  const [samples, setSamples] = useState<{ key: string; first: ReserveSample | null; last: ReserveSample | null }>({ key: "", first: null, last: null });
  const key = `${pool}:${asset}`;
  useEffect(() => {
    const s = q.data;
    if (!s) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- accumulating polled samples
    setSamples((prev) => (prev.key === key ? { key, ...pushSample(prev, s) } : { key, first: s, last: s }));
  }, [q.data, key]);
  const cur = samples.key === key ? samples : { first: null, last: null };
  const aprPct = cur.first && cur.last ? aprFromSamples(cur.first, cur.last) : null;
  return {
    aprPct,
    windowS: cur.first && cur.last ? cur.last.time - cur.first.time : 0,
    observedPct: strategy?.observed?.aprPct ?? null,
    observedOn: strategy?.observed?.measuredOn ?? null,
    error: q.error,
    live,
  };
}
