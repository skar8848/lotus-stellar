// Scenarios: stress tests of the lUSDC peg and the scripted demo run.
//
//   depeg    mm_b dumps lUSDC into the USDC/lUSDC book (eats every bid, the rest rests as a cheap ask); the
//            arbitrageur must buy it under par and redeem 1:1 on lotus_vault. Before/after table, tx links.
//   premium  the mirror image: mm_b buys lUSDC above par (eats every ask, the rest rests as a rich bid); the
//            arbitrageur mints at par with deposit() and sells into that bid.
//   demo     ~3 minutes for the video: normal quoting, a trade burst, a depeg shock at ~60s, arb recovery,
//            summary. NAV accrual is accelerated so the simulated 5% APR drift is visible.
//
// Everything runs on testnet with the bot's own accounts. The shock consumes the peg book's resting bids
// (or asks), including peg_lp's: that is the point of a stress test, and `node 04-seed-book.mjs --reset`
// re-posts the demo books afterwards.

import { Asset, Operation } from '@stellar/stellar-sdk';
import { fromStroops } from '../lib/stellar.mjs';
import { addr, i128, toStroops } from '../lib/stellar.mjs';
import { amt7Ceil, amt7Floor, invPriceFrac, priceFrac } from './lib/book.mjs';
import { firstLine } from './lib/bot.mjs';
import { txUrl } from './lib/log.mjs';
import { startComponents } from './lib/run.mjs';
import { keeperStep } from './keeper.mjs';
import { offerResults } from './lib/xdr.mjs';
import { RC } from './lib/names.mjs';

// ------------------------------------------------------------------ helpers

export async function runScenario(bot) {
  const name = bot.settings.scenario;
  if (name === 'depeg') return scenarioShock(bot, 'depeg');
  if (name === 'premium') return scenarioShock(bot, 'premium');
  if (name === 'demo') return scenarioDemo(bot);
  if (name === 'keeper') return scenarioKeeper(bot);
  if (name === 'cross-venue') {
    const { scenarioCrossVenue } = await import('./pool-scenarios.mjs');
    return scenarioCrossVenue(bot);
  }
  throw new Error(`unknown scenario "${name}" (depeg | premium | demo | cross-venue | keeper)`);
}

const f = (x, d = 5) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));
const bpsVs = (x, ref = 1) => (x == null ? '-' : `${(((x - ref) / ref) * 1e4).toFixed(1)} bps`);

/** Peg book + contract state at one instant. */
export async function snapshot(bot, label) {
  const { chain, assets } = bot;
  chain.invalidateBooks();
  const book = await chain.orderBook(assets.lusdc, assets.usdc, { maxAgeMs: 0 });
  let last = null;
  try {
    const t = (await chain.recentTrades(assets.lusdc, assets.usdc, 1))[0];
    if (t) {
      const p = Number(t.price.n) / Number(t.price.d);
      last = t.base_asset_code === 'USDC' ? 1 / p : p; // price is counter per base
    }
  } catch {
    /* trades are informational */
  }
  const v = await chain.views({ maxAgeMs: 0 });
  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask;
  return {
    label,
    at: Date.now(),
    bid,
    ask,
    bidDepth: book.bids.reduce((x, l) => x + l.amount, 0),
    askDepth: book.asks.reduce((x, l) => x + l.amount, 0),
    mid,
    last,
    supply: v.supply,
    vault: v.vaultValue,
    book,
  };
}

export function printPegTable(bot, snaps) {
  bot.log.table(
    ['phase', 'best bid', 'best ask', 'mid', 'mid vs par', 'last trade', 'supply', 'vault_value', 'vault/supply'],
    snaps.map((s) => [
      s.label,
      s.bid == null ? '(none)' : f(s.bid),
      s.ask == null ? '(none)' : f(s.ask),
      f(s.mid),
      bpsVs(s.mid),
      f(s.last),
      fromStroops(s.supply),
      fromStroops(s.vault),
      `${((Number(s.vault) / Number(s.supply)) * 100).toFixed(6)}%`,
    ]),
  );
}

