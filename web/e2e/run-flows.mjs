// End-to-end SDEX / vault flows on Stellar TESTNET, driven through the real UI with Playwright and
// verified on Horizon.   Usage:  node e2e/run-flows.mjs [flow ...]      (npm run e2e -- flow ...)
//
// Needs the dev server (default http://localhost:3200, BASE_URL to override) started with the DEV signer
// (web/.env.local written by e2e/setup-env.mjs). Accounts are picked through the Connect menu
// ([data-testid=wallet-connect] > [data-testid=dev-wallet-<label>]); no key is read or printed here.
//
// Flows (in order): vault-deposit-redeem, range-sell-5, range-band, limit-order, cancel-offer,
//                   swap-usdc-lbond, swap-unauthorized-message, cleanup
// Output: e2e/results/flows-<timestamp>.json, a table on stdout, screenshots in .screenshots/e2e-<flow>.png.
// Offers created by the tests are remembered in e2e/results/state.json and only THOSE are ever cancelled.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";

const HZ = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");
const shotsDir = path.resolve(here, "..", ".screenshots");
fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(shotsDir, { recursive: true });
const statePath = path.join(resultsDir, "state.json");

// The demo offers seeded for the video: never touched by these tests.
const DEMO_OFFER_IDS = ["931612", "931613", "931614", "931615", "931616", "931617", "931618"];

// The ACTIVE vault / receipt come from /api/config (deployments/testnet.contract.json), never hardcoded:
// lUSDC on the idle v1 vault, lUSDCb on the Blend-backed v2. RECEIPT=... / STRATEGY=... override.
let RECEIPT = process.env.RECEIPT || "lUSDC";
let STRATEGY = process.env.STRATEGY || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (h) => (h ? `${h.slice(0, 8)}...` : "-");
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol;

// ---------------------------------------------------------------------------
// state: offers created by these tests (survives between runs so cleanup/cancel can run on their own)
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { created: [], baseline: null };
  }
}
const state = loadState();
const saveState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

