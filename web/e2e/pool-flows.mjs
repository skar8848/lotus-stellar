// Lotus POOL flows through the real UI with the dev wallet: add position (ask), swap (buy), claim, add position (bid),
// swap (sell), remove both. Works against the live lotus_pool (deployments/testnet.pool.json) and against the local
// simulation (no testnet.pool.json): the mode is read from [data-testid=pool-tab][data-mock]. In live mode every
// transaction hash is verified on Horizon. Usage: node e2e/pool-flows.mjs   (BASE_URL defaults to :3200)
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
// POOL=<instance id from testnet.pool.json> selects the pool instance (default: the first one)
const POOL = process.env.POOL ? `&pool=${encodeURIComponent(process.env.POOL)}` : "";

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
  await page.goto(`${BASE_URL}/pools?tab=pool${POOL}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pool-tab"]', { timeout: 30000 });
  if ((await page.locator('[data-testid="wallet-button"]').count()) === 0) {
    await page.click('[data-testid="wallet-connect"]');
    await page.click(`[data-testid="dev-wallet-${who}"]`);
  }
  await page.waitForSelector('[data-testid="wallet-button"]');
  mode = (await page.locator('[data-testid="pool-tab"]').first().getAttribute("data-mock")) === "1" ? "simulation" : "live";
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
    try {
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
  await page.click('[data-testid="pool-tab-add"]');
  if (twoWay) {
    const btn = page.locator('[data-testid="pool-mode-twoway-btn"]');
    if (await btn.isDisabled()) throw new Error("Two-way LP switch is disabled on this instance: " + (await page.locator('[data-testid="pool-twoway-why"]').innerText().catch(() => "")));
    await btn.click();
    await page.waitForSelector('[data-testid="pool-twoway-note"]');
  }
  await page.click(`[data-testid="pool-side"] [data-value="${side}"]`);
  await page.fill('[data-testid="pool-amount"]', String(amount));
  await page.waitForTimeout(600);
  const btn = page.locator('[data-testid="pool-submit"]');
  const label = await btn.innerText();
  if (await btn.isDisabled()) throw new Error(`submit disabled: "${label}"`);
  await btn.click();
  return success(page, '[data-testid="position-builder"]');
}

async function swap(page, dir, amount) {
  await page.click('[data-testid="pool-tab-swap"]');
  await page.click(`[data-testid="pool-swap-dir"] [data-value="${dir}"]`);
  await page.fill('[data-testid="pool-swap-amount"]', String(amount));
  await page.waitForFunction(() => (document.querySelector('[data-testid="pool-swap-receive"]')?.value ?? "") !== "" && document.querySelector('[data-testid="pool-swap-receive"]').value !== "...", null, { timeout: 30000 });
  const btn = page.locator('[data-testid="pool-swap-submit"]');
  if (await btn.isDisabled()) throw new Error(`swap disabled: "${await btn.innerText()}"`);
  await btn.click();
  return success(page, '[data-testid="pool-swap"]');
}

const positionIds = async (page) =>
  (await page.locator('[data-testid="pool-position-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-position-id")))).map(Number);

if (process.env.TWOWAY === "1") {
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
  process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
}

let askId = null;
let bidId = null;

await flow("add-ask-position", async (page, r) => {
  await connect(page, "maker");
  r.txHashes.push(...(await addPosition(page, "Ask", 5)));
  // the new position id is the add_position return value (other accounts and agents may add positions meanwhile)
  askId = Number(lastResult);
  if (!Number.isFinite(askId)) throw new Error(`no position id in the tx result (${lastResult})`);
  await page.waitForSelector(`[data-position-id="${askId}"]`, { timeout: 30000 });
  r.checks.push({ newPositionId: askId });
});

await flow("swap-buy-lbond", async (page, r) => {
  await connect(page, "taker");
  r.txHashes.push(...(await swap(page, "buy", 2)));
});

await flow("claim-ask-proceeds", async (page, r) => {
  if (askId === null) throw new Error("skipped: no ask position");
  await connect(page, "maker");
  await page.waitForSelector(`[data-testid="pool-claim-${askId}"]`, { timeout: 20000 });
  const btn = page.locator(`[data-testid="pool-claim-${askId}"]`);
  if (await btn.isDisabled()) throw new Error("Claim disabled: no pending proceeds shown (swap may not have filled this position)");
  await btn.click();
  r.txHashes.push(...(await success(page, '[data-testid="pool-tab"]')));
});

await flow("add-bid-position", async (page, r) => {
  await connect(page, "maker");
  r.txHashes.push(...(await addPosition(page, "Bid", 5)));
  bidId = Number(lastResult);
  if (!Number.isFinite(bidId)) throw new Error(`no position id in the tx result (${lastResult})`);
  await page.waitForSelector(`[data-position-id="${bidId}"]`, { timeout: 30000 });
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
    await page.waitForSelector(`[data-testid="pool-remove-${id}"]`, { timeout: 20000 });
    await page.click(`[data-testid="pool-remove-${id}"]`);
    r.txHashes.push(...(await success(page, '[data-testid="pool-tab"]')));
    await page.waitForTimeout(4000);
    if ((await positionIds(page)).includes(id)) throw new Error("position still listed after removal");
  });
}

await browser.close();
const out = path.join(resultsDir, `pool-flows-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify({ mode, pool: process.env.POOL ?? "(default)", baseUrl: BASE_URL, results }, null, 2));
console.log(`\nmode: ${mode}\nresults: ${out}`);
console.table(results.map((r) => ({ flow: r.name, status: r.status, tx: r.txHashes.join(",").slice(0, 70), error: r.error ?? "" })));
process.exit(results.every((r) => r.status === "passed") ? 0 : 1);
