// USDC top-up for the bot accounts from the Blend testnet faucet, through a FRESH throwaway account.
//
// The faucet pays 1,000 USDC (plus BLND, wETH, wBTC) once per account that has no USDC trustline yet, so a bot account
// cannot ask twice. A new keypair can: friendbot funds it with XLM, the faucet pays it, and a plain payment forwards
// the USDC to the bot account that needs it. The throwaway key is not stored (it keeps the other faucet assets and
// some XLM, which is free testnet money). Every top-up is appended to deployments/testnet.bot.json (setup.topups).
//
//   node bot/lib/topup.mjs --to mm_a            one top-up into mm_a (CLI)
//   npm run bot:topup -- --to mm_b

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { blendFaucet } from '../../lib/blend-faucet.mjs';
import { balanceLine, explainHorizonError, friendbot } from '../../lib/stellar.mjs';
import { loadBotEnv, loadBotJson, saveBotJson } from './env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One faucet round through a fresh account; forwards `amount` USDC (default: all of it) to `toPub`.
 * Returns { from, amount, hashes: { friendbot?, faucet, forward } }.
 */
export async function faucetTopUp({ ctx, usdc, toPub, amount = null, log = () => {} }) {
  const kp = Keypair.random();
  await friendbot(ctx, kp.publicKey());
  log(`fresh account ${kp.publicKey()} funded by friendbot`);
  await sleep(1500);
  const f = await blendFaucet(ctx, kp);
  log(`Blend faucet paid the fresh account (tx ${f.hash})`);
  let have = 0;
  for (let i = 0; i < 6 && have <= 0; i++) {
    const acc = await ctx.horizon.loadAccount(kp.publicKey());
    have = Number(balanceLine(acc, usdc)?.balance ?? 0);
    if (have <= 0) await sleep(1500);
  }
  if (have <= 0) throw new Error('faucet transaction landed but the fresh account shows no USDC');
  const send = Math.min(have, amount ?? have);
  const acc = await ctx.horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: '1000', networkPassphrase: ctx.passphrase })
    .addOperation(Operation.payment({ destination: toPub, asset: usdc, amount: send.toFixed(7) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  try {
    const r = await ctx.horizon.submitTransaction(tx, { skipMemoRequiredCheck: true });
    return { from: kp.publicKey(), amount: send, hashes: { faucet: f.hash, forward: r.hash } };
  } catch (e) {
    throw new Error(`forwarding the faucet USDC failed: ${explainHorizonError(e)}`);
  }
}

/** Append a top-up record to testnet.bot.json (setup.topups). */
export function recordTopUp(rec) {
  try {
    const cur = loadBotJson().setup?.topups ?? [];
    saveBotJson({ setup: { topups: [...cur, { at: new Date().toISOString(), ...rec }].slice(-50) } });
  } catch {
    /* bookkeeping only */
  }
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isMain) {
  const i = process.argv.indexOf('--to');
  const label = i > 0 ? process.argv[i + 1] : 'mm_a';
  const env = loadBotEnv();
  if (!env.keys[label]) {
    console.error(`unknown bot account "${label}" (mm_a, mm_b, arb)`);
    process.exit(1);
  }
  const toPub = env.keys[label].publicKey();
  faucetTopUp({ ctx: env.ctx, usdc: env.usdc, toPub, log: (m) => console.log(m) })
    .then((r) => {
      recordTopUp({ to: label, amount: r.amount, via: r.from, txs: r.hashes, trigger: 'manual' });
      console.log(`topped up ${label} with ${r.amount} USDC | https://stellar.expert/explorer/testnet/tx/${r.hashes.forward}`);
    })
    .catch((e) => {
      console.error(`top-up failed: ${e.message}`);
      process.exit(1);
    });
}
