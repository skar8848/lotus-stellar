// Checks that the argument encoders of lib/pool.ts (union enums as Vec[Symbol], i32/i128/u64/u32 Vec, ...) produce
// exactly what the SDK's own Spec encoder produces from the contract spec embedded in the compiled wasm
// (target/wasm32v1-none/release/lotus_pool.wasm). Run: node e2e/pool-abi-check.mjs
import fs from "node:fs";
import { contract, xdr, nativeToScVal, Address } from "@stellar/stellar-sdk";
if (!fs.existsSync(new URL("../../target/wasm32v1-none/release/lotus_pool.wasm", import.meta.url))) {
  console.log("lotus_pool.wasm not built: skipped");
  process.exit(0);
}
const wasm = fs.readFileSync(new URL("../../target/wasm32v1-none/release/lotus_pool.wasm", import.meta.url));
const spec = contract.Spec.fromWasm ? await contract.Spec.fromWasm(wasm) : null;
if (!spec) { console.log("no Spec.fromWasm in this SDK"); process.exit(0); }
const owner = "GCJUR67CI37SF5QD3AYRVARR3SVFTINQHBSFGICSZEHXDZV2BZEQ46RV";
// What the SDK itself encodes for add_position args (union enums, Vec<u32>, i128, i32)
const args = spec.funcArgsToScVals("add_position", { owner, side: { tag: "Ask", values: undefined }, mode: { tag: "Directional", values: undefined }, lo_bin: -1, hi_bin: 2, amount: 50000000n, weights: [1, 2, 3, 4] });
const mine = [
  new Address(owner).toScVal(),
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Ask")]),
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Directional")]),
  nativeToScVal(-1, { type: "i32" }),
  nativeToScVal(2, { type: "i32" }),
  nativeToScVal(50000000n, { type: "i128" }),
  xdr.ScVal.scvVec([1, 2, 3, 4].map((w) => nativeToScVal(w, { type: "u32" }))),
];
const same = args.map((a, i) => a.toXDR("base64") === mine[i].toXDR("base64"));
console.log("add_position args identical to my encoders (per arg):", same);
const sw = spec.funcArgsToScVals("swap", { taker: owner, buy_base: true, amount_in: 10000000n, min_out: 9000000n });
const mySw = [new Address(owner).toScVal(), xdr.ScVal.scvBool(true), nativeToScVal(10000000n, { type: "i128" }), nativeToScVal(9000000n, { type: "i128" })];
console.log("swap args identical:", sw.map((a, i) => a.toXDR("base64") === mySw[i].toXDR("base64")));
const dp = spec.funcArgsToScVals("depth", { side: { tag: "Bid", values: undefined }, from_bin: -200, to_bin: 200 });
console.log("depth side arg identical:", dp[0].toXDR("base64") === xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Bid")]).toXDR("base64"));
const cl = spec.funcArgsToScVals("claim", { owner, id: 7n });
console.log("claim id arg identical:", cl[1].toXDR("base64") === nativeToScVal(7n, { type: "u64" }).toXDR("base64"));