/** Cancel every open offer of one of the bot's accounts (own offers only). */
export async function cancelOwn(bot, label) {
  const { chain, acct, log } = bot;
  if (bot.settings.dryRun) return 0;
  const offers = await chain.accountOffers(acct[label].pub);
  if (!offers.length) return 0;
  const toAsset = (a) => (a.asset_type === 'native' ? Asset.native() : new Asset(a.asset_code, a.asset_issuer));
  const ops = offers.slice(0, 100).map((o) =>
    Operation.manageSellOffer({ selling: toAsset(o.selling), buying: toAsset(o.buying), amount: '0', price: { n: o.price_r.n, d: o.price_r.d }, offerId: o.id }),
  );
  const res = await chain.submit({ label, ops, memo: 'lotus scenario cleanup' });
  log.act(label, `cancelled ${ops.length} leftover offer(s) of its own`, res.hash);
  return ops.length;
}

const who = (bot, seller) => bot.who(seller);

function describeHits(bot, claimed, { asBids }) {
  // ClaimAtom: seller = resting offer owner. For a dump into bids the owner bought lUSDC (amountBought) and sold USDC.
  return claimed.map((c) => {
    const lusdc = asBids ? c.amountBought : c.amountSold;
    const usdc = asBids ? c.amountSold : c.amountBought;
    return { who: who(bot, c.seller), lusdc: Number(lusdc), usdc: Number(usdc), price: Number(usdc) / Number(lusdc) };
  });
}

// ------------------------------------------------------------------ depeg / premium

// getters, not plain strings: the receipt code (lUSDC / lUSDCb) is only known once the config is loaded
const KINDS = {
  depeg: {
    get title() {
      return `Depeg stress test: ${RC} pushed under par`;
    },
    get story() {
      return (
        `mm_b dumps ${RC} into the USDC/${RC} book: every resting bid is eaten and the remainder rests as a cheap ask. ` +
        `The arbitrageur should buy that ${RC} under 1 USDC and redeem it 1:1 on lotus_vault.`
      );
    },
    restored: (book, thr) => !book.asks[0] || book.asks[0].price > 1 - thr,
    rowLabel: 'after shock (arb waiting)',
  },
  premium: {
    get title() {
      return `Premium stress test: ${RC} bid above par`;
    },
    get story() {
      return (
        `mm_b buys ${RC} above 1 USDC: every resting ask is eaten and the remainder rests as a rich bid. ` +
        `The arbitrageur should mint ${RC} at par with deposit() and sell it into that bid.`
      );
    },
    restored: (book, thr) => !book.bids[0] || book.bids[0].price < 1 + thr,
    rowLabel: 'after shock (arb waiting)',
  },
};

/**
 * Make sure mm_b can fund a shock: mint lUSDC at par (deposit) when it is short of lUSDC, or redeem lUSDC
 * when it is short of USDC. Both are plain lotus_vault calls signed by mm_b.
 */
async function ensureInventory(bot, { lusdc = 0, usdc = 0 }) {
  const { chain, log, acct, settings: s } = bot;
  let bal = await chain.refreshBalances('mm_b');
  if (bal.lusdc < lusdc) {
    const mint = Math.ceil(lusdc - bal.lusdc + 25);
    if (bal.usdc < mint + 20) throw new Error(`mm_b needs ${mint} more ${RC} but only holds ${bal.usdc.toFixed(2)} USDC`);
    if (s.dryRun) return log.dry('mm_b', `would mint ${mint} ${RC} with deposit() to fund the shock`);
    const res = await chain.invoke({ label: 'mm_b', method: 'deposit', args: [addr(acct.mm_b.pub), i128(toStroops(String(mint)))] });
    log.act('mm_b', `inventory: minted ${mint} ${RC} at par with deposit() to fund the shock`, res.hash);
    bal = await chain.refreshBalances('mm_b');
  }
  if (bal.usdc < usdc) {
    const burn = Math.ceil(usdc - bal.usdc + 25);
    if (bal.lusdc < burn + 20) throw new Error(`mm_b needs ${burn} more USDC but only holds ${bal.lusdc.toFixed(2)} ${RC}`);
    if (s.dryRun) return log.dry('mm_b', `would redeem ${burn} ${RC} to fund the shock`);
    const res = await chain.invoke({ label: 'mm_b', method: 'redeem', args: [addr(acct.mm_b.pub), i128(toStroops(String(burn)))] });
    log.act('mm_b', `inventory: redeemed ${burn} ${RC} at par to get USDC for the shock`, res.hash);
    await chain.refreshBalances('mm_b');
  }
}

