#!/usr/bin/env node
// 05 - The taker buys the tokenized bond with plain underlying, in ONE transaction, through the
// yield-bearing receipt: pathPaymentStrictSend  underlying -> receipt -> LBOND  (path = [receipt]).
// Then the unauthorized `blocked_taker` tries the same and is rejected by the issuer's AUTH_REQUIRED.
//
// What it proves:
//   - the receipt is a routing asset on the native DEX: a USDC/XLM holder never needs to hold it
//   - fills hit the peg book (peg_lp) and the maker's ladder; the maker is paid in receipt that
//     immediately starts earning yield (see 06)
//   - compliance: an account that is not whitelisted by the LBOND issuer cannot receive LBOND,
//     whether through a DEX path or a direct payment (op_not_authorized)
//
//   --amount 150     underlying to send
//   --skip-blocked   skip the compliance demo

import { parseArgs, saveClassic } from './lib/config.mjs';
import { lotusContext } from './lib/lotus.mjs';
import {
  Asset,
  ClassicTxError,
  Operation,
  accountLink,
  assetLabel,
  balanceLine,
  fmt,
  horizonTxLink,
  loadAccount,
  parsePathPaymentStrictSend,
  submitClassic,
} from './lib/stellar.mjs';
import { printBook } from './04-seed-book.mjs';
import { h1, step, ok, info, kv, link, warn, fail, table, die, short } from './lib/log.mjs';

