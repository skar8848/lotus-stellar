// Starts the bot's loops. Shared by normal mode (index.mjs) and the scenarios.

import { Arb } from '../arb.mjs';
import { Flow, MarketMaker } from '../mm.mjs';
import { StopBot } from './chain.mjs';
import { firstLine, startLoop } from './bot.mjs';
import { jitter } from './limiter.mjs';
import { CrossArb, PoolMM } from '../pool-legs.mjs';
import { LiquidityGuard } from './guard.mjs';

/**
 * Create the components and start their loops.
 *   only        'arb,mm,flow' subset (default: settings.only)
 *   arbEvery    seconds between arbitrage ticks (default settings.arbIntervalSec)
 *   mmEvery     seconds between market-maker ticks (default settings.mmIntervalSec)
 * Returns { arb, mm, flow, loops } ; loops resolve when the bot stops.
 */
export function startComponents(bot, { only, arbEvery, mmEvery, crossEvery, flowWarmupMs = 12_000 } = {}) {
  const s = bot.settings;
  const enabled = new Set((only ?? s.only).split(',').map((x) => x.trim()));
  const arb = new Arb(bot);
  const mm = new MarketMaker(bot);
  const flow = new Flow(bot);
  bot.components = { arb, mm, flow };
  const loops = [];
  if (enabled.has('mm')) loops.push(startLoop(bot, 'mm', () => mm.tick(), () => jitter((mmEvery ?? s.mmIntervalSec) * 1000, 0.25)));
  if (enabled.has('arb')) loops.push(startLoop(bot, 'arb', () => arb.tick(), () => jitter((arbEvery ?? s.arbIntervalSec) * 1000, 0.2)));
  if (enabled.has('flow')) {
    let first = true;
    loops.push(
      startLoop(
        bot,
        'flow',
        async () => {
          if (first) {
            first = false;
            await bot.sleep(flowWarmupMs); // let mm_a post its quotes first
          }
          if (s.flowMode === 'live') return flow.liveTick();
          await flow.tick();
          await flow.rebalance();
        },
        () => (s.flowMode === 'live' ? flow.liveDelayMs() : flow.nextDelayMs()),
      ),
    );
  }
  let poolmm = null;
  let cross = null;
  if (bot.poolAdapter) {
    poolmm = new PoolMM(bot, bot.poolAdapter);
    cross = new CrossArb(bot, bot.poolAdapter);
    bot.components.poolmm = poolmm;
    bot.components.cross = cross;
    if (enabled.has('poolmm')) loops.push(startLoop(bot, 'poolmm', () => poolmm.tick(), () => jitter(s.poolMmIntervalSec * 1000, 0.2)));
    if (enabled.has('cross')) loops.push(startLoop(bot, 'cross', () => cross.tick(), () => jitter((crossEvery ?? s.crossIntervalSec) * 1000, 0.2)));
  }
  const extra = (bot.extraPools ?? []).map((a) => new PoolMM(bot, a, { primary: false }));
  if (enabled.has('poolmm')) extra.forEach((pm, i) => loops.push(startLoop(bot, `poolx${i}`, () => pm.tick(), () => jitter(s.poolMmIntervalSec * 2000, 0.2))));
  if (s.liq) {
    const guard = new LiquidityGuard(bot, { mm, pools: [...(poolmm ? [poolmm] : []), ...extra] });
    bot.components.guard = guard;
    loops.push(startLoop(bot, 'liq', () => guard.tick(), () => jitter(s.liqIntervalSec * 1000, 0.1)));
  }
  loops.push(watchdog(bot));
  return { arb, mm, flow, poolmm, cross, loops };
}

/** Every 30 s: refresh balances (XLM guard), persist the NAV state; enforces --duration. */
export function watchdog(bot) {
  return (async () => {
    let n = 0;
    while (!bot.stopping) {
      await bot.sleep(5_000);
      if (bot.stopping) break;
      const s = bot.settings;
      if (s.duration && bot.stats.elapsedSec() >= s.duration) {
        bot.stop(`--duration ${s.duration}s reached`);
        break;
      }
      n += 5;
      if (n % 30 === 0) {
        try {
          await bot.refreshAll();
          for (const label of Object.keys(bot.acct)) bot.chain.guardXlm(label);
          bot.saveNavState();
        } catch (e) {
          if (e instanceof StopBot) bot.stop(e.message);
          else bot.log.warn('watchdog', firstLine(e));
        }
      }
    }
  })();
}
