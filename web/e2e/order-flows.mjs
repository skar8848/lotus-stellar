// "New order" flows through the real UI with the dev wallet, on testnet: the four destinations
// (Pool | SDEX) x (yield off | on) for Bid, plus Ask on SDEX + yield (and Ask on the other three with ASKS=1).
// Every transaction hash is verified on Horizon. Then: the proximity rule (UI only), the portfolio listing,
// and cleanup (cancel the offers, remove the pool positions, redeem the receipt minted by the 2-tx flow).
// Usage: node e2e/order-flows.mjs   (BASE_URL defaults to :3200, WHO=taker by default)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.resolve(here, "..", ".screenshots");
const resultsDir = path.resolve(here, "results");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });
const HORIZON = "https://horizon-testnet.stellar.org";
const WHO = process.env.WHO || "taker";
const AMOUNT = process.env.AMOUNT || "10";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;

const results = [];
const created = { positions: [], deposits: [] };
// EXTRA_REMOVE="pool-id:position-id,..." also removes positions left by an earlier run
for (const x of (process.env.EXTRA_REMOVE ?? "").split(",").filter(Boolean)) {
  const [pool, id] = x.split(":");
  created.positions.push({ pool, id: Number(id) });
}
let lastResult = null;

async function horizonTx(hash) {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${HORIZON}/transactions/${hash}`);
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });

async function connect(page, url) {
  await page.goto(`${BASE_URL}${url}`, { waitUntil: "domcontentloaded" });
  if ((await page.locator('[data-testid="wallet-button"]').count()) === 0) {
    await page.click('[data-testid="wallet-connect"]');
    await page.click(`[data-testid="dev-wallet-${WHO}"]`);
  }
  await page.waitForSelector('[data-testid="wallet-button"]');
  await page.waitForTimeout(6000); // balances + books polled
}

async function success(page, scope) {
  const ok = page.locator(`${scope} [data-testid="tx-success"]`).first();
  const err = page.locator(`${scope} [data-testid="tx-error"]`).first();
  await Promise.race([
    ok.waitFor({ timeout: 150000 }),
    err.waitFor({ timeout: 150000 }).then(async () => {
      throw new Error("on-screen error: " + (await err.innerText()));
    }),
  ]);
  lastResult = await ok.getAttribute("data-result");
  return ((await ok.getAttribute("data-hashes")) ?? "").split(",").filter(Boolean);
}

async function flow(name, fn) {
  if (ONLY && !ONLY.includes(name)) return null;
  const r = { name, status: "failed", txHashes: [], checks: [] };
  const page = await ctx.newPage();
  try {
    await fn(page, r);
    r.status = "passed";
  } catch (e) {
    r.error = String(e.message ?? e).slice(0, 500);
    try {
      await page.screenshot({ path: path.join(shots, `order-${name}-FAILED.png`), fullPage: true });
    } catch {}
  } finally {
    try {
      if (r.status === "passed") await page.screenshot({ path: path.join(shots, `order-${name}.png`), fullPage: true });
    } catch {}
    await page.close();
  }
  for (const h of r.txHashes) {
    const tx = await horizonTx(h);
    r.checks.push({ hash: h, horizonSuccessful: tx?.successful ?? null, ops: tx?.operation_count ?? null });
    if (!tx?.successful) {
      r.status = "failed";
      r.error = `Horizon says ${h} is not successful`;
    }
  }
  results.push(r);
  console.log(`${r.status.toUpperCase().padEnd(7)} ${name} ${r.txHashes.map((h) => h.slice(0, 8)).join(",")} ${r.error ?? ""}`);
  return r;
}

/** Fill the New order panel. */
async function fillOrder(page, { side, start, end, venue, yieldOn, amount = AMOUNT }) {
  await page.waitForSelector('[data-testid="new-order"]', { timeout: 30000 });
  await page.click(`[data-testid="pool-side"] [data-value="${side}"]`);
  // range first: the yield toggle depends on it (proximity rule)
  await page.fill('[data-testid="pool-amount"]', String(amount));
  await page.fill('[data-testid="pool-start"]', String(start));
  await page.fill('[data-testid="pool-end"]', String(end));
  await page.waitForTimeout(500);
  await page.click(`[data-testid="order-venue"] [data-value="${venue}"]`);
  await page.waitForTimeout(400);
  const before = await page.locator('[data-testid="new-order"]').getAttribute("data-pool");
  await page.click(`[data-testid="order-yield"] [data-value="${yieldOn ? "on" : "off"}"]`);
  if (venue === "pool") {
    // the yield toggle switches the pool instance (URL ?pool=): wait for it
    await page.waitForFunction(
      ([want]) => document.querySelector('[data-testid="new-order"]')?.getAttribute("data-yield") === want,
      [yieldOn ? "on" : "off"],
      { timeout: 15000 },
    );
    const after = await page.locator('[data-testid="new-order"]').getAttribute("data-pool");
    if (before !== after) await page.waitForTimeout(5000); // new instance: depth + config reload
  }
  await page.waitForTimeout(800);
  const no = page.locator('[data-testid="new-order"]');
  return {
    pool: await no.getAttribute("data-pool"),
    venue: await no.getAttribute("data-venue"),
    yield: await no.getAttribute("data-yield"),
    summary: await page.locator('[data-testid="order-summary-line"]').innerText().catch(() => ""),
    signatures: await page.locator('[data-testid="order-signatures"]').innerText().catch(() => ""),
  };
}

async function submit(page) {
  const btn = page.locator('[data-testid="order-submit"]');
  const label = await btn.innerText();
  if (await btn.isDisabled()) throw new Error(`submit disabled: "${label}"`);
  await btn.click();
  return success(page, '[data-testid="new-order"]');
}

const BID = { side: "Bid", start: "0.97", end: "0.966" };
const ASK = { side: "Ask", start: "1.03", end: "1.034" };

const cases = [
  ["bid-pool-idle", { ...BID, venue: "pool", yieldOn: false }],
  ["bid-pool-yield", { ...BID, venue: "pool", yieldOn: true }],
  ["bid-sdex-usdc", { ...BID, venue: "sdex", yieldOn: false }],
  ["bid-sdex-receipt", { ...BID, venue: "sdex", yieldOn: true }],
  ["ask-sdex-receipt", { ...ASK, venue: "sdex", yieldOn: true }],
];
if (process.env.ASKS === "1")
  cases.push(
    ["ask-pool-idle", { ...ASK, venue: "pool", yieldOn: false }],
    ["ask-pool-yield", { ...ASK, venue: "pool", yieldOn: true }],
    ["ask-sdex-usdc", { ...ASK, venue: "sdex", yieldOn: false }],
  );

for (const [name, c] of cases) {
  await flow(name, async (page, r) => {
    await connect(page, "/pools?tab=pool");
    const info = await fillOrder(page, c);
    r.checks.push(info);
    if (info.venue !== c.venue || info.yield !== (c.yieldOn ? "on" : "off")) throw new Error(`destination not set: ${JSON.stringify(info)}`);
    const expectSigs = c.venue === "sdex" && c.yieldOn && c.side === "Bid" ? "2" : "1";
    if (info.signatures !== expectSigs) throw new Error(`expected ${expectSigs} signatures, UI says ${info.signatures}`);
    r.txHashes.push(...(await submit(page)));
    if (c.venue === "pool") {
      const id = Number(lastResult);
      if (!Number.isFinite(id)) throw new Error(`no position id (${lastResult})`);
      created.positions.push({ pool: info.pool, id });
      r.checks.push({ positionId: id });
    }
    if (c.venue === "sdex" && c.yieldOn && c.side === "Bid") {
      if (r.txHashes.length !== 2) throw new Error(`expected 2 transactions, got ${r.txHashes.length}`);
      created.deposits.push(AMOUNT);
    }
  });
}

// proximity rule: Bid + Pool with the top bin right under the reference price -> yield On disabled
await flow("proximity-guard-ui", async (page, r) => {
  await connect(page, "/pools?tab=pool");
  await page.click('[data-testid="pool-side"] [data-value="Bid"]');
  await page.click('[data-testid="order-venue"] [data-value="pool"]');
  await page.click('[data-testid="order-yield"] [data-value="off"]');
  await page.waitForTimeout(3000);
  await page.fill('[data-testid="pool-amount"]', "5");
  // default bid range starts just under the reference price
  await page.click('[data-testid="new-order"] button:has-text("Reset")');
  await page.waitForTimeout(800);
  const on = page.locator('[data-testid="order-yield"] [data-value="on"]');
  const disabledNear = await on.isDisabled();
  const note = await page.locator('[data-testid="order-proximity"]').innerText().catch(() => "");
  // far enough below: enabled again
  await page.fill('[data-testid="pool-start"]', "0.97");
  await page.fill('[data-testid="pool-end"]', "0.96");
  await page.waitForTimeout(800);
  const disabledFar = await on.isDisabled();
  // SDEX is never blocked
  await page.fill('[data-testid="pool-start"]', "0.989");
  await page.click('[data-testid="order-venue"] [data-value="sdex"]');
  await page.waitForTimeout(500);
  const disabledSdex = await on.isDisabled();
  r.checks.push({ disabledNear, note: note.slice(0, 160), disabledFar, disabledSdex });
  if (!disabledNear || disabledFar || disabledSdex) throw new Error(JSON.stringify(r.checks));
});

// portfolio: pool positions per instance + SDEX offers in USDC and in the receipt
await flow("portfolio-lists-all-kinds", async (page, r) => {
  await connect(page, "/portfolio");
  await page.waitForTimeout(6000);
  const text = await page.locator('[data-testid="portfolio"]').innerText();
  const offerMarkets = await page.locator('[data-testid="offer-row"] td:nth-child(2)').allInnerTexts();
  const posRows = await page.locator('[data-testid="pool-position-row"]').count();
  r.checks.push({ offerMarkets: [...new Set(offerMarkets.map((t) => t.split("\n")[0].trim()))], posRows, links: await page.locator('[data-testid="portfolio"] a[href*="stellar.expert"]').count() });
  if (!offerMarkets.some((t) => t.startsWith("LBOND/USDC"))) throw new Error("no LBOND/USDC offer listed");
  if (!offerMarkets.some((t) => /LBOND\/lUSDC/.test(t))) throw new Error("no LBOND/receipt offer listed");
  if (posRows < created.positions.length) throw new Error(`only ${posRows} pool position rows`);
  if (!/LBOND \/ USDC \(USDC in DeFindex/.test(text) || !/LBOND \/ USDC \(idle USDC\)/.test(text)) throw new Error("pool instances not both shown");
});

if (process.env.NO_CLEANUP !== "1") {
  await flow("cleanup-cancel-offers", async (page, r) => {
    await connect(page, "/portfolio");
    await page.waitForSelector('[data-testid="offer-row"]', { timeout: 20000 });
    const n = await page.locator('[data-testid="offer-row"]').count();
    if (n > 1) {
      await page.click('[data-testid="offers-cancel-all"]');
      await page.click('[data-testid="offers-cancel-all-confirm"]');
    } else await page.click('[data-testid="offer-cancel"]');
    r.txHashes.push(...(await success(page, '[data-testid="portfolio-offers"]')));
    r.checks.push({ cancelled: n });
  });
  for (const p of created.positions) {
    await flow(`cleanup-remove-${p.pool}-${p.id}`, async (page, r) => {
      await connect(page, `/pools?tab=pool&pool=${p.pool}`);
      await page.waitForSelector(`[data-testid="pool-remove-${p.id}"]`, { timeout: 30000 });
      await page.click(`[data-testid="pool-remove-${p.id}"]`);
      r.txHashes.push(...(await success(page, '[data-testid="pool-tab"]')));
    });
  }
  if (created.deposits.length > 0) {
    await flow("cleanup-redeem-receipt", async (page, r) => {
      await connect(page, "/pools?tab=vault");
      const total = created.deposits.reduce((a, b) => a + Number(b), 0);
      const card = page.locator('[data-testid="vault-redeem-submit"]').first();
      await page.locator('[data-testid="vault-tab-redeem"]').first().click();
      await page.locator('[data-testid="vault-redeem-amount"]').first().fill(String(total));
      await page.waitForTimeout(500);
      await card.click();
      r.txHashes.push(...(await success(page, "")));
    });
  }
}

await browser.close();
const out = path.join(resultsDir, `order-flows-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify({ baseUrl: BASE_URL, who: WHO, created, results }, null, 2));
console.log(`\nresults: ${out}`);
console.table(results.map((r) => ({ flow: r.name, status: r.status, tx: r.txHashes.map((h) => h.slice(0, 10)).join(","), error: (r.error ?? "").slice(0, 80) })));
process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
