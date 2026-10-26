// Pro overlay of the /trade chart (the range order views of /swap?mode=pro and /pools New position), as one
// lightweight-charts series primitive: the order's min / max handles (lines, axis tags, shaded band), the reference
// price line, and the liquidity histogram at the right edge of the pane (per pool bin: Lotus pool liquidity in pink,
// SDEX liquidity in blue, the order being built on top). Prices are QUOTE per BASE, the chart's own axis. Dragging is
// handled by PriceChart (pointer events); this layer only draws, extends the autoscale and answers hit tests.

import type {
  AutoscaleInfo,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

/** One pool bin of the histogram: sizes in BASE-equivalent. */
export type DepthBin = { bin: number; price: number; pool: number; sdex: number; mine?: number };
export type RangeHandle = "min" | "max";

export const POOL_COLOR = "#F3B1CE"; // Lotus pink
export const SDEX_COLOR = "#6ea8d8";
const BAND = "rgba(243,177,206,0.07)";
const REF = "rgba(255,255,255,0.45)";
/** px of the pane, from the right edge, taken by the histogram */
export const panelWidth = (paneW: number) => Math.round(Math.max(90, Math.min(200, paneW * 0.2)));
const GRAB_PX = 7;

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export class RangeLayer implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private request: (() => void) | null = null;
  private range: { min: number; max: number } | null = null;
  private ref = 0;
  private bins: DepthBin[] = [];
  private stepBps = 10;
  private active: RangeHandle | null = null;
  private fmt: (p: number) => string = (p) => p.toFixed(4);
  private paneW = 0;
  private readonly views: readonly IPrimitivePaneView[];
  private readonly axis: readonly ISeriesPrimitiveAxisView[];

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (t) => this.draw(t) };
    // under the drawings, over the candles
    this.views = [{ renderer: () => renderer, zOrder: () => "normal" }];
    const tag = (price: () => number | null, back: () => string, text: () => string, color = "#000000"): ISeriesPrimitiveAxisView => ({
      coordinate: () => {
        const p = price();
        return p === null ? -100 : (this.series?.priceToCoordinate(p) ?? -100);
      },
      text,
      textColor: () => color,
      backColor: back,
      visible: () => price() !== null,
      tickVisible: () => true,
    });
    this.axis = [
      tag(() => (this.ref > 0 ? this.ref : null), () => "#525252", () => this.fmt(this.ref), "#ffffff"),
      tag(() => this.range?.min ?? null, () => POOL_COLOR, () => this.fmt(this.range?.min ?? 0)),
      tag(() => this.range?.max ?? null, () => POOL_COLOR, () => this.fmt(this.range?.max ?? 0)),
    ];
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.series = p.series;
    this.request = p.requestUpdate;
  }
  detached() {
    this.series = null;
    this.request = null;
  }
  paneViews() {
    return this.views;
  }
  priceAxisViews() {
    return this.axis;
  }

  set(s: { range?: { min: number; max: number } | null; ref?: number; bins?: DepthBin[]; stepBps?: number; fmt?: (p: number) => string }) {
    if (s.range !== undefined) this.range = s.range;
    if (s.ref !== undefined) this.ref = s.ref;
    if (s.bins !== undefined) this.bins = s.bins;
    if (s.stepBps !== undefined) this.stepBps = s.stepBps;
    if (s.fmt) this.fmt = s.fmt;
    this.request?.();
  }
  setActive(h: RangeHandle | null) {
    if (h === this.active) return;
    this.active = h;
    this.request?.();
  }

  /**
   * The price axis fits the candles (the series' own autoscale), the reference price with a ±1% margin and the two
   * handles. Nothing else: the histogram never stretches the scale, bins outside the visible prices are not drawn.
   */
  autoscaleInfo(): AutoscaleInfo | null {
    const pts: number[] = [];
    if (this.range) pts.push(this.range.min, this.range.max);
    if (this.ref > 0) pts.push(this.ref * 0.99, this.ref * 1.01);
    if (!pts.length) return null;
    return { priceRange: { minValue: Math.min(...pts), maxValue: Math.max(...pts) } };
  }

  private y(p: number): number | null {
    return this.series?.priceToCoordinate(p) ?? null;
  }
  /** the handle under pane y (within a few px), the nearest one if both are close */
  handleAt(y: number): RangeHandle | null {
    if (!this.range) return null;
    const ymin = this.y(this.range.min);
    const ymax = this.y(this.range.max);
    const dmin = ymin === null ? Infinity : Math.abs(ymin - y);
    const dmax = ymax === null ? Infinity : Math.abs(ymax - y);
    if (Math.min(dmin, dmax) > GRAB_PX) return null;
    return dmax <= dmin ? "max" : "min";
  }
  hitTest(_x: number, y: number): PrimitiveHoveredItem | null {
    const h = this.handleAt(y);
    return h ? { cursorStyle: "ns-resize", externalId: `range-${h}`, zOrder: "top", distance: 0, hitTestPriority: 1 } : null;
  }
  /** the histogram bin under pane (x, y): only over the panel and within one bin of a bar */
  binAt(x: number, y: number): DepthBin | null {
    if (!this.paneW || x < this.paneW - panelWidth(this.paneW) || !this.series) return null;
    const p = this.series.coordinateToPrice(y);
    if (p === null || !this.bins.length) return null;
    const d = this.bins.reduce((b, v) => (Math.abs(v.price - p) < Math.abs(b.price - p) ? v : b));
    return Math.abs(d.price / p - 1) <= this.stepBps / 10_000 ? d : null;
  }
  /** pane y of a handle (for tests / automation) */
  handleY(h: RangeHandle): number | null {
    return this.range ? this.y(this.range[h]) : null;
  }

  private draw(target: DrawTarget) {
    if (!this.series) return;
    target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
      const W = mediaSize.width;
      const H = mediaSize.height;
      this.paneW = W;
      const P = panelWidth(W);
      c.save();
      c.font = "10px Inter, -apple-system, sans-serif";
      c.textBaseline = "middle";

      // band between the handles, across the whole pane
      const r = this.range;
      const ymin = r ? this.y(r.min) : null;
      const ymax = r ? this.y(r.max) : null;
      if (ymin !== null && ymax !== null) {
        c.fillStyle = BAND;
        c.fillRect(0, Math.min(ymin, ymax), W, Math.abs(ymin - ymax));
      }

      // histogram panel: backdrop + separator, so it reads as its own column over the candles
      c.fillStyle = "rgba(10,10,10,0.85)";
      c.fillRect(W - P, 0, P, H);
      c.fillStyle = "rgba(255,255,255,0.08)";
      c.fillRect(W - P, 0, 1, H);
      const vis = this.bins
        .map((d) => ({ d, y: this.y(d.price) }))
        .filter((v): v is { d: DepthBin; y: number } => v.y !== null && v.y >= -20 && v.y <= H + 20);
      if (vis.length) {
        const maxTotal = Math.max(1e-9, ...vis.map(({ d }) => d.pool + d.sdex + (d.mine ?? 0)));
        const room = P - 6;
        const w = (v: number) => (v > 0 ? Math.sqrt(v / maxTotal) * room : 0);
        const f = 1 + this.stepBps / 10_000;
        for (const { d, y } of vis) {
          const y2 = this.y(d.price * f);
          const h = Math.max(1.5, Math.min(40, (y2 === null ? 4 : Math.abs(y - y2)) * 0.8));
          const total = w(d.pool + d.sdex);
          const pool = total * (d.pool / Math.max(1e-12, d.pool + d.sdex));
          const inR = r ? d.price >= r.min && d.price <= r.max : false;
          if (pool > 0) {
            c.fillStyle = hexA(POOL_COLOR, inR ? 0.75 : 0.4);
            c.fillRect(W - pool, y - h / 2, pool, h);
          }
          if (total - pool > 0) {
            c.fillStyle = hexA(SDEX_COLOR, inR ? 0.7 : 0.35);
            c.fillRect(W - total, y - h / 2, total - pool, h);
          }
          if (d.mine) {
            const mine = Math.max(3, w(d.pool + d.sdex + d.mine) - total);
            c.fillStyle = hexA(POOL_COLOR, 0.95);
            c.fillRect(W - total - mine, y - h / 2, mine, h);
            c.strokeStyle = "#ffffff";
            c.lineWidth = 1;
            c.strokeRect(W - total - mine + 0.5, y - h / 2 + 0.5, Math.max(0, mine - 1), Math.max(0, h - 1));
          }
        }
      }

      // reference price
      if (this.ref > 0) {
        const y = this.y(this.ref);
        if (y !== null) {
          c.strokeStyle = REF;
          c.lineWidth = 1;
          c.setLineDash([2, 3]);
          line(c, 0, y, W, y);
          c.setLineDash([]);
          c.fillStyle = REF;
          c.textAlign = "right";
          c.fillText("reference", W - P - 6, y - 7);
        }
      }

      // handles: line + grip pill just left of the histogram
      if (r)
        for (const k of ["max", "min"] as const) {
          const y = k === "min" ? ymin : ymax;
          if (y === null) continue;
          const on = this.active === k;
          c.strokeStyle = POOL_COLOR;
          c.lineWidth = on ? 2 : 1;
          line(c, 0, y, W, y);
          const label = `${k === "min" ? "Min" : "Max"} ${this.fmt(r[k])}`;
          c.font = "600 10px Inter, -apple-system, sans-serif";
          const tw = c.measureText(label).width + 22;
          const x = W - P - tw - 6;
          c.fillStyle = on ? POOL_COLOR : "#161616";
          roundRect(c, x, y - 9, tw, 18, 4);
          c.fill();
          c.strokeStyle = POOL_COLOR;
          c.lineWidth = 1;
          c.stroke();
          c.fillStyle = on ? "#000000" : POOL_COLOR;
          c.textAlign = "left";
          c.fillText("⇕", x + 5, y + 0.5);
          c.fillText(label, x + 16, y + 0.5);
        }
      c.restore();
    });
  }
}

function line(c: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
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
