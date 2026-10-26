// node --test test/  (after npm run build): pure parts of the SDK, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair, Networks, TransactionBuilder, Account, Operation, Asset, xdr, scValToNative } from "@stellar/stellar-sdk";
import {
  STRATEGIES,
  buildMarkets,
  classifyFailure,
  decodePosition,
  decodeQuote,
  directionalPools,
  evaluate,
  explainPoolError,
  findMarket,
  fromSecret,
  ladderFromPlan,
  modeArg,
  orderEnv,
  parseDeployments,
  planPosition,
  priceArg,
  priceAt,
  redeemEstimate,
  sideArg,
  weightsArg,
  PROXIMITY_MIN_BINS,
  isSorobanTx,
  parseTx,
  aprFromSamples,
} from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const DEP = path.join(ROOT, "deployments");
const readDep = (f) => (fs.existsSync(path.join(DEP, f)) ? JSON.parse(fs.readFileSync(path.join(DEP, f), "utf8")) : null);

test("shared files are byte-identical to web/lib (no divergence from the app)", { skip: !fs.existsSync(path.join(ROOT, "web", "lib")) }, () => {
  execFileSync(process.execPath, [path.join(here, "..", "scripts", "sync-shared.mjs"), "--check"], { stdio: "pipe" });
});

test("priceAt matches contracts/lotus_pool/test-vectors.json for every bin and step", { skip: !fs.existsSync(path.join(ROOT, "contracts/lotus_pool/test-vectors.json")) }, () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/lotus_pool/test-vectors.json"), "utf8"));
  let n = 0;
  for (const [step, prices] of Object.entries(v.steps)) {
    prices.forEach((p, k) => {
      assert.equal(priceAt(v.min_bin + k, Number(step)), BigInt(p), `step ${step} bin ${v.min_bin + k}`);
      n++;
    });
  }
  assert.ok(n > 2000);
});

const cfg = parseDeployments({
  contract: readDep("testnet.contract.json"),
  classic: readDep("testnet.classic.json"),
  strategies: readDep("testnet.strategies.json"),
  pools: readDep("testnet.pool.json"),
});

test("parseDeployments reads the public deployment files like the app", { skip: !readDep("testnet.contract.json") }, () => {
  assert.equal(cfg.passphrase, Networks.TESTNET);
  assert.match(cfg.lotusVault, /^C[A-Z2-7]{55}$/);
  assert.ok(cfg.pools.length >= 2);
  assert.ok(cfg.pools.every((p) => p.status !== "retired"));
  const { idle, vaulted } = directionalPools(cfg.pools);
  assert.ok(idle && !idle.vault);
  assert.ok(vaulted && vaulted.vault);
  for (const v of Object.values(cfg.accounts)) assert.match(v, /^G[A-Z2-7]{55}$/); // public keys only
});

test("markets: bond / peg / cash ids, findMarket accepts / and the old peg id", { skip: !readDep("testnet.contract.json") }, () => {
  const ms = buildMarkets(cfg);
  const r = cfg.receipt.code;
  assert.equal(ms[0].id, `LBOND-${r}`);
  assert.equal(ms[1].id, `${r}-USDC`);
  assert.equal(ms[2].id, "LBOND-USDC");
  assert.equal(findMarket(ms, `LBOND/${r}`)?.kind, "bond");
  assert.equal(findMarket(ms, `USDC-${r}`)?.kind, "peg");
  assert.equal(findMarket(ms, "nope"), null);
});

test("priceArg: exact rationals, inverted for bids", () => {
  assert.deepEqual(priceArg("1.001"), { n: 1001, d: 1000 });
  assert.deepEqual(priceArg("1.001", true), { n: 1000, d: 1001 });
  assert.deepEqual(priceArg("0.5"), { n: 1, d: 2 });
});

