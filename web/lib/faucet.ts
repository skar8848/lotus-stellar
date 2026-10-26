// Testnet faucet: shared, pure logic (no React, no SDK, no node:fs). Used by the /faucet page and by the
// server route app/api/faucet/route.ts. Secrets never touch this file: they live in lib/faucet-server.ts.
//
// What a claim gives (fixed amounts):
//   LBOND (rwa)       500   from the LBOND issuer (it also authorizes the trustline: LBOND is AUTH_REQUIRED)
//   USDC (underlying) 200   from a demo account holding Blend testnet USDC
//   receipt           50    the ACTIVE Lotus receipt (testnet.contract.json `receipt`, e.g. lUSDCb), from the maker
// Codes and issuers always come from the deployment config, never from constants here.

import type { AssetCfg, LotusConfig } from "./config-types.ts";

export type FaucetRole = "rwa" | "underlying" | "receipt";

export type FaucetAsset = {
  role: FaucetRole;
  asset: { code: string; issuer: string };
  /** Decimal string, 7 dp max. */
  amount: string;
  label: string;
};

export const FAUCET_AMOUNTS: Record<FaucetRole, string> = { rwa: "500", underlying: "200", receipt: "50" };

const ROLE_LABEL: Record<FaucetRole, string> = {
  rwa: "Tokenized bond (simulated T-bill), AUTH_REQUIRED",
  underlying: "Blend testnet USDC",
  receipt: "Lotus receipt (yield-bearing, 1:1 with USDC)",
};

const isIssuer = (s: string | null | undefined): s is string => typeof s === "string" && /^G[A-Z2-7]{55}$/.test(s);

/** The assets the faucet hands out, in display order, from the config. Assets without a valid issuer are skipped. */
export function faucetAssets(config: Pick<LotusConfig, "rwa" | "underlying" | "receipt">): FaucetAsset[] {
  const items: [FaucetRole, AssetCfg][] = [
    ["underlying", config.underlying],
    ["rwa", config.rwa],
    ["receipt", config.receipt],
  ];
  const out: FaucetAsset[] = [];
  for (const [role, a] of items) {
    if (!a || !a.code || !isIssuer(a.issuer)) continue;
    out.push({ role, asset: { code: a.code, issuer: a.issuer }, amount: FAUCET_AMOUNTS[role], label: ROLE_LABEL[role] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trustline / balance state from a Horizon account
// ---------------------------------------------------------------------------

export type HBalance = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
};

export type LineState = { has: boolean; authorized: boolean; balance: string | null };

export function lineState(balances: HBalance[] | null | undefined, a: { code: string; issuer: string }): LineState {
  const b = balances?.find((x) => x.asset_type !== "native" && x.asset_code === a.code && x.asset_issuer === a.issuer);
  if (!b) return { has: false, authorized: false, balance: null };
  return { has: true, authorized: b.is_authorized !== false, balance: b.balance };
}

/** Assets of `assets` whose trustline is missing on the account. */
export function missingTrustlines(balances: HBalance[] | null | undefined, assets: FaucetAsset[]): FaucetAsset[] {
  return assets.filter((f) => !lineState(balances, f.asset).has);
}

/** Decimal string (7 dp) -> stroops. Invalid -> null. */
export function stroops(s: string | null | undefined): bigint | null {
  if (typeof s !== "string") return null;
  const m = /^(\d+)(?:\.(\d{0,7}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]) * 10_000_000n + BigInt((m[2] ?? "").padEnd(7, "0") || "0");
}

/** Spendable balance (balance - selling liabilities) of a source account, in stroops. */
export function spendable(balances: HBalance[] | null | undefined, a: { code: string; issuer: string }): bigint {
  const b = balances?.find((x) => x.asset_type !== "native" && x.asset_code === a.code && x.asset_issuer === a.issuer);
  if (!b) return 0n;
  return (stroops(b.balance) ?? 0n) - (stroops(b.selling_liabilities ?? "0") ?? 0n);
}

// ---------------------------------------------------------------------------
// Claim planning (what the server will send for one address)
// ---------------------------------------------------------------------------

export type PlanStep =
  | { role: FaucetRole; code: string; action: "send"; authorize: boolean }
  | { role: FaucetRole; code: string; action: "skip"; reason: "no-trustline" | "already-claimed" | "has-balance" };

/**
 * Per asset: send unless the trustline is missing, this address already received it from this faucet,
 * or it already holds at least the faucet amount. LBOND also needs `authorize` when its trustline is not authorized.
 */
export function planClaim(balances: HBalance[] | null | undefined, assets: FaucetAsset[], alreadyClaimed: ReadonlySet<FaucetRole>): PlanStep[] {
  return assets.map((f): PlanStep => {
    const st = lineState(balances, f.asset);
    if (!st.has) return { role: f.role, code: f.asset.code, action: "skip", reason: "no-trustline" };
    if (alreadyClaimed.has(f.role)) return { role: f.role, code: f.asset.code, action: "skip", reason: "already-claimed" };
    const bal = stroops(st.balance) ?? 0n;
    const amt = stroops(f.amount) ?? 0n;
    if (bal >= amt) return { role: f.role, code: f.asset.code, action: "skip", reason: "has-balance" };
    return { role: f.role, code: f.asset.code, action: "send", authorize: f.role === "rwa" && !st.authorized };
  });
}

// ---------------------------------------------------------------------------
// Light per-key rate limit (sliding window, in memory)
// ---------------------------------------------------------------------------

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Records a hit and returns true when `key` is still under the limit. */
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// API shapes (route <-> page)
// ---------------------------------------------------------------------------

export type ClaimResult = {
  role: FaucetRole;
  code: string;
  amount: string;
  status: "sent" | "skipped" | "error";
  hash?: string;
  /** Human message for skipped / error. */
  message?: string;
};

export type ClaimResponse = { ok: boolean; address?: string; results?: ClaimResult[]; error?: string };

export const SKIP_TEXT: Record<"no-trustline" | "already-claimed" | "has-balance", string> = {
  "no-trustline": "no trustline yet (add it first)",
  "already-claimed": "already claimed by this address",
  "has-balance": "you already hold at least the faucet amount",
};
