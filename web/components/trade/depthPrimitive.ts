import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  ISeriesApi,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export type DepthBar = { price: number; depth: number; side?: "bid" | "ask"; size?: number; cum?: number };

// Ported from lotus-main (components/app/depthPrimitive.ts): a liquidity-depth histogram drawn on the
// candlestick's own canvas, positioned with series.priceToCoordinate() so it shares the price axis.
// The pink bars are the part of the book inside the range you are about to quote; bids/asks are tinted.
const IN_BAND = "rgba(243, 177, 206,0.92)";
const BID = "rgba(2,199,123,0.45)";
const ASK = "rgba(235,54,90,0.45)";
const BID_HOT = "rgba(2,199,123,1)";
const ASK_HOT = "rgba(235,54,90,1)";
const NEUTRAL = "rgba(110,140,165,0.28)";
const PANEL_BG = "#0a0a0a";
const PANEL_BORDER = "rgba(255,255,255,0.12)";
export const PANEL_FRAC = 0; // depth panel hidden on the price chart (the order book shows it); was 0.2

export class DepthPrimitive implements ISeriesPrimitive {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private depth: DepthBar[] = [];
  private band: { low: number; high: number } | null = null;
  private hover: number | null = null;
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
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
  setData(depth: DepthBar[], band: { low: number; high: number } | null) {
    this.depth = depth;
    this.band = band;
    this.requestUpdate?.();
  }
  setHover(price: number | null) {
    if (price === this.hover) return;
    this.hover = price;
    this.requestUpdate?.();
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  private draw(target: CanvasRenderingTarget2D) {
    const series = this.series;
    if (!series || this.depth.length === 0) return;
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

      const span = panelW - pad - minW;
      for (const d of this.depth) {
        const yMedia = series.priceToCoordinate(d.price);
        if (yMedia === null) continue;
        const w = minW + Math.sqrt(Math.max(0, Math.min(1, d.depth))) * span;
        const y = yMedia * vpr - barH / 2;
        const inBand = this.band !== null && d.price >= this.band.low && d.price <= this.band.high;
        const hot = this.hover !== null && d.price === this.hover;
        ctx.fillStyle = hot ? (d.side === "bid" ? BID_HOT : d.side === "ask" ? ASK_HOT : IN_BAND) : inBand ? IN_BAND : d.side === "bid" ? BID : d.side === "ask" ? ASK : NEUTRAL;
        ctx.fillRect(W - w, hot ? y - vpr : y, w, hot ? barH + 2 * vpr : barH);
      }
    });
  }
}