// ---------------------------------------------------------------------------
// Horizon helpers
// ---------------------------------------------------------------------------
async function hz(p, retries = 4) {
  let last = "";
  for (let i = 0; i <= retries; i++) {
    let r;
    try {
      r = await fetch(HZ + p, { headers: { Accept: "application/json" } });
    } catch (e) {
      last = String(e);
      await sleep(1000 * (i + 1));
      continue;
    }
    if (r.status === 404) return { status: 404, json: null };
    if (r.ok) return { status: 200, json: await r.json() };
    last = `HTTP ${r.status}`;
    if (r.status === 429 || r.status >= 500) {
      await sleep(1200 * (i + 1));
      continue;
    }
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  throw new Error(`Horizon unavailable for ${p}: ${last}`);
}

async function waitTx(hash, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const r = await hz(`/transactions/${hash}`);
    if (r.status === 200) return r.json;
    if (Date.now() - t0 > timeoutMs) throw new Error(`tx ${hash} not visible on Horizon after ${timeoutMs} ms`);
    await sleep(1500);
  }
}
const txOps = async (hash) => (await hz(`/transactions/${hash}/operations?limit=200&order=asc`)).json?._embedded?.records ?? [];
const accountOf = async (id) => (await hz(`/accounts/${id}`)).json;
const offersOf = async (id) => (await hz(`/accounts/${id}/offers?limit=200`)).json?._embedded?.records ?? [];
const balanceOf = (acct, code, issuer) => {
  const b = acct?.balances?.find((x) => (code === "XLM" ? x.asset_type === "native" : x.asset_code === code && (!issuer || x.asset_issuer === issuer)));
  return b ? Number(b.balance) : 0;
};
const assetQ = (prefix, a) => {
  if (!a.issuer) return `${prefix}_asset_type=native`;
  const type = a.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  return `${prefix}_asset_type=${type}&${prefix}_asset_code=${a.code}&${prefix}_asset_issuer=${a.issuer}`;
};
async function bookOf(base, quote) {
  const r = await hz(`/order_book?${assetQ("selling", base)}&${assetQ("buying", quote)}&limit=20`);
  const bids = (r.json?.bids ?? []).map((l) => Number(l.price));
  const asks = (r.json?.asks ?? []).map((l) => Number(l.price));
  return { bestBid: bids[0] ?? null, bestAsk: asks[0] ?? null };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
async function goto(page, p) {
  return page.goto(`${BASE_URL}${p}`, { waitUntil: "domcontentloaded", timeout: 120000 });
}

/** Open the Connect menu and pick a dev wallet; returns the connected address. */
async function connect(page, who) {
  const btn = page.locator("[data-testid=wallet-button]").first();
  for (let i = 0; i < 10; i++) {
    if (await btn.count()) break;
    await page.locator("[data-testid=wallet-connect]").first().click({ timeout: 30000 }).catch(() => {});
    const item = page.locator(`[data-testid=dev-wallet-${who}]`).first();
    try {
      await item.waitFor({ state: "visible", timeout: 2500 });
      await item.click();
      break;
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(800);
    }
  }
  await btn.waitFor({ timeout: 30000 });
  const addr = await btn.getAttribute("data-address");
  if (!addr) throw new Error(`dev wallet "${who}" did not connect (is NEXT_PUBLIC_DEV_SIGNER on? run node e2e/setup-env.mjs and restart the dev server)`);
  return addr;
}

// hashes already produced in this run (so the Horizon fallback never picks up an earlier flow's tx)
const GLOBAL_SEEN = new Set();

/** Successful txs of `account` newer than `sinceMs` that we have not seen yet (oldest first). */
async function txSince(account, sinceMs, seen = new Set()) {
  if (!account) return [];
  const r = await hz(`/accounts/${account}/transactions?order=desc&limit=10`);
  return (r.json?._embedded?.records ?? [])
    .filter((t) => t.successful && new Date(t.created_at).getTime() >= sinceMs - 15000 && !seen.has(t.hash) && !GLOBAL_SEEN.has(t.hash))
    .map((t) => t.hash)
    .reverse();
}

/**
 * Click, then wait for a NEW tx-success (hash not in `seen`) or a tx-error; returns { hashes, note, reloaded }.
 * The dev server can hot-reload the page while a transaction is in flight (another agent editing the app): the
 * success banner is then lost although the tx went through. A marker on `window` detects that; in that case the
 * tx is looked up on Horizon (newest tx of `account` since the click) and the result is flagged `reloaded`.
 */
async function clickAndWait(page, clickFn, { account, seen = new Set(), timeoutMs = 150000 } = {}) {
  try {
    await page.evaluate(() => {
      window.__e2e = 1;
    });
  } catch {
    /* page mid-reload: the marker check below handles it */
  }
  const since = Date.now();
  await clickFn();
  const t0 = Date.now();
  let reloadedAt = null;
  for (;;) {
    let snap = null;
    try {
      snap = await page.evaluate(() => ({
        marker: window.__e2e === 1,
        ok: [...document.querySelectorAll("[data-testid=tx-success]")].map((e) => ({ hash: e.getAttribute("data-hash"), hashes: e.getAttribute("data-hashes"), text: e.textContent })),
        err: [...document.querySelectorAll("[data-testid=tx-error]")].map((e) => e.textContent),
      }));
    } catch {
      snap = { marker: false, ok: [], err: [] }; // context destroyed by a reload
    }
    const fresh = snap.ok.find((o) => o.hash && !seen.has(o.hash) && !GLOBAL_SEEN.has(o.hash));
    if (fresh) {
      const hashes = (fresh.hashes || fresh.hash).split(",").filter(Boolean);
      hashes.forEach((h) => {
        seen.add(h);
        GLOBAL_SEEN.add(h);
      });
      return { hashes, note: (fresh.text || "").trim(), reloaded: false };
    }
    if (snap.err.length) throw new Error(`on-screen error: ${snap.err[0].trim()}`);
    if (!snap.marker) {
      reloadedAt ??= Date.now();
      const found = await txSince(account, since, seen);
      if (found.length) {
        found.forEach((h) => {
          seen.add(h);
          GLOBAL_SEEN.add(h);
        });
        return { hashes: found, note: "(success banner lost: page reloaded by the dev server; tx found on Horizon)", reloaded: true };
      }
      if (Date.now() - reloadedAt > 25000) throw new Error("PAGE_RELOADED: the dev server reloaded the page and no transaction from the account appeared on Horizon (nothing was submitted)");
    }
    if (Date.now() - t0 > timeoutMs) {
      const found = await txSince(account, since, seen);
      if (found.length) throw new Error(`no tx-success/tx-error banner after ${timeoutMs} ms, BUT a transaction from the account is on Horizon: ${found.join(",")}`);
      throw new Error(`no tx-success/tx-error after ${timeoutMs} ms (and no new transaction on Horizon)`);
    }
    await sleep(700);
  }
}

async function waitEnabled(page, selector, timeoutMs = 60000) {
  const loc = page.locator(selector).first();
  const t0 = Date.now();
  for (;;) {
    if ((await loc.count()) && (await loc.isEnabled().catch(() => false))) return loc;
    if (Date.now() - t0 > timeoutMs) {
      const txt = (await loc.textContent().catch(() => null)) ?? "(not found)";
      throw new Error(`${selector} stayed disabled for ${timeoutMs} ms; its label says: "${String(txt).trim()}"`);
    }
    await sleep(500);
  }
}

const fillIn = async (page, testId, value) => {
  const loc = page.locator(`[data-testid=${testId}]`).first();
  await loc.waitFor({ timeout: 30000 });
  await loc.fill(String(value));
};

class Skip extends Error {}

// ---------------------------------------------------------------------------
// per-flow result helper
// ---------------------------------------------------------------------------
function newResult(name) {
  return { name, status: "failed", txHashes: [], horizonChecks: { checks: [], notes: {} }, error: undefined };
}
function check(res, name, ok, detail) {
  res.horizonChecks.checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : String(detail) });
  return !!ok;
}
const note = (res, k, v) => (res.horizonChecks.notes[k] = v);

