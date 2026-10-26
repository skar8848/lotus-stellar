// /pools "New position" flows through the real UI with the dev wallet, on testnet: Ask and Bid on each of the four
// strategies (Lotus pool, + Blend yield, Stellar DEX, + Blend yield), every hash verified on Horizon, then each new
// order checked in "Your positions", the curator rule (Bid near the price), and cleanup through the same table
// (Remove pool positions, Cancel SDEX ladders), then the receipt redeemed from /portfolio.
// Usage: BASE_URL=http://localhost:3500 node e2e/position-flows.mjs
//   WHO=taker (dev account), AMOUNT=2, SIDES=Ask,Bid, ONLY=pool,sdex-yield, SHOTS=<dir>, KEEP=1 (no cleanup)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.SHOTS || path.resolve(here, "..", ".screenshots");
const resultsDir = path.resolve(here, "results");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });
const HORIZON = "https://horizon-testnet.stellar.org";
const WHO = process.env.WHO || "taker";
const AMOUNT = process.env.AMOUNT || "2";
const SIDES = (process.env.SIDES || "Ask,Bid").split(",");
const STRATS = process.env.ONLY ? process.env.ONLY.split(",") : ["pool", "pool-yield", "sdex", "sdex-yield"];

const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function horizonTx(hash) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${HORIZON}/transactions/${hash}`);
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !/MetaMask|Transport request timed out/.test(m.text())) consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message.slice(0, 300)));

async function connect(url) {
  await page.goto(`${BASE_URL}${url}`, { waitUntil: "domcontentloaded" });
  if ((await page.locator('[data-testid="wallet-button"]').count()) === 0) {
    await page.click('[data-testid="wallet-connect"]');
    await page.click(`[data-testid="dev-wallet-${WHO}"]`);
  }
  await page.waitForSelector('[data-testid="wallet-button"]');
  await page.waitForTimeout(5000);
}

async function waitTx(scope) {
  const ok = page.locator(`${scope} [data-testid="tx-success"]`).first();
  const err = page.locator(`${scope} [data-testid="tx-error"]`).first();
  await Promise.race([
    ok.waitFor({ timeout: 180000 }),
    err.waitFor({ timeout: 180000 }).then(async () => {
      throw new Error("on-screen error: " + (await err.innerText()));
    }),
  ]);
  return ((await ok.getAttribute("data-hashes")) ?? "").split(",").filter(Boolean);
}

async function rowKeys() {
  return page.$$eval('[data-testid="position-row"]', (els) =>
    els.map((e) => ({
      kind: e.getAttribute("data-kind"),
      strategy: e.getAttribute("data-strategy"),
      id: e.getAttribute("data-position-id"),
      pool: e.getAttribute("data-pool"),
      offers: e.getAttribute("data-offers"),
      side: e.getAttribute("data-side"),
      quote: e.getAttribute("data-quote"),
    })),
  );
}

async function toStep3(side, presetName) {
  await page.click('[data-testid="np-reset"]');
  await page.click(`[data-testid="np-side-${side.toLowerCase()}"]`);
  await page.click('[data-testid="np-continue-1"]');
  await page.waitForSelector('[data-testid="np-step-2"]');
  await page.waitForTimeout(1500);
  if (presetName) await page.click(`[data-testid="np-preset-${presetName}"]`);
  await page.fill('[data-testid="np-amount"]', AMOUNT);
  await page.waitForTimeout(800);
  await page.click('[data-testid="np-continue-2"]');
  await page.waitForSelector('[data-testid="np-step-3"]');
  await page.waitForTimeout(1200);
}

await connect("/pools");
await page.waitForTimeout(4000);
const before = await rowKeys();
log("rows before", before.length);
const created = [];

for (const side of SIDES) {
  for (const strat of STRATS) {
    const name = `${side}-${strat}`;
    const r = { name, status: "failed", hashes: [], checks: [] };
    try {
      await toStep3(side, side === "Bid" ? "buy-the-dip" : "just-above");
      const card = page.locator(`[data-testid="strategy-${strat}"]`);
      if ((await card.getAttribute("data-disabled")) === "1") throw new Error("card disabled: " + (await card.innerText()));
      const sigs = Number(await card.getAttribute("data-signatures"));
      await card.click();
      await page.click('[data-testid="np-review"]');
      await page.waitForSelector('[data-testid="review-dialog"]');
      const summary = await page.locator('[data-testid="order-summary-line"]').innerText();
      r.summary = summary;
      if (name === "Bid-sdex-yield" || name === "Ask-pool-yield") {
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(shots, `review-${name}.png`) });
      }
      await page.click('[data-testid="review-sign"]');
      const hashes = await waitTx('[data-testid="review-dialog"]');
      r.hashes = hashes;
      if (hashes.length < 1) throw new Error("no hash");
      r.checks.push(`signatures announced ${sigs}, ${hashes.length} tx`);
      for (const h of hashes) {
        const t = await horizonTx(h);
        if (!t?.successful) throw new Error(`tx ${h} not successful on Horizon`);
      }
      r.checks.push("all hashes successful on Horizon");
      await page.click('[data-testid="review-done"]');
      await page.waitForTimeout(6000);
      const rows = await rowKeys();
      const fresh = rows.filter((x) => !before.some((b) => b.kind === x.kind && b.strategy === x.strategy && b.id === x.id && b.pool === x.pool && b.side === x.side && b.quote === x.quote));
      const mine = fresh.filter((x) => x.strategy === strat && (x.kind === "pool" ? !created.some((c) => c.id === x.id && c.pool === x.pool) : x.side === side));
      if (mine.length === 0) throw new Error("not listed in Your positions");
      r.checks.push(`listed in Your positions as ${strat}`);
      for (const m of mine) if (m.kind === "pool") created.push(m);
      r.status = "passed";
    } catch (e) {
      r.error = String(e.message ?? e).slice(0, 400);
      await page.screenshot({ path: path.join(shots, `FAILED-${name}.png`) }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
    log(name, r.status, r.hashes.join(","), r.error ?? "");
    results.push(r);
  }
}

// Your positions with everything listed
await page.locator('[data-testid="your-positions"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await page.locator('[data-testid="your-positions"]').screenshot({ path: path.join(shots, "positions-all-strategies.png") });

// curator rule: a Bid right under the price cannot take the pool + Blend yield strategy
{
  const r = { name: "curator-rule", status: "failed", checks: [] };
  try {
    await toStep3("Bid", "just-below");
    const card = page.locator('[data-testid="strategy-pool-yield"]');
    if ((await card.getAttribute("data-disabled")) !== "1") throw new Error("pool-yield not disabled for a bid within 10 bins");
    const why = await page.locator('[data-testid="strategy-pool-yield-why"]').innerText();
    r.checks.push(why.slice(0, 160));
    for (const other of ["pool", "sdex", "sdex-yield"]) {
      if ((await page.locator(`[data-testid="strategy-${other}"]`).getAttribute("data-disabled")) === "1") throw new Error(`${other} should stay open`);
    }
    r.checks.push("pool, sdex, sdex-yield stay open");
    await page.locator('[data-testid="strategy-cards"]').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -140));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, "curator-rule-bid-near-price.png") });
    r.status = "passed";
  } catch (e) {
    r.error = String(e.message ?? e);
  }
  log(r.name, r.status, r.error ?? "");
  results.push(r);
}

// cleanup through the table
if (!process.env.KEEP) {
  await page.click('[data-testid="np-reset"]');
  for (const c of created) {
    const r = { name: `remove-${c.pool}-${c.id}`, status: "failed", hashes: [] };
    try {
      await page.click(`[data-testid="remove-${c.pool}-${c.id}"]`);
      r.hashes = await waitTx('[data-testid="your-positions"]');
      const t = await horizonTx(r.hashes[0]);
      if (!t?.successful) throw new Error("not successful on Horizon");
      await page.click('[data-testid="your-positions"] [aria-label="Dismiss"]').catch(() => {});
      await page.waitForTimeout(4000);
      if ((await page.locator(`[data-testid="remove-${c.pool}-${c.id}"]`).count()) > 0) throw new Error("still listed");
      r.status = "passed";
    } catch (e) {
      r.error = String(e.message ?? e).slice(0, 300);
    }
    log(r.name, r.status, r.hashes.join(","), r.error ?? "");
    results.push(r);
  }
  for (const side of SIDES) {
    for (const q of ["USDC", "lUSDCb"]) {
      const sel = `[data-testid="cancel-${side}-${q}"]`;
      if ((await page.locator(sel).count()) === 0) continue;
      const r = { name: `cancel-${side}-${q}`, status: "failed", hashes: [] };
      try {
        await page.click(sel);
        r.hashes = await waitTx('[data-testid="your-positions"]');
        for (const h of r.hashes) if (!(await horizonTx(h))?.successful) throw new Error("not successful on Horizon");
        await page.click('[data-testid="your-positions"] [aria-label="Dismiss"]').catch(() => {});
        await page.waitForTimeout(5000);
        if ((await page.locator(sel).count()) > 0) throw new Error("still listed");
        r.status = "passed";
      } catch (e) {
        r.error = String(e.message ?? e).slice(0, 300);
      }
      log(r.name, r.status, r.hashes.join(","), r.error ?? "");
      results.push(r);
    }
  }

  // the receipt minted by Bid + Stellar DEX + Blend yield: redeem it from /portfolio
  {
    const r = { name: "portfolio-redeem", status: "failed", hashes: [] };
    try {
      await page.goto(`${BASE_URL}/portfolio#receipts`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="portfolio-receipts"]', { timeout: 60000 });
      await page.waitForTimeout(5000);
      const box = page.locator('[data-testid="redeem-usdc-defindex-blend"]');
      await box.waitFor({ timeout: 30000 });
      await page.fill('[data-testid="redeem-amount-usdc-defindex-blend"]', AMOUNT);
      await page.locator("#receipts").screenshot({ path: path.join(shots, "portfolio-receipts-redeem.png") });
      await page.click('[data-testid="redeem-submit-usdc-defindex-blend"]');
      r.hashes = await waitTx('[data-testid="redeem-usdc-defindex-blend"]');
      if (!(await horizonTx(r.hashes[0]))?.successful) throw new Error("not successful on Horizon");
      r.status = "passed";
    } catch (e) {
      r.error = String(e.message ?? e).slice(0, 300);
    }
    log(r.name, r.status, r.hashes.join(","), r.error ?? "");
    results.push(r);
  }
}

const out = { at: new Date().toISOString(), base: BASE_URL, who: WHO, amount: AMOUNT, results, consoleErrors };
fs.writeFileSync(path.join(resultsDir, "position-flows.json"), JSON.stringify(out, null, 2));
log(`passed ${results.filter((r) => r.status === "passed").length}/${results.length}; console errors ${consoleErrors.length}`);
if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join("\n"));
await browser.close();
process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
