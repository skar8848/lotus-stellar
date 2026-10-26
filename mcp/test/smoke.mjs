// Read-only smoke test over stdio: spawns dist/index.js, lists the tools, calls the read tools.
//   npm run build && npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.LOTUS_SECRET; // read-only smoke: never sign
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "dist", "index.js")], env, stderr: "inherit" });
const client = new Client({ name: "lotus-smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

let failed = 0;
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) failed++;
  console.log(`\n## ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n${text.length > 1800 ? text.slice(0, 1800) + "\n…" : text}`);
  return text;
}
await call("lotus_health");
await call("lotus_markets");
await call("lotus_orderbook", { market: "LBOND-USDC", depth: 3, trades: 3 });
await call("lotus_quote_swap", { side: "buy", amount_in: "10" });
await call("lotus_build_range_order", { account: "GCJUR67CI37SF5QD3AYRVARR3SVFTINQHBSFGICSZEHXDZV2BZEQ46RV", side: "Ask", start_price: "1.01", end_price: "1.02", amount: "5" });
await client.close();
if (failed) {
  console.error(`\n${failed} tool call(s) failed`);
  process.exit(1);
}
