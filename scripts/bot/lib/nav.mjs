// Simulated fair value of LBOND in lUSDC: a tokenized T-bill whose NAV accrues at a fixed yield, plus a
// small mean-reverting (Ornstein-Uhlenbeck) market noise. This is a SIMULATION: no real bond, no oracle.
//
//   nav(t)  = nav(t0) * exp(apr * dt * timeScale / year)          deterministic accrual
//   noise   = OU process, stationary std navNoiseBps, half-life navHalfLifeSec
//   fair(t) = nav(t) * (1 + noise(t))

const YEAR_SEC = 365 * 24 * 3600;

function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

export class NavModel {
  constructor({ nav0 = 1, aprPct = 5, noiseBps = 3, halfLifeSec = 90, timeScale = 1 } = {}) {
    this.nav = nav0;
    this.noise = 0;
    this.aprPct = aprPct;
    this.sigma = noiseBps / 10_000;
    this.halfLife = halfLifeSec;
    this.timeScale = timeScale;
    this.last = Date.now();
  }
  /** Advance to now and return { nav, noise, fair }. */
  step(now = Date.now()) {
    const dt = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    if (dt > 0) {
      this.nav *= Math.exp(((this.aprPct / 100) * dt * this.timeScale) / YEAR_SEC);
      const a = Math.exp((-Math.LN2 * dt) / this.halfLife);
      this.noise = this.noise * a + this.sigma * Math.sqrt(Math.max(0, 1 - a * a)) * gauss();
    }
    return this.snapshot();
  }
  snapshot() {
    return { nav: this.nav, noise: this.noise, fair: this.nav * (1 + this.noise) };
  }
}
