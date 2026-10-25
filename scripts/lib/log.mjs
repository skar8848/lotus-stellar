// Human-readable console output helpers (judges will read this in the demo video).
// No emojis on purpose: plain ASCII markers render the same everywhere.

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `${code}${s}${C.reset}` : s);

export function h1(title) {
  console.log('\n' + paint(C.bold + C.cyan, `== ${title} `.padEnd(78, '=')));
}

export function step(msg) {
  console.log(paint(C.bold, `\n-> ${msg}`));
}

export function ok(msg) {
  console.log(paint(C.green, '   [OK]   ') + msg);
}

export function info(msg) {
  console.log(`          ${msg}`);
}

export function warn(msg) {
  console.log(paint(C.yellow, '   [WARN] ') + msg);
}

export function fail(msg) {
  console.log(paint(C.red, '   [FAIL] ') + msg);
}

export function kv(key, val) {
  console.log(`          ${paint(C.dim, String(key).padEnd(22))} ${val}`);
}

export function link(label, url) {
  console.log(`          ${paint(C.dim, String(label).padEnd(22))} ${paint(C.cyan, url)}`);
}

/** Shorten a G.../C... address for display: GABC...WXYZ */
export function short(addr, n = 4) {
  if (!addr || addr.length <= 2 * n + 3) return addr;
  return `${addr.slice(0, n)}...${addr.slice(-n)}`;
}

/** Render a simple ASCII table. rows: array of arrays (strings). */
export function table(headers, rows) {
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) =>
    '          ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(paint(C.dim, line(headers)));
  console.log(paint(C.dim, line(widths.map((w) => '-'.repeat(w)))));
  for (const r of rows) console.log(line(r));
  if (rows.length === 0) console.log(paint(C.dim, '          (empty)'));
}

export function die(msg, code = 1) {
  fail(msg);
  process.exit(code);
}
