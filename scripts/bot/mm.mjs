// Market maker (mm_a) and flow generator (mm_b).
//
// mm_a keeps four groups of resting offers, all in ONE account (an account cannot cross itself, and every
// quote stays on its own side of fair value, so it never does):
//   bond asks  LBOND -> lUSDC   at fair * (1 + half + i*spacing)         i = 0..levels-1
//   bond bids  lUSDC -> LBOND   at fair * (1 - half - i*spacing)
//   peg ask    lUSDC -> USDC    at 1 + 1 bp
//   peg bid    USDC  -> lUSDC   at 1 - 1 bp
//   usdc asks  LBOND -> USDC    at fair * (1 + half + i*spacing)         i = 0..usdcLevels-1   (--usdc-book on)
//   usdc bids  USDC  -> LBOND   at fair * (1 - half - i*spacing)
// Every tick it reads its own offers, diffs them against the target slots and sends at most ONE transaction:
// only the slots whose price drifted more than --requote-bps, or whose size is below --refill-frac of target.
// Quotes are clamped so they never cross another account's offers (the demo ladder, peg_lp, mm_b's shock
// offers): the bot never cancels or modifies offers it does not own.
//
// mm_b is the flow generator: it takes small clips of liquidity at random, log-normally distributed sizes
// and clustered arrival times, alternating direction, on the peg book and the bond book (sometimes routed
// USDC -> lUSDC -> LBOND in one path payment, like script 05). It rests no offers on those books, so its
// own trades can never cross itself.

import { Operation } from '@stellar/stellar-sdk';
import { assetLabel, fromStroops, toStroops } from '../lib/stellar.mjs';
import { amt7, amt7Ceil, amt7Floor, invPriceFrac, priceFrac, walkAsks, walkBids } from './lib/book.mjs';
import { offerResults, parsePathPayment } from './lib/xdr.mjs';
import { TxError } from './lib/chain.mjs';
import { firstLine } from './lib/bot.mjs';
import { RC } from './lib/names.mjs';
import { foreignBest, knownPrefix, takesTeam, teamOffers } from './lib/owners.mjs';
import { gauss } from './lib/nav.mjs';

const aKey = (a) => (a.isNative() ? 'XLM' : `${a.getCode()}:${a.getIssuer()}`);
const hKey = (a) => (a.asset_type === 'native' ? 'XLM' : `${a.asset_code}:${a.asset_issuer}`);
const r5 = (x) => Math.round(x * 1e5) / 1e5;
/** amount for log lines: up to 4 decimals, trailing zeros trimmed */
const t4 = (x) => Number(x).toFixed(4).replace(/\.?0+$/, '');
const same = (a, b) => Math.abs(a - b) < 6e-8;
const GROUPS = ['bondAsks', 'bondBids', 'usdcAsks', 'usdcBids', 'pegAsks', 'pegBids'];
const EMPTY_BOOK = Object.freeze({ bids: [], asks: [] });


/** mm_a's own offers (+ the team's demo offers with --ladder take), shared by every reader, refreshed when stale. */
export async function mmView(bot, maxAgeMs = 30_000) {
  if (!bot.mmState.offers || Date.now() - bot.mmState.at > maxAgeMs) {
    const mm = new MarketMaker(bot);
    const offers = mm.classify(await bot.chain.accountOffers(bot.acct.mm_a.pub));
    const team = await teamOffers(bot, (raw) => mm.classify(raw));
    bot.mmState = { offers, team, at: Date.now() };
  }
  return bot.mmState;
}

// ===================================================================== market maker

export class MarketMaker {
  constructor(bot) {
    this.bot = bot;
    this.keys = { lbond: aKey(bot.assets.lbond), lusdc: aKey(bot.assets.lusdc), usdc: aKey(bot.assets.usdc) };
    this.lastFair = null;
    this.requotes = 0;
    this.sizeScale = 1;
    this.resetNext = false;
    this.inflight = null;
    this.lastQuote = { bondAsk: null, bondBid: null, pegAsk: null, pegBid: null };
    this.lastBudgetWarn = 0;
  }

  /** Classify raw Horizon offers of mm_a into the four groups (best price first). */
  classify(offers) {
    const K = this.keys;
    const out = { bondAsks: [], bondBids: [], usdcAsks: [], usdcBids: [], pegAsks: [], pegBids: [], other: [] };
    for (const o of offers) {
      const sel = hKey(o.selling);
      const buy = hKey(o.buying);
      const amount = Number(o.amount);
      const price = Number(o.price);
      const rec = { id: o.id, amount, price, pr: o.price_r, selling: o.selling, buying: o.buying };
      if (sel === K.lbond && buy === K.lusdc) out.bondAsks.push({ ...rec, quote: price, size: amount });
      else if (sel === K.lusdc && buy === K.lbond) out.bondBids.push({ ...rec, quote: 1 / price, size: amount * price });
      else if (sel === K.lusdc && buy === K.usdc) out.pegAsks.push({ ...rec, quote: price, size: amount });
      else if (sel === K.usdc && buy === K.lusdc) out.pegBids.push({ ...rec, quote: 1 / price, size: amount * price });
      else if (sel === K.lbond && buy === K.usdc) out.usdcAsks.push({ ...rec, quote: price, size: amount });
      else if (sel === K.usdc && buy === K.lbond) out.usdcBids.push({ ...rec, quote: 1 / price, size: amount * price });
      else out.other.push(rec);
    }
    for (const g of ['bondAsks', 'usdcAsks', 'pegAsks']) out[g].sort((a, b) => a.quote - b.quote);
    for (const g of ['bondBids', 'usdcBids', 'pegBids']) out[g].sort((a, b) => b.quote - a.quote);
    return out;
  }

  /**
   * Best price held by somebody else at the touch: book levels minus what mm_a itself has at the same price, and minus
   * the team's demo offers when --ladder take (those may be traded through; app users' offers never are).
   */
  foreignTouch(book, ownAsks, ownBids, teamAsks = [], teamBids = []) {
    return { minAsk: foreignBest(book.asks, [ownAsks, teamAsks]), maxBid: foreignBest(book.bids, [ownBids, teamBids]) };
  }

