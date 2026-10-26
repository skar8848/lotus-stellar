"use client";

// /trade price chart, laid out like the TradingView Advanced Chart widget that Tenor embeds (top toolbar with
// intervals / chart style / indicators, a symbol + OHLC + volume + EMA legend, a volume pane at the bottom of the
// chart, crosshair, right price scale, date-range bar with %, log and auto scale modes) but drawn with TradingView's
// open-source lightweight-charts on OUR data: Horizon /trade_aggregations of the selected SDEX market.
// The embed widget cannot be used here: it only plots symbols from TradingView's own feeds, not testnet assets.
// Empty buckets are drawn as flat muted candles at the previous close with zero volume (see fillCandleGaps).

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartArea, ChartCandlestick, ChartColumn, ChartLine, Maximize, Minimize, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
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
  type ISeriesApi,
  type MouseEventParams,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { ema, fillCandleGaps, type ChartCandle } from "@/lib/book";
import type { Candle } from "@/lib/stellar";
import { cn } from "@/lib/utils";

export type Timeframe = { label: string; ms: number };
type Style = "candles" | "bars" | "line" | "area";
type ScaleMode = "normal" | "percent" | "log";

const UP = "#02c77b";
const DOWN = "#eb365a";
const FLAT = "rgba(134,142,156,0.55)"; // filled (no-trade) buckets
const EMA_LEN = 9;
const EMA_COLOR = "#2962ff"; // TradingView's default EMA blue
const PRIMARY = "#f3b1ce";

