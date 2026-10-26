// Drawing tools of the /trade chart, as one lightweight-charts series primitive (open-source plugin API, no licensed
// TradingView library). Points are stored as { time: UTC seconds, price } so a drawing stays put across intervals and
// time zones: x = logicalToCoordinate((time - t0) / res), which also works left / right of the loaded bars because the
// chart's bars are gap-filled (one bar per bucket, see fillCandleGaps).

import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

export type Pt = { time: number; price: number };
export type Drawing =
  | { id: string; kind: "trend"; a: Pt; b: Pt }
  | { id: string; kind: "fib"; a: Pt; b: Pt }
  | { id: string; kind: "hline"; a: Pt }
  | { id: string; kind: "hray"; a: Pt };
export type Measure = { a: Pt; b: Pt };
export type DrawTool = "cursor" | "trend" | "hline" | "hray" | "fib" | "measure";

export const DRAW_COLOR = "#2962ff"; // TradingView's default drawing blue
const FIB_LEVELS: [number, string][] = [
  [0, "#787b86"],
  [0.236, "#f23645"],
  [0.382, "#ff9800"],
  [0.5, "#4caf50"],
  [0.618, "#089981"],
  [0.786, "#00bcd4"],
  [1, "#787b86"],
];

type Ctx = { t0: number; res: number; fmt: (p: number) => string; up: string; down: string };
type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

const STORE = "lotus.chart.drawings.v1:";
export function loadDrawings(key: string): Drawing[] {
  try {
    const raw = window.localStorage.getItem(STORE + key);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as Drawing[]).filter((d) => d && typeof d.kind === "string" && d.a) : [];
  } catch {
    return [];
  }
}
export function saveDrawings(key: string, list: Drawing[]): void {
  try {
    if (list.length) window.localStorage.setItem(STORE + key, JSON.stringify(list));
    else window.localStorage.removeItem(STORE + key);
  } catch {
    /* private mode / quota: drawings just are not kept */
  }
}

