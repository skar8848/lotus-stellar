// The SDEX markets of a Lotus deployment. Port of web/lib/markets.ts (same order and ids):
//   bond : BOND/receipt   (LBOND priced in the yield-bearing receipt, one per Lotus vault)
//   peg  : receipt/USDC   (the 1:1 peg book, one per Lotus vault)
//   cash : BOND/USDC      (once, after the active vault's markets; SDEX destination of a range order without yield)

import type { LotusConfig, Strategy } from "./shared/config-types.ts";
import { assetReady, sameAsset, type AssetRef } from "./net.ts";

export type Market = {
  id: string;
  label: string;
  base: AssetRef;
  quote: AssetRef;
  kind: "bond" | "peg" | "cash";
  strategyId: string;
  strategyLabel: string;
  receipt: AssetRef;
  underlying: AssetRef;
  blurb: string;
};

const ref = (a: { code: string; issuer: string | null }): AssetRef => ({ code: a.code, issuer: a.issuer ?? null });

export function buildMarkets(config: LotusConfig, opts: { activeOnly?: boolean } = {}): Market[] {
  const out: Market[] = [];
  const taken = new Set<string>();
  const push = (m: Omit<Market, "id" | "label">) => {
    let id = `${m.base.code}-${m.quote.code}`;
    if (taken.has(id)) id = `${id}~${(m.quote.issuer ?? "").slice(1, 5)}`;
    taken.add(id);
    out.push({ ...m, id, label: `${m.base.code}/${m.quote.code}` });
  };
  const rwa = ref(config.rwa);
  const rank = (s: Pick<Strategy, "status"> & { lotusVault?: string }) =>
    s.lotusVault && s.lotusVault === config.lotusVault ? 0 : s.status === "live" ? 1 : s.status === "idle" ? 2 : 3;
  const pools: (Pick<Strategy, "id" | "label" | "underlying" | "receipt" | "status"> & { lotusVault?: string })[] =
    config.strategies.length > 0
      ? [...config.strategies].sort((a, b) => rank(a) - rank(b))
      : [{ id: "default", label: "Lotus vault", status: "idle" as const, underlying: config.underlying, receipt: config.receipt }];

  for (const s of pools) {
    const receipt = ref(s.receipt);
    const underlying = ref(s.underlying);
    if (s.status === "coming-soon" || !receipt.issuer || !assetReady(receipt)) continue;
    if (opts.activeOnly && config.lotusVault && s.lotusVault && s.lotusVault !== config.lotusVault) continue;
    if (assetReady(rwa) && !sameAsset(rwa, receipt)) {
      push({
        base: rwa,
        quote: receipt,
        kind: "bond",
        strategyId: s.id,
        strategyLabel: s.label,
        receipt,
        underlying,
        blurb: `${rwa.code}: tokenized bond (AUTH_REQUIRED, clawback) quoted in the yield-bearing ${receipt.code}.`,
      });
    }
    if (assetReady(underlying) && !sameAsset(underlying, receipt)) {
      push({
        base: receipt,
        quote: underlying,
        kind: "peg",
        strategyId: s.id,
        strategyLabel: s.label,
        receipt,
        underlying,
        blurb: `Peg book: ${receipt.code} priced in ${underlying.code}, redeemable 1:1 through the Lotus vault.`,
      });
    }
    if (!out.some((m) => m.kind === "cash") && assetReady(rwa) && assetReady(underlying) && !sameAsset(rwa, underlying)) {
      push({
        base: rwa,
        quote: underlying,
        kind: "cash",
        strategyId: s.id,
        strategyLabel: s.label,
        receipt,
        underlying,
        blurb: `${rwa.code} quoted in plain ${underlying.code}: no yield while an order waits (compare ${rwa.code}/${receipt.code}).`,
      });
    }
  }
  return out;
}

/** Accepts "LBOND-lUSDCb", "LBOND/lUSDCb" or a case-insensitive variant. null when unknown. */
export function findMarket(markets: Market[], idOrLabel: string): Market | null {
  const p = idOrLabel.trim().replace("/", "-").toLowerCase();
  return (
    markets.find((m) => m.id.toLowerCase() === p) ??
    markets.find((m) => m.kind === "peg" && m.id.toLowerCase() === p.split("-").reverse().join("-")) ??
    null
  );
}
