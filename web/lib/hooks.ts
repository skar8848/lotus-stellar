"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { explorerTx } from "./explorer";
import type { TxStage } from "./stellar";

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export type Polled<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  refresh: () => void;
};

/**
 * Poll an async function every `ms`. `enabled=false` clears data and does nothing.
 * The function identity should be memoised by the caller (useCallback) so deps are stable.
 */
export function usePolling<T>(fn: () => Promise<T>, ms: number, enabled = true): Polled<T> {
  // `key` remembers which fn produced the data, so a new fn (e.g. another wallet address)
  // never shows the previous one's numbers.
  const [state, setState] = useState<{ key: unknown; data: T | null; error: string | null; updatedAt: number | null }>({
    key: fn,
    data: null,
    error: null,
    updatedAt: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const v = await fn();
        if (!alive) return;
        setState({ key: fn, data: v, error: null, updatedAt: Date.now() });
      } catch (e) {
        if (!alive) return;
        setState((s) => ({
          key: fn,
          data: s.key === fn ? s.data : null,
          error: errMsg(e),
          updatedAt: s.key === fn ? s.updatedAt : null,
        }));
      } finally {
        if (alive) timer = setTimeout(run, ms);
      }
    };
    run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [fn, ms, enabled, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const fresh = state.key === fn;
  const data = enabled && fresh ? state.data : null;
  const error = enabled && fresh ? state.error : null;
  return { data, error, loading: enabled && data === null && error === null, updatedAt: fresh ? state.updatedAt : null, refresh };
}

export type TxState =
  | { stage: "idle" }
  | { stage: TxStage; note?: string }
  | { stage: "error"; error: string }
  | { stage: "success"; hash: string; hashes?: string[]; result?: unknown; note?: string };

export type TxRunner = {
  state: TxState;
  running: boolean;
  run: (
    fn: (
      onStage: (s: TxStage, note?: string) => void,
    ) => Promise<{ hash: string; hashes?: string[]; result?: unknown; note?: string }>,
  ) => Promise<{ hash: string; hashes?: string[]; result?: unknown } | null>;
  reset: () => void;
};

/**
 * Track a multi-step transaction flow for a button + status line. With a `label`, success and
 * failure also raise a toast (success carries a "View tx" explorer action).
 */
export function useTx(label?: string): TxRunner {
  const [state, setState] = useState<TxState>({ stage: "idle" });
  const run = useCallback<TxRunner["run"]>(
    async (fn) => {
      setState({ stage: "building" });
      try {
        const r = await fn((s, note) => setState({ stage: s, note }));
        setState({ stage: "success", hash: r.hash, hashes: r.hashes, result: r.result, note: r.note });
        if (label) {
          toast.success(`${label} confirmed`, {
            description: r.note,
            // a locally simulated action has no hash: no explorer link
            action: r.hash ? { label: "View tx", onClick: () => window.open(explorerTx(r.hash), "_blank", "noopener,noreferrer") } : undefined,
          });
        }
        return r;
      } catch (e) {
        const msg = errMsg(e);
        setState({ stage: "error", error: msg });
        if (label) toast.error(`${label} failed`, { description: msg.length > 180 ? msg.slice(0, 180) + "…" : msg });
        return null;
      }
    },
    [label],
  );
  const reset = useCallback(() => setState({ stage: "idle" }), []);
  const running = !["idle", "error", "success"].includes(state.stage);
  return { state, running, run, reset };
}

/** Debounce a value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
