import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, stringifyDeep } from "../lib/txErrors.ts";

test("footprint race: tx_failed plus ExceededLimit / trapped is retryable", () => {
  assert.equal(classifyFailure({ txCode: "tx_failed", detail: "HostError: Error(Storage, ExceededLimit)" }), "footprint");
  assert.equal(classifyFailure({ txCode: "txFailed", detail: '{"type":"invoke_host_function_trapped"}' }), "footprint");
  assert.equal(classifyFailure({ txCode: "tx_failed", detail: "outside the footprint" }), "footprint");
  assert.equal(classifyFailure({ detail: "Error(Storage, ExceededLimit)" }), "footprint");
});

test("other failures are not classified as a footprint race", () => {
  assert.equal(classifyFailure({ txCode: "tx_failed", detail: "Error(Contract, #9)" }), "other");
  assert.equal(classifyFailure({ txCode: "tx_insufficient_fee", detail: "ExceededLimit" }), "other");
  assert.equal(classifyFailure({ status: "ERROR", detail: "" }), "other");
});

test("existing retries keep their classes", () => {
  assert.equal(classifyFailure({ status: "TRY_AGAIN_LATER" }), "try-again");
  assert.equal(classifyFailure({ txCode: "tx_bad_seq" }), "bad-seq");
  assert.equal(classifyFailure({ txCode: "txBadSeq" }), "bad-seq");
  assert.equal(classifyFailure({ detail: "send failed (ERROR: tx_bad_seq)" }), "bad-seq");
});

test("stringifyDeep survives bigint and cycles", () => {
  const a: Record<string, unknown> = { n: 5n };
  a.self = a;
  assert.match(stringifyDeep(a), /"n":"5"/);
});
