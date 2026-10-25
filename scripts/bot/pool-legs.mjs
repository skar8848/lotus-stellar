// Pool legs: everything the bot does against the Lotus range pool (LBOND/USDC, directional bins).
// All of it sits behind the PoolAdapter (lib/pool.mjs) and a feature flag (--pool auto|on|off): without a
// live pool in deployments/testnet.pool.json the bot runs exactly as before.
//
//   PoolMM     mm_a posts one directional Ask position (LBOND, sold as price rises) and one Bid position (USDC,
//              buying LBOND as price falls) a few bins either side of the simulated fair value, and re-posts them
//              (remove_position + add_position) when fair value moved a few bins or a side is mostly filled.
//   CrossArb   arb compares the pool (quote_swap, fee included) with the SDEX route LBOND <-> lUSDC <-> USDC and,
//              when the net edge clears --cross-min-edge-bps, executes the pool swap and the opposite path
//              payment. Directions: buy on the pool / sell on the SDEX, or buy on the SDEX / sell on the pool.
//   Flow.tickPool (in mm.mjs) mm_b takes small clips from the pool so it prints volume there too.

import { Operation } from '@stellar/stellar-sdk';
import { fromStroops, toStroops } from '../lib/stellar.mjs';
import { amt7, amt7Ceil, amt7Floor, walkAsks, walkBids } from './lib/book.mjs';
import { StopBot } from './lib/chain.mjs';
import { firstLine } from './lib/bot.mjs';
import { parsePathPayment } from './lib/xdr.mjs';
import { RC } from './lib/names.mjs';

const E7 = 1e7;
const same = (a, b) => Math.abs(a - b) < 6e-8;
const stroops = (x) => BigInt(Math.round(Number(x) * E7));

// ===================================================================== shared state on the bot

export function poolState(bot) {
  bot.poolState ??= { mine: { Ask: null, Bid: null }, at: 0 };
  return bot.poolState;
}

// ===================================================================== market maker (mm_a)

export class PoolMM {
  constructor(bot, pool) {
    this.bot = bot;
    this.pool = pool;
    this.inflight = null;
    this.requotes = 0;
  }