/** Post the shock with mm_b. Returns { hash, hits, restOfferId, restAmount, size, price } or null (dry-run). */
async function postShock(bot, kind, book) {
  const { chain, assets, settings: s, log } = bot;
  if (kind === 'depeg') {
    const eaten = book.bids.filter((b) => b.price >= s.shockPrice).reduce((x, b) => x + b.amount, 0);
    const size = eaten + s.shockRest;
    const op = Operation.manageSellOffer({ selling: assets.lusdc, buying: assets.usdc, amount: amt7Floor(size), price: priceFrac(s.shockPrice), offerId: '0' });
    if (s.dryRun) {
      log.dry('mm_b', `would dump ${size.toFixed(2)} ${RC} at limit ${s.shockPrice} (eats ${eaten.toFixed(2)} of bids, ${s.shockRest} would rest as an ask)`);
      return null;
    }
    const res = await chain.submit({ label: 'mm_b', ops: [op], memo: 'lotus depeg shock' });
    const r = offerResults(res.result)[0];
    return { hash: res.hash, hits: describeHits(bot, r?.claimed ?? [], { asBids: true }), restOfferId: r?.offerId ?? null, restAmount: Number(r?.amountRemaining ?? 0), size, price: s.shockPrice, eaten };
  }
  // premium: sell USDC for lUSDC at up to premiumPrice
  const eaten = book.asks.filter((a) => a.price <= s.premiumPrice).reduce((x, a) => x + a.amount, 0);
  const lusdcTarget = eaten + s.premiumSize;
  const usdcAmount = lusdcTarget * s.premiumPrice;
  const op = Operation.manageSellOffer({ selling: assets.usdc, buying: assets.lusdc, amount: amt7Ceil(usdcAmount), price: invPriceFrac(s.premiumPrice), offerId: '0' });
  if (s.dryRun) {
    log.dry('mm_b', `would bid ${lusdcTarget.toFixed(2)} ${RC} at up to ${s.premiumPrice} (eats ${eaten.toFixed(2)} of asks, ${s.premiumSize} would rest as a bid)`);
    return null;
  }
  const res = await chain.submit({ label: 'mm_b', ops: [op], memo: 'lotus premium shock' });
  const r = offerResults(res.result)[0];
  return { hash: res.hash, hits: describeHits(bot, r?.claimed ?? [], { asBids: false }), restOfferId: r?.offerId ?? null, restAmount: Number(r?.amountRemaining ?? 0) * (1 / s.premiumPrice), size: lusdcTarget, price: s.premiumPrice, eaten };
}

/** Fund mm_b for the shock BEFORE the 'before' snapshot, so inventory mints do not pollute the contract figures. */
async function prepareShock(bot, kind) {
  const { chain, assets, settings: s } = bot;
  const book = await chain.orderBook(assets.lusdc, assets.usdc, { maxAgeMs: 0 });
  if (kind === 'depeg') {
    const need = (book.bids.filter((b) => b.price >= s.shockPrice).reduce((x, b) => x + b.amount, 0) + s.shockRest) * 1.02 + 5;
    await ensureInventory(bot, { lusdc: need });
  } else {
    const need = ((book.asks.filter((a) => a.price <= s.premiumPrice).reduce((x, a) => x + a.amount, 0) + s.premiumSize) * s.premiumPrice) * 1.02 + 5;
    await ensureInventory(bot, { usdc: need });
  }
}

