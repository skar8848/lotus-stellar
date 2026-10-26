// node --test tests/position-tx.test.mts : id of the position_added event data.
import test from "node:test";
import assert from "node:assert/strict";
import { eventPositionId } from "../lib/positionTx.ts";

test("position_added data: struct map or bare id", () => {
  assert.equal(eventPositionId({ id: 27n, side: ["Bid"], lo_bin: -20, hi_bin: -11 }), 27n);
  assert.equal(eventPositionId(5n), 5n);
  assert.equal(eventPositionId(5), 5n);
  assert.equal(eventPositionId({ side: ["Ask"] }), null);
  assert.equal(eventPositionId(null), null);
});
