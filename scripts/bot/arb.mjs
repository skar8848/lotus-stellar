// Peg arbitrageur ("arb").
//
// lUSDC is minted 1:1 against USDC by lotus_vault.deposit() and burnt 1:1 by redeem() while the vault is
// fully backed (vault_value() >= supply()). That makes 1 USDC the fair price of 1 lUSDC and gives two trades:
//
//   lUSDC offered under par   : path-pay USDC -> lUSDC (strict receive, price-capped), then redeem() for USDC
//   lUSDC bid above par       : deposit() USDC -> lUSDC at par, then path-pay lUSDC -> USDC into the bid
//
// Each leg is a separate transaction (Soroban allows one operation per tx, so the classic leg and the
// contract leg cannot be atomic). The redeem is simulated first and the book is re-read every tick, so a
// cycle that stops half-way leaves lUSDC inventory that the next tick redeems at par.
//
// Triangular check (--usdc-book on): every --tri-interval-sec, when the peg needs nothing, the arbitrageur prices
// LBOND on the direct LBOND/USDC book against the route LBOND <-> lUSDC <-> USDC. When a round trip clears
// --tri-min-edge-bps it sends ONE circular path payment USDC -> ... -> USDC to itself (atomic: it either lands with
// at least the expected USDC back, or fails as a whole for 0.00001 XLM). With --ladder leave it only trades against
// offers of the bot's own accounts (mm_a, mm_b), like the cross-venue leg.

import { Operation } from '@stellar/stellar-sdk';
import { addr, assetLabel, fromStroops, i128, toStroops } from '../lib/stellar.mjs';
import { amt7, amt7Ceil, amt7Floor, askDepthUpTo, bidDepthDownTo, walkAsks, walkBids } from './lib/book.mjs';
import { parsePathPayment } from './lib/xdr.mjs';
import { StopBot } from './lib/chain.mjs';
import { firstLine } from './lib/bot.mjs';
import { RC } from './lib/names.mjs';
import { MarketMaker } from './mm.mjs';

const E7 = 1e7;
const toNum = (stroops) => Number(stroops) / E7;
const same = (a, b) => Math.abs(a - b) < 6e-8;

/** The leading levels of a book side whose price matches one of `own` (offers of the bot's accounts). */
function ownPrefix(levels, own) {
  const out = [];
  for (const l of levels) {
    if (!own.some((o) => same(o.quote, l.price))) break;
    out.push(l);
  }
  return out;
}

export class Arb {
  constructor(bot) {
    this.bot = bot;
    this.n = 0;
    this.cycles = []; // ledger of completed cycles
    this.inventoryDirty = true;
    this.lastWarn = new Map();
    this.busy = false;
    this.lastTri = 0;
    this.tri = { checks: 0, executed: 0, failed: 0, best: null, worst: null, lastLog: 0 };
  }

  warnOnce(key, msg, everyMs = 30_000) {
    const now = Date.now();
    if (now - (this.lastWarn.get(key) ?? 0) < everyMs) return;
    this.lastWarn.set(key, now);
    this.bot.log.warn('arb', msg);
  }

  /** value of 1 lUSDC at redeem(): min(1, vault_value / supply), straight from the contract's formula. */
  redeemValue(v) {
    if (v.supply <= 0n) return 1;
    return Math.min(1, Number(v.vaultValue) / Number(v.supply));
  }

