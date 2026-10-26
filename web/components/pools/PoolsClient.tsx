"use client";

// /pools: the New position flow (one Uniswap-style "add liquidity" page, strategy chosen last) and Your positions
// across the four strategies. The pool swap + venue comparison opens in a dialog from the header. The separate
// two-way LP pool keeps its own builder, reached with "Advanced: two-way position" (?pool=<instance id>).

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Dot, ExplorerLink, Panel, Segmented, Stat } from "@/components/common";
import { fromStroops } from "@/lib/amount";
import { midPrice } from "@/lib/book";
import { useConfig, useNet } from "@/lib/config-context";
import type { PoolInstance } from "@/lib/config-types";
import { usePolling } from "@/lib/hooks";
import { pickReference } from "@/lib/orderRoute";
import { SUPPORTED_ABI, getPoolClient, resetMockPool } from "@/lib/pool";
import { MAX_BIN, MIN_BIN, planPosition } from "@/lib/poolGrid";
import { poolStatusLabel, poolYield } from "@/lib/poolUi";
import { assetReady, fetchOrderBook, fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { MyPositions } from "./MyPositions";
import { NewPosition } from "./NewPosition";
import { PoolRangeChart } from "./PoolRangeChart";
import { PoolSwap } from "./PoolSwap";
import { PositionBuilder } from "./PositionBuilder";
import { initialPoolForm, poolEffective, type PoolForm } from "./RangeInputs";
import { useBlendApr } from "./useBlendApr";
import { directionalPools } from "./useOrder";
import { YourPositions } from "./YourPositions";

export function PoolsClient() {
  const config = useConfig();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const pools = config.pools;
  const directional = useMemo(() => directionalPools(pools), [pools]);
  const twoWayInst = directional.others.find((p) => p.supportsTwoWay && !p.mock) ?? null;
  const picked = pools.find((p) => p.id === params.get("pool")) ?? null;
  const advanced = picked && !directional.list.includes(picked) ? picked : null;
  const [version, setVersion] = useState(0);
  const [swapOpen, setSwapOpen] = useState(false);

  const yieldStrategy = config.strategies.find((s) => s.lotusVault === config.lotusVault) ?? null;
  const apr = useBlendApr(advanced ? null : yieldStrategy);
  const aprText = apr.aprPct !== null ? `${apr.aprPct.toFixed(2)}% APR` : apr.observedPct !== null ? `${apr.observedPct.toFixed(2)}% APR` : null;

  const go = (id: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (id) sp.set("pool", id);
    else sp.delete("pool");
    const q = sp.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };

  const mock = pools.some((p) => p.mock);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-5 sm:px-6" data-testid="pools-page">
      {mock ? (
        <div className="mb-4 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 text-xs" data-testid="pool-mock-banner">
          <span className="font-medium text-primary">Local simulation.</span>{" "}
          <span className="text-mutedfg">
            No lotus_pool contract is deployed (deployments/testnet.pool.json is missing): pool actions change local state only and no transaction is sent.
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

      {advanced ? (
        <AdvancedTwoWay inst={advanced} onBack={() => go(null)} />
      ) : (
        <>
          <NewPosition
            apr={apr}
            onCreated={() => setVersion((v) => v + 1)}
            onOpenSwap={() => setSwapOpen(true)}
            twoWayInst={twoWayInst}
            onAdvanced={() => twoWayInst && go(twoWayInst.id)}
          />
          <div id="your-positions" className="mt-12 scroll-mt-20">
            <YourPositions version={version} aprText={aprText} onNew={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
          </div>
          <SwapDialog open={swapOpen} onOpenChange={setSwapOpen} list={directional.list} onDone={() => setVersion((v) => v + 1)} />
        </>
      )}
    </main>
  );
}

/** Pool swap + venue comparison, against the idle or the vault-backed instance. */
function SwapDialog({ open, onOpenChange, list, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; list: PoolInstance[]; onDone: () => void }) {
  const config = useConfig();
  const net = useNet();
  const [id, setId] = useState<string | null>(null);
  const inst = list.find((p) => p.id === id) ?? list[0];
  const client = useMemo(() => (inst ? getPoolClient(net, inst) : null), [net, inst]);
  if (!inst || !client) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[460px]" data-testid="swap-dialog">
        <DialogHeader>
          <DialogTitle>Swap on the Lotus pool</DialogTitle>
          <DialogDescription className="text-xs">Fills from the pool bins; the SDEX path for the same input is quoted below.</DialogDescription>
        </DialogHeader>
        {list.length > 1 ? (
          <Segmented value={inst.id} onChange={setId} size="sm" testId="swap-pool-picker" options={list.map((p) => ({ value: p.id, label: p.label }))} />
        ) : null}
        <PoolSwap key={inst.id} inst={inst} client={client} horizon={config.horizon} network={config.network} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}

/** The separate two-way LP instance: the previous builder (directional or two-way), its depth chart and positions. */
function AdvancedTwoWay({ inst, onBack }: { inst: PoolInstance; onBack: () => void }) {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const [form, setForm] = useState<PoolForm>({ ...initialPoolForm, mode: "TwoWay" });
  const client = useMemo(() => getPoolClient(net, inst), [net, inst]);
  const yieldInfo = poolYield(inst, config.strategies);
  const live = !inst.mock && !!inst.contract;

  const cfgFn = useCallback(() => client.getConfig(), [client]);
  const cfgQ = usePolling(cfgFn, 60000, true);
  const abiFn = useCallback(() => client.abiVersion(), [client]);
  const abiQ = usePolling(abiFn, 300000, true);
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
  const bestAsk = asks.length > 0 ? Number(asks[0].price) / 1e7 : null;
  const bestBid = bids.length > 0 ? Number(bids[bids.length - 1].price) / 1e7 : null;
  const poolMid = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid);
  const booksFn = useCallback(async () => {
    const ok = assetReady(inst.base) && !!inst.base.issuer;
    const [rb, ub] = await Promise.all([
      ok && assetReady(config.receipt) ? fetchOrderBook(config.horizon, inst.base, config.receipt, 5).catch(() => null) : Promise.resolve(null),
      ok && assetReady(inst.quote) ? fetchOrderBook(config.horizon, inst.base, inst.quote, 5).catch(() => null) : Promise.resolve(null),
    ]);
    return { receipt: rb, usdc: ub };
  }, [config.horizon, config.receipt, inst.base, inst.quote]);
  const booksQ = usePolling(booksFn, 10000, true);
  const refPrice = pickReference({ receiptMid: midPrice(booksQ.data?.receipt ?? null), usdcMid: midPrice(booksQ.data?.usdc ?? null), poolMid }).price;

  const eff = poolEffective(form, refPrice);
  const plan = useMemo(
    () =>
      planPosition({
        side: form.side,
        startPrice: eff.start,
        endPrice: eff.end,
        shape: form.shape,
        amount: Number(form.amount) > 0 ? form.amount : "1",
        stepBps: inst.binStepBps,
        feeBps: inst.feeBps,
      }),
    [form.side, form.shape, form.amount, eff.start, eff.end, inst.binStepBps, inst.feeBps],
  );
  const refreshAll = () => {
    tvlQ.refresh();
    depthQ.refresh();
    posQ.refresh();
  };
  const tvl = tvlQ.data;

  return (
    <div className="space-y-4" data-testid="pool-tab" data-pool={inst.id} data-mock={inst.mock ? "1" : "0"}>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-mutedfg hover:text-white" data-testid="twoway-back">
        <ArrowLeft className="size-3.5" /> Back to New position (directional range orders)
      </button>
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            Advanced: two-way position · {inst.label}
            <Badge variant="outline" className={cn("gap-1.5", inst.mock ? "border-primary/40 text-primary" : "border-green/40 text-green")}>
              <Dot ok={inst.mock ? null : true} />
              {poolStatusLabel(inst)}
            </Badge>
          </span>
        }
        subtitle={
          <>
            Classic LP with crossback (Mode::TwoWay) on the separate two-way instance: earns fees in both directions and refills when the price comes back, but can end up holding
            mostly the other asset. {yieldInfo.detail}
          </>
        }
        right={live ? <ExplorerLink kind="contract" id={inst.contract} network={config.network} label="pool contract" /> : null}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="pool-stats">
          <Stat
            label="TVL"
            value={tvl ? `${fmt(Number(fromStroops(tvl.quoteValue)) + Number(fromStroops(tvl.base)) * refPrice, 2)} ${inst.quote.code}` : "-"}
            sub={tvl ? `${fmt(fromStroops(tvl.quoteValue), 2)} ${inst.quote.code} + ${fmt(fromStroops(tvl.base), 2)} ${inst.base.code}` : "tvl()"}
          />
          <Stat label="Fee tier" value={`${fmt(inst.feeBps / 100, 2)}%`} sub={`of the ${inst.quote.code} leg`} />
          <Stat label="Bin step" value={`${fmt(inst.binStepBps / 100, 2)}%`} sub={`up to ${cfgQ.data?.maxBinsPerSwap ?? "-"} bins per swap`} />
          <Stat label="Reference price" value={fmt(refPrice, 4, 4)} sub={`${inst.quote.code} per ${inst.base.code}`} />
        </div>
        {abiQ.data !== null && abiQ.data !== SUPPORTED_ABI ? (
          <p className="mt-3 text-xs text-primary" data-testid="pool-abi-warning">
            This pool reports ABI version {abiQ.data}; this app was written for version {SUPPORTED_ABI}.
          </p>
        ) : null}
      </Panel>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          <Panel title="Depth by price bin" subtitle="Liquidity resting in this instance; your new position in pink.">
            <PoolRangeChart asks={asks} bids={bids} plan={plan} shapeOnly={!(Number(form.amount) > 0)} stepBps={inst.binStepBps} baseCode={inst.base.code} />
          </Panel>
          <MyPositions inst={inst} client={client} positions={posQ} network={config.network} onChanged={refreshAll} />
        </div>
        <div className="card p-4 sm:p-5">
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
        </div>
      </div>
    </div>
  );
}
