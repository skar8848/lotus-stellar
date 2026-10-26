// The SDEX markets the app trades:
//   BOND/receipt  : the tokenized bond (LBOND) priced in the yield-bearing receipt (one per Lotus vault)
//   USDC/receipt  : the 1:1 peg book between the underlying and the receipt (one per Lotus vault)
//   BOND/USDC     : the bond priced in plain USDC (no yield), once, after the active vault's markets. It is the
//                   SDEX destination of a "New order" with yield off.
// One pair per strategy, so a second Lotus vault adds its own markets automatically.

import type { LotusConfig, Strategy } from "./config-types";
import { assetReady, type AssetRef } from "./stellar";

export type Market = {
  /** URL-safe id, e.g. "LBOND-lUSDC" */
  id: string;
  /** Display label, e.g. "LBOND/lUSDC" */
  label: string;
  base: AssetRef;
  quote: AssetRef;
  /** bond = BOND/receipt, peg = USDC/receipt, cash = BOND/USDC (quote is not a receipt) */
  kind: "bond" | "peg" | "cash";
  /** The Lotus vault whose receipt is the quote asset (for "cash": the active vault, for links only). */
  strategyId: string;
  strategyLabel: string;
  /** The Lotus receipt (== quote, except for "cash"). */
  receipt: AssetRef;
  /** The vault underlying (USDC). */
  underlying: AssetRef;
  /** One-line description for the market header. */
  blurb: string;
};

const sameRef = (a: AssetRef, b: AssetRef) => a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);

export function buildMarkets(config: LotusConfig): Market[] {
  const out: Market[] = [];
  const taken = new Set<string>();
  const push = (m: Omit<Market, "id" | "label">) => {
    let id = `${m.base.code}-${m.quote.code}`;
    if (taken.has(id)) id = `${id}~${(m.quote.issuer ?? "").slice(1, 5)}`;
    taken.add(id);
    out.push({ ...m, id, label: `${m.base.code}/${m.quote.code}` });
  };

  // The vault that testnet.contract.json points at is the active one: its markets come first (the /trade
  // default), then other live vaults, then idle ones. Receipt codes are never hardcoded.
  const rank = (s: Pick<Strategy, "status"> & { lotusVault?: string }) =>
    s.lotusVault && s.lotusVault === config.lotusVault ? 0 : s.status === "live" ? 1 : s.status === "idle" ? 2 : 3;
  const pools: (Pick<Strategy, "id" | "label" | "underlying" | "receipt" | "status"> & { lotusVault?: string })[] =
    config.strategies.length > 0
      ? [...config.strategies].sort((a, b) => rank(a) - rank(b))
      : [{ id: "default", label: "Lotus vault", status: "idle" as const, underlying: config.underlying, receipt: config.receipt }];

  for (const s of pools) {
    // an announced vault ("coming-soon") has no receipt on the SDEX yet; a receipt is always a credit asset
    if (s.status === "coming-soon" || !s.receipt.issuer || !assetReady(s.receipt)) continue;
    if (assetReady(config.rwa) && !sameRef(config.rwa, s.receipt)) {
      push({
        base: config.rwa,
        quote: s.receipt,
        kind: "bond",
        strategyId: s.id,
        strategyLabel: s.label,
        receipt: s.receipt,
        underlying: s.underlying,
        blurb: `${config.rwa.code}: tokenized bond (AUTH_REQUIRED, clawback) quoted in the yield-bearing ${s.receipt.code}.`,
      });
    }
    if (assetReady(s.underlying) && !sameRef(s.underlying, s.receipt)) {
      push({
        base: s.underlying,
        quote: s.receipt,
        kind: "peg",
        strategyId: s.id,
        strategyLabel: s.label,
        receipt: s.receipt,
        underlying: s.underlying,
        blurb: `Peg book: ${s.underlying.code} against ${s.receipt.code}, redeemable 1:1 through the Lotus vault.`,
      });
    }
    // BOND/USDC once, right after the active vault's markets
    if (
      !out.some((m) => m.kind === "cash") &&
      assetReady(config.rwa) &&
      assetReady(s.underlying) &&
      !sameRef(config.rwa, s.underlying)
    ) {
      push({
        base: config.rwa,
        quote: s.underlying,
        kind: "cash",
        strategyId: s.id,
        strategyLabel: s.label,
        receipt: s.receipt,
        underlying: s.underlying,
        blurb: `${config.rwa.code} quoted in plain ${s.underlying.code}: no yield while an order waits (compare ${config.rwa.code}/${s.receipt.code}).`,
      });
    }
  }
  return out;
}

/** Accepts "LBOND-lUSDC", "LBOND/lUSDC" or a case-insensitive variant. */
export function pickMarket(markets: Market[], param: string | null | undefined): Market | null {
  if (markets.length === 0) return null;
  if (param) {
    const p = decodeURIComponent(param).replace("/", "-").toLowerCase();
    const hit = markets.find((m) => m.id.toLowerCase() === p);
    if (hit) return hit;
  }
  return markets[0];
}

/** Market for a given receipt asset, preferring the bond market (used by "Trade on the SDEX" links). */
export function marketForReceipt(markets: Market[], receipt: AssetRef): Market | null {
  const ms = markets.filter((m) => sameRef(m.receipt, receipt));
  return ms.find((m) => m.kind === "bond") ?? ms[0] ?? null;
}