  async tick() {
    this.busy = true;
    try {
      const { chain, assets, settings: s } = this.bot;
      const book = await chain.orderBook(assets.lusdc, assets.usdc); // base lUSDC, counter USDC
      const ask = book.asks[0];
      const bid = book.bids[0];
      const thr = s.arbThresholdBps / 1e4;
      if (ask && ask.price <= 1 - thr + 1e-12) return await this.buyAndRedeem(book);
      if (bid && bid.price >= 1 + thr - 1e-12) return await this.mintAndSell(book);
      if (this.inventoryDirty) await this.settleInventory();
      if (s.usdcBook === 'on' && Date.now() - this.lastTri >= s.triIntervalSec * 1000) await this.triTick();
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------ lUSDC under par

  async buyAndRedeem(book) {
    const { bot } = this;
    const { chain, assets, settings: s, log, acct } = bot;
    const t0 = Date.now();
    const thr = s.arbThresholdBps / 1e4;

    const v = await chain.views({ maxAgeMs: 1500 });
    const value = this.redeemValue(v);
    if (value < 1 - s.backingTolBps / 1e4 && !s.allowProrata) {
      this.warnOnce(
        'underbacked',
        `${RC} is offered under par but the vault is under-backed (vault_value ${fromStroops(v.vaultValue)} < supply ${fromStroops(v.supply)}, redeem would pay ${(value * 100).toFixed(4)}%): skipping, redeem is only par while fully backed`,
      );
      return;
    }
    const limit = Math.min(1 - thr, value - thr); // max price per lUSDC we accept

    const bal = await chain.refreshBalances('arb');
    const depth = askDepthUpTo(book, limit);
    let n = Math.min(depth, s.arbMaxNotional, toNum(v.supply), (bal.usdc / limit) * 0.999);
    n = Math.floor(n * E7) / E7;
    if (n < s.arbMinSize) {
      this.warnOnce('small', `edge exists but size is ${n.toFixed(4)} ${RC} (< --arb-min-size ${s.arbMinSize}; ask depth ${depth.toFixed(2)}, USDC balance ${bal.usdc.toFixed(2)})`);
      return;
    }
    const est = walkAsks(book, n);
    const expectedPaid = n * value;
    const edge = expectedPaid - est.cost;
    if (edge < s.arbMinProfit) {
      this.warnOnce('profit', `edge ${edge.toFixed(5)} USDC is under --arb-min-profit ${s.arbMinProfit}`);
      return;
    }
    const edgeBps = ((expectedPaid - est.cost) / est.cost) * 1e4;
    const tag = `cycle #${this.n + 1}`;

    if (s.dryRun) {
      if (Date.now() - (this.lastWarn.get('dry') ?? 0) > 15_000) {
        this.lastWarn.set('dry', Date.now());
        log.dry('arb', `${tag}: would buy ${n.toFixed(4)} ${RC} at avg ${est.avg.toFixed(5)} (${edgeBps.toFixed(1)} bps under par), redeem for ~${expectedPaid.toFixed(4)} USDC, edge ~${edge.toFixed(4)} USDC`);
      }
      return;
    }

    log.info('arb', `${tag}: ${RC} offered at ${book.asks[0].price.toFixed(5)} (${((1 - book.asks[0].price) * 1e4).toFixed(1)} bps under par), depth ${depth.toFixed(2)} at <= ${limit.toFixed(5)}: buying ${n.toFixed(4)}`);

    // 1. buy: strict receive n lUSDC, never paying more than `limit` per unit
    const destAmount = amt7Floor(n);
    const sendMax = amt7Ceil(n * limit + 0.00001);
    let buy;
    try {
      buy = await chain.submit({
        label: 'arb',
        memo: 'lotus peg arb buy',
        ops: [Operation.pathPaymentStrictReceive({ sendAsset: assets.usdc, sendMax, destination: acct.arb.pub, destAsset: assets.lusdc, destAmount, path: [] })],
      });
    } catch (e) {
      if (e instanceof StopBot) throw e;
      log.err('arb', `${tag}: buy leg failed (${firstLine(e)}); the book probably moved, retrying next tick`);
      return;
    }
    const pp = parsePathPayment(buy.result);
    const fills = pp.ok ? pp.fills : [];
    const usdcPaid = fills.reduce((sum, f) => sum + toStroops(f.amountBought), 0n);
    const got = pp.ok ? toStroops(pp.delivered.amount) : toStroops(destAmount);
    const avg = got > 0n ? Number(usdcPaid) / Number(got) : NaN;
    bot.stats.fills += fills.length;
    bot.stats.volumeLusdc += toNum(got);
    const tBuy = Date.now();
    log.act(
      'arb',
      `${tag} BUY  ${fromStroops(got)} ${RC} for ${fromStroops(usdcPaid)} USDC, avg ${avg.toFixed(5)} (${((1 - avg) * 1e4).toFixed(1)} bps under par), ${fills.length} fill(s) vs ${[...new Set(fills.map((f) => bot.who(f.seller)))].join('+') || '?'}`,
      buy.hash,
    );

    // 2. redeem: simulate first so the return value (`paid`) is known before a fee is spent
    const redeemArgs = [addr(acct.arb.pub), i128(got)];
    let simPaid;
    try {
      simPaid = BigInt(await chain.simulateAs('arb', { method: 'redeem', args: redeemArgs }));
    } catch (e) {
      this.inventoryDirty = true;
      log.err('arb', `${tag}: redeem simulation failed (${firstLine(e)}); holding ${fromStroops(got)} ${RC}, will retry`);
      return;
    }
    const shortfall = got - simPaid;
    if (shortfall * 100000n > got && !s.allowProrata) {
      // more than 1 bp short
      this.inventoryDirty = true;
      log.warn('arb', `${tag}: redeem would pay ${fromStroops(simPaid)} for ${fromStroops(got)} ${RC} (pro-rata, vault under-backed): NOT redeeming, keeping the ${RC}`);
      return;
    }
    let red;
    try {
      red = await chain.invoke({ label: 'arb', method: 'redeem', args: redeemArgs });
    } catch (e) {
      if (e instanceof StopBot) throw e;
      this.inventoryDirty = true;
      log.err('arb', `${tag}: redeem failed (${firstLine(e)}); holding ${fromStroops(got)} ${RC}, will retry`);
      return;
    }
    const paid = BigInt(red.returnValue ?? simPaid);
    this.finishCycle({ tag, side: 'buy-redeem', size: got, usdcIn: usdcPaid, usdcOut: paid, avg, t0, tBuy, hashes: [buy.hash, red.hash], fees: (buy.feeCharged ?? 0n) + (red.feeCharged ?? 0n), fills: fills.map((f) => bot.who(f.seller)) });
  }

  // ------------------------------------------------------------ lUSDC above par

  async mintAndSell(book) {
    const { bot } = this;
    const { chain, assets, settings: s, log, acct } = bot;
    const t0 = Date.now();
    const thr = s.arbThresholdBps / 1e4;
    const minPrice = 1 + thr;

    const bal = await chain.refreshBalances('arb');
    const depth = bidDepthDownTo(book, minPrice);
    let n = Math.min(depth, s.arbMaxNotional, bal.lusdc + bal.usdc * 0.999);
    n = Math.floor(n * E7) / E7;
    if (n < s.arbMinSize) {
      this.warnOnce('small', `${RC} bid above par but size is ${n.toFixed(4)} (< --arb-min-size ${s.arbMinSize}; bid depth ${depth.toFixed(2)})`);
      return;
    }
    const est = walkBids(book, n);
    const mint = Math.max(0, n - bal.lusdc); // lUSDC we must mint at par (inventory is valued at par)
    const edge = est.proceeds - n;
    if (edge < s.arbMinProfit) {
      this.warnOnce('profit', `edge ${edge.toFixed(5)} USDC is under --arb-min-profit ${s.arbMinProfit}`);
      return;
    }
    const edgeBps = (edge / n) * 1e4;
    const tag = `cycle #${this.n + 1}`;

    if (s.dryRun) {
      if (Date.now() - (this.lastWarn.get('dry') ?? 0) > 15_000) {
        this.lastWarn.set('dry', Date.now());
        log.dry('arb', `${tag}: would mint ${mint.toFixed(4)} ${RC} at par and sell ${n.toFixed(4)} at avg ${est.avg.toFixed(5)} (${edgeBps.toFixed(1)} bps over par), edge ~${edge.toFixed(4)} USDC`);
      }
      return;
    }
    log.info('arb', `${tag}: ${RC} bid at ${book.bids[0].price.toFixed(5)} (${((book.bids[0].price - 1) * 1e4).toFixed(1)} bps over par), depth ${depth.toFixed(2)} at >= ${minPrice.toFixed(5)}: minting ${mint.toFixed(4)} and selling ${n.toFixed(4)}`);

    // 1. mint at par
    let fees = 0n;
    const hashes = [];
    let tMint = Date.now();
    if (mint > 0.0000001) {
      try {
        const dep = await chain.invoke({ label: 'arb', method: 'deposit', args: [addr(acct.arb.pub), i128(toStroops(amt7Ceil(mint)))] });
        fees += dep.feeCharged ?? 0n;
        hashes.push(dep.hash);
        tMint = Date.now();
        log.act('arb', `${tag} MINT ${amt7Ceil(mint)} ${RC} at par via deposit()`, dep.hash);
      } catch (e) {
        if (e instanceof StopBot) throw e;
        log.err('arb', `${tag}: deposit failed (${firstLine(e)})`);
        return;
      }
    }

    // 2. sell into the bids: strict send n lUSDC, destination minimum = n * (1 + threshold)
    const sendAmount = amt7Floor(n);
    const destMin = amt7Ceil(n * minPrice);
    let sell;
    try {
      sell = await chain.submit({
        label: 'arb',
        memo: 'lotus peg arb sell',
        ops: [Operation.pathPaymentStrictSend({ sendAsset: assets.lusdc, sendAmount, destination: acct.arb.pub, destAsset: assets.usdc, destMin, path: [] })],
      });
    } catch (e) {
      if (e instanceof StopBot) throw e;
      this.inventoryDirty = true;
      log.err('arb', `${tag}: sell leg failed (${firstLine(e)}); holding the minted ${RC}, will redeem it at par if the bid is gone`);
      return;
    }
    fees += sell.feeCharged ?? 0n;
    hashes.push(sell.hash);
    const pp = parsePathPayment(sell.result);
    const fills = pp.ok ? pp.fills : [];
    const got = pp.ok ? toStroops(pp.delivered.amount) : 0n; // USDC received
    const sentStroops = toStroops(sendAmount); // lUSDC sent (strict send)
    const avg = Number(got) / Number(sentStroops);
    bot.stats.fills += fills.length;
    bot.stats.volumeLusdc += n;
    log.act('arb', `${tag} SELL ${sendAmount} ${RC} for ${fromStroops(got)} USDC, avg ${avg.toFixed(5)} (${((avg - 1) * 1e4).toFixed(1)} bps over par), ${fills.length} fill(s) vs ${[...new Set(fills.map((f) => bot.who(f.seller)))].join('+') || '?'}`, sell.hash);
    this.finishCycle({ tag, side: 'mint-sell', size: sentStroops, usdcIn: sentStroops, usdcOut: got, avg, t0, tBuy: tMint, hashes, fees, fills: fills.map((f) => bot.who(f.seller)) });
  }

  // ------------------------------------------------------------ bookkeeping

  finishCycle({ tag, side, size, usdcIn, usdcOut, avg, t0, tBuy, hashes, fees, fills = [] }) {
    const { log, settings: s } = this.bot;
    this.n += 1;
    const gross = usdcOut - usdcIn;
    const feeXlm = Number(fees) / E7;
    const net = Number(gross) / E7 - feeXlm * s.xlmUsd;
    const tDone = Date.now();
    const cycle = { n: this.n, side, size: fromStroops(size), usdcIn: fromStroops(usdcIn), usdcOut: fromStroops(usdcOut), gross: fromStroops(gross), avg, feeXlm, net, seconds: (tDone - t0) / 1000, t0, tBuy, tDone, hashes, counterparties: [...new Set(fills)] };
    this.cycles.push(cycle);
    this.bot.arbLedger.push(cycle);
    this.inventoryDirty = false;
    log.act(
      'arb',
      `${tag} DONE ${side}: ${gross >= 0n ? '+' : ''}${fromStroops(gross)} USDC gross on ${fromStroops(size)} ${RC}, fees ${feeXlm.toFixed(5)} XLM (~${(feeXlm * s.xlmUsd).toFixed(5)} USD at ${s.xlmUsd}), net ${net >= 0 ? '+' : ''}${net.toFixed(5)} USD, cycle took ${cycle.seconds.toFixed(1)}s`,
    );
    return cycle;
  }

  // ------------------------------------------------------------ LBOND/USDC vs LBOND/receipt x receipt/USDC

  /** The three SDEX books, cut down to the bot's own offers with --ladder leave. */
  async triBooks() {
    const { chain, assets, settings: s, acct } = this.bot;
    const [bond, peg, direct] = await Promise.all([
      chain.orderBook(assets.lbond, assets.lusdc),
      chain.orderBook(assets.lusdc, assets.usdc),
      chain.orderBook(assets.lbond, assets.usdc),
    ]);
    if (s.ladder === 'take') return { bond, peg, direct };
    const mm = new MarketMaker(this.bot);
    if (!this.bot.mmState.offers || Date.now() - this.bot.mmState.at > 30_000) {
      this.bot.mmState = { offers: mm.classify(await chain.accountOffers(acct.mm_a.pub)), at: Date.now() };
    }
    const a = this.bot.mmState.offers;
    const b = mm.classify(await chain.accountOffers(acct.mm_b.pub)); // mm_b rests offers only in the scenarios
    const own = (g) => [...a[g], ...b[g]];
    return {
      bond: { asks: ownPrefix(bond.asks, own('bondAsks')), bids: ownPrefix(bond.bids, own('bondBids')) },
      peg: { asks: ownPrefix(peg.asks, own('pegAsks')), bids: ownPrefix(peg.bids, own('pegBids')) },
      direct: { asks: ownPrefix(direct.asks, own('usdcAsks')), bids: ownPrefix(direct.bids, own('usdcBids')) },
    };
  }

  /** Round trips USDC -> LBOND -> USDC through both venues for a few sizes; returns all candidates (best first). */
  triScan(b, usdcBal) {
    const s = this.bot.settings;
    const out = [];
    for (let k = 0, x = 5; k < 6; k++, x *= 2) {
      // A: buy LBOND on LBOND/USDC, sell it LBOND -> receipt -> USDC
      const a = walkAsks(b.direct, x);
      const r = walkBids(b.bond, x);
      const u = r.filled >= x - 1e-9 ? walkBids(b.peg, r.proceeds) : null;
      if (a.filled >= x - 1e-9 && u && u.filled >= r.proceeds - 1e-7 && a.cost <= s.triMaxNotional && a.cost <= usdcBal * 0.98) {
        out.push({ dir: 'usdc-book->route', x, cost: a.cost, back: u.proceeds, profit: u.proceeds - a.cost, edgeBps: ((u.proceeds - a.cost) / a.cost) * 1e4, buyAt: a.avg, sellAt: u.proceeds / x });
      }
      // B: buy LBOND USDC -> receipt -> LBOND, sell it on LBOND/USDC
      const rb = walkAsks(b.bond, x);
      const ub = rb.filled >= x - 1e-9 ? walkAsks(b.peg, rb.cost) : null;
      const d = walkBids(b.direct, x);
      if (ub && ub.filled >= rb.cost - 1e-7 && d.filled >= x - 1e-9 && ub.cost <= s.triMaxNotional && ub.cost <= usdcBal * 0.98) {
        out.push({ dir: 'route->usdc-book', x, cost: ub.cost, back: d.proceeds, profit: d.proceeds - ub.cost, edgeBps: ((d.proceeds - ub.cost) / ub.cost) * 1e4, buyAt: ub.cost / x, sellAt: d.avg });
      }
    }
    return out.sort((p, q) => q.profit - p.profit);
  }

  async triTick() {
    const { bot } = this;
    const { chain, assets, settings: s, log, acct } = bot;
    this.lastTri = Date.now();
    const b = await this.triBooks();
    const bal = bot.balances.arb && Date.now() - bot.balances.arb.at < 15_000 ? bot.balances.arb : await chain.refreshBalances('arb');
    const all = this.triScan(b, bal.usdc);
    this.tri.checks += 1;
    const top = [...all].sort((p, q) => q.edgeBps - p.edgeBps)[0];
    if (top) {
      this.tri.best = this.tri.best == null ? top.edgeBps : Math.max(this.tri.best, top.edgeBps);
      this.tri.worst = this.tri.worst == null ? top.edgeBps : Math.min(this.tri.worst, top.edgeBps);
    }
    const good = all.filter((c) => c.edgeBps >= s.triMinEdgeBps && c.profit >= s.arbMinProfit);
    if (!good.length) {
      if (Date.now() - this.tri.lastLog > 60_000) {
        this.tri.lastLog = Date.now();
        log.info('arb', top ? `tri check: no round trip between LBOND/USDC and LBOND/${RC} x ${RC}/USDC clears ${s.triMinEdgeBps} bps (best ${top.dir} ${top.edgeBps.toFixed(1)} bps${new Set(all.map((c) => c.dir)).size < 2 ? '; the other direction is not priceable on bot-owned depth' : ''})` : 'tri check: not enough bot-quoted depth on the three books to price a round trip');
      }
      return;
    }
    const c = good[0];
    const tag = `tri #${this.tri.executed + 1}`;
    const path = c.dir === 'usdc-book->route' ? [assets.lbond, assets.lusdc] : [assets.lusdc, assets.lbond];
    if (s.dryRun) return log.dry('arb', `${tag}: would send ${c.cost.toFixed(4)} USDC round trip ${c.dir} (${c.edgeBps.toFixed(1)} bps, ~+${c.profit.toFixed(4)} USDC)`);
    log.info('arb', `${tag}: ${c.dir} on ${c.x} LBOND: buy at ${c.buyAt.toFixed(5)}, sell at ${c.sellAt.toFixed(5)} USDC, edge ${c.edgeBps.toFixed(1)} bps (~+${c.profit.toFixed(4)} USDC)`);
    const t0 = Date.now();
    const sendAmount = amt7Ceil(c.cost);
    const destMin = amt7Floor(c.cost + c.profit * 0.5); // keep at least half the expected edge, else the whole tx fails
    let res;
    try {
      res = await chain.submit({
        label: 'arb',
        memo: 'lotus tri arb',
        ops: [Operation.pathPaymentStrictSend({ sendAsset: assets.usdc, sendAmount, destination: acct.arb.pub, destAsset: assets.usdc, destMin, path })],
      });
    } catch (e) {
      if (e instanceof StopBot) throw e;
      this.tri.failed += 1;
      log.err('arb', `${tag}: round trip failed as a whole (${firstLine(e)}); nothing moved`);
      return;
    }
    const pp = parsePathPayment(res.result);
    const fills = pp.ok ? pp.fills : [];
    const got = pp.ok ? toStroops(pp.delivered.amount) : 0n;
    const sent = toStroops(sendAmount);
    bot.stats.fills += fills.length;
    bot.stats.volumeLusdc += c.cost;
    this.tri.executed += 1;
    const gross = got - sent;
    const feeXlm = Number(res.feeCharged ?? 0n) / E7;
    const cycle = { n: bot.arbLedger.length + 1, side: `tri ${c.dir}`, size: fromStroops(sent), usdcIn: fromStroops(sent), usdcOut: fromStroops(got), gross: fromStroops(gross), avg: c.buyAt, feeXlm, net: Number(gross) / E7 - feeXlm * s.xlmUsd, seconds: (Date.now() - t0) / 1000, t0, tBuy: Date.now(), tDone: Date.now(), hashes: [res.hash], counterparties: [...new Set(fills.map((f) => bot.who(f.seller)))] };
    bot.arbLedger.push(cycle);
    log.act('arb', `${tag} DONE ${c.dir}: sent ${fromStroops(sent)} USDC, got back ${fromStroops(got)} USDC (${gross >= 0n ? '+' : ''}${fromStroops(gross)}), ${fills.length} fill(s) vs ${cycle.counterparties.join('+') || '?'}, fee ${feeXlm.toFixed(5)} XLM, one atomic tx`, res.hash);
  }

  totals() {
    let gross = 0n;
    let fees = 0;
    let size = 0n;
    for (const c of this.cycles) {
      gross += toStroops(c.gross);
      fees += c.feeXlm;
      size += toStroops(c.size);
    }
    return { cycles: this.cycles.length, gross: fromStroops(gross), feesXlm: fees, size: fromStroops(size) };
  }

  /** Redeem lUSDC left over from an interrupted cycle (at par, only while the vault is backed). */
  async settleInventory() {
    const { chain, settings: s, log, acct } = this.bot;
    this.inventoryDirty = false;
    const bal = await chain.refreshBalances('arb');
    if (bal.lusdc < s.arbMinSize) return;
    const v = await chain.views({ maxAgeMs: 1500 });
    if (this.redeemValue(v) < 1 - s.backingTolBps / 1e4 && !s.allowProrata) {
      this.warnOnce('inv-underbacked', `arb holds ${bal.lusdc.toFixed(4)} ${RC} but the vault is under-backed: not redeeming`);
      this.inventoryDirty = true;
      return;
    }
    const amount = toStroops(bal.lusdcRaw);
    if (s.dryRun) return log.dry('arb', `would redeem leftover ${fromStroops(amount)} ${RC}`);
    try {
      const red = await chain.invoke({ label: 'arb', method: 'redeem', args: [addr(acct.arb.pub), i128(amount)] });
      log.act('arb', `INVENTORY redeemed leftover ${fromStroops(amount)} ${RC} for ${fromStroops(BigInt(red.returnValue ?? 0))} USDC`, red.hash);
    } catch (e) {
      if (e instanceof StopBot) throw e;
      this.inventoryDirty = true;
      log.err('arb', `leftover redeem failed (${firstLine(e)})`);
    }
  }
}
