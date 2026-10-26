// "View position" of a Lotus pool position: the stellar.expert page of the transaction that created it. The pool emits
// `position_added` (topics ["position_added", owner], data { id, side, lo_bin, hi_bin, ... }) in add_position; Soroban
// RPC getEvents finds it while it is inside the RPC retention window (about 7 days on testnet). Outside it, or on any
// RPC error, the caller falls back to the pool contract page. Results are cached (memory + localStorage per network).

import { nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { NetCfg } from "./stellar";

const RETENTION_LEDGERS = 120_000; // a bit under 7 days of 5 s ledgers, the testnet RPC default
const memo = new Map<string, Promise<string | null>>();
const LS_KEY = "lotus.positionTx.v1";

function lsGet(key: string): string | null {
  try {
    return (JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, string>)[key] ?? null;
  } catch {
    return null;
  }
}
function lsSet(key: string, hash: string) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, string>;
    all[key] = hash;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: memory cache only */
  }
}

/** id carried in the event data (struct map {id, ...} or a bare u64). */
export function eventPositionId(data: unknown): bigint | null {
  const v = data && typeof data === "object" && "id" in (data as Record<string, unknown>) ? (data as Record<string, unknown>).id : data;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  return null;
}

async function lookup(net: NetCfg, contract: string, owner: string, id: bigint): Promise<string | null> {
  const server = new rpc.Server(net.rpc);
  const latest = (await server.getLatestLedger()).sequence;
  const topic = [nativeToScVal("position_added", { type: "symbol" }).toXDR("base64"), nativeToScVal(owner, { type: "address" }).toXDR("base64")];
  const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [contract], topics: [topic] }];
  // getEvents scans a bounded ledger range per call (about 10k ledgers on testnet) and returns a cursor even for an
  // empty page: page from the oldest retained ledger until the cursor stops moving (the tip) or the id is found
  let res: rpc.Api.GetEventsResponse;
  try {
    res = await server.getEvents({ startLedger: Math.max(1, latest - RETENTION_LEDGERS), filters, limit: 200 });
  } catch {
    // start outside retention: ask once to learn the oldest ledger, then restart there
    const probe = await server.getEvents({ startLedger: latest - 100, filters, limit: 1 });
    res = await server.getEvents({ startLedger: probe.oldestLedger + 1, filters, limit: 200 });
  }
  let last = "";
  for (let page = 0; page < 60; page++) {
    for (const e of res.events) {
      const val = e.value as unknown as xdr.ScVal;
      if (eventPositionId(scValToNative(val)) === id) return e.txHash;
    }
    if (!res.cursor || (res.cursor === last && res.events.length === 0)) break;
    last = res.cursor;
    res = await server.getEvents({ cursor: res.cursor, filters, limit: 200 });
  }
  return null;
}

/** Hash of the add_position transaction of `id` on `contract`, or null (not found / outside retention / RPC error). */
export function positionCreationTx(net: NetCfg, contract: string, owner: string, id: bigint): Promise<string | null> {
  const key = `${net.passphrase}|${contract}|${id}`;
  const cached = lsGet(key);
  if (cached) return Promise.resolve(cached);
  let p = memo.get(key);
  if (!p) {
    p = lookup(net, contract, owner, id)
      .then((h) => {
        if (h) lsSet(key, h);
        else memo.delete(key); // a miss may be an RPC hiccup: allow a later retry
        return h;
      })
      .catch(() => {
        memo.delete(key);
        return null;
      });
    memo.set(key, p);
  }
  return p;
}