  /**
   * Target quotes. `fair` is LBOND in USDC, `pegMid` the receipt in USDC (1 = par): the LBOND/receipt ladder is
   * centred on fair / pegMid so the three books stay consistent (LBOND/receipt = LBOND/USDC / receipt/USDC).
   * Every book is clamped against other accounts' offers (app users rest orders on all three); with --ladder take the
   * team's demo offers are not clamped against, so a quote may trade through a stale demo level.
   */
  targets(fair, own, bondBook, pegBook, bal, usdcBook = EMPTY_BOOK, team = null, pegMid = 1) {
    const s = this.bot.settings;
    const half = s.halfSpreadBps / 1e4;
    const sp = s.spacingBps / 1e4;
    const ph = s.pegHalfSpreadBps / 1e4;
    const tm = team ?? { bondAsks: [], bondBids: [], usdcAsks: [], usdcBids: [], pegAsks: [], pegBids: [] };
    const t = { bondAsks: [], bondBids: [], usdcAsks: [], usdcBids: [], pegAsks: [], pegBids: [] };
    const bondF = this.foreignTouch(bondBook, own.bondAsks, own.bondBids, tm.bondAsks, tm.bondBids);
    const pegF = this.foreignTouch(pegBook, own.pegAsks, own.pegBids, tm.pegAsks, tm.pegBids);
    const usdcF = this.foreignTouch(usdcBook, own.usdcAsks, own.usdcBids, tm.usdcAsks, tm.usdcBids);
    const bondFair = fair / pegMid;

    for (let i = 0; i < s.levels; i++) {
      let ask = bondFair * (1 + half + i * sp);
      let bid = bondFair * (1 - half - i * sp);
      if (bondF.minAsk != null) bid = Math.min(bid, bondF.minAsk * (1 - 1e-4) * (1 - i * sp));
      if (bondF.maxBid != null) ask = Math.max(ask, bondF.maxBid * (1 + 1e-4) * (1 + i * sp));
      t.bondAsks.push({ quote: r5(ask), size: s.levelSize * this.sizeScale });
      t.bondBids.push({ quote: r5(bid), size: s.levelSize * this.sizeScale });
    }
    // LBOND/USDC: the same fair value and ladder shape as LBOND/receipt
    if (s.usdcBook === 'on') {
      for (let i = 0; i < s.usdcLevels; i++) {
        let ask = fair * (1 + half + i * sp);
        let bid = fair * (1 - half - i * sp);
        if (usdcF.minAsk != null) bid = Math.min(bid, usdcF.minAsk * (1 - 1e-4) * (1 - i * sp));
        if (usdcF.maxBid != null) ask = Math.max(ask, usdcF.maxBid * (1 + 1e-4) * (1 + i * sp));
        t.usdcAsks.push({ quote: r5(ask), size: s.usdcLevelSize * this.sizeScale });
        t.usdcBids.push({ quote: r5(bid), size: s.usdcLevelSize * this.sizeScale });
      }
    }
    // Peg book: centred on the (noisy) peg mid, but always inside the arbitrageur's no-trade band, so mm_a never
    // offers the receipt cheap enough to be bought and redeemed, nor bids it high enough to be minted and sold into.
    const thr = s.arbThresholdBps / 1e4;
    const guard = 0.5e-4;
    let pAsk = Math.max(pegMid + ph, 1 - thr + guard);
    let pBid = Math.min(pegMid - ph, 1 + thr - guard);
    if (pAsk - pBid < 1e-4) {
      const m = (pAsk + pBid) / 2;
      pAsk = m + 0.5e-4;
      pBid = m - 0.5e-4;
    }
    if (pegF.minAsk != null) pBid = Math.min(pBid, pegF.minAsk * (1 - 1e-4));
    if (pegF.maxBid != null) pAsk = Math.max(pAsk, pegF.maxBid * (1 + 1e-4));
    t.pegAsks.push({ quote: Math.round(pAsk * 1e6) / 1e6, size: s.pegSize * this.sizeScale });
    t.pegBids.push({ quote: Math.round(pBid * 1e6) / 1e6, size: s.pegSize * this.sizeScale });

    // inventory budget: never promise more than the account holds
    if (bal) {
      const lusdcNeed = t.bondBids.reduce((x, o) => x + o.size * o.quote, 0) + t.pegAsks[0].size;
      const usdcNeed = t.pegBids[0].size * t.pegBids[0].quote;
      const lbondNeed = t.bondAsks.reduce((x, o) => x + o.size, 0) + t.usdcAsks.reduce((x, o) => x + o.size, 0);
      const kL = Math.min(1, (bal.lusdc * 0.96) / Math.max(lusdcNeed, 1e-9));
      // USDC: the peg bid is funded first (it defends the receipt peg), the LBOND/USDC bids get what is left. When the
      // Lotus pool is on and mm_a has no Bid position yet, the USDC that position needs is kept aside as well.
      const poolReserve = this.bot.poolAdapter && !this.bot.poolState?.mine?.Bid ? s.poolBidSize * 1.1 : 0;
      const usdcAvail = Math.max(0, bal.usdc - poolReserve) * 0.96;
      const kU = Math.min(1, usdcAvail / Math.max(usdcNeed, 1e-9));
      const usdcBookNeed = t.usdcBids.reduce((x, o) => x + o.size * o.quote, 0);
      const kUB = usdcBookNeed > 0 ? Math.min(1, Math.max(0, usdcAvail - usdcNeed * kU) / usdcBookNeed) : 1;
      const kB = Math.min(1, (bal.lbond * 0.96) / Math.max(lbondNeed, 1e-9));
      for (const o of t.bondBids) o.size *= kL;
      t.pegAsks[0].size *= kL;
      t.pegBids[0].size *= kU;
      for (const o of t.bondAsks) o.size *= kB;
      for (const o of t.usdcAsks) o.size *= kB;
      for (const o of t.usdcBids) o.size *= kUB;
      // a level too small to be worth an offer is dropped (an existing one is then cancelled by the diff)
      t.usdcBids = t.usdcBids.filter((o) => o.size >= 1);
      t.usdcAsks = t.usdcAsks.filter((o) => o.size >= 1);
      if (kL < 0.999 && Date.now() - (this.lastRcWarn ?? 0) > 60_000 && (this.lastRcWarn = Date.now())) this.bot.log.warn('mm_a', `${RC} inventory (${bal.lusdc.toFixed(2)}) limits the quotes: scaling ${RC}-funded sizes by ${kL.toFixed(2)}`);
      if (kUB < 0.999 && Date.now() - this.lastBudgetWarn > 60_000) {
        this.lastBudgetWarn = Date.now();
        this.bot.log.warn('mm_a', `USDC inventory (${bal.usdc.toFixed(2)}${poolReserve ? `, ${poolReserve.toFixed(0)} kept for the pool Bid` : ''}) limits the LBOND/USDC bids: scaling them by ${kUB.toFixed(2)}${t.usdcBids.length < s.usdcLevels ? ` (${t.usdcBids.length}/${s.usdcLevels} levels left)` : ''}`);
      }
    }
    return t;
  }

  makeOp(group, tg, offerId = '0') {
    const { lbond, lusdc, usdc } = this.bot.assets;
    switch (group) {
      case 'bondAsks':
        return Operation.manageSellOffer({ selling: lbond, buying: lusdc, amount: amt7Floor(tg.size), price: priceFrac(tg.quote), offerId });
      case 'bondBids':
        return Operation.manageSellOffer({ selling: lusdc, buying: lbond, amount: amt7Floor(tg.size * tg.quote), price: invPriceFrac(tg.quote), offerId });
      case 'pegAsks':
        return Operation.manageSellOffer({ selling: lusdc, buying: usdc, amount: amt7Floor(tg.size), price: priceFrac(tg.quote), offerId });
      case 'pegBids':
        return Operation.manageSellOffer({ selling: usdc, buying: lusdc, amount: amt7Floor(tg.size * tg.quote), price: invPriceFrac(tg.quote), offerId });
      case 'usdcAsks':
        return Operation.manageSellOffer({ selling: lbond, buying: usdc, amount: amt7Floor(tg.size), price: priceFrac(tg.quote), offerId });
      case 'usdcBids':
        return Operation.manageSellOffer({ selling: usdc, buying: lbond, amount: amt7Floor(tg.size * tg.quote), price: invPriceFrac(tg.quote), offerId });
      default:
        throw new Error(`unknown group ${group}`);
    }
  }

  cancelOp(ex) {
    const toAsset = (a) => (a.asset_type === 'native' ? null : a);
    void toAsset;
    const { lbond, lusdc, usdc } = this.bot.assets;
    const byKey = { [this.keys.lbond]: lbond, [this.keys.lusdc]: lusdc, [this.keys.usdc]: usdc };
    return Operation.manageSellOffer({
      selling: byKey[hKey(ex.selling)],
      buying: byKey[hKey(ex.buying)],
      amount: '0',
      price: { n: ex.pr.n, d: ex.pr.d },
      offerId: ex.id,
    });
  }