/** Verify a tx on Horizon: successful + ledger; returns the operation records. */
async function verifyTx(res, hash, label) {
  const tx = await waitTx(hash);
  check(res, `${label}: tx successful on Horizon`, tx.successful === true, `ledger ${tx.ledger}, ${tx.operation_count} op(s), fee ${tx.fee_charged}`);
  const ops = await txOps(hash);
  note(res, `${label}.ops`, ops.map((o) => o.type));
  return { tx, ops };
}

/** Maker's offers that are not in the state's created list, for the final "untouched" comparison. */
const snapshotOffers = (offers) => offers.map((o) => ({ id: o.id, amount: o.amount, price: o.price, selling: o.selling?.asset_code ?? "XLM", buying: o.buying?.asset_code ?? "XLM" }));

async function recordCreated(res, flow, hash, makerAddr, before) {
  const after = await offersOf(makerAddr);
  const beforeIds = new Set(before.map((o) => o.id));
  const fresh = after.filter((o) => !beforeIds.has(o.id));
  for (const o of fresh) state.created.push({ id: o.id, flow, hash, price: o.price, amount: o.amount, selling: o.selling.asset_code ?? "XLM", buying: o.buying.asset_code ?? "XLM", at: new Date().toISOString() });
  saveState();
  note(res, "newOfferIds", fresh.map((o) => o.id));
  return fresh;
}

// ---------------------------------------------------------------------------
// flows
// ---------------------------------------------------------------------------
async function openTrade(page, who) {
  await goto(page, `/trade?market=LBOND-${RECEIPT}`);
  await page.locator("[data-testid=order-panel]").first().waitFor({ timeout: 90000 });
  const addr = await connect(page, who);
  return addr;
}

async function waitOfferRows(page, ids, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const present = await page.evaluate(() => [...document.querySelectorAll("[data-testid=open-offers] [data-testid=offer-row]")].map((r) => r.getAttribute("data-offer-id")));
    if (ids.every((i) => present.includes(i))) return present;
    if (Date.now() - t0 > timeoutMs) throw new Error(`offer rows ${ids.filter((i) => !present.includes(i)).join(",")} not shown in the Open offers table after ${timeoutMs} ms (shown: ${present.join(",")})`);
    await sleep(800);
  }
}