/** One shock + recovery cycle on a running bot (mm and arb loops already started). */
async function shockAndRecover(bot, kind, { arb, mm }) {
  const { log, chain, assets, settings: s } = bot;
  const K = KINDS[kind];
  const thr = s.arbThresholdBps / 1e4;
  const out = { kind, snaps: [], cycles: [] };

  await prepareShock(bot, kind);
  out.snaps.push(await snapshot(bot, 'before shock'));
  log.raw('');
  log.info('scenario', `peg before: bid ${f(out.snaps[0].bid)} / ask ${f(out.snaps[0].ask)}, supply ${fromStroops(out.snaps[0].supply)}, vault_value ${fromStroops(out.snaps[0].vault)}`);

  const cyclesBefore = arb.cycles.length;
  bot.paused.arb = true;
  const shock = await postShock(bot, kind, out.snaps[0].book);
  if (!shock) return out; // dry-run
  const tShock = Date.now();
  bot.paused.arb = false;
  out.shock = shock;
  out.tShock = tShock;

  const hitsTxt = shock.hits.map((h) => `${h.lusdc.toFixed(2)} ${RC} vs ${h.who} @${h.price.toFixed(5)}`).join(', ') || 'none';
  if (kind === 'depeg') {
    log.act('mm_b', `SHOCK dumped ${shock.size.toFixed(2)} ${RC} at limit ${s.shockPrice}: ${hitsTxt}; ${shock.restAmount.toFixed(2)} ${RC} now rests as an ask at ${s.shockPrice} (offer ${shock.restOfferId})`, shock.hash);
  } else {
    log.act('mm_b', `SHOCK bid up to ${s.premiumPrice} for ${shock.size.toFixed(2)} ${RC}: ${hitsTxt}; ~${shock.restAmount.toFixed(2)} ${RC} of bid now rests at ${s.premiumPrice} (offer ${shock.restOfferId})`, shock.hash);
  }
  out.snaps.push({ ...(await snapshot(bot, K.rowLabel)) });

  // ---- wait for the arbitrageur
  log.info('scenario', `waiting for the arbitrageur (polls every ${s.arbIntervalSec}s, threshold ${s.arbThresholdBps} bps)...`);
  const deadline = Date.now() + s.recoverTimeoutSec * 1000;
  let restored = false;
  while (Date.now() < deadline && !bot.stopping) {
    await bot.sleep(1500);
    if (arb.cycles.length > cyclesBefore && !arb.busy) {
      const book = await chain.orderBook(assets.lusdc, assets.usdc, { maxAgeMs: 0 });
      if (K.restored(book, thr)) {
        restored = true;
        out.tRestored = Date.now();
        break;
      }
    }
  }
  out.restored = restored;
  out.cycles = arb.cycles.slice(cyclesBefore);
  if (!restored) log.warn('scenario', `peg NOT restored within ${s.recoverTimeoutSec}s (arb cycles: ${out.cycles.length}); see the arb log lines above`);

  // ---- tidy: mm_b's leftover shock offer, then give mm_a one tick to bring its quotes back
  try {
    await cancelOwn(bot, 'mm_b');
  } catch (e) {
    log.warn('scenario', `could not cancel mm_b leftovers: ${firstLine(e)}`);
  }
  const back = Date.now() + 40_000;
  while (Date.now() < back && !bot.stopping) {
    const book = await chain.orderBook(assets.lusdc, assets.usdc, { maxAgeMs: 0 });
    if (book.bids[0] && book.bids[0].price > 0.998 && book.asks[0] && book.asks[0].price < 1.002) break;
    await bot.sleep(2500);
  }
  out.tQuotesBack = Date.now();
  out.snaps.push(await snapshot(bot, 'after arbitrage'));
  return out;
}

