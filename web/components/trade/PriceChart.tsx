"use client";

// /trade price chart, styled after Hyperliquid's chart (itself TradingView's Advanced Charts) on the Lotus near-black card: teal / red
// candles, dashed last-price line with its tag on the right axis, top toolbar (intervals, chart type, indicators,
// screenshot, full screen), left drawing rail, symbol + OHLC legend, bottom bar (date ranges, clock, % / log / auto).
// Drawn with TradingView's open-source lightweight-charts on OUR data (Horizon /trade_aggregations of the selected SDEX
// market): the licensed Advanced Charts library is not used, and the embed widget only plots TradingView's own feeds.
// Empty buckets are drawn as flat muted candles at the previous close with zero volume (see fillCandleGaps).
// The chart is created once; polls push only the changed tail of each series (syncSeries), so bot updates do not jank.
// mode="pro" (the range order views of /swap?mode=pro and /pools) adds chart/rangeLayer.ts: draggable min / max range
// handles, the reference price line and the per-bin liquidity histogram (Lotus pool + SDEX) at the right of the pane.

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  ChartArea,
  ChartCandlestick,
  ChartColumn,
  ChartLine,
  ChevronDown,
  Crosshair,
  Eye,
  EyeOff,
  Magnet,
  Maximize,
  Minimize,
  Minus,
  MoveRight,
  RotateCcw,
  Ruler,
  Slash,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { ema, fillCandleGaps, type ChartCandle } from "@/lib/book";
import type { Candle } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { DrawingLayer, loadDrawings, saveDrawings, type DrawTool, type Drawing, type Pt } from "./chart/drawings";
import { POOL_COLOR, RangeLayer, SDEX_COLOR, panelWidth, type DepthBin, type RangeHandle } from "./chart/rangeLayer";
import { fmtPrice, fmtVol, syncSeries, vwap, type SyncState } from "./chart/series";
import { Clock, Divider, HL, Menu, MenuHeading, MenuItem, TbBtn } from "./chart/ui";

export type Timeframe = { label: string; ms: number };
type Style = "candles" | "bars" | "line" | "area";
type ScaleMode = "normal" | "percent" | "log";
type Ind = { vol: boolean; ema9: boolean; ema21: boolean; vwap: boolean };

const FLAT = "rgba(134,142,156,0.5)"; // filled (no-trade) buckets
const EMA9 = "#2962ff";
const EMA21 = "#f7a600";
const VWAP = "#ab47bc";
const LOTUS = "#f3b1ce"; // Lotus pink: only for Lotus-specific accents (the user's own orders)
const FAVORITES = ["5m", "1h", "1D"];

/** Bottom-bar date ranges, each with the Horizon resolution that covers it best. */
const RANGES: { label: string; tf: string; secs: number }[] = [
  { label: "5y", tf: "1W", secs: 5 * 365 * 86_400 },
  { label: "1y", tf: "1D", secs: 365 * 86_400 },
  { label: "6m", tf: "1D", secs: 182 * 86_400 },
  { label: "3m", tf: "1D", secs: 91 * 86_400 },
  { label: "1m", tf: "1h", secs: 30 * 86_400 },
  { label: "5d", tf: "15m", secs: 5 * 86_400 },
  { label: "1d", tf: "5m", secs: 86_400 },
];
const STYLES: { id: Style; Icon: typeof ChartLine; label: string }[] = [
  { id: "candles", Icon: ChartCandlestick, label: "Candles" },
  { id: "bars", Icon: ChartColumn, label: "Bars" },
  { id: "line", Icon: ChartLine, label: "Line" },
  { id: "area", Icon: ChartArea, label: "Area" },
];
/** TradingView-style short interval name of the legend ("5", "15", "1h", "D") */
const tvInterval = (l: string) => (l.endsWith("m") ? l.slice(0, -1) : l === "1D" ? "D" : l === "1W" ? "W" : l);
const tfName = (l: string) => (l === "1D" ? "D" : l === "1W" ? "W" : l);

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** chart times are already shifted to the display time zone, so they are read with getUTC* */
function fmtTime(t: number, withTime: boolean): string {
  const d = new Date(t * 1000);
  const day = `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  return withTime ? `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : day;
}
const localOffset = () => (typeof window === "undefined" ? 0 : -new Date().getTimezoneOffset() * 60);

