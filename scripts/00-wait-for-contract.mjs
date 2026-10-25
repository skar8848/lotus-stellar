#!/usr/bin/env node
// 00 - Wait for deployments/testnet.contract.json (written by the contract agent), then print a
// summary and sanity-check the deployment: contract methods, receipt SAC admin, keeper funding.
//
//   node scripts/00-wait-for-contract.mjs [--interval 120] [--max 7200]

import { CONTRACT_JSON, parseArgs, waitForContractJson } from './lib/config.mjs';
import { lotusContext, readViews } from './lib/lotus.mjs';
import { accountLink, assetLabel, contractLink, contractMethods, fromStroops, getBalance, Asset, fmt, readContract } from './lib/stellar.mjs';
import { h1, step, ok, info, kv, link, warn, fail, die } from './lib/log.mjs';

async function main() {
  const args = parseArgs();
  const intervalMs = Number(args.interval ?? 120) * 1000;
  const maxMs = Number(args.max ?? 7200) * 1000;

  h1('00 - waiting for the lotus_vault deployment');
  info(`polling ${CONTRACT_JSON}`);
  info(`every ${intervalMs / 1000}s for up to ${Math.round(maxMs / 60000)} min`);

  const c = await waitForContractJson({
    intervalMs,
    maxMs,
    onTick: (elapsed) => info(`${new Date().toISOString()} not there yet (${Math.round(elapsed / 60000)} min elapsed)`),
  });
  if (!c) die('timed out waiting for deployments/testnet.contract.json');

  ok('deployments/testnet.contract.json found');
  const lt = lotusContext();
  kv('network', lt.cfg.network);
  kv('lotus_vault', lt.contractId);
  link('contract', contractLink(lt.contractId));
  kv('underlying', `${assetLabel(lt.underlying)}${lt.underlying.isNative() ? ' (native)' : ' ' + lt.underlying.getIssuer()}`);
  kv('underlying SAC', lt.underlyingSac);
  kv('receipt', `${lt.receipt.getCode()} ${lt.receipt.getIssuer()}`);
  kv('receipt SAC', lt.receiptSac);
  kv('defindex_vault', lt.defindexVault ?? '(none)');
  for (const k of ['admin', 'keeper', 'issuer']) if (lt.accounts[k]) kv(k, lt.accounts[k]);

  step('contract methods (from the on-chain spec)');
  try {
    for (const m of await contractMethods(lt.ctx, lt.contractId)) info(m);
  } catch (e) {
    warn(`could not list methods: ${e.message}`);
  }

  step('sanity checks');
  try {
    const admin = await readContract(lt.ctx, { contractId: lt.receiptSac, method: 'admin', sourcePub: lt.readerPub });
    if (admin === lt.contractId) ok(`receipt SAC admin is the lotus_vault contract (can mint)`);
    else fail(`receipt SAC admin is ${admin}, expected ${lt.contractId}: deposit() will not be able to mint`);
  } catch (e) {
    warn(`could not read receipt SAC admin(): ${e.message}`);
  }
  try {
    const v = await readViews(lt);
    kv('supply()', `${fmt(fromStroops(v.supply))} ${lt.receipt.getCode()}`);
    kv('vault_value()', `${fmt(fromStroops(v.vaultValue))} ${assetLabel(lt.underlying)}`);
    kv('surplus()', `${fmt(fromStroops(v.surplus))} ${assetLabel(lt.underlying)}`);
  } catch (e) {
    fail(`views failed: ${e.message}`);
    if (e.diagnostics?.length) for (const d of e.diagnostics) info(d);
  }
  for (const k of ['admin', 'keeper']) {
    if (!lt.accounts[k]) continue;
    try {
      const b = await getBalance(lt.ctx, lt.accounts[k], Asset.native());
      kv(`${k} XLM`, fmt(b.balance));
      if (Number(b.balance) < 500) warn(`${k} has little XLM; Soroban calls touching Blend can cost ~100 XLM on testnet`);
      link(k, accountLink(lt.accounts[k]));
    } catch (e) {
      warn(`${k} account not found on Horizon: ${e.message}`);
    }
  }
  info('next: node scripts/03-mint-receipt.mjs');
}

main().catch((e) => die(e?.stack ?? String(e)));
