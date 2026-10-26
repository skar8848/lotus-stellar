// Who owns the liquidity the bot may trade against.
//
//   own    offers of the bot accounts (mm_a, mm_b)
//   team   the team's demo liquidity accounts (maker's demo ladders, peg_lp's peg book). With --ladder take the bot
//          may trade against them like any participant (their stale levels get taken when fair value moves
//          through them; `node scripts/04-seed-book.mjs --reset` re-posts them). With --ladder leave they are
//          treated like everybody else's.
//   others anyone else, e.g. app users resting orders. NEVER cancelled, never modified, and never taken by the
//          bot's takers: quotes are clamped so they do not cross them, and takers stop at the first book level
//          that holds liquidity the bot cannot attribute to own/team offers.

const same = (a, b) => Math.abs(a - b) < 6e-8;

export const TEAM_ROLES = ['maker', 'peg_lp'];
const EMPTY = Object.freeze({ bondAsks: [], bondBids: [], usdcAsks: [], usdcBids: [], pegAsks: [], pegBids: [], other: [] });

export const takesTeam = (bot) => bot.settings.ladder === 'take';

/**
 * Team offers classified like mm_a's (MarketMaker.classify), cached for maxAgeMs. Empty when --ladder leave.
 * `classify` is passed in to avoid an import cycle with mm.mjs.
 */
export async function teamOffers(bot, classify, { maxAgeMs = 30_000 } = {}) {
  if (!takesTeam(bot)) return EMPTY;
  const st = bot.teamState;
  if (st && Date.now() - st.at < maxAgeMs) return st.offers;
  const pubs = TEAM_ROLES.map((r) => bot.env.cfg.classic.accounts?.[r]).filter(Boolean);
  const raw = [];
  for (const pub of pubs) raw.push(...(await bot.chain.accountOffers(pub)));
  const offers = classify(raw);
  bot.teamState = { offers, at: Date.now() };
  return offers;
}

/** Sum of base-unit sizes of the offers in `lists` quoted exactly at `price`. */
export function knownAt(price, lists) {
  let x = 0;
  for (const list of lists) for (const o of list ?? []) if (same(o.quote, price)) x += o.size;
  return x;
}

/**
 * Leading book levels that hold ONLY liquidity from `lists` (own + team offers). Stops at the first level that also
 * holds somebody else's liquidity (time priority could fill theirs first) or that holds none of ours.
 */
export function knownPrefix(levels, lists, eps = 1e-4) {
  const out = [];
  for (const l of levels) {
    const k = knownAt(l.price, lists);
    if (k <= 0 || l.amount > k * (1 + 1e-6) + eps) break;
    out.push(l);
  }
  return out;
}

/** Best price on a side held by somebody else than `lists`, or null. */
export function foreignBest(levels, lists, eps = 1e-6) {
  for (const l of levels) if (l.amount - knownAt(l.price, lists) > eps) return l.price;
  return null;
}