async function main() {
  const args = parseArgs();
  h1('05 - taker buys LBOND with the underlying through the receipt (one path payment)');
  const lt = lotusContext();
  const { ctx, underlying, receipt } = lt;
  const rwa = lt.cfg.classic.rwa;
  if (!rwa) die('LBOND not issued yet: run scripts/02-issue-rwa.mjs first');
  const lbond = new Asset(rwa.code, rwa.issuer);
  const uLabel = assetLabel(underlying);
  const rLabel = receipt.getCode();
  const sendAmount = String(args.amount ?? '150');
  const taker = lt.keypair('taker');
  const txs = {};

  // ---------------------------------------------------------------- before
  step(`taker ${taker.publicKey()} before`);
  link('account', accountLink(taker.publicKey()));
  let acc = await loadAccount(ctx, taker.publicKey());
  const uBefore = balanceLine(acc, underlying);
  const bBefore = balanceLine(acc, lbond);
  const rBefore = balanceLine(acc, receipt);
  kv(`${uLabel}`, fmt(uBefore?.balance ?? '0'));
  kv(`${rwa.code}`, `${fmt(bBefore?.balance ?? '0')}  (authorized: ${bBefore?.is_authorized})`);
  kv(`${rLabel}`, fmt(rBefore?.balance ?? '0'));
  if (!uBefore || Number(uBefore.balance) < Number(sendAmount) + (underlying.isNative() ? 5 : 0)) {
    die(`taker needs >= ${sendAmount} ${uLabel}`);
  }

  // ---------------------------------------------------------------- path finding (Horizon)
  step(`Horizon strict-send path finding: ${fmt(sendAmount)} ${uLabel} -> ${rwa.code}`);
  let destMin = '0.0000001';
  let estimated = null;
  try {
    const paths = await ctx.horizon.strictSendPaths(underlying, sendAmount, [lbond]).call();
    const viaReceipt = paths.records.filter((p) => p.path.some((a) => a.asset_code === rLabel));
    const best = (viaReceipt.length ? viaReceipt : paths.records).sort(
      (a, b) => Number(b.destination_amount) - Number(a.destination_amount),
    )[0];
    if (best) {
      estimated = best.destination_amount;
      destMin = (Math.floor(Number(estimated) * 0.99 * 1e7) / 1e7).toFixed(7);
      kv('best route', `${uLabel} -> ${best.path.map((a) => a.asset_code ?? 'XLM').join(' -> ')} -> ${rwa.code}`);
      kv('estimated out', `${fmt(estimated)} ${rwa.code}`);
      kv('destMin (99%)', fmt(destMin));
    } else warn('Horizon found no path; submitting with a minimal destMin anyway');
  } catch (e) {
    warn(`path finding failed (${e.message}); submitting with a minimal destMin`);
  }

  // ---------------------------------------------------------------- the trade
  step(`pathPaymentStrictSend: send ${fmt(sendAmount)} ${uLabel}, path [${rLabel}], receive ${rwa.code}`);
  let res;
  try {
    res = await submitClassic(ctx, {
      source: taker,
      ops: [
        Operation.pathPaymentStrictSend({
          sendAsset: underlying,
          sendAmount,
          destination: taker.publicKey(),
          destAsset: lbond,
          destMin,
          path: [receipt],
        }),
      ],
      memo: 'lotus: buy bond via receipt',
    });
  } catch (e) {
    fail(`path payment failed: ${e.message}`);
    if (e instanceof ClassicTxError && e.codes?.operations?.length) {
      info(`operation codes: ${e.codes.operations.join(', ')}`);
    }
    process.exit(1);
  }
  txs.path_payment = res.hash;
  ok(`filled in one transaction`);
  link('tx', res.link);
  link('horizon', horizonTxLink(ctx, res.hash));

  const parsed = parsePathPaymentStrictSend(res.result);
  if (parsed.ok) {
    info('fills (each row = one resting offer consumed):');
    table(
      ['hop', 'resting offer by', 'role', 'offer id', 'taker paid', 'taker received'],
      parsed.fills.map((f, i) => [
        String(i + 1),
        short(f.seller, 6),
        lt.roleOf(f.seller) ?? '?',
        f.offerId,
        `${fmt(f.amountBought)} ${assetLabel(f.assetBought)}`,
        `${fmt(f.amountSold)} ${assetLabel(f.assetSold)}`,
      ]),
    );
    kv('delivered', `${fmt(parsed.delivered.amount)} ${assetLabel(parsed.delivered.asset)} to ${short(parsed.delivered.destination, 6)} (taker)`);
    if (estimated) kv('vs estimate', `${fmt(estimated)} ${rwa.code}`);
    const effPrice = Number(sendAmount) / Number(parsed.delivered.amount);
    kv('effective price', `${effPrice.toFixed(4)} ${uLabel} per ${rwa.code} (bond trading near par)`);
  }

  acc = await loadAccount(ctx, taker.publicKey());
  const uAfter = balanceLine(acc, underlying);
  const bAfter = balanceLine(acc, lbond);
  const rAfter = balanceLine(acc, receipt);
  step('taker after');
  kv(`${uLabel}`, `${fmt(uAfter.balance)}  (${(Number(uAfter.balance) - Number(uBefore.balance)).toFixed(7)})`);
  kv(`${rwa.code}`, `${fmt(bAfter.balance)}  (+${(Number(bAfter.balance) - Number(bBefore?.balance ?? 0)).toFixed(7)})`);
  kv(`${rLabel}`, `${fmt(rAfter?.balance ?? '0')}  (never held: the receipt was only a hop)`);

  // the maker got paid in receipt, which is now earning yield (script 06 shows it)
  const makerAcc = await loadAccount(ctx, lt.accounts.maker);
  const makerR = balanceLine(makerAcc, receipt);
  step(`maker ${short(lt.accounts.maker, 6)} was paid in ${rLabel}`);
  kv(`${rLabel} balance`, `${fmt(makerR.balance)}  (selling_liabilities ${fmt(makerR.selling_liabilities)})`);
  info(`this ${rLabel} is a yield-bearing claim on the Blend position: run 06 to see the keeper pay the maker`);

  await printBook(ctx, lbond, receipt, { title: `order book ${rwa.code}/${rLabel} after the fill (lower rungs consumed)` });

  // ---------------------------------------------------------------- compliance demo
  if (!args['skip-blocked']) {
    const blocked = lt.keypair('blocked_taker');
    step(`compliance: blocked_taker ${blocked.publicKey()} (trustline NOT authorized by the issuer)`);
    link('account', accountLink(blocked.publicKey()));
    const bAcc = await loadAccount(ctx, blocked.publicKey());
    const bLine = balanceLine(bAcc, lbond);
    const bU = balanceLine(bAcc, underlying);
    kv(`${rwa.code} trustline`, `exists=${Boolean(bLine)} is_authorized=${bLine?.is_authorized}`);
    kv(`${uLabel} balance`, fmt(bU?.balance ?? '0'));

    // (1) same path payment as the taker
    const smallSend = underlying.isNative() ? '10' : String(Math.min(10, Number(bU?.balance ?? 0)));
    if (bU && Number(bU.balance) >= Number(smallSend) && Number(smallSend) > 0) {
      info(`attempt 1: pathPaymentStrictSend ${smallSend} ${uLabel} -> ${rLabel} -> ${rwa.code} ...`);
      try {
        const r = await submitClassic(ctx, {
          source: blocked,
          ops: [
            Operation.pathPaymentStrictSend({
              sendAsset: underlying,
              sendAmount: smallSend,
              destination: blocked.publicKey(),
              destAsset: lbond,
              destMin: '0.0000001',
              path: [receipt],
            }),
          ],
          memo: 'blocked taker attempt',
        });
        fail(`unexpected: the trade went through (${r.link})`);
      } catch (e) {
        if (e instanceof ClassicTxError) {
          ok(`rejected by the network: ${e.message}`);
          info('op_not_authorized = the LBOND issuer never authorized this trustline; the whole path payment is atomic, nothing was traded');
          txs.blocked_path_payment_attempt = e.hash;
        } else throw e;
      }
    } else {
      warn(`blocked_taker holds no ${uLabel}; skipping the path payment attempt`);
    }

    // (2) a direct payment of LBOND from the authorized taker to blocked_taker
    info(`attempt 2: taker pays 1 ${rwa.code} directly to blocked_taker ...`);
    try {
      const r = await submitClassic(ctx, {
        source: taker,
        ops: [Operation.payment({ destination: blocked.publicKey(), asset: lbond, amount: '1' })],
        memo: 'payment to blocked',
      });
      fail(`unexpected: the payment went through (${r.link})`);
    } catch (e) {
      if (e instanceof ClassicTxError) {
        ok(`rejected by the network: ${e.message}`);
        info('the transfer restriction is enforced by the protocol itself, not by the app');
      } else throw e;
    }
  }

  saveClassic({ tx: { demo_take: txs }, demo_take: { send_amount: sendAmount, estimated_out: estimated } });
  ok('wrote deployments/testnet.classic.json');
  info('next: node scripts/06-keeper-distribute.mjs');
}

main().catch((e) => die(e?.stack ?? String(e)));
