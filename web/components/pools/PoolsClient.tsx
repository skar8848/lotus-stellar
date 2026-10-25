"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dot, ExplorerLink, Panel, Segmented, Stat } from "@/components/common";
import { VaultTab } from "@/components/vault/VaultTab";
import { fromStroops } from "@/lib/amount";
import { useConfig, useNet } from "@/lib/config-context";
import { usePolling } from "@/lib/hooks";
import { getPoolClient, resetMockPool } from "@/lib/pool";
import { MAX_BIN, MIN_BIN, planPosition } from "@/lib/poolGrid";
import { poolStatusLabel, poolYield } from "@/lib/poolUi";
import { fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { MyPositions } from "./MyPositions";
import { PoolRangeChart } from "./PoolRangeChart";
import { PoolSwap } from "./PoolSwap";
import { PositionBuilder, initialPoolForm, poolEffective, type PoolForm } from "./PositionBuilder";

const topTrigger =
  "h-auto flex-none rounded-none border-0 bg-transparent px-2 py-1 text-lg font-semibold text-mutedfg/60 shadow-none hover:text-mutedfg data-[state=active]:bg-transparent data-[state=active]:text-white data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent dark:data-[state=active]:border-transparent";

export function PoolsClient() {
  const receiptCode = useConfig().receipt.code;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = params.get("tab") === "vault" ? "vault" : "pool";

  const setTab = (t: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("tab", t);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-5 sm:px-6">
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Pools</h1>
            <p className="mt-1 max-w-2xl text-xs text-mutedfg">
              The Lotus pool is a directional range pool on Soroban. The Lotus vault turns USDC into the {receiptCode} receipt that trades on the SDEX.
            </p>
          </div>
          <TabsList className="h-auto gap-0 bg-transparent p-0">
            <TabsTrigger value="pool" className={topTrigger} data-testid="pools-tab-pool">
              Lotus pool
            </TabsTrigger>
            <TabsTrigger value="vault" className={topTrigger} data-testid="pools-tab-vault">
              Vault &amp; receipt ({receiptCode})
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="pool">
          <PoolTab />
        </TabsContent>
        <TabsContent value="vault">
          <VaultTab />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function PoolTab() {
  const config = useConfig();
  const net = useNet();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wallet = useWallet();
  const [form, setForm] = useState<PoolForm>(initialPoolForm);
  const [panel, setPanel] = useState<"add" | "swap">("add");

  const pools = config.pools;
  const inst = pools.find((p) => p.id === params.get("pool")) ?? pools[0];
  const client = useMemo(() => getPoolClient(net, inst), [net, inst]);
  const live = !inst.mock && !!inst.contract;
  const yieldInfo = poolYield(inst, config.strategies);

  const cfgFn = useCallback(() => client.getConfig(), [client]);
  const cfgQ = usePolling(cfgFn, 60000, true);
  const tvlFn = useCallback(() => client.tvl(), [client]);
  const tvlQ = usePolling(tvlFn, 10000, true);
  const depthFn = useCallback(async () => {
    const [asks, bids] = await Promise.all([client.depth("Ask", MIN_BIN, MAX_BIN), client.depth("Bid", MIN_BIN, MAX_BIN)]);
    return { asks, bids };
  }, [client]);
  const depthQ = usePolling(depthFn, 8000, true);
  const addr = wallet.address;
  const posFn = useCallback(() => (addr ? client.positionsOf(addr) : Promise.resolve([])), [client, addr]);
  const posQ = usePolling(posFn, 10000, !!addr);

  const asks = depthQ.data?.asks ?? [];
  const bids = depthQ.data?.bids ?? [];
  const bestAsk = asks.length > 0 ? Number(asks[0].price) / 1e7 : null; // lowest ask bin
  const bestBid = bids.length > 0 ? Number(bids[bids.length - 1].price) / 1e7 : null; // highest bid bin
  const refPrice = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid ?? 1);

  const eff = poolEffective(form, refPrice);
  const plan = useMemo(
    () =>
      planPosition({
        side: form.side,
        startPrice: eff.start,
        endPrice: eff.end,
        shape: form.shape,
        // a placeholder size keeps the preview alive before the user types an amount
        amount: Number(form.amount) > 0 ? form.amount : "1",
        stepBps: inst.binStepBps,
        feeBps: inst.feeBps,
      }),
    [form.side, form.shape, form.amount, eff.start, eff.end, inst.binStepBps, inst.feeBps],
  );

  const refreshAll = useCallback(() => {
    tvlQ.refresh();
    depthQ.refresh();
    posQ.refresh();
  }, [tvlQ, depthQ, posQ]);

  const selectPool = (id: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set("pool", id);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    setForm(initialPoolForm);
  };

  const tvl = tvlQ.data;
  const errored = cfgQ.error || depthQ.error;

  return (
    <div className="space-y-4" data-testid="pool-tab" data-pool={inst.id} data-mock={inst.mock ? "1" : "0"}>
      {inst.mock ? (
        <div className="rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 text-xs" data-testid="pool-mock-banner">
          <span className="font-medium text-primary">Local simulation.</span>{" "}
          <span className="text-mutedfg">
            No lotus_pool contract is deployed yet (deployments/testnet.pool.json is missing), so this page runs the pool ABI against an in-browser simulation: positions, swaps, claims and removals below change local state only and no transaction is sent. It switches to the live contract on its own once the deployment file lists an instance.
          </span>{" "}
          <button
            className="text-primary underline underline-offset-2"
            onClick={() => {
              resetMockPool();
              window.location.reload();
            }}
          >
            Reset simulation
          </button>
        </div>
      ) : null}

      {/* instance + stats */}
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            {inst.label}
            <Badge variant="outline" className={cn("gap-1.5", inst.mock ? "border-primary/40 text-primary" : "border-green/40 text-green")}>
              <Dot ok={inst.mock ? null : true} />
              {poolStatusLabel(inst)}
            </Badge>
          </span>
        }
        subtitle={
          <>
            {inst.base.code} priced in {inst.quote.code} on a {inst.binStepBps / 100}% price grid. {yieldInfo.detail}
          </>
        }
        right={
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] text-mutedfg">
            {live ? <ExplorerLink kind="contract" id={inst.contract} network={config.network} label="pool contract" /> : null}
            {inst.vault ? <ExplorerLink kind="contract" id={inst.vault} network={config.network} label="DeFindex vault" /> : null}
          </div>
        }
      >
        {pools.length > 1 ? (
          <Segmented
            value={inst.id}
            onChange={selectPool}
            size="sm"
            className="mb-4 w-auto flex-wrap"
            testId="pool-picker"
            options={pools.map((p) => ({ value: p.id, label: p.label }))}
          />
        ) : null}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-5" data-testid="pool-stats">
          <Stat
            label="TVL"
            value={tvl ? `${fmt(Number(fromStroops(tvl.quoteValue)) + Number(fromStroops(tvl.base)) * refPrice, 2)} ${inst.quote.code}` : "-"}
            sub={tvl ? `${fmt(fromStroops(tvl.quoteValue), 2)} ${inst.quote.code} + ${fmt(fromStroops(tvl.base), 2)} ${inst.base.code} at pool mid` : "tvl()"}
          />
          <Stat label={`${inst.base.code} in pool`} value={tvl ? fmt(fromStroops(tvl.base), 2) : "-"} sub="token balance held by the pool" />
          <Stat label="Fee tier" value={`${fmt(inst.feeBps / 100, 2)}%`} sub={`of the ${inst.quote.code} leg`} />
          <Stat label="Bin step" value={`${fmt(inst.binStepBps / 100, 2)}%`} sub={`${inst.binStepBps} bps, bins ${MIN_BIN}..${MAX_BIN}`} />
          <div className="col-span-2 min-w-0 sm:col-span-4 lg:col-span-1">
            <div className="label">Yield on {inst.quote.code} leg</div>
            <div className="mt-1 text-sm font-medium" data-testid="pool-yield">
              {yieldInfo.short}
            </div>
            <div className="mt-0.5 text-xs text-mutedfg">{yieldInfo.tone === "live" ? "vault yield accrues to positions" : "no yield is claimed"}</div>
          </div>
        </div>
        {errored ? <p className="mt-3 text-xs text-destructive">Pool read failed: {String(cfgQ.error || depthQ.error)}</p> : null}
      </Panel>

      {/* chart, then the builder, then positions on a phone; chart + positions left and the builder right on desktop */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_460px] lg:grid-rows-[auto_minmax(0,1fr)]">
        <Panel
          className="lg:col-start-1 lg:row-start-1"
          title="Depth by price bin"
          subtitle="Liquidity resting in the pool. Your new position is drawn in pink as you set the range."
        >
          <PoolRangeChart asks={asks} bids={bids} plan={panel === "add" ? plan : null} shapeOnly={!(Number(form.amount) > 0)} stepBps={inst.binStepBps} baseCode={inst.base.code} />
        </Panel>

        <aside className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="card p-4 sm:p-5">
            <Tabs value={panel} onValueChange={(v) => setPanel(v as "add" | "swap")} className="gap-3">
              <TabsList className="h-auto gap-0 bg-transparent p-0">
                <TabsTrigger value="add" className={topTrigger} data-testid="pool-tab-add">
                  Add liquidity
                </TabsTrigger>
                <TabsTrigger value="swap" className={topTrigger} data-testid="pool-tab-swap">
                  Swap
                </TabsTrigger>
              </TabsList>
              <TabsContent value="add">
                <PositionBuilder
                  inst={inst}
                  client={client}
                  cfg={cfgQ.data}
                  strategies={config.strategies}
                  form={form}
                  setForm={setForm}
                  plan={plan}
                  refPrice={refPrice}
                  network={config.network}
                  onDone={refreshAll}
                />
              </TabsContent>
              <TabsContent value="swap">
                <PoolSwap inst={inst} client={client} horizon={config.horizon} network={config.network} onDone={refreshAll} />
              </TabsContent>
            </Tabs>
          </div>
        </aside>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <MyPositions inst={inst} client={client} positions={posQ} network={config.network} onChanged={refreshAll} />
        </div>
      </div>
    </div>
  );
}
