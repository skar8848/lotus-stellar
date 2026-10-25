// Chain access for the bot: rate-limited Horizon reads, Soroban simulations, transaction submission
// with a local sequence cache, per-account serialization, 429 back-off, operation caps, the XLM
// guard and --dry-run. Existing helpers from scripts/lib/stellar.mjs are reused, not modified.

import { Account, Contract, Memo, TransactionBuilder, rpc, scValToNative } from '@stellar/stellar-sdk';
import {
  SorobanError,
  balanceLine,
  diagnosticsToText,
  explainHorizonError,
  horizonErrorCodes,
  invokeContract,
  xdr,
} from '../../lib/stellar.mjs';
import { parseBook } from './book.mjs';
import { Gate, OpsCap, interruptibleSleep, sleep } from './limiter.mjs';
import { txUrl } from './log.mjs';

export class StopBot extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'StopBot';
  }
}

export class TxError extends Error {
  constructor(message, { txCode, opCodes = [], hash, retriable = false } = {}) {
    super(message);
    this.name = 'TxError';
    this.txCode = txCode;
    this.opCodes = opCodes;
    this.hash = hash;
    this.retriable = retriable;
  }
}

const assetKey = (a) => (a.isNative() ? 'XLM' : `${a.getCode()}:${a.getIssuer()}`);

function httpStatus(e) {
  return e?.response?.status ?? e?.status ?? e?.statusCode ?? null;
}
function retryAfterMs(e) {
  const h = e?.response?.headers;
  const v = h?.['retry-after'] ?? h?.get?.('retry-after');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n * 1000, 60_000) : null;
}
function isNetworkError(e) {
  const code = e?.code ?? e?.cause?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'ECONNABORTED'].includes(code) || /network|timeout|socket hang up|fetch failed/i.test(e?.message ?? '');
}
const is429 = (e) => httpStatus(e) === 429 || /\b429\b|too many requests|rate.?limit/i.test(e?.message ?? '');

export class Chain {
  constructor(bot) {
    this.bot = bot;
    const s = bot.settings;
    this.hGate = new Gate('horizon', { perMin: s.httpPerMin, burst: 10 });
    this.rGate = new Gate('rpc', { perMin: s.rpcPerMin, burst: 10 });
    this.cap = new OpsCap({ maxTx: s.maxTxPerMin, maxOps: s.maxOpsPerMin });
    this.seq = new Map(); // pub -> Account with the next sequence number
    this.books = new Map();
    this.viewsCache = null;
    this.readerAccounts = new Map();
    this.locks = new Map();
  }

  // ----------------------------------------------------------------- plumbing

