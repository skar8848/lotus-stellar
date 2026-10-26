"use client";

// Pro range chart, ported from the previous front's /pro page (owl/web components/AssetChart.tsx + the LimitScreen
// ChartPanel card): candlesticks (lightweight-charts v5), the liquidity histogram in the right 20% of the pane
// (depthLayer.ts), the order range as two DRAGGABLE Start / End handles with the bin levels as dashed pink lines,
// and the floating zoom out / fit / zoom in / recenter group. No EVM logic: candles are Horizon trade aggregations,
// depth is our per-bin pool + SDEX liquidity. The chart is created once; data / range / depth update in place so
// dragging stays smooth. Handles are DOM rows pinned to their price on a rAF loop (track zoom / scroll / autoscale).
// Used by /swap?mode=pro and the /pools New position range step; /trade keeps its own PriceChart.

import type React from "react";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Loader2, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { Badge } from "@/components/ui/badge";
import { TokenIcon } from "@/components/common";
import { fillCandleGaps } from "@/lib/book";
import type { Candle } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { DepthPrimitive, IN_POOL, OUT_POOL, OUT_SDEX, PANEL_FRAC, type DepthBin } from "./depthLayer";
import { PRO_TIMEFRAMES } from "./useProCandles";

export type RangeEnd = "start" | "end";
const PINK = "#F3B1CE";
const FLAT = "rgba(134,142,156,0.5)"; // filled (no-trade) buckets

