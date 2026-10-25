"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { Empty } from "@/components/common";
import { StrategyCard } from "@/components/vault/StrategyCard";
import { VaultActions } from "@/components/vault/VaultActions";
import { VaultEvents } from "@/components/vault/VaultEvents";
import { YieldExplainer } from "@/components/vault/YieldExplainer";
import { useConfig, useNet } from "@/lib/config-context";
import { usePolling } from "@/lib/hooks";
import { readVaultStats, type VaultStats } from "@/lib/stellar";
import { fetchVaultEvents, hasContract } from "@/lib/vault";

/**
 * "Vault & receipt" tab: the Lotus vault (lotus_vault: USDC -> DeFindex -> Blend) and its receipt.
 * Strategy cards from the deployment files, deposit / redeem for the selected one, the yield explainer
 * and recent contract events. Selection lives in ?strategy=<id> (other params, e.g. tab=vault, are kept).
 * Uses useSearchParams: the host page must wrap it in <Suspense>.
 */
export function VaultTab() {
  const config = useConfig();
  const net = useNet();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // The vault testnet.contract.json points at is the active one: it comes first and is the default selection,
  // then other live vaults, then idle ones, then announced ones.
  const strategies = useMemo(() => {
    const rank = (s: { status: string; lotusVault: string }) =>
      s.lotusVault && s.lotusVault === config.lotusVault ? 0 : s.status === "live" ? 1 : s.status === "idle" ? 2 : 3;
    return [...config.strategies].sort((a, b) => rank(a) - rank(b));
  }, [config.strategies, config.lotusVault]);

  const callable = useMemo(() => strategies.filter(hasContract), [strategies]);
  const wanted = params.get("strategy");
  const selected = strategies.find((s) => s.id === wanted && hasContract(s)) ?? callable[0] ?? strategies[0] ?? null;

  const select = useCallback(
    (id: string) => {
      const p = new URLSearchParams(params.toString());
      p.set("strategy", id);
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  // One poll for every vault's numbers (4 read-only simulations each), shared by the cards and the detail.
  const statsFn = useCallback(async () => {
    const entries = await Promise.all(callable.map(async (s) => [s.id, await readVaultStats(net, s.lotusVault)] as const));
    return Object.fromEntries(entries) as Record<string, VaultStats>;
  }, [net, callable]);
  const stats = usePolling(statsFn, 10000, callable.length > 0);

  const ids = useMemo(() => callable.map((s) => s.lotusVault), [callable]);
  const eventsFn = useCallback(() => fetchVaultEvents(net, ids), [net, ids]);
  const events = usePolling(eventsFn, 30000, ids.length > 0);

  const onDone = useCallback(() => {
    stats.refresh();
    events.refresh();
  }, [stats, events]);

  return (
    <div className="space-y-6" data-testid="vault-tab">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Lotus vault and receipt</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-mutedfg">
          The Lotus vault turns USDC into a receipt token, 1:1, and invests the USDC in a DeFindex vault that lends on Blend. The receipt ({config.receipt.code} for the active vault) is a normal Stellar asset: hold it, or
          quote it on the SDEX, where open offers keep earning.
        </p>
      </div>

      {strategies.length === 0 ? (
        <div className="card">
          <Empty>
            No Lotus vault found in the deployment files (testnet.contract.json / testnet.strategies.json). Deploy one and this page picks it up on its own.
          </Empty>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2" data-testid="vault-strategies">
            {strategies.map((s) => (
              <StrategyCard
                key={s.id}
                strategy={s}
                stats={stats.data?.[s.id] ?? null}
                loading={stats.loading}
                selected={selected?.id === s.id}
                onSelect={select}
                network={config.network}
              />
            ))}
          </div>

          {selected ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
              <div className="min-w-0 lg:col-start-2 lg:row-start-1">
                <VaultActions key={selected.id} strategy={selected} stats={stats.data?.[selected.id] ?? null} onDone={onDone} />
              </div>
              <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1">
                <YieldExplainer strategy={selected} />
                <VaultEvents events={events} strategy={selected} network={config.network} />
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