  /** Diff existing vs target for one group -> [{kind, op, group, i}] */
  diffGroup(group, existing, targets, force) {
    const s = this.bot.settings;
    const thr = (group.startsWith('bond') || group.startsWith('usdc') ? s.requoteBps : 0.2) / 1e4;
    const out = [];
    for (let i = 0; i < targets.length; i++) {
      const tg = targets[i];
      const ex = force ? null : existing[i];
      if (!ex) {
        out.push({ kind: 'create', group, i, op: this.makeOp(group, tg) });
        continue;
      }
      const moved = Math.abs(ex.quote - tg.quote) / tg.quote > thr;
      const consumed = ex.size < s.refillFrac * tg.size;
      const oversize = ex.size > tg.size * 1.25;
      if (moved || consumed || oversize) {
        out.push({ kind: 'update', group, i, op: this.makeOp(group, tg, ex.id), why: moved ? 'moved' : consumed ? 'refill' : 'resize' });
      }
    }
    for (let i = targets.length; i < existing.length; i++) out.push({ kind: 'cancel', group, i, op: this.cancelOp(existing[i]) });
    return out;
  }

  /** One quoting pass. Re-entrant calls (loop tick + a scenario's explicit call) share the in-flight pass. */
  tick() {
    if (this.inflight) return this.inflight;
    this.inflight = this.pass().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async pass() {
    const { bot } = this;
    const { chain, settings: s, assets, acct, log } = bot;
    if (bot.paused.mm) return;
    const f = bot.nav.step();
    const usdcOn = s.usdcBook === 'on';
    const [offersRaw, bondBook, pegBook, usdcBook] = await Promise.all([
      chain.accountOffers(acct.mm_a.pub),
      chain.orderBook(assets.lbond, assets.lusdc),
      chain.orderBook(assets.lusdc, assets.usdc),
      usdcOn ? chain.orderBook(assets.lbond, assets.usdc) : EMPTY_BOOK,
    ]);
    const own = this.classify(offersRaw);
    const team = await teamOffers(bot, (raw) => this.classify(raw));
    bot.mmState = { offers: own, team, at: Date.now() };
    const pegMid = s.pegNoiseBps > 0 ? Math.round(bot.peg.step().mid * 2e4) / 2e4 : 1; // 0.5 bp steps
    // balances move every time a quote is hit: keep the inventory budget honest (one extra read when stale)
    const bal = bot.balances.mm_a && Date.now() - bot.balances.mm_a.at < 6_000 ? bot.balances.mm_a : await chain.refreshBalances('mm_a');
    const fair = r5(f.fair);

    if (this.resetNext) {
      this.resetNext = false;
      await this.cancelAll(own);
      return;
    }
    const tg = this.targets(fair, own, bondBook, pegBook, bal, usdcBook, team, pegMid);
    const force = false;
    let changes = [];
    for (const g of GROUPS) changes.push(...this.diffGroup(g, own[g], tg[g], force));
    if (!changes.length) return;

    // order: cancels first, then the side that moves away from the other one first so a bid never sits above an ask
    const up = this.lastFair == null || fair >= this.lastFair;
    const order = up ? ['bondAsks', 'bondBids', 'usdcAsks', 'usdcBids', 'pegAsks', 'pegBids'] : ['bondBids', 'bondAsks', 'usdcBids', 'usdcAsks', 'pegBids', 'pegAsks'];
    changes.sort((a, b) => (a.kind === 'cancel' ? -1 : 0) - (b.kind === 'cancel' ? -1 : 0) || order.indexOf(a.group) - order.indexOf(b.group) || a.i - b.i);
    const ops = changes.map((c) => c.op);

    const created = changes.filter((c) => c.kind === 'create').length;
    const updated = changes.filter((c) => c.kind === 'update').length;
    const cancelled = changes.filter((c) => c.kind === 'cancel').length;
    const bondTouched = changes.some((c) => c.group.startsWith('bond') || c.group.startsWith('usdc'));
    const range = (arr) => (arr.length ? `${arr[0].quote.toFixed(5)}..${arr[arr.length - 1].quote.toFixed(5)}` : '-');
    const desc = `fair ${fair.toFixed(5)}${pegMid !== 1 ? ` peg mid ${pegMid.toFixed(5)}` : ''} | bond asks ${range(tg.bondAsks)} bids ${range(tg.bondBids)}${usdcOn || own.usdcAsks.length || own.usdcBids.length ? ` | usdc asks ${range(tg.usdcAsks)} bids ${range(tg.usdcBids)}` : ''} | peg ${tg.pegBids[0].quote.toFixed(4)}/${tg.pegAsks[0].quote.toFixed(4)} | ${ops.length} op(s): ${created} new, ${updated} updated, ${cancelled} cancelled (${[...new Set(changes.map((c) => c.why ?? c.kind))].join(',')})`;

    if (s.dryRun) {
      log.dry('mm_a', `would re-quote: ${desc}`);
      return;
    }
    try {
      const res = await chain.submit({ label: 'mm_a', ops, memo: 'lotus mm quotes' });
      this.requotes += 1;
      if (bondTouched) this.lastFair = fair;
      this.sizeScale = Math.min(1, this.sizeScale * 1.15);
      bot.mmState = { ...bot.mmState, at: 0 }; // offers changed: readers refetch them
      bot.stats.requotes = (bot.stats.requotes ?? 0) + 1;
      log.act('mm_a', `QUOTE ${desc}`, res.hash);
      const bad = offerResults(res.result).filter((r) => r && r.ok && r.claimed?.length);
      if (bad.length) log.info('mm_a', `${bad.length} quote op(s) traded through the team's stale demo offers on posting (--ladder take)`);
    } catch (e) {
      if (e instanceof TxError) {
        if (e.opCodes.includes('op_cross_self')) {
          log.warn('mm_a', 'op_cross_self: cancelling all of mm_a\'s offers and re-posting on the next tick');
          this.resetNext = true;
        } else if (e.opCodes.includes('op_underfunded')) {
          this.sizeScale = Math.max(0.2, this.sizeScale * 0.7);
          log.warn('mm_a', `op_underfunded: reducing quote sizes to ${(this.sizeScale * 100).toFixed(0)}%`);
        }
      }
      throw e;
    }
  }

  async cancelAll(own) {
    const all = [...GROUPS.flatMap((g) => own[g]), ...own.other];
    if (!all.length) return;
    const ops = all.slice(0, 100).map((o) => this.cancelOp(o));
    const res = await this.bot.chain.submit({ label: 'mm_a', ops, memo: 'lotus mm reset' });
    this.bot.log.act('mm_a', `RESET cancelled ${ops.length} own offer(s)`, res.hash);
  }
}

// ===================================================================== flow generator

export class Flow {
  constructor(bot) {
    this.bot = bot;
    this.dir = { peg: 'buy', bond: 'sell', usdc: 'buy' };
    this.burstLeft = 0;
    this.pace = null; // {min, max} seconds: scripted override (demo bursts)
    this.lastRebalance = Date.now();
    this.skipped = 0;
    this.trades = [];
  }

