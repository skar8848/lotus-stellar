// The Bot object: one per process, shared by every component (arb, mm, flow, scenarios).

import { Chain, StopBot } from './chain.mjs';
import { FlatModel, PegModel, TreasuryModel, fetchDgs10 } from './nav.mjs';
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
    this.savedState = saved;
    // placeholder until initModel() (async: it may fetch the FRED reference yield)
    this.nav = this.makeModel({ nav0, yieldRefPct: settings.yieldRef > 0 ? settings.yieldRef : saved.yield_ref_pct ?? settings.yieldFallback, yieldPct: saved.yield_pct });
    this.navStart = nav0;
    this.yieldSource = saved.yield_ref_source ?? null;
    this.peg = new PegModel({ noiseBps: settings.pegNoiseBps, maxBps: settings.pegNoiseMaxBps, halfLifeSec: settings.pegNoiseHalfLifeSec });
    this.arbLedger = []; // filled by Arb
    this.poolAdapter = null; // set by the pool leg when enabled
  }

  /** Display name for an address: bot/demo role if known, else short form. */
  who(pub) {
    return this.env.roleOf(pub) ?? short(pub, 4);
  }

  makeModel({ nav0, yieldRefPct, yieldPct }) {
    const s = this.settings;
    if (s.navModel === 'flat') {
      return new FlatModel({ nav0, aprPct: s.navApr, noiseBps: s.navNoiseBps, halfLifeSec: s.navHalfLifeSec, timeScale: s.timeScale });
    }
    return new TreasuryModel({
      nav0,
      yieldRefPct,
      yieldPct,
      carryPct: s.carryPct,
      durationYrs: s.durationYrs,
      volBpDay: s.yieldVolBpDay,
      halfLifeDays: s.yieldHalfLifeDays,
      jumpsPerDay: s.yieldJumpsPerDay,
      jumpBp: s.yieldJumpBp,
      microBps: s.navNoiseBps,
      microHalfLifeSec: s.navHalfLifeSec,
      priceMin: s.priceMin,
      priceMax: s.priceMax,
      timeScale: s.timeScale,
    });
  }

  /**
   * Treasury model: pick the reference yield. Order: --yield-ref, the saved state (continuity across restarts),
   * the latest FRED DGS10 print, --yield-fallback. --yield-refresh refetches FRED and re-bases the NAV so the
   * price does not jump.
   */
  async initModel() {
    const s = this.settings;
    if (s.navModel === 'flat') return;
    const saved = this.savedState ?? {};
    const hasSaved = saved.model === 'tsy-10y' && saved.yield_ref_pct > 0 && s.navStart <= 0;
    let ref = null;
    if (s.yieldRef > 0) ref = { pct: s.yieldRef, source: '--yield-ref' };
    else if (hasSaved && !s.yieldRefresh) ref = { pct: saved.yield_ref_pct, source: saved.yield_ref_source ?? 'saved state', saved: true };
    else {
      const fred = await fetchDgs10();
      ref = fred ?? { pct: s.yieldFallback, source: `fallback ${s.yieldFallback}% (FRED DGS10 unreachable)` };
    }
    const nav0 = this.nav.nav;
    if (ref.saved) {
      this.nav = this.makeModel({ nav0, yieldRefPct: ref.pct, yieldPct: saved.yield_pct ?? ref.pct });
    } else {
      // a new reference: keep the current price (saved, or nav0) and start the yield at the reference
      const keepPrice = hasSaved && saved.price > 0 ? saved.price : nav0;
      this.nav = this.makeModel({ nav0: keepPrice, yieldRefPct: ref.pct, yieldPct: ref.pct });
    }
    this.yieldSource = ref.source;
    this.navStart = this.nav.snapshot().price;
  }

  /** One line describing the fair-value model (banner, README). */
  modelLine() {
    const s = this.settings;
    const f = this.nav.snapshot();
    if (this.nav.kind === 'flat') return `LBOND fair  flat model: NAV ${f.nav.toFixed(6)}, ${s.navApr}% APR, noise ${s.navNoiseBps} bps (simulation)`;
    return `LBOND fair  simulated 10Y: yield ${f.yieldPct.toFixed(3)}% (ref ${f.yieldRefPct.toFixed(3)}%, ${this.yieldSource}), vol ${s.yieldVolBpDay} bp/day, ${s.yieldJumpsPerDay} jumps/day ~${s.yieldJumpBp} bp, duration ${s.durationYrs}, price ${f.price.toFixed(5)} in [${s.priceMin}, ${s.priceMax}] (simulation, not market data)`;
  }

  stop(reason) {
    if (this.stopping) return;
    this.stopping = true;
    this.stopReason = reason;
    this.log.warn('bot', `stopping: ${reason}`);
  }

  /** A component swallowed a failure (logged it and carried on): count it like a thrown error for the loop's backoff. */
  softFail(name) {
    this.softFails ??= {};
    this.softFails[name] = (this.softFails[name] ?? 0) + 1;
  }

  sleep(ms) {
    return interruptibleSleep(ms, this);
  }

  async refreshAll() {
    for (const label of Object.keys(this.acct)) await this.chain.refreshBalances(label);
  }

  /** Initial balance snapshot + XLM guard. Throws StopBot when an account is too low to start. */
  async init() {
    await this.initModel();
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
      const what = s.poolId ? `no live LBOND/USDC pool with id "${s.poolId}" (retired instances are ignored)` : 'no live LBOND/USDC pool';
      if (s.pool === 'on') throw new Error(`--pool on, but deployments/testnet.pool.json has ${what}`);
      this.log.info('pool', `${what} in deployments/testnet.pool.json: pool legs disabled`);
      return null;
    }
    const adapter = new PoolAdapter(this, entry);
    try {
      const info = await adapter.init();
      this.poolAdapter = adapter;
      this.log.info('pool', `using pool ${entry.id} ${entry.contract} (ABI ${info.abi}, bin step ${info.step} bps, fee ${info.fee} bps)`);
      await this.warnRetiredPositions(entry.contract);
      await this.initExtraPools(entry.contract);
      return adapter;
    } catch (e) {
      if (s.pool === 'on') throw e;
      this.log.warn('pool', `pool legs disabled: ${firstLine(e)}`);
      return null;
    }
  }

  /** Extra live pools (--pool-extra-ids) where mm_a also keeps an Ask and a Bid position. */
  async initExtraPools(primaryContract) {
    const { PoolAdapter, loadPoolEntry } = await import('./pool.mjs');
    this.extraPools = [];
    for (const id of this.settings.poolExtraIds.split(',').map((x) => x.trim()).filter(Boolean)) {
      const entry = loadPoolEntry({ id });
      if (!entry || entry.contract === primaryContract) {
        this.log.warn('pool', `extra pool "${id}": not a live LBOND/USDC pool (or the primary one), skipped`);
        continue;
      }
      const a = new PoolAdapter(this, entry);
      try {
        await a.init();
        this.extraPools.push(a);
        this.log.info('pool', `extra pool ${entry.id} ${entry.contract}: mm_a keeps an Ask and a Bid position there too`);
      } catch (e) {
        this.log.warn('pool', `extra pool ${id} disabled: ${firstLine(e)}`);
      }
    }
  }

  /** Retired pool instances are never traded; say so when a bot account still has positions there (--cleanup closes them). */
  async warnRetiredPositions(liveContract) {
    try {
      const { PoolAdapter, loadRetiredPoolEntries } = await import('./pool.mjs');
      for (const entry of loadRetiredPoolEntries({ exceptContract: liveContract })) {
        const old = new PoolAdapter(this, entry);
        for (const label of Object.keys(this.acct)) {
          const ids = await old.positionsOf(this.acct[label].pub).catch(() => []);
          if (ids.length) this.log.warn('pool', `${label} still has ${ids.length} position(s) in RETIRED pool ${entry.id} ${entry.contract}: ignored while trading, closed by --cleanup`);
        }
      }
    } catch {
      /* informational only */
    }
  }

  saveNavState() {
    if (this.nav.timeScale > 1) return; // an accelerated (demo) run must not ratchet the saved NAV
    try {
      const st = this.nav.state();
      if (this.yieldSource) st.yield_ref_source = this.yieldSource;
      saveBotJson({ state: { ...st, nav_at: new Date().toISOString(), note: 'simulated LBOND fair value (see scripts/bot/lib/nav.mjs); not market data' } });
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
          const soft0 = bot.softFails?.[name] ?? 0;
          await fn();
          if ((bot.softFails?.[name] ?? 0) > soft0) {
            bot.stats.tick(name, false);
            consecutive += 1;
            if (consecutive >= 5) {
              bot.log.warn(name, `${consecutive} consecutive failures: pausing this component for 30s`);
              await bot.sleep(30_000);
              consecutive = 0;
            }
          } else {
            bot.stats.tick(name, true);
            consecutive = 0;
          }
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
