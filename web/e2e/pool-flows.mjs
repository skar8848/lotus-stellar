// Lotus POOL flows through the real UI with the dev wallet: add position (ask), swap (buy), claim, add position (bid),
// swap (sell), remove both. Directional positions are created with the /pools "New position" flow (strategy Lotus
// pool, or Lotus pool + Blend yield for the vault-backed instance), swaps go through the "Swap on the pool" dialog,
// claim / remove through "Your positions". TWOWAY=1 drives the "Advanced: two-way position" page (?pool=<id>, its
// own builder + position list); the swap dialog only lists the directional instances, so the two-way swap steps are
// reported as skipped. Works against the live lotus_pool (deployments/testnet.pool.json) and the local simulation
// (the mock banner). In live mode every transaction hash is verified on Horizon.
// Usage: node e2e/pool-flows.mjs   (BASE_URL defaults to :3200; POOL=<instance id>, default the idle instance)
// An unfilled directional position is locked in the UI: it is removed on chain with E2E_DEV_SECRET (env only).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";
import { chainCleanup, hasCleanupKey } from "./chain-cleanup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.resolve(here, "..", ".screenshots");
const resultsDir = path.resolve(here, "results");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });
const HORIZON = "https://horizon-testnet.stellar.org";
// POOL=<instance id from testnet.pool.json> selects the pool instance (default: the first instance without a vault)
const TWOWAY = process.env.TWOWAY === "1";
const cfg = await (await fetch(`${BASE_URL}/api/config`)).json();
const usable = cfg.pools.filter((p) => p.status !== "retired" && p.status !== "coming-soon");
const INST = process.env.POOL
  ? cfg.pools.find((p) => p.id === process.env.POOL)
  : TWOWAY
    ? usable.find((p) => p.supportsTwoWay)
    : (usable.find((p) => !p.vault) ?? usable[0]);
if (!INST) throw new Error(`pool instance ${process.env.POOL ?? "(default)"} not found in /api/config`);
// New position strategy card of a directional instance (the flow uses the FIRST idle / vault-backed instance)
const STRATEGY = INST.vault ? "pool-yield" : "pool";
class Skip extends Error {}

const results = [];
let mode = "unknown";

async function horizonTx(hash) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${HORIZON}/transactions/${hash}`);
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

async function connect(page, who) {
  await page.goto(`${BASE_URL}/pools${TWOWAY ? `?pool=${encodeURIComponent(INST.id)}` : ""}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(TWOWAY ? '[data-testid="pool-tab"]' : '[data-testid="new-position"]', { timeout: 30000 });
  if ((await page.locator('[data-testid="wallet-button"]').count()) === 0) {
    await page.click('[data-testid="wallet-connect"]');
    await page.click(`[data-testid="dev-wallet-${who}"]`);
  }
  await page.waitForSelector('[data-testid="wallet-button"]');
  mode = TWOWAY
    ? (await page.locator('[data-testid="pool-tab"]').first().getAttribute("data-mock")) === "1"
      ? "simulation"
      : "live"
    : (await page.locator('[data-testid="pool-mock-banner"]').count()) > 0
      ? "simulation"
      : "live";
  // wait for balances (Horizon poll) so the submit button is not blocked by "loading"
  await page.waitForTimeout(7000);
}

/** Wait for a success banner and return its hashes ([] for a simulated flow). */
async function success(page, scope) {
  const ok = page.locator(`${scope ?? ""} [data-testid="tx-success"]`).first();
  const err = page.locator(`${scope ?? ""} [data-testid="tx-error"]`).first();
  await Promise.race([ok.waitFor({ timeout: 90000 }), err.waitFor({ timeout: 90000 }).then(async () => { throw new Error("on-screen error: " + (await err.innerText())); })]);
  const hashes = ((await ok.getAttribute("data-hashes")) ?? "").split(",").filter(Boolean);
  lastResult = await ok.getAttribute("data-result"); // e.g. the id of a new position (u64 return value)
  return hashes;
}
let lastResult = null;

// one browser context for the whole run: the local simulation keeps its state in localStorage
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });

