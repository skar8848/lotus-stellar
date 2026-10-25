#!/usr/bin/env node
// 03 - Mint the yield-bearing receipt: deposit underlying into lotus_vault, get receipt 1:1.
//
// What it proves: the Soroban contract is the SAC admin of a CLASSIC asset. deposit(from, amount)
// pulls the underlying (lent on Blend through DeFindex) and mints `amount` receipt to a plain
// Stellar account, which can then use it on the native orderbook like any other asset.
//
//   maker  : small deposit  (inventory to receive receipt from its bond ladder)   --maker <amt>
//   peg_lp : large deposit  (seeds the underlying/receipt peg book)                --peg <amt>
//   taker  : trustline only (the taker holds only the underlying, by design)
//   --force : deposit even if the account already holds receipt

import { parseArgs, saveClassic } from './lib/config.mjs';
import { lotusContext, readViews } from './lib/lotus.mjs';
import { ensureUnderlying, isBlendUsdc } from './lib/blend-faucet.mjs';
import {
  Asset,
  accountLink,
  addr,
  assetLabel,
  assetLink,
  balanceLine,
  contractLink,
  ensureTrustline,
  feeXlm,
  fmt,
  fromStroops,
  i128,
  invokeContract,
  loadAccount,
  toStroops,
  txLink,
} from './lib/stellar.mjs';
import { h1, step, ok, info, kv, link, warn, fail, die } from './lib/log.mjs';

const XLM_FEE_RESERVE = 2000; // keep >= 2,000 XLM per account for Soroban fees on testnet

