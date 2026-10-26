// Simulated fair values. This is a SIMULATION: there is no real bond and no oracle behind LBOND.
//
// TreasuryModel (default, --nav-model tsy): LBOND is priced like a 10-year US Treasury.
//   yield y(t)  Ornstein-Uhlenbeck around the reference yield y_ref (the latest FRED DGS10 print when it could be
//               fetched, else --yield-ref), daily volatility --yield-vol-bp-day (6.5 bp), half-life
//               --yield-half-life-days, plus Poisson jumps (--yield-jumps-per-day, size --yield-jump-bp)
//   nav(t)      carry accrual: nav *= exp(carry * dt / year), carry = the simulated yield (or --carry-pct)
//   price(t)    nav(t) - duration * (y(t) - y_ref)            (duration --duration-yrs, 7)
//   fair(t)     price(t) * (1 + micro(t)), micro = small OU noise (--nav-noise-bps, 1 bp, half-life 120 s)
// The price is kept inside [--price-min, --price-max] (0.96 .. 1.03) by reflecting the yield at the band edges.
// Diffusion runs in real time; --time-scale only accelerates the carry accrual (the demo scenario uses it).
//
// FlatModel (--nav-model flat): the previous model, NAV accruing at --nav-apr plus OU noise.
//
// PegModel: the receipt's USDC price. The receipt redeems 1:1 through lotus_vault and its yield is paid by minting,
// so its fair price is exactly 1 USDC; the model only adds a few bps of OU noise around par (never a drift), and the
// market maker keeps its quotes inside the arbitrageur's no-trade band.

const YEAR_SEC = 365 * 24 * 3600;
const DAY_SEC = 86_400;

export function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/** One exact OU step: x -> x*a + std*sqrt(1-a^2)*N(0,1), a = exp(-ln2 dt / halfLife). */
function ouStep(x, dt, halfLifeSec, stdStationary) {
  const a = Math.exp((-Math.LN2 * dt) / halfLifeSec);
  return x * a + stdStationary * Math.sqrt(Math.max(0, 1 - a * a)) * gauss();
}

/**
 * Latest 10-year Treasury constant-maturity yield (FRED series DGS10, percent). No API key needed.
 * Returns { pct, date, source } or null on any failure (offline, timeout, format change).
 */
export async function fetchDgs10({ timeoutMs = 6000 } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10', { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const rows = (await res.text()).trim().split('\n').slice(1);
    for (let i = rows.length - 1; i >= 0; i--) {
      const [date, v] = rows[i].split(',');
      const pct = Number(v);
      if (Number.isFinite(pct) && pct > 0 && pct < 20) return { pct, date, source: `FRED DGS10 ${date}` };
    }
    return null;
  } catch {
    return null;
  }
}

export class TreasuryModel {
  /**
   * opts: nav0, yieldRefPct, yieldPct (current, default = ref), carryPct (0 = follow the yield), durationYrs,
   * volBpDay, halfLifeDays, jumpsPerDay, jumpBp, microBps, microHalfLifeSec, priceMin, priceMax, timeScale
   */
  constructor(o = {}) {
    this.kind = 'tsy';
    this.nav = o.nav0 ?? 1;
    this.yRef = (o.yieldRefPct ?? 4.2) / 100;
    this.y = (o.yieldPct ?? o.yieldRefPct ?? 4.2) / 100;
    this.carry = (o.carryPct ?? 0) / 100;
    this.D = o.durationYrs ?? 7;
    this.sigmaDay = (o.volBpDay ?? 6.5) / 1e4;
    this.halfLife = (o.halfLifeDays ?? 30) * DAY_SEC;
    this.jumpRate = (o.jumpsPerDay ?? 3) / DAY_SEC;
    this.jumpSize = (o.jumpBp ?? 3) / 1e4;
    this.microStd = (o.microBps ?? 1) / 1e4;
    this.microHalfLife = o.microHalfLifeSec ?? 120;
    this.priceMin = o.priceMin ?? 0.96;
    this.priceMax = o.priceMax ?? 1.03;
    this.timeScale = o.timeScale ?? 1;
    this.micro = 0;
    this.jumps = [];
    this.last = Date.now();
  }

  priceOf(y = this.y) {
    return this.nav - this.D * (y - this.yRef);
  }