  async withLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    this.locks.set(key, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async guarded(kind, gate, what, fn) {
    const { stats, log } = this.bot;
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      await gate.take();
      if (kind === 'horizon') stats.http++;
      else stats.rpc++;
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (is429(e)) {
          const wait = retryAfterMs(e) ?? 4000 * 2 ** attempt;
          stats.rateLimited++;
          stats.backoffMs += wait;
          gate.penalize(wait);
          log.warn('limits', `${kind} answered 429 on ${what}: all ${kind} calls paused for ${(wait / 1000).toFixed(1)}s (incident #${stats.rateLimited})`);
          continue;
        }
        const st = httpStatus(e);
        if ((st && st >= 500) || isNetworkError(e)) {
          stats.httpErrors++;
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  hread(what, fn) {
    return this.guarded('horizon', this.hGate, what, fn);
  }
  rread(what, fn) {
    return this.guarded('rpc', this.rGate, what, fn);
  }

  // ------------------------------------------------------------------- reads

  /** Order book (cached for maxAgeMs; concurrent callers share one request). */
  orderBook(selling, buying, { maxAgeMs = 2500, limit = 20 } = {}) {
    const key = `${assetKey(selling)}>${assetKey(buying)}`;
    const c = this.books.get(key);
    if (c && Date.now() - c.at < maxAgeMs) return c.promise;
    const promise = this.hread('order_book', async () =>
      parseBook(await this.bot.ctx.horizon.orderbook(selling, buying).limit(limit).call()),
    );
    this.books.set(key, { at: Date.now(), promise });
    promise.catch(() => this.books.delete(key));
    return promise;
  }
  invalidateBooks() {
    this.books.clear();
  }

  async accountOffers(pub) {
    const page = await this.hread('offers', () => this.bot.ctx.horizon.offers().forAccount(pub).limit(200).call());
    return page.records;
  }

  async recentTrades(base, counter, limit = 10) {
    const page = await this.hread('trades', () =>
      this.bot.ctx.horizon.trades().forAssetPair(base, counter).order('desc').limit(limit).call(),
    );
    return page.records;
  }

  /** Refresh and return the balances of a bot account (numbers + raw strings). */
  async refreshBalances(label) {
    const { acct, assets } = this.bot;
    const acc = await this.hread('account', () => this.bot.ctx.horizon.loadAccount(acct[label].pub));
    const line = (a) => balanceLine(acc, a);
    const num = (a) => Number(line(a)?.balance ?? 0);
    const snap = {
      xlm: Number(acc.balances.find((b) => b.asset_type === 'native')?.balance ?? 0),
      usdc: num(assets.usdc),
      lusdc: num(assets.lusdc),
      lbond: num(assets.lbond),
      usdcRaw: line(assets.usdc)?.balance ?? '0.0000000',
      lusdcRaw: line(assets.lusdc)?.balance ?? '0.0000000',
      lbondRaw: line(assets.lbond)?.balance ?? '0.0000000',
      lusdcSelling: Number(line(assets.lusdc)?.selling_liabilities ?? 0),
      usdcSelling: Number(line(assets.usdc)?.selling_liabilities ?? 0),
      lbondSelling: Number(line(assets.lbond)?.selling_liabilities ?? 0),
      at: Date.now(),
    };
    this.bot.balances[label] = snap;
    return snap;
  }

  /** Light read-only contract call: simulate with a throwaway Account object (no sequence needed). */
  async simulate({ method, args = [], contractId }) {
    const { ctx, passphrase, readerPub } = this.bot;
    const tx = new TransactionBuilder(new Account(readerPub, '0'), { fee: '100', networkPassphrase: passphrase })
      .addOperation(new Contract(contractId ?? this.bot.contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await this.rread(`simulate ${method}`, () => ctx.rpcServer.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) {
      throw new SorobanError(`simulation of ${method}() failed: ${sim.error}`, { diagnostics: diagnosticsToText(sim.events) });
    }
    return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
  }

  /** Simulate a state-changing call as `label` (to see the return value before paying a fee). */
  async simulateAs(label, { method, args, contractId: cid }) {
    const { ctx, passphrase, acct } = this.bot;
    const contractId = cid ?? this.bot.contractId;
    let account = this.readerAccounts.get(label);
    if (!account) {
      account = await this.rread('getAccount', () => ctx.rpcServer.getAccount(acct[label].pub));
      this.readerAccounts.set(label, account);
    }
    const tx = new TransactionBuilder(new Account(acct[label].pub, account.sequenceNumber()), { fee: '100', networkPassphrase: passphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await this.rread(`simulate ${method}`, () => ctx.rpcServer.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) {
      throw new SorobanError(`simulation of ${method}() failed: ${sim.error}`, { diagnostics: diagnosticsToText(sim.events) });
    }
    return sim.result?.retval ? scValToNative(sim.result.retval) : undefined;
  }

  /** vault_value() and supply() in stroops (BigInt), cached for maxAgeMs. */
  async views({ maxAgeMs = 2500 } = {}) {
    if (this.viewsCache && Date.now() - this.viewsCache.at < maxAgeMs) return this.viewsCache;
    const [vv, sp] = await Promise.all([this.simulate({ method: 'vault_value' }), this.simulate({ method: 'supply' })]);
    this.viewsCache = { vaultValue: BigInt(vv), supply: BigInt(sp), at: Date.now() };
    return this.viewsCache;
  }

  // -------------------------------------------------------------- write guards

  /** Wait until the per-minute caps allow `ops` more operations; throws when the bot is stopping. */
  async reserve(ops) {
    for (;;) {
      if (this.bot.stopping) throw new StopBot('stopping');
      const w = this.cap.waitMs(ops);
      if (w <= 0) break;
      const u = this.cap.usage();
      this.bot.log.info('limits', `cap reached (${u.tx} tx / ${u.ops} ops in the last minute): waiting ${(w / 1000).toFixed(1)}s`);
      await interruptibleSleep(Math.min(w, 5000), this.bot);
    }
    this.cap.record(ops);
  }

  guardXlm(label) {
    const b = this.bot.balances[label];
    const min = this.bot.settings.minXlm;
    if (b && b.xlm < min) throw new StopBot(`${label} holds ${b.xlm.toFixed(2)} XLM, below the --min-xlm guard of ${min}`);
  }

  chargeFee(label, stroops) {
    if (stroops == null) return;
    this.bot.stats.addFee(label, stroops);
    const b = this.bot.balances[label];
    if (b) b.xlm -= Number(stroops) / 1e7;
  }

  // -------------------------------------------------------------- classic submit

  async nextAccount(label) {
    const { acct, ctx } = this.bot;
    let a = this.seq.get(acct[label].pub);
    if (!a) {
      const loaded = await this.hread('account', () => ctx.horizon.loadAccount(acct[label].pub));
      a = new Account(acct[label].pub, loaded.sequenceNumber());
      this.seq.set(acct[label].pub, a);
    }
    return a;
  }

  async waitForTx(hash, timeoutMs = 25_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const r = await this.hread('tx lookup', () => this.bot.ctx.horizon.transactions().transaction(hash).call());
        return r;
      } catch (e) {
        if (httpStatus(e) !== 404) throw e;
      }
      await sleep(2000);
    }
    return null;
  }

  /**
   * Build, sign and submit a classic transaction signed by bot account `label`.
   * Returns { hash, link, result (xdr.TransactionResult), feeCharged, response } or { dryRun: true }.
   * Throws TxError for failures (op/tx result codes attached) and StopBot for guard trips.
   */
  async submit({ label, ops, memo, fee = '1000', kind = 'classic' }) {
    const { stats, acct, passphrase, settings, ctx } = this.bot;
    if (settings.dryRun) {
      stats.txSkipped++;
      return { dryRun: true };
    }
    this.guardXlm(label);
    await this.reserve(ops.length);
    return this.withLock(acct[label].pub, async () => {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        const account = await this.nextAccount(label);
        const builder = new TransactionBuilder(account, { fee, networkPassphrase: passphrase });
        for (const op of ops) builder.addOperation(op);
        if (memo) builder.addMemo(memoText(memo));
        const tx = builder.setTimeout(60).build();
        tx.sign(acct[label].kp);
        const hash = Buffer.from(tx.hash()).toString('hex');
        try {
          const response = await this.hread('submit', () => ctx.horizon.submitTransaction(tx, { skipMemoRequiredCheck: true }));
          return this.finish(label, kind, hash, response.result_xdr, response.fee_charged ?? response.fee_paid, response);
        } catch (e) {
          lastErr = e;
          const codes = horizonErrorCodes(e);
          const st = httpStatus(e);
          this.seq.delete(acct[label].pub); // sequence may be out of sync, reload next time
          if (codes?.transaction === 'tx_bad_seq') {
            await sleep(600);
            continue;
          }
          if (st === 504 || st === 503 || isNetworkError(e)) {
            const found = await this.waitForTx(hash);
            if (found) return this.finish(label, kind, hash, found.result_xdr, found.fee_charged, found);
            continue;
          }
          if (codes?.transaction === 'tx_insufficient_fee' || codes?.transaction === 'tx_too_late') {
            await sleep(1500);
            continue;
          }
          stats.txFail++;
          // a tx_failed tx IS in a ledger (fee charged); a rejected one is not
          const opCodes = codes?.operations ?? [];
          stats.error(`tx:${opCodes.find((c) => c !== 'op_success') ?? codes?.transaction ?? 'unknown'}`);
          throw new TxError(explainHorizonError(e), { txCode: codes?.transaction, opCodes, hash });
        }
      }
      stats.txFail++;
      stats.error('tx:retries_exhausted');
      throw new TxError(`submit failed after retries: ${explainHorizonError(lastErr)}`, { hash: undefined });
    });
  }

  finish(label, kind, hash, resultXdr, feeCharged, response) {
    const { stats } = this.bot;
    const result = resultXdr ? xdr.TransactionResult.fromXdr(resultXdr, 'base64') : null;
    stats.txOk++;
    stats.ops += response?.operation_count ?? 1;
    stats.recordTx(label, kind, hash);
    const fee = feeCharged != null ? BigInt(feeCharged) : null;
    this.chargeFee(label, fee);
    this.invalidateBooks();
    return { hash, link: txUrl(hash), result, feeCharged: fee, response };
  }

  // ------------------------------------------------------------- Soroban invoke

  /** deposit/redeem and friends, signed by bot account `label`. Wraps scripts/lib invokeContract. */
  async invoke({ label, method, args, contractId: cid }) {
    const { stats, acct, ctx, settings } = this.bot;
    const contractId = cid ?? this.bot.contractId;
    if (settings.dryRun) {
      stats.txSkipped++;
      return { dryRun: true };
    }
    this.guardXlm(label);
    await this.reserve(1);
    return this.withLock(acct[label].pub, async () => {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.rGate.take();
        stats.rpc += 5; // getAccount + simulate(s) + send + polls: coarse accounting
        try {
          const res = await invokeContract(ctx, { contractId, method, args, source: acct[label].kp, label: `${method}(${label})` });
          this.seq.delete(acct[label].pub); // the Soroban tx consumed a sequence number
          this.readerAccounts.delete(label);
          stats.txOk++;
          stats.ops += 1;
          stats.recordTx(label, `soroban:${method}`, res.hash);
          this.chargeFee(label, res.feeCharged);
          this.viewsCache = null;
          this.invalidateBooks();
          return res;
        } catch (e) {
          lastErr = e;
          this.seq.delete(acct[label].pub);
          const msg = e?.message ?? '';
          if (/bad[_ ]?seq/i.test(msg)) {
            await sleep(1200);
            continue;
          }
          if (is429(e)) {
            stats.rateLimited++;
            this.rGate.penalize(5000 * 2 ** attempt);
            this.bot.log.warn('limits', `rpc answered 429 on ${method}: pausing rpc calls`);
            continue;
          }
          if (/simulation/i.test(msg)) stats.error(`sim:${method}`);
          else {
            stats.txFail++;
            stats.error(`soroban:${method}`);
          }
          throw e;
        }
      }
      stats.txFail++;
      stats.error(`soroban:${method}:retries`);
      throw lastErr;
    });
  }
}

function memoText(text) {
  return Memo.text(String(text).slice(0, 28));
}
