"use client";

import { useCallback, useMemo } from "react";
import { Empty, ExplorerLink, Panel } from "@/components/common";
import { OpenOffers } from "@/components/trade/OpenOffers";
import { useAccount } from "@/lib/account";
import { useConfig, useNet } from "@/lib/config-context";
import { usePolling } from "@/lib/hooks";
import { buildMarkets } from "@/lib/markets";
import { assetKey, assetReady, fetchOffers, fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { Activity } from "./Activity";
import { Balances } from "./Balances";
import { PoolPositions } from "./PoolPositions";
import { ReceiptPositions } from "./ReceiptPositions";
import { Summary } from "./Summary";
import { loadActivity, loadPoolPositions, loadSupplies } from "./data";
import { XLM, buildBalanceRows, loadPrices, poolValue, walletTotals, type PriceMap } from "./model";

const NO_PRICES: PriceMap = {};

export function PortfolioClient() {
  const config = useConfig();
  const net = useNet();
  const wallet = useWallet();
  const acct = useAccount();
  const address = wallet.address;
  const markets = useMemo(() => buildMarkets(config), [config]);

  const offersFn = useCallback(() => (address ? fetchOffers(config.horizon, address) : Promise.resolve([])), [config.horizon, address]);
  const offers = usePolling(offersFn, 8000, !!address);
  const pricesFn = useCallback(() => loadPrices(config), [config]);
  const prices = usePolling(pricesFn, 20000, !!address);
  const poolsFn = useCallback(() => (address ? loadPoolPositions(config, net, address) : Promise.resolve([])), [config, net, address]);
  const pools = usePolling(poolsFn, 10000, !!address);
  const suppliesFn = useCallback(() => loadSupplies(config, net), [config, net]);
  const supplies = usePolling(suppliesFn, 15000, !!address);
  const activityFn = useCallback(() => (address ? loadActivity(config, net, address) : Promise.resolve({ rows: [], unavailable: [] })), [config, net, address]);
  const activity = usePolling(activityFn, 30000, !!address);

  const priceMap = prices.data ?? NO_PRICES;
  const rows = useMemo(() => buildBalanceRows(config, acct.data, priceMap), [config, acct.data, priceMap]);
  const totals = useMemo(() => walletTotals(rows), [rows]);

  const poolStats = useMemo(() => {
    const data = pools.data ?? [];
    const onchain = data.filter((d) => !d.inst.mock).flatMap((d) => d.positions.map((position) => ({ inst: d.inst, position })));
    const simulated = data.filter((d) => d.inst.mock).reduce((n, d) => n + d.positions.length, 0);
    const v = poolValue(onchain, priceMap);
    return { value: v.value, excluded: v.excluded, onchain: onchain.length, simulated };
  }, [pools.data, priceMap]);

  const xlmFree = rows.find((r) => r.kind === "native")?.available ?? null;

  const priceNotes = useMemo(() => {
    const notes: string[] = [];
    if (!prices.data) return notes;
    if (assetReady(config.rwa)) {
      const px = prices.data[assetKey(config.rwa)];
      notes.push(
        px
          ? `${config.rwa.code} is valued at ${fmt(px.price, 4, 4)} USDC (${px.source}).`
          : `${config.rwa.code} has no price right now (empty books and no trades): it is excluded from the total.`,
      );
    }
    const x = prices.data[assetKey(XLM)];
    notes.push(x ? `XLM is valued at ${fmt(x.price, 4, 4)} USDC (${x.source}).` : "XLM has no price: there is no XLM/USDC book on this network, so it is excluded from the total.");
    return notes;
  }, [prices.data, config.rwa]);

  const refreshAll = () => {
    acct.refresh();
    offers.refresh();
    pools.refresh();
    supplies.refresh();
    activity.refresh();
  };

  const notFunded = !!address && acct.data === null && acct.updatedAt !== null;
  const accountLoading = !!address && acct.data === null && !notFunded;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-5 sm:px-6" data-testid="portfolio">
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
        <p className="mt-1 text-xs text-mutedfg">
          {address ? (
            <>
              Account <ExplorerLink kind="account" id={address} network={config.network} n={6} /> on {config.network}
              {wallet.kind === "dev" ? " (dev wallet)" : ""}
            </>
          ) : (
            "Balances, open offers, Lotus pool positions and activity of the connected account."
          )}
        </p>
      </div>

      {!address ? (
        <Panel title="Connect a wallet">
          <Empty className="py-8" >
            <span data-testid="portfolio-connect-prompt">Connect a wallet (top right) to see your balances, open offers, pool positions and recent activity. Nothing is shown for an account you have not connected.</span>
          </Empty>
        </Panel>
      ) : (
        <div className="space-y-4">
          {notFunded ? (
            <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" data-testid="portfolio-unfunded">
              This account does not exist on {config.network} yet. Fund it with Friendbot first.
            </p>
          ) : null}
          {acct.error ? <p className="text-xs text-destructive">Horizon: {acct.error}</p> : null}

          <Summary
            loading={prices.data === null || accountLoading}
            walletValue={totals.value}
            walletExcluded={totals.excluded}
            pools={poolStats}
            xlmFree={xlmFree}
            offersCount={offers.data ? offers.data.length : null}
          />

          <Balances rows={rows} network={config.network} priceNotes={priceNotes} loading={accountLoading} />

          <PoolPositions data={pools.data} address={address} network={config.network} onChanged={refreshAll} />

          <ReceiptPositions strategies={config.strategies} account={acct.data} supplies={supplies.data} network={config.network} loading={accountLoading} onChanged={refreshAll} />

          {/* same rule as /pools Your positions: a resting limit order is locked until fully filled (filled offers
              leave the book), so the shared OpenOffers table is shown without its Cancel buttons here */}
          <div
            data-testid="portfolio-offers"
            data-locked="1"
            className="[&_[data-testid=offer-cancel]]:hidden [&_[data-testid=offers-cancel-all]]:hidden [&_div:has(>button[data-value=market])]:hidden"
          >
            <p className="mb-2 text-[11px] text-mutedfg" data-testid="portfolio-offers-locked">
              Offers are locked until fully filled · Early redemption · soon
            </p>
            <OpenOffers markets={markets} market={null} offers={offers} onChanged={refreshAll} />
          </div>

          <Activity data={activity.data} error={activity.error && !activity.data ? activity.error : null} network={config.network} />
        </div>
      )}
    </main>
  );
}
