// Structured, human-readable logging for the bot. One line per action.
//
//   12:03:41 arb      BUY 150.0000000 lUSDC @0.98500 ... | https://stellar.expert/explorer/testnet/tx/<hash>
//
// Lines that report ACTIVITY (a quote, a trade, an arbitrage cycle, a transaction) go through act() and carry
// the tx link when there is one. Plain ASCII, no emojis, so it reads the same in a terminal, a log file and a
// video capture. Where the volume comes from is stated in the startup banner and in bot/README.md.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export const txUrl = (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m' };

const hhmmss = (d = new Date()) => d.toTimeString().slice(0, 8);

/** Size-based rotation: file -> file.1 -> ... -> file.<keep> (the oldest is dropped). */
function rotate(file, keep) {
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  renameSync(file, `${file}.1`);
}

export function createLogger({ file = null, quiet = false, console: toConsole = true, maxBytes = 20 * 1024 * 1024, keep = 5 } = {}) {
  const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const paint = (c, s) => (useColor ? `${c}${s}${C.reset}` : s);
  if (file) mkdirSync(path.dirname(file), { recursive: true });
  let size = 0;
  try {
    if (file && existsSync(file)) size = statSync(file).size;
  } catch {
    size = 0;
  }

  const emit = (line) => {
    if (toConsole) console.log(line);
    if (file) {
      try {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '') + '\n';
        if (maxBytes > 0 && size + clean.length > maxBytes) {
          rotate(file, keep);
          size = 0;
        }
        appendFileSync(file, clean);
        size += clean.length;
      } catch {
        /* logging must never take the bot down */
      }
    }
  };
  const fmtTag = (tag) => String(tag).padEnd(8);

  return {
    file,
    /** activity: one line per action, with the tx link when there is one */
    act(tag, msg, hash) {
      const tail = hash ? `  | ${paint(C.cyan, txUrl(hash))}` : '';
      emit(`${paint(C.dim, hhmmss())} ${fmtTag(tag)} ${msg}${tail}`);
    },
    /** activity that was NOT executed because of --dry-run */
    dry(tag, msg) {
      emit(`${paint(C.dim, hhmmss())} ${fmtTag(tag)} ${paint(C.dim, '[dry-run]')} ${msg}`);
    },
    info(tag, msg) {
      if (!quiet) emit(`${paint(C.dim, hhmmss())} ${fmtTag(tag)} ${msg}`);
    },
    warn(tag, msg) {
      emit(`${paint(C.dim, hhmmss())} ${paint(C.yellow, 'WARN')}     ${fmtTag(tag)} ${msg}`);
    },
    err(tag, msg) {
      emit(`${paint(C.dim, hhmmss())} ${paint(C.red, 'ERROR')}    ${fmtTag(tag)} ${msg}`);
    },
    head(msg) {
      emit('\n' + paint(C.bold + C.cyan, `== ${msg} `.padEnd(100, '=')));
    },
    raw(msg = '') {
      emit(msg);
    },
    /** simple aligned table, rows: array of arrays */
    table(headers, rows, indent = '  ') {
      const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
      const line = (cells) => indent + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
      emit(paint(C.dim, line(headers)));
      emit(paint(C.dim, line(widths.map((w) => '-'.repeat(w)))));
      for (const r of rows) emit(line(r));
    },
  };
}

export const num = (x, d = 7) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : String(x));
export const short = (a, n = 4) => (a && a.length > 2 * n + 3 ? `${a.slice(0, n)}..${a.slice(-n)}` : a);
