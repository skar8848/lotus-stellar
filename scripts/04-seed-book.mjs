#!/usr/bin/env node
// 04 - Seed the two SDEX books that make the demo work.
//
//   (a) peg_lp: two-sided underlying/receipt book around 1:1 (5 bps each side), so anyone holding
//       the underlying can path-pay THROUGH the receipt without ever holding it.
//   (b) maker: a ladder of sell offers LBOND -> receipt at 0.98, 0.99, 1.00, 1.01, 1.02 (a bond
//       trading near par), posted in ONE transaction (5 ManageSellOffer ops).
//
// What it proves: the receipt is a first-class SDEX asset. The maker's receipt (and the receipt it
// earns from fills) sits on its own account while quoted: SDEX offers only create "selling
// liabilities", the funds never leave the account, so quoted inventory keeps earning yield.
//
//   --reset           cancel all existing offers of peg_lp and maker before posting
//   --peg-size 200    size of each peg side (receipt / underlying)
//   --level-size 100  LBOND per ladder level
//   --levels 0.98,0.99,1.00,1.01,1.02

import { parseArgs, saveClassic } from './lib/config.mjs';
import { lotusContext } from './lib/lotus.mjs';
import {
  Asset,
  Operation,
  accountLink,
  assetLabel,
  balanceLine,
  fmt,
  horizonOffersLink,
  horizonOrderbookLink,
  listOffers,
  loadAccount,
  marketLink,
  orderbook,
  parseManageSellOffers,
  submitClassic,
} from './lib/stellar.mjs';
import { h1, step, ok, info, kv, link, warn, table, die } from './lib/log.mjs';

// price as an exact fraction {n, d}: price = n/d units of `buying` per 1 unit of `selling`
const PEG_SPREAD_BPS = 5n;

export async function printBook(ctx, selling, buying, { title } = {}) {
  const ob = await orderbook(ctx, selling, buying, 10);
  const s = assetLabel(selling);
  const b = assetLabel(buying);
  step(title ?? `order book ${s}/${b}  (price = ${b} per 1 ${s})`);
  info(`asks: offers SELLING ${s} for ${b}        bids: offers BUYING ${s} with ${b}`);
  const rows = [];
  const n = Math.max(ob.asks.length, ob.bids.length);
  for (let i = 0; i < n; i++) {
    const a = ob.asks[i];
    const bd = ob.bids[i];
    rows.push([
      bd ? `${fmt(bd.amount)} ${s}` : '',
      bd ? Number(bd.price).toFixed(4) : '',
      '|',
      a ? Number(a.price).toFixed(4) : '',
      a ? `${fmt(a.amount)} ${s}` : '',
    ]);
  }
  table(['bid size', 'bid', ' ', 'ask', 'ask size'], rows);
  link('horizon', horizonOrderbookLink(ctx, selling, buying));
  link('stellar.expert', marketLink(selling, buying));
  return ob;
}

async function cancelAll(ctx, kp, label) {
  const offers = await listOffers(ctx, kp.publicKey());
  if (!offers.length) return;
  const ops = offers.slice(0, 100).map((o) =>
    Operation.manageSellOffer({
      selling: assetFromHorizon(o.selling),
      buying: assetFromHorizon(o.buying),
      amount: '0',
      price: o.price_r ? { n: o.price_r.n, d: o.price_r.d } : o.price,
      offerId: o.id,
    }),
  );
  const r = await submitClassic(ctx, { source: kp, ops, memo: 'cancel offers' });
  ok(`${label}: cancelled ${ops.length} offer(s)`);
  link('tx', r.link);
}

function assetFromHorizon(a) {
  return a.asset_type === 'native' ? Asset.native() : new Asset(a.asset_code, a.asset_issuer);
}