/** Date ranges of the bottom bar: like the TradingView widget, each one also picks a sensible interval. */
const RANGES: { label: string; tf: string | null; secs: number | null }[] = [
  { label: "1D", tf: "5m", secs: 86_400 },
  { label: "5D", tf: "15m", secs: 5 * 86_400 },
  { label: "1M", tf: "1h", secs: 30 * 86_400 },
  { label: "1Y", tf: "1D", secs: 365 * 86_400 },
  { label: "All", tf: null, secs: null },
];

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtUtc(t: number, withTime: boolean): string {
  const d = new Date(t * 1000);
  const day = `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  return withTime ? `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : day;
}
const fmtPrice = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toFixed(4));
const fmtVol = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function PriceChart({
  candles,
  timeframes,
  tfIdx,
  onTf,
  resetKey,
  marketLabel,
  baseCode,
  headerLeft,
  className,
}: {
  /** raw Horizon aggregations (only buckets with trades), oldest first; null while loading */
  candles: Candle[] | null;
  timeframes: readonly Timeframe[];
  tfIdx: number;
  onTf: (i: number) => void;
  /** changes with the market / interval: the view is reset once the new data arrives */
  resetKey: string;
  marketLabel: string;
  baseCode: string;
  /** rendered at the start of the toolbar (the Chart / Depth switch) */
  headerLeft?: React.ReactNode;
  className?: string;
}) {
  const tf = timeframes[tfIdx];
  const intraday = tf.ms < 86_400_000;
  const [style, setStyle] = useState<Style>("candles");
  const [showVol, setShowVol] = useState(true);
  const [showEma, setShowEma] = useState(true);
  const [scale, setScale] = useState<ScaleMode>("normal");
  const [autoScale, setAutoScale] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaRef = useRef<ISeriesApi<"Line"> | null>(null);
  const appliedKey = useRef<string | null>(null);
  const pendingSecs = useRef<number | null>(null);
  const timesRef = useRef<Map<number, number>>(new Map());

  // UTC clock of the bottom bar (and the "now" the gap filling runs to)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const nowBucket = Math.floor(now / tf.ms);

  // gap-filled bars + EMA; recomputed when data arrives or a new bucket opens
  const bars = useMemo<ChartCandle[]>(
    () => (candles && candles.length ? fillCandleGaps(candles, tf.ms, nowBucket * tf.ms) : []),
    [candles, tf.ms, nowBucket],
  );
  const emaVals = useMemo(() => (bars.length ? ema(bars.map((b) => b.close), EMA_LEN) : []), [bars]);

  // the chart, the volume pane and the EMA are created once
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#b2b5be",
        fontSize: 11,
        fontFamily: "var(--font-inter), Inter, -apple-system, sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { color: "rgba(255,255,255,0.05)" }, horzLines: { color: "rgba(255,255,255,0.05)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)", scaleMargins: { top: 0.12, bottom: 0.22 } },
      timeScale: { borderColor: "rgba(255,255,255,0.1)", timeVisible: true, secondsVisible: false, rightOffset: 3, barSpacing: 7, minBarSpacing: 0.5 },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#9598a1", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#363a45" },
        horzLine: { color: "#9598a1", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#363a45" },
      },
      localization: { timeFormatter: (t: number) => fmtUtc(t, true), priceFormatter: (p: number) => fmtPrice(p) },
    });
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    const emaS = chart.addSeries(LineSeries, {
      color: EMA_COLOR,
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    volRef.current = vol;
    emaRef.current = emaS;

    const onMove = (p: MouseEventParams) => {
      if (!p.point || p.time == null || p.point.x < 0 || p.point.y < 0) {
        setHoverIdx(null);
        return;
      }
      setHoverIdx(timesRef.current.get(p.time as number) ?? null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volRef.current = null;
      emaRef.current = null;
    };
  }, []);

  // main series: recreated when the style changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (mainRef.current) chart.removeSeries(mainRef.current);
    const priceFormat = { type: "price" as const, precision: 4, minMove: 0.0001 };
    mainRef.current =
      style === "candles"
        ? chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat })
        : style === "bars"
          ? chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, thinBars: false, priceFormat })
          : style === "line"
            ? chart.addSeries(LineSeries, { color: PRIMARY, lineWidth: 2, priceFormat })
            : chart.addSeries(AreaSeries, { lineColor: PRIMARY, topColor: "rgba(243,177,206,0.28)", bottomColor: "rgba(243,177,206,0.02)", lineWidth: 2, priceFormat });
  }, [style]);

  // data
  useEffect(() => {
    const main = mainRef.current;
    const vol = volRef.current;
    const emaS = emaRef.current;
    const chart = chartRef.current;
    if (!main || !vol || !emaS || !chart) return;
    timesRef.current = new Map(bars.map((b, i) => [b.time, i]));
    const t = (b: ChartCandle) => b.time as UTCTimestamp;
    if (style === "candles" || style === "bars") {
      (main as ISeriesApi<"Candlestick">).setData(
        bars.map((b) => (b.filled ? { time: t(b), open: b.open, high: b.high, low: b.low, close: b.close, color: FLAT, borderColor: FLAT, wickColor: FLAT } : { time: t(b), open: b.open, high: b.high, low: b.low, close: b.close })),
      );
    } else {
      (main as ISeriesApi<"Line">).setData(bars.map((b) => ({ time: t(b), value: b.close })));
    }
    vol.setData(showVol ? bars.map((b) => (b.volume > 0 ? { time: t(b), value: b.volume, color: b.close >= b.open ? "rgba(2,199,123,0.45)" : "rgba(235,54,90,0.45)" } : { time: t(b) })) : []);
    emaS.setData(showEma ? bars.map((b, i) => ({ time: t(b), value: emaVals[i] })) : []);

    // reset the view once per market / interval, when its data has arrived
    if (bars.length > 0 && appliedKey.current !== resetKey) {
      appliedKey.current = resetKey;
      const ts = chart.timeScale();
      const secs = pendingSecs.current;
      pendingSecs.current = null;
      if (secs) {
        const to = bars[bars.length - 1].time;
        ts.setVisibleRange({ from: Math.max(bars[0].time, to - secs) as UTCTimestamp, to: to as UTCTimestamp });
      } else defaultView(chart, bars.length);
    }
  }, [bars, emaVals, style, showVol, showEma, resetKey]);

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
      const on = chartRef.current?.priceScale("right").options().autoScale;
      if (on === false) setAutoScale(false);
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
    appliedKey.current = null;
    setAutoScale(true);
    if (bars.length && chartRef.current) defaultView(chartRef.current, bars.length);
  }
  function pickRange(r: (typeof RANGES)[number]) {
    if (!r.secs) {
      chartRef.current?.timeScale().fitContent();
      return;
    }
    const want = timeframes.findIndex((x) => x.label === r.tf);
    if (want >= 0 && want !== tfIdx) {
      pendingSecs.current = r.secs;
      onTf(want);
    } else if (bars.length) {
      const to = bars[bars.length - 1].time;
      chartRef.current?.timeScale().setVisibleRange({ from: Math.max(bars[0].time, to - r.secs) as UTCTimestamp, to: to as UTCTimestamp });
    }
  }
  function toggleFull() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen?.();
  }

  // legend: the bar under the crosshair, else the last bar (TradingView behaviour)
  const i = hoverIdx ?? bars.length - 1;
  const bar = bars[i];
  const prev = i > 0 ? bars[i - 1] : null;
  const chg = bar && prev ? bar.close - prev.close : null;
  const chgPct = chg !== null && prev && prev.close > 0 ? (chg / prev.close) * 100 : null;
  const up = bar ? (chg !== null ? chg >= 0 : bar.close >= bar.open) : true;
  const realCount = candles?.length ?? 0;
  const utc = new Date(now);

  return (
    <div ref={wrapRef} className={cn("flex min-h-0 flex-col bg-black", className)} data-testid="price-chart" data-style={style} data-bars={bars.length} data-real={realCount}>
      {/* top toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1.5 scroll-thin" data-testid="chart-toolbar">
        {headerLeft}
        {headerLeft ? <Divider /> : null}
        {timeframes.map((t, k) => (
          <TbBtn key={t.label} active={k === tfIdx} onClick={() => onTf(k)} testId={`tf-${t.label}`} title={`${t.label} interval`}>
            {t.label}
          </TbBtn>
        ))}
        <Divider />
        {(
          [
            ["candles", ChartCandlestick, "Candles"],
            ["bars", ChartColumn, "Bars"],
            ["line", ChartLine, "Line"],
            ["area", ChartArea, "Area"],
          ] as const
        ).map(([s, Icon, label]) => (
          <TbBtn key={s} active={style === s} onClick={() => setStyle(s)} testId={`style-${s}`} title={label} icon>
            <Icon className="size-4" />
          </TbBtn>
        ))}
        <Divider />
        <TbBtn active={showVol} onClick={() => setShowVol((v) => !v)} testId="ind-vol" title="Volume">
          Vol
        </TbBtn>
        <TbBtn active={showEma} onClick={() => setShowEma((v) => !v)} testId="ind-ema" title={`Exponential moving average (${EMA_LEN})`}>
          EMA {EMA_LEN}
        </TbBtn>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <TbBtn onClick={() => zoom(-1)} title="Zoom out" icon>
            <ZoomOut className="size-3.5" />
          </TbBtn>
          <TbBtn onClick={() => zoom(1)} title="Zoom in" icon>
            <ZoomIn className="size-3.5" />
          </TbBtn>
          <TbBtn onClick={resetView} title="Reset chart view" icon>
            <RotateCcw className="size-3.5" />
          </TbBtn>
          <TbBtn onClick={toggleFull} title={full ? "Exit full screen" : "Full screen"} icon testId="chart-fullscreen">
            {full ? <Minimize className="size-3.5" /> : <Maximize className="size-3.5" />}
          </TbBtn>
        </div>
      </div>

      {/* chart + legend */}
      <div className="relative min-h-0 flex-1">
        <div ref={boxRef} className="absolute inset-0" />
        <div className="num pointer-events-none absolute left-2.5 top-1.5 z-10 space-y-0.5 text-[11px] leading-4" data-testid="chart-legend">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="text-[12px] font-medium text-[#d1d4dc]">
              {marketLabel} · {tf.label} · Stellar DEX
            </span>
            {bar ? (
              <span className={cn("flex flex-wrap gap-x-2", bar.filled ? "text-mutedfg" : up ? "text-green" : "text-red")}>
                <span><span className="text-mutedfg">O</span>{fmtPrice(bar.open)}</span>
                <span><span className="text-mutedfg">H</span>{fmtPrice(bar.high)}</span>
                <span><span className="text-mutedfg">L</span>{fmtPrice(bar.low)}</span>
                <span><span className="text-mutedfg">C</span>{fmtPrice(bar.close)}</span>
                {chg !== null && chgPct !== null ? (
                  <span>
                    {chg >= 0 ? "+" : ""}
                    {fmtPrice(chg)} ({chgPct >= 0 ? "+" : ""}
                    {chgPct.toFixed(2)}%)
                  </span>
                ) : null}
              </span>
            ) : null}
            {bar?.filled ? <span className="rounded bg-white/5 px-1 text-[10px] text-mutedfg">no trades</span> : null}
          </div>
          {bar && showVol ? (
            <div className="text-mutedfg">
              Vol · {baseCode} <span className={bar.volume > 0 ? (bar.close >= bar.open ? "text-green" : "text-red") : ""}>{fmtVol(bar.volume)}</span>
              {bar.trades > 0 ? <span> · {bar.trades} trade{bar.trades > 1 ? "s" : ""}</span> : null}
            </div>
          ) : null}
          {bar && showEma && emaVals[i] != null ? (
            <div className="text-mutedfg">
              EMA {EMA_LEN} close <span style={{ color: EMA_COLOR }}>{fmtPrice(emaVals[i])}</span>
            </div>
          ) : null}
        </div>
        {candles !== null && realCount === 0 ? (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-xs text-mutedfg">No trades in this market yet.</div>
        ) : candles === null ? (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-xs text-mutedfg">Loading {marketLabel} trades...</div>
        ) : null}
      </div>

      {/* bottom bar: date ranges | UTC clock, %, log, auto */}
      <div className="flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-border px-1.5 text-[11px] scroll-thin" data-testid="chart-bottom-bar">
        {RANGES.map((r) => (
          <TbBtn key={r.label} onClick={() => pickRange(r)} testId={`range-${r.label}`} title={r.secs ? `Last ${r.label}${r.tf ? `, ${r.tf} interval` : ""}` : "Fit all data"} small>
            {r.label}
          </TbBtn>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <span className="num px-1.5 text-mutedfg" title="Chart time zone">
            {pad2(utc.getUTCHours())}:{pad2(utc.getUTCMinutes())}:{pad2(utc.getUTCSeconds())} UTC
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

/** The last 60 to 140 bars (a short history keeps empty space on the left, like TradingView), 3 bars of margin right. */
function defaultView(chart: IChartApi, n: number) {
  const span = Math.min(140, Math.max(60, n));
  chart.timeScale().setVisibleLogicalRange({ from: n - span, to: n + 3 });
}

function Divider() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-white/10" aria-hidden />;
}

function TbBtn({
  children,
  onClick,
  active,
  title,
  testId,
  icon,
  small,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
  testId?: string;
  icon?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "grid shrink-0 place-items-center rounded font-medium transition-colors",
        icon ? "size-7" : small ? "h-5 px-1.5 text-[11px]" : "h-7 px-2 text-xs",
        active ? "text-[#2962ff] hover:bg-white/10" : "text-[#b2b5be] hover:bg-white/10 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}
