#!/usr/bin/env node
// Lotus testnet bot: peg arbitrageur + market maker + flow generator (+ scenarios).
//
//   npm run bot                         normal mode until Ctrl+C
//   npm run bot -- --duration 600       stop after 10 minutes
//   npm run bot -- --dry-run            decide and log, submit nothing
//   npm run bot -- --cleanup            on stop, cancel the bot's own open offers (mm_a, mm_b)
//   npm run bot:depeg | bot:demo        scripted scenarios (see scenarios.mjs)
//
// Testnet only: the process refuses to start on any other network passphrase.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/config.mjs';
import { Bot } from './lib/bot.mjs';
import { StopBot } from './lib/chain.mjs';
import { loadBotEnv } from './lib/env.mjs';
import { createLogger } from './lib/log.mjs';
import { cleanupOffers, printSummary } from './lib/report.mjs';
import { startComponents } from './lib/run.mjs';
import { buildSettings, helpText, originNote } from './lib/settings.mjs';
import { RC } from './lib/names.mjs';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Start the three loops (+ watchdog). Resolves when the bot stops. */
export async function runNormal(bot, { only } = {}) {
  const s = bot.settings;
  const { loops } = startComponents(bot, { only });
  const enabled = (only ?? s.only).split(',').map((x) => x.trim());
  bot.log.info('bot', `running: ${enabled.join(', ')}${s.duration ? ` for ${s.duration}s` : ' until Ctrl+C'}${s.dryRun ? ' [dry-run]' : ''}`);
  await Promise.all(loops);
}

function banner(bot) {
  const { log, env, settings: s } = bot;
  log.head('Lotus testnet bot');
  log.raw(originNote());
  log.raw(`network   ${env.cfg.passphrase}`);
  log.raw(`horizon   ${env.cfg.horizon}   rpc ${env.cfg.rpc}`);
  log.raw(`vault     ${env.contractId}`);
  log.raw(bot.modelLine());
  if (s.flowMode === 'live') log.raw(`flow      live: ${s.flowLiveRateMin}-${s.flowLiveRateMax} trades/min per SDEX market (max gap ${s.flowLiveMaxGapSec}s), LBOND ${s.flowBondSizeMin}-${s.flowBondSizeMax}, ${RC} ${s.flowPegSizeMin}-${s.flowPegSizeMax}, pool ${s.flowPoolPerMin}/min | peg noise ${s.pegNoiseBps} bps (max ${s.pegNoiseMaxBps})`);
  for (const [label, a] of Object.entries(bot.acct)) log.raw(`${label.padEnd(9)} ${a.pub}`);
  log.raw(
    `settings  arb >= ${s.arbThresholdBps} bps | ${s.levels} levels x ${s.spacingBps} bps (size ${s.levelSize}) | flow ~1 trade/${s.flowMinSec}-${s.flowMaxSec}s | caps ${s.maxTxPerMin} tx/min ${s.maxOpsPerMin} ops/min ${s.httpPerMin} req/min | min ${s.minXlm} XLM | ladder=${s.ladder} | usdc-book=${s.usdcBook}${s.usdcBook === 'on' ? ` (${s.usdcLevels} x ${s.usdcLevelSize} LBOND)` : ''}${s.dryRun ? ' | DRY-RUN' : ''}${s.cleanup ? ' | cleanup on exit' : ''}`,
  );
}

async function main() {
  const args = parseArgs();
  if (args.help || args.h) {
    console.log(helpText);
    return;
  }
  const settings = buildSettings(args);
  const env = loadBotEnv(); // refuses non-testnet networks, requires bot:setup to have run
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = settings.logFile === 'none' ? null : settings.logFile || path.join(BOT_DIR, 'logs', `bot-${stamp}.log`);
  const log = createLogger({ file: logFile, quiet: settings.quiet, console: settings.console, maxBytes: settings.logMaxMb * 1024 * 1024, keep: settings.logKeep });
  const bot = new Bot({ env, settings, log });

  let interrupted = false;
  const onSignal = (sig) => {
    if (interrupted) {
      console.log('\nsecond interrupt: exiting now');
      process.exit(130);
    }
    interrupted = true;
    bot.stop(`${sig} received${settings.cleanup ? ' (will cancel the bot\'s own offers)' : ''}`);
  };
  process.on('SIGINT', () => onSignal('Ctrl+C'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('unhandledRejection', (e) => log.err('bot', `unhandled rejection: ${e?.stack ?? e}`));

  try {
    await bot.init();
    banner(bot);
    await bot.initPool();
    log.table(
      ['account', 'XLM', 'USDC', `${RC}`, 'LBOND'],
      Object.entries(bot.balances).map(([l, b]) => [l, b.xlm.toFixed(4), b.usdc.toFixed(2), b.lusdc.toFixed(2), b.lbond.toFixed(2)]),
    );
    if (settings.scenario) {
      const { runScenario } = await import('./scenarios.mjs');
      await runScenario(bot);
    } else {
      await runNormal(bot);
    }
  } catch (e) {
    if (e instanceof StopBot) bot.stop(e.message);
    else {
      log.err('bot', e?.stack ?? String(e));
      bot.stop('fatal error');
    }
  }

  // ---- shutdown
  bot.stopping = true;
  if (settings.cleanup) await cleanupOffers(bot);
  try {
    await bot.refreshAll();
  } catch {
    /* final balances are best effort */
  }
  bot.saveNavState();
  printSummary(bot);
  log.raw(`\nstopped: ${bot.stopReason ?? 'finished'}`);
  process.exit(bot.stopReason && /guard|holds/.test(bot.stopReason) ? 3 : bot.stopReason && /fatal/.test(bot.stopReason) ? 2 : 0);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  main().catch((e) => {
    console.error(e?.stack ?? e);
    process.exit(1);
  });
}
