// Portfolio checks (no on-chain transactions): mobile overflow, and the simulated-pool Claim/Remove UI.
//   node e2e/portfolio-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.resolve(here, "..", ".screenshots");
fs.mkdirSync(shots, { recursive: true });
const MAKER = "GCJUR67CI37SF5QD3AYRVARR3SVFTINQHBSFGICSZEHXDZV2BZEQ46RV";
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

async function connect(page, who) {
  await page.click('[data-testid="wallet-connect"]');
  await page.click(`[data-testid="dev-wallet-${who}"]`);
}

const browser = await launch();

// 1) mobile: no horizontal page scroll, sections present
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/portfolio`, { waitUntil: "domcontentloaded" });
  await connect(page, "maker");
  await page.waitForSelector('[data-testid="portfolio-balances"]', { timeout: 30000 });
  await page.waitForTimeout(6000);
  const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check("mobile 390px: no horizontal page overflow", over.sw <= over.cw + 1, `scrollWidth=${over.sw} clientWidth=${over.cw}`);
  for (const id of ["portfolio-summary", "portfolio-balances", "portfolio-pool-positions", "portfolio-receipts", "portfolio-offers", "portfolio-activity"]) {
    check(`mobile: ${id} rendered`, (await page.locator(`[data-testid="${id}"]`).count()) > 0);
  }
  await page.screenshot({ path: path.join(shots, "portfolio-maker-mobile.png"), fullPage: true });
  await ctx.close();
}

// 2) simulated pool: seed two positions for the maker in the mock's localStorage, then Claim and Remove through the UI
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const sent = [];
  page.on("request", (r) => {
    const u = r.url();
    if (r.method() === "POST" && (u.includes("/transactions") || (u.includes("soroban-testnet") && (r.postData() ?? "").includes("sendTransaction")))) sent.push(u);
  });
  await page.goto(`${BASE_URL}/portfolio`, { waitUntil: "domcontentloaded" });
  const state = {
    nextId: "5n",
    positions: [
      { id: "3n", owner: MAKER, side: "Ask", mode: "Directional", loBin: 0, hiBin: 4, deposited: "1000000000n",
        bins: [0, 1, 2, 3, 4].map((b) => ({ bin: b, remaining: b < 2 ? "0n" : "200000000n", filled: b < 2 ? "200000000n" : "0n" })),
        proceeds: "400200000n", fees: "1200000n", closed: false },
      { id: "4n", owner: MAKER, side: "Bid", mode: "Directional", loBin: -6, hiBin: -2, deposited: "500000000n",
        bins: [-6, -5, -4, -3, -2].map((b) => ({ bin: b, remaining: "100000000n", filled: "0n" })),
        proceeds: "0n", fees: "0n", closed: false },
    ],
  };
  await page.evaluate((s) => window.localStorage.setItem("lotus.pool.mock.v1", JSON.stringify(s)), state);
  await page.reload({ waitUntil: "domcontentloaded" });
  await connect(page, "maker");
  await page.waitForSelector('[data-testid="pool-claim-3"]', { timeout: 30000 });
  check("simulation: two seeded positions listed", (await page.locator('[data-testid="pool-position-row"]').count()) === 2);
  check("simulation banner shown", (await page.locator('[data-testid="pool-mock-note"]').count()) > 0);
  const ask = await page.locator('[data-position-id="3"]').innerText();
  check("ask row shows LBOND inventory and USDC proceeds", /LBOND/.test(ask) && /USDC/.test(ask), ask.replace(/\s+/g, " ").slice(0, 160));
  const bid = await page.locator('[data-position-id="4"]').innerText();
  check("bid row has nothing to claim (claim disabled)", await page.locator('[data-testid="pool-claim-4"]').isDisabled(), bid.replace(/\s+/g, " ").slice(0, 120));
  check("summary counts simulated positions, not on-chain value", /2 simulated/.test(await page.locator('[data-testid="portfolio-summary"]').innerText()));
  await page.screenshot({ path: path.join(shots, "portfolio-pool-sim.png"), fullPage: false });

  await page.click('[data-testid="pool-claim-3"]');
  await page.waitForSelector('[data-testid="tx-simulated"]', { timeout: 15000 });
  const note = await page.locator('[data-testid="tx-simulated"]').innerText();
  check("claim: simulated status, no fake tx link", /Simulated locally/.test(note) && (await page.locator('[data-testid="tx-simulated"] a').count()) === 0, note.replace(/\s+/g, " "));
  await page.waitForTimeout(1500);
  check("claim: proceeds cleared, position still open", (await page.locator('[data-testid="pool-claim-3"]').isDisabled()) && (await page.locator('[data-position-id="3"]').count()) === 1);

  await page.click('[data-testid="pool-remove-3"]');
  await page.waitForTimeout(2500);
  check("remove: position gone", (await page.locator('[data-position-id="3"]').count()) === 0);
  check("remove: the other position remains", (await page.locator('[data-position-id="4"]').count()) === 1);
  check("no transaction was sent to Horizon or Soroban RPC", sent.length === 0, sent.join(","));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