function printShockReport(bot, out) {
  const { log, settings: s } = bot;
  if (!out.shock) return;
  const K = KINDS[out.kind];
  log.head(`${K.title}: result`);
  printPegTable(bot, out.snaps);
  log.raw('');
  const t = (ms) => `T+${((ms - out.tShock) / 1000).toFixed(1)}s`;
  log.raw(`  shock            ${out.shock.hits.length} resting offer(s) hit, ${out.shock.restAmount.toFixed(2)} ${RC} left resting at ${out.kind === 'depeg' ? s.shockPrice : s.premiumPrice}`);
  for (const h of out.shock.hits) log.raw(`                     ${h.lusdc.toFixed(4)} ${RC} vs ${h.who} at ${h.price.toFixed(5)} (${bpsVs(h.price)} vs par)`);
  log.raw(`                     tx ${txUrl(out.shock.hash)}`);
  if (!out.cycles.length) {
    log.raw('  arbitrage        none: the arbitrageur did not act (see warnings above)');
    return;
  }
  let gross = 0;
  let fees = 0;
  for (const c of out.cycles) {
    gross += Number(c.gross);
    fees += c.feeXlm;
    log.raw(`  arbitrage #${c.n}     ${c.side}: ${c.size} ${RC} at avg ${c.avg.toFixed(5)} (${bpsVs(c.avg)} vs par), counterparty ${c.counterparties.join('+') || '?'}`);
    log.raw(`                     detected ${t(c.t0)}, first leg confirmed ${t(c.tBuy)}, second leg confirmed ${t(c.tDone)}  (cycle ${c.seconds.toFixed(1)}s)`);
    log.raw(`                     gross ${Number(c.gross) >= 0 ? '+' : ''}${c.gross} USDC, fees ${c.feeXlm.toFixed(5)} XLM`);
    for (const h of c.hashes) log.raw(`                     tx ${txUrl(h)}`);
  }
  const before = out.snaps[0];
  const after = out.snaps[out.snaps.length - 1];
  log.raw(`  total            arb gross ${gross >= 0 ? '+' : ''}${gross.toFixed(7)} USDC, fees ${fees.toFixed(5)} XLM`);
  const moved = out.cycles.reduce((x, c) => x + Number(c.size), 0);
  log.raw(`  contract         supply ${fromStroops(before.supply)} -> ${fromStroops(after.supply)}: ${out.kind === 'depeg' ? 'redeem() burnt' : 'deposit() minted'} ${moved.toFixed(4)} ${RC} at par; vault_value ${fromStroops(before.vault)} -> ${fromStroops(after.vault)}`);
  log.raw(
    out.restored
      ? `  peg restored     ${t(out.tRestored)} after the shock landed (book no longer offers an edge >= ${s.arbThresholdBps} bps); mm_a quotes back ${t(out.tQuotesBack)}`
      : `  peg restored     NO (timeout ${s.recoverTimeoutSec}s)`,
  );
}

async function scenarioShock(bot, kind) {
  const { log } = bot;
  const K = KINDS[kind];
  log.head(`Scenario: ${K.title}`);
  log.raw(K.story);
  log.raw(bot.settings.dryRun ? '(dry-run: the shock is sized and described but not sent)' : '');
  // arb paused until the shock lands; mm_a posts its quotes and keeps them fresh; no random flow
  const comps = startComponents(bot, { only: 'mm,arb', arbEvery: 1.5, mmEvery: 6 });
  bot.paused.arb = true;
  // make sure mm_a has quotes in place before the "before" snapshot
  try {
    await comps.mm.tick();
  } catch (e) {
    log.warn('scenario', `initial mm_a quote failed: ${firstLine(e)}`);
  }
  await bot.sleep(2000);
  const out = await shockAndRecover(bot, kind, comps);
  printShockReport(bot, out);
  bot.stop('scenario finished');
  await Promise.all(comps.loops);
  return out;
}

// ------------------------------------------------------------------ demo (~3 minutes)

