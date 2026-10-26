"use client";

// Ported from lotus-main (owl/web/components/app/LiquidityRangeChart.tsx, the Uniswap-v4 style "New position"
// chart): a price line on the left flowing into a liquidity-depth histogram on the right, with draggable min / max
// handles. Same layout, colours and interaction; the data here is Stellar: the line is the SDEX trade history of the
// pair, the histogram is the live depth per pool bin (Lotus pool bins + SDEX book levels snapped to the same grid),
// and the order being built is drawn in pink on top of it.

import { useCallback, useMemo, useRef, useState } from "react";

export type DepthBin = { bin: number; price: number; pool: number; sdex: number; mine?: number };

const fmtP = (p: number) => (p >= 1000 ? p.toFixed(0) : p.toFixed(4));

export function LiquidityRangeChart({
  line,
  min,
  max,
  current,
  onChange,
  depth,
  stepBps,
  height = 320,
}: {
  /** price series, oldest first (SDEX closes). Empty: a flat line at the current price */
  line: number[];
  min: number;
  max: number;
  current: number;
  onChange: (min: number, max: number) => void;
  depth: DepthBin[];
  stepBps: number;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<null | "min" | "max">(null);

  const { lo, hi, linePath, bars } = useMemo(() => {
    const series = line.length > 1 ? line : current > 0 ? [current, current] : [];
    // depth far from the action would flatten everything: only bins within 10% of the price drive the scale
    const near = depth.filter((d) => current <= 0 || Math.abs(d.price / current - 1) < 0.1);
    const pts = [...series, min, max, ...(current > 0 ? [current] : []), ...near.filter((d) => d.mine).map((d) => d.price)];
    const dataLo = Math.min(...pts);
    const dataHi = Math.max(...pts);
    const pad = (dataHi - dataLo) * 0.12 || dataHi * 0.01 || 0.01;
    const lo = Math.max(0, dataLo - pad);
    const hi = dataHi + pad;
    const span = hi - lo || 1;
    const yOf = (p: number) => (1 - (p - lo) / span) * 1000;

    const n = series.length;
    const lineW = 660;
    const linePath = series.map((c, i) => `${i === 0 ? "M" : "L"}${(i / Math.max(1, n - 1)) * lineW},${yOf(c).toFixed(1)}`).join(" ");

    // depth histogram in a fixed right panel; sqrt-scale spreads a few deep bins into a readable shape
    const PANEL = 200;
    const visible = depth.filter((d) => d.price >= lo && d.price <= hi);
    const maxTotal = Math.max(1e-9, ...visible.map((d) => d.pool + d.sdex + (d.mine ?? 0)));
    const barH = Math.max(2, Math.min(40, (((current || 1) * stepBps) / 10_000 / span) * 1000 * 0.8));
    const w = (v: number) => (v > 0 ? Math.sqrt(v / maxTotal) * PANEL : 0);
    const bars = visible.map((d) => {
      const pool = w(d.pool + d.sdex) * (d.pool / Math.max(1e-12, d.pool + d.sdex));
      const total = w(d.pool + d.sdex);
      const withMine = w(d.pool + d.sdex + (d.mine ?? 0));
      return { y: yOf(d.price), h: barH, pool, sdex: total - pool, mine: d.mine ? Math.max(3, withMine - total) : 0, base: total, inRange: d.price >= min && d.price <= max };
    });
    return { lo, hi, linePath, bars };
  }, [line, depth, min, max, current, stepBps]);

  const yToPrice = useCallback(
    (clientY: number) => {
      const el = ref.current;
      if (!el) return min;
      const rect = el.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      return lo + (1 - pct) * (hi - lo);
    },
    [lo, hi, min],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const p = yToPrice(e.clientY);
      const gap = ((current || 1) * stepBps) / 10_000;
      if (drag === "min") onChange(Math.min(p, max - gap), max);
      else onChange(min, Math.max(p, min + gap));
    },
    [drag, yToPrice, onChange, min, max, current, stepBps],
  );

  const pctOf = (p: number) => `${((1 - (p - lo) / (hi - lo)) * 100).toFixed(2)}%`;

  return (
    <div
      ref={ref}
      data-testid="range-chart"
      className="relative touch-none select-none overflow-hidden rounded-lg border border-line bg-black/30"
      style={{ height }}
      onPointerMove={onMove}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
    >
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="lrc-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F3B1CE" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#F3B1CE" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* selected range band */}
        <rect x="0" y={(1 - (max - lo) / (hi - lo)) * 1000} width="1000" height={Math.max(0, ((max - min) / (hi - lo)) * 1000)} fill="#F3B1CE" fillOpacity="0.07" />
        {/* price area + line (left ~66%) */}
        {linePath ? <path d={`${linePath} L660,1000 L0,1000 Z`} fill="url(#lrc-area)" /> : null}
        {linePath ? <path d={linePath} fill="none" stroke="#8fb6c8" strokeWidth="3" vectorEffect="non-scaling-stroke" /> : null}
        {/* depth panel (right ~20%): faint backdrop + separator so it reads as its own column */}
        <rect x="800" y="0" width="200" height="1000" fill="#0a121c" fillOpacity="0.55" />
        <rect x="800" y="0" width="2" height="1000" fill="#ffffff" fillOpacity="0.08" />
        {bars.map((b, i) => (
          <g key={i}>
            {b.pool > 0 ? <rect x={1000 - b.pool} y={b.y - b.h / 2} width={b.pool} height={b.h} fill={b.inRange ? "#F3B1CE" : "#6e8ca5"} fillOpacity={b.inRange ? 0.6 : 0.35} /> : null}
            {b.sdex > 0 ? (
              <rect x={1000 - b.base} y={b.y - b.h / 2} width={b.sdex} height={b.h} fill={b.inRange ? "#F3B1CE" : "#6e8ca5"} fillOpacity={b.inRange ? 0.3 : 0.16} />
            ) : null}
            {b.mine > 0 ? (
              <rect
                x={1000 - b.base - b.mine}
                y={b.y - b.h / 2}
                width={b.mine}
                height={b.h}
                fill="#F3B1CE"
                fillOpacity="0.85"
                stroke="#F3B1CE"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </g>
        ))}
      </svg>

      {/* draggable handles */}
      {(["max", "min"] as const).map((k) => {
        const p = k === "min" ? min : max;
        return (
          <div key={k} className="absolute left-0 right-0" style={{ top: pctOf(p), transform: "translateY(-50%)" }}>
            <div className="flex items-center">
              <div className="h-px flex-1 bg-primary/70" />
              <div
                data-testid={`range-handle-${k}`}
                onPointerDown={(e) => {
                  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                  setDrag(k);
                }}
                className="flex h-5 cursor-ns-resize items-center rounded-md border border-primary bg-card px-1.5 text-[10px] font-medium tabular-nums text-primary shadow"
                title={`${k} price: drag to move`}
              >
                {fmtP(p)}
              </div>
            </div>
          </div>
        );
      })}

      {/* current price marker */}
      {current > 0 ? (
        <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-white/25" style={{ top: pctOf(current) }}>
          <span className="absolute left-2 -translate-y-full pb-0.5 text-[10px] tabular-nums text-mutedfg">{fmtP(current)}</span>
        </div>
      ) : null}
    </div>
  );
}
