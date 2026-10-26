"use client";

import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAccount } from "@/lib/account";
import { fromStroops } from "@/lib/amount";
import type { PoolInstance, Strategy } from "@/lib/config-types";
import { useTx } from "@/lib/hooks";
import type { PoolClient, PoolConfig } from "@/lib/pool";
import type { PositionPlan } from "@/lib/poolGrid";
import { poolYield } from "@/lib/poolUi";
import { fmt } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { Spinner, TxStatus } from "@/components/common";
import { RangeInputs, Row, type PoolForm } from "./RangeInputs";
import { TrustlineNotice, useAssetAccess } from "@/components/trade/access";

export { initialPoolForm, poolDefaults, poolEffective, type PoolForm } from "./RangeInputs";

/**
 * Pool position builder with the Directional / Two-way LP switch. The main /pools flow is the New order panel
 * (NewOrder.tsx); this builder stays for the separate two-way instance (lbond-usdc-twoway, ?pool=...).
 */
export function PositionBuilder({
  inst,
  client,
  cfg,
  strategies,
  form,
  setForm,
  plan,
  refPrice,
  network,
  onDone,
}: {
  inst: PoolInstance;
  client: PoolClient;
  cfg: PoolConfig | null;
  strategies: Strategy[];
  form: PoolForm;
  setForm: (f: PoolForm) => void;
  plan: PositionPlan;
  refPrice: number;
  network: string;
  onDone: () => void;
}) {
  const wallet = useWallet();
  const acct = useAccount();
  const tx = useTx("Add position");
  const baseAccess = useAssetAccess(inst.base);
  const quoteAccess = useAssetAccess(inst.quote);
  const sold = form.side === "Ask" ? inst.base : inst.quote;
  const soldAccess = form.side === "Ask" ? baseAccess : quoteAccess;
  // two-way needs supports_two_way AND no DeFindex vault (the contract answers NotImplemented otherwise)
  const twoWayOk = (inst.supportsTwoWay || cfg?.supportsTwoWay === true) && !inst.vault;
  const twoWayWhy = inst.vault
    ? "Not available on vault-backed pools: with the USDC leg parked in DeFindex the contract returns NotImplemented for two-way positions."
    : "This pool instance was deployed without two-way support (supports_two_way is false).";
  const isTwoWay = form.mode === "TwoWay" && twoWayOk;
  const yieldInfo = poolYield(inst, strategies);
  const set = (patch: Partial<PoolForm>) => setForm({ ...form, ...patch });
  const need = plan.ok ? Number(fromStroops(plan.deposit)) : 0;
  const insufficient = plan.ok && soldAccess.available !== null && need > soldAccess.available + 1e-9;
  const blockedBy = !wallet.address
    ? "Connect a wallet"
    : baseAccess.state === "no-trustline" || baseAccess.state === "unauthorized"
      ? `${inst.base.code} trustline needed`
      : quoteAccess.state === "no-trustline" || quoteAccess.state === "unauthorized"
        ? `${inst.quote.code} trustline needed`
        : !(Number(form.amount) > 0)
          ? "Enter an amount"
          : !plan.ok
            ? plan.errors[0] ?? "Enter a range and an amount"
            : insufficient
            ? `Insufficient ${sold.code}`
            : null;

  const submit = () =>
    tx.run(async (onStage) => {
      if (!wallet.address) throw new Error("Connect a wallet first");
      if (!plan.ok) throw new Error(plan.errors[0] ?? "Invalid position");
      const r = await client.addPosition(
        { source: wallet.address, sign: wallet.sign, onStage },
        { side: form.side, mode: isTwoWay ? "TwoWay" : "Directional", loBin: plan.loBin, hiBin: plan.hiBin, amount: plan.deposit, weights: plan.weights },
      );
      set({ amount: "" });
      acct.refresh();
      onDone();
      return {
        hash: r.hash,
        result: r.result,
        note: `${isTwoWay ? "two-way " : ""}${form.side} position, ${plan.bins.length} bins (${plan.loBin}..${plan.hiBin}), ${fmt(fromStroops(plan.deposit), 2)} ${sold.code}${r.simulated ? " (simulated locally, no transaction)" : ""}`,
      };
    });

  const lo = plan.bins[0];
  const hi = plan.bins[plan.bins.length - 1];

  return (
    <div className="space-y-2" data-testid="position-builder">
      <RangeInputs
        base={inst.base}
        quote={inst.quote}
        form={form}
        setForm={setForm}
        plan={plan}
        refPrice={refPrice}
        balance={soldAccess.available !== null ? fmt(soldAccess.available, 2) : wallet.address ? "-" : undefined}
        sideHelp={<>{isTwoWay
          ? form.side === "Ask"
            ? `You deposit ${inst.base.code} into bins above the market; each bin also bids ${inst.quote.code} for ${inst.base.code} at its price once it has sold some.`
            : `You deposit ${inst.quote.code} into bins below the market; each bin also offers ${inst.base.code} at its price once it has bought some.`
          : form.side === "Ask"
            ? `Your ${inst.base.code} is sold bin by bin as the price rises through the range. Proceeds arrive in ${inst.quote.code}.`
            : `Your ${inst.quote.code} buys ${inst.base.code} bin by bin as the price falls through the range. Proceeds arrive in ${inst.base.code}.`}</>}
      >
      {/* mode: directional (default) vs two-way LP */}
      <div className="flex items-center gap-2" data-testid="pool-mode">
        <button
          type="button"
          data-testid="pool-mode-directional"
          data-active={!isTwoWay ? "1" : "0"}
          onClick={() => setForm({ ...form, mode: "Directional" })}
          className={cn("flex-1 rounded-full border px-3 py-1 text-[11px] font-medium transition", !isTwoWay ? "border-transparent bg-white/10 text-foreground" : "border-border text-mutedfg hover:text-white")}
        >
          Directional
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex-1" data-testid="pool-mode-twoway" data-enabled={twoWayOk ? "1" : "0"}>
              <button
                type="button"
                data-testid="pool-mode-twoway-btn"
                data-active={isTwoWay ? "1" : "0"}
                disabled={!twoWayOk}
                onClick={() => setForm({ ...form, mode: "TwoWay" })}
                className={cn(
                  "w-full rounded-full border px-3 py-1 text-[11px] font-medium transition",
                  isTwoWay ? "border-transparent bg-white/10 text-foreground" : twoWayOk ? "border-border text-mutedfg hover:text-white" : "cursor-not-allowed border-border text-mutedfg/50",
                )}
              >
                Two-way LP
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[17rem] text-[11px] leading-relaxed">
            {twoWayOk ? "Classic LP with crossback: the position trades in both directions and bins refill when the price comes back." : twoWayWhy}
          </TooltipContent>
        </Tooltip>
      </div>
      {!twoWayOk ? (
        <p className="px-1 text-[11px] text-mutedfg" data-testid="pool-twoway-why">
          Two-way LP is off here. {twoWayWhy}
        </p>
      ) : null}
      {isTwoWay ? (
        <p className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed text-primary" data-testid="pool-twoway-note">
          Two-way LP: your liquidity rests on both sides of every bin. It earns fees in both directions and refills when the price comes back through a bin, but it can end up holding mostly the other asset ({inst.base.code} or {inst.quote.code}), like any classic LP position. Directional positions never flip back.
        </p>
      ) : null}

      </RangeInputs>

      <div className="rounded-xl border border-border px-3 py-2.5 text-xs" data-testid="pool-summary">
        <div className="flex items-center justify-between pb-1">
          <span className="label">Summary</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="About the pool grid" className="text-mutedfg hover:text-foreground">
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[17rem] text-[11px] leading-relaxed">
              Prices sit on the contract&apos;s grid: price_at(bin) = 1e7 x (1 + {inst.binStepBps} bps) ^ bin, bins -200 to 200. Your start and end prices snap to the nearest bins.
            </TooltipContent>
          </Tooltip>
        </div>
        <Row k="Average price" v={plan.ok && plan.avgPrice !== null ? `${fmt(Number(plan.avgPrice) / 1e7, 4, 4)} ${inst.quote.code}` : "-"} />
        <Row k="Bins" v={plan.ok ? `${plan.bins.length} (${plan.loBin} to ${plan.hiBin})` : "-"} testId="pool-bins" />
        <Row k="Price range" v={plan.ok && lo && hi ? `${fmt(Number(lo.price) / 1e7, 4, 4)} to ${fmt(Number(hi.price) / 1e7, 4, 4)}` : "-"} />
        <Row k="Fee tier" v={`${fmt(inst.feeBps / 100, 2)}% of the ${inst.quote.code} leg of each fill`} />
        {isTwoWay ? (
          <Row k="Earns" v="fees in both directions; Claim pays fees, Remove pays both reserves" />
        ) : (
          <Row
            k="If fully filled you receive"
            v={plan.ok ? `${fmt(fromStroops(plan.proceedsIfFilled), 2)} ${form.side === "Ask" ? inst.quote.code : inst.base.code} (before fees)` : "-"}
          />
        )}
        <Row k="Your funds" v={form.side === "Ask" ? `${inst.base.code} stays in the pool` : `${inst.quote.code} stays in the pool`} />
      </div>
      <p className="px-1 text-[11px] leading-relaxed text-mutedfg">
        {isTwoWay
          ? `Two-way: fee tier ${fmt(inst.feeBps / 100, 2)}% is charged on top of the price in both directions and goes to the LPs of the bin. `
          : "Directional: inventory only goes down and proceeds only go up. A filled bin never flips back (unlike an AMM position). "}
        {form.side === "Bid" || isTwoWay ? yieldInfo.detail : `Proceeds are ${inst.quote.code}: ${yieldInfo.detail}`}
      </p>

      <TrustlineNotice asset={inst.base} access={baseAccess} verb={form.side === "Ask" ? "deposit" : "receive"} showOk />
      <TrustlineNotice asset={inst.quote} access={quoteAccess} verb="hold" />
      <Button className="h-12 w-full text-base" onClick={submit} disabled={tx.running || blockedBy !== null} data-testid="pool-submit">
        {tx.running ? <Spinner className="size-5" /> : blockedBy ?? "Add position"}
      </Button>
      <TxStatus state={tx.state} network={network} onDismiss={tx.reset} />
    </div>
  );
}