export class DrawingLayer implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private request: (() => void) | null = null;
  private drawings: Drawing[] = [];
  private preview: Drawing | Measure | null = null;
  private previewKind: DrawTool = "cursor";
  private measure: Measure | null = null;
  private hidden = false;
  private ctx: Ctx = { t0: 0, res: 60, fmt: (p) => p.toFixed(4), up: "#26a69a", down: "#ef5350" };
  private readonly views: readonly IPrimitivePaneView[];
  private axis: readonly ISeriesPrimitiveAxisView[] = [];

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (t) => this.draw(t) };
    this.views = [{ renderer: () => renderer, zOrder: () => "top" }];
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart;
    this.series = p.series;
    this.request = p.requestUpdate;
  }
  detached() {
    this.chart = null;
    this.series = null;
    this.request = null;
  }
  paneViews() {
    return this.views;
  }
  priceAxisViews() {
    return this.axis;
  }

  setContext(c: Partial<Ctx>) {
    this.ctx = { ...this.ctx, ...c };
    this.request?.();
  }
  setDrawings(list: Drawing[]) {
    this.drawings = list;
    this.rebuildAxis();
    this.request?.();
  }
  setHidden(h: boolean) {
    this.hidden = h;
    this.rebuildAxis();
    this.request?.();
  }
  /** in-progress drawing (first point placed, second under the cursor) */
  setPreview(kind: DrawTool, a: Pt | null, b: Pt | null) {
    this.previewKind = kind;
    this.preview = a && b ? (kind === "measure" ? { a, b } : ({ id: "preview", kind, a, b } as Drawing)) : null;
    this.request?.();
  }
  setMeasure(m: Measure | null) {
    this.measure = m;
    this.request?.();
  }
  hasMeasure() {
    return this.measure !== null;
  }

  private rebuildAxis() {
    const out: ISeriesPrimitiveAxisView[] = [];
    if (!this.hidden)
      for (const d of this.drawings) {
        if (d.kind !== "hline" && d.kind !== "hray") continue;
        const price = d.a.price;
        out.push({
          coordinate: () => this.series?.priceToCoordinate(price) ?? -100,
          text: () => this.ctx.fmt(price),
          textColor: () => "#ffffff",
          backColor: () => DRAW_COLOR,
        });
      }
    this.axis = out;
  }

  private x(time: number): number | null {
    const ts = this.chart?.timeScale();
    if (!ts) return null;
    return ts.logicalToCoordinate(((time - this.ctx.t0) / this.ctx.res) as Logical);
  }
  private y(price: number): number | null {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  private draw(target: DrawTarget) {
    if (!this.series || !this.chart) return;
    target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
      const W = mediaSize.width;
      c.save();
      c.font = "11px Inter, -apple-system, sans-serif";
      c.textBaseline = "middle";
      if (!this.hidden) for (const d of this.drawings) this.drawOne(c, d, W, false);
      if (this.preview) {
        if (this.previewKind === "measure") this.drawMeasure(c, this.preview as Measure);
        else this.drawOne(c, this.preview as Drawing, W, true);
      }
      if (this.measure) this.drawMeasure(c, this.measure);
      c.restore();
    });
  }

  private drawOne(c: CanvasRenderingContext2D, d: Drawing, W: number, preview: boolean) {
    c.strokeStyle = DRAW_COLOR;
    c.lineWidth = 1.5;
    c.setLineDash(preview ? [4, 3] : []);
    if (d.kind === "hline" || d.kind === "hray") {
      const y = this.y(d.a.price);
      if (y === null) return;
      const x0 = d.kind === "hline" ? 0 : (this.x(d.a.time) ?? 0);
      line(c, x0, y, W, y);
      if (d.kind === "hray") dot(c, x0, y);
      return;
    }
    const xa = this.x(d.a.time);
    const xb = this.x(d.b.time);
    const ya = this.y(d.a.price);
    const yb = this.y(d.b.price);
    if (xa === null || xb === null || ya === null || yb === null) return;
    if (d.kind === "trend") {
      line(c, xa, ya, xb, yb);
      dot(c, xa, ya);
      dot(c, xb, yb);
      return;
    }
    // Fibonacci retracement: levels from b (0) back to a (1), as TradingView draws it
    const [l, r] = xa < xb ? [xa, xb] : [xb, xa];
    c.setLineDash([]);
    for (const [lv, col] of FIB_LEVELS) {
      const price = d.b.price + (d.a.price - d.b.price) * lv;
      const y = this.y(price);
      if (y === null) continue;
      c.strokeStyle = col;
      c.lineWidth = 1;
      line(c, l, y, r, y);
      c.fillStyle = col;
      c.textAlign = "right";
      c.fillText(`${lv} (${this.ctx.fmt(price)})`, l - 4, y);
    }
    c.strokeStyle = "rgba(120,123,134,0.6)";
    c.setLineDash([3, 3]);
    line(c, xa, ya, xb, yb);
  }

  private drawMeasure(c: CanvasRenderingContext2D, m: Measure) {
    const xa = this.x(m.a.time);
    const xb = this.x(m.b.time);
    const ya = this.y(m.a.price);
    const yb = this.y(m.b.price);
    if (xa === null || xb === null || ya === null || yb === null) return;
    const up = m.b.price >= m.a.price;
    const col = up ? this.ctx.up : this.ctx.down;
    c.setLineDash([]);
    c.fillStyle = hexA(col, 0.18);
    c.fillRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya));
    c.strokeStyle = col;
    c.lineWidth = 1;
    const mx = (xa + xb) / 2;
    const my = (ya + yb) / 2;
    arrow(c, mx, ya, mx, yb);
    arrow(c, xa, my, xb, my);
    const dp = m.b.price - m.a.price;
    const pct = m.a.price > 0 ? (dp / m.a.price) * 100 : 0;
    const bars = Math.round((m.b.time - m.a.time) / this.ctx.res);
    const lines = [`${dp >= 0 ? "+" : ""}${this.ctx.fmt(dp)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`, `${bars} bar${Math.abs(bars) === 1 ? "" : "s"}, ${span(Math.abs(m.b.time - m.a.time))}`];
    c.font = "11px Inter, -apple-system, sans-serif";
    const w = Math.max(...lines.map((s) => c.measureText(s).width)) + 16;
    const h = 38;
    const by = up ? Math.min(ya, yb) - h - 6 : Math.max(ya, yb) + 6;
    c.fillStyle = col;
    roundRect(c, mx - w / 2, by, w, h, 4);
    c.fill();
    c.fillStyle = "#ffffff";
    c.textAlign = "center";
    c.fillText(lines[0], mx, by + 12);
    c.fillText(lines[1], mx, by + 27);
  }
}

function span(secs: number): string {
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(secs / 86_400);
  const h = Math.round((secs % 86_400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}
function line(c: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
}
function dot(c: CanvasRenderingContext2D, x: number, y: number) {
  c.save();
  c.setLineDash([]);
  c.fillStyle = "#0f1a1f";
  c.beginPath();
  c.arc(x, y, 3.5, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.restore();
}
function arrow(c: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  line(c, x1, y1, x2, y2);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 8) return;
  const a = Math.atan2(y2 - y1, x2 - x1);
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - 6 * Math.cos(a - 0.5), y2 - 6 * Math.sin(a - 0.5));
  c.moveTo(x2, y2);
  c.lineTo(x2 - 6 * Math.cos(a + 0.5), y2 - 6 * Math.sin(a + 0.5));
  c.stroke();
}
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