  /** ms until the next trade: exponential around the configured window, with occasional short bursts. */
  nextDelayMs() {
    const s = this.bot.settings;
    if (this.pace) return (this.pace.min + Math.random() * (this.pace.max - this.pace.min)) * 1000;
    if (this.burstLeft > 0) {
      this.burstLeft -= 1;
      return (1.5 + Math.random() * 3) * 1000;
    }
    const mean = (s.flowMinSec + s.flowMaxSec) / 2;
    let d = -Math.log(1 - Math.random()) * mean;
    d = Math.min(Math.max(d, s.flowMinSec * 0.35), s.flowMaxSec * 3);
    if (Math.random() < 0.12) this.burstLeft = 1 + Math.floor(Math.random() * 3);
    return d * 1000;
  }

  /**
   * Log-normal clip size around the geometric middle of [lo, hi]; ~30% snap to round numbers.
   * Classic mode: lo/hi = --flow-size-min/max, clamped to [lo/2, hi*5]. Live mode passes per-market bounds and
   * a sigma that puts lo and hi about two standard deviations out, clamped to [lo, hi].
   */
  pickSize(lo, hi) {
    const s = this.bot.settings;
    const live = lo != null;
    lo ??= s.flowSizeMin;
    hi ??= s.flowSizeMax;
    const median = Math.sqrt(lo * hi);
    const sigma = live ? Math.max(0.3, Math.log(hi / lo) / 4) : 0.75;
    let x = median * Math.exp(sigma * gauss());
    x = live ? Math.min(Math.max(x, lo), hi) : Math.min(Math.max(x, lo * 0.5), hi * 5);
    if (Math.random() < 0.3) {
      const round = [1, 2, 5, 10, 20, 25, 50, 75, 100].reduce((best, r) => (Math.abs(r - x) < Math.abs(best - x) ? r : best), 1);
      x = round;
    } else {
      x = Math.round(x * 100) / 100;
    }
    return live ? Math.min(Math.max(x, lo), hi) : x;
  }

  /**
   * Base-unit capacity of the leading book levels that hold only mm_a's offers (+ the team's demo offers with
   * --ladder take). Stops at the first level holding anybody else's liquidity, unless --flow-touch-foreign.
   */
  capacity(levels, ownList, used = 0, teamList = []) {
    const lv = this.bot.settings.flowTouchForeign ? levels : knownPrefix(levels, [ownList, teamList]);
    const cap = lv.reduce((x, l) => x + l.amount, 0);
    return Math.max(0, cap - used);
  }

  async tick() {
    const { bot } = this;
    const { chain, settings: s, assets, acct, log } = bot;
    if (bot.paused.flow) return;
    const view = await mmView(bot);
    const own = view.offers;
    const team = view.team;
    const usdcOn = s.usdcBook === 'on';
    const [pegBook, bondBook, usdcBook] = await Promise.all([
      chain.orderBook(assets.lusdc, assets.usdc),
      chain.orderBook(assets.lbond, assets.lusdc),
      usdcOn ? chain.orderBook(assets.lbond, assets.usdc) : EMPTY_BOOK,
    ]);
    const bal = bot.balances.mm_b ?? (await chain.refreshBalances('mm_b'));

    // some of the flow goes to the Lotus pool when it is live and mm_a has positions there
    if (bot.poolAdapter && Math.random() < s.flowPoolWeight) {
      try {
        if (await this.tickPool(bal)) return;
      } catch (e) {
        if (e?.name === 'StopBot') throw e;
        log.err('flow', `pool trade failed: ${firstLine(e)}`);
        return;
      }
    }

    // candidate (book, direction) pairs in random order, starting from the preferred book/direction
    const preferPeg = Math.random() < s.flowPegWeight;
    const flip = (d) => (d === 'buy' ? 'sell' : 'buy');
    const dirFor = (book) => (Math.random() < 0.75 ? flip(this.dir[book]) : Math.random() < 0.5 ? 'buy' : 'sell');
    const first = preferPeg ? 'peg' : 'bond';
    const second = preferPeg ? 'bond' : 'peg';
    const d1 = dirFor(first);
    const d2 = dirFor(second);
    const candidates = [
      [first, d1],
      [first, flip(d1)],
      [second, d2],
      [second, flip(d2)],
    ];
    const routedOk = Math.random() < 0.12;
    if (routedOk) candidates.unshift(['routed', Math.random() < 0.5 ? 'buy' : 'sell']);
    // LBOND/USDC: first choice for ~flowUsdcWeight of the trades, otherwise a fallback after the receipt books
    if (usdcOn) {
      const du = dirFor('usdc');
      const pair = [['usdc', du], ['usdc', flip(du)]];
      if (Math.random() < s.flowUsdcWeight) candidates.unshift(...pair);
      else candidates.push(...pair);
    }

    const size0 = this.pickSize();
    for (const [book, dir] of candidates) {
      const plan = this.plan(book, dir, size0, { pegBook, bondBook, usdcBook, own, team, bal });
      if (!plan) continue;
      await this.executeBatch([plan]);
      if (book !== 'routed') this.dir[book] = dir;
      return;
    }
    this.skipped += 1;
    log.info('flow', `no feasible clip this round (touch not ours or inventory low); skipped=${this.skipped}`);
  }

  /** One clip against mm_a's pool positions. Returns true when a trade was sent. */
  async tickPool(bal) {
    const { bot } = this;
    const { chain, settings: s, log } = bot;
    const pool = bot.poolAdapter;
    const mine = bot.poolState?.mine;
    if (!mine || (!mine.Ask && !mine.Bid)) return false;
    this.dir.pool ??= 'sell';
    const flip = (d) => (d === 'buy' ? 'sell' : 'buy');
    const first = Math.random() < 0.75 ? flip(this.dir.pool) : this.dir.pool;
    const fee = pool.feeBps / 1e4;
    for (const dir of [first, flip(first)]) {
      const size = s.flowMode === 'live' ? this.pickSize(s.flowBondSizeMin, Math.min(25, s.flowBondSizeMax)) : Math.min(this.pickSize(), 12);
      const pos = dir === 'buy' ? mine.Ask : mine.Bid;
      if (!pos) continue;
      const lo = pool.priceAt(pos.lo);
      const hi = pool.priceAt(pos.hi);
      if (dir === 'buy') {
        const budget = size * lo * (1 + fee) * 1.01;
        if (bal.usdc < budget * 1.05) continue;
        const q = await pool.quote(true, toStroops(amt7Ceil(budget)));
        const ours = q.avgPrice >= lo * (1 + fee) * 0.9998 && q.avgPrice <= hi * (1 + fee) * 1.0002;
        if (q.out <= 0n || (!ours && !s.flowTouchForeign)) continue;
        if (s.dryRun) return log.dry('flow', `mm_b would buy ~${size.toFixed(2)} LBOND from the pool`) ?? true;
        const minOut = (q.out * 99n) / 100n;
        const res = await pool.swap('mm_b', true, toStroops(amt7Ceil(budget)), minOut);
        const out = Number(res.out) / 1e7;
        this.finishPool('BUY ', out, out * q.avgPrice, 'USDC', q.avgPrice, res);
        this.dir.pool = 'buy';
        return true;
      }
      if (bal.lbond < size * 1.01) continue;
      const q = await pool.quote(false, toStroops(amt7(size)));
      const ours = q.avgPrice >= lo * (1 - fee) * 0.9998 && q.avgPrice <= hi * (1 - fee) * 1.0002;
      if (q.out <= 0n || (!ours && !s.flowTouchForeign)) continue;
      if (s.dryRun) return log.dry('flow', `mm_b would sell ${size.toFixed(2)} LBOND to the pool`) ?? true;
      const res = await pool.swap('mm_b', false, toStroops(amt7(size)), (q.out * 99n) / 100n);
      this.finishPool('SELL', size, Number(res.out) / 1e7, 'USDC', q.avgPrice, res);
      this.dir.pool = 'sell';
      return true;
    }
    return false;
  }