async function scenarioDemo(bot) {
  const { log, settings: s } = bot;
  const T0 = Date.now();
  const at = () => (Date.now() - T0) / 1000;
  const until = async (sec) => {
    while (at() < sec && !bot.stopping) await bot.sleep(250);
  };
  log.head('Demo run (about 3 minutes)');
  log.raw('t=0 normal quoting | t~30s trade burst | t~60s depeg shock | arb recovery | final summary');
  if (s.timeScale <= 1) {
    bot.nav.timeScale = 5000;
    log.raw('LBOND NAV accrual (5% APR) is accelerated x5000 for this run so the drift is visible within minutes (one real minute ~ 3.5 days of accrual).');
  }

  const comps = startComponents(bot, { only: 'mm,arb,flow,poolmm', arbEvery: 2, mmEvery: 6, flowWarmupMs: 8_000 });
  const { flow } = comps;
  flow.pace = { min: 5, max: 9 };
  const stats0 = { flow: bot.stats.flowTrades, fills: bot.stats.fills };

  await until(30);
  log.raw(`\n-- t=${at().toFixed(0)}s: trade burst (several trades per ledger) --`);
  bot.paused.flow = true; // the scripted burst replaces the random flow for a moment
  for (let i = 0; i < 4 && at() < 56 && !bot.stopping; i++) {
    try {
      await flow.burst(3 + Math.floor(Math.random() * 3));
    } catch (e) {
      log.err('demo', `burst failed: ${firstLine(e)}`);
    }
    await bot.sleep(1500 + Math.random() * 2500);
  }
  bot.paused.flow = false;
  flow.pace = { min: 5, max: 9 };
  await until(60);
  log.raw(`\n-- t=${at().toFixed(0)}s: depeg shock --`);
  flow.pace = null;
  bot.paused.flow = true;
  let shock;
  try {
    shock = await shockAndRecover(bot, 'depeg', comps);
  } catch (e) {
    log.err('demo', `shock failed: ${firstLine(e)}`);
  }
  bot.paused.flow = false;
  flow.pace = { min: 6, max: 10 };
  log.raw(`\n-- t=${at().toFixed(0)}s: normal trading again --`);
  await until(Math.max(165, at() + 25) + s.keeperWait);
  const after = await snapshot(bot, 'end of demo');
  bot.stop('demo finished');
  await Promise.all(comps.loops);

  if (shock) printShockReport(bot, shock);
  log.head('Demo totals');
  log.raw(`  duration         ${at().toFixed(0)}s`);
  log.raw(`  trades           ${bot.stats.flowTrades - stats0.flow} flow trades by mm_b, ${bot.arbLedger.length} arbitrage cycle(s) by arb, ${bot.stats.fills - stats0.fills} fills in total`);
  log.raw(`  end state        peg ${f(after.bid)} / ${f(after.ask)} (mid ${f(after.mid)}, ${bpsVs(after.mid)} vs par)`);
  const nav = bot.nav.snapshot();
  log.raw(`  LBOND fair value ${nav.fair.toFixed(5)} (NAV ${nav.nav.toFixed(6)} from ${bot.navStart.toFixed(6)})`);

  // real interest: mm_a's offers have been resting all along, now the keeper pays the vault's interest to every holder
  if (s.demoKeeper) {
    try {
      await keeperStep(bot, { minSurplus: BigInt(Math.round(s.keeperMinSurplus * 1e7)) });
    } catch (e) {
      log.err('keeper', firstLine(e));
    }
  }
}

/** Let mm_a's quotes rest and trade for a while, then run the keeper step. */
async function scenarioKeeper(bot) {
  const { log, settings: s } = bot;
  const wait = s.keeperWait > 0 ? s.keeperWait : 180;
  log.head('Scenario: keeper distribution of real interest');
  log.raw(`mm_a quotes and the flow trades for ${wait}s, so some receipt sits in open offers; then the keeper distributes the vault interest`);
  log.raw('(surplus = vault_value - supply) to every holder pro rata. SDEX offers never move funds off the account, so quoted inventory earns too.');
  const comps = startComponents(bot, { only: 'mm,flow,poolmm', mmEvery: 8, flowWarmupMs: 8_000 });
  const end = Date.now() + wait * 1000;
  while (Date.now() < end && !bot.stopping) await bot.sleep(500);
  bot.stop('wait finished');
  await Promise.all(comps.loops);
  await keeperStep(bot, { minSurplus: BigInt(Math.round(s.keeperMinSurplus * 1e7)) });
}
