#!/usr/bin/env node
// 07 - Demo lever: simulate accrued yield by sending underlying straight to the lotus contract.
//
// Why: Blend testnet interest is tiny over a few minutes. vault_value() = DeFindex position + idle
// underlying held by the contract (see contracts/lotus_vault/src/lib.rs), so a donation of
// underlying to the contract address is indistinguishable from yield: surplus() rises by the same
// amount and 06 can distribute it. This is a SAC transfer(from, lotus_vault, amount) on the
// underlying's Stellar Asset Contract (classic payments cannot target a C... address).
//
//   --amount 5        underlying to donate
//   --from keeper     which secret pays (keeper | admin | taker | maker | peg_lp | ...)

import { parseArgs } from './lib/config.mjs';
import { lotusContext, readViews } from './lib/lotus.mjs';
import { ensureUnderlying } from './lib/blend-faucet.mjs';
import { addr, assetLabel, contractLink, feeXlm, fmt, fromStroops, i128, invokeContract, toStroops } from './lib/stellar.mjs';
import { h1, step, ok, info, kv, link, fail, die } from './lib/log.mjs';

async function main() {
  const args = parseArgs();
  const amount = String(args.amount ?? '5');
  const fromRole = String(args.from ?? 'keeper');
  h1(`07 - simulate yield: donate ${fmt(amount)} underlying to the lotus contract`);
  const lt = lotusContext();
  const uLabel = assetLabel(lt.underlying);
  const donor = lt.keypair(fromRole);
  kv('donor', `${fromRole} ${donor.publicKey()}`);
  kv('underlying SAC', lt.underlyingSac);
  kv('lotus_vault', lt.contractId);
  link('contract', contractLink(lt.contractId));

  const funding = await ensureUnderlying(lt.ctx, donor, lt.underlying, amount);
  if (funding.funded) ok(`${fromRole} topped up from the Blend faucet, now ${fmt(funding.line?.balance ?? '0')} ${uLabel}`);
  else if (!funding.line || Number(funding.line.balance) < Number(amount)) {
    die(`${fromRole} holds ${fmt(funding.line?.balance ?? '0')} ${uLabel}, needs ${amount} (${funding.reason ?? 'fund it first'})`);
  } else kv(`${fromRole} ${uLabel}`, fmt(funding.line.balance));

  step('before');
  const b = await readViews(lt);
  kv('vault_value()', `${fmt(fromStroops(b.vaultValue))} ${uLabel}`);
  kv('supply()', fmt(fromStroops(b.supply)));
  kv('surplus()', `${fmt(fromStroops(b.surplus))} ${uLabel}`);

  step(`SAC transfer(${fromRole} -> lotus_vault, ${fmt(amount)} ${uLabel})`);
  try {
    const res = await invokeContract(lt.ctx, {
      contractId: lt.underlyingSac,
      method: 'transfer',
      args: [addr(donor.publicKey()), addr(lt.contractId), i128(toStroops(amount))],
      source: donor,
      label: 'transfer',
    });
    ok('transfer confirmed');
    kv('fee charged', `${feeXlm(res.feeCharged)} XLM`);
    link('tx', res.link);
  } catch (e) {
    fail(e.message);
    if (e.diagnostics?.length) for (const d of e.diagnostics) info('  ' + d);
    process.exit(1);
  }

  step('after');
  const a = await readViews(lt);
  kv('vault_value()', `${fmt(fromStroops(a.vaultValue))} ${uLabel}  (${fromStroops(a.vaultValue - b.vaultValue)})`);
  kv('supply()', fmt(fromStroops(a.supply)));
  kv('surplus()', `${fmt(fromStroops(a.surplus))} ${uLabel}  (${fromStroops(a.surplus - b.surplus)})`);
  if (a.surplus > b.surplus) {
    ok('surplus() counted the idle underlying: the keeper can now distribute it');
    info('next: node scripts/06-keeper-distribute.mjs');
  } else {
    fail('surplus() did not move: check with the contract agent whether vault_value() counts idle underlying');
  }
}

main().catch((e) => die(e?.stack ?? String(e)));
