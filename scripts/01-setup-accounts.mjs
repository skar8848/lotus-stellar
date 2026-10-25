#!/usr/bin/env node
// 01 - Create and friendbot-fund the demo accounts: rwa_issuer, maker, taker, peg_lp.
//
// What it proves: nothing yet; it just prepares four independent testnet accounts
// (10,000 XLM each from friendbot) and records them in deployments/testnet.classic.json.
// Secrets go to deployments/testnet.secrets.json (gitignored). Re-runnable: existing keys are reused.

import { loadConfig, loadSecrets, saveClassic, saveSecrets } from './lib/config.mjs';
import { Keypair, accountLink, friendbot, getBalance, Asset, makeClients, fmt } from './lib/stellar.mjs';
import { h1, step, ok, info, kv, link, warn, die } from './lib/log.mjs';

const ROLES = [
  ['rwa_issuer', 'issues LBOND, the tokenized bond (AUTH_REQUIRED issuer)'],
  ['maker', 'market maker: sells LBOND against the yield-bearing receipt'],
  ['taker', 'buyer holding only the underlying (USDC/XLM)'],
  ['peg_lp', 'liquidity provider for the underlying/receipt 1:1 peg book'],
];

async function main() {
  h1('01 - setup demo accounts (testnet)');
  const cfg = loadConfig();
  const ctx = makeClients(cfg);
  const secrets = loadSecrets();
  const newSecrets = {};
  const accounts = {};

  for (const [role, purpose] of ROLES) {
    step(`${role}: ${purpose}`);
    let kp;
    if (secrets[role]) {
      kp = Keypair.fromSecret(secrets[role]);
      info(`reusing existing key from testnet.secrets.json`);
    } else {
      kp = Keypair.random();
      newSecrets[role] = kp.secret();
      info(`generated new keypair`);
    }
    const pub = kp.publicKey();
    accounts[role] = pub;

    const status = await friendbot(ctx, pub);
    const xlm = await getBalance(ctx, pub, Asset.native());
    if (status === 'funded') ok(`friendbot funded ${pub}`);
    else ok(`account already exists ${pub}`);
    kv('XLM balance', fmt(xlm.balance));
    link('explorer', accountLink(pub));
    if (Number(xlm.balance) < 2000) {
      warn(`balance below 2,000 XLM; Soroban calls that touch Blend cost ~100 XLM each on testnet`);
    }
  }

  if (Object.keys(newSecrets).length) {
    saveSecrets(newSecrets);
    ok(`saved ${Object.keys(newSecrets).length} new secret(s) to deployments/testnet.secrets.json (gitignored)`);
  }
  saveClassic({
    network: cfg.network,
    horizon: cfg.horizon,
    rpc: cfg.rpc,
    accounts,
    tx: { setup_accounts: { at: new Date().toISOString(), funded_by: 'friendbot' } },
  });
  ok('wrote deployments/testnet.classic.json');

  step('summary');
  for (const [role] of ROLES) kv(role, accounts[role]);
  info('next: node scripts/02-issue-rwa.mjs');
}

main().catch((e) => die(e?.stack ?? String(e)));
