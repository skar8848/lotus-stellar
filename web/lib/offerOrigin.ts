// Which transaction created each open SDEX offer of an account (for lib/offerGroups.ts).
//
// Horizon /accounts/{id}/transactions returns result_xdr + envelope_xdr. For every manageSellOffer /
// manageBuyOffer / createPassiveSellOffer op that CREATES an offer (offerId 0), the op result
// (success -> offer -> manageOfferCreated) carries the new offer id, and the envelope op carries the initial amount.
// Ops on an existing id with amount 0 are cancellations, with an amount > 0 updates.
// Scan: newest first, up to MAX_BACK_PAGES pages of 200 until every open offer is found, then only newer
// transactions (order=asc from the newest cursor). Cached per (Horizon, account) in memory.

import { Asset, Operation, xdr } from "@stellar/stellar-sdk";
import type { CreatedOffer, OfferTx, OriginIndex } from "./offerGroups";

const PAGE = 200;
const MAX_BACK_PAGES = 3;
const MAX_FORWARD_PAGES = 3;

const assetKeyOf = (a: Asset): string => (a.isNative() ? "native" : `${a.getCode()}:${a.getIssuer()}`);

type OpResultInfo = { kind: "created"; offerId: string } | { kind: "deleted" } | { kind: "updated"; offerId: string } | null;

function offerResults(resultXdr: string): OpResultInfo[] | null {
  const res = xdr.TransactionResult.fromXDR(resultXdr, "base64").result;
  const results =
    res.type === "txSuccess" ? res.results : res.type === "txFeeBumpInnerSuccess" && res.innerResultPair.result.result.type === "txSuccess" ? res.innerResultPair.result.result.results : null;
  if (!results) return null;
  return results.map((r): OpResultInfo => {
    if (r.type !== "opInner") return null;
    const tr = r.tr;
    const m =
      tr.type === "manageSellOffer"
        ? tr.manageSellOfferResult
        : tr.type === "manageBuyOffer"
          ? tr.manageBuyOfferResult
          : tr.type === "createPassiveSellOffer"
            ? tr.createPassiveSellOfferResult
            : null;
    if (!m || (m.type !== "manageSellOfferSuccess" && m.type !== "manageBuyOfferSuccess")) return null;
    const o = m.success.offer;
    if (o.type === "manageOfferCreated") return { kind: "created", offerId: o.offer.offerId.toString() };
    if (o.type === "manageOfferUpdated") return { kind: "updated", offerId: o.offer.offerId.toString() };
    return { kind: "deleted" };
  });
}

function envelopeOps(envelopeXdr: string): xdr.Operation[] {
  const env = xdr.TransactionEnvelope.fromXDR(envelopeXdr, "base64");
  switch (env.type) {
    case "envelopeTypeTxV0":
      return env.v0.tx.operations;
    case "envelopeTypeTx":
      return env.v1.tx.operations;
    case "envelopeTypeTxFeeBump":
      return env.feeBump.tx.innerTx.v1.tx.operations;
    default:
      return [];
  }
}

export type ParsedOfferTx = OfferTx & { cancelled: string[]; updated: string[] };

/** Decode one Horizon transaction record. Null when it touches no offer. Throws on malformed XDR. */
export function parseOfferTx(rec: { hash: string; created_at: string; envelope_xdr: string; result_xdr: string }): ParsedOfferTx | null {
  const results = offerResults(rec.result_xdr);
  if (!results || !results.some(Boolean)) return null;
  const ops = envelopeOps(rec.envelope_xdr);
  const created: CreatedOffer[] = [];
  const cancelled: string[] = [];
  const updated: string[] = [];
  ops.forEach((raw, i) => {
    const r = results[i];
    if (!r) return;
    const op = Operation.fromXDRObject(raw);
    let selling: Asset, buying: Asset, amount: number, id: string;
    if (op.type === "manageSellOffer") {
      ({ selling, buying } = op);
      amount = Number(op.amount);
      id = op.offerId;
    } else if (op.type === "createPassiveSellOffer") {
      ({ selling, buying } = op);
      amount = Number(op.amount);
      id = "0";
    } else if (op.type === "manageBuyOffer") {
      ({ selling, buying } = op);
      // buyAmount of `buying` at price = selling per buying -> selling units
      amount = Number(op.buyAmount) * Number(op.price);
      id = op.offerId;
    } else return;
    if (id === "0" || id === "") {
      if (r.kind === "created" || r.kind === "deleted")
        created.push({ offerId: r.kind === "created" ? r.offerId : null, selling: assetKeyOf(selling), buying: assetKeyOf(buying), initial: amount });
    } else if (amount === 0) cancelled.push(id);
    else updated.push(id);
  });
  if (created.length === 0 && cancelled.length === 0 && updated.length === 0) return null;
  return { hash: rec.hash, createdAt: rec.created_at, created, cancelled, updated };
}

