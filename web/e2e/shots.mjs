// Screenshot helper: node e2e/shots.mjs --path /trade --name trade [--mobile] [--wallet maker] [--full] [--click "[data-testid=tab-limit]"] [--wait 3000]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, launch } from "./browser.mjs";

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const has = (k) => args.includes(`--${k}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", ".screenshots");
fs.mkdirSync(outDir, { recursive: true });

const mobile = has("mobile");
const browser = await launch();
const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: mobile ? 2 : 1 });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 1800)));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));
await page.goto(`${BASE_URL}${get("path", "/")}`, { waitUntil: "domcontentloaded" });
const wallet = get("wallet", "");
if (wallet) {
  await page.click('[data-testid="wallet-connect"]');
  await page.click(`[data-testid="dev-wallet-${wallet}"]`);
}
for (const sel of args.flatMap((a, i) => (a === "--click" ? [args[i + 1]] : []))) {
  await page.click(sel);
  await page.waitForTimeout(500);
}
await page.waitForTimeout(Number(get("wait", "4000")));
const name = get("name", "shot");
const file = path.join(outDir, `${name}${mobile ? "-mobile" : ""}.png`);
await page.screenshot({ path: file, fullPage: has("full") });
console.log(file);
if (errors.length) console.log("console errors:\n - " + [...new Set(errors)].join("\n - "));
await browser.close();
