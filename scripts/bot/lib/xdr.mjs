// Transaction result parsing for the bot (stellar-sdk v17 XDR objects are plain data; see
// scripts/lib/stellar.mjs). We reuse arm / decodeClaimAtom / opResults from there and add what the
// bot needs: path payment (strict send AND strict receive) fills, all claim atoms of a tx, and offers.

import { arm, accountIdToStr, decodeClaimAtom, fromStroops, opResults } from '../../lib/stellar.mjs';
import { Asset } from '@stellar/stellar-sdk';

/** Fills + final delivery for a path payment op (either flavour). */
export function parsePathPayment(result, opIndex = 0) {
  const tr = arm(opResults(result)[opIndex]);
  const r = arm(tr);
  const type = r?.type ?? 'unknown';
  if (type !== 'pathPaymentStrictSendSuccess' && type !== 'pathPaymentStrictReceiveSuccess') {
    return { ok: false, code: type };
  }
  const s = arm(r);
  const last = s.last;
  return {
    ok: true,
    fills: s.offers.map(decodeClaimAtom),
    delivered: {
      destination: accountIdToStr(last.destination),
      asset: Asset.fromOperation(last.asset),
      amount: fromStroops(last.amount),
    },
  };
}

/** Every claim atom (fill against a resting offer) of every op in a tx result, decoded. */
export function allFills(result) {
  const out = [];
  let results;
  try {
    results = opResults(result);
  } catch {
    return out;
  }
  for (const opr of results ?? []) {
    try {
      const tr = arm(opr);
      const r = arm(tr);
      const s = r && typeof r === 'object' ? arm(r) : null;
      if (!s) continue;
      const atoms = s.offers ?? s.offersClaimed ?? null;
      if (Array.isArray(atoms)) for (const a of atoms) out.push(decodeClaimAtom(a));
    } catch {
      /* op without fills */
    }
  }
  return out;
}

/** manageSellOffer results of a tx: [{ok, effect, offerId, amountRemaining, claimed}|null per op]. */
export function offerResults(result) {
  let results;
  try {
    results = opResults(result);
  } catch {
    return [];
  }
  return results.map((opr) => {
    try {
      const tr = arm(opr);
      if (tr?.type !== 'manageSellOffer') return null;
      const r = arm(tr);
      if (r.type !== 'manageSellOfferSuccess') return { ok: false, code: r.type };
      const s = arm(r);
      const effect = s.offer.type;
      const entry = effect === 'manageOfferDeleted' ? null : arm(s.offer);
      return {
        ok: true,
        effect,
        offerId: entry ? entry.offerId.toString() : null,
        amountRemaining: entry ? fromStroops(entry.amount) : '0',
        claimed: s.offersClaimed.map(decodeClaimAtom),
      };
    } catch {
      return null;
    }
  });
}