async function flow(name, fn) {
  const r = { name, status: "failed", txHashes: [], mode: "", checks: [] };
  const page = await ctx.newPage();
  try {
    await fn(page, r);
    r.status = "passed";
  } catch (e) {
    r.error = String(e.message ?? e).slice(0, 400);
    if (e instanceof Skip) r.status = "skipped";
    else try {
      await page.screenshot({ path: path.join(shots, `pool-${name}-FAILED.png`) });
    } catch {}
  } finally {
    try {
      if (r.status === "passed") await page.screenshot({ path: path.join(shots, `pool-${name}.png`), fullPage: true });
    } catch {}
    r.mode = mode;
    await page.close();
  }
  // live: verify on Horizon
  if (r.status === "passed" && mode === "live") {
    for (const h of r.txHashes) {
      const tx = await horizonTx(h);
      r.checks.push({ hash: h, horizonSuccessful: tx?.successful ?? null, ledger: tx?.ledger ?? null });
      if (!tx?.successful) {
        r.status = "failed";
        r.error = `Horizon says ${h} is not successful`;
      }
    }
  }
  results.push(r);
  console.log(`${r.status.toUpperCase().padEnd(7)} ${name} ${r.txHashes.map((h) => h.slice(0, 8)).join(",")} ${r.error ?? ""}`);
  return r;
}

async function addPosition(page, side, amount, twoWay = false) {
  if (!twoWay) return addDirectional(page, side, amount);
  {
    const btn = page.locator('[data-testid="pool-mode-twoway-btn"]');
    if (await btn.isDisabled()) throw new Error("Two-way LP switch is disabled on this instance: " + (await page.locator('[data-testid="pool-twoway-why"]').innerText().catch(() => "")));
    await btn.click();
    await page.waitForSelector('[data-testid="pool-twoway-note"]');
  }
  // the two-way instance keeps its own builder on the Advanced page
  await page.click(`[data-testid="pool-side"] [data-value="${side}"]`);
  await page.fill('[data-testid="pool-amount"]', String(amount));
  await page.waitForTimeout(600);
  const btn = page.locator('[data-testid="pool-submit"]');
  const label = await btn.innerText();
  if (await btn.isDisabled()) throw new Error(`submit disabled: "${label}"`);
  await btn.click();
  return success(page, '[data-testid="position-builder"]');
}

/** /pools New position: side, default range ("Just above" / "Buy the dip" preset), amount, the pool strategy, sign. */
async function addDirectional(page, side, amount) {
  await page.click('[data-testid="np-reset"]');
  await page.click(`[data-testid="np-side-${side.toLowerCase()}"]`);
  await page.click('[data-testid="np-continue-1"]');
  await page.waitForSelector('[data-testid="np-step-2"]');
  await page.waitForTimeout(1500);
  await page.click(`[data-testid="np-preset-${side === "Ask" ? "just-above" : "buy-the-dip"}"]`);
  await page.fill('[data-testid="np-amount"]', String(amount));
  await page.waitForTimeout(600);
  await page.click('[data-testid="np-continue-2"]');
  await page.waitForSelector('[data-testid="np-step-3"]');
  const card = page.locator(`[data-testid="strategy-${STRATEGY}"]`);
  if ((await card.getAttribute("data-disabled")) === "1") throw new Error(`${STRATEGY} unavailable: ${await card.innerText()}`);
  await card.click();
  await page.click('[data-testid="np-review"]');
  await page.waitForSelector('[data-testid="review-dialog"]');
  const btn = page.locator('[data-testid="review-sign"]');
  if (await btn.isDisabled()) throw new Error(`sign disabled: "${await btn.innerText()}"`);
  await btn.click();
  const hashes = await success(page, '[data-testid="review-dialog"]');
  await page.click('[data-testid="review-done"]');
  return hashes;
}

