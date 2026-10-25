// Plain-node tests for the range builder math: `node --test tests/range.test.mts` (npm run test:unit)
import test from "node:test";
import assert from "node:assert/strict";
import { buildRange, offerPrice, crossingCount, chunkOps, shapeWeights } from "../lib/range.ts";
import { toStroops, fromStroops } from "../lib/amount.ts";

const base = { from: "1.00", to: "1.10", levels: 5, totalBase: "100", shape: "uniform" as const };

test("uniform sell: 5 asks, prices evenly spaced, sizes sum exactly", () => {
  const r = buildRange({ ...base, mode: "sell" });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.levels.map((l) => l.price), ["1", "1.025", "1.05", "1.075", "1.1"]);
  assert.ok(r.levels.every((l) => l.side === "ask"));
  assert.equal(r.summary.totalBase, toStroops("100"));
  assert.equal(r.summary.needBase, toStroops("100"));
  assert.equal(r.summary.needQuote, 0n);
  assert.equal(r.summary.reserveXlm, 2.5);
  assert.equal(r.summary.txCount, 1);
});

test("weighted shapes keep the exact total and tilt the right way", () => {
  for (const shape of ["start", "end"] as const) {
    const r = buildRange({ ...base, mode: "sell", shape, totalBase: "100.0000001" });
    assert.equal(r.summary.totalBase, toStroops("100.0000001"));
    const first = r.levels[0].baseAmount;
    const last = r.levels[r.levels.length - 1].baseAmount;
    assert.ok(shape === "start" ? first > last : last > first, shape);
  }
  assert.deepEqual(shapeWeights("start", 4), [4, 3, 2, 1]);
  assert.deepEqual(shapeWeights("end", 4), [1, 2, 3, 4]);
});

test("buy: bids only, sell amount is quote = base * price", () => {
  const r = buildRange({ ...base, mode: "buy", from: "0.95", to: "0.90", totalBase: "100" });
  assert.deepEqual(r.errors, []);
  assert.ok(r.levels.every((l) => l.side === "bid"));
  for (const l of r.levels) assert.equal(l.sellAmount, (l.baseAmount * l.priceStroops + 5_000_000n) / 10_000_000n);
  assert.equal(r.summary.needBase, 0n);
  assert.ok(r.summary.needQuote > 0n);
});

test("band: bids strictly below split, asks at or above", () => {
  const r = buildRange({ ...base, mode: "band", from: "0.90", to: "1.10", levels: 5, split: "1.00" });
  assert.deepEqual(r.levels.map((l) => l.side), ["bid", "bid", "ask", "ask", "ask"]);
  assert.equal(r.summary.bids, 2);
  assert.equal(r.summary.asks, 3);
});

test("offer price: exact reduced rationals for asks and inverted bids", () => {
  assert.deepEqual(offerPrice({ side: "ask", priceStroops: toStroops("0.99") }), { n: 99, d: 100 });
  assert.deepEqual(offerPrice({ side: "bid", priceStroops: toStroops("0.99") }), { n: 100, d: 99 });
  assert.deepEqual(offerPrice({ side: "ask", priceStroops: toStroops("1") }), { n: 1, d: 1 });
});

test("validation", () => {
  assert.ok(buildRange({ ...base, mode: "sell", levels: 1 }).errors.length > 0);
  assert.ok(buildRange({ ...base, mode: "sell", levels: 51 }).errors.length > 0);
  assert.ok(buildRange({ ...base, mode: "sell", from: "1", to: "1" }).errors.length > 0);
  assert.ok(buildRange({ ...base, mode: "sell", totalBase: "0" }).errors.length > 0);
  assert.ok(buildRange({ ...base, mode: "sell", totalBase: "0.0000003", levels: 10 }).errors.length > 0);
});

test("crossing detection and chunking", () => {
  const r = buildRange({ ...base, mode: "sell" });
  assert.equal(crossingCount(r.levels, 1.06, null), 3); // asks at 1, 1.025, 1.05 sit under a 1.06 bid
  assert.equal(crossingCount(r.levels, null, null), 0);
  assert.deepEqual(chunkOps([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(chunkOps(Array.from({ length: 250 }, (_, i) => i), 100).length, 3);
  assert.equal(fromStroops(toStroops("12.5")), "12.5");
});
