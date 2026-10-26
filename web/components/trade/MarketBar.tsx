"use client";

// Top bar of the exchange layout: market selector (dropdown) + live stats of the selected SDEX book.

import type React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import type { Market } from "@/lib/markets";
import { fmt, type Candle } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { Dot, TokenIcon } from "@/components/common";

const KIND_TAG: Record<Market["kind"], { label: string; cls: string; title: (m: Market) => string }> = {
  bond: { label: "earns", cls: "bg-primary/10 text-primary", title: (m) => `Quoted in ${m.quote.code}, the Lotus receipt: what waits in an offer keeps earning` },
  peg: { label: "peg", cls: "bg-white/5 text-mutedfg", title: (m) => `The Lotus receipt ${m.base.code} priced in ${m.quote.code}, redeemable 1:1 in the vault` },
  cash: { label: "no yield", cls: "bg-white/5 text-mutedfg", title: (m) => `Quoted in plain ${m.quote.code}: nothing earns while an order waits` },
};

function PairIcons({ m, size = 22 }: { m: Market; size?: number }) {
  return (
    <span className="relative flex shrink-0 items-center" style={{ width: size * 1.6, height: size }}>
      <span className="relative z-10 flex rounded-full ring-2 ring-card">
        <TokenIcon code={m.base.code} size={size} />
      </span>
      <span className="absolute top-0 flex" style={{ left: size * 0.6 }}>
        <TokenIcon code={m.quote.code} size={size} />
      </span>
    </span>
  );
}

export function MarketSelector({ markets, market, onSelect }: { markets: Market[]; market: Market; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // the menu is portalled to <body> (position: fixed under the button) so no overflow container can clip it
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(352, window.innerWidth - 16);
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: r.bottom + 4 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const tag = KIND_TAG[market.kind];

  return (
    <div className="relative" ref={ref} data-testid="market-select" data-value={market.id}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary"
        data-testid="market-title"
      >
        <PairIcons m={market} />
        <span className="text-sm font-semibold">{market.label}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", tag.cls)} title={tag.title(market)}>
          {tag.label}
        </span>
        <ChevronDown className={cn("size-4 text-mutedfg transition-transform", open && "rotate-180")} />
      </button>
      {open && pos
        ? createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100] w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
          style={{ left: pos.left, top: pos.top }}
          data-testid="market-menu"
          role="listbox"
        >
          <div className="border-b border-border px-4 py-2 text-xs font-medium text-mutedfg">SDEX markets ({markets.length})</div>
          <div className="max-h-[min(28rem,70vh)] overflow-y-auto scroll-thin">
            {markets.map((m) => {
              const t = KIND_TAG[m.kind];
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={m.id === market.id}
                  data-value={m.id}
                  data-testid={`market-option-${m.id}`}
                  onClick={() => {
                    onSelect(m.id);
                    setOpen(false);
                  }}
                  className={cn("flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary", m.id === market.id && "bg-secondary")}
                >
                  <span className="mt-0.5">
                    <PairIcons m={m} size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{m.label}</span>
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", t.cls)} title={t.title(m)}>
                        {t.label}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-mutedfg">{m.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export type DayStats = { change: number | null; high: number | null; low: number | null; volume: number | null; trades: number };

/** 24h figures from 1h trade aggregations (only buckets with trades exist). */
export function dayStats(candles: Candle[] | null, last: number | null): DayStats {
  if (!candles) return { change: null, high: null, low: null, volume: null, trades: 0 };
  const since = Date.now() / 1000 - 86400;
  const day = candles.filter((c) => c.time >= since - 3600);
  if (day.length === 0) return { change: null, high: null, low: null, volume: 0, trades: 0 };
  const open = day[0].open;
  const close = last ?? day[day.length - 1].close;
  return {
    change: open > 0 ? (close / open - 1) * 100 : null,
    high: Math.max(...day.map((c) => c.high)),
    low: Math.min(...day.map((c) => c.low)),
    volume: day.reduce((s, c) => s + c.volume, 0),
    trades: day.reduce((s, c) => s + c.trades, 0),
  };
}

const Sep = () => <div className="hidden h-6 w-px shrink-0 bg-border sm:block" />;

function Stat({ k, v, className, testId, title, wrap }: { k: string; v: React.ReactNode; className?: string; testId?: string; title?: string; wrap?: string }) {
  return (
    <div className={cn("flex shrink-0 flex-col", wrap)} title={title}>
      <span className="text-[10px] text-mutedfg">{k}</span>
      <span className={cn("num text-sm font-medium", className)} data-testid={testId}>
        {v}
      </span>
    </div>
  );
}

export function MarketBar({
  markets,
  market,
  onSelect,
  last,
  mid,
  bid,
  ask,
  day,
  live,
  loading,
  info,
}: {
  markets: Market[];
  market: Market;
  onSelect: (id: string) => void;
  last: number | null;
  mid: number | null;
  bid: number | null;
  ask: number | null;
  day: DayStats;
  live: boolean | null;
  loading: boolean;
  /** asset and issuer links, shown after the stats */
  info?: React.ReactNode;
}) {
  const spread = bid !== null && ask !== null ? ask - bid : null;
  const up = day.change !== null ? day.change >= 0 : null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-2 py-1 sm:gap-4" data-testid="market-bar">
      {/* the selector sits OUTSIDE the stats' scroll container (phones only scroll the stats) */}
      <div className="shrink-0">
        <MarketSelector markets={markets} market={market} onSelect={onSelect} />
      </div>
      <Sep />
      <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto scroll-thin lg:overflow-hidden xl:gap-5" data-testid="market-stats">
        <Stat k="Last" v={last !== null ? fmt(last, 4, 4) : "--"} className={cn("font-bold", up === null ? "" : up ? "text-green" : "text-red")} testId="stat-last" />
        <Stat
          k="24h change"
          v={day.change !== null ? `${day.change >= 0 ? "+" : ""}${day.change.toFixed(2)}%` : "--"}
          className={up === null ? "" : up ? "text-green" : "text-red"}
        />
        <Stat wrap="hidden min-[1600px]:flex" k="Mid" v={mid !== null ? fmt(mid, 4, 4) : "--"} />
        <Stat wrap="hidden min-[1400px]:flex" k="Spread" v={spread !== null ? `${fmt(spread, 4, 4)}` : "--"} title={spread !== null && mid ? `${((spread / mid) * 100).toFixed(2)}% of mid` : undefined} />
        <Stat k="Best bid" v={bid !== null ? fmt(bid, 4, 4) : "--"} className="text-green" />
        <Stat k="Best ask" v={ask !== null ? fmt(ask, 4, 4) : "--"} className="text-red" />
        <Stat wrap="hidden min-[1600px]:flex" k="24h high" v={day.high !== null ? fmt(day.high, 4, 4) : "--"} />
        <Stat wrap="hidden min-[1600px]:flex" k="24h low" v={day.low !== null ? fmt(day.low, 4, 4) : "--"} />
        <Stat k={`24h vol (${market.base.code})`} v={day.volume !== null ? fmt(day.volume, 2) : "--"} title={`${day.trades} trades in 24h`} />
        {info ? <span className="hidden shrink-0 items-center gap-1 text-[11px] text-mutedfg xl:flex">{info}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pr-1 text-[11px] text-mutedfg">
          <Dot ok={live} pulse={loading} />
          {live === false ? "offline" : "live"}
        </span>
      </div>
    </div>
  );
}
