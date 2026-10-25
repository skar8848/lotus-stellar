// The Bot object: one per process, shared by every component (arb, mm, flow, scenarios).

import { Chain, StopBot } from './chain.mjs';
import { NavModel } from './nav.mjs';
import { Stats, interruptibleSleep } from './limiter.mjs';
import { loadBotJson, saveBotJson } from './env.mjs';
import { short } from './log.mjs';
import { setReceiptCode } from './names.mjs';

export class Bot {
  constructor({ env, settings, log }) {
    this.env = env;
    this.settings = settings;
    this.log = log;
    this.stats = new Stats();
    this.ctx = env.ctx;
    this.passphrase = env.ctx.passphrase;
    this.contractId = env.contractId;
    this.readerPub = env.readerPub;
    this.assets = { usdc: env.usdc, lusdc: env.lusdc, lbond: env.lbond };
    setReceiptCode(env.lusdc.getCode());
    this.acct = Object.fromEntries(Object.entries(env.keys).map(([label, kp]) => [label, { label, kp, pub: kp.publicKey() }]));
    this.balances = {}; // label -> snapshot from chain.refreshBalances
    this.startBalances = {};
    this.stopping = false;
    this.stopReason = null;
    this.paused = { arb: false, mm: false, flow: false, pool: false };
    this.mmState = { offers: null, at: 0 }; // last view of mm_a's own offers, shared with the flow generator
    this.chain = new Chain(this);

    const saved = loadBotJson().state ?? {};
    const nav0 = settings.navStart > 0 ? settings.navStart : saved.nav > 0 ? saved.nav : 1;
    this.nav = new NavModel({
      nav0,
      aprPct: settings.navApr,
      noiseBps: settings.navNoiseBps,
      halfLifeSec: settings.navHalfLifeSec,
      timeScale: settings.timeScale,
    });
    this.navStart = nav0;
    this.arbLedger = []; // filled by Arb
    this.poolAdapter = null; // set by the pool leg when enabled
  }

  /** Display name for an address: bot/demo role if known, else short form. */
  who(pub) {
    return this.env.roleOf(pub) ?? short(pub, 4);
  }

  stop(reason) {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    this.log.warn('bot', `stopping: ${reason}`);
  }

  sleep(ms) {
    return interruptibleSleep(ms, this);
  }

  async refreshAll() {
    for (const label of Object.keys(this.acct)) await this.chain.refreshBalances(label);
  }

  /** Initial balance snapshot + XLM guard. Throws StopBot when an account is too low to start. */
  async init() {
    await this.refreshAll();
    for (const [label, b] of Object.entries(this.balances)) {
      this.startBalances[label] = { ...b };
      if (b.xlm < this.settings.minXlm) {
        throw new StopBot(`${label} holds ${b.xlm.toFixed(2)} XLM, below the --min-xlm guard of ${this.settings.minXlm}`);
      }
    }
  }

  /**
   * Feature flag for the Lotus range pool. --pool off: never. auto (default): use the live LBOND/USDC pool of
   * deployments/testnet.pool.json when there is one and it matches the ABI, otherwise carry on without it.
   * on: the same, but a missing or mismatching pool is an error.
   */
  async initPool() {
    const s = this.settings;
    if (s.pool === 'off') return null;
    const { PoolAdapter, loadPoolEntry } = await import('./pool.mjs');
    const entry = loadPoolEntry({ id: s.poolId || undefined });
    if (!entry) {
      if (s.pool === 'on') throw new Error('--pool on, but deployments/testnet.pool.json has no live LBOND/USDC pool');
      this.log.info('pool', 'no live LBOND/USDC pool in deployments/testnet.pool.json: pool legs disabled');
      return null;
    }
    const adapter = new PoolAdapter(this, entry);
    try {
      const info = await adapter.init();
      this.poolAdapter = adapter;
      this.log.info('pool', `using pool ${entry.id} ${entry.contract} (ABI ${info.abi}, bin step ${info.step} bps, fee ${info.fee} bps)`);
      return adapter;
    } catch (e) {
      if (s.pool === 'on') throw e;
      this.log.warn('pool', `pool legs disabled: ${firstLine(e)}`);
      return null;
    }
  }

  saveNavState() {
    if (this.nav.timeScale > 1) return; // an accelerated (demo) run must not ratchet the saved NAV
    try {
      const snap = this.nav.snapshot();
      saveBotJson({ state: { nav: Number(snap.nav.toFixed(10)), nav_at: new Date().toISOString() } });
    } catch {
      /* never fatal */
    }
  }
}

/**
 * Run `fn` repeatedly until the bot stops. `intervalFn()` returns the sleep (ms) before the next call.
 * Errors are logged and counted, never fatal, except StopBot (guards). After 5 consecutive failures the
 * loop backs off for 30 s.
 */
export function startLoop(bot, name, fn, intervalFn) {
  return (async () => {
    let consecutive = 0;
    while (!bot.stopping) {
      if (!bot.paused[name]) {
        try {
          await fn();
          bot.stats.tick(name, true);
          consecutive = 0;
        } catch (e) {
          if (e instanceof StopBot) {
            if (e.message !== 'stopping') bot.stop(e.message);
            break;
          }
          bot.stats.tick(name, false);
          consecutive += 1;
          bot.log.err(name, firstLine(e));
          if (consecutive >= 5) {
            bot.log.warn(name, `${consecutive} consecutive failures: pausing this component for 30s`);
            await bot.sleep(30_000);
            consecutive = 0;
          }
        }
      }
      await bot.sleep(intervalFn());
    }
  })();
}

export function firstLine(e) {
  const m = e?.message ?? String(e);
  return m.split('\n')[0].slice(0, 300);
}