  tick() {
    if (this.inflight) return this.inflight;
    this.inflight = this.pass().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** mm_a's positions as {Ask, Bid} (newest per side; older duplicates are removed). */
  async sync() {
    const { pool, bot } = this;
    const ids = await pool.positionsOf(bot.acct.mm_a.pub);
    const byId = [];
    for (const id of ids) byId.push(await pool.getPosition(id));
    const mine = { Ask: null, Bid: null };
    for (const p of byId.sort((a, b) => Number(a.id - b.id))) {
      if (mine[p.side] && !bot.settings.dryRun) {
        // an older position of the same side from a previous run: close it, one live position per side is enough
        const old = mine[p.side];
        const r = await pool.removePosition('mm_a', old.id);
        bot.log.act('mm_a', `POOL closed duplicate ${old.side} position #${old.id} (returned ${fromStroops(r.base ?? 0n)} LBOND, ${fromStroops(r.quote ?? 0n)} USDC)`, r.hash);
      }
      mine[p.side] = p;
    }
    const st = poolState(bot);
    st.mine = mine;
    st.at = Date.now();
    return mine;
  }

  targetRange(side, fair) {
    const s = this.bot.settings;
    const half = s.poolHalfSpreadBps / 1e4;
    if (side === 'Ask') {
      const lo = this.pool.binCeil(fair * (1 + half));
      return { lo, hi: lo + s.poolLevels - 1 };
    }
    const hi = this.pool.binFloor(fair * (1 - half));
    return { lo: hi - s.poolLevels + 1, hi };
  }

  async pass() {
    const { bot, pool } = this;
    const { settings: s, log, chain } = bot;
    if (bot.paused.poolmm) return;
    const fair = bot.nav.step().fair;
    const mine = await this.sync();
    const bal = bot.balances.mm_a && Date.now() - bot.balances.mm_a.at < 20_000 ? bot.balances.mm_a : await chain.refreshBalances('mm_a');
    for (const side of ['Ask', 'Bid']) {
      const target = this.targetRange(side, fair);
      const pos = mine[side];
      const shift = pos ? Math.abs(pos.lo - target.lo) : 99;
      const left = pos ? Number(pos.inventory) / Math.max(1, Number(pos.deposited)) : 0;
      const stale = !pos || shift >= s.poolShiftBins || left < 1 - 0.7 /* >70% filled */ || pos.inventory <= 0n;
      if (!stale) continue;
      const why = !pos ? 'no position' : shift >= s.poolShiftBins ? `fair value moved ${shift} bins` : 'mostly filled';
      const size = side === 'Ask' ? s.poolAskSize : s.poolBidSize;
      const have = side === 'Ask' ? bal.lbond : bal.usdc;
      if (have < size * 1.05) {
        log.warn('mm_a', `pool ${side}: not enough ${side === 'Ask' ? 'LBOND' : 'USDC'} (${have.toFixed(2)}) for a ${size} position; skipping`);
        continue;
      }
      if (s.dryRun) {
        log.dry('mm_a', `would ${pos ? 'replace' : 'post'} pool ${side} position: bins ${target.lo}..${target.hi} (${pool.priceAt(target.lo).toFixed(4)}..${pool.priceAt(target.hi).toFixed(4)}), ${size} ${side === 'Ask' ? 'LBOND' : 'USDC'} (${why})`);
        continue;
      }
      let returned = '';
      if (pos) {
        const r = await pool.removePosition('mm_a', pos.id);
        returned = ` (closed #${pos.id}: got back ${fromStroops(r.base)} LBOND + ${fromStroops(r.quote)} USDC)`;
      }
      const per = size / s.poolLevels;
      if (stroops(per) < 10_000n * 2n) throw new Error('pool position too small per bin');
      const add = await pool.addPosition('mm_a', side, target.lo, target.hi, stroops(size));
      this.requotes += 1;
      mine[side] = { id: add.id, side, lo: target.lo, hi: target.hi, deposited: stroops(size), inventory: stroops(size) };
      log.act(
        'mm_a',
        `POOL ${side.toUpperCase()} position #${add.id}: bins ${target.lo}..${target.hi} = ${pool.priceAt(target.lo).toFixed(4)}..${pool.priceAt(target.hi).toFixed(4)}, ${size} ${side === 'Ask' ? 'LBOND' : 'USDC'} spread over ${s.poolLevels} bins; fair ${fair.toFixed(5)}, ${why}${returned}`,
        add.hash,
      );
    }
    poolState(bot).mine = mine;
  }

  /** Close mm_a's positions (used by --cleanup). */
  async closeAll() {
    const mine = await this.sync();
    for (const side of ['Ask', 'Bid']) {
      if (!mine[side]) continue;
      const r = await this.pool.removePosition('mm_a', mine[side].id);
      this.bot.log.act('cleanup', `mm_a: closed pool ${side} position #${mine[side].id} (${fromStroops(r.base)} LBOND, ${fromStroops(r.quote)} USDC back)`, r.hash);
    }
  }
}

// ===================================================================== cross-venue arbitrage (arb)

/** The leading book levels that belong to mm_a: with --ladder leave the arb only trades against those. */
function ownPrefix(levels, ownList) {
  const out = [];
  for (const l of levels) {
    if (!ownList.some((o) => same(o.quote, l.price))) break;
    out.push(l);
  }
  return out;
}

export class CrossArb {
  constructor(bot, pool) {
    this.bot = bot;
    this.pool = pool;
    this.busy = false;
    this.lastWarn = new Map();
    this.cycles = [];
  }

  warnOnce(key, msg, everyMs = 45_000) {
    const now = Date.now();
    if (now - (this.lastWarn.get(key) ?? 0) < everyMs) return;
    this.lastWarn.set(key, now);
    this.bot.log.warn('cross', msg);
  }

  /** SDEX books the arb may trade against (all, or only mm_a's quotes with --ladder leave). */
  async books() {
    const { bot } = this;
    const { chain, assets, settings: s, acct } = bot;
    const [bond, peg] = await Promise.all([chain.orderBook(assets.lbond, assets.lusdc), chain.orderBook(assets.lusdc, assets.usdc)]);
    if (s.ladder === 'take') return { bond, peg };
    if (!bot.mmState.offers || Date.now() - bot.mmState.at > 30_000) {
      const { MarketMaker } = await import('./mm.mjs');
      bot.mmState = { offers: new MarketMaker(bot).classify(await chain.accountOffers(acct.mm_a.pub)), at: Date.now() };
    }
    const own = bot.mmState.offers;
    return {
      bond: { asks: ownPrefix(bond.asks, own.bondAsks), bids: ownPrefix(bond.bids, own.bondBids) },
      peg: { asks: ownPrefix(peg.asks, own.pegAsks), bids: ownPrefix(peg.bids, own.pegBids) },
    };
  }