/** price with enough decimals: 4 under 10 (LBOND ~1.00xx), 2 under 1000, then whole numbers with separators */
export function fmtPx(n: number): string {
  if (!(n > 0)) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  const dp = n >= 10 ? 2 : 4;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
const precisionFor = (p: number) => (p > 0 && p < 10 ? 4 : 2);

/** The lotus-main /pro chart card: pair + "x% liquidity in range", big price ($), 1H..1Y, the chart, legend, caption. */
export function ProChartCard({
  base,
  quote,
  price,
  loading,
  inRangeShare,
  tfIdx,
  onTf,
  marketLabel,
  bare,
  showLegend = true,
  caption,
  ...chart
}: ChartProps & {
  base: string;
  quote: string;
  price: number;
  loading?: boolean;
  inRangeShare: number | null;
  tfIdx: number;
  onTf: (i: number) => void;
  marketLabel: string;
  /** no card frame (inside another card, /pools) */
  bare?: boolean;
  showLegend?: boolean;
  caption?: React.ReactNode;
}) {
  const showRange = !!chart.range;
  return (
    <div className={cn("flex flex-col", !bare && "card p-5")} data-testid="pro-chart">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <span className="flex -space-x-1.5">
              <TokenIcon code={base} size={20} />
              <TokenIcon code={quote} size={20} />
            </span>
            {base} <span className="text-mutedfg">/ {quote}</span>
            {showRange && inRangeShare != null && (
              <Badge variant="outline" className="text-[10px] text-primary" data-testid="pro-in-range">
                {inRangeShare}% liquidity in range
              </Badge>
            )}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums" data-testid="pro-price" data-price={price || undefined}>
            {price > 0 ? `$${fmtPx(price)}` : loading ? <Loader2 className="size-5 animate-spin text-mutedfg" /> : "-"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {PRO_TIMEFRAMES.map((t, i) => (
            <button
              key={t.label}
              onClick={() => onTf(i)}
              data-testid={`pro-tf-${t.label}`}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition", tfIdx === i ? "bg-white/10 text-white" : "text-mutedfg hover:text-white")}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 flex-1">
        <ProRangeChart {...chart} />
      </div>
      {showLegend ? <LiquidityLegend className="mt-2" /> : null}
      <p className="mt-1.5 text-[11px] text-mutedfg">
        {showRange ? (
          <>
            Drag the <span className="text-primary">Start</span> / <span className="text-primary">End</span> handles to set your range: inventory fills bin by bin as the price moves through it.{" "}
          </>
        ) : null}
        {caption ?? `The right panel shows live liquidity per pool bin (Lotus pool + SDEX), on the same price axis as the ${marketLabel} candles.`}
      </p>
    </div>
  );
}

/** Legend row under the chart (lotus-main had none; kept so pool vs SDEX shading reads). */
export function LiquidityLegend({ className }: { className?: string }) {
  const sw = (bg: string) => <span className="inline-block size-2.5 rounded-sm" style={{ background: bg }} />;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mutedfg", className)} data-testid="range-chart-legend">
      <span className="flex items-center gap-1.5">{sw(OUT_POOL)} Lotus pool liquidity</span>
      <span className="flex items-center gap-1.5">{sw(OUT_SDEX)} SDEX liquidity</span>
      <span className="flex items-center gap-1.5">{sw(IN_POOL)} in your range</span>
    </div>
  );
}

type ChartProps = {
  /** raw Horizon aggregations (only buckets with trades); null while loading */
  candles: Candle[] | null;
  /** bucket size of `candles`, ms (empty buckets are drawn as flat grey candles) */
  resMs: number;
  /** the order's range, Start / End in QUOTE per BASE (null: no handles) */
  range: { start: number; end: number } | null;
  /** grid prices of the order's bins (dashed pink lines) */
  bins?: number[];
  depth: DepthBin[];
  /** reference price of the order: the % on the handles, kept in the autoscale */
  refPrice: number;
  /** a handle was dragged to `price`; the caller snaps / clamps and passes the new range back */
  onRangeChange?: (which: RangeEnd, price: number) => void;
  /** reset the range back around the reference price */
  onRecenter?: () => void;
  height?: number;
};

export function ProRangeChart({ candles, resMs, range, bins = [], depth, refPrice, onRangeChange, onRecenter, height = 420 }: ChartProps) {
  const interactive = !!onRangeChange && !!range;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const primitiveRef = useRef<DepthPrimitive | null>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<RangeEnd | null>(null);
  const fittedRef = useRef<string>("");

  // latest props for the imperative rAF / drag / autoscale handlers
  const rangeRef = useRef(range);
  const refRef = useRef(refPrice);
  const onChangeRef = useRef(onRangeChange);
  useEffect(() => {
    rangeRef.current = range;
    refRef.current = refPrice;
    onChangeRef.current = onRangeChange;
  });

  // the y-axis fits the candles, the range and the reference price (never the whole histogram)
  const autoscale = useRef((original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    const b = original();
    let min = b?.priceRange?.minValue ?? Infinity;
    let max = b?.priceRange?.maxValue ?? -Infinity;
    const r = rangeRef.current;
    if (r && r.start > 0 && r.end > 0) {
      min = Math.min(min, r.start, r.end);
      max = Math.max(max, r.start, r.end);
    }
    if (refRef.current > 0) {
      min = Math.min(min, refRef.current);
      max = Math.max(max, refRef.current);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return b;
    if (min >= max) {
      min *= 0.998;
      max *= 1.002;
    }
    const pad = (max - min) * 0.04;
    return { priceRange: { minValue: min - pad, maxValue: max + pad } };
  });

  // create the chart ONCE
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8898a8",
        fontFamily: "var(--font-inter), Inter, sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true },
      crosshair: { mode: 0 },
      handleScroll: true,
      handleScale: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#02c77b",
      downColor: "#eb365a",
      borderVisible: false,
      wickUpColor: "#02c77b",
      wickDownColor: "#eb365a",
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      autoscaleInfoProvider: autoscale.current,
    });
    const primitive = new DepthPrimitive();
    series.attachPrimitive(primitive);
    chartRef.current = chart;
    seriesRef.current = series;
    primitiveRef.current = primitive;

    const resize = () => chart.applyOptions({ width: el.clientWidth });
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // pin the DOM handles to their price every frame (rows span 80% of the chart, labels at the histogram's edge, as lotus-main)
    let raf = 0;
    const pin = (h: HTMLDivElement | null, price?: number) => {
      if (!h) return;
      const y = price != null && price > 0 ? series.priceToCoordinate(price) : null;
      if (y == null) {
        h.style.opacity = "0";
        return;
      }
      h.style.opacity = "1";
      h.style.transform = `translateY(${y}px)`;
      h.dataset.y = String(Math.round(y));
    };
    const sync = () => {
      const r = rangeRef.current;
      pin(startRef.current, r?.start);
      pin(endRef.current, r?.end);
      raf = requestAnimationFrame(sync);
    };
    raf = requestAnimationFrame(sync);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      primitiveRef.current = null;
      linesRef.current = [];
    };
  }, [height]);

  // gap-filled bars (flat grey candles at the previous close for buckets without trades)
  // minute tick: gap filling runs up to "now"
  const [nowMin, setNowMin] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => {
    const id = setInterval(() => setNowMin(Math.floor(Date.now() / 60_000) * 60_000), 5000);
    return () => clearInterval(id);
  }, []);
  const bars = useMemo(() => (candles?.length ? fillCandleGaps(candles, resMs, nowMin + 59_999) : []), [candles, resMs, nowMin]);

  // fit the candles into the LEFT (1 - PANEL_FRAC) of the pane, so they end before the depth panel
  function fitReserved() {
    const n = bars.length;
    if (!n) return;
    chartRef.current?.timeScale().setVisibleLogicalRange({ from: -0.5, to: n / (1 - PANEL_FRAC) - 0.5 });
  }

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.setData(
      bars.map((b) =>
        b.filled
          ? { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close, color: FLAT, wickColor: FLAT }
          : { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close },
      ),
    );
    // refit when the timeframe (or the market) changes, not on every poll, so a zoom is kept
    const key = `${resMs}:${bars.length > 0}`;
    if (bars.length && fittedRef.current !== key) {
      fittedRef.current = key;
      const n = bars.length;
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: -0.5, to: n / (1 - PANEL_FRAC) - 0.5 });
    }
  }, [bars, resMs]);

  // axis precision: 4 decimals for prices under 10 (LBOND), 2 above
  const prec = precisionFor(refPrice || bars[bars.length - 1]?.close || 0);
  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 10 ** -prec } });
  }, [prec]);

  // range lines + bin levels, in place (no chart recreate -> smooth drag)
  const binKey = bins.join(",");
  const rs = range?.start ?? null;
  const re = range?.end ?? null;
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    linesRef.current.forEach((l) => s.removePriceLine(l));
    linesRef.current = [];
    for (const p of binKey ? binKey.split(",").map(Number) : [])
      linesRef.current.push(s.createPriceLine({ price: p, color: "rgba(243,177,206,0.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" }));
    for (const p of [rs, re])
      if (p !== null && p > 0) linesRef.current.push(s.createPriceLine({ price: p, color: PINK, lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: "" }));
  }, [rs, re, binKey]);

  // depth + the highlighted band; re-apply the provider so the scale recomputes with the new range / reference
  useEffect(() => {
    const band = rs !== null && re !== null ? { low: Math.min(rs, re), high: Math.max(rs, re) } : null;
    primitiveRef.current?.setData(depth, band);
    seriesRef.current?.applyOptions({ autoscaleInfoProvider: autoscale.current });
  }, [depth, rs, re, refPrice]);

  // drag: pointer Y -> price; the chart does not pan while a handle is held
  useEffect(() => {
    function move(e: PointerEvent) {
      const which = dragRef.current;
      const s = seriesRef.current;
      const cont = containerRef.current;
      if (!which || !s || !cont) return;
      const y = e.clientY - cont.getBoundingClientRect().top;
      const price = s.coordinateToPrice(y);
      if (price == null || (price as number) <= 0) return;
      onChangeRef.current?.(which, price as number);
    }
    function up() {
      if (!dragRef.current) return;
      dragRef.current = null;
      chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  function startDrag(which: RangeEnd, e: React.PointerEvent) {
    e.preventDefault();
    dragRef.current = which;
    chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
    document.body.style.userSelect = "none";
  }

  // zoom the time axis (lotus-main controls)
  function zoom(dir: 1 | -1) {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const d = (r.to - r.from) * 0.15 * dir;
    ts.setVisibleLogicalRange({ from: r.from + d, to: r.to - d });
  }

  const realCount = candles?.length ?? 0;
  return (
    <div className="relative w-full" style={{ height }} data-testid="pro-range-chart" data-bars={bars.length} data-range-start={range?.start} data-range-end={range?.end}>
      <div ref={containerRef} className="h-full w-full" />
      {interactive && range && (
        <>
          <Handle ref={startRef} which="start" label="Start" price={range.start} refPrice={refPrice} onDown={(e) => startDrag("start", e)} />
          <Handle ref={endRef} which="end" label="End" price={range.end} refPrice={refPrice} onDown={(e) => startDrag("end", e)} />
        </>
      )}
      {candles === null ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-mutedfg">Loading trades...</div>
      ) : realCount === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-mutedfg">No trades in this window yet.</div>
      ) : null}
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-lg border border-line bg-card/80 p-0.5 backdrop-blur">
        <ToolBtn title="Zoom out" onClick={() => zoom(-1)}>
          <ZoomOut className="size-3.5" />
        </ToolBtn>
        <ToolBtn title="Fit all" onClick={fitReserved}>
          <Maximize2 className="size-3.5" />
        </ToolBtn>
        <ToolBtn title="Zoom in" onClick={() => zoom(1)}>
          <ZoomIn className="size-3.5" />
        </ToolBtn>
        {onRecenter && (
          <ToolBtn title="Recenter range on price" onClick={onRecenter}>
            <Crosshair className="size-3.5" />
          </ToolBtn>
        )}
      </div>
    </div>
  );
}

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className="grid size-7 place-items-center rounded-md text-mutedfg transition hover:bg-white/10 hover:text-white">
      {children}
    </button>
  );
}

const Handle = forwardRef<HTMLDivElement, { which: RangeEnd; label: string; price: number; refPrice: number; onDown: (e: React.PointerEvent) => void }>(function Handle(
  { which, label, price, refPrice, onDown },
  ref,
) {
  const pct = refPrice > 0 ? (price / refPrice - 1) * 100 : null;
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-10" style={{ width: `${(1 - PANEL_FRAC) * 100}%`, opacity: 0 }} data-testid={`handle-${which}`}>
      {/* the whole row is the drag target (grab the line anywhere), with a tall hit area */}
      <div onPointerDown={onDown} title={`drag to move the ${label.toLowerCase()} price`} className="pointer-events-auto flex -translate-y-1/2 cursor-ns-resize touch-none items-center py-2">
        <div className="h-0.5 flex-1 rounded bg-primary/70" />
        <div className="flex items-center gap-1 rounded-md border border-primary bg-card px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary shadow">
          <span className="text-mutedfg">{label}</span> {fmtPx(price)}
          {pct != null && (
            <span className="text-mutedfg">
              {pct >= 0 ? "+" : ""}
              {pct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