  finishPool(verb, lbond, usdc, unit, avg, res) {
    const { bot } = this;
    bot.stats.flowTrades += 1;
    bot.stats.fills += 1;
    bot.stats.volumeLusdc += usdc;
    this.trades.push({ at: Date.now(), venue: 'pool', dir: verb.trim().toLowerCase(), size: lbond, hash: res.hash });
    const bm = (bot.stats.byMarket ??= {});
    bm.pool = (bm.pool ?? 0) + 1;
    bot.log.act('flow', `mm_b POOL ${verb} ${t4(lbond)} LBOND ${verb.trim() === 'BUY' ? 'for' : 'to get'} ${t4(usdc)} ${unit}, avg ${avg.toFixed(5)} incl ${bot.poolAdapter.feeBps} bps fee, vs mm_a position`, res.hash);
  }

  /** Build an executable plan (and reserve its capacity in `used`) or null when the touch is not mm_a's / inventory is short. */
  plan(book, dir, size0, ctx, used = {}) {
    const p = this._plan(book, dir, size0, ctx, used);
    if (!p) return null;
    const add = (k, v) => (used[k] = (used[k] ?? 0) + v);
    if (p.venue === 'peg') add(dir === 'buy' ? 'pegAsks' : 'pegBids', p.size);
    else if (p.venue === 'bond') add(dir === 'buy' ? 'bondAsks' : 'bondBids', p.size);
    else if (p.venue === 'usdc') add(dir === 'buy' ? 'usdcAsks' : 'usdcBids', p.size);
    else {
      add(dir === 'buy' ? 'bondAsks' : 'bondBids', p.size);
      add(dir === 'buy' ? 'pegAsks' : 'pegBids', p.size);
    }
    return p;
  }

  _plan(book, dir, size0, { pegBook, bondBook, usdcBook = EMPTY_BOOK, own, team = {}, bal }, used) {
    const { assets, acct } = this.bot;
    const dest = acct.mm_b.pub;
    const minSize = Math.max(0.5, this.bot.settings.flowSizeMin * 0.5);
    // the receipt trades at par +/- a few bps: team demo offers further than --peg-noise-max-bps + 1 from par are not taken
    const band = (this.bot.settings.pegNoiseMaxBps + 1) / 1e4;
    team = { ...team, pegAsks: (team.pegAsks ?? []).filter((o) => Math.abs(o.quote - 1) <= band), pegBids: (team.pegBids ?? []).filter((o) => Math.abs(o.quote - 1) <= band) };
    if (book === 'peg') {
      const levels = dir === 'buy' ? pegBook.asks : pegBook.bids;
      const cap = this.capacity(levels, dir === 'buy' ? own.pegAsks : own.pegBids, used[dir === 'buy' ? 'pegAsks' : 'pegBids'] ?? 0, dir === 'buy' ? team.pegAsks : team.pegBids) * 0.8;
      const size = Math.min(size0, cap);
      if (size < minSize) return null;
      if (dir === 'buy') {
        const est = walkAsks(pegBook, size);
        if (est.filled < size - 1e-9 || bal.usdc < est.cost * 1.01) return null;
        return {
          book, dir, size, unit: `${RC}`, price: est.avg, venue: 'peg', sendAsset: assets.usdc,
          op: Operation.pathPaymentStrictReceive({ sendAsset: assets.usdc, sendMax: amt7Ceil(est.cost * 1.003 + 0.00001), destination: dest, destAsset: assets.lusdc, destAmount: amt7(size), path: [] }),
          text: (r) => `BUY  ${t4(size)} ${RC} for ${t4(r.spent)} USDC`,
        };
      }
      const est = walkBids(pegBook, size);
      if (est.filled < size - 1e-9 || bal.lusdc < size * 1.001) return null;
      return {
        book, dir, size, unit: `${RC}`, price: est.avg, venue: 'peg', sendAsset: assets.lusdc,
        op: Operation.pathPaymentStrictSend({ sendAsset: assets.lusdc, sendAmount: amt7(size), destination: dest, destAsset: assets.usdc, destMin: amt7Floor(est.proceeds * 0.997), path: [] }),
        text: (r) => `SELL ${t4(size)} ${RC} for ${t4(r.got)} USDC`,
      };
    }
    if (book === 'bond') {
      const levels = dir === 'buy' ? bondBook.asks : bondBook.bids;
      const cap = this.capacity(levels, dir === 'buy' ? own.bondAsks : own.bondBids, used[dir === 'buy' ? 'bondAsks' : 'bondBids'] ?? 0, dir === 'buy' ? team.bondAsks : team.bondBids) * 0.8;
      const size = Math.min(size0, cap);
      if (size < minSize) return null;
      if (dir === 'buy') {
        const est = walkAsks(bondBook, size);
        if (est.filled < size - 1e-9 || bal.lusdc < est.cost * 1.01) return null;
        return {
          book, dir, size, unit: 'LBOND', price: est.avg, venue: 'bond', sendAsset: assets.lusdc,
          op: Operation.pathPaymentStrictReceive({ sendAsset: assets.lusdc, sendMax: amt7Ceil(est.cost * 1.003 + 0.00001), destination: dest, destAsset: assets.lbond, destAmount: amt7(size), path: [] }),
          text: (r) => `BUY  ${t4(size)} LBOND for ${t4(r.spent)} ${RC}`,
        };
      }
      const est = walkBids(bondBook, size);
      if (est.filled < size - 1e-9 || bal.lbond < size * 1.001) return null;
      return {
        book, dir, size, unit: 'LBOND', price: est.avg, venue: 'bond', sendAsset: assets.lbond,
        op: Operation.pathPaymentStrictSend({ sendAsset: assets.lbond, sendAmount: amt7(size), destination: dest, destAsset: assets.lusdc, destMin: amt7Floor(est.proceeds * 0.997), path: [] }),
        text: (r) => `SELL ${t4(size)} LBOND for ${t4(r.got)} ${RC}`,
      };
    }
    if (book === 'usdc') {
      // LBOND/USDC, direct: what an app user choosing "SDEX quoted in USDC" trades against
      const levels = dir === 'buy' ? usdcBook.asks : usdcBook.bids;
      const cap = this.capacity(levels, dir === 'buy' ? own.usdcAsks : own.usdcBids, used[dir === 'buy' ? 'usdcAsks' : 'usdcBids'] ?? 0, dir === 'buy' ? team.usdcAsks : team.usdcBids) * 0.8;
      const size = Math.min(size0, cap);
      if (size < minSize) return null;
      if (dir === 'buy') {
        const est = walkAsks(usdcBook, size);
        if (est.filled < size - 1e-9 || bal.usdc < est.cost * 1.01) return null;
        return {
          book, dir, size, unit: 'LBOND', price: est.avg, venue: 'usdc', sendAsset: assets.usdc,
          op: Operation.pathPaymentStrictReceive({ sendAsset: assets.usdc, sendMax: amt7Ceil(est.cost * 1.003 + 0.00001), destination: dest, destAsset: assets.lbond, destAmount: amt7(size), path: [] }),
          text: (r) => `BUY  ${t4(size)} LBOND for ${t4(r.spent)} USDC (LBOND/USDC book)`,
        };
      }
      const est = walkBids(usdcBook, size);
      if (est.filled < size - 1e-9 || bal.lbond < size * 1.001) return null;
      return {
        book, dir, size, unit: 'LBOND', price: est.avg, venue: 'usdc', sendAsset: assets.lbond,
        op: Operation.pathPaymentStrictSend({ sendAsset: assets.lbond, sendAmount: amt7(size), destination: dest, destAsset: assets.usdc, destMin: amt7Floor(est.proceeds * 0.997), path: [] }),
        text: (r) => `SELL ${t4(size)} LBOND for ${t4(r.got)} USDC (LBOND/USDC book)`,
      };
    }
    // routed: USDC -> lUSDC -> LBOND (buy) or LBOND -> lUSDC -> USDC (sell), one path payment touching both books
    const bondLevels = dir === 'buy' ? bondBook.asks : bondBook.bids;
    const pegLevels = dir === 'buy' ? pegBook.asks : pegBook.bids;
    const capB = this.capacity(bondLevels, dir === 'buy' ? own.bondAsks : own.bondBids, used[dir === 'buy' ? 'bondAsks' : 'bondBids'] ?? 0, dir === 'buy' ? team.bondAsks : team.bondBids) * 0.8;
    const capP = this.capacity(pegLevels, dir === 'buy' ? own.pegAsks : own.pegBids, used[dir === 'buy' ? 'pegAsks' : 'pegBids'] ?? 0, dir === 'buy' ? team.pegAsks : team.pegBids) * 0.8;
    const size = Math.min(size0 * (this.live ? 1 : 1.5), capB, capP * 0.95);
    if (size < Math.max(1, minSize)) return null;
    if (dir === 'buy') {
      const b = walkAsks(bondBook, size);
      if (b.filled < size - 1e-9) return null;
      const p = walkAsks(pegBook, b.cost);
      if (p.filled < b.cost - 1e-9 || bal.usdc < p.cost * 1.01) return null;
      return {
        book, dir, size, unit: 'LBOND', price: p.cost / size, venue: 'routed', sendAsset: assets.usdc,
        op: Operation.pathPaymentStrictReceive({ sendAsset: assets.usdc, sendMax: amt7Ceil(p.cost * 1.004 + 0.00001), destination: dest, destAsset: assets.lbond, destAmount: amt7(size), path: [assets.lusdc] }),
        text: (r) => `BUY  ${t4(size)} LBOND for ${t4(r.spent)} USDC via ${RC}`,
      };
    }
    const b = walkBids(bondBook, size);
    if (b.filled < size - 1e-9) return null;
    const p = walkBids(pegBook, b.proceeds);
    if (p.filled < b.proceeds - 1e-9 || bal.lbond < size * 1.001) return null;
    return {
      book, dir, size, unit: 'LBOND', price: p.proceeds / size, venue: 'routed', sendAsset: assets.lbond,
      op: Operation.pathPaymentStrictSend({ sendAsset: assets.lbond, sendAmount: amt7(size), destination: dest, destAsset: assets.usdc, destMin: amt7Floor(p.proceeds * 0.995), path: [assets.lusdc] }),
      text: (r) => `SELL ${t4(size)} LBOND for ${t4(r.got)} USDC via ${RC}`,
    };
  }

