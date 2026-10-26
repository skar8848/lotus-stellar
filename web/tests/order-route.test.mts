// node --test tests/order-route.test.mts : bins -> SDEX ladder conversion, proximity rule, summary line.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_POSITION_BINS, planPosition, priceAt, MIN_BIN, MAX_BIN } from "../lib/poolGrid.ts";
import {
  MAX_SDEX_LEVELS,
  PROXIMITY_MIN_BINS,
  binsBelowReference,
  ladderFromPlan,
  offerPriceForBin,
  orderSummary,
  pickReference,
  signaturesNeeded,
  yieldGuard,
} from "../lib/orderRoute.ts";

const STEP = 10;
const plan = (side: "Ask" | "Bid", start: string, end: string, amount: string, shape: "uniform" | "start" | "end" = "uniform") =>
  planPosition({ side, startPrice: start, endPrice: end, shape, amount, stepBps: STEP, feeBps: 10 });

test("ask ladder: one offer per bin, exact grid price, same amounts, total preserved", () => {
  const p = plan("Ask", "1", "1.005", "100", "end");
  assert.ok(p.ok, p.errors.join());
  const l = ladderFromPlan(p);
  assert.deepEqual(l.errors, []);
  assert.equal(l.offers.length, p.bins.length);
  assert.equal(l.offers.reduce((a, o) => a + o.sellAmount, 0n), 1_000_000_000n);
  for (const [i, o] of l.offers.entries()) {
    const b = p.bins[i];
    assert.equal(o.bin, b.bin);
    assert.equal(o.sellAmount, b.amount);
    assert.equal(o.priceStroops, priceAt(b.bin, STEP));
    // n/d == p / 1e7 exactly
    assert.equal(BigInt(o.price.n) * 10_000_000n, BigInt(o.price.d) * o.priceStroops);
  }
  // shape "end" for an ask = more size at higher prices
  assert.ok(l.offers[l.offers.length - 1].sellAmount > l.offers[0].sellAmount);
});

test("bid ladder: sells quote at 1/p exactly, amounts in quote", () => {
  const p = plan("Bid", "0.99", "0.97", "20");
  assert.ok(p.ok, p.errors.join());
  const l = ladderFromPlan(p);
  assert.equal(l.offers.reduce((a, o) => a + o.sellAmount, 0n), 200_000_000n);
  for (const o of l.offers) {
    // n/d == 1e7 / p  (LBOND per USDC)
    assert.equal(BigInt(o.price.n) * o.priceStroops, BigInt(o.price.d) * 10_000_000n);
    // base size = quote / p
    assert.ok(o.baseAmount > o.sellAmount); // prices < 1: more LBOND than USDC
  }
});

test("every grid price fits an int32 rational on both sides", () => {
  for (let b = MIN_BIN; b <= MAX_BIN; b++) {
    const p = priceAt(b, STEP);
    for (const side of ["Ask", "Bid"] as const) {
      const r = offerPriceForBin(side, p);
      assert.ok(r.n > 0 && r.d > 0 && r.n <= 2147483647 && r.d <= 2147483647);
    }
  }
});

test("SDEX cap: more than 50 bins is refused (pool allows 64)", () => {
  const wide = plan("Ask", "1", String(Number(priceAt(59, STEP)) / 1e7), "600");
  assert.ok(wide.ok, wide.errors.join());
  assert.equal(wide.bins.length, 60);
  assert.ok(wide.bins.length <= MAX_POSITION_BINS);
  const l = ladderFromPlan(wide);
  assert.equal(l.errors.length, 1);
  assert.match(l.errors[0], new RegExp(String(MAX_SDEX_LEVELS)));
  const ok = ladderFromPlan(plan("Ask", "1", String(Number(priceAt(49, STEP)) / 1e7), "500"));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.offers.length, 50);
});

test("invalid plan gives no offers", () => {
  const l = ladderFromPlan(plan("Ask", "1.01", "1.0", "10"));
  assert.equal(l.offers.length, 0);
  assert.ok(l.errors.length > 0);
});

