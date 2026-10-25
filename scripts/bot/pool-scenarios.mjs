// Scenario: cross-venue dislocation (Lotus pool vs SDEX).
//
//   npm run bot -- --scenario cross-venue [--cross-dir cheap|rich|both] [--cross-shock-bps 80] [--cross-shock-size 60]
//
//   cheap  mm_b posts a pool Ask position priced `crossShockBps` under what the SDEX pays for LBOND. The arbitrageur
//          buys LBOND from the pool (swap) and sells it on the SDEX (path payment LBOND -> lUSDC -> USDC).
//   rich   mm_b posts a pool Bid position priced `crossShockBps` over what LBOND costs on the SDEX. The arbitrageur
//          buys LBOND on the SDEX (path payment USDC -> lUSDC -> LBOND) and sells it to the pool (swap).
//
// Before/after table of both venues' prices, the arbitrage ledger and every tx link. mm_b's position is
// removed at the end (unfilled inventory and proceeds come back to mm_b).

import { fromStroops } from '../lib/stellar.mjs';
import { firstLine } from './lib/bot.mjs';
import { txUrl } from './lib/log.mjs';
import { startComponents } from './lib/run.mjs';
import { RC } from './lib/names.mjs';

const E7 = 1e7;
const stroops = (x) => BigInt(Math.round(Number(x) * E7));
const f = (x, d = 5) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));
const bps = (a, b) => (a == null || b == null ? null : ((a - b) / b) * 1e4);
const fb = (x) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(1)} bps`);

/** Prices of LBOND in USDC on both venues, as seen by a taker of ~1 LBOND. */
export async function crossSnapshot(bot, cross, label) {
  const pool = bot.poolAdapter;
  bot.chain.invalidateBooks();
  const top = await pool.topOfBook();
  const books = await cross.books();
  const fee = pool.feeBps / 1e4;
  const sell1 = cross.sdexSell(books, 1);
  const buy1 = cross.sdexBuy(books, 1);
  const poolBuy = top.ask ? top.ask.price * (1 + fee) : null; // what a buyer of 1 LBOND pays on the pool
  const poolSell = top.bid ? top.bid.price * (1 - fee) : null; // what a seller of 1 LBOND gets on the pool
  return {
    label,
    at: Date.now(),
    poolAsk: top.ask,
    poolBid: top.bid,
    poolBuy,
    poolSell,
    sdexSell: sell1?.usdc ?? null,
    sdexBuy: buy1?.usdc ?? null,
    edgeBuyPool: bps(sell1?.usdc ?? null, poolBuy), // buy on the pool, sell on the SDEX
    edgeBuySdex: bps(poolSell, buy1?.usdc ?? null), // buy on the SDEX, sell on the pool
  };
}

function printCrossTable(bot, snaps) {
  bot.log.table(
    ['phase', 'pool best ask (bin)', 'pool best bid (bin)', 'pool buy (+fee)', 'pool sell (-fee)', 'SDEX sell LBOND', 'SDEX buy LBOND', 'edge buy pool/sell SDEX', 'edge buy SDEX/sell pool'],
    snaps.map((s) => [
      s.label,
      s.poolAsk ? `${f(s.poolAsk.price, 4)} (${s.poolAsk.bin})` : '(none)',
      s.poolBid ? `${f(s.poolBid.price, 4)} (${s.poolBid.bin})` : '(none)',
      f(s.poolBuy),
      f(s.poolSell),
      f(s.sdexSell),
      f(s.sdexBuy),
      fb(s.edgeBuyPool),
      fb(s.edgeBuySdex),
    ]),
  );
}

async function shockOnce(bot, comps, dir) {
  const { log, settings: s } = bot;
  const pool = bot.poolAdapter;
  const { cross } = comps;
  const out = { dir, snaps: [] };
  out.snaps.push(await crossSnapshot(bot, cross, 'before dislocation'));
  const before = out.snaps[0];
  const cyclesBefore = cross.cycles.length;

  // ---- price the dislocating position relative to the SDEX
  let side;
  let bin;
  let amount;
  const fee = pool.feeBps / 1e4;
  if (dir === 'cheap') {
    if (before.sdexSell == null) throw new Error('no SDEX bid for LBOND to measure against (is mm_a quoting the bond book?)');
    const rawAsk = (before.sdexSell * (1 - s.crossShockBps / 1e4)) / (1 + fee);
    bin = pool.binFloor(rawAsk);
    side = 'Ask';
    amount = stroops(s.crossShockSize); // LBOND
  } else {
    if (before.sdexBuy == null) throw new Error('no SDEX ask for LBOND to measure against (is mm_a quoting the bond book?)');
    const rawBid = (before.sdexBuy * (1 + s.crossShockBps / 1e4)) / (1 - fee);
    bin = pool.binCeil(rawBid);
    side = 'Bid';
    amount = stroops(s.crossShockSize * pool.priceAt(bin)); // USDC that can absorb crossShockSize LBOND
  }
  const price = pool.priceAt(bin);
  log.info('scenario', `${dir}: pool ${side} at bin ${bin} = ${price.toFixed(4)} (SDEX ${dir === 'cheap' ? 'pays' : 'asks'} ${f(dir === 'cheap' ? before.sdexSell : before.sdexBuy, 4)}, shock ${s.crossShockBps} bps)`);

  if (s.dryRun) {
    log.dry('mm_b', `would add a pool ${side} position at bin ${bin} (${price.toFixed(4)}), ${fromStroops(amount)} ${side === 'Ask' ? 'LBOND' : 'USDC'}`);
    return out;
  }
  bot.paused.cross = true;
  const add = await pool.addPosition('mm_b', side, bin, bin, amount);
  const tShock = Date.now();
  out.tShock = tShock;
  out.shock = { side, bin, price, hash: add.hash, id: add.id, amount: fromStroops(amount) };
  bot.paused.cross = false;
  log.act('mm_b', `POOL ${side.toUpperCase()} position #${add.id} at bin ${bin} (${price.toFixed(4)}): ${fromStroops(amount)} ${side === 'Ask' ? 'LBOND' : 'USDC'} -> the pool now ${dir === 'cheap' ? 'sells LBOND' : 'pays for LBOND'} ${s.crossShockBps} bps away from the SDEX`, add.hash);
  out.snaps.push(await crossSnapshot(bot, cross, 'dislocated (arb waiting)'));

  // ---- wait for the arbitrageur to close it
  log.info('scenario', `waiting for the cross-venue arbitrageur (polls every 2s, needs ${s.crossMinEdgeBps} bps net)...`);
  const deadline = Date.now() + s.recoverTimeoutSec * 1000;
  let closed = false;
  while (Date.now() < deadline && !bot.stopping) {
    await bot.sleep(2000);
    if (cross.cycles.length > cyclesBefore && !cross.busy) {
      const scan = await cross.scan();
      if (!scan.best) {
        closed = true;
        out.tClosed = Date.now();
        break;
      }
    }
  }
  out.closed = closed;
  out.cycles = cross.cycles.slice(cyclesBefore);
  if (!closed) log.warn('scenario', `dislocation NOT closed within ${s.recoverTimeoutSec}s (cycles: ${out.cycles.length})`);

  // ---- tidy: take mm_b's position back
  try {
    const r = await pool.removePosition('mm_b', add.id);
    out.removed = { base: fromStroops(r.base), quote: fromStroops(r.quote), hash: r.hash };
    log.act('mm_b', `POOL closed position #${add.id}: got back ${fromStroops(r.base)} LBOND and ${fromStroops(r.quote)} USDC (what the arbitrageur did not take, plus proceeds)`, r.hash);
  } catch (e) {
    log.warn('scenario', `could not close mm_b's position #${add.id}: ${firstLine(e)}`);
  }
  await bot.sleep(1500);
  out.snaps.push(await crossSnapshot(bot, cross, 'after arbitrage'));
  return out;
}

