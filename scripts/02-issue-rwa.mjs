#!/usr/bin/env node
// 02 - Issue LBOND ("Lotus Bond"), a simulated tokenized treasury bill, as a regulated classic asset.
//
// What it proves: Stellar's built-in compliance primitives for RWAs.
//   - issuer flags AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED, home_domain lotus.fi
//   - maker + taker open trustlines and are explicitly authorized (SetTrustLineFlags) -> can trade
//   - blocked_taker opens a trustline but is NOT authorized -> cannot receive LBOND (shown in script 05)
//   - 1,000,000 LBOND minted to the maker (the inventory it will sell on the SDEX ladder)

import { loadConfig, loadSecrets, requireSecret, saveClassic, saveSecrets } from './lib/config.mjs';
import {
  Asset,
  Keypair,
  Operation,
  accountLink,
  assetLink,
  balanceLine,
  friendbot,
  getBalance,
  loadAccount,
  makeClients,
  submitClassic,
  txLink,
  fmt,
} from './lib/stellar.mjs';
import { AuthClawbackEnabledFlag, AuthRequiredFlag, AuthRevocableFlag } from '@stellar/stellar-sdk';
import { h1, step, ok, info, kv, link, warn, die } from './lib/log.mjs';

const RWA_CODE = 'LBOND';
const RWA_NAME = 'Lotus Bond (simulated tokenized T-bill)';
const HOME_DOMAIN = 'lotus.fi';
const MAKER_INVENTORY = '1000000'; // 1,000,000 LBOND

