"use client";

// /trade: classic exchange layout on the Stellar DEX.
//   desktop: [market bar] / [chart | order book + trades] / [bottom tabs], order entry in a full-height right column
//   mobile : everything stacked (market bar, chart, order entry, book, bottom tabs)
// Every action is a wallet-signed Stellar transaction (no session keys, no auto-sign).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AssetLink, Empty, ExplorerLink } from "@/components/common";
import { useAccount } from "@/lib/account";
import { bestPrices, depthBars, midPrice } from "@/lib/book";
import { useConfig } from "@/lib/config-context";
import { usePolling } from "@/lib/hooks";
import { buildMarkets, pickMarket } from "@/lib/markets";
import { fetchCandles, fetchOffers, fetchOrderBook, fetchTrades } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { DepthChart, OrderBookTable, RecentTrades } from "./BookPanels";
import { BottomPanel } from "./BottomPanel";
import type { PricePick } from "./LimitTab";
import { MarketBar, dayStats } from "./MarketBar";
import { OrderPanel, type OrderTab } from "./OrderPanel";
import { PriceChart } from "./PriceChart";
import { computeRange, effective, initialRangeForm, type RangeForm } from "./rangeState";

const TFS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
  { label: "1h", ms: 3_600_000 },
] as const;

const LG = "(min-width: 1024px)";
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(LG);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(LG).matches,
    () => true,
  );
}

/** Height left under the sticky nav (desktop layout fills the viewport, like a trading terminal). */
function useFillHeight(ref: React.RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const calc = () => {
      const el = ref.current;
      if (!el) return;
      setH(Math.max(560, window.innerHeight - el.offsetTop));
    };
    calc();
    window.addEventListener("resize", calc);
    // banners above the terminal (e.g. a hint under the nav) can appear after mount and move it down
    const ro = new ResizeObserver(calc);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("resize", calc);
      ro.disconnect();
    };
  }, [ref, enabled]);
  return enabled ? h : null;
}

