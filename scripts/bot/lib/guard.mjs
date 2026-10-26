// Liquidity guard (bot:live): both sides of every book are always quoted.
//
// Every --liq-interval-sec (60 s) it measures, from the public order books and pool positions:
//   LBOND/USDC and LBOND/receipt   LBOND within --liq-band-pct (1%) of fair value, each side   >= --liq-bond-min (200)
//   receipt/USDC                   receipt within --liq-peg-band-bps (10 bps) of par, each side >= --liq-peg-min (500)
//   each Lotus pool mm_a quotes    an Ask and a Bid position with inventory, first bin within --liq-band-pct of fair
// and logs one line. When a side is short it finds out why and fixes it, in this order:
//   * mm_a lacks LBOND        -> rwa_issuer issues LBOND to mm_a (authorized trustline)
//   * mm_a lacks USDC         -> from the treasury account blocked_taker while it keeps >= --liq-treasury-keep (3,000)
//                                for the app faucet, else one Blend faucet round through a fresh account (lib/topup.mjs)
//   * mm_a lacks the receipt  -> lotus_vault.deposit() with mm_a's USDC (minted 1:1)
//   then it resets mm_a's quote sizes and re-quotes the books and re-posts the pool positions at once.
// It never cancels or modifies an offer that is not the bot's.

import { Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { addr, balanceLine, i128, toStroops } from '../../lib/stellar.mjs';
import { loadSecrets } from '../../lib/config.mjs';
import { firstLine } from './bot.mjs';
import { loadBotJson } from './env.mjs';
import { faucetTopUp, recordTopUp } from './topup.mjs';
import { RC } from './names.mjs';

const sum = (levels, ok) => levels.filter((l) => ok(l.price)).reduce((x, l) => x + l.amount, 0);

export class LiquidityGuard {
  constructor(bot, { mm, pools = [] }) {
    this.bot = bot;
    this.mm = mm;
    this.pools = pools; // PoolMM instances (primary + extra pools)
    this.checks = 0;
    this.shortChecks = 0;
    this.actions = 0;
  }

  /** What mm_a's full quote set needs (sizes at scale 1), in LBOND, USDC and receipt. */
  needs() {
    const s = this.bot.settings;
    const fair = this.bot.nav.snapshot().fair;
    const poolLbond = this.pools.length * s.poolAskSize;
    const poolUsdc = this.pools.length * s.poolBidSize;
    return {
      lbond: s.levels * s.levelSize + (s.usdcBook === 'on' ? s.usdcLevels * s.usdcLevelSize : 0) + poolLbond,
      usdc: s.pegSize + (s.usdcBook === 'on' ? s.usdcLevels * s.usdcLevelSize * fair : 0) + poolUsdc,
      lusdc: s.levels * s.levelSize * fair + s.pegSize,
    };
  }

  async measure() {
    const { chain, assets, settings: s } = this.bot;
    chain.invalidateBooks();
    const [usdcBook, bondBook, pegBook] = await Promise.all([
      chain.orderBook(assets.lbond, assets.usdc, { maxAgeMs: 0 }),
      chain.orderBook(assets.lbond, assets.lusdc, { maxAgeMs: 0 }),
      chain.orderBook(assets.lusdc, assets.usdc, { maxAgeMs: 0 }),
    ]);
    const fair = this.bot.nav.snapshot().fair;
    const bondFair = fair / this.bot.peg.snapshot().mid;
    const b = s.liqBandPct / 100;
    const pb = s.liqPegBandBps / 1e4;
    const m = {
      usdc: { bid: sum(usdcBook.bids, (p) => p >= fair * (1 - b)), ask: sum(usdcBook.asks, (p) => p <= fair * (1 + b)), min: s.liqBondMin },
      bond: { bid: sum(bondBook.bids, (p) => p >= bondFair * (1 - b)), ask: sum(bondBook.asks, (p) => p <= bondFair * (1 + b)), min: s.liqBondMin },
      peg: { bid: sum(pegBook.bids, (p) => p >= 1 - pb), ask: sum(pegBook.asks, (p) => p <= 1 + pb), min: s.liqPegMin },
    };
    if (s.usdcBook !== 'on') delete m.usdc;
    const pools = [];
    for (const pm of this.pools) {
      const mine = pm.st().mine;
      const ask = mine?.Ask;
      const bid = mine?.Bid;
      const askOk = Boolean(ask && ask.inventory > 0n && pm.pool.priceAt(ask.lo) <= fair * (1 + b));
      const bidOk = Boolean(bid && bid.inventory > 0n && pm.pool.priceAt(bid.hi) >= fair * (1 - b));
      pools.push({ pm, id: pm.pool.label, askOk, bidOk });
    }
    return { m, pools, fair };
  }

  async tick() {
    const { bot } = this;
    const { log, chain } = bot;
    const { m, pools, fair } = await this.measure();
    this.checks += 1;
    const names = { usdc: 'LBOND/USDC', bond: `LBOND/${RC}`, peg: `${RC}/USDC` };
    const short = [];
    const parts = Object.entries(m).map(([k, v]) => {
      if (v.bid < v.min) short.push(`${names[k]} bid`);
      if (v.ask < v.min) short.push(`${names[k]} ask`);
      return `${names[k]} bid ${v.bid.toFixed(0)} ask ${v.ask.toFixed(0)} (min ${v.min})`;
    });
    for (const p of pools) {
      if (!p.askOk) short.push(`pool ${p.id} ask`);
      if (!p.bidOk) short.push(`pool ${p.id} bid`);
      parts.push(`pool ${p.id} ask ${p.askOk ? 'ok' : 'MISSING'} bid ${p.bidOk ? 'ok' : 'MISSING'}`);
    }
    log.info('liq', `check: ${parts.join(' | ')} | fair ${fair.toFixed(5)}${short.length ? ` | SHORT: ${short.join(', ')}` : ''}`);
    if (!short.length || bot.settings.dryRun) return;
    this.shortChecks += 1;

    // 1. inventory: make sure mm_a can fund the full quote set (x1.15), minting/fetching what is missing
    const bal = await chain.refreshBalances('mm_a');
    const need = this.needs();
    const want = { lbond: need.lbond * 1.15, usdc: need.usdc * 1.15, lusdc: need.lusdc * 1.15 };
    if (bal.lbond < want.lbond) await this.issueLbond(Math.max(5000, Math.ceil(want.lbond * 2 - bal.lbond)));
    const rcGap = Math.max(0, want.lusdc - bal.lusdc);
    const usdcGap = Math.max(0, want.usdc + rcGap - bal.usdc);
    if (usdcGap > 1) await this.getUsdc(Math.ceil(usdcGap + 100));
    if (rcGap > 1) {
      const b2 = await chain.refreshBalances('mm_a');
      const mint = Math.min(Math.ceil(rcGap + 50), Math.floor(b2.usdc - need.usdc));
      if (mint >= 1) await this.deposit(mint);
      else log.warn('liq', `mm_a needs ${rcGap.toFixed(0)} more ${RC} but has no spare USDC to mint it yet`);
    }
    await chain.refreshBalances('mm_a');

    // 2. re-quote at full size now, and re-post missing / stale pool positions
    this.mm.sizeScale = 1;
    try {
      await this.mm.tick();
    } catch (e) {
      log.warn('liq', `re-quote after the check failed: ${firstLine(e)}`);
    }
    for (const p of pools.filter((x) => !x.askOk || !x.bidOk)) {
      try {
        await p.pm.tick();
      } catch (e) {
        log.warn('liq', `pool ${p.id} re-post failed: ${firstLine(e)}`);
      }
    }
  }

  // ---------------------------------------------------------------- inventory sources

  async submitAs(kp, ops) {
    const { ctx } = this.bot;
    const acc = await ctx.horizon.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(acc, { fee: '1000', networkPassphrase: ctx.passphrase });
    for (const op of ops) tx.addOperation(op);
    const built = tx.setTimeout(60).build();
    built.sign(kp);
    const r = await ctx.horizon.submitTransaction(built, { skipMemoRequiredCheck: true });
    return r.hash;
  }

  async issueLbond(amount) {
    const { bot } = this;
    const sec = loadSecrets().rwa_issuer;
    if (!sec) return bot.log.warn('liq', 'mm_a is short of LBOND but the rwa_issuer secret is not available');
    try {
      const hash = await this.submitAs(Keypair.fromSecret(sec), [Operation.payment({ destination: bot.acct.mm_a.pub, asset: bot.assets.lbond, amount: String(amount) })]);
      this.actions += 1;
      bot.log.act('liq', `TOP-UP rwa_issuer issued ${amount} LBOND to mm_a (simulated bond, team-issued)`, hash);
    } catch (e) {
      bot.log.warn('liq', `LBOND issue failed: ${firstLine(e)}`);
    }
  }

  async getUsdc(amount) {
    const { bot } = this;
    const s = bot.settings;
    const sec = loadSecrets().blocked_taker;
    if (sec) {
      try {
        const kp = Keypair.fromSecret(sec);
        const acc = await bot.ctx.horizon.loadAccount(kp.publicKey());
        const have = Number(balanceLine(acc, bot.assets.usdc)?.balance ?? 0);
        const spare = Math.floor(have - s.liqTreasuryKeep);
        const send = Math.min(spare, amount);
        if (send >= 50) {
          const hash = await this.submitAs(kp, [Operation.payment({ destination: bot.acct.mm_a.pub, asset: bot.assets.usdc, amount: String(send) })]);
          this.actions += 1;
          bot.log.act('liq', `TOP-UP treasury blocked_taker sent ${send} USDC to mm_a (keeps ${(have - send).toFixed(0)} >= ${s.liqTreasuryKeep} for the app faucet)`, hash);
          if (send >= amount) return;
          amount -= send;
        }
      } catch (e) {
        bot.log.warn('liq', `treasury USDC transfer failed: ${firstLine(e)}`);
      }
    }
    const recent = (loadBotJson().setup?.topups ?? []).filter((t) => Date.now() - Date.parse(t.at) < 86_400_000).length;
    if (recent >= s.liqTopupMax) return bot.log.warn('liq', `mm_a needs ${amount} USDC but ${recent} faucet top-ups already ran in 24 h (--liq-topup-max ${s.liqTopupMax})`);
    for (let left = amount; left > 0; left -= 1000) {
      try {
        const t = await faucetTopUp({ ctx: bot.ctx, usdc: bot.assets.usdc, toPub: bot.acct.mm_a.pub, log: (msg) => bot.log.info('liq', msg) });
        recordTopUp({ to: 'mm_a', amount: t.amount, via: t.from, txs: t.hashes, trigger: 'liquidity guard' });
        this.actions += 1;
        bot.log.act('liq', `TOP-UP mm_a received ${t.amount} USDC from the Blend testnet faucet via fresh account ${t.from}`, t.hashes.forward);
      } catch (e) {
        bot.log.warn('liq', `faucet top-up failed: ${firstLine(e)}`);
        return;
      }
    }
  }

  async deposit(amount) {
    const { bot } = this;
    try {
      const res = await bot.chain.invoke({ label: 'mm_a', method: 'deposit', args: [addr(bot.acct.mm_a.pub), i128(toStroops(String(amount)))] });
      this.actions += 1;
      bot.log.act('liq', `TOP-UP mm_a minted ${amount} ${RC} at par with lotus_vault.deposit()`, res.hash);
    } catch (e) {
      bot.log.warn('liq', `deposit failed: ${firstLine(e)}`);
    }
  }
}