type TxRecord = { hash: string; created_at: string; paging_token: string; envelope_xdr: string; result_xdr: string };

type Cache = {
  index: OriginIndex;
  newest: string | null;
  oldest: string | null;
  exhausted: boolean;
  backPages: number;
  queue: Promise<unknown>;
};
const caches = new Map<string, Cache>();

function ingest(c: Cache, recs: TxRecord[]) {
  for (const rec of recs) {
    let p: ParsedOfferTx | null = null;
    try {
      p = parseOfferTx(rec);
    } catch {
      continue; // one undecodable record never breaks the rest
    }
    if (!p) continue;
    const tx: OfferTx = { hash: p.hash, createdAt: p.createdAt, created: p.created };
    for (const o of p.created) if (o.offerId) c.index.byOffer.set(o.offerId, tx);
    for (const id of p.cancelled) c.index.cancelled.add(id);
    for (const id of p.updated) c.index.updated.add(id);
  }
}

async function page(horizon: string, account: string, order: "asc" | "desc", cursor: string | null): Promise<TxRecord[]> {
  const q = new URLSearchParams({ order, limit: String(PAGE) });
  if (cursor) q.set("cursor", cursor);
  const res = await fetch(`${horizon}/accounts/${account}/transactions?${q}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  const j = (await res.json()) as { _embedded?: { records?: TxRecord[] } };
  return j._embedded?.records ?? [];
}

async function refresh(c: Cache, horizon: string, account: string, offerIds: string[]) {
  if (c.newest) {
    for (let i = 0; i < MAX_FORWARD_PAGES; i++) {
      const recs = await page(horizon, account, "asc", c.newest);
      ingest(c, recs);
      if (recs.length) c.newest = recs[recs.length - 1].paging_token;
      if (recs.length < PAGE) break;
    }
  }
  while (!c.exhausted && c.backPages < MAX_BACK_PAGES && (c.backPages === 0 || offerIds.some((id) => !c.index.byOffer.has(id)))) {
    const recs = await page(horizon, account, "desc", c.oldest);
    ingest(c, recs);
    if (recs.length) {
      if (!c.newest) c.newest = recs[0].paging_token;
      c.oldest = recs[recs.length - 1].paging_token;
    }
    if (recs.length < PAGE) c.exhausted = true;
    c.backPages++;
  }
}

/** Origin index covering `offerIds` as far as the scanned window allows (missing ids: no origin, single rows). */
export function loadOfferOrigins(horizon: string, account: string, offerIds: string[]): Promise<OriginIndex> {
  const key = `${horizon}|${account}`;
  let c = caches.get(key);
  if (!c) {
    c = { index: { byOffer: new Map(), cancelled: new Set(), updated: new Set() }, newest: null, oldest: null, exhausted: false, backPages: 0, queue: Promise.resolve() };
    caches.set(key, c);
  }
  const cache = c;
  const run = cache.queue.then(() => refresh(cache, horizon, account, offerIds));
  cache.queue = run.catch(() => undefined);
  return run.then(() => ({ byOffer: new Map(cache.index.byOffer), cancelled: new Set(cache.index.cancelled), updated: new Set(cache.index.updated) }));
}