  /** Several trades in ONE transaction (same ledger): used for bursts. A single plan is the normal case. */
  async executeBatch(plans) {
    const { bot } = this;
    const { chain, log, settings: s } = bot;
    if (s.dryRun) {
      for (const plan of plans) log.dry('flow', `mm_b would ${plan.dir} ${plan.size.toFixed(2)} ${plan.unit} (${plan.venue}, ~${plan.price.toFixed(5)})`);
      return;
    }
    let res;
    try {
      res = await chain.submit({ label: 'mm_b', ops: plans.map((p) => p.op), memo: plans.length > 1 ? 'lotus flow burst' : 'lotus flow' });
    } catch (e) {
      if (e?.name === 'StopBot') throw e;
      log.err('flow', `mm_b ${plans.map((p) => `${p.dir} ${p.size.toFixed(2)} ${p.unit}`).join(' + ')} failed: ${firstLine(e)}`);
      bot.softFail('flow');
      return false;
    }
    const stable = (f) => {
      const keys = [f.assetSold, f.assetBought].map((a) => ({ a, amt: a === f.assetSold ? f.amountSold : f.amountBought }));
      const hit = keys.find((k) => k.a.getCode?.() === `${RC}`) ?? keys.find((k) => k.a.getCode?.() === 'USDC');
      return hit ? Number(hit.amt) : 0;
    };
    plans.forEach((plan, i) => {
      const pp = parsePathPayment(res.result, i);
      const fills = pp.ok ? pp.fills : [];
      // what mm_b paid = what the resting offers' owners received in the asset mm_b sent (first hop only)
      const spent = fills.filter((f) => f.assetBought.equals(plan.sendAsset)).reduce((x, f) => x + Number(f.amountBought), 0);
      const r = { spent, got: pp.ok ? pp.delivered.amount : '0' };
      const counter = [...new Set(fills.map((f) => bot.who(f.seller)))].join('+') || '?';
      bot.stats.flowTrades += 1;
      bot.stats.fills += fills.length;
      bot.stats.volumeLusdc += fills.reduce((x, f) => x + stable(f), 0);
      this.trades.push({ at: Date.now(), venue: plan.venue, dir: plan.dir, size: plan.size, hash: res.hash });
      if (this.trades.length > 2000) this.trades.splice(0, 1000);
      const bm = (bot.stats.byMarket ??= {});
      for (const v of plan.venue === 'routed' ? ['bond', 'peg'] : [plan.venue]) bm[v] = (bm[v] ?? 0) + 1;
      log.act('flow', `mm_b ${plan.text(r)}, avg ${plan.price.toFixed(5)}, ${fills.length} fill(s) vs ${counter}${plans.length > 1 ? ` [${i + 1}/${plans.length} in one ledger]` : ''}`, i === 0 ? res.hash : undefined);
    });
    return true;
  }

  // ------------------------------------------------------------------ live mode (--flow-mode live)
  //
  // One independent arrival process per SDEX market (LBOND/USDC = 'usdc', LBOND/receipt = 'bond', receipt/USDC = 'peg'):
  // exponential gaps at a rate drawn in [--flow-live-rate-min, --flow-live-rate-max] trades per minute (re-drawn every
  // few minutes), never more than --flow-live-max-gap-sec since that market's last trade, so every 1-minute candle gets
  // at least one print and usually several. Markets that fall due together go into ONE transaction (mm_b can only land
  // one transaction per ledger). Direction: 50/50, tilted towards the recent fair-value move (--flow-trend) and towards
  // keeping mm_b's own inventory near its targets (--flow-inv-bias). Plus occasional Lotus pool swaps (--flow-pool-per-min).

  initLive() {
    const now = Date.now();
    this.live = { markets: {}, poolNext: now + 30_000 + Math.random() * 30_000 };
    for (const m of ['usdc', 'bond', 'peg']) {
      this.live.markets[m] = { next: now + 3_000 + Math.random() * 12_000, last: 0, ref: null, rate: 0, rateUntil: 0, trades: 0, skips: 0 };
    }
    if (this.bot.settings.usdcBook !== 'on') delete this.live.markets.usdc;
  }

