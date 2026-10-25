#!/usr/bin/env node
// bot:setup - create and provision the three bot accounts, idempotently.
//
//   mm_a  market maker: quotes LBOND/<receipt> and the USDC/<receipt> peg book
//   mm_b  flow generator / taker (and the actor that moves the peg in the stress scenarios)
//   arb   peg arbitrageur (and the cross-venue arbitrageur when the Lotus pool is live)
//
// For each account: friendbot XLM, trustlines (the active receipt from deployments/testnet.contract.json, LBOND),
// LBOND authorization signed by rwa_issuer (AUTH_REQUIRED asset), LBOND inventory from the issuer (mm_a, mm_b),
// USDC from the Blend testnet faucet, the receipt minted through lotus_vault.deposit(), and, after a switch of
// deployment (v1 lUSDC -> v2 lUSDCb), the previous receipt redeemed at par on the previous vault. Secrets go ONLY to
// deployments/testnet.bot.secrets.json (mode 0600, gitignored); public info to deployments/testnet.bot.json.
//
// Re-running skips whatever is already in place. Nothing here touches offers or balances of other accounts,
// apart from the issuer paying LBOND to the bot accounts and authorizing their trustlines.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { Asset, Keypair, Operation, StrKey } from '@stellar/stellar-sdk';
import { DEPLOY_DIR, parseArgs, readJson } from '../lib/config.mjs';
import { blendFaucet } from '../lib/blend-faucet.mjs';
import {
  accountExists,
  addr,
  assetFromConfig,
  balanceLine,
  feeXlm,
  fmt,
  friendbot,
  fromStroops,
  i128,
  invokeContract,
  loadAccount,
  submitClassic,
  toStroops,
} from '../lib/stellar.mjs';
import { BOT_JSON, BOT_ROLES, BOT_SECRETS_JSON, loadBotEnv, loadBotJson, loadBotSecrets, saveBotJson, saveBotSecrets, secretsFileIsIgnored } from './lib/env.mjs';
import { createLogger, txUrl } from './lib/log.mjs';
import { originNote } from './lib/settings.mjs';
import { RC, setReceiptCode } from './lib/names.mjs';

// What each account is provisioned with (USDC from the faucet, the receipt minted from that USDC, LBOND from the issuer).
// The Blend faucet pays 1,000 USDC once per account (see fundUsdc), so USDC targets are 1,000.
export const PLAN = {
  mm_a: { usdc: 1000, lusdc: 600, lbond: 20000, lbondTrust: true },
  mm_b: { usdc: 1000, lusdc: 600, lbond: 20000, lbondTrust: true },
  arb: { usdc: 1000, lusdc: 0, lbond: 0, lbondTrust: true }, // LBOND trustline so it can run the cross-venue leg later
};

const purposeOf = () => ({
  mm_a: `market maker: quotes LBOND/${RC} (4 levels each side) and the USDC/${RC} peg book`,
  mm_b: 'flow generator / taker; also the actor that moves the peg in the stress scenarios',
  arb: `arbitrageur: buys ${RC} under 1 USDC and redeems it, or mints it at par and sells above 1`,
});

/**
 * The previous deployment's receipt, when deployments/testnet.contract.v1.json describes a DIFFERENT receipt than the
 * active testnet.contract.json (i.e. after switch-strategy.sh v2). Its holders can redeem it at par on the old vault.
 */
export function loadLegacyReceipt(env) {
  const file = path.join(DEPLOY_DIR, 'testnet.contract.v1.json');
  if (!existsSync(file)) return null;
  try {
    const j = readJson(file);
    const receipt = assetFromConfig(j.receipt);
    if (receipt.equals(env.lusdc) || j.lotus_vault_contract === env.contractId) return null;
    return { receipt, contractId: j.lotus_vault_contract };
  } catch {
    return null;
  }
}

