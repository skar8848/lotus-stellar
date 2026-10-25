#!/usr/bin/env node
// 06 - Keeper: distribute accrued yield to every receipt holder, pro-rata, including receipt that is
// locked in open SDEX offers.
//
// What it proves: surplus() = vault_value() - supply() is the yield earned on Blend (via DeFindex)
// that has not been minted yet. The keeper lists holders off-chain (Horizon /accounts?asset=...),
// computes floor(surplus * balance_i / supply) exactly like the contract's on-chain cap, and calls
// distribute(recipients, amounts) signed by the keeper. The contract re-checks every line against
// the cap, so a buggy or malicious keeper can only omit holders, never over-pay.
// Holder balances include selling_liabilities: the maker's quoted inventory earns yield.
//
//   --loop <seconds>   run forever, every N seconds
//   --dry-run          compute and print, do not submit
//   --min <amount>     do nothing while surplus < amount (default 0.0000001)

import { parseArgs, saveClassic } from './lib/config.mjs';
import { chunk, computeProRata, lotusContext, readViews, receiptHolders } from './lib/lotus.mjs';
import {
  accountLink,
  assetLabel,
  balanceLine,
  contractLink,
  feeXlm,
  fmt,
  fromStroops,
  horizonHoldersLink,
  invokeContract,
  listOffers,
  loadAccount,
  toStroops,
  vecAddr,
  vecI128,
} from './lib/stellar.mjs';
import { h1, step, ok, info, kv, link, warn, fail, table, die, short } from './lib/log.mjs';

const MAX_RECIPIENTS_PER_CALL = 20;

async function snapshotMaker(lt) {
  const acc = await loadAccount(lt.ctx, lt.accounts.maker);
  const line = balanceLine(acc, lt.receipt);
  const offers = await listOffers(lt.ctx, lt.accounts.maker);
  return {
    balance: line?.balance ?? '0',
    selling: line?.selling_liabilities ?? '0',
    offers: offers.length,
    offersInReceipt: offers.filter((o) => o.buying?.asset_code === lt.receipt.getCode()).length,
  };
}

