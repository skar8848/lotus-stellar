// Config loading/merging for the Lotus testnet scripts.
//
// Files (all under <repo>/deployments/):
//   testnet.contract.json         written by the contract agent (contract id, assets, admin/keeper/issuer)
//   testnet.classic.json          written by these scripts (RWA asset, demo accounts, offers, tx hashes)
//   testnet.secrets.json          S... keys, shared with the contract agent, merged on write (gitignored)
//   testnet.classic.secrets.json  backup copy of the keys created by these scripts only (gitignored)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..', '..');
// LOTUS_DEPLOY_DIR lets you point the scripts at another folder (rehearsals on throwaway accounts).
export const DEPLOY_DIR = process.env.LOTUS_DEPLOY_DIR
  ? path.resolve(process.env.LOTUS_DEPLOY_DIR)
  : path.join(ROOT, 'deployments');
export const CONTRACT_JSON = path.join(DEPLOY_DIR, 'testnet.contract.json');
export const CLASSIC_JSON = path.join(DEPLOY_DIR, 'testnet.classic.json');
export const SECRETS_JSON = path.join(DEPLOY_DIR, 'testnet.secrets.json');
export const CLASSIC_SECRETS_JSON = path.join(DEPLOY_DIR, 'testnet.classic.secrets.json');

export const DEFAULTS = Object.freeze({
  network: 'testnet',
  rpc: 'https://soroban-testnet.stellar.org',
  horizon: 'https://horizon-testnet.stellar.org',
  passphrase: 'Test SDF Network ; September 2015',
  friendbot: 'https://friendbot.stellar.org',
});

/** Keys these scripts own in the secrets file. */
export const CLASSIC_SECRET_KEYS = ['rwa_issuer', 'maker', 'taker', 'peg_lp', 'blocked_taker'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursive merge of plain objects; arrays and scalars in `patch` replace. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function readJson(file, fallback) {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing file: ${file}`);
  }
  const raw = readFileSync(file, 'utf8');
  if (raw.trim() === '' && fallback !== undefined) return fallback;
  return JSON.parse(raw);
}

/** Atomic write (tmp + rename) so a concurrent reader never sees a half-written file. */
export function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- classic.json

export function loadClassic() {
  return readJson(CLASSIC_JSON, { network: 'testnet', accounts: {}, tx: {} });
}

/** Merge `patch` into testnet.classic.json (re-read first: other scripts may have written). */
export function saveClassic(patch) {
  const merged = deepMerge(loadClassic(), { ...patch, updated_at: new Date().toISOString() });
  writeJson(CLASSIC_JSON, merged);
  return merged;
}

// --------------------------------------------------------------- contract.json

/** Returns the parsed contract json or null when absent / still being written. */
export function tryLoadContract() {
  try {
    const c = readJson(CONTRACT_JSON);
    if (!c || !c.lotus_vault_contract) return null;
    return c;
  } catch {
    return null;
  }
}

export function loadContract() {
  const c = tryLoadContract();
  if (!c) {
    throw new Error(
      `deployments/testnet.contract.json is missing or incomplete. ` +
        `It is written by the contract agent once lotus_vault is deployed. ` +
        `Run: node scripts/00-wait-for-contract.mjs`,
    );
  }
  return c;
}

/**
 * Poll for the contract json. Resolves with the parsed json, or null on timeout.
 * onTick(elapsedMs) is called after every failed attempt.
 */
export async function waitForContractJson({ intervalMs = 120_000, maxMs = 2 * 3600_000, onTick } = {}) {
  const start = Date.now();
  for (;;) {
    const c = tryLoadContract();
    if (c) return c;
    const elapsed = Date.now() - start;
    if (elapsed >= maxMs) return null;
    if (onTick) onTick(elapsed);
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, maxMs - elapsed)));
  }
}

// ---------------------------------------------------------------- merged config

/**
 * Load the merged configuration.
 *   requireContract: throw if testnet.contract.json is not there yet.
 * Returns { network, rpc, horizon, passphrase, friendbot, contract|null, classic }.
 */
export function loadConfig({ requireContract = false } = {}) {
  const contract = requireContract ? loadContract() : tryLoadContract();
  const classic = loadClassic();
  return {
    network: contract?.network ?? classic.network ?? DEFAULTS.network,
    rpc: contract?.rpc ?? DEFAULTS.rpc,
    horizon: contract?.horizon ?? DEFAULTS.horizon,
    passphrase: contract?.passphrase ?? DEFAULTS.passphrase,
    friendbot: DEFAULTS.friendbot,
    contract,
    classic,
  };
}

// --------------------------------------------------------------------- secrets

/** Merged view of the shared secrets file and our backup copy (shared file wins). */
export function loadSecrets() {
  const backup = readJson(CLASSIC_SECRETS_JSON, {});
  const shared = readJson(SECRETS_JSON, {});
  return { ...backup, ...shared };
}

/**
 * Save keys: merged into the shared secrets file (never clobbering the contract agent's keys)
 * and mirrored into our own backup file for the keys we own.
 */
export function saveSecrets(patch) {
  const shared = { ...readJson(SECRETS_JSON, {}), ...patch };
  writeJson(SECRETS_JSON, shared);
  const mine = readJson(CLASSIC_SECRETS_JSON, {});
  for (const k of CLASSIC_SECRET_KEYS) if (patch[k]) mine[k] = patch[k];
  writeJson(CLASSIC_SECRETS_JSON, mine);
  return shared;
}

export function requireSecret(secrets, name, hint = 'run scripts/01-setup-accounts.mjs first') {
  const s = secrets[name];
  if (!s || !/^S[A-Z2-7]{55}$/.test(s)) {
    throw new Error(`secret "${name}" not found in deployments/testnet.secrets.json (${hint})`);
  }
  return s;
}

// ------------------------------------------------------------------- CLI args

/** Tiny flag parser: --foo bar --baz -> { foo: 'bar', baz: true }, positional in `_`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