export function PriceChart({
  candles,
  timeframes,
  tfIdx,
  onTf,
  resetKey,
  marketLabel,
  marketId,
  baseCode,
  orderLines,
  headerLeft,
  className,
  mode = "trade",
  range,
  onRangeChange,
  refPrice,
  liquidity,
}: {
  /** raw Horizon aggregations (only buckets with trades), oldest first; null while loading */
  candles: Candle[] | null;
  timeframes: readonly Timeframe[];
  tfIdx: number;
  onTf: (i: number) => void;
  /** changes with the market / interval: the view is reset once the new data arrives */
  resetKey: string;
  marketLabel: string;
  /** drawings are saved per market under this key (default: the label) */
  marketId?: string;
  baseCode: string;
  /** the connected account's open offers on this market, drawn as pink price lines */
  orderLines?: { ask: number[]; bid: number[] };
  /** rendered at the start of the toolbar (the Chart / Depth switch) */
  headerLeft?: React.ReactNode;
  className?: string;
  /** "pro": range order view (range handles, reference price, liquidity histogram on the right of the pane) */
  mode?: "trade" | "pro";
  /** pro: the order's range in QUOTE per BASE (null: no handles, e.g. the Swap tab) */
  range?: { min: number; max: number } | null;
  /** pro: a handle was dragged; the caller snaps / clamps (bin grid, direction rule) and passes the new range back */
  onRangeChange?: (min: number, max: number) => void;
  /** pro: reference price of the order (dashed line + axis tag) */
  refPrice?: number;
  /** pro: per-bin liquidity (Lotus pool + SDEX + the order being built), BASE-equivalent */
  liquidity?: { bins: DepthBin[]; stepBps: number; unit?: string };
}) {
  const pro = mode === "pro";
  const tf = timeframes[tfIdx];
  const res = Math.round(tf.ms / 1000);
  const intraday = tf.ms < 86_400_000;
  const storeKey = marketId ?? marketLabel;
  const [style, setStyle] = useState<Style>("candles");
  // pro: volume off by default (the pane is for the range and the liquidity)
  const [ind, setInd] = useState<Ind>({ vol: !pro, ema9: true, ema21: false, vwap: false });
  const [scale, setScale] = useState<ScaleMode>("normal");
  const [autoScale, setAutoScale] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [tool, setToolState] = useState<DrawTool>("cursor");
  const [magnet, setMagnet] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [local, setLocal] = useState(true);
  const [count, setCount] = useState(0);
  // minute tick: gap filling runs up to "now" (re-renders once a minute, not every second)
  const [nowMin, setNowMin] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  const tzOff = local ? localOffset() : 0;

  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema9Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapRef = useRef<ISeriesApi<"Line"> | null>(null);
  const layerRef = useRef<DrawingLayer | null>(null);
  const sync = useRef<Record<"main" | "vol" | "ema9" | "ema21" | "vwap", SyncState>>({ main: { prev: null }, vol: { prev: null }, ema9: { prev: null }, ema21: { prev: null }, vwap: { prev: null } });
  const appliedKey = useRef<string | null>(null);
  const pendingSecs = useRef<number | null>(null);
  const timesRef = useRef<Map<number, number>>(new Map());
  const barsRef = useRef<ChartCandle[]>([]);
  const resRef = useRef(res);
  const toolRef = useRef<DrawTool>("cursor");
  const magnetRef = useRef(false);
  const pendingPt = useRef<Pt | null>(null);
  const drawingsRef = useRef<Drawing[]>([]);
  const keyRef = useRef(storeKey);
  const orderLinesRef = useRef<{ series: ISeriesApi<SeriesType>; lines: IPriceLine[] } | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const rangeLayerRef = useRef<RangeLayer | null>(null);
  const proRef = useRef(pro);
  const rangeRef = useRef(range ?? null);
  const onRangeRef = useRef(onRangeChange);
  const gapRef = useRef(0);
  const [tip, setTip] = useState<{ x: number; y: number; d: DepthBin } | null>(null);
  const [dragging, setDragging] = useState<RangeHandle | null>(null);
  useEffect(() => {
    proRef.current = pro;
    rangeRef.current = range ?? null;
    onRangeRef.current = onRangeChange;
    gapRef.current = ((refPrice || range?.min || 1) * (liquidity?.stepBps ?? 10)) / 10_000;
  });

  useEffect(() => {
    const id = setInterval(() => setNowMin(Math.floor(Date.now() / 60_000) * 60_000), 5000);
    return () => clearInterval(id);
  }, []);

  // gap-filled bars (UTC times) + indicators; recomputed when data arrives or a new bucket opens
  const bars = useMemo<ChartCandle[]>(() => (candles && candles.length ? fillCandleGaps(candles, tf.ms, nowMin + 59_999) : []), [candles, tf.ms, nowMin]);
  const closes = useMemo(() => bars.map((b) => b.close), [bars]);
  const ema9 = useMemo(() => (closes.length ? ema(closes, 9) : []), [closes]);
  const ema21 = useMemo(() => (closes.length ? ema(closes, 21) : []), [closes]);
  const vwapVals = useMemo(() => vwap(bars), [bars]);

  function setTool(t: DrawTool) {
    toolRef.current = t;
    pendingPt.current = null;
    layerRef.current?.setPreview(t, null, null);
    setToolState(t);
  }
  function commit(next: Drawing[]) {
    drawingsRef.current = next;
    layerRef.current?.setDrawings(next);
    saveDrawings(keyRef.current, next);
    setCount(next.length);
  }

  // the chart, the volume overlay, the indicator lines and the drawing layer are created once
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: HL.bg },
        textColor: HL.text,
        fontSize: 11,
        fontFamily: "var(--font-inter), Inter, -apple-system, sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { color: HL.grid }, horzLines: { color: HL.grid } },
      rightPriceScale: { borderColor: HL.border, scaleMargins: { top: 0.1, bottom: 0.17 } },
      timeScale: { borderColor: HL.border, timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 8, minBarSpacing: 0.5 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: HL.cross, width: 1, style: LineStyle.Dashed, labelBackgroundColor: HL.crossLabel },
        horzLine: { color: HL.cross, width: 1, style: LineStyle.Dashed, labelBackgroundColor: HL.crossLabel },
      },
      localization: { timeFormatter: (t: number) => fmtTime(t, true), priceFormatter: (p: number) => fmtPrice(p) },
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });
    // same price format as the candles: the first series on the right scale sets its tick step (default 0.01 = one label)
    const line = (color: string) =>
      chart.addSeries(LineSeries, { color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
    chartRef.current = chart;
    volRef.current = vol;
    ema9Ref.current = line(EMA9);
    ema21Ref.current = line(EMA21);
    vwapRef.current = line(VWAP);
    const layer = new DrawingLayer();
    layer.setContext({ fmt: fmtPrice, up: HL.up, down: HL.down });
    layerRef.current = layer;
    const rangeLayer = new RangeLayer();
    rangeLayer.set({ fmt: fmtPrice });
    rangeLayerRef.current = rangeLayer;

    /** pane pixel (x, y) -> { UTC time of the bar, price }, snapped to O/H/L/C with the magnet */
    const pointAt = (x: number, y: number): Pt | null => {
      const main = mainRef.current;
      const bs = barsRef.current;
      const logical = chart.timeScale().coordinateToLogical(x);
      if (!main || !bs.length || logical === null) return null;
      const li = Math.round(logical);
      const raw = main.coordinateToPrice(y);
      if (raw === null) return null;
      let price: number = raw;
      const b = bs[li];
      if (magnetRef.current && b) {
        let best = Infinity;
        for (const v of [b.open, b.high, b.low, b.close]) {
          const vy = main.priceToCoordinate(v);
          if (vy !== null && Math.abs(vy - y) < best) {
            best = Math.abs(vy - y);
            price = v;
          }
        }
      }
      return { time: bs[0].time + li * resRef.current, price };
    };

    const onMove = (p: MouseEventParams) => {
      const pend = pendingPt.current;
      if (pend && p.point) layer.setPreview(toolRef.current, pend, pointAt(p.point.x, p.point.y));
      if (proRef.current) {
        const pt = p.point;
        const d = pt && pt.x >= 0 && pt.y >= 0 ? rangeLayer.binAt(pt.x, pt.y) : null;
        setTip(d && pt ? { x: pt.x, y: pt.y, d } : null);
        if (toolRef.current === "cursor") rangeLayer.setActive(pt ? rangeLayer.handleAt(pt.y) : null);
        exposeHandles();
      }
      if (!p.point || p.time == null || p.point.x < 0 || p.point.y < 0) {
        setHoverIdx(null);
        return;
      }
      setHoverIdx(timesRef.current.get(p.time as number) ?? null);
    };
    // clicks are read from pointer events on the container (chart.subscribeClick can drop the first click that
    // follows a toolbar click); a press that moved more than 4px is a pan, not a click
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      down = null;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const pane = chart.paneSize();
      if (x < 0 || y < 0 || x > pane.width || y > pane.height) return;
      onClick(x, y);
    };
    const onClick = (x: number, y: number) => {
      const t = toolRef.current;
      if (t === "cursor") {
        if (layer.hasMeasure()) layer.setMeasure(null);
        return;
      }
      const pt = pointAt(x, y);
      if (!pt) return;
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      if (t === "hline" || t === "hray") {
        commit([...drawingsRef.current, { id, kind: t, a: pt }]);
        setTool("cursor");
        return;
      }
      const a = pendingPt.current;
      if (!a) {
        pendingPt.current = pt;
        layer.setMeasure(null);
        return;
      }
      if (t === "measure") layer.setMeasure({ a, b: pt });
      else commit([...drawingsRef.current, { id, kind: t, a, b: pt }]);
      setTool("cursor");
    };
    /** pane y of each handle as data attributes (automation: tests drag them without reading the canvas) */
    const exposeHandles = () => {
      const box = paneRef.current;
      if (!box) return;
      box.dataset.handleMinY = String(Math.round(rangeLayer.handleY("min") ?? -1));
      box.dataset.handleMaxY = String(Math.round(rangeLayer.handleY("max") ?? -1));
    };

    // range handles (pro): a press on a handle drags it instead of panning the chart. Listeners sit on the pane's
    // parent in the capture phase, so neither the chart nor the drawing tools see the press.
    const pane = paneRef.current;
    let drag: RangeHandle | null = null;
    const grab = (e: PointerEvent) => {
      if (!proRef.current || !onRangeRef.current || !rangeRef.current || toolRef.current !== "cursor" || e.button !== 0 || !pane) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > chart.paneSize().width || y > chart.paneSize().height) return;
      const h = rangeLayer.handleAt(y);
      if (!h) return;
      drag = h;
      e.stopPropagation();
      e.preventDefault();
      pane.setPointerCapture?.(e.pointerId);
      rangeLayer.setActive(h);
      setDragging(h);
      setTip(null);
    };
    const swallow = (e: Event) => {
      if (drag) e.stopPropagation();
    };
    const moveDrag = (e: PointerEvent) => {
      if (!drag) return;
      e.stopPropagation();
      const main = mainRef.current;
      const cur = rangeRef.current;
      const cb = onRangeRef.current;
      if (!main || !cur || !cb) return;
      const r = el.getBoundingClientRect();
      const y = Math.max(0, Math.min(chart.paneSize().height, e.clientY - r.top));
      const p = main.coordinateToPrice(y);
      if (p === null || !(p > 0)) return;
      const gap = gapRef.current;
      if (drag === "min") cb(Math.min(p, cur.max - gap), cur.max);
      else cb(cur.min, Math.max(p, cur.min + gap));
    };
    const endDrag = (e: PointerEvent) => {
      if (!drag) return;
      e.stopPropagation();
      drag = null;
      pane?.releasePointerCapture?.(e.pointerId);
      rangeLayer.setActive(null);
      setDragging(null);
      // a handle dragged off a manually scaled axis: back to auto scale, which keeps both handles in view
      if (chart.priceScale("right").options().autoScale === false) {
        chart.priceScale("right").applyOptions({ autoScale: true });
        setAutoScale(true);
      }
      exposeHandles();
    };
    if (pane) {
      pane.addEventListener("pointerdown", grab, true);
      pane.addEventListener("mousedown", swallow, true);
      pane.addEventListener("touchstart", swallow, true);
      pane.addEventListener("pointermove", moveDrag, true);
      pane.addEventListener("pointerup", endDrag, true);
      pane.addEventListener("pointercancel", endDrag, true);
    }

    chart.subscribeCrosshairMove(onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      layer.setMeasure(null);
      setTool("cursor");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (pane) {
        pane.removeEventListener("pointerdown", grab, true);
        pane.removeEventListener("mousedown", swallow, true);
        pane.removeEventListener("touchstart", swallow, true);
        pane.removeEventListener("pointermove", moveDrag, true);
        pane.removeEventListener("pointerup", endDrag, true);
        pane.removeEventListener("pointercancel", endDrag, true);
      }
      chart.unsubscribeCrosshairMove(onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volRef.current = null;
      ema9Ref.current = null;
      ema21Ref.current = null;
      vwapRef.current = null;
      layerRef.current = null;
      rangeLayerRef.current = null;
      orderLinesRef.current = null;
    };
  }, []);

  // main series: recreated when the style changes (the drawing layer moves with it)
  useEffect(() => {
    const chart = chartRef.current;
    const layer = layerRef.current;
    const rangeLayer = rangeLayerRef.current;
    if (!chart || !layer || !rangeLayer) return;
    if (mainRef.current) {
      mainRef.current.detachPrimitive(layer);
      if (pro) mainRef.current.detachPrimitive(rangeLayer);
      chart.removeSeries(mainRef.current);
    }
    const common = { priceFormat: { type: "price" as const, precision: 4, minMove: 0.0001 }, priceLineStyle: LineStyle.Dashed, priceLineWidth: 1 as const };
    const main =
      style === "candles"
        ? chart.addSeries(CandlestickSeries, { ...common, upColor: HL.up, downColor: HL.down, borderUpColor: HL.up, borderDownColor: HL.down, wickUpColor: HL.up, wickDownColor: HL.down })
        : style === "bars"
          ? chart.addSeries(BarSeries, { ...common, upColor: HL.up, downColor: HL.down, thinBars: true })
          : style === "line"
            ? chart.addSeries(LineSeries, { ...common, color: HL.accent, lineWidth: 2 })
            : chart.addSeries(AreaSeries, { ...common, lineColor: HL.accent, topColor: "rgba(80,210,193,0.25)", bottomColor: "rgba(80,210,193,0.02)", lineWidth: 2 });
    if (pro) main.attachPrimitive(rangeLayer);
    main.attachPrimitive(layer);
    mainRef.current = main;
    sync.current.main = { prev: null };
  }, [style, pro]);

  // pro overlay data
  const rMin = range?.min ?? null;
  const rMax = range?.max ?? null;
  useEffect(() => {
    rangeLayerRef.current?.set({
      range: rMin !== null && rMax !== null ? { min: rMin, max: rMax } : null,
      ref: refPrice ?? 0,
      bins: liquidity?.bins ?? [],
      stepBps: liquidity?.stepBps ?? 10,
    });
  }, [rMin, rMax, refPrice, liquidity?.bins, liquidity?.stepBps]);

  // data: only the changed tail is pushed on a poll
  useEffect(() => {
    const main = mainRef.current;
    const chart = chartRef.current;
    if (!main || !chart || !volRef.current || !ema9Ref.current || !ema21Ref.current || !vwapRef.current) return;
    barsRef.current = bars;
    resRef.current = res;
    if (bars.length) layerRef.current?.setContext({ t0: bars[0].time, res });
    const t = (b: ChartCandle) => (b.time + tzOff) as UTCTimestamp;
    timesRef.current = new Map(bars.map((b, i) => [b.time + tzOff, i]));
    const S = sync.current;
    syncSeries(
      main,
      S.main,
      style === "candles" || style === "bars"
        ? bars.map((b) => (b.filled ? { time: t(b), open: b.open, high: b.high, low: b.low, close: b.close, color: FLAT, borderColor: FLAT, wickColor: FLAT } : { time: t(b), open: b.open, high: b.high, low: b.low, close: b.close }))
        : bars.map((b) => ({ time: t(b), value: b.close })),
    );
    const opt = (s: ISeriesApi<SeriesType>, st: SyncState, on: boolean, pts: () => { time: UTCTimestamp; [k: string]: unknown }[]) => {
      if (on) syncSeries(s, st, pts());
      else if (st.prev !== null) {
        s.setData([]);
        st.prev = null;
      }
    };
    opt(volRef.current, S.vol, ind.vol, () => bars.map((b) => (b.volume > 0 ? { time: t(b), value: b.volume, color: b.close >= b.open ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)" } : { time: t(b) })));
    opt(ema9Ref.current, S.ema9, ind.ema9, () => bars.map((b, i) => ({ time: t(b), value: ema9[i] })));
    opt(ema21Ref.current, S.ema21, ind.ema21, () => bars.map((b, i) => ({ time: t(b), value: ema21[i] })));
    opt(vwapRef.current, S.vwap, ind.vwap, () => bars.map((b, i) => (vwapVals[i] != null ? { time: t(b), value: vwapVals[i] } : { time: t(b) })));

    // reset the view once per market / interval, when its data has arrived
    if (bars.length > 0 && appliedKey.current !== resetKey) {
      appliedKey.current = resetKey;
      const secs = pendingSecs.current;
      pendingSecs.current = null;
      if (secs) showLast(chart, bars, secs, tzOff);
      else defaultView(chart, bars.length, pro);
    }
  }, [bars, ema9, ema21, vwapVals, style, ind, resetKey, res, tzOff, pro]);

  // drawings of this market
  useEffect(() => {
    keyRef.current = storeKey;
    const list = loadDrawings(storeKey);
    drawingsRef.current = list;
    layerRef.current?.setDrawings(list);
    pendingPt.current = null;
    layerRef.current?.setMeasure(null);
    const id = setTimeout(() => setCount(list.length), 0);
    return () => clearTimeout(id);
  }, [storeKey]);
  useEffect(() => {
    layerRef.current?.setHidden(hidden);
  }, [hidden]);
  useEffect(() => {
    magnetRef.current = magnet;
    chartRef.current?.applyOptions({ crosshair: { mode: magnet ? CrosshairMode.MagnetOHLC : CrosshairMode.Normal } });
  }, [magnet]);

  // the connected account's offers: pink dashed price lines (Lotus accent)
  const ordersKey = orderLines ? `${orderLines.ask.join(",")}|${orderLines.bid.join(",")}` : "";
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const prev = orderLinesRef.current;
    if (prev && prev.series === main) for (const l of prev.lines) main.removePriceLine(l);
    const lines: IPriceLine[] = [];
    if (ordersKey) {
      const [ask, bid] = ordersKey.split("|").map((s) => (s ? s.split(",").map(Number) : []));
      for (const [list, title] of [
        [ask, "my ask"],
        [bid, "my bid"],
      ] as const)
        for (const price of list)
          lines.push(main.createPriceLine({ price, color: LOTUS, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, axisLabelColor: LOTUS, axisLabelTextColor: "#000000", title }));
    }
    orderLinesRef.current = { series: main, lines };
  }, [ordersKey, style]);

  // price scale modes
  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({
      mode: scale === "log" ? PriceScaleMode.Logarithmic : scale === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
      autoScale,
    });
  }, [scale, autoScale]);
  // dragging the price axis turns auto scale off (as in TradingView); the "auto" button turns it back on
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const check = () => {
      if (chartRef.current?.priceScale("right").options().autoScale === false) setAutoScale(false);
    };
    el.addEventListener("pointerup", check);
    return () => el.removeEventListener("pointerup", check);
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { timeVisible: intraday } });
  }, [intraday]);

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  function zoom(dir: 1 | -1) {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const d = (r.to - r.from) * 0.15 * dir;
    ts.setVisibleLogicalRange({ from: r.from + d, to: r.to - d });
  }
  function resetView() {
    setAutoScale(true);
    if (bars.length && chartRef.current) defaultView(chartRef.current, bars.length, pro);
  }
  function pickRange(r: (typeof RANGES)[number]) {
    const want = timeframes.findIndex((x) => x.label === r.tf);
    if (want >= 0 && want !== tfIdx) {
      pendingSecs.current = r.secs;
      onTf(want);
    } else if (bars.length && chartRef.current) showLast(chartRef.current, bars, r.secs, tzOff);
  }
  function toggleFull() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen?.();
  }
  function clearDrawings() {
    commit([]);
    layerRef.current?.setMeasure(null);
    setTool("cursor");
  }

  // legend: the bar under the crosshair, else the last bar (TradingView behaviour)
  const i = hoverIdx ?? bars.length - 1;
  const bar = bars[i];
  const prev = i > 0 ? bars[i - 1] : null;
  const chg = bar && prev ? bar.close - prev.close : null;
  const chgPct = chg !== null && prev && prev.close > 0 ? (chg / prev.close) * 100 : null;
  const up = bar ? (chg !== null ? chg >= 0 : bar.close >= bar.open) : true;
  const valColor = bar?.filled ? HL.text : up ? HL.up : HL.down;
  const realCount = candles?.length ?? 0;
  const title = `${marketLabel} · ${tvInterval(tf.label)} · Lotus SDEX`;

  function screenshot() {
    const chart = chartRef.current;
    const box = boxRef.current;
    if (!chart || !box) return;
    const shot = chart.takeScreenshot(true, false);
    const dpr = shot.width / Math.max(1, box.clientWidth);
    const c = document.createElement("canvas");
    c.width = shot.width;
    c.height = shot.height;
    const g = c.getContext("2d");
    if (!g) return;
    g.drawImage(shot, 0, 0);
    g.scale(dpr, dpr);
    g.font = "500 12px Inter, -apple-system, sans-serif";
    g.textBaseline = "top";
    g.fillStyle = HL.bright;
    g.fillText(title, 10, 8);
    if (bar) {
      g.fillStyle = valColor;
      g.font = "11px Inter, -apple-system, sans-serif";
      g.fillText(`O ${fmtPrice(bar.open)}  H ${fmtPrice(bar.high)}  L ${fmtPrice(bar.low)}  C ${fmtPrice(bar.close)}`, 10, 26);
    }
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const d = new Date();
      a.download = `lotus-${storeKey}-${tf.label}-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }

  const favs = timeframes.map((t, k) => ({ t, k })).filter(({ t, k }) => FAVORITES.includes(t.label) || k === tfIdx);
  const StyleIcon = STYLES.find((s) => s.id === style)?.Icon ?? ChartCandlestick;
  const nInd = Object.values(ind).filter(Boolean).length;

  const tools: { id: DrawTool; Icon: React.ComponentType<{ className?: string }>; label: string }[] = [
    { id: "cursor", Icon: Crosshair, label: "Crosshair" },
    { id: "trend", Icon: Slash, label: "Trend line (2 clicks)" },
    { id: "hline", Icon: Minus, label: "Horizontal line" },
    { id: "hray", Icon: MoveRight, label: "Horizontal ray" },
    { id: "fib", Icon: FibIcon, label: "Fibonacci retracement (2 clicks)" },
    { id: "measure", Icon: Ruler, label: "Measure (2 clicks): price change, %, bars" },
  ];

  return (
    <div
      ref={wrapRef}
      className={cn("flex min-h-0 flex-col", className)}
      style={{ background: HL.bg }}
      data-testid="price-chart"
      data-style={style}
      data-bars={bars.length}
      data-real={realCount}
      data-tool={tool}
      data-drawings={count}
    >
      {/* top toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5" style={{ borderColor: HL.border }} data-testid="chart-toolbar">
        {headerLeft}
        {headerLeft ? <Divider /> : null}
        {favs.map(({ t, k }) => (
          <TbBtn key={t.label} active={k === tfIdx} onClick={() => onTf(k)} testId={`tf-${t.label}`} title={`${t.label} interval`}>
            {tfName(t.label)}
          </TbBtn>
        ))}
        <Menu label={<ChevronDown className="size-3.5" />} title="More intervals" testId="tf-menu" width={120}>
          {(close) =>
            timeframes.map((t, k) => (
              <MenuItem
                key={t.label}
                active={k === tfIdx}
                testId={`tf-menu-${t.label}`}
                onClick={() => {
                  onTf(k);
                  close();
                }}
              >
                {t.label}
              </MenuItem>
            ))
          }
        </Menu>
        <Divider />
        <Menu label={<StyleIcon className="size-4" />} title="Chart type" testId="style-menu" width={140}>
          {(close) =>
            STYLES.map(({ id, Icon, label }) => (
              <MenuItem
                key={id}
                active={style === id}
                testId={`style-${id}`}
                onClick={() => {
                  setStyle(id);
                  close();
                }}
              >
                <Icon className="size-4" />
                {label}
              </MenuItem>
            ))
          }
        </Menu>
        <Divider />
        <Menu
          label={
            <>
              <span className="font-serif italic">ƒx</span>
              <span className="hidden sm:inline">Indicators</span>
              {nInd ? <span className="num ml-0.5 text-[10px]" style={{ color: HL.accent }}>{nInd}</span> : null}
            </>
          }
          title="Indicators"
          testId="ind-menu"
          width={190}
        >
          {() => (
            <>
              <MenuHeading>Indicators</MenuHeading>
              {(
                [
                  ["vol", "Volume", null],
                  ["ema9", "EMA 9", EMA9],
                  ["ema21", "EMA 21", EMA21],
                  ["vwap", "VWAP (daily)", VWAP],
                ] as const
              ).map(([k, label, col]) => (
                <MenuItem key={k} active={ind[k]} testId={`ind-${k}`} onClick={() => setInd((s) => ({ ...s, [k]: !s[k] }))} right={ind[k] ? <span className="text-[11px]">on</span> : null}>
                  {col ? <span className="h-0.5 w-3 rounded" style={{ background: col }} /> : <ChartColumn className="size-3" />}
                  {label}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <TbBtn onClick={screenshot} title="Take a snapshot (PNG)" icon testId="chart-screenshot">
            <Camera className="size-4" />
          </TbBtn>
          <TbBtn onClick={toggleFull} title={full ? "Exit full screen" : "Full screen"} icon testId="chart-fullscreen">
            {full ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </TbBtn>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* left drawing rail */}
        <div className="flex w-9 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r py-1 scroll-thin" style={{ borderColor: HL.border }} data-testid="chart-tools">
          {tools.map(({ id, Icon, label }) => (
            <TbBtn key={id} icon active={tool === id} onClick={() => setTool(tool === id && id !== "cursor" ? "cursor" : id)} title={label} testId={`tool-${id}`}>
              <Icon className="size-4" />
            </TbBtn>
          ))}
          <Divider vertical />
          <TbBtn icon onClick={() => zoom(1)} title="Zoom in" testId="tool-zoom-in">
            <ZoomIn className="size-4" />
          </TbBtn>
          <TbBtn icon onClick={() => zoom(-1)} title="Zoom out" testId="tool-zoom-out">
            <ZoomOut className="size-4" />
          </TbBtn>
          <TbBtn icon onClick={resetView} title="Reset chart view" testId="tool-reset">
            <RotateCcw className="size-4" />
          </TbBtn>
          <Divider vertical />
          <TbBtn icon active={magnet} onClick={() => setMagnet((m) => !m)} title="Magnet: snap drawings to open / high / low / close" testId="tool-magnet">
            <Magnet className="size-4" />
          </TbBtn>
          <TbBtn icon active={hidden} onClick={() => setHidden((h) => !h)} title={hidden ? "Show drawings" : "Hide drawings"} testId="tool-hide">
            {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </TbBtn>
          <TbBtn icon onClick={clearDrawings} title="Remove all drawings" testId="tool-clear" disabled={count === 0}>
            <Trash2 className="size-4" />
          </TbBtn>
        </div>

        {/* chart + legend */}
        <div
          ref={paneRef}
          className={cn("relative min-w-0 flex-1", tool !== "cursor" && "cursor-crosshair", dragging && "cursor-ns-resize select-none")}
          data-testid="chart-pane"
          data-range-min={pro && range ? range.min : undefined}
          data-range-max={pro && range ? range.max : undefined}
          data-dragging={dragging ?? undefined}
        >
          <div ref={boxRef} className="absolute inset-0" />
          <div className="num pointer-events-none absolute left-2.5 top-1.5 z-10 space-y-0.5 text-[11px] leading-4" data-testid="chart-legend">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: HL.bright }}>
                {title}
                <span className={cn("size-1.5 rounded-full", candles !== null && "animate-pulse")} style={{ background: candles !== null ? HL.up : HL.text }} title="live" />
              </span>
              {bar ? (
                <span className="flex flex-wrap gap-x-2" style={{ color: valColor }}>
                  {(
                    [
                      ["O", bar.open],
                      ["H", bar.high],
                      ["L", bar.low],
                      ["C", bar.close],
                    ] as const
                  ).map(([k, v]) => (
                    <span key={k}>
                      <span style={{ color: HL.text }}>{k}</span>
                      {fmtPrice(v)}
                    </span>
                  ))}
                  {chg !== null && chgPct !== null ? (
                    <span>
                      {chg >= 0 ? "+" : ""}
                      {fmtPrice(chg)} ({chgPct >= 0 ? "+" : ""}
                      {chgPct.toFixed(2)}%)
                    </span>
                  ) : null}
                </span>
              ) : null}
              {bar?.filled ? <span className="rounded bg-white/5 px-1 text-[10px]" style={{ color: HL.text }}>no trades</span> : null}
            </div>
            {bar && ind.vol ? (
              <div style={{ color: HL.text }}>
                Volume · {baseCode} <span style={{ color: bar.volume > 0 ? (bar.close >= bar.open ? HL.up : HL.down) : undefined }}>{fmtVol(bar.volume)}</span>
                {bar.trades > 0 ? <span> · {bar.trades} trade{bar.trades > 1 ? "s" : ""}</span> : null}
              </div>
            ) : null}
            {bar && ind.ema9 && ema9[i] != null ? <IndLine label="EMA 9 close" color={EMA9} value={ema9[i]} /> : null}
            {bar && ind.ema21 && ema21[i] != null ? <IndLine label="EMA 21 close" color={EMA21} value={ema21[i]} /> : null}
            {bar && ind.vwap && vwapVals[i] != null ? <IndLine label="VWAP" color={VWAP} value={vwapVals[i] as number} /> : null}
          </div>
          {pro ? (
            <ProTooltip tip={dragging ? null : tip} unit={liquidity?.unit ?? baseCode} />
          ) : null}
          {tool !== "cursor" ? (
            <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded px-2 py-0.5 text-[11px]" style={{ background: HL.menu, color: HL.bright }}>
              {tool === "hline" || tool === "hray" ? "Click to place" : "Click the first point, then the second"} · Esc to cancel
            </div>
          ) : null}
          {candles !== null && realCount === 0 ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-xs" style={{ color: HL.text }}>
              No trades in this market yet.
            </div>
          ) : candles === null ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-xs" style={{ color: HL.text }}>
              Loading {marketLabel} trades...
            </div>
          ) : null}
        </div>
      </div>

      {/* bottom bar: date ranges | clock, %, log, auto */}
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-t px-1.5 text-[11px]" style={{ borderColor: HL.border }} data-testid="chart-bottom-bar">
        {RANGES.map((r) => (
          <TbBtn key={r.label} onClick={() => pickRange(r)} testId={`range-${r.label}`} title={`Last ${r.label}, ${r.tf} interval (shows what exists)`} small>
            {r.label}
          </TbBtn>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <span className="hidden sm:inline">
            <Clock tzOff={tzOff} onToggle={() => setLocal((l) => !l)} />
          </span>
          <Divider />
          <TbBtn small active={scale === "percent"} onClick={() => setScale((s) => (s === "percent" ? "normal" : "percent"))} title="Percentage scale" testId="scale-percent">
            %
          </TbBtn>
          <TbBtn small active={scale === "log"} onClick={() => setScale((s) => (s === "log" ? "normal" : "log"))} title="Logarithmic scale" testId="scale-log">
            log
          </TbBtn>
          <TbBtn small active={autoScale} onClick={() => setAutoScale(true)} title="Auto scale (fit the price axis to the visible bars)" testId="scale-auto">
            auto
          </TbBtn>
        </div>
      </div>
    </div>
  );
}

/** Pro: hover tooltip of a histogram bin (price, pool size, SDEX size, your size). */
function ProTooltip({ tip, unit }: { tip: { x: number; y: number; d: DepthBin } | null; unit: string }) {
  if (!tip) return null;
  const n = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return (
    <div
      className="num pointer-events-none absolute z-20 -translate-x-full -translate-y-1/2 whitespace-nowrap rounded border px-2 py-1 text-[10px] leading-4 shadow"
      style={{ left: Math.max(150, tip.x - 10), top: tip.y, background: HL.menu, borderColor: HL.border, color: HL.text }}
      data-testid="depth-tooltip"
    >
      <div className="font-medium" style={{ color: HL.bright }}>
        {fmtPrice(tip.d.price)}
      </div>
      <div>
        <span style={{ color: POOL_COLOR }}>pool</span> {n(tip.d.pool)} · <span style={{ color: SDEX_COLOR }}>SDEX</span> {n(tip.d.sdex)}
        {tip.d.mine ? <> · yours {n(tip.d.mine)}</> : null} {unit}
      </div>
    </div>
  );
}

/** Pro: legend of the liquidity histogram, as a small row rendered BELOW the chart by the caller. */
export function LiquidityLegend({ mine, className }: { mine?: boolean; className?: string }) {
  const sw = (bg: string, border?: boolean) => <span className={cn("inline-block size-2.5 rounded-sm", border && "border border-white")} style={{ background: bg }} />;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mutedfg", className)} data-testid="range-chart-legend">
      <span className="flex items-center gap-1.5">{sw(POOL_COLOR)} Lotus pool liquidity</span>
      <span className="flex items-center gap-1.5">{sw(SDEX_COLOR)} SDEX liquidity</span>
      {mine ? <span className="flex items-center gap-1.5">{sw(POOL_COLOR, true)} your order</span> : null}
    </div>
  );
}

function IndLine({ label, color, value }: { label: string; color: string; value: number }) {
  return (
    <div style={{ color: HL.text }}>
      {label} <span style={{ color }}>{fmtPrice(value)}</span>
    </div>
  );
}

function FibIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M2 3h12M2 6.5h12M2 9.5h12M2 13h12" />
      <circle cx="4" cy="13" r="1.3" fill="currentColor" />
      <circle cx="12" cy="3" r="1.3" fill="currentColor" />
    </svg>
  );
}

/**
 * The last 60 bars (or the whole history if shorter, at least 20 slots wide), 3 bars of margin right; in pro mode the
 * right margin also leaves the liquidity panel and the handle grips free, so the candles fill the left part.
 */
function defaultView(chart: IChartApi, n: number, pro = false) {
  const span = Math.max(20, Math.min(60, n));
  const w = chart.paneSize().width;
  const frac = pro && w > 0 ? Math.min(0.5, (panelWidth(w) + 16) / w) : 0;
  const right = 3 + ((span + 3) * frac) / (1 - frac);
  chart.timeScale().setVisibleLogicalRange({ from: n - span, to: n - 1 + right });
}
/** Last `secs` of data (only what exists: a range longer than the history shows the whole history). */
function showLast(chart: IChartApi, bars: ChartCandle[], secs: number, tzOff: number) {
  const to = bars[bars.length - 1].time;
  chart.timeScale().setVisibleRange({ from: (Math.max(bars[0].time, to - secs) + tzOff) as UTCTimestamp, to: (to + tzOff) as UTCTimestamp });
}
