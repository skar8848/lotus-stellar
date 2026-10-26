"use client";

// /swap: the previous front's order screen (owl/web app/lite + app/pro -> components/app/LimitScreen.tsx), both
// versions as views of ONE page, switched by the Lite / Pro pill (?mode=pro), tabs Swap / Limit (Lite) or
// Swap / Range (Pro) / DCA (disabled), as on lotus-main.
//   Lite Swap   swap against the directional Lotus pool(s), best quote          (SwapPanel)
//   Lite Limit  one price, one bin, then the strategy choice of /pools           (LiteLimit)
//   Pro         the chart (pool bins + SDEX depth, draggable range) + Range form (ChartPanel + ProRange)

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfig } from "@/lib/config-context";
import { assetKey, type AssetRef } from "@/lib/stellar";
import { cn } from "@/lib/utils";
import { useBlendApr } from "@/components/pools/useBlendApr";
import { directionalPools } from "@/components/pools/useOrder";
import { ChartPanel, LiteLimit, ProRange } from "./OrderViews";
import { SlippageSettings, VersionSwitcher } from "./parts";
import { SwapPanel } from "./SwapPanel";
import { useRangeOrder } from "./useRangeOrder";

export function SwapClient() {
  const config = useConfig();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const mode: "lite" | "pro" = params.get("mode") === "pro" ? "pro" : "lite";
  // Lite opens on Swap, Pro on Range (its reason to exist)
  const tabParam = params.get("tab");
  const tab: "swap" | "limit" = tabParam === "swap" || tabParam === "limit" ? tabParam : mode === "pro" ? "limit" : "swap";
  const setTab = (t: "swap" | "limit") => {
    const q = new URLSearchParams(params.toString());
    q.set("tab", t);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const pools = useMemo(() => directionalPools(config.pools).list, [config.pools]);
  // tokens = legs of the directional pools (config, never hard-coded)
  const tokens = useMemo(() => {
    const seen = new Map<string, AssetRef>();
    for (const p of pools) for (const a of [p.quote, p.base]) if (!seen.has(assetKey(a))) seen.set(assetKey(a), { code: a.code, issuer: a.issuer });
    return [...seen.values()];
  }, [pools]);
  // pair shared by every view (as LimitScreen's baseSym / quoteSym); default: pay the quote (USDC) for the base (LBOND)
  const [payKey, setPayKey] = useState<string | null>(null);
  const [recvKey, setRecvKey] = useState<string | null>(null);
  const pay = tokens.find((t) => assetKey(t) === payKey) ?? pools[0]?.quote ?? null;
  const recv = tokens.find((t) => assetKey(t) === recvKey) ?? pools[0]?.base ?? null;
  const [slippage, setSlippage] = useState(0.5);

  const base = pools[0]?.base;
  const side = pay && base && assetKey(pay) === assetKey(base) ? "Ask" : "Bid";
  const order = useRangeOrder({ sideFromSell: side, kind: mode === "pro" ? "range" : "limit", enabled: mode === "pro" || tab === "limit" });
  const yieldStrategy = config.strategies.find((s) => s.lotusVault === config.lotusVault) ?? null;
  const apr = useBlendApr(yieldStrategy);

  if (!pay || !recv) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 pb-12 pt-2 sm:px-6">
        <div className="flex min-h-[80vh] flex-col justify-center">
          <p className="mx-auto max-w-[460px] text-center text-sm text-mutedfg">No Lotus pool is deployed yet.</p>
        </div>
      </main>
    );
  }

  const flip = () => {
    setPayKey(assetKey(recv));
    setRecvKey(assetKey(pay));
    order.resetPrices();
  };
  const select = (s: "pay" | "recv", a: AssetRef) => {
    const k = assetKey(a);
    if (s === "pay" && k === assetKey(pay)) return;
    if (s === "recv" && k === assetKey(recv)) return;
    if (s === "pay") {
      setPayKey(k);
      if (k === assetKey(recv)) setRecvKey(assetKey(pay));
    } else {
      setRecvKey(k);
      if (k === assetKey(pay)) setPayKey(assetKey(recv));
    }
    order.resetPrices();
  };
  // the two sides differ: each dropdown leaves out the other side's token (LimitScreen sell / buy options)
  const sellOptions = tokens.filter((t) => assetKey(t) !== assetKey(recv));
  const buyOptions = tokens.filter((t) => assetKey(t) !== assetKey(pay));
  const pair = { pay, recv, sellOptions, buyOptions, onSelect: select, onFlip: flip };

  const tabBtn = (t: "swap" | "limit", label: string) => (
    <button onClick={() => setTab(t)} data-testid={`tab-${t}`} className={cn("px-2 py-1 transition", tab === t ? "text-white" : "text-mutedfg/60 hover:text-mutedfg")}>
      {label}
    </button>
  );

  const panel = (
    <div className="mx-auto w-full max-w-[460px]" data-testid="order-panel" data-mode={mode} data-tab={tab}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1 text-lg font-semibold">
          {tabBtn("swap", "Swap")}
          {tabBtn("limit", mode === "pro" ? "Range" : "Limit")}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-not-allowed px-2 py-1 text-mutedfg/60" aria-disabled="true" data-testid="tab-dca">
                DCA
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Coming soon</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <VersionSwitcher current={mode} />
          {mode === "pro" || tab === "swap" ? <SlippageSettings slippage={slippage} onChange={setSlippage} /> : null}
        </div>
      </div>
      {tab === "swap" ? (
        <SwapPanel pools={pools} pay={pay} recv={recv} sellOptions={sellOptions} buyOptions={buyOptions} onSelect={select} onFlip={flip} slippage={slippage} />
      ) : mode === "pro" ? (
        <ProRange o={order} pair={pair} apr={apr} />
      ) : (
        <LiteLimit o={order} pair={pair} apr={apr} />
      )}
    </div>
  );

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-12 pt-2 sm:px-6" data-testid="swap-page" data-mode={mode}>
      {mode === "pro" ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_460px]">
          <ChartPanel o={order} showRange={tab === "limit"} />
          {panel}
        </div>
      ) : (
        // center the column vertically, as the lite page
        <div className="flex min-h-[80vh] flex-col justify-center">{panel}</div>
      )}
    </main>
  );
}
