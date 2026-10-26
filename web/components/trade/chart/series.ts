// Small pure helpers of the /trade chart: price formatting, VWAP, and incremental series updates.

import type { ISeriesApi, SeriesType, Time } from "lightweight-charts";

const THIN = " ";
/** Axis / legend price: 4 decimals under 10, 2 above, thin-space thousands (TradingView / Hyperliquid style). */
export function fmtPrice(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 10 ? abs.toFixed(2) : abs.toFixed(4);
  const [int, dec] = s.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  return `${n < 0 ? "-" : ""}${grouped}${dec ? `.${dec}` : ""}`;
}
export function fmtVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** VWAP anchored on each UTC day (typical price x volume), null before the day's first trade. */
export function vwap(bars: { time: number; high: number; low: number; close: number; volume: number }[]): (number | null)[] {
  const out: (number | null)[] = [];
  let day = -1;
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    const d = Math.floor(b.time / 86_400);
    if (d !== day) {
      day = d;
      pv = 0;
      v = 0;
    }
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
    out.push(v > 0 ? pv / v : null);
  }
  return out;
}

type Point = { time: Time } & Record<string, unknown>;
export type SyncState = { prev: Point[] | null };

/**
 * Push `next` into a series with as little work as possible: when only the last bar changed and / or new bars were
 * appended (the usual poll), `update()` the tail; otherwise (new market, interval, window shift) `setData()`.
 */
export function syncSeries(series: ISeriesApi<SeriesType>, st: SyncState, next: Point[]): void {
  const prev = st.prev;
  let full = !prev || prev.length === 0 || next.length < prev.length || next.length === 0 || prev[0].time !== next[0].time;
  if (!full && prev) {
    for (let i = 0; i < prev.length - 1; i++) {
      if (!samePoint(prev[i], next[i])) {
        full = true;
        break;
      }
    }
  }
  if (full) series.setData(next as never);
  else if (prev) for (let i = prev.length - 1; i < next.length; i++) if (i >= prev.length || !samePoint(prev[i], next[i])) series.update(next[i] as never);
  st.prev = next;
}
function samePoint(a: Point, b: Point): boolean {
  if (a.time !== b.time) return false;
  for (const k in b) if (a[k] !== b[k]) return false;
  for (const k in a) if (!(k in b)) return false;
  return true;
}
