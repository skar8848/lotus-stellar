// /pools "New position": reference price and "crosses the book" checks per strategy, through the real UI with the
// dev wallet on testnet. UI only: nothing is signed (the review modal is opened, then closed).
//   1. ask-preset-no-cross   Ask + "Just above" before a strategy is chosen: reference = highest strategy reference,
//                            no strategy card warns about crossing
//   2. bid-preset-no-cross   Bid + "Just below": reference = lowest strategy reference, no card warns
//   3. direction-rule-clamps a sell min typed under the price / a buy max above it is clamped, with a note
//   4. pool-crossing-warned  Lotus pool chosen, ask from the pool price while the pool is under the LBOND/USDC bids:
//                            the pool card and the review modal warn (skipped when the market does not allow it)
//   5. reference-follows-strategy  once Stellar DEX is chosen, the range step prices from LBOND/USDC
// The full create / list / cleanup flows on the four strategies are e2e/position-flows.mjs.
// Usage: BASE_URL=http://localhost:3700 node e2e/order-flows.mjs   (WHO=taker by default)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.SHOTS || path.resolve(here, "..", ".screenshots");
const resultsDir = path.resolve(here, "results");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });
const HORIZON = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const WHO = process.env.WHO || "taker";
const STRATS = ["pool", "pool-yield", "sdex", "sdex-yield"];

const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

const cfgRes = await fetch(`${BASE_URL}/api/config`).catch(() => null);
if (!cfgRes?.ok) {
  console.error(`cannot reach ${BASE_URL}/api/config: is the dev server running?`);
  process.exit(2);
}
const cfg = await cfgRes.json();
const pool0 = cfg.pools.find((p) => p.status !== "retired" && p.status !== "coming-soon") ?? cfg.pools[0];
const base = pool0.base;
const quote = pool0.quote;

const assetQs = (prefix, a) =>
  a.code === "XLM"
    ? `${prefix}_asset_type=native`
    : `${prefix}_asset_type=${a.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12"}&${prefix}_asset_code=${a.code}&${prefix}_asset_issuer=${a.issuer}`;
async function bestBid(b, q) {
  const r = await fetch(`${HORIZON}/order_book?${assetQs("selling", b)}&${assetQs("buying", q)}&limit=1`);
  const j = await r.json();
  return j.bids?.[0] ? Number(j.bids[0].price) : null;
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !/MetaMask|Transport request timed out/.test(m.text())) consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 300)));

await page.goto(`${BASE_URL}/pools`, { waitUntil: "domcontentloaded" });
if ((await page.locator('[data-testid="wallet-button"]').count()) === 0) {
  await page.click('[data-testid="wallet-connect"]');
  await page.click(`[data-testid="dev-wallet-${WHO}"]`);
}
await page.waitForSelector('[data-testid="wallet-button"]');
await page.waitForTimeout(8000); // books + pool depth polled

async function refs() {
  const el = page.locator('[data-testid="np-step-2"]');
  const out = { ref: Number(await el.getAttribute("data-ref")) };
  for (const s of STRATS) out[s] = Number(await el.getAttribute(`data-ref-${s}`));
  out.source = await page.locator('[data-testid="np-ref-source"]').innerText();
  return out;
}

async function toStep2(side) {
  await page.click('[data-testid="np-reset"]');
  await page.click(`[data-testid="np-side-${side.toLowerCase()}"]`);
  await page.click('[data-testid="np-continue-1"]');
  await page.waitForSelector('[data-testid="np-step-2"]');
  await page.waitForTimeout(1500);
}

async function toStep3() {
  await page.fill('[data-testid="np-amount"]', "1");
  await page.waitForTimeout(600);
  await page.click('[data-testid="np-continue-2"]');
  await page.waitForSelector('[data-testid="np-step-3"]');
  await page.waitForTimeout(1000);
}

async function crossingCards() {
  const out = [];
  for (const s of STRATS) if ((await page.locator(`[data-testid="strategy-${s}-crosses"]`).count()) > 0) out.push(s);
  return out;
}