const FLOWS = [
  // -------------------------------------------------------------------------
  {
    name: "vault-deposit-redeem",
    who: "taker",
    async run({ page, res, cfg }) {
      let route = "/pools?tab=vault";
      const resp = await goto(page, route);
      let hasTab = await page.locator("[data-testid=vault-tab]").first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
      if (!resp || resp.status() >= 400 || !hasTab) {
        route = "/earn";
        await goto(page, route);
        await page.locator("[data-testid=vault-tab]").first().waitFor({ timeout: 90000 });
        hasTab = true;
      }
      note(res, "route", route);
      const addr = await connect(page, "taker");
      note(res, "account", addr);

      const sid = STRATEGY;
      const strat = cfg.strategies.find((s) => s.id === sid) ?? cfg.strategies[0];
      if (!strat) throw new Error("no strategy in /api/config");
      if (strat.id !== sid) note(res, "strategyFallback", `${sid} not found, using ${strat.id}`);
      const sel = page.locator(`[data-testid=vault-select-${strat.id}]`).first();
      await sel.waitFor({ timeout: 45000 });
      await sel.click();
      note(res, "strategy", { id: strat.id, receipt: strat.receipt.code, status: strat.status });

      const uCode = strat.underlying.code;
      const rCode = strat.receipt.code;
      const seen = new Set();

      // ---- deposit 1 USDC
      const before = await accountOf(addr);
      await fillIn(page, "vault-deposit-amount", "1");
      const dep = await waitEnabled(page, "[data-testid=vault-deposit-submit]", 60000);
      const d = await clickAndWait(page, () => dep.click(), { account: addr, seen });
      if (d.reloaded) note(res, "uiBannerLost.deposit", true);
      res.txHashes.push(...d.hashes);
      const dv = await verifyTx(res, d.hashes[0], "deposit");
      check(res, "deposit: one invoke_host_function op", dv.ops.length === 1 && dv.ops[0].type === "invoke_host_function", dv.ops.map((o) => o.type).join(","));
      const abc = dv.ops[0]?.asset_balance_changes;
      if (abc) note(res, "deposit.asset_balance_changes", abc.map((c) => `${c.type} ${c.amount} ${c.asset_code ?? "XLM"}`));
      const afterDep = await accountOf(addr);
      const dU = balanceOf(afterDep, uCode, strat.underlying.issuer) - balanceOf(before, uCode, strat.underlying.issuer);
      const dR = balanceOf(afterDep, rCode, strat.receipt.issuer) - balanceOf(before, rCode, strat.receipt.issuer);
      check(res, `deposit: ${uCode} balance -1`, near(dU, -1, 0.001), `delta ${dU}`);
      check(res, `deposit: ${rCode} balance +1`, near(dR, 1, 0.001), `delta ${dR}`);

      // ---- redeem 1 lUSDC
      await page.locator("[data-testid=vault-tab-redeem]").first().click();
      await fillIn(page, "vault-redeem-amount", "1");
      const red = await waitEnabled(page, "[data-testid=vault-redeem-submit]", 60000);
      const r = await clickAndWait(page, () => red.click(), { account: addr, seen });
      if (r.reloaded) note(res, "uiBannerLost.redeem", true);
      res.txHashes.push(...r.hashes);
      const rv = await verifyTx(res, r.hashes[0], "redeem");
      check(res, "redeem: one invoke_host_function op", rv.ops.length === 1 && rv.ops[0].type === "invoke_host_function", rv.ops.map((o) => o.type).join(","));
      const abc2 = rv.ops[0]?.asset_balance_changes;
      if (abc2) note(res, "redeem.asset_balance_changes", abc2.map((c) => `${c.type} ${c.amount} ${c.asset_code ?? "XLM"}`));
      const afterRed = await accountOf(addr);
      const rU = balanceOf(afterRed, uCode, strat.underlying.issuer) - balanceOf(afterDep, uCode, strat.underlying.issuer);
      const rR = balanceOf(afterRed, rCode, strat.receipt.issuer) - balanceOf(afterDep, rCode, strat.receipt.issuer);
      check(res, `redeem: ${uCode} balance +~1`, near(rU, 1, 0.001), `delta ${rU}`);
      check(res, `redeem: ${rCode} balance -1`, near(rR, -1, 0.001), `delta ${rR}`);
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "range-sell-5",
    who: "maker",
    async run({ page, res }) {
      const maker = await openTrade(page, "maker");
      note(res, "account", maker);
      const before = await offersOf(maker);
      await page.locator("[data-testid=tab-range]").first().click();
      await page.locator("[data-testid=range-mode] [data-value=sell]").first().click();
      await fillIn(page, "range-levels", "5");
      await fillIn(page, "range-from", "1.03");
      await fillIn(page, "range-to", "1.07");
      await fillIn(page, "range-total", "5");
      await page.locator("[data-testid=range-shape] [data-value=uniform]").first().click();
      const summary = (await page.locator("[data-testid=range-offers]").first().textContent())?.trim();
      note(res, "uiSummary.offers", summary);
      check(res, "UI summary says 5 offers (5 asks, 0 bids)", /^5\b.*5 asks, 0 bids/.test(summary ?? ""), summary);
      const crossing = await page.locator("[data-testid=range-crosses]").count();
      check(res, "UI shows no 'crosses the book' warning", crossing === 0, `warnings: ${crossing}`);
      const btn = await waitEnabled(page, "[data-testid=range-submit]", 60000);
      note(res, "submitLabel", (await btn.textContent())?.trim());
      const out = await clickAndWait(page, () => btn.click(), { account: maker });
      if (out.reloaded) note(res, "uiBannerLost", true);
      res.txHashes.push(...out.hashes);
      check(res, "exactly one transaction (one signature)", out.hashes.length === 1, out.hashes.length);
      const v = await verifyTx(res, out.hashes[0], "range");
      const msos = v.ops.filter((o) => o.type === "manage_sell_offer");
      check(res, "5 manage_sell_offer ops", msos.length === 5 && v.ops.length === 5, v.ops.map((o) => o.type).join(","));
      check(res, "all sell LBOND for lUSDC", msos.every((o) => o.selling_asset_code === "LBOND" && o.buying_asset_code === RECEIPT));
      const prices = msos.map((o) => Number(o.price)).sort((a, b) => a - b);
      const want = [1.03, 1.04, 1.05, 1.06, 1.07];
      check(res, "prices 1.03 .. 1.07", prices.length === 5 && prices.every((p, i) => near(p, want[i], 1e-6)), prices.join(","));
      check(res, "amounts 1 LBOND each (5 total)", msos.every((o) => near(o.amount, 1, 1e-6)), msos.map((o) => o.amount).join(","));
      const fresh = await recordCreated(res, "range-sell-5", out.hashes[0], maker, before);
      check(res, "5 new offers on Horizon", fresh.length === 5, fresh.length);
      check(res, "new offers sell LBOND for lUSDC at the expected prices", fresh.length === 5 && fresh.map((o) => Number(o.price)).sort((a, b) => a - b).every((p, i) => near(p, want[i], 1e-6)));
      await waitOfferRows(page, fresh.map((o) => o.id));
      check(res, "all 5 offers visible in the Open offers table", true);
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "range-band",
    who: "maker",
    async run({ page, res, cfg }) {
      const maker = await openTrade(page, "maker");
      note(res, "account", maker);
      const before = await offersOf(maker);

      // pick a band that does NOT cross the live book: 3 bids below the best bid/ask, 3 asks above both
      const { bestBid, bestAsk } = await bookOf(cfg.rwa, cfg.receipt);
      note(res, "liveBook", { bestBid, bestAsk });
      const lowRef = Math.min(bestBid ?? Infinity, bestAsk ?? Infinity);
      const highRef = Math.max(bestBid ?? 0, bestAsk ?? 0);
      const p3 = Number.isFinite(lowRef) ? Math.round((lowRef - 0.02) * 100) / 100 : 0.97; // highest bid level
      const p4 = highRef > 0 ? Math.round((highRef + 0.02) * 100) / 100 : 1.01; // lowest ask level
      const step = Math.round((p4 - p3) * 10000) / 10000;
      const from = Math.round((p3 - 2 * step) * 10000) / 10000;
      const to = Math.round((p4 + 2 * step) * 10000) / 10000;
      const split = Math.round(((p3 + p4) / 2) * 10000) / 10000;
      note(res, "band", { from, to, split, levels: 6, total: 3 });
      if (from <= 0) throw new Error(`computed band start ${from} is not positive (book too wide?)`);

      await page.locator("[data-testid=tab-range]").first().click();
      await page.locator("[data-testid=range-mode] [data-value=band]").first().click();
      await fillIn(page, "range-levels", "6");
      await fillIn(page, "range-from", from);
      await fillIn(page, "range-to", to);
      await fillIn(page, "range-split", split);
      await fillIn(page, "range-total", "3");
      await page.locator("[data-testid=range-shape] [data-value=uniform]").first().click();
      const summary = (await page.locator("[data-testid=range-offers]").first().textContent())?.trim();
      note(res, "uiSummary.offers", summary);
      check(res, "UI summary says 6 offers (3 asks, 3 bids)", /^6\b.*3 asks, 3 bids/.test(summary ?? ""), summary);
      const crossing = await page.locator("[data-testid=range-crosses]").count();
      check(res, "UI shows no 'crosses the book' warning", crossing === 0, `warnings: ${crossing}`);
      const btn = await waitEnabled(page, "[data-testid=range-submit]", 60000);
      const out = await clickAndWait(page, () => btn.click(), { account: maker });
      if (out.reloaded) note(res, "uiBannerLost", true);
      res.txHashes.push(...out.hashes);
      const v = await verifyTx(res, out.hashes[0], "band");
      const msos = v.ops.filter((o) => o.type === "manage_sell_offer");
      check(res, "6 manage_sell_offer ops in one tx", msos.length === 6 && v.ops.length === 6 && out.hashes.length === 1, v.ops.map((o) => o.type).join(","));
      const asks = msos.filter((o) => o.selling_asset_code === "LBOND" && o.buying_asset_code === RECEIPT);
      const bids = msos.filter((o) => o.selling_asset_code === RECEIPT && o.buying_asset_code === "LBOND");
      check(res, "3 asks (sell LBOND) and 3 bids (sell lUSDC)", asks.length === 3 && bids.length === 3, `asks ${asks.length}, bids ${bids.length}`);
      check(res, "asks sell 0.5 LBOND each", asks.every((o) => near(o.amount, 0.5, 1e-6)), asks.map((o) => o.amount).join(","));
      const fresh = await recordCreated(res, "range-band", out.hashes[0], maker, before);
      check(res, "6 new offers on Horizon", fresh.length === 6, fresh.length);
      await waitOfferRows(page, fresh.map((o) => o.id));
      check(res, "all 6 offers visible in the Open offers table", true);
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "limit-order",
    who: "maker",
    async run({ page, res }) {
      const maker = await openTrade(page, "maker");
      note(res, "account", maker);
      const before = await offersOf(maker);
      await page.locator("[data-testid=tab-limit]").first().click();
      await page.locator("[data-testid=limit-side] [data-value=sell]").first().click();
      await fillIn(page, "limit-price", "1.08");
      await fillIn(page, "limit-amount", "1");
      const btn = await waitEnabled(page, "[data-testid=limit-submit]", 60000);
      note(res, "submitLabel", (await btn.textContent())?.trim());
      const out = await clickAndWait(page, () => btn.click(), { account: maker });
      if (out.reloaded) note(res, "uiBannerLost", true);
      res.txHashes.push(...out.hashes);
      const v = await verifyTx(res, out.hashes[0], "limit");
      check(res, "exactly 1 manage_sell_offer op", v.ops.length === 1 && v.ops[0].type === "manage_sell_offer", v.ops.map((o) => o.type).join(","));
      const op = v.ops[0] ?? {};
      check(res, "sells 1 LBOND for the receipt at 1.08", op.selling_asset_code === "LBOND" && op.buying_asset_code === RECEIPT && near(op.amount, 1) && near(op.price, 1.08), `${op.amount} @ ${op.price}`);
      const fresh = await recordCreated(res, "limit-order", out.hashes[0], maker, before);
      check(res, "1 new offer on Horizon", fresh.length === 1, fresh.length);
      await waitOfferRows(page, fresh.map((o) => o.id));
      check(res, "offer visible in the Open offers table", true);
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "cancel-offer",
    who: "maker",
    async run({ page, res }) {
      // only offers THIS test harness created, still open
      const open = [];
      for (const c of [...state.created].reverse()) {
        if ((await hz(`/offers/${c.id}`)).status === 200) open.push(c);
      }
      if (open.length === 0) throw new Skip("no still-open offer created by the earlier flows (run range-sell-5 / range-band / limit-order first)");
      const target = open.find((c) => c.flow === "limit-order") ?? open[0];
      note(res, "target", { id: target.id, flow: target.flow, price: target.price });
      if (DEMO_OFFER_IDS.includes(target.id)) throw new Error("refusing to cancel a demo offer");
      const maker = await openTrade(page, "maker");
      await waitOfferRows(page, [target.id]);
      const row = page.locator(`[data-testid=offer-row][data-offer-id="${target.id}"]`).first();
      const out = await clickAndWait(page, () => row.locator("[data-testid=offer-cancel]").click(), { account: maker });
      if (out.reloaded) note(res, "uiBannerLost", true);
      res.txHashes.push(...out.hashes);
      const v = await verifyTx(res, out.hashes[0], "cancel");
      check(res, "exactly 1 manage_sell_offer op", v.ops.length === 1 && v.ops[0].type === "manage_sell_offer", v.ops.map((o) => o.type).join(","));
      const op = v.ops[0] ?? {};
      check(res, "op has amount 0 and the offer id", near(op.amount, 0) && String(op.offer_id) === String(target.id), `amount ${op.amount}, offer_id ${op.offer_id}`);
      check(res, "tx source is the maker", v.tx.source_account === maker, v.tx.source_account);
      const gone = (await hz(`/offers/${target.id}`)).status === 404;
      check(res, `offer #${target.id} is gone from Horizon`, gone);
      const stillListed = (await offersOf(maker)).some((o) => o.id === target.id);
      check(res, "offer no longer in the maker's offers", !stillListed);
      state.created = state.created.filter((c) => c.id !== target.id);
      state.cancelled = [...(state.cancelled ?? []), { id: target.id, hash: out.hashes[0] }];
      saveState();
      await page.waitForFunction((id) => !document.querySelector(`[data-testid=offer-row][data-offer-id="${id}"]`), target.id, { timeout: 30000 });
      check(res, "row disappears from the Open offers table", true);
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "swap-usdc-lbond",
    who: "taker",
    async run({ page, res, cfg }) {
      const taker = await openTrade(page, "taker");
      note(res, "account", taker);
      const before = await accountOf(taker);
      await page.locator("[data-testid=tab-swap]").first().click();
      await fillIn(page, "swap-pay-amount", "2");
      const routeLoc = page.locator("[data-testid=swap-route]").first();
      await page.waitForFunction(() => {
        const el = document.querySelector("[data-testid=swap-route]");
        return !!el && el.textContent && el.textContent.trim() !== "-" && !/no path/.test(el.textContent);
      }, undefined, { timeout: 60000 }).catch(() => {});
      const routeText = (await routeLoc.textContent())?.trim();
      note(res, "uiRoute", routeText);
      check(res, `UI route goes USDC > ${RECEIPT} > LBOND`, new RegExp(`^USDC > ${RECEIPT} > LBOND$`).test(routeText ?? ""), routeText);
      const uiReceive = (await page.locator("[data-testid=swap-receive-amount]").first().inputValue()).trim();
      note(res, "uiReceive", uiReceive);
      const btn = await waitEnabled(page, "[data-testid=swap-submit]", 60000);
      note(res, "submitLabel", (await btn.textContent())?.trim());
      const out = await clickAndWait(page, () => btn.click(), { account: taker });
      if (out.reloaded) note(res, "uiBannerLost", true);
      res.txHashes.push(...out.hashes);
      const v = await verifyTx(res, out.hashes[0], "swap");
      check(res, "exactly 1 path_payment_strict_send op", v.ops.length === 1 && v.ops[0].type === "path_payment_strict_send", v.ops.map((o) => o.type).join(","));
      const op = v.ops[0] ?? {};
      check(res, "pays 2 USDC, receives LBOND", op.source_asset_code === "USDC" && near(op.source_amount, 2) && op.asset_code === "LBOND", `${op.source_amount} ${op.source_asset_code} -> ${op.amount} ${op.asset_code}`);
      const pathCodes = (op.path ?? []).map((p) => p.asset_code);
      note(res, "path", pathCodes);
      check(res, `path runs through ${RECEIPT}`, pathCodes.includes(RECEIPT), pathCodes.join(","));
      check(res, "tx source is the taker", v.tx.source_account === taker);
      const after = await accountOf(taker);
      const dL = balanceOf(after, "LBOND", cfg.rwa.issuer) - balanceOf(before, "LBOND", cfg.rwa.issuer);
      const dU = balanceOf(after, "USDC", cfg.underlying.issuer) - balanceOf(before, "USDC", cfg.underlying.issuer);
      check(res, "taker LBOND balance increased by the received amount", dL > 0 && near(dL, op.amount, 1e-6), `delta ${dL} (op amount ${op.amount})`);
      check(res, "taker USDC balance decreased by 2", near(dU, -2, 1e-6), `delta ${dU}`);
      note(res, "balances", { LBOND: [balanceOf(before, "LBOND", cfg.rwa.issuer), balanceOf(after, "LBOND", cfg.rwa.issuer)], USDC: [balanceOf(before, "USDC", cfg.underlying.issuer), balanceOf(after, "USDC", cfg.underlying.issuer)] });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "swap-unauthorized-message",
    who: "blocked",
    async run({ page, res }) {
      const addr = await openTrade(page, "blocked");
      note(res, "account", addr);
      await page.locator("[data-testid=tab-swap]").first().click();
      const access = page.locator("[data-testid=access-LBOND]").first();
      await access.waitFor({ timeout: 60000 });
      const state = await access.getAttribute("data-access");
      const text = ((await access.textContent()) ?? "").replace(/\s+/g, " ").trim();
      note(res, "access.data-access", state);
      note(res, "access.text", text);
      check(res, "LBOND notice shows unauthorized or no-trustline", state === "unauthorized" || state === "no-trustline", state);
      check(res, "message names the issuer authorization requirement", /authoriz/i.test(text) && /AUTH_REQUIRED|issuer/i.test(text), text.slice(0, 160));
      const submit = page.locator("[data-testid=swap-submit]").first();
      check(res, "swap button is disabled", await submit.isDisabled());
      note(res, "submitLabel", (await submit.textContent())?.trim());
      await page.screenshot({ path: path.join(shotsDir, "e2e-blocked.png"), fullPage: true });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "cleanup",
    who: "maker",
    async run({ page, res }) {
      const ours = [];
      for (const c of state.created) {
        if (DEMO_OFFER_IDS.includes(c.id)) continue;
        if ((await hz(`/offers/${c.id}`)).status === 200) ours.push(c);
      }
      note(res, "toCancel", ours.map((c) => `${c.id} (${c.flow} @ ${c.price})`));
      const maker = await openTrade(page, "maker");
      const baselineBefore = state.baseline ?? [];
      if (ours.length === 0) {
        note(res, "nothingToCancel", true);
      }
      const seen = new Set();
      for (const c of ours) {
        await waitOfferRows(page, [c.id]);
        const row = page.locator(`[data-testid=offer-row][data-offer-id="${c.id}"]`).first();
        const out = await clickAndWait(page, () => row.locator("[data-testid=offer-cancel]").click(), { account: maker, seen });
        if (out.reloaded) note(res, `uiBannerLost.${c.id}`, true);
        res.txHashes.push(...out.hashes);
        const v = await verifyTx(res, out.hashes[0], `cancel#${c.id}`);
        const op = v.ops[0] ?? {};
        check(res, `#${c.id}: manage_sell_offer amount 0 on that offer`, v.ops.length === 1 && near(op.amount, 0) && String(op.offer_id) === String(c.id), `amount ${op.amount}, offer_id ${op.offer_id}`);
        check(res, `#${c.id}: gone from Horizon`, (await hz(`/offers/${c.id}`)).status === 404);
        state.created = state.created.filter((x) => x.id !== c.id);
        saveState();
        await page.waitForFunction((id) => !document.querySelector(`[data-testid=offer-row][data-offer-id="${id}"]`), c.id, { timeout: 30000 });
      }
      // untouched check: demo offers + every offer that existed before the tests
      const now = await offersOf(maker);
      const nowIds = new Set(now.map((o) => o.id));
      const demo = DEMO_OFFER_IDS.filter((id) => baselineBefore.some((b) => b.id === id));
      const missingDemo = demo.filter((id) => !nowIds.has(id));
      note(res, "demoOffersStillOpen", demo.filter((id) => nowIds.has(id)));
      if (missingDemo.length) note(res, "demoOffersMissing(filled or cancelled elsewhere)", missingDemo);
      // no tx of ours may have referenced a demo/baseline offer id
      const baselineIds = new Set(baselineBefore.map((b) => b.id));
      const allHashes = [...new Set([...res.txHashes, ...(state.cancelled ?? []).map((c) => c.hash)])];
      let touched = [];
      for (const h of allHashes) {
        const ops = await txOps(h);
        touched = touched.concat(ops.filter((o) => o.type === "manage_sell_offer" && Number(o.offer_id) !== 0 && baselineIds.has(String(o.offer_id))).map((o) => o.offer_id));
      }
      check(res, "no cancellation op touched a pre-existing (demo/bot) offer", touched.length === 0, touched.join(","));
      check(res, "demo offers #931615..#931618 not cancelled by the tests", ["931615", "931616", "931617", "931618"].every((id) => !touched.includes(id)));
      const leftover = now.filter((o) => state.created.some((c) => c.id === o.id));
      check(res, "no test offer left open", leftover.length === 0, leftover.map((o) => o.id).join(","));
      note(res, "makerOffersNow", snapshotOffers(now).map((o) => `${o.id}:${o.selling}>${o.buying}@${Number(o.price).toFixed(4)}x${Number(o.amount).toFixed(2)}`));
    },
  },
];

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
async function runFlow(browser, flow, ctxInfo) {
  const res = newResult(flow.name);
  const t0 = Date.now();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/MetaMask|TransportTimeout/i.test(t)) return;
    consoleErrors.push(t.slice(0, 220));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 220)}`));
  try {
    await flow.run({ page, res, cfg: ctxInfo.cfg });
    res.status = res.horizonChecks.checks.every((c) => c.ok) ? "passed" : "failed";
    if (res.status === "failed") res.error = "failed checks: " + res.horizonChecks.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail ?? ""})`).join("; ");
  } catch (e) {
    if (e instanceof Skip) {
      res.status = "skipped";
      res.error = e.message;
    } else {
      res.status = "failed";
      res.error = String(e && e.message ? e.message : e).split("\n")[0].slice(0, 600);
      try {
        const overlay = await page.evaluate(() => document.querySelector("nextjs-portal")?.shadowRoot?.textContent?.replace(/\s+/g, " ").slice(0, 300) ?? null);
        if (overlay) res.horizonChecks.notes.nextOverlay = overlay;
      } catch {
        /* page gone */
      }
    }
  } finally {
    res.consoleErrors = [...new Set(consoleErrors)].slice(0, 8);
    res.durationMs = Date.now() - t0;
    try {
      await page.screenshot({ path: path.join(shotsDir, `e2e-${flow.name}.png`), fullPage: true });
    } catch {
      /* ignore */
    }
    await context.close();
  }
  return res;
}

async function main() {
  const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const unknown = want.filter((w) => !FLOWS.some((f) => f.name === w));
  if (unknown.length) {
    console.error(`unknown flow(s): ${unknown.join(", ")}\navailable: ${FLOWS.map((f) => f.name).join(", ")}`);
    process.exit(2);
  }
  const selected = want.length ? FLOWS.filter((f) => want.includes(f.name)) : FLOWS;

  const cfgRes = await fetch(`${BASE_URL}/api/config`).catch(() => null);
  if (!cfgRes || !cfgRes.ok) {
    console.error(`cannot reach ${BASE_URL}/api/config: is the dev server running?`);
    process.exit(2);
  }
  const cfg = await cfgRes.json();
  if (!process.env.RECEIPT) RECEIPT = cfg.receipt.code;
  if (!STRATEGY) STRATEGY = cfg.strategies.find((x) => x.lotusVault === cfg.lotusVault)?.id ?? cfg.strategies[0]?.id ?? "";
  console.log(`active receipt ${RECEIPT}, vault strategy ${STRATEGY}`);

  // baseline: maker's offers that do not belong to the tests (kept from the first run until cleanup removes it)
  const makerAddr = cfg.accounts?.maker;
  if (makerAddr) {
    const createdIds = new Set(state.created.map((c) => c.id));
    const now = (await offersOf(makerAddr)).filter((o) => !createdIds.has(o.id));
    if (!state.baseline || !state.baseline.length) state.baseline = snapshotOffers(now);
    else {
      // add offers that appeared since (bots) but keep what we already knew
      const known = new Set(state.baseline.map((b) => b.id));
      state.baseline = [...state.baseline, ...snapshotOffers(now).filter((o) => !known.has(o.id))];
    }
    saveState();
  }

  const browser = await launch();
  const results = [];
  const startedAt = new Date().toISOString();
  console.log(`running ${selected.length} flow(s) against ${BASE_URL}, Horizon ${HZ}`);
  for (const flow of selected) {
    process.stdout.write(`- ${flow.name} ... `);
    const flowStartedAt = Date.now();
    let res = await runFlow(browser, flow, { cfg });
    // a flow that failed BEFORE any transaction was submitted may be a dev-server hot reload / slow compile: retry once
    let onChain = [];
    if (res.status === "failed" && res.txHashes.length === 0) {
      try {
        onChain = await txSince(res.horizonChecks.notes.account, flowStartedAt, new Set());
      } catch {
        /* Horizon hiccup: be conservative below */
      }
      if (onChain.length) {
        res.txHashes.push(...onChain);
        res.horizonChecks.notes.txFoundOnHorizonAfterFailure = onChain;
      }
    }
    if (res.status === "failed" && res.txHashes.length === 0 && /Timeout|timeout|detached|closed|net::|Target page|PAGE_RELOADED/i.test(res.error ?? "")) {
      process.stdout.write("(retrying once) ");
      const retry = await runFlow(browser, flow, { cfg });
      retry.horizonChecks.notes.retriedAfter = res.error;
      res = retry;
    }
    results.push(res);
    console.log(res.status.toUpperCase() + (res.status === "passed" ? "" : `  ${res.error ?? ""}`));
  }
  await browser.close();

  const out = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    horizon: HZ,
    flows: results,
  };
  const file = path.join(resultsDir, `flows-${startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  // table
  const w = Math.max(...results.map((r) => r.name.length), 4);
  console.log("\n" + "flow".padEnd(w) + "  status   tx hashes");
  for (const r of results) {
    console.log(r.name.padEnd(w) + "  " + r.status.padEnd(8) + " " + (r.txHashes.length ? r.txHashes.map(short).join(" ") : "-"));
  }
  const failed = results.filter((r) => r.status === "failed");
  console.log(`\n${results.filter((r) => r.status === "passed").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "skipped").length} skipped`);
  for (const r of failed) console.log(`  FAILED ${r.name}: ${r.error}`);
  console.log(`results: ${file}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
