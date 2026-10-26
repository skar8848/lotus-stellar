// Liquidity histogram of the Pro range chart, ported from the previous front (owl/web components/app/depthPrimitive.ts):
// drawn on the candlestick series' own canvas, each bar placed with series.priceToCoordinate(), so it sits on the same
// price axis as the candles and follows every zoom / scroll / autoscale. It lives in an opaque panel pinned to the
// right 20% of the pane (the candles visually stop at its left edge, a thin separator marks it). Bars grow leftward,
// sqrt-scaled; bars inside the selected range are pink. One bar per pool bin: Lotus pool + SDEX liquidity, the pool
// share drawn slightly brighter than the SDEX share (same hue), sizes in BASE-equivalent.

import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

/** One pool bin of the histogram: sizes in BASE-equivalent. */
export type DepthBin = { bin: number; price: number; pool: number; sdex: number; mine?: number };

/** right share of the pane taken by the histogram (the range handles stop at its left edge) */
export const PANEL_FRAC = 0.2;
export const IN_POOL = "rgba(243,177,206,0.92)"; // inside the range: bright Lotus pink (lotus-main IN_BAND)
export const IN_SDEX = "rgba(243,177,206,0.55)";
export const OUT_POOL = "rgba(150,172,192,0.4)"; // outside: dimmed grey (lotus-main OUT_BAND, pool a bit brighter)
export const OUT_SDEX = "rgba(110,140,165,0.22)";
const PANEL_BG = "#0a0a0a";
const PANEL_BORDER = "rgba(255,255,255,0.12)";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export class DepthPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private depth: DepthBin[] = [];
  private band: { low: number; high: number } | null = null;
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (t) => this.draw(t) };
    this.view = { zOrder: () => "top" as PrimitivePaneViewZOrder, renderer: () => renderer };
  }

  attached(p: SeriesAttachedParameter<Time, SeriesType>) {
    this.series = p.series as ISeriesApi<SeriesType>;
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.series = null;
    this.requestUpdate = undefined;
  }
  setData(depth: DepthBin[], band: { low: number; high: number } | null) {
    this.depth = depth;
    this.band = band;
    this.requestUpdate?.();
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  private draw(target: DrawTarget) {
    const series = this.series;
    if (!series) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const { horizontalPixelRatio: hpr, verticalPixelRatio: vpr } = scope;
      const W = scope.bitmapSize.width;
      const H = scope.bitmapSize.height;
      const panelW = scope.mediaSize.width * PANEL_FRAC * hpr;
      const panelX = W - panelW;
      const pad = 6 * hpr;
      const minW = 6 * hpr;
      const barH = Math.max(1, 4 * vpr);

      ctx.fillStyle = PANEL_BG;
      ctx.fillRect(panelX, 0, panelW, H);
      ctx.fillStyle = PANEL_BORDER;
      ctx.fillRect(panelX, 0, Math.max(1, hpr), H);

      // only the bins on screen, normalised to the largest one on screen
      const vis: { d: DepthBin; y: number }[] = [];
      for (const d of this.depth) {
        if (d.pool + d.sdex <= 0) continue;
        const y = series.priceToCoordinate(d.price);
        if (y === null || y < -4 || y > scope.mediaSize.height + 4) continue;
        vis.push({ d, y });
      }
      if (!vis.length) return;
      const max = Math.max(1e-12, ...vis.map(({ d }) => d.pool + d.sdex));
      const span = panelW - pad - minW;
      for (const { d, y: yMedia } of vis) {
        const total = d.pool + d.sdex;
        const w = minW + Math.sqrt(Math.min(1, total / max)) * span;
        const poolW = w * (d.pool / total);
        const y = yMedia * vpr - barH / 2;
        const inBand = this.band !== null && d.price >= this.band.low && d.price <= this.band.high;
        if (poolW > 0) {
          ctx.fillStyle = inBand ? IN_POOL : OUT_POOL;
          ctx.fillRect(W - poolW, y, poolW, barH);
        }
        if (w - poolW > 0) {
          ctx.fillStyle = inBand ? IN_SDEX : OUT_SDEX;
          ctx.fillRect(W - w, y, w - poolW, barH);
        }
      }
    });
  }
}
