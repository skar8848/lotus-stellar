// Bot environment: merged config, assets, bot keypairs, safety checks.
//
//   deployments/testnet.bot.json          public: bot accounts, setup tx hashes, simulated NAV state
//   deployments/testnet.bot.secrets.json  S... keys ONLY (gitignored by deployments/.gitignore)
//
// Existing files (testnet.contract.json, testnet.classic.json, testnet*.secrets.json) are only READ.

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DEPLOY_DIR, ROOT, deepMerge, loadConfig, loadSecrets, readJson, writeJson } from '../../lib/config.mjs';
import { Asset, Keypair, assetFromConfig, makeClients } from '../../lib/stellar.mjs';
import { TESTNET_PASSPHRASE } from './settings.mjs';

export const BOT_JSON = path.join(DEPLOY_DIR, 'testnet.bot.json');
export const BOT_SECRETS_JSON = path.join(DEPLOY_DIR, 'testnet.bot.secrets.json');
export const BOT_ROLES = ['mm_a', 'mm_b', 'arb'];

// ------------------------------------------------------------------ files

export const loadBotSecrets = () => readJson(BOT_SECRETS_JSON, {});
export const loadBotJson = () => readJson(BOT_JSON, { network: 'testnet', accounts: {}, setup: {}, state: {} });

export function saveBotJson(patch) {
  const merged = deepMerge(loadBotJson(), { ...patch, updated_at: new Date().toISOString() });
  writeJson(BOT_JSON, merged);
  return merged;
}

/** Write the bot secrets file with mode 0600 (atomic). */
export function saveBotSecrets(secrets) {
  mkdirSync(path.dirname(BOT_SECRETS_JSON), { recursive: true });
  const tmp = `${BOT_SECRETS_JSON}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, BOT_SECRETS_JSON);
  try {
    chmodSync(BOT_SECRETS_JSON, 0o600);
  } catch {
    /* best effort */
  }
}

/** true when git ignores the secrets file (or when we are not in a git work tree at all). */
export function secretsFileIsIgnored() {
  if (!existsSync(path.join(ROOT, '.git'))) return true;
  const r = spawnSync('git', ['check-ignore', '-q', BOT_SECRETS_JSON], { cwd: ROOT });
  return r.status === 0;
}

// ------------------------------------------------------------------ safety

export function assertTestnet(cfg) {
  const problems = [];
  if (cfg.passphrase !== TESTNET_PASSPHRASE) problems.push(`network passphrase is "${cfg.passphrase}"`);
  if (cfg.network && cfg.network !== 'testnet') problems.push(`network is "${cfg.network}"`);
  if (!/testnet/i.test(cfg.horizon)) problems.push(`Horizon URL "${cfg.horizon}" is not a testnet endpoint`);
  if (!/testnet/i.test(cfg.rpc)) problems.push(`RPC URL "${cfg.rpc}" is not a testnet endpoint`);
  if (problems.length) {
    throw new Error(`REFUSING TO RUN: this bot is testnet-only (${problems.join('; ')}). Expected passphrase "${TESTNET_PASSPHRASE}".`);
  }
}

// ------------------------------------------------------------------ environment

/**
 * Everything the bot needs. `needAccounts`: throw if the bot accounts have not been created yet.
 */
export function loadBotEnv({ needAccounts = true } = {}) {
  const cfg = loadConfig({ requireContract: true });
  assertTestnet(cfg);
  const ctx = makeClients(cfg);
  const c = cfg.contract;
  const rwa = cfg.classic.rwa;
  if (!rwa) throw new Error('LBOND is not issued yet: run scripts/02-issue-rwa.mjs first');
  const usdc = assetFromConfig(c.underlying);
  const lusdc = assetFromConfig(c.receipt);
  const lbond = new Asset(rwa.code, rwa.issuer);

  const secrets = loadSecrets();
  const botSecrets = loadBotSecrets();
  const keys = {};
  for (const role of BOT_ROLES) {
    if (botSecrets[role] && /^S[A-Z2-7]{55}$/.test(botSecrets[role])) keys[role] = Keypair.fromSecret(botSecrets[role]);
  }
  const missing = BOT_ROLES.filter((r) => !keys[r]);
  if (needAccounts && missing.length) {
    throw new Error(`bot accounts missing (${missing.join(', ')}): run "npm run bot:setup" first`);
  }

  const bot = loadBotJson();
  const known = {
    ...(c.accounts ?? {}),
    ...(cfg.classic.accounts ?? {}),
    ...Object.fromEntries(Object.entries(keys).map(([r, kp]) => [r, kp.publicKey()])),
  };
  const roleOf = (g) => Object.entries(known).find(([, v]) => v === g)?.[0] ?? null;

  const issuerSecret = secrets.rwa_issuer;
  return {
    cfg,
    ctx,
    contractId: c.lotus_vault_contract,
    usdc,
    lusdc,
    lbond,
    rwa,
    keys,
    missing,
    issuer: issuerSecret ? Keypair.fromSecret(issuerSecret) : null,
    roleOf,
    botJson: bot,
    /** a funded account usable as the source of read-only simulations */
    readerPub: keys.arb?.publicKey() ?? cfg.classic.accounts?.maker ?? c.accounts?.keeper,
  };
}