async function main() {
  h1(`02 - issue ${RWA_CODE} with compliance flags (testnet)`);
  const cfg = loadConfig();
  const ctx = makeClients(cfg);
  const secrets = loadSecrets();

  const issuer = Keypair.fromSecret(requireSecret(secrets, 'rwa_issuer'));
  const maker = Keypair.fromSecret(requireSecret(secrets, 'maker'));
  const taker = Keypair.fromSecret(requireSecret(secrets, 'taker'));
  const lbond = new Asset(RWA_CODE, issuer.publicKey());
  const txs = {};

  // ---- blocked_taker: funded, will get an unauthorized trustline
  step('blocked_taker: account that will NOT be authorized by the issuer');
  let blocked;
  if (secrets.blocked_taker) {
    blocked = Keypair.fromSecret(secrets.blocked_taker);
    info('reusing existing key');
  } else {
    blocked = Keypair.random();
    saveSecrets({ blocked_taker: blocked.secret() });
    info('generated new keypair (saved to testnet.secrets.json)');
  }
  const fb = await friendbot(ctx, blocked.publicKey());
  ok(`${fb === 'funded' ? 'friendbot funded' : 'already exists'} ${blocked.publicKey()}`);

  // ---- issuer flags
  step(`issuer ${issuer.publicKey()}: set AUTH_REQUIRED | AUTH_REVOCABLE | AUTH_CLAWBACK_ENABLED, home_domain ${HOME_DOMAIN}`);
  const issuerAcc = await loadAccount(ctx, issuer.publicKey());
  const f = issuerAcc.flags ?? {};
  if (f.auth_required && f.auth_revocable && f.auth_clawback_enabled && issuerAcc.home_domain === HOME_DOMAIN) {
    ok('flags already set');
  } else {
    const r = await submitClassic(ctx, {
      source: issuer,
      ops: [
        Operation.setOptions({
          setFlags: AuthRequiredFlag | AuthRevocableFlag | AuthClawbackEnabledFlag,
          homeDomain: HOME_DOMAIN,
        }),
      ],
      memo: 'LBOND issuer flags',
    });
    txs.issuer_flags = r.hash;
    ok(`SetOptions submitted`);
    link('tx', r.link);
  }
  kv('flags', 'auth_required=true auth_revocable=true auth_clawback_enabled=true');
  kv('meaning', 'holders must be whitelisted; issuer can freeze or claw back (regulated RWA)');

  // ---- trustlines + authorization for maker and taker
  for (const [name, kp] of [
    ['maker', maker],
    ['taker', taker],
  ]) {
    step(`${name} ${kp.publicKey()}: trustline to ${RWA_CODE} + issuer authorization`);
    const acc = await loadAccount(ctx, kp.publicKey());
    const line = balanceLine(acc, lbond);
    if (!line) {
      const r = await submitClassic(ctx, {
        source: kp,
        ops: [Operation.changeTrust({ asset: lbond })],
        memo: `trust ${RWA_CODE}`,
      });
      txs[`${name}_trust`] = r.hash;
      ok('ChangeTrust submitted');
      link('tx', r.link);
    } else ok('trustline exists');

    const fresh = balanceLine(await loadAccount(ctx, kp.publicKey()), lbond);
    if (fresh?.is_authorized) {
      ok('already authorized');
    } else {
      const r = await submitClassic(ctx, {
        source: issuer,
        ops: [
          Operation.setTrustLineFlags({
            trustor: kp.publicKey(),
            asset: lbond,
            flags: { authorized: true },
          }),
        ],
        memo: `authorize ${name}`,
      });
      txs[`${name}_authorize`] = r.hash;
      ok('SetTrustLineFlags(authorized=true) submitted by issuer');
      link('tx', r.link);
    }
  }

  // ---- blocked_taker trustline, deliberately left unauthorized
  step(`blocked_taker ${blocked.publicKey()}: trustline to ${RWA_CODE}, NO authorization`);
  const blockedAcc = await loadAccount(ctx, blocked.publicKey());
  if (!balanceLine(blockedAcc, lbond)) {
    const r = await submitClassic(ctx, {
      source: blocked,
      ops: [Operation.changeTrust({ asset: lbond })],
      memo: `trust ${RWA_CODE}`,
    });
    txs.blocked_trust = r.hash;
    ok('ChangeTrust submitted');
    link('tx', r.link);
  } else ok('trustline exists');
  const blockedLine = balanceLine(await loadAccount(ctx, blocked.publicKey()), lbond);
  kv('is_authorized', String(blockedLine?.is_authorized ?? false));
  info('-> any payment or DEX fill delivering LBOND to this account will fail with op_not_authorized');

  // ---- mint inventory to the maker
  step(`mint ${fmt(MAKER_INVENTORY)} ${RWA_CODE} to maker`);
  const makerLine = await getBalance(ctx, maker.publicKey(), lbond);
  if (Number(makerLine?.balance ?? 0) >= Number(MAKER_INVENTORY)) {
    ok(`maker already holds ${fmt(makerLine.balance)} ${RWA_CODE}`);
  } else {
    const r = await submitClassic(ctx, {
      source: issuer,
      ops: [Operation.payment({ destination: maker.publicKey(), asset: lbond, amount: MAKER_INVENTORY })],
      memo: 'mint LBOND inventory',
    });
    txs.mint_maker = r.hash;
    ok(`issuer paid ${fmt(MAKER_INVENTORY)} ${RWA_CODE} to maker`);
    link('tx', r.link);
  }

  // ---- record
  saveClassic({
    accounts: { blocked_taker: blocked.publicKey() },
    rwa: {
      code: RWA_CODE,
      issuer: issuer.publicKey(),
      name: RWA_NAME,
      home_domain: HOME_DOMAIN,
      flags: ['AUTH_REQUIRED', 'AUTH_REVOCABLE', 'AUTH_CLAWBACK_ENABLED'],
      maker_inventory: MAKER_INVENTORY,
      authorized: ['maker', 'taker'],
      unauthorized: ['blocked_taker'],
    },
    tx: { issue_rwa: txs },
  });
  ok('wrote deployments/testnet.classic.json');

  step('links for judges');
  link(`${RWA_CODE} asset`, assetLink(lbond));
  link('issuer', accountLink(issuer.publicKey()));
  link('maker', accountLink(maker.publicKey()));
  link('blocked_taker', accountLink(blocked.publicKey()));
  for (const [k, h] of Object.entries(txs)) link(`tx ${k}`, txLink(h));
  if (!Object.keys(txs).length) warn('no new transactions this run (everything was already in place)');
  info('next: node scripts/03-mint-receipt.mjs (needs deployments/testnet.contract.json)');
}

main().catch((e) => die(e?.stack ?? String(e)));