function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setH(Math.floor(entries[0].contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

export function TradeClient() {
  const config = useConfig();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wallet = useWallet();
  const acct = useAccount();

  const markets = useMemo(() => buildMarkets(config), [config]);
  const market = pickMarket(markets, params.get("market"));

  const [tab, setTab] = useState<OrderTab>("swap");
  const [tfIdx, setTfIdx] = useState(2);
  const [view, setView] = useState<"price" | "depth">("price");
  const [midTab, setMidTab] = useState<"book" | "trades">("book");
  const [slippage, setSlippage] = useState(0.5);
  const [pick, setPick] = useState<PricePick>(null);
  const [form, setForm] = useState<RangeForm>(initialRangeForm);

  const desktop = useIsDesktop();
  const mainRef = useRef<HTMLElement>(null);
  const fill = useFillHeight(mainRef, desktop);
  const chartBox = useRef<HTMLDivElement>(null);
  const chartH = useElementHeight(chartBox);

  const base = market?.base ?? config.rwa;
  const quote = market?.quote ?? config.receipt;
  const ready = !!market && !!base.issuer && !!quote.issuer;
  const horizon = config.horizon;

  const bookFn = useCallback(() => fetchOrderBook(horizon, base, quote, 50), [horizon, base, quote]);
  const book = usePolling(bookFn, 5000, ready);
  const tradesFn = useCallback(() => fetchTrades(horizon, base, quote, 40), [horizon, base, quote]);
  const trades = usePolling(tradesFn, 10000, ready);
  const candlesFn = useCallback(() => fetchCandles(horizon, base, quote, TFS[tfIdx].ms, 200), [horizon, base, quote, tfIdx]);
  const candles = usePolling(candlesFn, 20000, ready);
  const dayFn = useCallback(() => fetchCandles(horizon, base, quote, 3_600_000, 48), [horizon, base, quote]);
  const dayCandles = usePolling(dayFn, 60000, ready);
  const offersFn = useCallback(() => (wallet.address ? fetchOffers(horizon, wallet.address) : Promise.resolve([])), [horizon, wallet.address]);
  const offers = usePolling(offersFn, 8000, !!wallet.address);

  const bk = book.data;
  const { bid, ask } = bestPrices(bk);
  const last = trades.data?.[0]?.price ?? null;
  const mid = midPrice(bk);
  const refPrice = mid ?? last ?? 1;
  const day = useMemo(() => dayStats(dayCandles.data, last), [dayCandles.data, last]);

  const rangeResult = useMemo(() => computeRange(form, refPrice), [form, refPrice]);
  const eff = effective(form, refPrice);
  const rangeLine = tab === "range" && Number(eff.from) > 0 && Number(eff.to) > 0 ? { start: Number(eff.from), end: Number(eff.to) } : null;
  const bins = tab === "range" ? rangeResult.levels.map((l) => Number(l.price)) : [];

  const depth = useMemo(() => depthBars(bk), [bk]);
  // line fallback: one point per second (lightweight-charts needs strictly ascending, unique times)
  const line = useMemo(() => {
    const byTime = new Map<number, number>();
    for (const t of [...(trades.data ?? [])].reverse()) {
      const time = Math.floor(new Date(t.time).getTime() / 1000);
      if (Number.isFinite(t.price) && Number.isFinite(time)) byTime.set(time, t.price);
    }
    return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }, [trades.data]);

  const setMarket = (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("market", id);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    setForm(initialRangeForm);
    setPick(null);
  };

  const onRangeDrag = (which: "start" | "end", price: number) =>
    setForm((f) => ({ ...f, [which === "start" ? "from" : "to"]: String(Number(price.toFixed(4))) }));
  const recenter = () => setForm((f) => ({ ...f, from: null, to: null, split: null }));

  const onDone = () => {
    book.refresh();
    trades.refresh();
    candles.refresh();
    dayCandles.refresh();
    offers.refresh();
    acct.refresh();
  };

  if (!market) {
    return (
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-6 sm:px-6">
        <div className="card p-6">
          <Empty>No market is configured yet: the receipt or the bond asset is not deployed. Check deployments/testnet.contract.json and testnet.classic.json.</Empty>
        </div>
      </main>
    );
  }

  const bottom = (
    <BottomPanel
      markets={markets}
      market={market}
      offers={offers}
      onChanged={onDone}
      resizable={desktop}
      // keep at least ~300px for the chart row
      maxHeight={fill ? Math.max(140, fill - 48 - 300) : 600}
    />
  );

  return (
    <main
      ref={mainRef}
      className="flex w-full min-w-0 flex-1 flex-col bg-background lg:flex-none lg:flex-row lg:overflow-hidden"
      style={desktop && fill ? { height: fill } : undefined}
      data-market={market.id}
      data-testid="trade-terminal"
    >
      {/* left: market bar + chart / book + bottom tabs */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MarketBar
          markets={markets}
          market={market}
          onSelect={setMarket}
          last={last}
          mid={mid}
          bid={bid}
          ask={ask}
          day={day}
          live={book.error ? false : book.data ? true : null}
          loading={book.loading}
        />

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* chart */}
          <section className="flex min-w-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r" data-testid="chart-card">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1">
              <div className="flex items-center gap-0.5">
                {(["price", "depth"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    data-testid={`view-${v}`}
                    className={cn(
                      "border-b-2 px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                      view === v ? "border-primary text-foreground" : "border-transparent text-mutedfg hover:text-foreground",
                    )}
                  >
                    {v === "price" ? "Chart" : "Depth"}
                  </button>
                ))}
              </div>
              {view === "price" ? (
                <div className="flex items-center gap-0.5">
                  {TFS.map((t, i) => (
                    <button
                      key={t.label}
                      type="button"
                      onClick={() => setTfIdx(i)}
                      data-testid={`tf-${t.label}`}
                      className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition", tfIdx === i ? "bg-white/10 text-foreground" : "text-mutedfg hover:text-foreground")}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-[11px] text-mutedfg">
                  {market.base.code} vs {market.quote.code}
                </span>
              )}
            </div>
            <div ref={chartBox} className="relative h-[340px] min-h-0 md:h-[420px] lg:h-auto lg:flex-1">
              {view === "price" ? (
                <PriceChart
                  candles={candles.data ?? []}
                  line={line}
                  depth={depth}
                  range={rangeLine}
                  bins={bins}
                  refPrice={refPrice}
                  onRangeChange={tab === "range" ? onRangeDrag : undefined}
                  onRecenter={tab === "range" ? recenter : undefined}
                  height={Math.max(200, chartH)}
                />
              ) : (
                <div className="flex h-full flex-col justify-center px-4 py-3">
                  <DepthChart book={bk} height={Math.max(140, chartH - 50)} />
                </div>
              )}
            </div>
            <p className="shrink-0 truncate border-t border-border px-3 py-1 text-[10px] text-mutedfg" title={tab === "range" ? "Drag the Start / End handles to set your range" : undefined}>
              {tab === "range"
                ? "Drag the Start / End handles to set your range; dashed lines are the levels to quote. Bars at right: the book (pink = inside your range)."
                : "Candles: Horizon trade aggregations (periods with trades only). Bars at right: cumulative depth."}
              {candles.error ? <span className="text-destructive"> Candles unavailable: {candles.error}</span> : null}
              <span className="hidden lg:inline">
                {" "}
                · <AssetLink asset={market.base} network={config.network} className="text-[10px]" /> / <AssetLink asset={market.quote} network={config.network} className="text-[10px]" />
              </span>
              <span className="hidden xl:inline">
                {" "}
                · Issuer of {market.base.code}: {market.base.issuer ? <ExplorerLink kind="account" id={market.base.issuer} network={config.network} className="text-[10px]" /> : "-"} · receipt issuer:{" "}
                {market.receipt.issuer ? <ExplorerLink kind="account" id={market.receipt.issuer} network={config.network} className="text-[10px]" /> : "-"}
              </span>
            </p>
          </section>

          {/* order book / trades */}
          <section className="flex h-[380px] w-full shrink-0 flex-col md:h-auto md:w-[250px] xl:w-[280px]" data-testid="book-card">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2">
              {(
                [
                  { id: "book", label: "Order book" },
                  { id: "trades", label: "Trades" },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setMidTab(t.id)}
                  data-testid={`mid-tab-${t.id}`}
                  className={cn(
                    "border-b-2 px-2.5 py-2 text-xs font-medium transition-colors",
                    midTab === t.id ? "border-primary text-foreground" : "border-transparent text-mutedfg hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
              <span className="ml-auto pr-1 text-[10px] text-mutedfg">price in {market.quote.code}</span>
            </div>
            {book.error && midTab === "book" ? <p className="shrink-0 px-3 py-1 text-[11px] text-destructive">{book.error}</p> : null}
            <div className="min-h-0 flex-1 overflow-hidden">
              {midTab === "book" ? (
                <OrderBookTable
                  book={bk}
                  baseCode={market.base.code}
                  quoteCode={market.quote.code}
                  onPick={(price) => {
                    setPick({ price, nonce: Date.now() });
                    setTab("limit");
                  }}
                />
              ) : (
                <div className="h-full overflow-auto scroll-thin">
                  <RecentTrades trades={trades.data} horizon={horizon} baseCode={market.base.code} quoteCode={market.quote.code} network={config.network} />
                  {trades.error ? <p className="px-3 py-1 text-[11px] text-destructive">{trades.error}</p> : null}
                </div>
              )}
            </div>
          </section>
        </div>

        {desktop ? bottom : null}
      </div>

      {/* right: order entry, full height */}
      <aside className="w-full shrink-0 border-t border-border bg-card lg:w-[320px] lg:overflow-y-auto lg:border-l lg:border-t-0 scroll-thin" data-testid="order-column">
        <OrderPanel
          market={market}
          book={bk}
          tab={tab}
          onTab={setTab}
          slippage={slippage}
          onSlippage={setSlippage}
          pick={pick}
          form={form}
          setForm={setForm}
          rangeResult={rangeResult}
          refPrice={refPrice}
          onDone={onDone}
        />
      </aside>

      {desktop ? null : bottom}
    </main>
  );
}