async function swap(page, dir, amount) {
  if (TWOWAY) throw new Skip("skipped: the swap dialog lists the directional instances only, no UI swap on the two-way instance");
  await page.click('[data-testid="np-open-swap"]');
  await page.waitForSelector('[data-testid="swap-dialog"]');
  if ((await page.locator('[data-testid="swap-pool-picker"]').count()) > 0) await page.click(`[data-testid="swap-pool-picker"] [data-value="${INST.id}"]`);
  await page.click(`[data-testid="pool-swap-dir"] [data-value="${dir}"]`);
  await page.fill('[data-testid="pool-swap-amount"]', String(amount));
  await page.waitForFunction(() => (document.querySelector('[data-testid="pool-swap-receive"]')?.value ?? "") !== "" && document.querySelector('[data-testid="pool-swap-receive"]').value !== "...", null, { timeout: 30000 });
  const btn = page.locator('[data-testid="pool-swap-submit"]');
  if (await btn.isDisabled()) throw new Error(`swap disabled: "${await btn.innerText()}"`);
  await btn.click();
  return success(page, '[data-testid="pool-swap"]');
}

// two-way page: its own list; /pools: "Your positions" rows of this instance
const positionIds = async (page) =>
  TWOWAY
    ? (await page.locator('[data-testid="pool-position-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-position-id")))).map(Number)
    : (await page.locator(`[data-testid="position-row"][data-kind="pool"][data-pool="${INST.id}"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-position-id")))).map(Number);
const claimSel = (id) => (TWOWAY ? `[data-testid="pool-claim-${id}"]` : `[data-testid="claim-${INST.id}-${id}"]`);
const removeSel = (id) => (TWOWAY ? `[data-testid="pool-remove-${id}"]` : `[data-testid="remove-${INST.id}-${id}"]`);
const posRowSel = (id) => (TWOWAY ? `[data-position-id="${id}"]` : `[data-testid="position-row"][data-kind="pool"][data-pool="${INST.id}"][data-position-id="${id}"]`);
const listScope = () => (TWOWAY ? '[data-testid="pool-tab"]' : '[data-testid="your-positions"]');

if (TWOWAY) {
  // ---- two-way round trip: add, swap through it one way, swap back, claim fees, remove
  results.length = 0;
  let twId = null;
  const holdings = async (page, id) => (await page.locator(`[data-position-id="${id}"] [data-testid="twoway-holdings"]`).innerText()).replace(/\s+/g, " ");
  await flow("twoway-add-position", async (page, r) => {
    await connect(page, "maker");
    r.txHashes.push(...(await addPosition(page, "Ask", 5, true)));
    twId = Number(lastResult);
    await page.waitForSelector(`[data-position-id="${twId}"]`, { timeout: 30000 });
    const mode = await page.locator(`[data-position-id="${twId}"] [data-testid="position-mode"]`).innerText();
    if (!/two-way/.test(mode)) throw new Error("position row does not show the two-way mode: " + mode);
    r.checks.push({ newPositionId: twId, holdings: await holdings(page, twId) });
  });
  await flow("twoway-swap-buy-through", async (page, r) => {
    await connect(page, "taker");
    r.txHashes.push(...(await swap(page, "buy", 2)));
  });
  await flow("twoway-swap-back-sell", async (page, r) => {
    await connect(page, "taker");
    r.txHashes.push(...(await swap(page, "sell", 1)));
  });
  await flow("twoway-claim-fees", async (page, r) => {
    if (twId === null) throw new Error("skipped: no two-way position");
    await connect(page, "maker");
    r.checks.push({ holdingsBefore: await holdings(page, twId) });
    const btn = page.locator(`[data-testid="pool-claim-${twId}"]`);
    if (await btn.isDisabled()) throw new Error("Claim disabled: no fees accrued");
    await btn.click();
    r.txHashes.push(...(await success(page, '[data-testid="pool-tab"]')));
  });
  await flow("twoway-remove", async (page, r) => {
    if (twId === null) throw new Error("skipped: no two-way position");
    await connect(page, "maker");
    await page.click(`[data-testid="pool-remove-${twId}"]`);
    r.txHashes.push(...(await success(page, '[data-testid="pool-tab"]')));
    await page.waitForTimeout(4000);
    if ((await positionIds(page)).includes(twId)) throw new Error("position still listed after removal");
  });
  await browser.close();
  const out2 = path.join(resultsDir, `pool-twoway-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out2, JSON.stringify({ mode, pool: process.env.POOL, results }, null, 2));
  console.table(results.map((r) => ({ flow: r.name, status: r.status, tx: r.txHashes.join(",").slice(0, 70), error: r.error ?? "" })));
  console.log("results:", out2);
  process.exit(results.every((r) => r.status === "passed" || r.status === "skipped") ? 0 : 1);
}

let askId = null;
let bidId = null;

await flow("add-ask-position", async (page, r) => {
  await connect(page, "maker");
  r.txHashes.push(...(await addPosition(page, "Ask", 5)));
  // the new position id is the add_position return value (other accounts and agents may add positions meanwhile)
  askId = Number(lastResult);
  if (!Number.isFinite(askId)) throw new Error(`no position id in the tx result (${lastResult})`);
  await page.waitForSelector(posRowSel(askId), { timeout: 30000 });
  r.checks.push({ newPositionId: askId });
});

await flow("swap-buy-lbond", async (page, r) => {
  await connect(page, "taker");
  r.txHashes.push(...(await swap(page, "buy", 2)));
});

await flow("claim-ask-proceeds", async (page, r) => {
  if (askId === null) throw new Error("skipped: no ask position");
  await connect(page, "maker");
  await page.waitForSelector(claimSel(askId), { timeout: 20000 });
  const btn = page.locator(claimSel(askId));
  if (await btn.isDisabled()) throw new Error("Claim disabled: no pending proceeds shown (swap may not have filled this position)");
  await btn.click();
  r.txHashes.push(...(await success(page, listScope())));
});

await flow("add-bid-position", async (page, r) => {
  await connect(page, "maker");
  r.txHashes.push(...(await addPosition(page, "Bid", 5)));
  bidId = Number(lastResult);
  if (!Number.isFinite(bidId)) throw new Error(`no position id in the tx result (${lastResult})`);
  await page.waitForSelector(posRowSel(bidId), { timeout: 30000 });
  r.checks.push({ newPositionId: bidId });
});

await flow("swap-sell-lbond", async (page, r) => {
  await connect(page, "taker");
  r.txHashes.push(...(await swap(page, "sell", 1)));
});

for (const [label, getId] of [["remove-ask-position", () => askId], ["remove-bid-position", () => bidId]]) {
  await flow(label, async (page, r) => {
    const id = getId();
    if (id === null) throw new Error("skipped: no position");
    await connect(page, "maker");
    await page.waitForSelector(posRowSel(id), { timeout: 20000 });
    if ((await page.locator(removeSel(id)).count()) > 0) {
      await page.click(removeSel(id));
      r.txHashes.push(...(await success(page, listScope())));
    } else {
      // directional order not fully filled: locked in the UI ("Early redemption · soon"), removed on chain instead
      if ((await page.locator(`[data-testid="early-${INST.id}-${id}"]`).count()) === 0) throw new Error("neither Remove nor Early redemption shown");
      r.checks.push("locked in the UI until filled: removed on chain");
      if (!hasCleanupKey("maker")) throw new Error('locked until filled and E2E_DEV_SECRET has no "maker" key: position left open');
      const out = await chainCleanup({ who: "maker", positions: [{ contract: INST.contract, id }] });
      if (out[0]?.error) throw new Error(out[0].error);
      r.txHashes.push(out[0].hash);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(6000);
    if ((await positionIds(page)).includes(id)) throw new Error("position still listed after removal");
  });
}

await browser.close();
const out = path.join(resultsDir, `pool-flows-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify({ mode, pool: INST.id, baseUrl: BASE_URL, results }, null, 2));
console.log(`\nmode: ${mode}\nresults: ${out}`);
console.table(results.map((r) => ({ flow: r.name, status: r.status, tx: r.txHashes.join(",").slice(0, 70), error: r.error ?? "" })));
process.exit(results.every((r) => r.status === "passed" || r.status === "skipped") ? 0 : 1);
