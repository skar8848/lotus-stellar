// Rate limiting, operation caps, back-off and run statistics shared by every bot component.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (ms, frac = 0.2) => ms * (1 + (Math.random() * 2 - 1) * frac);

/** Sleep that wakes early when `signal.stopped` flips (cheap polling every 250 ms). */
export async function interruptibleSleep(ms, state) {
  const end = Date.now() + ms;
  while (Date.now() < end && !state.stopping) await sleep(Math.max(1, Math.min(250, end - Date.now())));
}

/**
 * Token bucket: `perMin` requests per minute on average, bursts up to `burst`.
 * penalize(ms) blocks every taker for ms (used after a 429).
 */
export class Gate {
  constructor(name, { perMin, burst = 8 }) {
    this.name = name;
    this.perMin = perMin;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
    this.blockedUntil = 0;
  }
  refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60000) * this.perMin);
    this.last = now;
  }
  async take() {
    for (;;) {
      const now = Date.now();
      if (now < this.blockedUntil) {
        await sleep(this.blockedUntil - now);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.max(20, ((1 - this.tokens) / this.perMin) * 60000));
    }
  }
  penalize(ms) {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
    this.tokens = 0;
  }
}

/** Sliding one-minute window counting transactions and operations. */
export class OpsCap {
  constructor({ maxTx, maxOps }) {
    this.maxTx = maxTx;
    this.maxOps = maxOps;
    this.events = []; // {t, ops}
  }
  prune() {
    const cutoff = Date.now() - 60_000;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
  }
  usage() {
    this.prune();
    return { tx: this.events.length, ops: this.events.reduce((s, e) => s + e.ops, 0) };
  }
  /** ms to wait before `ops` more operations fit in the window (0 = now). */
  waitMs(ops) {
    this.prune();
    const u = this.usage();
    if (u.tx + 1 <= this.maxTx && u.ops + ops <= this.maxOps) return 0;
    // find when enough old events expire
    let tx = u.tx;
    let o = u.ops;
    for (const e of this.events) {
      tx -= 1;
      o -= e.ops;
      if (tx + 1 <= this.maxTx && o + ops <= this.maxOps) return Math.max(0, e.t + 60_000 - Date.now()) + 50;
    }
    return 60_000;
  }
  record(ops) {
    this.events.push({ t: Date.now(), ops });
  }
}

/** Counters reported at the end of a run. */
export class Stats {
  constructor() {
    this.startedAt = Date.now();
    this.http = 0; // Horizon requests
    this.rpc = 0; // Soroban RPC requests
    this.rateLimited = 0; // HTTP 429 received
    this.backoffMs = 0;
    this.httpErrors = 0; // 5xx / network errors that were retried
    this.txOk = 0;
    this.txFail = 0; // submitted but failed (op error, bad seq after retries, ...)
    this.txSkipped = 0; // dropped by caps / dry-run
    this.ops = 0;
    this.feeStroops = new Map(); // account label -> BigInt stroops
    this.fills = 0; // claim atoms (resting offers consumed) in our own taker txs
    this.volumeLusdc = 0; // fill volume denominated in lUSDC/USDC (bond fills valued in lUSDC)
    this.flowTrades = 0;
    this.errors = new Map(); // key -> count
    this.ticks = new Map(); // component -> {ok, err}
    this.txs = []; // {label, kind, hash, at}
  }
  addFee(label, stroops) {
    if (stroops == null) return;
    this.feeStroops.set(label, (this.feeStroops.get(label) ?? 0n) + BigInt(stroops));
  }
  totalFee() {
    let t = 0n;
    for (const v of this.feeStroops.values()) t += v;
    return t;
  }
  tick(component, ok) {
    const t = this.ticks.get(component) ?? { ok: 0, err: 0 };
    if (ok) t.ok += 1;
    else t.err += 1;
    this.ticks.set(component, t);
  }
  error(key) {
    this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
  }
  recordTx(label, kind, hash) {
    this.txs.push({ label, kind, hash, at: new Date().toISOString() });
  }
  elapsedSec() {
    return (Date.now() - this.startedAt) / 1000;
  }
}