async function runOnce(lt, args) {
  const { ctx, receipt, underlying } = lt;
  const rLabel = receipt.getCode();
  const uLabel = assetLabel(underlying);
  const keeper = lt.keypair('keeper');
  const minSurplus = toStroops(String(args.min ?? '0.0000001'));

  step('contract views');
  const v = await readViews(lt);
  kv('supply()', `${fmt(fromStroops(v.supply))} ${rLabel}`);
  kv('vault_value()', `${fmt(fromStroops(v.vaultValue))} ${uLabel}`);
  kv('surplus()', `${fmt(fromStroops(v.surplus))} ${uLabel}`);
  link('contract', contractLink(lt.contractId));

  if (v.surplus < minSurplus) {
    warn(`surplus is ${fmt(fromStroops(v.surplus))} ${uLabel}: nothing to distribute yet.`);
    info('Blend testnet interest accrues slowly and only per-ledger-touch. To show the full loop in the demo:');
    info('  node scripts/07-simulate-yield.mjs --amount 5   (sends 5 underlying to the lotus contract;');
    info('  vault_value() counts idle underlying held by the contract, so surplus() rises immediately)');
    info('then re-run this script.');
    return { distributed: 0n };
  }
  if (v.supply <= 0n) {
    warn('supply() is 0: nobody holds the receipt yet (run 03)');
    return { distributed: 0n };
  }

  step(`receipt holders (Horizon /accounts?asset=${rLabel}:${short(receipt.getIssuer())}, balances re-read from RPC)`);
  link('horizon', horizonHoldersLink(ctx, receipt));
  const holders = await receiptHolders(lt);
  const sumHolders = holders.reduce((s, h) => s + h.stroops, 0n);
  table(
    ['holder', 'role', `${rLabel} balance`, 'locked in offers', 'share'],
    holders.map((h) => [
      short(h.account, 6),
      h.role ?? '?',
      fmt(fromStroops(h.stroops)),
      fmt(fromStroops(h.selling_liabilities)),
      v.supply > 0n ? `${(Number((h.stroops * 10000n) / v.supply) / 100).toFixed(2)}%` : '-',
    ]),
  );
  kv('sum of balances', `${fmt(fromStroops(sumHolders))} ${rLabel} (supply ${fmt(fromStroops(v.supply))})`);
  if (sumHolders > v.supply) warn('holders sum exceeds supply(); amounts will be trimmed');
  for (const h of holders.filter((x) => x.selling_liabilities > 0n)) {
    info(`${h.role ?? short(h.account, 6)}: ${fmt(fromStroops(h.selling_liabilities))} ${rLabel} sits in an open SDEX offer and still counts toward its share`);
  }

  const before = await snapshotMaker(lt);

  step('pro-rata plan: amount_i = floor(surplus * balance_i / supply)');
  const plan = computeProRata(v.surplus, v.supply, holders);
  const planTotal = plan.reduce((s, l) => s + l.amount, 0n);
  table(
    ['recipient', 'role', `yield (${rLabel})`],
    plan.map((l) => [short(l.account, 6), l.role ?? '?', fromStroops(l.amount)]),
  );
  kv('total', `${fromStroops(planTotal)} ${rLabel} of ${fromStroops(v.surplus)} surplus (dust ${fromStroops(v.surplus - planTotal)} stays in the vault)`);
  if (!plan.length) {
    warn('nothing to mint (all shares round to zero)');
    return { distributed: 0n };
  }
  if (args['dry-run']) {
    warn('--dry-run: not submitting');
    return { distributed: 0n };
  }

  // ---------------------------------------------------------------- distribute
  const chunks = chunk(plan, MAX_RECIPIENTS_PER_CALL);
  let distributed = 0n;
  const hashes = [];
  for (let i = 0; i < chunks.length; i++) {
    let lines = chunks[i];
    if (i > 0) {
      // surplus shrank and supply grew with the previous call: recompute this chunk's caps
      const fresh = await readViews(lt);
      lines = computeProRata(fresh.surplus, fresh.supply, lines.map((l) => ({ ...l, amount: undefined })));
      if (!lines.length) break;
    }
    step(`distribute() call ${i + 1}/${chunks.length}: ${lines.length} recipient(s), signed by keeper ${short(keeper.publicKey(), 6)}`);
    try {
      const res = await invokeContract(ctx, {
        contractId: lt.contractId,
        method: 'distribute',
        args: [vecAddr(lines.map((l) => l.account)), vecI128(lines.map((l) => l.amount))],
        source: keeper,
        label: 'distribute',
      });
      const minted = BigInt(res.returnValue ?? 0);
      distributed += minted;
      hashes.push(res.hash);
      ok(`minted ${fromStroops(minted)} ${rLabel} of yield to ${lines.length} holder(s)`);
      kv('fee charged', `${feeXlm(res.feeCharged)} XLM`);
      link('tx', res.link);
    } catch (e) {
      fail(e.message);
      if (e.diagnostics?.length) for (const d of e.diagnostics) info('  ' + d);
      if (e.link) link('tx', e.link);
      throw e;
    }
  }

  // ---------------------------------------------------------------- maker before/after
  const after = await snapshotMaker(lt);
  step(`maker ${short(lt.accounts.maker, 6)}: before vs after (offers untouched)`);
  link('account', accountLink(lt.accounts.maker));
  table(
    ['', `${rLabel} balance`, 'locked in offers', 'open offers'],
    [
      ['before', fmt(before.balance), fmt(before.selling), String(before.offers)],
      ['after', fmt(after.balance), fmt(after.selling), String(after.offers)],
    ],
  );
  const grew = toStroops(after.balance) - toStroops(before.balance);
  if (grew > 0n) {
    ok(`the maker's ${rLabel} balance grew by ${fromStroops(grew)} while its ${after.offers} offer(s) stayed open`);
    info('quoted inventory keeps earning: SDEX offers only reserve funds (selling_liabilities), they never leave the account');
  }

  const v2 = await readViews(lt);
  kv('surplus() now', `${fmt(fromStroops(v2.surplus))} ${uLabel}`);
  kv('supply() now', `${fmt(fromStroops(v2.supply))} ${rLabel}`);
  saveClassic({
    tx: { keeper_distribute: { last: hashes, at: new Date().toISOString() } },
    last_distribution: { total: fromStroops(distributed), recipients: plan.length },
  });
  return { distributed };
}

async function main() {
  const args = parseArgs();
  h1('06 - keeper: distribute yield pro-rata to receipt holders');
  const lt = lotusContext();
  const loopSec = args.loop ? Number(args.loop) : 0;
  for (;;) {
    try {
      await runOnce(lt, args);
    } catch (e) {
      if (!loopSec) throw e;
      fail(`iteration failed: ${e.message}`);
    }
    if (!loopSec) break;
    info(`\n--loop: sleeping ${loopSec}s (Ctrl-C to stop)`);
    await new Promise((r) => setTimeout(r, loopSec * 1000));
    h1(`06 - keeper tick ${new Date().toISOString()}`);
  }
}

main().catch((e) => die(e?.stack ?? String(e)));