async function main() {
  const args = parseArgs();
  h1('04 - seed the SDEX books (peg + bond ladder)');
  const lt = lotusContext();
  const { ctx, underlying, receipt } = lt;
  const rwa = lt.cfg.classic.rwa;
  if (!rwa) die('LBOND not issued yet: run scripts/02-issue-rwa.mjs first');
  const lbond = new Asset(rwa.code, rwa.issuer);
  const uLabel = assetLabel(underlying);
  const rLabel = receipt.getCode();

  const pegLp = lt.keypair('peg_lp');
  const maker = lt.keypair('maker');
  const pegSize = String(args['peg-size'] ?? '200');
  const levelSize = String(args['level-size'] ?? '100');
  const levels = String(args.levels ?? '0.98,0.99,1.00,1.01,1.02').split(',').map((s) => s.trim());
  const txs = {};
  const offers = { peg: {}, ladder: [] };

  if (args.reset) {
    step('--reset: cancelling existing offers');
    await cancelAll(ctx, pegLp, 'peg_lp');
    await cancelAll(ctx, maker, 'maker');
  }

  // ---------------------------------------------------------------- (a) peg book
  step(`peg_lp ${pegLp.publicKey()}: two-sided ${uLabel}/${rLabel} book around 1:1`);
  link('account', accountLink(pegLp.publicKey()));
  const pegAcc = await loadAccount(ctx, pegLp.publicKey());
  const pegR = balanceLine(pegAcc, receipt);
  const pegU = balanceLine(pegAcc, underlying);
  kv(`${rLabel} balance`, fmt(pegR?.balance ?? '0'));
  kv(`${uLabel} balance`, fmt(pegU?.balance ?? '0'));
  if (!pegR || Number(pegR.balance) < Number(pegSize)) die(`peg_lp needs >= ${pegSize} ${rLabel}: run scripts/03-mint-receipt.mjs`);

  const existing = await listOffers(ctx, pegLp.publicKey());
  if (existing.length && !args.reset) {
    ok(`peg_lp already has ${existing.length} open offer(s); not re-posting (use --reset to rebuild)`);
    for (const o of existing) offers.peg[o.id] = `${assetLabel(assetFromHorizon(o.selling))}->${assetLabel(assetFromHorizon(o.buying))} ${o.amount} @ ${o.price}`;
  } else {
    // sell receipt for underlying at 1 + 5bps ; sell underlying for receipt at 1/(1 - 5bps)
    // The two sides are from the same account, so they must not cross (MANAGE_SELL_OFFER_CROSS_SELF).
    const askPrice = { n: Number(10000n + PEG_SPREAD_BPS), d: 10000 }; // underlying per receipt
    const bidPrice = { n: 10000, d: Number(10000n - PEG_SPREAD_BPS) }; // receipt per underlying
    const r = await submitClassic(ctx, {
      source: pegLp,
      ops: [
        Operation.manageSellOffer({ selling: receipt, buying: underlying, amount: pegSize, price: askPrice, offerId: '0' }),
        Operation.manageSellOffer({ selling: underlying, buying: receipt, amount: pegSize, price: bidPrice, offerId: '0' }),
      ],
      memo: 'lotus peg book',
    });
    txs.peg_book = r.hash;
    const parsed = parseManageSellOffers(r.result);
    offers.peg = {
      sell_receipt: { offer_id: parsed[0]?.offerId, amount: pegSize, price: `${askPrice.n}/${askPrice.d}` },
      sell_underlying: { offer_id: parsed[1]?.offerId, amount: pegSize, price: `${bidPrice.n}/${bidPrice.d}` },
    };
    ok(`posted: sell ${fmt(pegSize)} ${rLabel} @ ${(askPrice.n / askPrice.d).toFixed(4)} ${uLabel}  (offer ${parsed[0]?.offerId})`);
    ok(`posted: sell ${fmt(pegSize)} ${uLabel} @ ${(bidPrice.n / bidPrice.d).toFixed(4)} ${rLabel}  (offer ${parsed[1]?.offerId})`);
    link('tx', r.link);
  }
  link('offers', horizonOffersLink(ctx, pegLp.publicKey()));

  // ---------------------------------------------------------------- (b) bond ladder
  step(`maker ${maker.publicKey()}: ladder of ${levels.length} sell offers ${rwa.code} -> ${rLabel} in ONE transaction`);
  link('account', accountLink(maker.publicKey()));
  const makerAcc = await loadAccount(ctx, maker.publicKey());
  const makerB = balanceLine(makerAcc, lbond);
  const makerR = balanceLine(makerAcc, receipt);
  kv(`${rwa.code} balance`, fmt(makerB?.balance ?? '0'));
  kv(`${rLabel} balance`, fmt(makerR?.balance ?? '0'));
  if (!makerR) die(`maker has no ${rLabel} trustline: run scripts/03-mint-receipt.mjs`);

  const makerOffers = await listOffers(ctx, maker.publicKey());
  if (makerOffers.length && !args.reset) {
    ok(`maker already has ${makerOffers.length} open offer(s); not re-posting (use --reset to rebuild)`);
    offers.ladder = makerOffers.map((o) => ({ offer_id: o.id, amount: o.amount, price: o.price }));
  } else {
    const ops = levels.map((p) => {
      const [i, f = ''] = p.split('.');
      const d = 10 ** f.length;
      const n = Number(i) * d + Number(f || 0);
      return Operation.manageSellOffer({ selling: lbond, buying: receipt, amount: levelSize, price: { n, d }, offerId: '0' });
    });
    const r = await submitClassic(ctx, { source: maker, ops, memo: 'lotus bond ladder' });
    txs.bond_ladder = r.hash;
    const parsed = parseManageSellOffers(r.result);
    offers.ladder = levels.map((p, idx) => ({ offer_id: parsed[idx]?.offerId, amount: levelSize, price: p }));
    for (const l of offers.ladder) ok(`posted: sell ${fmt(l.amount)} ${rwa.code} @ ${l.price} ${rLabel}  (offer ${l.offer_id})`);
    link('tx', r.link);
    kv('ops in tx', String(ops.length));
  }
  link('offers', horizonOffersLink(ctx, maker.publicKey()));
  const makerAfter = balanceLine(await loadAccount(ctx, maker.publicKey()), lbond);
  kv(`${rwa.code} on account`, `${fmt(makerAfter.balance)}  (selling_liabilities ${fmt(makerAfter.selling_liabilities)}: still on the account, only reserved)`);

  // ---------------------------------------------------------------- books
  await printBook(ctx, receipt, underlying, { title: `order book ${rLabel}/${uLabel}  (peg: price = ${uLabel} per 1 ${rLabel})` });
  await printBook(ctx, lbond, receipt, { title: `order book ${rwa.code}/${rLabel}  (ladder: price = ${rLabel} per 1 ${rwa.code})` });

  saveClassic({ offers, tx: { seed_book: txs } });
  ok('wrote deployments/testnet.classic.json');
  if (!Object.keys(txs).length) warn('no new transactions this run');
  info('next: node scripts/05-demo-take.mjs');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) main().catch((e) => die(e?.stack ?? String(e)));
