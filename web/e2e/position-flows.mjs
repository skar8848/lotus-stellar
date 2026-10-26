// /pools "New position" flows through the real UI with the dev wallet, on testnet: Ask and Bid on each of the four
// strategies (Lotus pool, + Blend yield, Stellar DEX, + Blend yield), every hash verified on Horizon, then each new
// order checked in "Your positions" (locked until filled: "Early redemption · soon" instead of Remove / Cancel, "View
// position" = the creation tx on stellar.expert), the curator rule (Bid near the price + "Change range"), then cleanup ON CHAIN
// (e2e/chain-cleanup.mjs: remove_position + cancel of the offers this run created, the UI cannot do it any more)
// and the receipt redeemed from /portfolio.
// Usage: BASE_URL=http://localhost:3500 E2E_DEV_SECRET=<label=S...,...> node e2e/position-flows.mjs
//   WHO=taker (dev account), AMOUNT=2, SIDES=Ask,Bid, ONLY=pool,sdex-yield, SHOTS=<dir>, KEEP=1 (no cleanup)
//   E2E_DEV_SECRET: same format as the dev signer's NEXT_PUBLIC_DEV_SECRET, env only (never printed)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";
import { chainCleanup, hasCleanupKey, openOffers } from "./chain-cleanup.mjs";

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

async function toStep3(side, presetName, setRange) {
  await page.click('[data-testid="np-reset"]');
  await page.click(`[data-testid="np-side-${side.toLowerCase()}"]`);
  await page.click('[data-testid="np-continue-1"]');
  await page.waitForSelector('[data-testid="np-step-2"]');
  await page.waitForTimeout(1500);
  if (presetName) await page.click(`[data-testid="np-preset-${presetName}"]`);
  if (setRange) await setRange();
  await page.fill('[data-testid="np-amount"]', AMOUNT);
  await page.waitForTimeout(800);
  await page.click('[data-testid="np-continue-2"]');
  await page.waitForSelector('[data-testid="np-step-3"]');
  await page.waitForTimeout(1200);
}

const cfg = await (await fetch(`${BASE_URL}/api/config`)).json();
const account = cfg.accounts?.[WHO === "blocked" ? "blocked_taker" : WHO];
const offersBefore = new Set((account ? await openOffers(account) : []).map((o) => o.id));
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
      // the preset is placed from the strategy books (most conservative before a strategy is chosen): it must not
      // cross the book this strategy rests on (the bug: a "Just above" ask from the receipt mid filled on LBOND/USDC)
      if ((await page.locator(`[data-testid="strategy-${strat}-crosses"]`).count()) > 0)
        throw new Error("preset crosses the book: " + (await page.locator(`[data-testid="strategy-${strat}-crosses"]`).innerText()));
      r.checks.push("preset does not cross this strategy's book");
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
    // range 2 bins under the pool + Blend yield reference. The direction rule clamps a bid to the reference of the
    // range step (the lowest strategy reference until a strategy is chosen), so pick Lotus pool first, then edit.
    await toStep3("Bid", "buy-the-dip");
    await page.click('[data-testid="strategy-pool"]');
    await page.click('[data-testid="np-edit"]');
    await page.waitForSelector('[data-testid="np-step-2"]');
    const ref = Number(await page.locator('[data-testid="np-step-2"]').getAttribute("data-ref-pool-yield"));
    if (!(ref > 0)) throw new Error("no pool-yield reference");
    await page.fill('[data-testid="np-max"]', (ref * 0.998).toFixed(7));
    await page.press('[data-testid="np-max"]', "Enter");
    await page.fill('[data-testid="np-min"]', (ref * 0.99).toFixed(7));
    await page.press('[data-testid="np-min"]', "Enter");
    await page.waitForTimeout(500);
    r.checks.push(`pool-yield reference ${ref}`);
    await page.click('[data-testid="np-continue-2"]');
    await page.waitForSelector('[data-testid="np-step-3"]');
    await page.waitForTimeout(800);
    const card = page.locator('[data-testid="strategy-pool-yield"]');
    if ((await card.getAttribute("data-disabled")) !== "1") throw new Error("pool-yield not disabled for a bid within 10 bins");
    const why = await page.locator('[data-testid="strategy-pool-yield-why"]').innerText();
    r.checks.push(why.slice(0, 160));
    for (const other of ["pool", "sdex", "sdex-yield"]) {
      if ((await page.locator(`[data-testid="strategy-${other}"]`).getAttribute("data-disabled")) === "1") throw new Error(`${other} should stay open`);
    }
    r.checks.push("pool, sdex, sdex-yield stay open");
    if (!/^Too close to the price/.test(why.trim())) throw new Error(`curator message: ${why}`);
    await page.locator('[data-testid="strategy-cards"]').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -140));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, "curator-rule-bid-near-price.png") });
    // "Change range": top moved to the highest bin the curator rule allows, the card opens
    await page.click('[data-testid="strategy-change-range"]');
    await page.waitForTimeout(600);
    if ((await page.locator('[data-testid="strategy-pool-yield"]').getAttribute("data-disabled")) === "1") throw new Error("Change range did not open pool-yield");
    r.checks.push("Change range opens pool-yield");
    r.status = "passed";
  } catch (e) {
    r.error = String(e.message ?? e);
  }
  log(r.name, r.status, r.error ?? "");
  results.push(r);
}

