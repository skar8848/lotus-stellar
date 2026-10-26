"use client";

// /trade: classic exchange layout on the Stellar DEX.
//   desktop: [market bar] / [chart | order book + trades] / [bottom tabs], order entry in a full-height right column
//   mobile : everything stacked (market bar, chart, order entry, book, bottom tabs)
// Every action is a wallet-signed Stellar transaction (no session keys, no auto-sign).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AssetLink, Empty, ExplorerLink } from "@/components/common";
import { useAccount } from "@/lib/account";
import { bestPrices, groupAccountTrades, midPrice } from "@/lib/book";
import { useConfig } from "@/lib/config-context";
import { usePolling } from "@/lib/hooks";
import { buildMarkets, pickMarket } from "@/lib/markets";
import { assetKey, fetchAccountTrades, fetchCandles, fetchOffers, fetchOrderBook, fetchTrades, toAssetRef } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { DepthChart, OrderBookTable, RecentTrades } from "./BookPanels";
import { BottomPanel } from "./BottomPanel";
import type { PricePick } from "./LimitTab";
import { MarketBar, dayStats } from "./MarketBar";
import { OrderPanel, type OrderTab } from "./OrderPanel";
import { PriceChart } from "./PriceChart";

const TFS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
  { label: "1h", ms: 3_600_000 },
  { label: "1D", ms: 86_400_000 },
  { label: "1W", ms: 604_800_000 },
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

/** `remountKey`: the element is conditionally rendered, re-observe when it changes. */
function useElementHeight(ref: React.RefObject<HTMLElement | null>, remountKey?: unknown): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setH(Math.floor(entries[0].contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, remountKey]);
  return h;
}

