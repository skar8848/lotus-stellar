// node --test tests/offer-groups.test.mts : open SDEX offers -> order rows (one range row per ladder transaction),
// and the decoding of the creating transaction (result_xdr offer ids + envelope initial amounts).
import test from "node:test";
import assert from "node:assert/strict";
import { describeOffer, earnTag, emptyOrigins, groupOffers, rangeLocked, type OfferTx, type OriginIndex } from "../lib/offerGroups.ts";
import { parseOfferTx } from "../lib/offerOrigin.ts";
import type { Market } from "../lib/markets.ts";
import type { HorizonOffer } from "../lib/stellar.ts";

const I1 = "G" + "A".repeat(55);
const I2 = "G" + "B".repeat(55);
const I3 = "G" + "C".repeat(55);
const USDC = { code: "USDC", issuer: I1 };
const LBOND = { code: "LBOND", issuer: I2 };
const RCPT = { code: "lUSDCb", issuer: I3 };
const mk = (base: typeof USDC, quote: typeof USDC, kind: Market["kind"]): Market =>
  ({ id: `${base.code}-${quote.code}`, label: `${base.code}/${quote.code}`, base, quote, kind, strategyId: "s", strategyLabel: "s", receipt: RCPT, underlying: USDC, blurb: "" }) as Market;
