// Copies the pure routing / grid / amount logic of the web app into sdk/src/shared/, byte for byte, so the SDK and
// the app can never diverge on bins -> offers, the direction rule, the curator rule or the failure classification.
//
//   node scripts/sync-shared.mjs          copy web/lib/<file> -> src/shared/<file> (when web/ is present)
//   node scripts/sync-shared.mjs --check  exit 1 if a copy differs from web/lib (used by the unit tests)
//
// The copies are committed, so the SDK still builds from a checkout without web/ (or from npm).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(here, "..");
const WEB_LIB = path.resolve(SDK, "..", "web", "lib");
const OUT = path.join(SDK, "src", "shared");

/** web/lib files with no SDK / React / node imports (or only imports between themselves). */
export const SHARED = ["amount.ts", "poolGrid.ts", "orderRoute.ts", "txErrors.ts", "config-types.ts", "yieldRate.ts"];

const check = process.argv.includes("--check");
if (!fs.existsSync(WEB_LIB)) {
  console.log(`sync-shared: ${WEB_LIB} not found, keeping the committed copies`);
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
let diff = 0;
for (const f of SHARED) {
  const src = fs.readFileSync(path.join(WEB_LIB, f), "utf8");
  const dst = path.join(OUT, f);
  const cur = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : null;
  if (cur === src) continue;
  diff++;
  if (check) console.error(`sync-shared: src/shared/${f} differs from web/lib/${f} (run npm run sync)`);
  else {
    fs.writeFileSync(dst, src);
    console.log(`sync-shared: updated src/shared/${f}`);
  }
}
if (check && diff > 0) process.exit(1);