function printReport(bot, out) {
  const { log, settings: s } = bot;
  if (!out.shock) return;
  log.head(`Cross-venue result (${out.dir}: pool ${out.shock.side} ${s.crossShockBps} bps off the SDEX)`);
  printCrossTable(bot, out.snaps);
  log.raw('');
  const t = (ms) => `T+${((ms - out.tShock) / 1000).toFixed(1)}s`;
  log.raw(`  dislocation      mm_b pool ${out.shock.side} position #${out.shock.id}, bin ${out.shock.bin} = ${out.shock.price.toFixed(4)}, ${out.shock.amount} ${out.shock.side === 'Ask' ? 'LBOND' : 'USDC'}`);
  log.raw(`                     tx ${txUrl(out.shock.hash)}`);
  if (!out.cycles?.length) {
    log.raw('  arbitrage        none: the cross-venue arbitrageur did not act (see warnings above)');
    return;
  }
  let gross = 0;
  let fees = 0;
  for (const c of out.cycles) {
    gross += Number(c.gross);
    fees += c.feeXlm;
    log.raw(`  arbitrage #${c.n}     ${c.side}: ~${Number(c.size).toFixed(3)} LBOND, expected ${Number(c.usdcOut) - Number(c.usdcIn) >= 0 ? '+' : ''}${(Number(c.usdcOut) - Number(c.usdcIn)).toFixed(4)} USDC, realised ${Number(c.gross) >= 0 ? '+' : ''}${c.gross} USDC, fees ${c.feeXlm.toFixed(5)} XLM`);
    log.raw(`                     detected ${t(c.t0)}, first leg ${t(c.tBuy)}, second leg ${t(c.tDone)} (cycle ${c.seconds.toFixed(1)}s), counterparties: ${c.counterparties.join('+') || 'pool'}`);
    for (const h of c.hashes) log.raw(`                     tx ${txUrl(h)}`);
  }
  log.raw(`  total            arb ${gross >= 0 ? '+' : ''}${gross.toFixed(7)} USDC gross, ${fees.toFixed(5)} XLM fees`);
  log.raw(out.closed ? `  gap closed       ${t(out.tClosed)} after the dislocation landed (no remaining edge >= ${s.crossMinEdgeBps} bps net)` : '  gap closed       NO (timeout)');
  if (out.removed) log.raw(`  mm_b position    closed, ${out.removed.base} LBOND + ${out.removed.quote} USDC returned  ${txUrl(out.removed.hash)}`);
}

