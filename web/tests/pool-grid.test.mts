// node --test tests/pool-grid.test.mts : grid math + (when present) the contract's test vectors.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceAt, binForPrice, planPosition } from "../lib/poolGrid.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("grid basics at 10 bps", () => {
  assert.equal(priceAt(0, 10), 10_000_000n);
  assert.equal(priceAt(1, 10), 10_010_000n);
  assert.equal(priceAt(-1, 10), 9_990_010n); // 1e7 / 1.001 = 9_990_009.99
  assert.ok(priceAt(20, 10) > 10_200_000n && priceAt(20, 10) < 10_203_000n);
  assert.ok(priceAt(-20, 10) > 9_800_000n && priceAt(-20, 10) < 9_803_000n);
  // monotonic across the whole grid
  let prev = 0n;
  for (let b = -200; b <= 200; b++) {
    const p = priceAt(b, 10);
    assert.ok(p > prev);
    prev = p;
  }
});

test("price <-> bin round trip", () => {
  for (const b of [-200, -37, -1, 0, 1, 25, 200]) assert.equal(binForPrice(Number(priceAt(b, 10)) / 1e7, 10), b);
});

test("ask plan: exact deposit, weights ascending, avg price inside the range", () => {
  const plan = planPosition({ side: "Ask", startPrice: "1.00", endPrice: "1.02", shape: "start", amount: "100", stepBps: 10, feeBps: 30 });
  assert.ok(plan.ok, plan.errors.join());
  assert.equal(plan.bins.reduce((a, b) => a + b.amount, 0n), 1_000_000_000n);
  assert.ok(plan.weights[0] > plan.weights[plan.weights.length - 1]);
  assert.ok(plan.avgPrice! >= plan.bins[0].price && plan.avgPrice! <= plan.bins[plan.bins.length - 1].price);
});

test("bid plan runs downward and puts the 'start' weight on the highest bin", () => {
  const plan = planPosition({ side: "Bid", startPrice: "0.99", endPrice: "0.97", shape: "start", amount: "100", stepBps: 10, feeBps: 30 });
  assert.ok(plan.ok, plan.errors.join());
  assert.ok(plan.weights[plan.weights.length - 1] > plan.weights[0]);
  const wrong = planPosition({ side: "Bid", startPrice: "0.97", endPrice: "0.99", shape: "uniform", amount: "100", stepBps: 10, feeBps: 30 });
  assert.ok(!wrong.ok);
});

test("contract test vectors: BigInt replica matches contracts/lotus_pool/test-vectors.json (skipped until it exists)", (t) => {
  const f = path.resolve(here, "..", "..", "contracts", "lotus_pool", "test-vectors.json");
  if (!fs.existsSync(f)) return t.skip("no test-vectors.json yet");
  // { min_bin, max_bin, steps: { "<step_bps>": [price(min_bin), ..., price(max_bin)] } }
  const raw = JSON.parse(fs.readFileSync(f, "utf8")) as { min_bin: number; max_bin: number; steps: Record<string, number[]> };
  const diffs: string[] = [];
  let checked = 0;
  for (const [step, prices] of Object.entries(raw.steps)) {
    assert.equal(prices.length, raw.max_bin - raw.min_bin + 1, `step ${step}: unexpected length`);
    prices.forEach((p, k) => {
      const bin = raw.min_bin + k;
      const got = priceAt(bin, Number(step));
      checked++;
      if (got !== BigInt(p)) diffs.push(`step ${step} bin ${bin}: ts ${got} vs contract ${p}`);
    });
  }
  assert.ok(checked > 1000, "too few vectors checked");
  assert.deepEqual(diffs.slice(0, 5), [], `BigInt replica differs from the contract on ${diffs.length} of ${checked} prices`);
});
