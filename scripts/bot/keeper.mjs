// Keeper step: distribute the interest the vault has earned (surplus = vault_value - supply) to every holder of the
// receipt, pro rata, and show each holder's balance before and after. It is the logic of scripts/06-keeper-distribute.mjs
// (reused from scripts/lib/lotus.mjs, not copied): holders from Horizon, balances re-read from RPC, amounts
// floor(surplus * balance / supply) exactly like the contract's on-chain cap, 20 recipients per call, signed by the
// keeper key of deployments/testnet.secrets.json.
//
// Why it is in the demo: SDEX offers never move funds off the account, so a receipt that sits in an open offer
// (mm_a's bids and peg ask) is still counted by the vault and earns the interest. The table highlights those accounts.
//
// vault_value() / surplus() / supply() are only ever SIMULATED (readContract), never submitted as transactions.

import { chunk, computeProRata, lotusContext, readViews, receiptHolders } from '../lib/lotus.mjs';
import { feeXlm, fromStroops, invokeContract, vecAddr, vecI128 } from '../lib/stellar.mjs';
import { RC } from './lib/names.mjs';
import { txUrl } from './lib/log.mjs';
import { firstLine } from './lib/bot.mjs';
import { sleep } from './lib/limiter.mjs';

const MAX_PER_CALL = 20;
const n7 = (stroops) => Number(stroops) / 1e7;

async function holdersWithRoles(bot, lt) {
  const rows = await receiptHolders(lt);
  return rows
    .map((h) => ({ ...h, role: bot.who(h.account) }))
    .sort((a, b) => (b.stroops > a.stroops ? 1 : b.stroops < a.stroops ? -1 : 0));
}

/**
 * Distribute the surplus and print before/after per holder. Returns { distributed (stroops), hashes, before, after }.
 * `minSurplus` in stroops: below it nothing is sent.
 */
export async function keeperStep(bot, { minSurplus = 1n } = {}) {
  const { log, settings: s, stats } = bot;
  const lt = lotusContext(); // same context as scripts 03-07: reads testnet.contract.json (the active deployment) + the secrets
  const keeper = lt.keypair('keeper');
  const out = { distributed: 0n, hashes: [], before: [], after: [] };

  log.head(`Keeper: distribute the interest to every ${RC} holder`);
  const v0 = await readViews(lt); // simulation only
  const rate = Number(v0.vaultValue) / Number(v0.supply);
  log.raw(`  supply() ${fromStroops(v0.supply)} ${RC} | vault_value() ${fromStroops(v0.vaultValue)} USDC | surplus() ${fromStroops(v0.surplus)} USDC (vault/supply ${(rate * 100).toFixed(6)}%)`);
  const before = await holdersWithRoles(bot, lt);
  out.before = before;

  const plan = computeProRata(v0.surplus, v0.supply, before);
  const planTotal = plan.reduce((x, l) => x + l.amount, 0n);
  if (v0.surplus < minSurplus || !plan.length) {
    log.raw(`  surplus is ${fromStroops(v0.surplus)} USDC: ${plan.length ? 'below the minimum' : 'every share rounds to zero'}, nothing to distribute yet (interest accrues per ledger touch).`);
    printHolders(bot, before, null, new Map());
    return out;
  }
  log.raw(`  plan: mint ${fromStroops(planTotal)} ${RC} to ${plan.length} holder(s) (dust ${fromStroops(v0.surplus - planTotal)} stays in the vault)`);
  if (s.dryRun) {
    log.dry('keeper', 'would call distribute() with the plan above');
    printHolders(bot, before, null, new Map(plan.map((l) => [l.account, l.amount])));
    return out;
  }

  const chunks = chunk(plan, MAX_PER_CALL);
  for (let i = 0; i < chunks.length; i++) {
    let lines = chunks[i];
    if (i > 0) {
      const fresh = await readViews(lt);
      lines = computeProRata(fresh.surplus, fresh.supply, lines.map((l) => ({ ...l, amount: undefined })));
      if (!lines.length) break;
    }
    try {
      const res = await invokeContract(lt.ctx, {
        contractId: lt.contractId,
        method: 'distribute',
        args: [vecAddr(lines.map((l) => l.account)), vecI128(lines.map((l) => l.amount))],
        source: keeper,
        label: 'distribute',
      });
      const minted = BigInt(res.returnValue ?? 0);
      out.distributed += minted;
      out.hashes.push(res.hash);
      stats.txOk += 1;
      stats.ops += 1;
      stats.recordTx('keeper', 'soroban:distribute', res.hash);
      stats.addFee('keeper', res.feeCharged);
      log.act('keeper', `distribute() call ${i + 1}/${chunks.length}: minted ${fromStroops(minted)} ${RC} of interest to ${lines.length} holder(s), fee ${feeXlm(res.feeCharged)} XLM`, res.hash);
    } catch (e) {
      stats.txFail += 1;
      stats.error('soroban:distribute');
      log.err('keeper', `distribute() failed: ${firstLine(e)}`);
      break;
    }
  }

  await sleep(3500); // let Horizon index the new balances (bot.sleep would return at once: the bot is already stopping)
  const after = await holdersWithRoles(bot, lt);
  out.after = after;
  const paid = new Map();
  for (const h of after) {
    const b = before.find((x) => x.account === h.account);
    const d = h.stroops - (b?.stroops ?? 0n);
    if (d !== 0n) paid.set(h.account, d);
  }
  printHolders(bot, before, after, paid);
  const v1 = await readViews(lt);
  log.raw(`  after: supply() ${fromStroops(v1.supply)} ${RC} | vault_value() ${fromStroops(v1.vaultValue)} USDC | surplus() ${fromStroops(v1.surplus)} USDC`);
  for (const h of hashesOf(out)) log.raw(`  tx ${txUrl(h)}`);
  return out;
}

const hashesOf = (out) => out.hashes;

function printHolders(bot, before, after, paid) {
  const { log } = bot;
  const afterBy = new Map((after ?? []).map((h) => [h.account, h]));
  const rows = before.map((h) => {
    const a = afterBy.get(h.account);
    const d = paid.get(h.account) ?? 0n;
    const locked = h.selling_liabilities;
    return {
      role: h.role,
      cells: [
        h.role,
        fromStroops(h.stroops),
        locked > 0n ? fromStroops(locked) : '-',
        a ? fromStroops(a.stroops) : '-',
        d > 0n ? `+${fromStroops(d)}` : '-',
        locked > 0n && d > 0n ? '<- earned while quoted' : '',
      ],
    };
  });
  log.table([`holder`, `${RC} before`, 'in open offers', `${RC} after`, 'interest', ''], rows.map((r) => r.cells));
  const quoted = before.filter((h) => h.selling_liabilities > 0n);
  for (const h of quoted) {
    const d = paid.get(h.account) ?? 0n;
    log.raw(`  ${h.role}: ${fromStroops(h.selling_liabilities)} ${RC} sits in open SDEX offers and ${d > 0n ? `received ${fromStroops(d)} of the interest` : 'would receive its share'}: quoted inventory keeps earning because offers never move the funds out of the account.`);
  }
}