export async function scenarioCrossVenue(bot) {
  const { log, settings: s } = bot;
  if (!bot.poolAdapter) {
    throw new Error(
      'the cross-venue scenario needs the Lotus pool: deployments/testnet.pool.json lists no live LBOND/USDC pool, ' +
        'the ABI did not match, or --pool off was given',
    );
  }
  log.head('Scenario: cross-venue arbitrage (Lotus pool vs SDEX)');
  log.raw('mm_b plants a mispriced position in the Lotus pool; the arbitrageur compares quote_swap (fee included) with the SDEX route');
  log.raw(`LBOND <-> ${RC} <-> USDC and closes the gap with a pool swap plus the opposite path payment.`);
  const comps = startComponents(bot, { only: 'mm,poolmm,cross', crossEvery: 2, mmEvery: 6 });
  bot.paused.cross = true;
  try {
    await comps.mm.tick();
    await comps.poolmm.tick();
  } catch (e) {
    log.warn('scenario', `initial quoting: ${firstLine(e)}`);
  }
  await bot.sleep(2500);
  const dirs = s.crossDir === 'both' ? ['cheap', 'rich'] : [s.crossDir];
  const results = [];
  for (const dir of dirs) {
    if (bot.stopping) break;
    try {
      const out = await shockOnce(bot, comps, dir);
      results.push(out);
      printReport(bot, out);
    } catch (e) {
      log.err('scenario', `${dir}: ${firstLine(e)}`);
    }
  }
  bot.stop('scenario finished');
  await Promise.all(comps.loops);
  return results;
}