export async function runSetup(args = {}) {
  const log = createLogger({ quiet: false });
  const dry = Boolean(args['dry-run']);
  log.head('Lotus bot setup (testnet)');
  const env = loadBotEnv({ needAccounts: false }); // also refuses to run off testnet
  const { ctx, usdc, lusdc, lbond, issuer } = env;
  setReceiptCode(lusdc.getCode());
  log.raw(originNote());
  log.raw(`active receipt ${lusdc.getCode()}:${lusdc.getIssuer()}  vault ${env.contractId}`);
  const txs = {};
  if (dry) log.warn('setup', '--dry-run: only reading, nothing will be created or sent');

  // ---------------------------------------------------------------- keys
  if (!secretsFileIsIgnored()) {
    throw new Error(`refusing to write secrets: ${BOT_SECRETS_JSON} is not covered by .gitignore (git check-ignore failed)`);
  }
  const secrets = loadBotSecrets();
  let created = false;
  for (const role of BOT_ROLES) {
    if (!secrets[role]) {
      secrets[role] = Keypair.random().secret();
      created = true;
      log.info('setup', `${role}: new keypair generated`);
    }
  }
  if (created && !dry) {
    saveBotSecrets(secrets); // persisted BEFORE funding so a funded key can never be lost
    log.info('setup', `secrets written to ${BOT_SECRETS_JSON} (mode 0600, git-ignored: verified with git check-ignore)`);
  }
  const keys = Object.fromEntries(BOT_ROLES.map((r) => [r, Keypair.fromSecret(secrets[r])]));
  for (const r of BOT_ROLES) {
    if (!StrKey.isValidEd25519PublicKey(keys[r].publicKey())) throw new Error(`bad key for ${r}`);
    log.info('setup', `${r.padEnd(5)} ${keys[r].publicKey()}  (${purposeOf()[r]})`);
  }
  if (dry) {
    log.info('setup', 'dry-run done');
    return;
  }

  // ---------------------------------------------------------------- friendbot
  for (const role of BOT_ROLES) {
    const pub = keys[role].publicKey();
    if (await accountExists(ctx, pub)) {
      log.info('setup', `${role}: account exists`);
    } else {
      await friendbot(ctx, pub);
      log.act('setup', `${role}: funded by friendbot (10,000 XLM)`);
    }
  }

  // ---------------------------------------------------------------- trustlines
  for (const role of BOT_ROLES) {
    const kp = keys[role];
    const acc = await loadAccount(ctx, kp.publicKey());
    const ops = [];
    // NOT usdc: the Blend faucet creates that trustline itself and only pays accounts that have none yet
    const want = [lusdc, ...(PLAN[role].lbondTrust ? [lbond] : [])];
    for (const a of want) if (!balanceLine(acc, a)) ops.push(Operation.changeTrust({ asset: a }));
    if (!ops.length) {
      log.info('setup', `${role}: trustlines already open`);
      continue;
    }
    const r = await submitClassic(env.ctx, { source: kp, ops, memo: 'lotus bot trustlines' });
    txs[`${role}_trustlines`] = r.hash;
    log.act('setup', `${role}: opened ${ops.length} trustline(s)`, r.hash);
  }

  // ---------------------------------------------------------------- LBOND: authorization + inventory (issuer-signed)
  if (!issuer) throw new Error('rwa_issuer secret not found in deployments/testnet.secrets.json: cannot authorize LBOND trustlines');
  {
    const ops = [];
    const notes = [];
    for (const role of BOT_ROLES) {
      if (!PLAN[role].lbondTrust) continue;
      const acc = await loadAccount(ctx, keys[role].publicKey());
      const line = balanceLine(acc, lbond);
      if (!line?.is_authorized) {
        ops.push(Operation.setTrustLineFlags({ trustor: keys[role].publicKey(), asset: lbond, flags: { authorized: true } }));
        notes.push(`authorize ${role}`);
      }
      const have = Number(line?.balance ?? 0);
      if (PLAN[role].lbond > 0 && have < PLAN[role].lbond / 2) {
        ops.push(Operation.payment({ destination: keys[role].publicKey(), asset: lbond, amount: String(PLAN[role].lbond) }));
        notes.push(`pay ${fmt(String(PLAN[role].lbond))} LBOND to ${role}`);
      }
    }
    if (ops.length) {
      const r = await submitClassic(ctx, { source: issuer, ops, memo: 'lotus bot LBOND setup' });
      txs.lbond_issuer_tx = r.hash;
      log.act('setup', `rwa_issuer: ${notes.join(', ')}`, r.hash);
    } else {
      log.info('setup', 'LBOND: trustlines authorized and inventory in place');
    }
  }

  // ---------------------------------------------------------------- previous receipt -> USDC (after a deployment switch)
  // The faucet pays 1,000 USDC once per account, so the USDC locked in the old receipt is the bot's capital:
  // cancel the account's own offers that still reference it, then redeem it at par on the previous vault.
  const legacy = loadLegacyReceipt(env);
  if (legacy) {
    for (const role of BOT_ROLES) {
      const kp = keys[role];
      let line = balanceLine(await loadAccount(ctx, kp.publicKey()), legacy.receipt);
      if (!line || Number(line.balance) <= 0) continue;
      const pub = kp.publicKey();
      const sameAsset = (a) => a.asset_type !== 'native' && a.asset_code === legacy.receipt.getCode() && a.asset_issuer === legacy.receipt.getIssuer();
      const stale = (await ctx.horizon.offers().forAccount(pub).limit(200).call()).records.filter((o) => sameAsset(o.selling) || sameAsset(o.buying));
      if (stale.length) {
        const toAsset = (a) => (a.asset_type === 'native' ? Asset.native() : new Asset(a.asset_code, a.asset_issuer));
        const cancel = stale.slice(0, 100).map((o) => Operation.manageSellOffer({ selling: toAsset(o.selling), buying: toAsset(o.buying), amount: '0', price: { n: o.price_r.n, d: o.price_r.d }, offerId: o.id }));
        const r = await submitClassic(ctx, { source: kp, ops: cancel, memo: 'cancel legacy offers' });
        txs[`${role}_cancel_legacy_offers`] = r.hash;
        log.act('setup', `${role}: cancelled ${cancel.length} of its own offer(s) denominated in the previous receipt ${legacy.receipt.getCode()}`, r.hash);
        line = balanceLine(await loadAccount(ctx, pub), legacy.receipt);
      }
      const amount = toStroops(line.balance) - toStroops(line.selling_liabilities ?? '0');
      if (amount <= 0n) continue;
      try {
        const res = await invokeContract(ctx, { contractId: legacy.contractId, method: 'redeem', args: [addr(pub), i128(amount)], source: kp, label: `redeem legacy (${role})` });
        txs[`${role}_redeem_legacy`] = res.hash;
        log.act('setup', `${role}: redeemed ${fromStroops(amount)} ${legacy.receipt.getCode()} at par on the previous vault, got ${fromStroops(BigInt(res.returnValue ?? 0))} USDC, fee ${feeXlm(res.feeCharged)} XLM`, res.hash);
      } catch (e) {
        log.warn('setup', `${role}: could not redeem the previous receipt (${e.message.split('\n')[0]}); it stays in the account`);
      }
    }
  }

  // ---------------------------------------------------------------- USDC from the Blend faucet
  // The faucet (lib/blend-faucet.mjs) returns an issuer-signed tx with changeTrust+payment for every asset
  // the account has NO trustline for yet (USDC, BLND, wETH, wBTC). An account that already has a USDC trustline
  // gets no USDC (and a second call returns an empty tx). So: 1,000 USDC per account, and only for accounts
  // without a USDC trustline. An empty trustline is removed first so a previous attempt can be retried.
  for (const role of BOT_ROLES) {
    const kp = keys[role];
    const target = PLAN[role].usdc;
    let line = balanceLine(await loadAccount(ctx, kp.publicKey()), usdc);
    const have = Number(line?.balance ?? 0);
    if (have >= target * 0.05) {
      log.info('setup', `${role}: holds ${fmt(String(have))} USDC (faucet already used for this account)`);
      continue;
    }
    try {
      if (line) {
        const r = await submitClassic(ctx, { source: kp, ops: [Operation.changeTrust({ asset: usdc, limit: '0' })], memo: 'reset usdc trustline' });
        txs[`${role}_usdc_trust_reset`] = r.hash;
        log.act('setup', `${role}: removed the empty USDC trustline so the faucet treats the account as new for USDC`, r.hash);
      }
      const f = await blendFaucet(ctx, kp);
      txs[`${role}_faucet`] = f.hash;
      line = balanceLine(await loadAccount(ctx, kp.publicKey()), usdc);
      log.act('setup', `${role}: Blend testnet faucet paid, USDC balance now ${fmt(line?.balance ?? '0')}`, f.hash);
    } catch (e) {
      log.warn('setup', `${role}: faucet failed (${e.message.split('\n')[0]}); the account has ${fmt(String(have))} USDC`);
    }
  }

  // ---------------------------------------------------------------- lUSDC via deposit()
  for (const role of BOT_ROLES) {
    const want = PLAN[role].lusdc;
    if (want <= 0) continue;
    const kp = keys[role];
    const acc = await loadAccount(ctx, kp.publicKey());
    const haveL = Number(balanceLine(acc, lusdc)?.balance ?? 0);
    const haveU = Number(balanceLine(acc, usdc)?.balance ?? 0);
    if (haveL >= want * 0.9) {
      log.info('setup', `${role}: holds ${fmt(String(haveL))} ${RC} (target ${want})`);
      continue;
    }
    const amount = Math.floor(Math.min(want - haveL, haveU * 0.9)); // whole units: float remainders have too many decimals for stroops
    if (amount < 1) {
      log.warn('setup', `${role}: not enough USDC (${haveU}) to mint ${RC}`);
      continue;
    }
    try {
      const res = await invokeContract(ctx, {
        contractId: env.contractId,
        method: 'deposit',
        args: [addr(kp.publicKey()), i128(toStroops(String(amount)))],
        source: kp,
        label: `deposit(${role})`,
      });
      txs[`${role}_deposit`] = res.hash;
      log.act('setup', `${role}: deposit(${amount} USDC) minted ${amount} ${RC} at par, fee ${feeXlm(res.feeCharged)} XLM`, res.hash);
    } catch (e) {
      log.err('setup', `${role}: deposit failed: ${e.message.split('\n')[0]}`);
    }
  }

  // ---------------------------------------------------------------- record
  const balances = {};
  for (const role of BOT_ROLES) {
    const acc = await loadAccount(ctx, keys[role].publicKey());
    const g = (a) => balanceLine(acc, a)?.balance ?? '0';
    balances[role] = {
      XLM: acc.balances.find((b) => b.asset_type === 'native')?.balance,
      USDC: g(usdc),
      receipt: g(lusdc),
      LBOND: g(lbond),
      lbond_authorized: balanceLine(acc, lbond)?.is_authorized ?? false,
    };
  }
  const prev = loadBotJson();
  saveBotJson({
    network: 'testnet',
    purpose: originNote(),
    accounts: Object.fromEntries(BOT_ROLES.map((r) => [r, keys[r].publicKey()])),
    roles: purposeOf(),
    assets: {
      USDC: { code: usdc.getCode(), issuer: usdc.getIssuer() },
      receipt: { code: lusdc.getCode(), issuer: lusdc.getIssuer() },
      LBOND: { code: lbond.getCode(), issuer: lbond.getIssuer() },
    },
    lotus_vault_contract: env.contractId,
    legacy_receipt: legacy ? { code: legacy.receipt.getCode(), issuer: legacy.receipt.getIssuer(), contract: legacy.contractId } : null,
    setup: {
      at: new Date().toISOString(),
      plan: PLAN,
      balances_after_setup: balances,
      tx: { ...(prev.setup?.tx ?? {}), ...txs },
    },
  });

  log.head('Setup summary');
  log.table(
    ['account', 'address', 'XLM', 'USDC', `${RC}`, 'LBOND', 'LBOND auth'],
    BOT_ROLES.map((r) => [r, keys[r].publicKey(), fmt(balances[r].XLM), fmt(balances[r].USDC), fmt(balances[r].receipt), fmt(balances[r].LBOND), String(balances[r].lbond_authorized)]),
  );
  log.raw(`\nwrote ${BOT_JSON}`);
  log.raw(`secrets in ${BOT_SECRETS_JSON} (git-ignored)`);
  log.raw('next: npm run bot   |   npm run bot:depeg   |   npm run bot:demo');
  for (const [k, h] of Object.entries(txs)) log.raw(`  ${k.padEnd(22)} ${txUrl(h)}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  runSetup(parseArgs()).catch((e) => {
    console.error(`\nsetup failed: ${e?.stack ?? e}`);
    process.exit(1);
  });
}