export function TradeClient() {
  const config = useConfig();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wallet = useWallet();
  const acct = useAccount();

  const markets = useMemo(() => buildMarkets(config, { activeOnly: true }), [config]);
  const market = pickMarket(markets, params.get("market"));

  const [tab, setTab] = useState<OrderTab>("swap");
  const [tfIdx, setTfIdx] = useState(2);
  const [view, setView] = useState<"price" | "depth">("price");
  const [midTab, setMidTab] = useState<"book" | "trades">("book");
  const [slippage, setSlippage] = useState(0.5);
  const [pick, setPick] = useState<PricePick>(null);

  const desktop = useIsDesktop();
  const mainRef = useRef<HTMLElement>(null);
  const fill = useFillHeight(mainRef, desktop);
  const chartBox = useRef<HTMLDivElement>(null);
  const chartH = useElementHeight(chartBox, view);

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
  // price levels of my own offers on this market (asks sell the base; bids sell the quote, price inverted)
  const myLevels = useMemo(() => {
    const out = { ask: [] as number[], bid: [] as number[] };
    if (!market) return out;
    for (const o of offers.data ?? []) {
      const sell = assetKey(toAssetRef(o.selling));
      const buy = assetKey(toAssetRef(o.buying));
      const p = Number(o.price);
      if (sell === assetKey(market.base) && buy === assetKey(market.quote)) out.ask.push(p);
      else if (sell === assetKey(market.quote) && buy === assetKey(market.base) && p > 0) out.bid.push(1 / p);
    }
    return out;
  }, [offers.data, market]);
  // the connected account's fills, one row per operation (a routed swap is one row): bottom Trade history,
  // and its routed swaps of this market are merged into the Trades tab
  const me = wallet.address;
  const myTradesFn = useCallback(() => (me ? fetchAccountTrades(horizon, me, 100) : Promise.resolve([])), [horizon, me]);
  const myTrades = usePolling(myTradesFn, 15000, !!me);
  const fills = useMemo(() => (me && myTrades.data ? groupAccountTrades(myTrades.data, me, markets) : null), [myTrades.data, me, markets]);
  const myRouted = useMemo(() => (fills ?? []).filter((f) => f.routed && f.marketId === market?.id), [fills, market?.id]);

  const bk = book.data;
  const { bid, ask } = bestPrices(bk);
  const last = trades.data?.[0]?.price ?? null;
  const mid = midPrice(bk);
  const day = useMemo(() => dayStats(dayCandles.data, last), [dayCandles.data, last]);

  const setMarket = (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("market", id);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    setPick(null);
  };

  const onDone = () => {
    book.refresh();
    trades.refresh();
    candles.refresh();
    dayCandles.refresh();
    offers.refresh();
    myTrades.refresh();
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
      fills={fills}
      fillsError={myTrades.error}
      onChanged={onDone}
      resizable={desktop}
      // keep at least ~300px for the chart row
      maxHeight={fill ? Math.max(140, fill - 48 - 300) : 600}
    />
  );

  const viewTabs = (["price", "depth"] as const).map((v) => (
    <button
      key={v}
      type="button"
      onClick={() => setView(v)}
      data-testid={`view-${v}`}
      className={cn(
        "h-9 shrink-0 border-b-2 px-2.5 text-xs font-medium transition-colors",
        view === v ? "border-primary text-foreground" : "border-transparent text-mutedfg hover:text-foreground",
      )}
    >
      {v === "price" ? "Chart" : "Depth"}
    </button>
  ));

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
          info={
            <>
              <AssetLink asset={market.base} network={config.network} className="text-[11px]" /> / <AssetLink asset={market.quote} network={config.network} className="text-[11px]" />
              <span>· {market.base.code} issuer</span>
              {market.base.issuer ? <ExplorerLink kind="account" id={market.base.issuer} network={config.network} className="text-[11px]" /> : "-"}
              {market.quote.issuer && market.quote.issuer !== market.base.issuer ? (
                <>
                  <span>· {market.quote.code} issuer</span>
                  <ExplorerLink kind="account" id={market.quote.issuer} network={config.network} className="text-[11px]" />
                </>
              ) : null}
            </>
          }
        />

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* chart */}
          <section className="flex min-w-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r" data-testid="chart-card">
            <div className="flex h-[380px] min-h-0 flex-col md:h-[460px] lg:h-auto lg:flex-1">
              {view === "price" ? (
                <PriceChart
                  className="h-full"
                  candles={candles.data}
                  timeframes={TFS}
                  tfIdx={tfIdx}
                  onTf={setTfIdx}
                  resetKey={`${market.id}:${TFS[tfIdx].label}`}
                  marketLabel={market.label}
                  marketId={market.id}
                  baseCode={market.base.code}
                  headerLeft={viewTabs}
                />
              ) : (
                <>
                  <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-1.5">
                    <div className="flex items-center">{viewTabs}</div>
                    <span className="text-[11px] text-mutedfg">
                      {market.base.code} vs {market.quote.code}
                    </span>
                  </div>
                  <div ref={chartBox} className="flex min-h-0 flex-1 flex-col justify-center px-4 py-3">
                    <DepthChart book={bk} height={Math.max(140, chartH - 30)} baseCode={market.base.code} quoteCode={market.quote.code} />
                  </div>
                </>
              )}
            </div>
          </section>

          {/* order book / trades */}
          <section className="flex h-[380px] w-full shrink-0 flex-col md:h-auto md:w-[260px] xl:w-[290px]" data-testid="book-card">
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
                  mine={myLevels}
                  baseCode={market.base.code}
                  quoteCode={market.quote.code}
                  onPick={(price) => {
                    setPick({ price, nonce: Date.now() });
                    setTab("limit");
                  }}
                />
              ) : (
                <div className="h-full overflow-auto scroll-thin">
                  <RecentTrades trades={trades.data} routed={myRouted} horizon={horizon} baseCode={market.base.code} quoteCode={market.quote.code} network={config.network} />
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
          onDone={onDone}
        />
      </aside>

      {desktop ? null : bottom}
    </main>
  );
}