  scheduleNext(m, now, { retry = false } = {}) {
    const s = this.bot.settings;
    const st = this.live.markets[m];
    if (now >= st.rateUntil) {
      st.rate = s.flowLiveRateMin + Math.random() * (s.flowLiveRateMax - s.flowLiveRateMin);
      st.rateUntil = now + (3 + Math.random() * 5) * 60_000;
    }
    let d;
    if (retry) d = 4 + Math.random() * 5;
    else {
      d = -Math.log(1 - Math.random()) * (60 / st.rate);
      d = Math.min(Math.max(d, s.flowLiveMinGapSec), s.flowLiveMaxGapSec);
    }
    st.next = now + d * 1000;
    if (st.last) st.next = Math.min(st.next, st.last + s.flowLiveMaxGapSec * 1000);
    st.next = Math.max(st.next, now + 1500);
  }

  liveDelayMs() {
    if (!this.live) return 1000;
    const now = Date.now();
    let next = this.live.poolNext;
    for (const st of Object.values(this.live.markets)) next = Math.min(next, st.next);
    const forceAt = Math.floor(now / 60_000) * 60_000 + this.bot.settings.flowForceAtSec * 1000;
    if (forceAt > now) next = Math.min(next, forceAt);
    else if (Object.values(this.live.markets).some((st) => st.lastMin !== Math.floor(now / 60_000))) next = Math.min(next, now + 1000);
    return Math.min(3000, Math.max(200, next - now));
  }

  /** Reference price of a market for the trend tilt: LBOND in USDC, LBOND in receipt, receipt in USDC. */
  refPrice(m) {
    const fair = this.bot.nav.snapshot().fair;
    const peg = this.bot.peg.snapshot().mid;
    return m === 'usdc' ? fair : m === 'bond' ? fair / peg : peg;
  }

  /** Buy (base) or sell for market m: 50/50 tilted by the fair-value move since its last trade and mm_b's inventory. */
  pickDir(m, bal) {
    const s = this.bot.settings;
    const st = this.live.markets[m];
    const ref = this.refPrice(m);
    const moveBps = st.ref ? ((ref - st.ref) / st.ref) * 1e4 : 0;
    const trend = s.flowTrend * Math.tanh(moveBps / 1.5);
    let x;
    if (m === 'usdc') x = (bal.usdc - s.flowTargetUsdc) / s.flowTargetUsdc; // more USDC than wanted -> buy LBOND with it
    else if (m === 'bond') x = (bal.lusdc - s.flowTargetReceipt) / s.flowTargetReceipt;
    else x = (bal.usdc - bal.lusdc) / Math.max(1, bal.usdc + bal.lusdc); // receipt/USDC: hold both about equally
    const inv = s.flowInvBias * Math.tanh(1.5 * x);
    const p = Math.min(0.88, Math.max(0.12, 0.5 + trend + inv));
    return Math.random() < p ? 'buy' : 'sell';
  }

  async liveTick() {
    const { bot } = this;
    const { chain, settings: s, assets } = bot;
    if (bot.paused.flow) return;
    if (!this.live) this.initLive();
    const now = Date.now();

    const minuteOpen = Object.values(this.live.markets).some((st) => st.lastMin !== Math.floor(now / 60_000));
    const lateInMinute = (now % 60_000) / 1000 >= s.flowForceAtSec - 12;
    // a pool swap (Soroban, ~10 s) holds mm_b's sequence: never right before a forced SDEX print may be needed
    if (bot.poolAdapter && s.flowPoolPerMin > 0 && now >= this.live.poolNext && !(minuteOpen && lateInMinute)) {
      this.live.poolNext = now + Math.max(20, -Math.log(1 - Math.random()) * (60 / s.flowPoolPerMin)) * 1000;
      try {
        const bal = bot.balances.mm_b && now - bot.balances.mm_b.at < 10_000 ? bot.balances.mm_b : await chain.refreshBalances('mm_b');
        if (!(await this.tickPool(bal))) this.skipped += 1;
      } catch (e) {
        if (e?.name === 'StopBot') throw e;
        bot.log.err('flow', `pool trade failed: ${firstLine(e)}`);
      }
    }

    // hard guarantee: a market with no trade landed in the current UTC minute by second --flow-force-at-sec gets a
    // small forced trade now (retried every few seconds until one lands), so no 1-minute candle is ever empty
    const minute = Math.floor(Date.now() / 60_000);
    const sec = (Date.now() % 60_000) / 1000;
    const forced = new Set();
    if (sec >= s.flowForceAtSec) {
      for (const [m, st] of Object.entries(this.live.markets)) {
        if (st.lastMin !== minute && st.next > Date.now() + 1500 && Date.now() - (st.forceTry ?? 0) > 3_000) {
          forced.add(m);
          st.forceTry = Date.now();
        }
      }
    }
    const due = Object.entries(this.live.markets)
      .filter(([m, st]) => st.next <= Date.now() + 1500 || forced.has(m))
      .map(([m]) => m);
    if (due.length) {
      const view = await mmView(bot, 15_000);
      const [pegBook, bondBook, usdcBook] = await Promise.all([
        chain.orderBook(assets.lusdc, assets.usdc),
        chain.orderBook(assets.lbond, assets.lusdc),
        s.usdcBook === 'on' ? chain.orderBook(assets.lbond, assets.usdc) : EMPTY_BOOK,
      ]);
      const bal = bot.balances.mm_b && Date.now() - bot.balances.mm_b.at < 10_000 ? bot.balances.mm_b : await chain.refreshBalances('mm_b');
      const ctx = { pegBook, bondBook, usdcBook, own: view.offers, team: view.team, bal };
      const used = {};
      const plans = [];
      const planned = [];
      const flip = (d) => (d === 'buy' ? 'sell' : 'buy');
      for (const m of due) {
        const [lo, hi] = m === 'peg' ? [s.flowPegSizeMin, s.flowPegSizeMax] : [s.flowBondSizeMin, s.flowBondSizeMax];
        const st0 = this.live.markets[m];
        let dir = this.pickDir(m, bal);
        if (forced.has(m)) {
          // forced print: small, in the direction of the fair-value drift since the market's last trade
          const ref = this.refPrice(m);
          if (st0.ref && Math.abs(ref - st0.ref) / st0.ref > 2e-5) dir = ref > st0.ref ? 'buy' : 'sell';
          this.forcedTrades = (this.forcedTrades ?? 0) + 1;
        }
        const [flo, fhi] = forced.has(m) ? [lo, Math.min(hi, lo * 4)] : [lo, hi];
        // a share of LBOND/receipt prints come from routed trades USDC -> receipt -> LBOND (they print on both books)
        const book = m === 'bond' && !forced.has(m) && Math.random() < 0.1 ? 'routed' : m;
        let plan = null;
        for (const [b, d, k] of [[book, dir, 1], [m, dir, 1], [m, dir, 0.3], [m, flip(dir), 1], [m, flip(dir), 0.3]]) {
          plan = this.plan(b, d, Math.max(flo, this.pickSize(flo, fhi) * k), ctx, used);
          if (plan) break;
        }
        if (plan) {
          plans.push(plan);
          planned.push(m);
        } else {
          this.live.markets[m].skips += 1;
          this.skipped += 1;
          this.scheduleNext(m, Date.now(), { retry: true });
        }
      }
      if (plans.length) {
        const ok = await this.executeBatch(plans);
        const t = Date.now();
        for (const m of planned) {
          const st = this.live.markets[m];
          if (ok) {
            st.lastMin = Math.floor(t / 60_000);
            st.last = t;
            st.trades += 1;
            st.ref = this.refPrice(m);
            this.scheduleNext(m, t);
          } else this.scheduleNext(m, t, { retry: true });
        }
        if (ok) bot.balances.mm_b = { ...bal, at: 0 }; // spent: re-read before the next plan
      }
    }
    await this.rebalance();
  }

