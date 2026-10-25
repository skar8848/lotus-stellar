"use client";

import { Panel } from "@/components/common";
import type { Strategy } from "@/lib/config-types";

const Step = ({ n, children }: { n: string; children: React.ReactNode }) => (
  <li className="flex gap-3">
    <span className="mt-0.5 shrink-0 font-[family-name:var(--font-audiowide)] text-xs text-mutedfg/70">{n}</span>
    <span className="min-w-0 text-sm leading-relaxed text-foreground/85">{children}</span>
  </li>
);

/** "How yield reaches you": what the keeper does, and what the testnet strategy really does today. */
export function YieldExplainer({ strategy }: { strategy: Strategy }) {
  const r = strategy.receipt.code;
  return (
    <Panel title="How yield reaches you" subtitle={`What happens to the ${strategy.underlying.code} behind your ${r}`}>
      <ol className="space-y-3" data-testid="vault-explainer">
        <Step n="01">
          The vault invests every deposit in a DeFindex vault. Surplus is the part of its value above the {r} supply: yield that has not been handed out yet.
        </Step>
        <Step n="02">
          A keeper mints that surplus as new {r} to holders, pro-rata to their balances. The contract caps every payout on-chain: a distribution above the surplus, or above a
          holder&apos;s share of it, is rejected.
        </Step>
        <Step n="03">
          Balances committed to open SDEX offers count. An offer only sets a selling liability, so the {r} in your bids and asks never leaves your account and keeps
          earning while it waits in the book.
        </Step>
      </ol>
      <div className="mt-4 rounded-xl border border-line bg-secondary/60 px-3.5 py-3 text-xs leading-relaxed text-mutedfg">
        {strategy.status === "live" ? (
          <>
            <span className="font-medium text-green">Live yield.</span> This vault allocates to Blend through DeFindex, so the vault value grows above the {r} supply as interest
            accrues. Only distributions that actually happened are shown on this page.
          </>
        ) : strategy.status === "idle" ? (
          <>
            <span className="font-medium text-foreground">Idle on testnet.</span> This vault keeps its funds idle in the DeFindex testnet vault, so there is{" "}
            <span className="text-foreground">no Blend interest</span> on it. A distribution on an idle vault can only come from USDC donated to the contract (that is how the keeper
            is demoed), never from lending. Your {r} is still redeemable 1:1.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">Announced, not deployed.</span> This strategy has no contract on testnet yet.
          </>
        )}
      </div>
    </Panel>
  );
}