const CASH = mk(LBOND, USDC, "cash");
const BOND = mk(LBOND, RCPT, "bond");
const MARKETS = [BOND, CASH];
const f = (a: typeof USDC) => ({ asset_type: a.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12", asset_code: a.code, asset_issuer: a.issuer });
const key = (a: typeof USDC) => `${a.code}:${a.issuer}`;
const offer = (id: string, sell: typeof USDC, buy: typeof USDC, amount: string, price: string): HorizonOffer =>
  ({ id, seller: I1, selling: f(sell), buying: f(buy), amount, price, price_r: { n: 1, d: 1 } }) as HorizonOffer;

test("offers created by one transaction on one pair are one range row; the rest stay single", () => {
  const ladder: OfferTx = {
    hash: "aa".repeat(32),
    createdAt: "2026-10-26T08:00:00Z",
    created: [
      { offerId: "11", selling: key(LBOND), buying: key(USDC), initial: 10 },
      { offerId: "12", selling: key(LBOND), buying: key(USDC), initial: 10 },
      { offerId: "13", selling: key(LBOND), buying: key(USDC), initial: 10 },
      // same tx, other pair: its own group
      { offerId: "20", selling: key(USDC), buying: key(LBOND), initial: 5 },
    ],
  };
  const idx: OriginIndex = { ...emptyOrigins(), byOffer: new Map([["11", ladder], ["12", ladder], ["13", ladder], ["20", ladder]]) };
  const offers = [
    offer("5", LBOND, USDC, "3", "1.5"), // unknown origin
    offer("13", LBOND, USDC, "10", "1.02"),
    offer("11", LBOND, USDC, "4", "1.00"), // partly filled
    offer("12", LBOND, USDC, "10", "1.01"),
    offer("20", USDC, LBOND, "5", "1.0204"),
  ];
  const rows = groupOffers(offers.map((o) => describeOffer(o, MARKETS)), idx);
  assert.deepEqual(rows.map((r) => r.kind), ["single", "range", "single"]);
  const [single, range, bid] = rows;
  assert.equal(single.kind === "single" && single.tx, null);
  assert.ok(range.kind === "range");
  assert.equal(range.market?.id, CASH.id);
  assert.equal(range.side, "Ask");
  assert.deepEqual(range.offers.map((d) => d.offer.id), ["11", "12", "13"]);
  assert.equal(range.lo, 1);
  assert.equal(range.hi, 1.02);
  assert.equal(range.open, 3);
  assert.equal(range.levels, 3);
  assert.equal(range.size, 24);
  assert.ok(Math.abs(range.total - (4 + 10.1 + 10.2)) < 1e-9);
  assert.ok(Math.abs((range.filledPct ?? -1) - 20) < 1e-9); // 24 of 30 left
  // a lone offer of the tx on its pair is a single row, with its tx and fill
  assert.ok(bid.kind === "single");
  assert.equal(bid.d.side, "Bid");
  assert.equal(bid.tx?.hash, ladder.hash);
  assert.equal(bid.filledPct, 0);
  assert.equal(rangeLocked(range), false);
});

test("filled levels count, cancelled levels do not; an updated offer makes the fill unknown", () => {
  const tx: OfferTx = {
    hash: "bb".repeat(32),
    createdAt: "2026-10-26T08:00:00Z",
    created: ["1", "2", "3", "4", null].map((id) => ({ offerId: id, selling: key(LBOND), buying: key(RCPT), initial: 10 })),
  };
  const idx: OriginIndex = { byOffer: new Map(["1", "2", "3", "4"].map((id) => [id, tx])), cancelled: new Set(["4"]), updated: new Set() };
  // 1 and 2 still open, 3 filled and gone, 4 cancelled, the 5th crossed at creation (no id)
  const ds = [offer("1", LBOND, RCPT, "10", "1.01"), offer("2", LBOND, RCPT, "5", "1.02")].map((o) => describeOffer(o, MARKETS));
  const [r] = groupOffers(ds, idx);
  assert.ok(r.kind === "range");
  assert.equal(r.open, 2);
  assert.equal(r.levels, 4);
  assert.equal(r.filledPct, (1 - 15 / 40) * 100);
  // receipt-quoted range (DEX + Blend yield): locked, tagged
  assert.equal(rangeLocked(r), true);
  assert.equal(earnTag(r.market, r.side)?.label, "proceeds earn");
  idx.updated.add("2");
  const [u] = groupOffers(ds, idx);
  assert.equal(u.kind === "range" && u.filledPct, null);
});

test("no origin index: every offer is a single row, in Horizon order", () => {
  const ds = [offer("9", LBOND, USDC, "1", "1"), offer("10", USDC, LBOND, "1", "1"), offer("11", USDC, RCPT, "1", "1")].map((o) => describeOffer(o, MARKETS));
  const rows = groupOffers(ds, null);
  assert.deepEqual(rows.map((r) => (r.kind === "single" ? r.d.offer.id : "?")), ["9", "10", "11"]);
  assert.deepEqual(rows.map((r) => (r.kind === "single" ? r.d.side : "?")), ["Ask", "Bid", "Offer"]);
  assert.equal(rows.some(rangeLocked), false);
  assert.equal(earnTag(CASH, "Bid"), null);
  assert.equal(earnTag(BOND, "Bid")?.label, "earns");
});

// a real testnet transaction: 5 manageSellOffer LBOND -> lUSDCb, 100 each at 0.98 .. 1.02
const FIXTURE = {
  "hash": "c4ce3c16fed009534427f68364d7eabe179910fa30d69ab5cacc578385f5d231",
  "created_at": "2026-10-25T21:47:52Z",
  "envelope_xdr": "AAAAAgAAAACTSPviRv8i9gPYMRqCMdyqWaGwOGRTIFLJD3Hmug5JDgAAE4gAUi8sAAAAcQAAAAEAAAAAAAAAAAAAAABq3nm3AAAAAQAAABFsb3R1cyBib25kIGxhZGRlcgAAAAAAAAUAAAAAAAAAAwAAAAJMQk9ORAAAAAAAAAAAAAAAmNRvenEyvQKhUmo86Q+JLMJiJGmKWpDXlxNb0skiAT4AAAACbFVTRENiAAAAAAAAAAAAAL8A5HpbH5zsM+ZWp+KR1syVT58K8JUy9Md1tnzsoafuAAAAADuaygAAAABiAAAAZAAAAAAAAAAAAAAAAAAAAAMAAAACTEJPTkQAAAAAAAAAAAAAAJjUb3pxMr0CoVJqPOkPiSzCYiRpilqQ15cTW9LJIgE+AAAAAmxVU0RDYgAAAAAAAAAAAAC/AOR6Wx+c7DPmVqfikdbMlU+fCvCVMvTHdbZ87KGn7gAAAAA7msoAAAAAYwAAAGQAAAAAAAAAAAAAAAAAAAADAAAAAkxCT05EAAAAAAAAAAAAAACY1G96cTK9AqFSajzpD4kswmIkaYpakNeXE1vSySIBPgAAAAJsVVNEQ2IAAAAAAAAAAAAAvwDkelsfnOwz5lan4pHWzJVPnwrwlTL0x3W2fOyhp+4AAAAAO5rKAAAAAGQAAABkAAAAAAAAAAAAAAAAAAAAAwAAAAJMQk9ORAAAAAAAAAAAAAAAmNRvenEyvQKhUmo86Q+JLMJiJGmKWpDXlxNb0skiAT4AAAACbFVTRENiAAAAAAAAAAAAAL8A5HpbH5zsM+ZWp+KR1syVT58K8JUy9Md1tnzsoafuAAAAADuaygAAAABlAAAAZAAAAAAAAAAAAAAAAAAAAAMAAAACTEJPTkQAAAAAAAAAAAAAAJjUb3pxMr0CoVJqPOkPiSzCYiRpilqQ15cTW9LJIgE+AAAAAmxVU0RDYgAAAAAAAAAAAAC/AOR6Wx+c7DPmVqfikdbMlU+fCvCVMvTHdbZ87KGn7gAAAAA7msoAAAAAZgAAAGQAAAAAAAAAAAAAAAAAAAABug5JDgAAAEC830lfF0iDIR+EeGxAksLsCMW+c36snMYBNmYkPGV4R6cbH7i67FVxpvwF+eb/0tVqXAcr8/pIyZgvMTpuO1sJ",
  "result_xdr": "AAAAAAAAAfQAAAAAAAAABQAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAJNI++JG/yL2A9gxGoIx3KpZobA4ZFMgUskPcea6DkkOAAAAAAAON6YAAAACTEJPTkQAAAAAAAAAAAAAAJjUb3pxMr0CoVJqPOkPiSzCYiRpilqQ15cTW9LJIgE+AAAAAmxVU0RDYgAAAAAAAAAAAAC/AOR6Wx+c7DPmVqfikdbMlU+fCvCVMvTHdbZ87KGn7gAAAAA7msoAAAAAYgAAAGQAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAJNI++JG/yL2A9gxGoIx3KpZobA4ZFMgUskPcea6DkkOAAAAAAAON6cAAAACTEJPTkQAAAAAAAAAAAAAAJjUb3pxMr0CoVJqPOkPiSzCYiRpilqQ15cTW9LJIgE+AAAAAmxVU0RDYgAAAAAAAAAAAAC/AOR6Wx+c7DPmVqfikdbMlU+fCvCVMvTHdbZ87KGn7gAAAAA7msoAAAAAYwAAAGQAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAJNI++JG/yL2A9gxGoIx3KpZobA4ZFMgUskPcea6DkkOAAAAAAAON6gAAAACTEJPTkQAAAAAAAAAAAAAAJjUb3pxMr0CoVJqPOkPiSzCYiRpilqQ15cTW9LJIgE+AAAAAmxVU0RDYgAAAAAAAAAAAAC/AOR6Wx+c7DPmVqfikdbMlU+fCvCVMvTHdbZ87KGn7gAAAAA7msoAAAAAZAAAAGQAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAJNI++JG/yL2A9gxGoIx3KpZobA4ZFMgUskPcea6DkkOAAAAAAAON6kAAAACTEJPTkQAAAAAAAAAAAAAAJjUb3pxMr0CoVJqPOkPiSzCYiRpilqQ15cTW9LJIgE+AAAAAmxVU0RDYgAAAAAAAAAAAAC/AOR6Wx+c7DPmVqfikdbMlU+fCvCVMvTHdbZ87KGn7gAAAAA7msoAAAAAZQAAAGQAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAJNI++JG/yL2A9gxGoIx3KpZobA4ZFMgUskPcea6DkkOAAAAAAAON6oAAAACTEJPTkQAAAAAAAAAAAAAAJjUb3pxMr0CoVJqPOkPiSzCYiRpilqQ15cTW9LJIgE+AAAAAmxVU0RDYgAAAAAAAAAAAAC/AOR6Wx+c7DPmVqfikdbMlU+fCvCVMvTHdbZ87KGn7gAAAAA7msoAAAAAZgAAAGQAAAAAAAAAAAAAAAA="
};

test("parseOfferTx reads the created offer ids and initial amounts", () => {
  const p = parseOfferTx(FIXTURE);
  assert.ok(p);
  assert.equal(p.hash, FIXTURE.hash);
  assert.equal(p.created.length, 5);
  assert.ok(p.created.every((c) => c.offerId && /^\d+$/.test(c.offerId) && c.initial === 100 && c.selling.startsWith("LBOND:") && c.buying.startsWith("lUSDCb:")));
  assert.equal(new Set(p.created.map((c) => c.offerId)).size, 5);
  assert.ok(p.created.some((c) => c.offerId === "931753"));
  assert.deepEqual(p.cancelled, []);
});