  step(now = Date.now()) {
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    if (dt > 0) {
      const carry = this.carry > 0 ? this.carry : this.y;
      this.nav *= Math.exp((carry * dt * this.timeScale) / YEAR_SEC);
      // OU in yield: stationary std = sigma_day * sqrt(halfLife / (2 ln2 * 1 day)); over short dt it is ~ sigma_day*sqrt(dt/day)
      const statStd = this.sigmaDay * Math.sqrt(this.halfLife / (2 * Math.LN2 * DAY_SEC));
      this.y = this.yRef + ouStep(this.y - this.yRef, dt, this.halfLife, statStd);
      // occasional small jumps (data releases, auctions...): Poisson, random sign, 0.5x..1.5x jumpBp
      if (Math.random() < 1 - Math.exp(-this.jumpRate * dt)) {
        const j = (Math.random() < 0.5 ? -1 : 1) * this.jumpSize * (0.5 + Math.random());
        this.y += j;
        this.jumps.push({ at: now, bp: j * 1e4 });
        if (this.jumps.length > 50) this.jumps.shift();
      }
      // keep the price in the believable band: reflect the yield at the edges
      const yLo = this.yRef + (this.nav - this.priceMax) / this.D; // lowest yield = highest price
      const yHi = this.yRef + (this.nav - this.priceMin) / this.D;
      if (this.y < yLo) this.y = Math.min(yHi, 2 * yLo - this.y);
      if (this.y > yHi) this.y = Math.max(yLo, 2 * yHi - this.y);
      this.micro = ouStep(this.micro, dt, this.microHalfLife, this.microStd);
    }
    return this.snapshot();
  }

  snapshot() {
    const price = this.priceOf();
    return { nav: this.nav, price, yieldPct: this.y * 100, yieldRefPct: this.yRef * 100, noise: this.micro, fair: price * (1 + this.micro) };
  }

  state() {
    return {
      model: 'tsy-10y',
      nav: Number(this.nav.toFixed(10)),
      yield_pct: Number((this.y * 100).toFixed(6)),
      yield_ref_pct: Number((this.yRef * 100).toFixed(6)),
      duration_yrs: this.D,
      price: Number(this.priceOf().toFixed(7)),
    };
  }
}

export class FlatModel {
  constructor({ nav0 = 1, aprPct = 5, noiseBps = 3, halfLifeSec = 90, timeScale = 1 } = {}) {
    this.kind = 'flat';
    this.nav = nav0;
    this.noise = 0;
    this.aprPct = aprPct;
    this.sigma = noiseBps / 10_000;
    this.halfLife = halfLifeSec;
    this.timeScale = timeScale;
    this.last = Date.now();
  }
  step(now = Date.now()) {
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    if (dt > 0) {
      this.nav *= Math.exp(((this.aprPct / 100) * dt * this.timeScale) / YEAR_SEC);
      this.noise = ouStep(this.noise, dt, this.halfLife, this.sigma);
    }
    return this.snapshot();
  }
  snapshot() {
    return { nav: this.nav, price: this.nav, noise: this.noise, fair: this.nav * (1 + this.noise) };
  }
  state() {
    return { model: 'flat', nav: Number(this.nav.toFixed(10)) };
  }
}

/** Back-compat name used by older code paths. */
export const NavModel = FlatModel;

/** Receipt price in USDC: 1 + OU noise of --peg-noise-bps (0 = exactly par), clamped to +/- --peg-noise-max-bps. */
export class PegModel {
  constructor({ noiseBps = 0, maxBps = 3.5, halfLifeSec = 180 } = {}) {
    this.std = noiseBps / 1e4;
    this.max = maxBps / 1e4;
    this.halfLife = halfLifeSec;
    this.x = 0;
    this.last = Date.now();
  }
  step(now = Date.now()) {
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    if (dt > 0 && this.std > 0) {
      this.x = ouStep(this.x, dt, this.halfLife, this.std);
      if (this.x > this.max) this.x = 2 * this.max - this.x;
      if (this.x < -this.max) this.x = -2 * this.max - this.x;
    }
    return { mid: 1 + this.x, bps: this.x * 1e4 };
  }
  snapshot() {
    return { mid: 1 + this.x, bps: this.x * 1e4 };
  }
}
