#!/usr/bin/env node
// Long-running live mode: steady, modest volume on the three SDEX markets + the Lotus pool, for credible /trade charts.
//
//   npm run bot:live                         start (foreground); Ctrl+C stops it cleanly
//   nohup npm run bot:live >/dev/null 2>&1 &   unattended (log: scripts/bot/logs/bot-live.log, rotated at 20 MB x 5)
//   npm run bot:stop                         SIGTERM the running instance: it cancels its own offers, closes its pool positions
//   npm run bot:live -- --flow-live-rate-max 6    any bot option overrides the preset below
//
// A supervisor: it runs bot/index.mjs with the LIVE preset, restarts it after a crash (backoff, at most 10 restarts an
// hour), never restarts after a guard stop (exit code 3, e.g. XLM under --min-xlm), and refuses to start twice
// (pid file scripts/bot/logs/bot-live.pid).

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(BOT_DIR, 'logs');
const PID_FILE = path.join(LOG_DIR, 'bot-live.pid');
const SUP_LOG = path.join(LOG_DIR, 'bot-live-supervisor.log');

export const LIVE_PRESET = [
  '--flow-mode', 'live',
  '--ladder', 'take', // the team's stale demo levels (maker, peg_lp) may be traded through; app users' offers never are
  '--peg-noise-bps', '1.5',
  '--requote-bps', '1.5',
  '--level-size', '60', // 4 levels x 60 = 240 LBOND each side within 35 bps (liquidity guard minimum 200 within 1%)
  '--usdc-levels', '4',
  '--usdc-level-size', '60',
  '--peg-size', '550', // >= 500 receipt each side within 10 bps of par
  '--liq', 'true',
  '--pool-extra-ids', 'lbond-usdc-defindex', // vault-backed pool: mm_a keeps an Ask and a Bid there too
  '--pool-shift-bins', '2',
  '--max-tx-per-min', '40',
  '--max-ops-per-min', '150',
  '--http-per-min', '140',
  '--mm-interval-sec', '8',
  '--tri-interval-sec', '20',
  '--cross-interval-sec', '10',
  '--cleanup', 'true',
  '--log-file', path.join(LOG_DIR, 'bot-live.log'),
];

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = () => {
  try {
    return Number(readFileSync(PID_FILE, 'utf8').trim()) || null;
  } catch {
    return null;
  }
};
const say = (m) => {
  const line = `${new Date().toISOString()} supervisor ${m}`;
  console.log(line);
  try {
    appendFileSync(SUP_LOG, line + '\n');
  } catch {
    /* best effort */
  }
};

async function stopRunning() {
  const pid = readPid();
  if (!pid || !alive(pid)) {
    console.log('bot:live is not running');
    if (pid) unlinkSync(PID_FILE);
    return;
  }
  process.kill(pid, 'SIGTERM');
  console.log(`SIGTERM sent to bot:live (pid ${pid}); waiting for its cleanup (own offers, own pool positions)...`);
  for (let i = 0; i < 180 && alive(pid); i++) await new Promise((r) => setTimeout(r, 1000));
  console.log(alive(pid) ? `still running after 180 s (pid ${pid})` : 'stopped');
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const args = process.argv.slice(2);
  if (args.includes('--stop')) return stopRunning();
  const old = readPid();
  if (old && alive(old) && old !== process.pid) {
    console.error(`bot:live already running (pid ${old}); npm run bot:stop first`);
    process.exit(1);
  }
  writeFileSync(PID_FILE, String(process.pid));

  let child = null;
  let stopping = false;
  const restarts = [];
  const cleanupPid = () => {
    try {
      if (readPid() === process.pid) unlinkSync(PID_FILE);
    } catch {
      /* already gone */
    }
  };
  const onSignal = (sig) => {
    if (stopping) {
      if (child) child.kill('SIGKILL');
      cleanupPid();
      process.exit(130);
    }
    stopping = true;
    say(`${sig}: stopping the bot (it cancels its own offers and closes its own pool positions)`);
    if (child) child.kill('SIGTERM');
    setTimeout(() => {
      if (child) child.kill('SIGKILL');
    }, 170_000).unref();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('exit', cleanupPid);

  for (;;) {
    const childArgs = [path.join(BOT_DIR, 'index.mjs'), ...LIVE_PRESET, ...args];
    say(`starting bot (pid file ${PID_FILE}, log ${path.join(LOG_DIR, 'bot-live.log')})`);
    const code = await new Promise((resolve) => {
      child = spawn(process.execPath, childArgs, { stdio: 'inherit', cwd: path.dirname(BOT_DIR), detached: true }); // own process group: a terminal Ctrl+C reaches only the supervisor, which forwards ONE SIGTERM
      child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
    });
    child = null;
    if (stopping) break;
    if (code === 0) {
      say('bot finished (exit 0)');
      break;
    }
    if (code === 3) {
      say('bot stopped by a guard (exit 3, see the log): not restarting');
      break;
    }
    const now = Date.now();
    while (restarts.length && now - restarts[0] > 3_600_000) restarts.shift();
    if (restarts.length >= 10) {
      say('10 restarts in the last hour: giving up');
      break;
    }
    restarts.push(now);
    const wait = Math.min(300, 15 * 2 ** (restarts.length - 1));
    say(`bot exited with code ${code}: restarting in ${wait}s (restart ${restarts.length} this hour)`);
    for (let i = 0; i < wait && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
    if (stopping) break;
  }
  cleanupPid();
  say('supervisor exit');
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