async function flow(name, fn) {
  const r = { name, status: "failed", checks: [] };
  try {
    await fn(r);
    r.status = "passed";
  } catch (e) {
    r.error = String(e.message ?? e).slice(0, 400);
    await page.screenshot({ path: path.join(shots, `order-${name}-FAILED.png`) }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
  log(name, r.status, r.error ?? "");
  results.push(r);
}

await flow("ask-preset-no-cross", async (r) => {
  await toStep2("Ask");
  const x = await refs();
  r.checks.push(x);
  const want = Math.max(...STRATS.map((s) => x[s]));
  if (!near(x.ref, want)) throw new Error(`ask reference ${x.ref} is not the highest strategy reference ${want}`);
  await page.click('[data-testid="np-preset-just-above"]');
  await toStep3();
  const crossing = await crossingCards();
  if (crossing.length) throw new Error(`"Just above" crosses on ${crossing.join(",")}`);
  r.checks.push("no strategy card warns");
});

await flow("bid-preset-no-cross", async (r) => {
  await toStep2("Bid");
  const x = await refs();
  r.checks.push(x);
  const want = Math.min(...STRATS.map((s) => x[s]));
  if (!near(x.ref, want)) throw new Error(`bid reference ${x.ref} is not the lowest strategy reference ${want}`);
  await page.click('[data-testid="np-preset-just-below"]');
  await toStep3();
  const crossing = await crossingCards();
  if (crossing.length) throw new Error(`"Just below" crosses on ${crossing.join(",")}`);
  r.checks.push("no strategy card warns");
});

await flow("direction-rule-clamps", async (r) => {
  // a sell range cannot start under the price: typing a min 1% under it is clamped, with a note
  await toStep2("Ask");
  const x = await refs();
  await page.fill('[data-testid="np-min"]', (x.ref * 0.99).toFixed(7));
  await page.press('[data-testid="np-min"]', "Enter");
  await page.waitForTimeout(400);
  const note = await page.locator('[data-testid="np-direction-note"]').innerText().catch(() => "");
  const min = Number((await page.locator('[data-testid="np-min"]').inputValue()).replace(/,/g, ""));
  r.checks.push({ ref: x.ref, min, note });
  if (!note) throw new Error("no direction note");
  if (min + 1e-4 < x.ref) throw new Error(`min ${min} left under the reference ${x.ref}`);
  // same for a buy range above the price
  await toStep2("Bid");
  const y = await refs();
  await page.fill('[data-testid="np-max"]', (y.ref * 1.01).toFixed(7));
  await page.press('[data-testid="np-max"]', "Enter");
  await page.waitForTimeout(400);
  const max = Number((await page.locator('[data-testid="np-max"]').inputValue()).replace(/,/g, ""));
  if (max - 1e-4 > y.ref) throw new Error(`max ${max} left above the reference ${y.ref}`);
  r.checks.push({ bidRef: y.ref, max });
});

await flow("pool-crossing-warned", async (r) => {
  // the pool strategy is checked against its bins AND LBOND/USDC: an ask from the pool price, under the USDC bids
  const bid = await bestBid(base, quote);
  await toStep2("Ask");
  const x = await refs();
  r.checks.push({ usdcBestBid: bid, poolRef: x.pool });
  if (bid === null || !(x.pool < bid)) {
    r.checks.push("pool price is not under the LBOND/USDC bid right now: nothing to cross, check skipped");
    return;
  }
  await toStep3();
  await page.click('[data-testid="strategy-pool"]');
  await page.click('[data-testid="np-edit"]');
  await page.waitForSelector('[data-testid="np-step-2"]');
  await page.fill('[data-testid="np-min"]', x.pool.toFixed(7));
  await page.press('[data-testid="np-min"]', "Enter");
  await page.fill('[data-testid="np-max"]', (x.pool * 1.004).toFixed(7));
  await page.press('[data-testid="np-max"]', "Enter");
  await page.waitForTimeout(500);
  await toStep3();
  const crossing = await crossingCards();
  r.checks.push({ crossing });
  if (!crossing.includes("pool")) throw new Error(`pool card does not warn (crossing: ${crossing.join(",")})`);
  await page.click('[data-testid="strategy-pool"]');
  await page.click('[data-testid="np-review"]');
  await page.waitForSelector('[data-testid="review-dialog"]');
  const warn = await page.locator('[data-testid="order-crosses"]').innerText().catch(() => "");
  if (!warn) throw new Error("review modal does not warn");
  r.checks.push(warn.slice(0, 200));
  await page.screenshot({ path: path.join(shots, "order-review-crosses.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
});

await flow("reference-follows-strategy", async (r) => {
  await toStep2("Ask");
  await page.click('[data-testid="np-preset-just-above"]');
  await toStep3();
  await page.click('[data-testid="strategy-sdex"]');
  await page.click('[data-testid="np-edit"]');
  await page.waitForSelector('[data-testid="np-step-2"]');
  const x = await refs();
  r.checks.push(x);
  if (!near(x.ref, x.sdex)) throw new Error(`range step reference ${x.ref} is not the Stellar DEX one ${x.sdex}`);
  if (!/book of your strategy/.test(x.source)) throw new Error(`source label: ${x.source}`);
  await page.click('[data-testid="np-reset"]');
});

const out = { at: new Date().toISOString(), base: BASE_URL, who: WHO, results, consoleErrors };
fs.writeFileSync(path.join(resultsDir, "order-flows.json"), JSON.stringify(out, null, 2));
log(`passed ${results.filter((r) => r.status === "passed").length}/${results.length}; console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join("\n"));
await browser.close();
process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