  /** USDC received for selling x LBOND on the SDEX route LBOND -> lUSDC -> USDC. */
  sdexSell(b, x) {
    const l = walkBids(b.bond, x);
    if (l.filled < x * 0.9995) return null;
    const u = walkBids(b.peg, l.proceeds);
    if (u.filled < l.proceeds * 0.9995) return null;
    return { usdc: u.proceeds, avg: u.proceeds / x };
  }

  /** USDC needed to buy x LBOND on the SDEX route USDC -> lUSDC -> LBOND. */
  sdexBuy(b, x) {
    const l = walkAsks(b.bond, x);
    if (l.filled < x * 0.9995) return null;
    const u = walkAsks(b.peg, l.cost);
    if (u.filled < l.cost * 0.9995) return null;
    return { usdc: u.cost, avg: u.cost / x };
  }

  /** Best opportunity right now, or null. Costs 2-6 quote_swap simulations. */
  async scan() {
    const { bot, pool } = this;
    const s = bot.settings;
    const b = await this.books();
    const probe = s.crossProbe;
    const refSell = this.sdexSell(b, probe);
    const refBuy = this.sdexBuy(b, probe);
    const cands = [];

    // direction 1: buy LBOND on the pool (pay USDC), sell it on the SDEX
    if (refSell) {
      for (let k = 0; k < 4; k++) {
        const budget = probe * refSell.avg * 2 ** k;
        if (budget > s.crossMaxNotional) break;
        const q = await pool.quote(true, stroops(budget));
        const out = Number(q.out) / E7;
        if (out <= 0 || q.partial) break;
        const cost = out * q.avgPrice;
        const sell = this.sdexSell(b, out);
        if (!sell) break;
        cands.push({ dir: 'pool->sdex', budget, out, cost, revenue: sell.usdc, profit: sell.usdc - cost, edgeBps: ((sell.usdc - cost) / cost) * 1e4, poolPrice: q.avgPrice, sdexPrice: sell.avg });
      }
    }
    // direction 2: buy LBOND on the SDEX, sell it to the pool
    if (refBuy) {
      for (let k = 0; k < 4; k++) {
        const x = probe * 2 ** k;
        if (x * refBuy.avg > s.crossMaxNotional) break;
        const q = await pool.quote(false, stroops(x));
        const proceeds = Number(q.out) / E7;
        if (proceeds <= 0 || q.partial) break;
        const buy = this.sdexBuy(b, x);
        if (!buy) break;
        cands.push({ dir: 'sdex->pool', x, out: x, cost: buy.usdc, revenue: proceeds, profit: proceeds - buy.usdc, edgeBps: ((proceeds - buy.usdc) / buy.usdc) * 1e4, poolPrice: q.avgPrice, sdexPrice: buy.avg });
      }
    }
    const good = cands.filter((c) => c.edgeBps >= s.crossMinEdgeBps && c.profit >= s.crossMinProfit).sort((a, c) => c.profit - a.profit);
    return { best: good[0] ?? null, all: cands, books: b };
  }

  async tick() {
    this.busy = true;
    try {
      if (this.bot.paused.cross) return;
      const { best, all } = await this.scan();
      if (!best) {
        const top = all.sort((a, c) => c.edgeBps - a.edgeBps)[0];
        if (top) this.bot.log.info('cross', `no edge: best candidate ${top.dir} ${top.edgeBps.toFixed(1)} bps net (needs ${this.bot.settings.crossMinEdgeBps})`);
        return;
      }
      await this.execute(best);
    } finally {
      this.busy = false;
    }
  }