test("proximity: distance in bins from the top of the range to the reference", () => {
  assert.ok(Math.abs(binsBelowReference(-10, STEP, 1) - 10) < 1e-3);
  assert.ok(Math.abs(binsBelowReference(-1, STEP, 1) - 1) < 1e-3);
  assert.ok(binsBelowReference(3, STEP, 1) < 0);
});

test("proximity rule blocks only Bid + Pool closer than the threshold", () => {
  const ref = 1;
  // exactly PROXIMITY_MIN_BINS below: allowed
  assert.equal(yieldGuard({ side: "Bid", venue: "pool", hiBin: -PROXIMITY_MIN_BINS, stepBps: STEP, refPrice: ref }).blocked, false);
  // one bin closer: blocked
  const g = yieldGuard({ side: "Bid", venue: "pool", hiBin: -PROXIMITY_MIN_BINS + 1, stepBps: STEP, refPrice: ref });
  assert.equal(g.blocked, true);
  assert.match(g.reason ?? "", /Too close to the price/);
  // Ask and SDEX never blocked
  assert.equal(yieldGuard({ side: "Ask", venue: "pool", hiBin: 1, stepBps: STEP, refPrice: ref }).blocked, false);
  assert.equal(yieldGuard({ side: "Bid", venue: "sdex", hiBin: -1, stepBps: STEP, refPrice: ref }).blocked, false);
  // reference moves the rule: at ref = price_at(5), a top bin at -4 is 9 bins below
  const ref5 = Number(priceAt(5, STEP)) / 1e7;
  assert.equal(yieldGuard({ side: "Bid", venue: "pool", hiBin: -4, stepBps: STEP, refPrice: ref5 }).blocked, true);
  assert.equal(yieldGuard({ side: "Bid", venue: "pool", hiBin: -5, stepBps: STEP, refPrice: ref5 }).blocked, false);
});

test("signatures per destination", () => {
  assert.equal(signaturesNeeded({ side: "Bid", venue: "pool", yieldOn: true }), 1);
  assert.equal(signaturesNeeded({ side: "Ask", venue: "sdex", yieldOn: true }), 1);
  assert.equal(signaturesNeeded({ side: "Bid", venue: "sdex", yieldOn: false }), 1);
  assert.equal(signaturesNeeded({ side: "Bid", venue: "sdex", yieldOn: true }), 2);
  assert.equal(signaturesNeeded({ side: "Bid", venue: "sdex", yieldOn: true, needsReceiptTrustline: true }), 3);
});

test("reference price fallbacks", () => {
  assert.equal(pickReference({ receiptMid: 0.995, usdcMid: 1.01, poolMid: 1 }).price, 0.995);
  assert.equal(pickReference({ receiptMid: null, usdcMid: 1.01, poolMid: 1 }).price, 1.01);
  assert.equal(pickReference({ receiptMid: null, usdcMid: null, poolMid: 1.002 }).price, 1.002);
  assert.equal(pickReference({ receiptMid: null, usdcMid: NaN, poolMid: null }).price, 1);
});

test("summary line", () => {
  const s = orderSummary({
    side: "Ask",
    venue: "pool",
    yieldOn: true,
    amount: 1_000_000_000n,
    loPrice: 10_000_000n,
    hiPrice: 10_050_100n,
    baseCode: "LBOND",
    quoteCode: "USDC",
    receiptCode: "lUSDCb",
    yieldName: "Blend yield",
    signatures: 1,
  });
  assert.equal(s, "Sell 100 LBOND from 1.000 to 1.005 · waits in the Lotus pool · earns Blend yield on proceeds · 1 signature");
  const b = orderSummary({
    side: "Bid",
    venue: "sdex",
    yieldOn: true,
    amount: 100_000_000n,
    loPrice: 9_700_000n,
    hiPrice: 9_900_000n,
    baseCode: "LBOND",
    quoteCode: "USDC",
    receiptCode: "lUSDCb",
    yieldName: "Blend yield",
    signatures: 2,
  });
  assert.match(b, /^Buy LBOND with 10 USDC from 0\.990 down to 0\.970 · waits on the SDEX \(LBOND\/lUSDCb\) · deposits 10 USDC for lUSDCb.* · 2 signatures$/);
});
