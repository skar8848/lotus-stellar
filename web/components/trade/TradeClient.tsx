"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AssetLink, Dot, Empty, ExplorerLink, Segmented } from "@/components/common";
import { useAccount } from "@/lib/account";
import { bestPrices, depthBars, midPrice } from "@/lib/book";
import { useConfig } from "@/lib/config-context";
import { usePolling } from "@/lib/hooks";
import { buildMarkets, pickMarket } from "@/lib/markets";
import { fetchCandles, fetchOffers, fetchOrderBook, fetchTrades, fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { DepthChart, OrderBookTable, RecentTrades } from "./BookPanels";
import type { PricePick } from "./LimitTab";
import { OpenOffers } from "./OpenOffers";
import { OrderPanel, type OrderTab } from "./OrderPanel";
import { PriceChart } from "./PriceChart";
import { computeRange, effective, initialRangeForm, type RangeForm } from "./rangeState";

const TFS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
  { label: "1h", ms: 3_600_000 },
] as const;

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
  const [slippage, setSlippage] = useState(0.5);
  const [pick, setPick] = useState<PricePick>(null);
  const [form, setForm] = useState<RangeForm>(initialRangeForm);

  const base = market?.base ?? config.rwa;
  const quote = market?.quote ?? config.receipt;
  const ready = !!market && !!base.issuer && !!quote.issuer;
  const horizon = config.horizon;

  const bookFn = useCallback(() => fetchOrderBook(horizon, base, quote, 30), [horizon, base, quote]);
  const book = usePolling(bookFn, 5000, ready);
  const tradesFn = useCallback(() => fetchTrades(horizon, base, quote, 30), [horizon, base, quote]);
  const trades = usePolling(tradesFn, 10000, ready);
  const candlesFn = useCallback(() => fetchCandles(horizon, base, quote, TFS[tfIdx].ms, 200), [horizon, base, quote, tfIdx]);
  const candles = usePolling(candlesFn, 20000, ready);
  const offersFn = useCallback(() => (wallet.address ? fetchOffers(horizon, wallet.address) : Promise.resolve([])), [horizon, wallet.address]);
  const offers = usePolling(offersFn, 8000, !!wallet.address);

  const bk = book.data;
  const { bid, ask } = bestPrices(bk);
  const last = trades.data?.[0]?.price ?? null;
  const mid = midPrice(bk);
  const refPrice = mid ?? last ?? 1;

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

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-5 sm:px-6" data-market={market.id}>
      {/* market header */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight" data-testid="market-title">
              {market.label}
            </h1>
            <Segmented
              value={market.id}
              onChange={setMarket}
              size="sm"
              className="w-auto"
              testId="market-select"
              options={markets.map((m) => ({ value: m.id, label: m.label, title: m.blurb }))}
            />
          </div>
          <p className="mt-1 max-w-2xl text-xs text-mutedfg">{market.blurb}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs" data-testid="market-stats">
          <Stat k="Last" v={last !== null ? fmt(last, 4, 4) : "-"} />
          <Stat k="Mid" v={mid !== null ? fmt(mid, 4, 4) : "-"} />
          <Stat k="Bid" v={bid !== null ? fmt(bid, 4, 4) : "-"} className="text-green" />
          <Stat k="Ask" v={ask !== null ? fmt(ask, 4, 4) : "-"} className="text-red" />
          <span className="flex items-center gap-1.5 text-mutedfg">
            <Dot ok={book.error ? false : book.data ? true : null} pulse={book.loading} />
            {book.error ? "offline" : "live"}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_440px]">
        {/* chart */}
        <section className="card min-w-0 p-4 sm:p-5 lg:col-start-1 lg:row-start-1" data-testid="chart-card">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {market.base.code} <span className="text-mutedfg">/ {market.quote.code}</span>
              <span className="hidden text-[11px] font-normal text-mutedfg sm:inline">
                <AssetLink asset={market.base} label="base" /> · <AssetLink asset={market.quote} label="quote" />
              </span>
            </div>
            <div className="flex items-center gap-1">
              {TFS.map((t, i) => (
                <button
                  key={t.label}
                  onClick={() => setTfIdx(i)}
                  data-testid={`tf-${t.label}`}
                  className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition", tfIdx === i ? "bg-white/10 text-white" : "text-mutedfg hover:text-white")}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3">
            <PriceChart
              candles={candles.data ?? []}
              line={line}
              depth={depth}
              range={rangeLine}
              bins={bins}
              refPrice={refPrice}
              onRangeChange={tab === "range" ? onRangeDrag : undefined}
              onRecenter={tab === "range" ? recenter : undefined}
              height={380}
            />
          </div>
          <p className="mt-2 text-[11px] text-mutedfg">
            {tab === "range"
              ? "Drag the Start / End handles to set your range; the dashed lines are the levels that will be quoted. Bars at right: current book (pink = inside your range)."
              : "Candles come from Horizon trade aggregations (only periods with trades exist). Bars at right: cumulative depth, bids green and asks red."}
            {candles.error ? <span className="text-destructive"> Candles unavailable: {candles.error}</span> : null}
          </p>
        </section>

        {/* order panel */}
        <aside className="min-w-0 lg:col-start-2 lg:row-span-3 lg:row-start-1">
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

        {/* book + trades */}
        <div className="grid min-w-0 gap-4 md:grid-cols-2 lg:col-start-1 lg:row-start-2">
          <section className="card p-4 sm:p-5">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Order book</h2>
              <span className="text-[11px] text-mutedfg">refreshes every 5s</span>
            </div>
            {book.error ? <p className="mb-2 text-xs text-destructive">{book.error}</p> : null}
            <OrderBookTable
              book={bk}
              baseCode={market.base.code}
              quoteCode={market.quote.code}
              onPick={(price) => {
                setPick({ price, nonce: Date.now() });
                setTab("limit");
              }}
            />
          </section>
          <section className="card p-4 sm:p-5">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Recent trades</h2>
              <span className="text-[11px] text-mutedfg">green = base bought</span>
            </div>
            <RecentTrades trades={trades.data} horizon={horizon} baseCode={market.base.code} quoteCode={market.quote.code} network={config.network} />
            {trades.error ? <p className="mt-2 text-xs text-destructive">{trades.error}</p> : null}
          </section>
        </div>

        {/* depth */}
        <section className="card min-w-0 p-4 sm:p-5 lg:col-start-1 lg:row-start-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Cumulative depth</h2>
            <span className="text-[11px] text-mutedfg">
              {market.base.code} vs {market.quote.code}
            </span>
          </div>
          <DepthChart book={bk} />
        </section>
      </div>

      <div className="mt-4">
        <OpenOffers markets={markets} market={market} offers={offers} onChanged={onDone} />
      </div>

      <p className="mt-4 text-[11px] text-mutedfg">
        Testnet. Issuer of {market.base.code}: {market.base.issuer ? <ExplorerLink kind="account" id={market.base.issuer} network={config.network} /> : "-"} · receipt issuer:{" "}
        {market.receipt.issuer ? <ExplorerLink kind="account" id={market.receipt.issuer} network={config.network} /> : "-"}
      </p>
    </main>
  );
}

function Stat({ k, v, className }: { k: string; v: string; className?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="label">{k}</span>
      <span className={cn("num text-sm font-medium", className)}>{v}</span>
    </span>
  );
}