  async execute(c) {
    const { bot, pool } = this;
    const { chain, assets, log, settings: s, acct } = bot;
    const t0 = Date.now();
    const n = this.cycles.length + 1;
    const tag = `cross #${n}`;
    log.info('cross', `${tag}: ${c.dir} edge ${c.edgeBps.toFixed(1)} bps net of fees on ~${c.out.toFixed(2)} LBOND (pool ${c.poolPrice.toFixed(5)} incl fee vs SDEX ${c.sdexPrice.toFixed(5)}), expected +${c.profit.toFixed(4)} USDC`);
    if (s.dryRun) return log.dry('cross', `${tag}: would trade ${c.dir}`);

    const before = await chain.refreshBalances('arb');
    const hashes = [];
    let fees = 0n;
    let tFirst = 0;
    const fills = [];
    try {
      if (c.dir === 'pool->sdex') {
        const minOut = amt7Floor(c.out * 0.995);
        const sw = await pool.swap('arb', true, stroops(c.budget), toStroops(minOut));
        hashes.push(sw.hash);
        fees += sw.feeCharged ?? 0n;
        tFirst = Date.now();
        const got = sw.out; // LBOND received (stroops)
        log.act('cross', `${tag} POOL BUY  ${fromStroops(got)} LBOND (avg ${c.poolPrice.toFixed(5)} USDC incl fee)`, sw.hash);
        const expected = this.sdexSell(await this.books(), Number(got) / E7);
        const destMin = amt7Floor((expected ? expected.usdc : c.revenue) * 0.996);
        const sell = await chain.submit({
          label: 'arb',
          memo: 'lotus cross sell',
          ops: [Operation.pathPaymentStrictSend({ sendAsset: assets.lbond, sendAmount: fromStroops(got), destination: acct.arb.pub, destAsset: assets.usdc, destMin, path: [assets.lusdc] })],
        });
        hashes.push(sell.hash);
        fees += sell.feeCharged ?? 0n;
        const pp = parsePathPayment(sell.result);
        if (pp.ok) fills.push(...pp.fills.map((f) => bot.who(f.seller)));
        bot.stats.fills += pp.ok ? pp.fills.length : 0;
        log.act('cross', `${tag} SDEX SELL ${fromStroops(got)} LBOND for ${pp.ok ? pp.delivered.amount : '?'} USDC via ${RC}`, sell.hash);
      } else {
        const destAmount = amt7Floor(c.x);
        const sendMax = amt7Ceil(c.cost * 1.004 + 0.00001);
        const buy = await chain.submit({
          label: 'arb',
          memo: 'lotus cross buy',
          ops: [Operation.pathPaymentStrictReceive({ sendAsset: assets.usdc, sendMax, destination: acct.arb.pub, destAsset: assets.lbond, destAmount, path: [assets.lusdc] })],
        });
        hashes.push(buy.hash);
        fees += buy.feeCharged ?? 0n;
        tFirst = Date.now();
        const pp = parsePathPayment(buy.result);
        if (pp.ok) fills.push(...pp.fills.map((f) => bot.who(f.seller)));
        bot.stats.fills += pp.ok ? pp.fills.length : 0;
        log.act('cross', `${tag} SDEX BUY  ${destAmount} LBOND (avg ${c.sdexPrice.toFixed(5)} USDC via ${RC})`, buy.hash);
        const sw = await pool.swap('arb', false, toStroops(destAmount), stroops(c.revenue * 0.995));
        hashes.push(sw.hash);
        fees += sw.feeCharged ?? 0n;
        log.act('cross', `${tag} POOL SELL ${destAmount} LBOND for ${fromStroops(sw.out)} USDC (avg ${c.poolPrice.toFixed(5)} net of fee)`, sw.hash);
      }
    } catch (e) {
      if (e instanceof StopBot) throw e;
      log.err('cross', `${tag}: leg failed (${firstLine(e)}); arb may be holding LBOND until the next tick unwinds it`);
      bot.stats.error('cross:leg');
      return;
    }
    const after = await chain.refreshBalances('arb');
    const gross = after.usdc - before.usdc;
    const feeXlm = Number(fees) / E7;
    const net = gross - feeXlm * s.xlmUsd;
    const tDone = Date.now();
    const lbondDelta = after.lbond - before.lbond;
    const cycle = {
      n: bot.arbLedger.length + 1,
      side: c.dir,
      size: c.out.toFixed(7),
      usdcIn: c.cost.toFixed(7),
      usdcOut: c.revenue.toFixed(7),
      gross: gross.toFixed(7),
      avg: c.poolPrice,
      feeXlm,
      net,
      seconds: (tDone - t0) / 1000,
      t0,
      tBuy: tFirst,
      tDone,
      hashes,
      counterparties: [...new Set(fills)],
    };
    this.cycles.push(cycle);
    bot.arbLedger.push(cycle);
    log.act('cross', `${tag} DONE ${c.dir}: ${gross >= 0 ? '+' : ''}${gross.toFixed(5)} USDC gross (expected +${c.profit.toFixed(4)}), fees ${feeXlm.toFixed(5)} XLM, LBOND left over ${lbondDelta.toFixed(4)}, took ${cycle.seconds.toFixed(1)}s`);
  }
}
