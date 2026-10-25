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

import { Operation } from '@stellar/stellar-sdk';
import { addr, assetLabel, fromStroops, i128, toStroops } from '../lib/stellar.mjs';
import { amt7, amt7Ceil, amt7Floor, askDepthUpTo, bidDepthDownTo, walkAsks, walkBids } from './lib/book.mjs';
import { parsePathPayment } from './lib/xdr.mjs';
import { StopBot } from './lib/chain.mjs';
import { firstLine } from './lib/bot.mjs';
import { RC } from './lib/names.mjs';

const E7 = 1e7;
const toNum = (stroops) => Number(stroops) / E7;

export class Arb {
  constructor(bot) {
    this.bot = bot;
    this.n = 0;
    this.cycles = []; // ledger of completed cycles
    this.inventoryDirty = true;
    this.lastWarn = new Map();
    this.busy = false;
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