test("encoders: Side / Mode travel as Vec[Symbol], weights as Vec<u32>", () => {
  assert.deepEqual(scValToNative(sideArg("Ask")), ["Ask"]);
  assert.deepEqual(scValToNative(modeArg("Directional")), ["Directional"]);
  assert.deepEqual(scValToNative(weightsArg([1, 2])), [1, 2]);
});

test("decoders: position and quote", () => {
  const p = decodePosition({ id: 7n, owner: "G", side: ["Bid"], mode: ["Directional"], lo_bin: -5, hi_bin: -1, deposited: 10n, inventory: 4n, filled: 6n, pending_proceeds: 3n, pending_fees: 1n, vaulted: true });
  assert.equal(p.side, "Bid");
  assert.equal(p.loBin, -5);
  assert.equal(p.vaulted, true);
  const q = decodeQuote({ amount_out: 5n, fee: 1n, avg_price: 10_010_000n, bins_crossed: 2, partial: false });
  assert.equal(q.amountOut, 5n);
  assert.equal(q.binsCrossed, 2);
  assert.match(explainPoolError("HostError: Error(Contract, #9)"), /SlippageExceeded/);
});

// ---- range-order evaluation (port of useOrder.ts evaluate) -----------------------------------------------------
const G = Keypair.random().publicKey();
const acct = (lines) => ({
  id: G,
  sequence: "1",
  subentry_count: lines.length,
  balances: [
    ...lines.map(([a, bal, auth = true]) => ({ asset_type: a.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12", asset_code: a.code, asset_issuer: a.issuer, balance: bal, selling_liabilities: "0", is_authorized: auth })),
    { asset_type: "native", balance: "100" },
  ],
});
const top = (bid, ask) => ({ bid, ask });
const mkt = { usdc: top(0.999, 1.001), receipt: top(0.999, 1.001), pool: { idle: top(0.999, 1.001), vaulted: top(0.999, 1.001) } };
const dest = (env, plan, id) => evaluate(env, plan, 10, mkt, STRATEGIES.find((s) => s.id === id));

test("evaluate: an Ask below the price breaks the direction rule on every venue", { skip: !readDep("testnet.contract.json") }, () => {
  const { base, quote, receipt } = orderEnv(cfg, null, planPosition({ side: "Ask", startPrice: "1", endPrice: "1", shape: "uniform", amount: "1", stepBps: 10, feeBps: 10 }));
  const a = acct([[base, "100"], [quote, "100"], [receipt, "100"]]);
  const plan = planPosition({ side: "Ask", startPrice: "0.99", endPrice: "0.995", shape: "uniform", amount: "10", stepBps: 10, feeBps: 10 });
  const env = orderEnv(cfg, a, plan);
  for (const s of STRATEGIES) assert.match(dest(env, plan, s.id).unavailable ?? "", /at or above/);
  const ok = planPosition({ side: "Ask", startPrice: "1.01", endPrice: "1.02", shape: "uniform", amount: "10", stepBps: 10, feeBps: 10 });
  const env2 = orderEnv(cfg, a, ok);
  for (const s of STRATEGIES) assert.equal(dest(env2, ok, s.id).blockedBy, null, s.id);
  assert.equal(dest(env2, ok, "sdex").signatures, 1);
  assert.equal(env2.ladder.offers.length, ok.bins.length);
});

test("evaluate: curator rule blocks a Bid near the price on pool-yield only", { skip: !readDep("testnet.contract.json") }, () => {
  const { base, quote, receipt } = orderEnv(cfg, null, planPosition({ side: "Bid", startPrice: "1", endPrice: "1", shape: "uniform", amount: "1", stepBps: 10, feeBps: 10 }));
  const a = acct([[base, "100"], [quote, "100"], [receipt, "100"]]);
  const near = planPosition({ side: "Bid", startPrice: "0.997", endPrice: "0.99", shape: "uniform", amount: "10", stepBps: 10, feeBps: 10 });
  const env = orderEnv(cfg, a, near);
  assert.equal(dest(env, near, "pool-yield").unavailable, "Too close to the price");
  assert.equal(dest(env, near, "pool").unavailable, null);
  assert.equal(dest(env, near, "sdex-yield").signatures, 2);
  const far = planPosition({ side: "Bid", startPrice: "0.985", endPrice: "0.98", shape: "uniform", amount: "10", stepBps: 10, feeBps: 10 });
  assert.ok(far.hiBin <= -PROXIMITY_MIN_BINS - 1);
  assert.equal(dest(orderEnv(cfg, a, far), far, "pool-yield").unavailable, null);
});

test("evaluate: missing / unauthorized LBOND trustline and balance checks", { skip: !readDep("testnet.contract.json") }, () => {
  const plan = planPosition({ side: "Ask", startPrice: "1.01", endPrice: "1.02", shape: "uniform", amount: "10", stepBps: 10, feeBps: 10 });
  const { base, quote } = orderEnv(cfg, null, plan);
  assert.match(dest(orderEnv(cfg, acct([[quote, "1"]]), plan), plan, "pool").blockedBy, /LBOND trustline needed/);
  assert.match(dest(orderEnv(cfg, acct([[base, "100", false], [quote, "1"]]), plan), plan, "pool").blockedBy, /not authorized/);
  assert.match(dest(orderEnv(cfg, acct([[base, "5"], [quote, "1"]]), plan), plan, "pool").blockedBy, /Insufficient LBOND/);
  const sd = dest(orderEnv(cfg, acct([[base, "100"]]), plan), plan, "sdex");
  assert.equal(sd.blockedBy, null);
  assert.deepEqual(sd.addTrust.map((x) => x.code), ["USDC"]); // proceeds trustline bundled in front of the offers
});

test("ladder: > 50 bins is refused on the SDEX", () => {
  const p = planPosition({ side: "Ask", startPrice: "1.0", endPrice: "1.06", shape: "uniform", amount: "100", stepBps: 10, feeBps: 10 });
  assert.ok(p.ok);
  assert.ok(ladderFromPlan(p).errors.length > 0);
});

test("failure classification: footprint race vs other", () => {
  assert.equal(classifyFailure({ txCode: "txFailed", detail: "Error(Storage, ExceededLimit)" }), "footprint");
  assert.equal(classifyFailure({ txCode: "txBadSeq" }), "bad-seq");
  assert.equal(classifyFailure({ txCode: "txFailed", detail: "Error(Contract, #9)" }), "other");
});

test("redeemEstimate: par while backed, pro rata otherwise", () => {
  assert.equal(redeemEstimate(100n, 1000n, 900n), 100n);
  assert.equal(redeemEstimate(100n, 900n, 1000n), 90n);
  assert.equal(redeemEstimate(100n, null, 1000n), null);
});

test("apr from two b_rate samples", () => {
  const r = aprFromSamples({ bRate: 1_000_000_000_000n, time: 0 }, { bRate: 1_000_000_100_000n, time: 100 });
  assert.ok(r > 3 && r < 3.3);
});

test("fromSecret: signs testnet only, never exposes the secret", async () => {
  const kp = Keypair.random();
  const signer = fromSecret(kp.secret());
  assert.equal(signer.publicKey, kp.publicKey());
  assert.ok(!JSON.stringify(signer).includes(kp.secret()));
  const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", Keypair.random().publicKey()) }))
    .setTimeout(30)
    .build();
  const signed = await signer.sign(tx.toXDR(), Networks.TESTNET);
  const parsed = parseTx(signed, Networks.TESTNET);
  assert.equal(parsed.signatures.length, 1);
  assert.equal(isSorobanTx(parsed), false);
  await assert.rejects(signer.sign(tx.toXDR(), Networks.PUBLIC), /testnet/);
  assert.throws(() => fromSecret("nope"), (e) => !String(e.message).includes("nope"));
});
