// node --test tests/faucet.test.mts : faucet asset list from config, trustline state, claim plan, rate limit.
import test from "node:test";
import assert from "node:assert/strict";
import { FAUCET_AMOUNTS, RateLimiter, faucetAssets, lineState, missingTrustlines, planClaim, spendable, stroops, type HBalance } from "../lib/faucet.ts";

const I1 = "G" + "A".repeat(55);
const I2 = "G" + "B".repeat(55);
const I3 = "G" + "C".repeat(55);
const cfg = {
  underlying: { code: "USDC", issuer: I1 },
  rwa: { code: "LBOND", issuer: I2 },
  receipt: { code: "lUSDCb", issuer: I3 },
};
const line = (code: string, issuer: string, balance: string, extra: Partial<HBalance> = {}): HBalance => ({
  asset_type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
  asset_code: code,
  asset_issuer: issuer,
  balance,
  ...extra,
});

test("assets come from the config, in order, with the fixed amounts", () => {
  const a = faucetAssets(cfg);
  assert.deepEqual(a.map((x) => [x.role, x.asset.code, x.asset.issuer, x.amount]), [
    ["underlying", "USDC", I1, "200"],
    ["rwa", "LBOND", I2, "500"],
    ["receipt", "lUSDCb", I3, "50"],
  ]);
  assert.equal(FAUCET_AMOUNTS.rwa, "500");
  // a receipt without a valid issuer is skipped, never invented
  assert.equal(faucetAssets({ ...cfg, receipt: { code: "lUSDC", issuer: null } }).length, 2);
});

test("trustline state and missing list", () => {
  const assets = faucetAssets(cfg);
  const bal: HBalance[] = [{ asset_type: "native", balance: "10000" }, line("LBOND", I2, "0", { is_authorized: false })];
  assert.deepEqual(lineState(bal, cfg.rwa as { code: string; issuer: string }), { has: true, authorized: false, balance: "0" });
  assert.deepEqual(missingTrustlines(bal, assets).map((m) => m.asset.code), ["USDC", "lUSDCb"]);
  assert.equal(missingTrustlines(null, assets).length, 3);
});

test("claim plan: authorize LBOND, skip missing / claimed / already funded", () => {
  const assets = faucetAssets(cfg);
  const bal: HBalance[] = [line("LBOND", I2, "0", { is_authorized: false }), line("USDC", I1, "250"), line("lUSDCb", I3, "10")];
  const plan = planClaim(bal, assets, new Set());
  assert.deepEqual(plan, [
    { role: "underlying", code: "USDC", action: "skip", reason: "has-balance" },
    { role: "rwa", code: "LBOND", action: "send", authorize: true },
    { role: "receipt", code: "lUSDCb", action: "send", authorize: false },
  ]);
  const again = planClaim([line("LBOND", I2, "500", { is_authorized: true })], assets, new Set(["rwa"]));
  assert.deepEqual(again.map((p) => (p.action === "skip" ? p.reason : "send")), ["no-trustline", "already-claimed", "no-trustline"]);
});

test("amounts and spendable balance (offers excluded)", () => {
  assert.equal(stroops("1.5"), 15_000_000n);
  assert.equal(stroops("200"), 2_000_000_000n);
  assert.equal(stroops("abc"), null);
  assert.equal(spendable([line("lUSDCb", I3, "100", { selling_liabilities: "80" })], cfg.receipt as { code: string; issuer: string }), 200_000_000n);
  assert.equal(spendable([], cfg.receipt as { code: string; issuer: string }), 0n);
});

test("rate limiter: sliding window per key", () => {
  let t = 0;
  const rl = new RateLimiter(2, 1000, () => t);
  assert.equal(rl.allow("a"), true);
  assert.equal(rl.allow("a"), true);
  assert.equal(rl.allow("a"), false);
  assert.equal(rl.allow("b"), true);
  t = 1001;
  assert.equal(rl.allow("a"), true);
});