async function main() {
  const args = parseArgs();
  h1('03 - mint receipt via lotus_vault.deposit()');
  const lt = lotusContext();
  const { ctx, underlying, receipt } = lt;
  const native = underlying.isNative();
  const uLabel = assetLabel(underlying);
  const rLabel = receipt.getCode();

  kv('lotus_vault', lt.contractId);
  link('contract', contractLink(lt.contractId));
  kv('underlying', native ? 'XLM (native)' : `${uLabel}:${underlying.getIssuer()}`);
  kv('receipt', `${rLabel}:${receipt.getIssuer()}`);
  link('receipt asset', assetLink(receipt));

  const plan = [
    ['maker', String(args.maker ?? '100')],
    ['peg_lp', String(args.peg ?? (native ? '1000' : '500'))],
    ['taker', null],
  ];
  const txs = {};

  // ---- underlying: friendbot only gives XLM; Blend testnet USDC comes from the Blend faucet
  if (isBlendUsdc(underlying)) {
    step(`fund the demo accounts with Blend testnet ${uLabel} (faucet: 1,000 ${uLabel} per account)`);
    for (const role of ['maker', 'peg_lp', 'taker', 'blocked_taker']) {
      const kp = lt.keypair(role);
      try {
        const r = await ensureUnderlying(ctx, kp, underlying, role === 'blocked_taker' ? '10' : '150');
        if (r.funded) {
          ok(`${role}: faucet paid, now ${fmt(r.line?.balance ?? '0')} ${uLabel}`);
          link('tx', `https://stellar.expert/explorer/testnet/tx/${r.hash}`);
          txs[`${role}_faucet`] = r.hash;
        } else ok(`${role}: holds ${fmt(r.line?.balance ?? '0')} ${uLabel}`);
      } catch (e) {
        warn(`${role}: faucet failed (${e.message})`);
      }
    }
  }

  for (const [role, amount] of plan) {
    const kp = lt.keypair(role);
    const pub = kp.publicKey();
    step(`${role} ${pub}`);
    link('account', accountLink(pub));

    // 1. trustline to the receipt (classic asset)
    const h = await ensureTrustline(ctx, kp, receipt);
    if (h) {
      ok(`trustline to ${rLabel} opened`);
      link('tx', txLink(h));
      txs[`${role}_trust_receipt`] = h;
    } else ok(`trustline to ${rLabel} exists`);

    let acc = await loadAccount(ctx, pub);
    const uLine = balanceLine(acc, underlying);
    const rLine = balanceLine(acc, receipt);
    kv(`${uLabel} balance`, uLine ? fmt(uLine.balance) : '(no trustline)');
    kv(`${rLabel} balance`, rLine ? fmt(rLine.balance) : '0');
    if (rLine && rLine.is_authorized === false) {
      fail(`${role}'s ${rLabel} trustline is not authorized; the receipt issuer must not use AUTH_REQUIRED`);
    }

    if (amount === null) {
      info(`no deposit: the ${role} keeps only the underlying and will buy LBOND through the peg book`);
      continue;
    }

    // 2. make sure the account holds the underlying
    if (!uLine || Number(uLine.balance) <= 0) {
      fail(`${role} holds no ${uLabel}.`);
      if (!native) {
        info(`The underlying is ${uLabel}:${underlying.getIssuer()} (not native, friendbot cannot help).`);
        info(`Fund ${pub} with ${uLabel} first, then re-run this script.`);
        if (isBlendUsdc(underlying)) {
          info(`Blend faucet (what this script tried): curl -H "Origin: https://testnet.blend.capital" \\`);
          info(`  "https://ewqw4hx7oa.execute-api.us-east-1.amazonaws.com/getAssets?userId=${pub}" -> sign + submit the XDR`);
        }
      }
      process.exit(1);
    }
    let depositAmt = amount;
    const available = native ? Number(uLine.balance) - XLM_FEE_RESERVE : Number(uLine.balance);
    if (Number(depositAmt) > available) {
      if (available <= 0) {
        fail(`${role} has ${fmt(uLine.balance)} ${uLabel}; nothing left to deposit after the ${XLM_FEE_RESERVE} XLM fee reserve`);
        process.exit(1);
      }
      warn(`requested ${fmt(depositAmt)} but only ${fmt(String(available))} ${uLabel} available; depositing that`);
      depositAmt = String(Math.floor(available));
    }
    if (rLine && Number(rLine.balance) >= Number(depositAmt) && !args.force) {
      ok(`already holds ${fmt(rLine.balance)} ${rLabel} (>= ${fmt(depositAmt)}); skipping deposit (use --force to add more)`);
      continue;
    }

    // 3. deposit(from, amount) -> contract pulls the underlying, invests it, mints receipt 1:1
    info(`calling deposit(${role}, ${fmt(depositAmt)} ${uLabel}) ...`);
    try {
      const res = await invokeContract(ctx, {
        contractId: lt.contractId,
        method: 'deposit',
        args: [addr(pub), i128(toStroops(depositAmt))],
        source: kp,
        label: `deposit(${role})`,
      });
      txs[`${role}_deposit`] = res.hash;
      ok(`deposit confirmed; df shares received: ${res.returnValue?.toString?.() ?? res.returnValue}`);
      kv('fee charged', `${feeXlm(res.feeCharged)} XLM`);
      link('tx', res.link);
    } catch (e) {
      fail(e.message);
      if (e.diagnostics?.length) {
        info('diagnostic events:');
        for (const d of e.diagnostics) info('  ' + d);
      }
      if (e.link) link('tx', e.link);
      process.exit(1);
    }
    acc = await loadAccount(ctx, pub);
    const after = balanceLine(acc, receipt);
    kv(`${rLabel} balance`, `${fmt(after?.balance ?? '0')}  (minted 1:1 for ${fmt(depositAmt)} ${uLabel})`);
    kv(`${uLabel} balance`, fmt(balanceLine(acc, underlying)?.balance ?? '0'));
  }

  step('contract state');
  try {
    const v = await readViews(lt);
    kv('supply()', `${fmt(fromStroops(v.supply))} ${rLabel}`);
    kv('vault_value()', `${fmt(fromStroops(v.vaultValue))} ${uLabel}`);
    kv('surplus()', `${fmt(fromStroops(v.surplus))} ${uLabel}  (yield not yet distributed)`);
  } catch (e) {
    warn(`views failed: ${e.message}`);
  }

  saveClassic({
    receipt: { code: receipt.getCode(), issuer: receipt.getIssuer(), sac: lt.receiptSac },
    underlying: { code: uLabel, issuer: native ? null : underlying.getIssuer(), sac: lt.underlyingSac },
    deposits: Object.fromEntries(plan.filter(([, a]) => a !== null).map(([r, a]) => [r, a])),
    tx: { mint_receipt: txs },
  });
  ok('wrote deployments/testnet.classic.json');
  info('next: node scripts/04-seed-book.mjs');
}

main().catch((e) => die(e?.stack ?? String(e)));
