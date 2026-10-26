"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { Crosshair, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  type MouseEventParams,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { DepthPrimitive, PANEL_FRAC, type DepthBar } from "./depthPrimitive";

export type ChartRange = { start: number; end: number };
export type LinePoint = { time: number; value: number };

type Hover = {
  x: number;
  y: number;
  price: number | null;
  time: number | null;
  ohlc: { open: number; high: number; low: number; close: number } | null;
  value: number | null;
  bar: DepthBar | null;
};

const fmtTime = (t: number) =>
  new Date(t * 1000).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtSize = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

const fmtPrice = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(4) : n.toPrecision(4));

/**
 * Candlestick chart (lightweight-charts v5) ported from lotus-main's AssetChart. The order range is overlaid
 * as two DRAGGABLE horizontal handles (start / end), the levels as dashed lines, and the order book as a depth
 * panel on the right. The chart is created once; data, range and depth update in place so dragging stays smooth.
 * With no candles it falls back to a line of recent trades, and with no trades at all it keeps an invisible
 * anchor at the reference price so the depth panel still has a price axis.
 */
export function PriceChart({
  candles,
  line,
  depth,
  range,
  bins,
  refPrice,
  onRangeChange,
  onRecenter,
  height = 380,
  baseCode = "",
  quoteCode = "",
}: {
  candles: Candle[];
  line: LinePoint[];
  depth: DepthBar[];
  range?: ChartRange | null;
  bins?: number[];
  refPrice?: number | null;
  onRangeChange?: (which: "start" | "end", price: number) => void;
  onRecenter?: () => void;
  height?: number;
  baseCode?: string;
  quoteCode?: string;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const interactive = !!onRangeChange && !!range;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const primitiveRef = useRef<DepthPrimitive | null>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | "start" | "end">(null);

  // latest props for the imperative rAF / drag / autoscale handlers (refs are written in an effect, never during render)
  const rangeRef = useRef<ChartRange | null | undefined>(range);
  const depthRef = useRef<DepthBar[]>(depth);
  const onChangeRef = useRef(onRangeChange);
  const candleCount = useRef(0);
  const anchorRef = useRef(false); // the invisible reference-price candle (no trades): no OHLC legend for it
  const providerRef = useRef<unknown>(null);
  useEffect(() => {
    rangeRef.current = range;
    depthRef.current = depth;
    onChangeRef.current = onRangeChange;
  });

  // create the chart ONCE (the height follows the prop through applyOptions, see below)
  const initialHeight = useRef(height);
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height: initialHeight.current,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8898a8",
        fontFamily: "var(--font-inter), Inter, sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.35)", width: 1, style: 3, labelVisible: true, labelBackgroundColor: "#1f2933" },
        horzLine: { color: "rgba(255,255,255,0.35)", width: 1, style: 3, labelVisible: true, labelBackgroundColor: "#1f2933" },
      },
      handleScroll: true,
      handleScale: true,
    });

    // Extend the vertical scale beyond the candles to include the depth levels and the order range, so
    // far-from-spot liquidity shows (the candle-only autoscale would clip it).
    const provider = (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
      const base = original();
      let min = base?.priceRange?.minValue ?? Infinity;
      let max = base?.priceRange?.maxValue ?? -Infinity;
      const r = rangeRef.current;
      if (r && r.start > 0 && r.end > 0) {
        min = Math.min(min, r.start, r.end);
        max = Math.max(max, r.start, r.end);
      }
      for (const bar of depthRef.current) {
        if (bar.depth > 0.02) {
          min = Math.min(min, bar.price);
          max = Math.max(max, bar.price);
        }
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return base;
      const pad = (max - min) * 0.05;
      return { priceRange: { minValue: min - pad, maxValue: max + pad } };
    };

    providerRef.current = provider;
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#02c77b",
      downColor: "#eb365a",
      borderVisible: false,
      wickUpColor: "#02c77b",
      wickDownColor: "#eb365a",
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autoscaleInfoProvider: provider as any,
    });
    const lineSeries = chart.addSeries(LineSeries, {
      color: "#f3b1ce",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const primitive = new DepthPrimitive();
    candleSeries.attachPrimitive(primitive);
    chartRef.current = chart;
    candleRef.current = candleSeries;
    lineRef.current = lineSeries;
    primitiveRef.current = primitive;

    // hover: price at the cursor, OHLC / value of the bar under it, and the depth level when over the right panel
    const onMove = (p: MouseEventParams) => {
      const cont = containerRef.current;
      if (!p.point || !cont || p.point.x < 0 || p.point.y < 0) {
        setHover(null);
        return;
      }
      const { x, y } = p.point;
      const price = candleSeries.coordinateToPrice(y) as number | null;
      const cd = p.seriesData.get(candleSeries) as { open?: number; high?: number; low?: number; close?: number } | undefined;
      const ld = p.seriesData.get(lineSeries) as { value?: number } | undefined;
      const ohlc = cd && cd.open != null && cd.high != null && cd.low != null && cd.close != null && !anchorRef.current
        ? { open: cd.open, high: cd.high, low: cd.low, close: cd.close }
        : null;
      // the depth panel is drawn over the right PANEL_FRAC of the pane (pane width = timescale width)
      const paneW = chart.timeScale().width();
      let bar: DepthBar | null = null;
      if (x >= paneW * (1 - PANEL_FRAC)) {
        let best = Infinity;
        for (const d of depthRef.current) {
          const dy = candleSeries.priceToCoordinate(d.price);
          if (dy == null) continue;
          const dist = Math.abs(dy - y);
          if (dist < best && dist <= 8) {
            best = dist;
            bar = d;
          }
        }
      }
      primitive.setHover(bar ? bar.price : null);
      setHover({ x, y, price, time: p.time != null ? (p.time as number) : null, ohlc: bar ? null : ohlc, value: bar ? null : ld?.value ?? null, bar });
    };
    chart.subscribeCrosshairMove(onMove);

    const resize = () => containerRef.current && chart.applyOptions({ width: containerRef.current.clientWidth });
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    // pin the DOM handles to their price every frame (tracks zoom / scroll / autoscale)
    let raf = 0;
    const pin = (el: HTMLDivElement | null, price?: number) => {
      if (!el) return;
      const y = price != null ? candleRef.current?.priceToCoordinate(price) : null;
      if (y == null) {
        el.style.opacity = "0";
      } else {
        el.style.opacity = "1";
        el.style.transform = `translateY(${y}px)`;
      }
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
      chart.unsubscribeCrosshairMove(onMove);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      primitiveRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({ height });
  }, [height]);

  // fit the data into the LEFT (1 - PANEL_FRAC) of the pane, reserving the right share for the depth panel.
  // With only a few candles keep a 40-bar window so a single candle does not stretch across the chart.
  function fitReserved() {
    const n = Math.max(candleCount.current, 1);
    const span = Math.max(n, 40) / (1 - PANEL_FRAC);
    const to = n - 1 + 0.5 + span * PANEL_FRAC;
    chartRef.current?.timeScale().setVisibleLogicalRange({ from: to - span, to });
  }

  // data: candles, else a line of trades, else an invisible anchor at the reference price
  const candleKey = candles.map((c) => `${c.time}:${c.close}`).join("|");
  const lineKey = line.map((p) => `${p.time}:${p.value}`).join("|");
  useEffect(() => {
    const cs = candleRef.current;
    const ls = lineRef.current;
    if (!cs || !ls) return;
    anchorRef.current = false;
    if (candles.length > 0) {
      cs.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
      ls.setData([]);
      candleCount.current = candles.length;
    } else if (line.length > 0) {
      cs.setData([]);
      ls.setData(line.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
      candleCount.current = line.length;
    } else {
      ls.setData([]);
      candleCount.current = 1;
      if (refPrice && refPrice > 0) {
        anchorRef.current = true;
        const t = Math.floor(Date.now() / 1000) as UTCTimestamp;
        cs.setData([{ time: t, open: refPrice, high: refPrice, low: refPrice, close: refPrice, color: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", wickColor: "rgba(0,0,0,0)" }]);
      } else {
        cs.setData([]);
      }
    }
    fitReserved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleKey, lineKey, candles.length === 0 && line.length === 0 ? refPrice : 0]);

  // range handles + level lines: update in place (no chart recreate, so dragging stays smooth)
  const binKey = (bins ?? []).join(",");
  useEffect(() => {
    const s = candleRef.current;
    if (!s) return;
    linesRef.current.forEach((l) => s.removePriceLine(l));
    linesRef.current = [];
    for (const p of bins ?? []) {
      linesRef.current.push(s.createPriceLine({ price: p, color: "rgba(243,177,206,0.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" }));
    }
    if (range) {
      linesRef.current.push(s.createPriceLine({ price: range.start, color: "#F3B1CE", lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: "" }));
      linesRef.current.push(s.createPriceLine({ price: range.end, color: "#F3B1CE", lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.start, range?.end, binKey]);

  // depth panel + the highlighted range band
  const depthKey = depth.map((d) => `${d.price}:${d.depth.toFixed(3)}`).join("|");
  useEffect(() => {
    const band = range ? { low: Math.min(range.start, range.end), high: Math.max(range.start, range.end) } : null;
    primitiveRef.current?.setData(depth, band);
    // re-apply the provider so the price scale recomputes and pulls far-from-spot liquidity into view
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candleRef.current?.applyOptions({ autoscaleInfoProvider: providerRef.current as any });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depthKey, range?.start, range?.end]);

  // drag: pointer-Y -> price; chart pan is disabled while a handle is held
  useEffect(() => {
    function move(e: PointerEvent) {
      const which = dragRef.current;
      const s = candleRef.current;
      const cont = containerRef.current;
      if (!which || !s || !cont) return;
      const y = e.clientY - cont.getBoundingClientRect().top;
      const price = s.coordinateToPrice(y);
      if (price == null || (price as number) <= 0) return;
      onChangeRef.current?.(which, price as number);
    }
    function up() {
      if (dragRef.current) {
        dragRef.current = null;
        chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
        document.body.style.userSelect = "";
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  function startDrag(which: "start" | "end", e: React.PointerEvent) {
    e.preventDefault();
    dragRef.current = which;
    chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
    document.body.style.userSelect = "none";
  }

  function zoom(dir: 1 | -1) {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const d = (r.to - r.from) * 0.15 * dir;
    ts.setVisibleLogicalRange({ from: r.from + d, to: r.to - d });
  }

  const empty = candles.length === 0 && line.length === 0;
  const tipLeft = hover ? Math.max(4, hover.x - 190) : 0;

  return (
    <div className="relative w-full" style={{ height }} data-testid="price-chart" onMouseLeave={() => { setHover(null); primitiveRef.current?.setHover(null); }}>
      <div ref={containerRef} className="h-full w-full" />
      {/* legend: OHLC (or trade price) of the bar under the cursor + the price at the cursor */}
      {hover && !hover.bar && (hover.ohlc || hover.value != null || hover.price != null) ? (
        <div className="num pointer-events-none absolute left-2 top-2 z-20 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md border border-border bg-card/85 px-2 py-1 text-[11px] backdrop-blur" data-testid="chart-legend">
          {hover.time != null && (hover.ohlc || hover.value != null) ? <span className="text-mutedfg">{fmtTime(hover.time)}</span> : null}
          {hover.ohlc ? (
            <>
              <span><span className="text-mutedfg">O</span> {fmtPrice(hover.ohlc.open)}</span>
              <span><span className="text-mutedfg">H</span> {fmtPrice(hover.ohlc.high)}</span>
              <span><span className="text-mutedfg">L</span> {fmtPrice(hover.ohlc.low)}</span>
              <span className={hover.ohlc.close >= hover.ohlc.open ? "text-green" : "text-red"}><span className="text-mutedfg">C</span> {fmtPrice(hover.ohlc.close)}</span>
            </>
          ) : hover.value != null ? (
            <span><span className="text-mutedfg">Trade</span> {fmtPrice(hover.value)}</span>
          ) : null}
          {hover.price != null && hover.price > 0 ? (
            <span data-testid="chart-cursor-price"><span className="text-mutedfg">Cursor</span> {fmtPrice(hover.price)}{quoteCode ? <span className="text-mutedfg"> {quoteCode}</span> : null}</span>
          ) : null}
        </div>
      ) : null}
      {/* depth panel tooltip: the level under the cursor */}
      {hover?.bar ? (
        <div
          className="num pointer-events-none absolute z-20 w-[180px] rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur"
          style={{ left: tipLeft, top: Math.max(4, hover.y - 30) }}
          data-testid="depth-tooltip"
        >
          <div className={cn("font-medium", hover.bar.side === "bid" ? "text-green" : hover.bar.side === "ask" ? "text-red" : "")}>
            {hover.bar.side === "bid" ? "Bid" : hover.bar.side === "ask" ? "Ask" : "Level"} {fmtPrice(hover.bar.price)}
            {quoteCode ? <span className="text-mutedfg"> {quoteCode}</span> : null}
          </div>
          {hover.bar.size != null ? (
            <div className="flex justify-between gap-2"><span className="text-mutedfg">Size</span><span>{fmtSize(hover.bar.size)} {baseCode}</span></div>
          ) : null}
          {hover.bar.cum != null ? (
            <div className="flex justify-between gap-2"><span className="text-mutedfg">Cumulative</span><span>{fmtSize(hover.bar.cum)} {baseCode}</span></div>
          ) : null}
        </div>
      ) : null}
      {empty ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-border bg-card/80 px-2 py-1 text-[11px] text-mutedfg backdrop-blur">
          No trades in this market yet. Depth is shown at right.
        </div>
      ) : null}
      {interactive && range ? (
        <>
          <Handle ref={startRef} label="Start" price={range.start} refPrice={refPrice} onDown={(e) => startDrag("start", e)} />
          <Handle ref={endRef} label="End" price={range.end} refPrice={refPrice} onDown={(e) => startDrag("end", e)} />
        </>
      ) : null}
      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-lg border border-border bg-card/80 p-0.5 backdrop-blur">
        <ToolBtn title="Zoom out" onClick={() => zoom(-1)}>
          <ZoomOut className="size-3.5" />
        </ToolBtn>
        <ToolBtn title="Fit all" onClick={fitReserved}>
          <Maximize2 className="size-3.5" />
        </ToolBtn>
        <ToolBtn title="Zoom in" onClick={() => zoom(1)}>
          <ZoomIn className="size-3.5" />
        </ToolBtn>
        {onRecenter ? (
          <ToolBtn title="Recenter range on price" onClick={onRecenter}>
            <Crosshair className="size-3.5" />
          </ToolBtn>
        ) : null}
      </div>
    </div>
  );
}

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="grid size-7 place-items-center rounded-md text-mutedfg transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}

const Handle = forwardRef<
  HTMLDivElement,
  { label: string; price: number; refPrice?: number | null; onDown: (e: React.PointerEvent) => void }
>(function Handle({ label, price, refPrice, onDown }, ref) {
  const pct = refPrice && refPrice > 0 ? (price / refPrice - 1) * 100 : null;
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-10" style={{ width: `${(1 - PANEL_FRAC) * 100}%`, opacity: 0 }}>
      {/* the WHOLE row is the drag target (grab the line anywhere), with a tall hit area */}
      <div
        onPointerDown={onDown}
        title={`drag to move the ${label.toLowerCase()} price`}
        className="pointer-events-auto flex -translate-y-1/2 cursor-ns-resize touch-none items-center py-2"
        data-testid={`handle-${label.toLowerCase()}`}
      >
        <div className="h-0.5 flex-1 rounded bg-primary/70" />
        <div className="flex items-center gap-1 rounded-md border border-primary bg-card px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary shadow">
          <span className="text-mutedfg">{label}</span> {fmtPrice(price)}
          {pct != null ? (
            <span className="text-mutedfg">
              {pct >= 0 ? "+" : ""}
              {pct.toFixed(1)}%
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
});
