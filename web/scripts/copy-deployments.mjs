// Build step for hosted deploys (Vercel): copy the PUBLIC deployment files from ../deployments into
// ./deployments so lib/config.ts finds them at runtime. Secret files (*.secrets.json) are never copied.
import fs from "node:fs";
import path from "node:path";

const src = path.resolve(process.cwd(), "..", "deployments");
const dst = path.resolve(process.cwd(), "deployments");
if (!fs.existsSync(src)) {
  console.log("copy-deployments: ../deployments not found, skipping");
  process.exit(0);
}
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith(".json") || f.includes("secrets")) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  n++;
}
console.log(`copy-deployments: ${n} public files copied`);
