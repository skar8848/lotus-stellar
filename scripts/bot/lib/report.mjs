// End-of-run summary and the --cleanup routine (cancel the bot's OWN offers only).

import { fromStroops } from '../../lib/stellar.mjs';
import { txUrl } from './log.mjs';
import { RC } from './names.mjs';

const xlm = (stroops) => (Number(stroops) / 1e7).toFixed(5);

export function printSummary(bot, { title = 'Run summary' } = {}) {
  const { log, stats, settings: s } = bot;
  const secs = stats.elapsedSec();
  log.head(`${title} (${secs.toFixed(0)}s)`);
  const rows = [];
  for (const [name, t] of stats.ticks) rows.push([name, String(t.ok + t.err), String(t.ok), String(t.err), t.ok + t.err ? `${((t.err / (t.ok + t.err)) * 100).toFixed(1)}%` : '-']);
  log.table(['component', 'ticks', 'ok', 'errors', 'error rate'], rows);

  const txTotal = stats.txOk + stats.txFail;
  log.raw('');
  log.raw(`  transactions     ${stats.txOk} ok, ${stats.txFail} failed on-chain/at submit, ${stats.txSkipped} skipped (dry-run)  -> failure rate ${txTotal ? ((stats.txFail / txTotal) * 100).toFixed(1) : '0.0'}%  (${stats.ops} operations, ${(stats.txOk / (secs / 60)).toFixed(1)} tx/min)`);
  log.raw(`  requests         ${stats.http} Horizon, ~${stats.rpc} Soroban RPC  (${(stats.http / (secs / 60)).toFixed(0)} Horizon req/min)`);
  log.raw(`  rate limiting    ${stats.rateLimited} HTTP 429 incident(s), ${(stats.backoffMs / 1000).toFixed(1)}s of back-off, ${stats.httpErrors} retried 5xx/network error(s)`);
  if (stats.errors.size) log.raw(`  errors by kind   ${[...stats.errors.entries()].map(([k, v]) => `${k} x${v}`).join(', ')}`);
  log.raw(`  market activity  ${stats.flowTrades} flow trades, ${stats.fills} fills in bot-taker txs, ~${stats.volumeLusdc.toFixed(2)} ${RC}/USDC of fill volume`);

  const fees = [...stats.feeStroops.entries()].map(([k, v]) => `${k} ${xlm(v)}`).join(', ');
  log.raw(`  XLM spent (fees) ${xlm(stats.totalFee())} XLM  (${fees || 'none'})`);
  for (const [label, b0] of Object.entries(bot.startBalances)) {
    const b1 = bot.balances[label];
    if (b1) log.raw(`    ${label.padEnd(5)} XLM ${b0.xlm.toFixed(5)} -> ${b1.xlm.toFixed(5)} | USDC ${b0.usdc.toFixed(2)} -> ${b1.usdc.toFixed(2)} | ${RC} ${b0.lusdc.toFixed(2)} -> ${b1.lusdc.toFixed(2)} | LBOND ${b0.lbond.toFixed(2)} -> ${b1.lbond.toFixed(2)}`);
  }

  const led = bot.arbLedger;
  if (led.length) {
    let gross = 0n;
    let fee = 0;
    for (const c of led) {
      gross += BigInt(Math.round(Number(c.gross) * 1e7));
      fee += c.feeXlm;
    }
    log.raw(`  arb ledger       ${led.length} cycle(s), gross ${fromStroops(gross)} USDC, fees ${fee.toFixed(5)} XLM`);
    log.table(
      ['#', 'side', `size (${RC})`, 'avg price', 'gross (USDC)', 'fees (XLM)', 'seconds', 'tx'],
      led.map((c) => [c.n, c.side, c.size, c.avg.toFixed(5), c.gross, c.feeXlm.toFixed(5), c.seconds.toFixed(1), c.hashes.map((h) => txUrl(h)).join(' ')]),
      '    ',
    );
  } else {
    log.raw('  arb ledger       no cycle (the peg book never offered an edge above the threshold)');
  }
  if (s.dryRun) log.raw('  (dry-run: nothing was submitted)');
  if (log.file) log.raw(`  full log: ${log.file}`);
}

/** Cancel every open offer of mm_a and mm_b (the bot's own accounts). Never touches other accounts. */
export async function cleanupOffers(bot) {
  const { chain, log, acct } = bot;
  if (bot.settings.dryRun) return;
  const wasStopping = bot.stopping;
  bot.stopping = false; // chain.reserve() refuses to work while stopping
  try {
    if (bot.poolAdapter) {
      for (const label of ['mm_a', 'mm_b']) {
        try {
          for (const id of await bot.poolAdapter.positionsOf(bot.acct[label].pub)) {
            const r = await bot.poolAdapter.removePosition(label, id);
            log.act('cleanup', `${label}: closed pool position #${id} (${fromStroops(r.base ?? 0n)} LBOND, ${fromStroops(r.quote ?? 0n)} USDC back)`, r.hash);
          }
        } catch (e) {
          log.err('cleanup', `${label} pool positions: ${e.message.split('\n')[0]}`);
        }
      }
    }
    for (const label of ['mm_a', 'mm_b']) {
      try {
        const offers = await chain.accountOffers(acct[label].pub);
        if (!offers.length) {
          log.info('cleanup', `${label}: no open offers`);
          continue;
        }
        const { Operation } = await import('@stellar/stellar-sdk');
        const { Asset } = await import('@stellar/stellar-sdk');
        const toAsset = (a) => (a.asset_type === 'native' ? Asset.native() : new Asset(a.asset_code, a.asset_issuer));
        const ops = offers.slice(0, 100).map((o) =>
          Operation.manageSellOffer({ selling: toAsset(o.selling), buying: toAsset(o.buying), amount: '0', price: { n: o.price_r.n, d: o.price_r.d }, offerId: o.id }),
        );
        const res = await chain.submit({ label, ops, memo: 'lotus cleanup' });
        log.act('cleanup', `${label}: cancelled ${ops.length} open offer(s)`, res.hash);
      } catch (e) {
        log.err('cleanup', `${label}: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    bot.stopping = wasStopping;
  }
}