// locked until filled: no Remove / Cancel in Your positions, "Early redemption · soon" instead; View position links the
// creation tx on stellar.expert
{
  const r = { name: "locked-until-filled", status: "failed", checks: [] };
  try {
    await page.click('[data-testid="np-reset"]');
    await page.waitForTimeout(1500);
    for (const c of created) {
      // another account may fill a position meanwhile: a fully filled one shows Remove (status Filled)
      const row = page.locator(`[data-testid="position-row"][data-pool="${c.pool}"][data-position-id="${c.id}"]`);
      const filled = /\bFilled\b/.test(await row.innerText());
      const hasRemove = (await page.locator(`[data-testid="remove-${c.pool}-${c.id}"]`).count()) > 0;
      const hasEarly = (await page.locator(`[data-testid="early-${c.pool}-${c.id}"]`).count()) > 0;
      if (filled ? !hasRemove || hasEarly : hasRemove || !hasEarly) throw new Error(`#${c.id} filled=${filled} remove=${hasRemove} early=${hasEarly}`);
      if (filled) r.checks.push(`#${c.id} fully filled meanwhile: Remove shown`);
    }
    for (const side of SIDES)
      for (const q of ["USDC", cfg.receipt.code]) {
        if ((await page.locator(`[data-testid="cancel-${side}-${q}"]`).count()) > 0) throw new Error(`Cancel shown on ${side} ${q}`);
      }
    r.checks.push(`${created.length} pool rows + SDEX rows locked`);
    // "View position" = the add_position tx on stellar.expert (position_added event via RPC getEvents)
    const runHashes = new Set(results.flatMap((x) => x.hashes ?? []));
    for (const c of created) {
      const link = page.locator(`[data-testid="view-${c.pool}-${c.id}"]`);
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("data-resolved") === "tx", `[data-testid="view-${c.pool}-${c.id}"]`, { timeout: 30000 });
      const href = await link.getAttribute("href");
      const h = href?.split("/tx/")[1];
      if (!h || !runHashes.has(h)) throw new Error(`#${c.id} view link ${href} is not its creation tx`);
    }
    r.checks.push(`${created.length} View position links = creation tx`);
    r.status = "passed";
  } catch (e) {
    r.error = String(e.message ?? e).slice(0, 300);
  }
  log(r.name, r.status, r.error ?? "");
  results.push(r);
}

// cleanup on chain (the UI keeps unfilled orders locked): only what this run created
if (!process.env.KEEP) {
  const r = { name: "chain-cleanup", status: "failed", hashes: [], checks: [] };
  try {
    if (!hasCleanupKey(WHO)) throw new Error(`E2E_DEV_SECRET has no "${WHO}" key: created orders left open (${created.map((c) => `${c.pool}#${c.id}`).join(", ")})`);
    const positions = created.map((c) => ({ contract: [...cfg.pools, ...(cfg.retiredPools ?? [])].find((p) => p.id === c.pool).contract, id: c.id }));
    const offers = (await openOffers(account)).filter((o) => !offersBefore.has(o.id));
    const out = await chainCleanup({ who: WHO, positions, offers });
    r.checks.push(...out.map((o) => `${o.what}: ${o.hash ? o.hash.slice(0, 10) : o.error}`));
    r.hashes = out.filter((o) => o.hash).map((o) => o.hash);
    for (const h of r.hashes) if (!(await horizonTx(h))?.successful) throw new Error(`${h} not successful on Horizon`);
    if (out.some((o) => o.error)) throw new Error(out.filter((o) => o.error).map((o) => o.error).join("; "));
    const left = (await openOffers(account)).filter((o) => !offersBefore.has(o.id));
    if (left.length) throw new Error(`${left.length} offers of this run still open`);
    r.checks.push(`${positions.length} positions removed, ${offers.length} offers cancelled`);
    r.status = "passed";
  } catch (e) {
    r.error = String(e.message ?? e).slice(0, 400);
  }
  log(r.name, r.status, r.hashes.join(","), r.error ?? "");
  results.push(r);

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
