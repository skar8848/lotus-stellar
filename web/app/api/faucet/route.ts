import { NextResponse, type NextRequest } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { loadConfig } from "@/lib/config";
import { faucetAssets, planClaim, RateLimiter, SKIP_TEXT, spendable, stroops, type ClaimResponse, type ClaimResult, type FaucetRole, type HBalance } from "@/lib/faucet";
import { faucetKeypair, fundingOps, horizonError, isTestnet, scrub, sendClassic } from "@/lib/faucet-server";

// Testnet faucet. POST { address } -> authorizes the LBOND trustline and sends LBOND, USDC and the active
// Lotus receipt from server-held demo keys (lib/faucet-server.ts). Testnet only, one claim per address and
// asset (in memory: resets on a server restart, backed by the "already holds the amount" check), light
// per-IP rate limit. GET -> whether the faucet is configured (no keys, public info only).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FaucetState = {
  claimed: Map<string, Set<FaucetRole>>;
  inflight: Set<string>;
  perIp: RateLimiter;
  global: RateLimiter;
};
// globalThis so the record survives dev hot reloads of this module.
const g = globalThis as unknown as { __lotusFaucet?: FaucetState };
const state: FaucetState = (g.__lotusFaucet ??= {
  claimed: new Map(),
  inflight: new Set(),
  perIp: new RateLimiter(6, 10 * 60_000),
  global: new RateLimiter(120, 60 * 60_000),
});

const json = (body: ClaimResponse | Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function horizonAccount(horizon: string, id: string): Promise<{ balances: HBalance[] } | null> {
  const r = await fetch(`${horizon}/accounts/${id}`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Horizon HTTP ${r.status}`);
  return (await r.json()) as { balances: HBalance[] };
}

export function GET() {
  const config = loadConfig();
  const testnet = isTestnet(config.passphrase);
  const assets = faucetAssets(config).map((f) => {
    const kp = testnet ? faucetKeypair(f.role) : null;
    // the LBOND key must be the issuer (it authorizes the trustline)
    const ok = !!kp && (f.role !== "rwa" || kp.publicKey() === f.asset.issuer);
    return { role: f.role, code: f.asset.code, amount: f.amount, configured: ok, source: ok && kp ? kp.publicKey() : null };
  });
  return json({ ok: true, testnet, enabled: testnet && assets.some((a) => a.configured), assets });
}

export async function POST(req: NextRequest) {
  const config = loadConfig();
  if (!isTestnet(config.passphrase)) return json({ ok: false, error: "The faucet only runs on Stellar testnet." }, 403);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  if (!state.perIp.allow(ip)) return json({ ok: false, error: "Too many faucet requests from your network, wait a few minutes." }, 429);
  if (!state.global.allow("all")) return json({ ok: false, error: "The faucet is busy (hourly limit reached), try again later." }, 429);

  let address = "";
  try {
    const body = (await req.json()) as { address?: unknown };
    address = typeof body.address === "string" ? body.address.trim() : "";
  } catch {
    /* empty / invalid body */
  }
  if (!StrKey.isValidEd25519PublicKey(address)) return json({ ok: false, error: "Not a valid Stellar account address (G...)." }, 400);

  if (state.inflight.has(address)) return json({ ok: false, error: "A claim for this address is already running." }, 409);
  state.inflight.add(address);
  try {
    const assets = faucetAssets(config);
    if (assets.length === 0) return json({ ok: false, error: "No faucet assets in the deployment config." }, 500);

    let acct: { balances: HBalance[] } | null;
    try {
      acct = await horizonAccount(config.horizon, address);
    } catch (e) {
      return json({ ok: false, error: `Horizon unavailable: ${horizonError(e)}` }, 502);
    }
    if (!acct) return json({ ok: false, error: "This account does not exist on testnet yet: fund it with Friendbot first." }, 400);

    const claimed = state.claimed.get(address) ?? new Set<FaucetRole>();
    const plan = planClaim(acct.balances, assets, claimed);
    if (plan.every((p) => p.action === "skip" && p.reason === "no-trustline")) {
      return json({ ok: false, error: "Add the trustlines first (step 2): the account cannot receive any of the assets yet." }, 400);
    }

    const results: ClaimResult[] = await Promise.all(
      plan.map(async (step): Promise<ClaimResult> => {
        const f = assets.find((a) => a.role === step.role)!;
        const base = { role: f.role, code: f.asset.code, amount: f.amount };
        if (step.action === "skip") return { ...base, status: "skipped", message: SKIP_TEXT[step.reason] };

        const kp = faucetKeypair(f.role);
        if (!kp) return { ...base, status: "error", message: `the faucet has no key for ${f.asset.code} on this server` };
        if (f.role === "rwa" && kp.publicKey() !== f.asset.issuer) {
          return { ...base, status: "error", message: `the ${f.asset.code} key on this server is not the asset issuer` };
        }
        try {
          if (f.role !== "rwa") {
            // the issuer mints; any other source must hold the amount outside its open offers
            const src = await horizonAccount(config.horizon, kp.publicKey());
            if (!src) return { ...base, status: "error", message: `the faucet account for ${f.asset.code} does not exist on testnet` };
            const have = spendable(src.balances, f.asset);
            if (have < (stroops(f.amount) ?? 0n)) {
              return { ...base, status: "error", message: `the faucet is empty for ${f.asset.code} (its source account has less than ${f.amount} available), ask the team to refill it` };
            }
          }
          const hash = await sendClassic(config.horizon, config.passphrase, kp, fundingOps({ destination: address, asset: f.asset, amount: f.amount, authorize: step.authorize }));
          const set = state.claimed.get(address) ?? new Set<FaucetRole>();
          set.add(f.role);
          state.claimed.set(address, set);
          return { ...base, status: "sent", hash, message: step.authorize ? "trustline authorized by the issuer" : undefined };
        } catch (e) {
          const code = horizonError(e);
          const hint = /op_underfunded/.test(code) ? ` (the faucet is empty for ${f.asset.code}, ask the team to refill it)` : /tx_insufficient_balance/.test(code) ? " (the faucet account is out of XLM for fees)" : "";
          return { ...base, status: "error", message: scrub(`transaction failed: ${code}${hint}`) };
        }
      }),
    );

    const sent = results.filter((r) => r.status === "sent").length;
    const errors = results.filter((r) => r.status === "error").length;
    const error = sent > 0 ? undefined : errors > 0 ? "Nothing was sent, see the reason per asset." : "Nothing to send: every asset was skipped.";
    return json({ ok: sent > 0, address, results, error });
  } finally {
    state.inflight.delete(address);
  }
}
