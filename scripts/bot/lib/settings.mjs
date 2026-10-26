// Bot settings: defaults + CLI parsing. Every knob can be overridden with --kebab-case-flag value.
//
//   npm run bot -- --arb-threshold-bps 3 --levels 5 --dry-run

import { RC } from './names.mjs';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

/** Printed once at startup and repeated in bot/README.md ("Where the volume comes from"). */
export const originNote = () =>
  `Testnet. Market makers (mm_a, mm_b) and an arbitrageur (arb) operated by the Lotus team, trading assets the team issues (LBOND) or mints through lotus_vault (${RC}).`;

/** name -> default. The type of the default drives how a CLI flag is coerced. */
export const DEFAULTS = Object.freeze({
  // ---- run control
  duration: 0, // seconds, 0 = until Ctrl+C
  only: 'arb,mm,flow,poolmm,cross', // components to run (poolmm and cross need the pool, see --pool)
  dryRun: false, // read + decide, never submit
  cleanup: false, // on stop, cancel the bot's OWN open offers (mm_a, mm_b)
  quiet: false,
  logFile: '', // default: scripts/bot/logs/bot-<timestamp>.log (set to "none" to disable)
  logMaxMb: 20, // rotate the log file at this size (file.1 .. file.<log-keep>)
  logKeep: 5,
  console: true, // false: write to the log file only (for nohup)

  // ---- safety
  minXlm: 200, // stop the bot if any bot account falls below this XLM balance
  maxTxPerMin: 20, // submitted transactions per rolling minute, all accounts
  maxOpsPerMin: 60, // operations per rolling minute (a 9-offer re-quote counts 9)
  httpPerMin: 150, // Horizon requests per minute budget (reads + submits)
  rpcPerMin: 150, // Soroban RPC requests per minute budget

  // ---- peg arbitrageur (arb)
  arbThresholdBps: 2, // act when the edge to par (after the price you pay/get) exceeds this
  arbIntervalSec: 5,
  arbMaxNotional: 250, // max lUSDC per cycle
  arbMinSize: 1, // ignore opportunities smaller than this many lUSDC
  arbMinProfit: 0.005, // USDC; skip cycles whose gross edge is smaller
  backingTolBps: 0.5, // vault_value may be this many bps under supply and still count as "par" (DeFindex rounding)
  allowProrata: false, // true: also redeem when the vault is under-backed, valuing the redeem at vault_value/supply
  xlmUsd: 0.1, // ONLY used to print a net-of-fees figure; testnet XLM is free

  // ---- market maker (mm_a)
  levels: 4, // quote levels per side on LBOND/lUSDC
  halfSpreadBps: 5, // distance of level 1 from fair value
  spacingBps: 10, // distance between levels
  levelSize: 50, // LBOND per level
  pegHalfSpreadBps: 1, // USDC/lUSDC book: bid 1 bp under, ask 1 bp over par
  pegSize: 100, // lUSDC per side on the peg book
  requoteBps: 4, // re-quote the bond ladder when fair value moved more than this
  refillFrac: 0.6, // refill an offer when less than this fraction of its size is left
  mmIntervalSec: 8,
  ladder: 'leave', // leave: never cross the demo ladder / other accounts' offers ; take: bond bids may take the stale demo asks

  // ---- LBOND/USDC book on the SDEX (mm_a quotes it from the same fair value; the app's "SDEX in USDC" destination)
  usdcBook: 'on', // on: mm_a quotes LBOND/USDC, mm_b trades it, arb checks it against LBOND/receipt x receipt/USDC ; off: mm_a cancels its own LBOND/USDC offers
  usdcLevels: 3, // quote levels per side on LBOND/USDC (same half spread and spacing as the receipt book)
  usdcLevelSize: 30, // LBOND per level (scaled down when mm_a is short of USDC, after the peg bid is funded)
  flowUsdcWeight: 0.35, // share of mm_b's flow trades that go to LBOND/USDC (when --usdc-book on)
  triIntervalSec: 10, // arb: triangular check LBOND/USDC vs LBOND/receipt x receipt/USDC every N seconds
  triMinEdgeBps: 6, // ... acts when the round trip clears this many bps
  triMaxNotional: 100, // ... USDC per round trip (one atomic circular path payment)

  // ---- simulated LBOND fair value (see lib/nav.mjs)
  navModel: 'tsy', // tsy: priced like a US 10-year Treasury from a simulated yield ; flat: NAV accrual at --nav-apr + noise
  navStart: 0, // 0 = continue from the saved state (or 1.00 on first run)
  navApr: 5, // flat model only: simulated bond yield, % per year
  navNoiseBps: 1, // stationary std of the small mean-reverting micro noise on top of the model price (flat model: 3 was the old default)
  navHalfLifeSec: 120,
  timeScale: 1, // accelerate the NAV (carry) accrual only (the demo scenario uses 5000: one minute = 3.5 days)
  yieldRef: 0, // tsy: reference 10Y yield in %. 0 = saved state, else the latest FRED DGS10 print, else --yield-fallback
  yieldFallback: 4.2, // tsy: used when FRED cannot be reached and nothing is saved
  yieldRefresh: false, // tsy: refetch DGS10 and restart the simulated yield from it (price continuity is kept: the NAV is re-based)
  yieldVolBpDay: 6.5, // tsy: daily std of the simulated yield, in bp (real 10Y: ~5-8 bp/day)
  yieldHalfLifeDays: 30, // tsy: mean reversion of the yield towards the reference
  yieldJumpsPerDay: 3, // tsy: Poisson rate of small jumps
  yieldJumpBp: 3, // tsy: jump size, bp (each jump is 0.5x..1.5x this, random sign)
  durationYrs: 7, // tsy: modified duration, price = nav - duration * (yield - ref)
  carryPct: 0, // tsy: carry accrual, % per year (0 = the current simulated yield)
  priceMin: 0.96, // tsy: the simulated price is kept inside [price-min, price-max]
  priceMax: 1.03,

  // ---- receipt (lUSDCb) price on the USDC/receipt book: par +/- a few bps (the vault redeems 1:1, yield is minted)
  pegNoiseBps: 0, // stationary std of the mid's OU noise around 1.0000 (0 = mm_a quotes exactly 1 -/+ peg-half-spread)
  pegNoiseMaxBps: 3, // the mid never leaves par by more than this
  pegNoiseHalfLifeSec: 180,

  // ---- flow generator (mm_b)
  flowMinSec: 10,
  flowMaxSec: 20,
  flowSizeMin: 2,
  flowSizeMax: 10,
  flowPegWeight: 0.55, // probability that a flow trade is on the peg book (else the bond book)
  flowTouchForeign: false, // true: flow may also consume other accounts' offers (demo ladder, peg_lp)
  flowMode: 'classic', // classic: one clip every --flow-min-sec..--flow-max-sec ; live: per-market arrival processes (bot:live)
  flowLiveRateMin: 2, // live: trades per minute per SDEX market, drawn in [min, max] every few minutes
  flowLiveRateMax: 4,
  flowLiveMinGapSec: 4,
  flowLiveMaxGapSec: 40, // live: never longer than this without a print on a market (every 1-minute candle gets one)
  flowForceAtSec: 35, // live: a market without a trade in the current UTC minute by this second gets a small forced trade
  flowBondSizeMin: 1, // live: LBOND clip sizes (log-normal) on LBOND/USDC and LBOND/receipt
  flowBondSizeMax: 40,
  flowPegSizeMin: 5, // live: receipt clip sizes on receipt/USDC
  flowPegSizeMax: 100,
  flowPoolPerMin: 0.3, // live: Lotus pool swaps per minute (Soroban, ~0.003 XLM each)
  flowTrend: 0.15, // live: buy-probability tilt towards the recent fair-value move
  flowInvBias: 0.3, // live: buy-probability tilt that brings mm_b's inventory back to its targets
  flowTargetUsdc: 350, // live: mm_b's USDC target
  flowTargetReceipt: 350, // live: mm_b's receipt target
  liq: false, // liquidity guard (bot:live): both sides of every book and pool always quoted, inventory minted/fetched when short
  liqIntervalSec: 60,
  liqBandPct: 1, // LBOND books and pools: depth counted within this % of fair value
  liqBondMin: 200, // LBOND per side within the band, on LBOND/USDC and LBOND/receipt
  liqPegBandBps: 10, // receipt/USDC: depth counted within this many bps of par
  liqPegMin: 500, // receipt per side within the band
  liqTreasuryKeep: 3000, // USDC the treasury account blocked_taker always keeps (the app faucet pays from it)
  liqTopupMax: 8, // Blend faucet rounds allowed per 24 h for the guard
  poolExtraIds: '', // comma-separated ids of extra live pools where mm_a also keeps an Ask and a Bid position (e.g. lbond-usdc-defindex)
  arbKeepUsdc: 600, // rebalance: USDC the arbitrageur keeps; the surplus goes back to the market makers
  topup: true, // rebalance: when the bots' USDC runs out, one Blend faucet round through a fresh account
  topupBelowUsdc: 900, // ... when mm_a + mm_b + arb hold less USDC than this
  topupMax: 3, // ... at most this many per run, 10 minutes apart

  // ---- Lotus range pool (LBOND/USDC), behind a feature flag
  pool: 'auto', // auto: use the live LBOND/USDC pool of deployments/testnet.pool.json when there is one ; on: require it ; off: never
  poolId: '', // pick a pool by its id in testnet.pool.json (default: the first live LBOND/USDC one)
  poolLevels: 4, // bins per mm_a position
  poolHalfSpreadBps: 5, // first bin sits at least this far from fair value (the grid step of the pool is 10 bps)
  poolAskSize: 120, // LBOND in mm_a's Ask position
  poolBidSize: 100, // USDC in mm_a's Bid position
  poolShiftBins: 3, // re-post a position when fair value moved this many bins away from it
  poolMmIntervalSec: 15,
  crossIntervalSec: 6,
  crossMinEdgeBps: 8, // cross-venue arb: minimum edge NET of the pool fee and the SDEX spread
  crossMaxNotional: 100, // USDC per cross-venue cycle
  crossMinProfit: 0.01, // USDC
  crossProbe: 10, // LBOND used to probe the edge before sizing up
  flowPoolWeight: 0.3, // share of mm_b's flow trades that go to the pool
  crossDir: 'cheap', // cross-venue scenario: cheap (pool sells LBOND too cheap) | rich (pool pays too much) | both
  crossShockBps: 80, // how far from the SDEX price mm_b places its dislocating pool position
  crossShockSize: 60, // LBOND (cheap) or LBOND-worth of USDC (rich) in that position

  // ---- scenarios
  scenario: '', // depeg | premium | demo | cross-venue | keeper
  shockRest: 150, // depeg: lUSDC left RESTING as an ask at the shock price once mm_b's dump has eaten every bid above it
  shockPrice: 0.985, // depeg: limit price of the dump (USDC per lUSDC)
  premiumSize: 150, // premium: lUSDC left RESTING as a bid at the premium price once mm_b has bought every ask below it
  premiumPrice: 1.004, // premium: limit price of that bid (USDC per lUSDC)
  recoverTimeoutSec: 180,
  demoKeeper: true, // demo scenario: finish with the keeper step (distribute real interest, balances before/after)
  keeperWait: 0, // seconds of extra normal trading before the keeper step (the keeper scenario waits 180 when this is 0)
  keeperMinSurplus: 0.0000001, // USDC: do nothing while surplus() is below this
});

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export function buildSettings(args) {
  const out = { ...DEFAULTS };
  const unknown = [];
  for (const [flag, raw] of Object.entries(args)) {
    if (flag === '_') continue;
    const key = Object.keys(DEFAULTS).find((k) => kebab(k) === flag);
    if (!key) {
      unknown.push(flag);
      continue;
    }
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') {
      out[key] = raw === true || raw === 'true' || raw === '1';
    } else if (typeof def === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--${flag} expects a number, got "${raw}"`);
      out[key] = n;
    } else {
      out[key] = String(raw);
    }
  }
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.map((u) => '--' + u).join(', ')}`);
  if (!['leave', 'take'].includes(out.ladder)) throw new Error('--ladder must be "leave" or "take"');
  if (!['auto', 'on', 'off'].includes(out.pool)) throw new Error('--pool must be auto, on or off');
  if (!['on', 'off'].includes(out.usdcBook)) throw new Error('--usdc-book must be on or off');
  if (out.usdcLevels < 1 || out.usdcLevels > 8) throw new Error('--usdc-levels must be between 1 and 8');
  if (!['cheap', 'rich', 'both'].includes(out.crossDir)) throw new Error('--cross-dir must be cheap, rich or both');
  if (out.levels < 1 || out.levels > 8) throw new Error('--levels must be between 1 and 8');
  if (!['classic', 'live'].includes(out.flowMode)) throw new Error('--flow-mode must be classic or live');
  if (out.flowMinSec > out.flowMaxSec) throw new Error('--flow-min-sec must be <= --flow-max-sec');
  return out;
}

export const helpText = `
Lotus testnet bot: market makers + peg arbitrageur operated by the team (testnet only)

  npm run bot:setup                 create/fund mm_a, mm_b, arb (idempotent)
  npm run bot                       arbitrageur + market maker + flow generator, until Ctrl+C
  npm run bot:depeg                 stress test: dump lUSDC below par, watch the arb restore it
  npm run bot:demo                  ~3 minute scripted run for the video
  npm run bot -- --scenario premium stress test of the other side: bid above par, arb mints + sells
  npm run bot -- --scenario cross-venue   dislocate the Lotus pool price, watch the arb close it against the SDEX
  npm run bot -- --scenario keeper        let mm_a's offers rest, then distribute the vault interest and show every holder before/after

Options (all optional, defaults in bot/lib/settings.mjs):
${Object.entries(DEFAULTS)
  .map(([k, v]) => `  --${kebab(k).padEnd(22)} ${String(v === '' ? '""' : v)}`)
  .join('\n')}
`;