  /** A burst: `count` clips (peg buys/sells alternating, bond sells, the odd routed trade) in a single transaction. */
  async burst(count = 4) {
    const { bot } = this;
    const { chain, assets, acct } = bot;
    const view = await mmView(bot);
    const own = view.offers;
    const team = view.team;
    const usdcOn = bot.settings.usdcBook === 'on';
    const [pegBook, bondBook, usdcBook] = await Promise.all([
      chain.orderBook(assets.lusdc, assets.usdc),
      chain.orderBook(assets.lbond, assets.lusdc),
      usdcOn ? chain.orderBook(assets.lbond, assets.usdc) : EMPTY_BOOK,
    ]);
    const bal = bot.balances.mm_b ?? (await chain.refreshBalances('mm_b'));
    const ctx = { pegBook, bondBook, usdcBook, own, team, bal };
    const used = {};
    const plans = [];
    let pegDir = Math.random() < 0.5 ? 'buy' : 'sell';
    for (let tries = 0; tries < count * 4 && plans.length < count; tries++) {
      const roll = Math.random();
      let plan;
      if (roll < 0.5) {
        plan = this.plan('peg', pegDir, this.pickSize(), ctx, used);
        if (plan) pegDir = pegDir === 'buy' ? 'sell' : 'buy';
      } else if (roll < 0.85) {
        // the bond leg goes to LBOND/USDC instead of LBOND/receipt about a third of the time when that book is on
        const book = usdcOn && Math.random() < 0.35 ? 'usdc' : 'bond';
        plan = this.plan(book, Math.random() < 0.5 ? 'buy' : 'sell', this.pickSize(), ctx, used);
      } else {
        plan = this.plan('routed', Math.random() < 0.5 ? 'buy' : 'sell', this.pickSize(), ctx, used);
      }
      if (plan) plans.push(plan);
    }
    if (!plans.length) return;
    await this.executeBatch(plans);
  }

  /**
   * Keep both accounts able to trade: plain payments between mm_a and mm_b (no trade prints) when one side runs
   * low on USDC, lUSDC or LBOND. Only moves what the donor can spare.
   */
  async rebalance() {
    const { bot } = this;
    const { chain, assets, acct, log, settings: s } = bot;
    if (s.dryRun || Date.now() - this.lastRebalance < 90_000) return;
    this.lastRebalance = Date.now();
    await chain.refreshBalances('mm_a');
    await chain.refreshBalances('mm_b');
    await chain.refreshBalances('arb');
    const a = bot.balances.mm_a;
    const b = bot.balances.mm_b;
    const r = bot.balances.arb;
    const moves = [];
    const want = (label, asset, code, have, low, donor, spare) => {
      if (have < low && spare > low) moves.push({ from: donor, to: label, asset, code, amount: Math.floor((spare - low) / 2) });
      else if (have < low && spare > 20) moves.push({ from: donor, to: label, asset, code, amount: Math.floor(Math.min(spare, low - have)) });
    };
    const live = s.flowMode === 'live';
    const aUsdcLow = (bot.poolAdapter ? 260 : 150) + (s.usdcBook === 'on' ? s.usdcLevels * s.usdcLevelSize * 0.5 : 0);
    const aRcLow = live ? s.levels * s.levelSize + s.pegSize * 0.6 : 250;
    const bUsdcLow = live ? s.flowTargetUsdc * 0.5 : 60;
    const bRcLow = live ? s.flowTargetReceipt * 0.5 : 60;
    const arbKeep = s.arbKeepUsdc;
    // the arbitrageur's profits (and any surplus over its working capital) go back to the market makers
    if (r.usdc > arbKeep + 150) moves.push({ from: 'arb', to: a.usdc < b.usdc ? 'mm_a' : 'mm_b', asset: assets.usdc, code: 'USDC', amount: Math.floor(r.usdc - arbKeep) });
    if (r.lbond > 5 && !bot.components?.cross?.busy) moves.push({ from: 'arb', to: 'mm_b', asset: assets.lbond, code: 'LBOND', amount: Math.floor(r.lbond) });
    want('mm_a', assets.usdc, 'USDC', a.usdc, aUsdcLow, b.usdc - bUsdcLow > r.usdc - arbKeep ? 'mm_b' : 'arb', Math.max(b.usdc - bUsdcLow - 100, r.usdc - arbKeep));
    want('mm_a', assets.lusdc, `${RC}`, a.lusdc, aRcLow, 'mm_b', b.lusdc - bRcLow - 50);
    want('mm_b', assets.lusdc, `${RC}`, b.lusdc, bRcLow, 'mm_a', a.lusdc - aRcLow - 100);
    want('mm_b', assets.usdc, 'USDC', b.usdc, bUsdcLow, a.usdc - aUsdcLow > r.usdc - arbKeep ? 'mm_a' : 'arb', Math.max(a.usdc - aUsdcLow - 100, r.usdc - arbKeep));
    want('mm_b', assets.lbond, 'LBOND', b.lbond, 500, 'mm_a', a.lbond - 5000);
    // last resort: no USDC to move around -> one Blend faucet round through a fresh account (see lib/topup.mjs)
    const totalUsdc = a.usdc + b.usdc + r.usdc;
    // the cap counts the faucet rounds of the last 24 h recorded in testnet.bot.json, so supervisor restarts do not reset it
    if (s.topup && totalUsdc < s.topupBelowUsdc && Date.now() - (this.lastTopup ?? 0) > 600_000) {
      const { loadBotJson } = await import('./lib/env.mjs');
      const recent = (loadBotJson().setup?.topups ?? []).filter((t) => Date.now() - Date.parse(t.at) < 86_400_000).length;
      if (recent >= s.topupMax) {
        this.lastTopup = Date.now();
        log.warn('topup', `bot USDC total ${totalUsdc.toFixed(0)} is under ${s.topupBelowUsdc} but ${recent} faucet top-up(s) already ran in the last 24 h (--topup-max ${s.topupMax}): not topping up`);
      }
    }
    if (s.topup && totalUsdc < s.topupBelowUsdc && Date.now() - (this.lastTopup ?? 0) > 600_000) {
      this.lastTopup = Date.now();
      const to = a.usdc < b.usdc ? 'mm_a' : 'mm_b';
      try {
        const { faucetTopUp, recordTopUp } = await import('./lib/topup.mjs');
        const t = await faucetTopUp({ ctx: bot.ctx, usdc: assets.usdc, toPub: acct[to].pub, log: (m) => log.info('topup', m) });
        recordTopUp({ to, amount: t.amount, via: t.from, txs: t.hashes, trigger: `bot USDC total ${totalUsdc.toFixed(0)} < ${s.topupBelowUsdc}` });
        log.act('topup', `${to} received ${t.amount} USDC from the Blend testnet faucet via fresh account ${t.from}`, t.hashes.forward);
      } catch (e) {
        log.warn('topup', `faucet top-up failed: ${firstLine(e)}`);
      }
    }
    for (const m of moves.filter((x) => x.amount >= 1).slice(0, 3)) {
      const res = await chain.submit({ label: m.from, ops: [Operation.payment({ destination: acct[m.to].pub, asset: m.asset, amount: String(m.amount) })], memo: 'lotus inventory' });
      log.act('flow', `inventory: ${m.from} moved ${m.amount} ${m.code} to ${m.to}`, res.hash);
    }
  }
}

export { assetLabel, fromStroops, toStroops };
