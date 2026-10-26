import { test } from "node:test";
import assert from "node:assert/strict";
import { aprFromSamples, pushSample, sampleFromReserve } from "../lib/yieldRate.ts";

test("APR from two b_rate samples matches the observed_apr window B figures", () => {
  // deployments/testnet.contract.json observed_apr.window_b: 900 s, 6.9141% gross
  const a = { bRate: 1059005036323n, time: 1792963202 };
  const b = { bRate: 1059007125944n, time: 1792964102 };
  const apr = aprFromSamples(a, b);
  assert.ok(apr !== null);
  assert.ok(Math.abs(apr - 6.9141) < 0.001, `got ${apr}`);
});

test("too-short or inverted windows give null", () => {
  assert.equal(aprFromSamples({ bRate: 1n, time: 10 }, { bRate: 2n, time: 15 }), null);
  assert.equal(aprFromSamples({ bRate: 5n, time: 10 }, { bRate: 4n, time: 100 }), null);
  assert.equal(aprFromSamples({ bRate: 0n, time: 10 }, { bRate: 4n, time: 100 }), null);
});

test("pushSample keeps the first sample and the latest newer one", () => {
  let s = pushSample({ first: null, last: null }, { bRate: 1n, time: 1 });
  s = pushSample(s, { bRate: 2n, time: 5 });
  s = pushSample(s, { bRate: 2n, time: 5 });
  assert.deepEqual(s, { first: { bRate: 1n, time: 1 }, last: { bRate: 2n, time: 5 } });
});

test("sampleFromReserve decodes get_reserve", () => {
  assert.deepEqual(sampleFromReserve({ data: { b_rate: 7n, last_time: 9n } }), { bRate: 7n, time: 9 });
  assert.equal(sampleFromReserve({}), null);
});
