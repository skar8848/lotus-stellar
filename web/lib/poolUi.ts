// Small presentation helpers for the pool pages (no React).

import type { PoolInstance, Strategy } from "./config-types";

export type YieldTone = "none" | "idle" | "live";

/** What happens to the pool's USDC leg, stated honestly from the instance + its strategy entry. */
export function poolYield(inst: PoolInstance, strategies: Strategy[]): { tone: YieldTone; short: string; detail: string } {
  if (!inst.vault) {
    return {
      tone: "none",
      short: `${inst.quote.code} idle in the pool`,
      detail: `The pool's ${inst.quote.code} leg is held idle: no yield.`,
    };
  }
  const s = inst.strategyId ? strategies.find((x) => x.id === inst.strategyId) : undefined;
  if (s?.status === "live") {
    return {
      tone: "live",
      short: `${inst.quote.code} in DeFindex > Blend`,
      detail: `The pool's ${inst.quote.code} leg is held as DeFindex vault shares and allocated to Blend (${s.label}); vault yield accrues to the positions that own it.`,
    };
  }
  return {
    tone: "idle",
    short: `${inst.quote.code} in DeFindex (idle)`,
    detail: s
      ? `The pool's ${inst.quote.code} leg is held as DeFindex vault shares, but the testnet vault behind "${s.label}" is not allocated to Blend: no interest accrues yet.`
      : `The pool's ${inst.quote.code} leg is held as DeFindex vault shares. Allocation to Blend is not confirmed in testnet.strategies.json, so no yield is claimed.`,
  };
}

export function poolStatusLabel(inst: PoolInstance): string {
  if (inst.mock) return "Local simulation";
  if (inst.status === "coming-soon") return "Coming soon";
  if (inst.status === "retired") return "Retired";
  if (inst.status === "idle") return "Live (idle USDC)";
  return "Live";
}
