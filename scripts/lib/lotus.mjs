// Lotus-specific helpers shared by scripts 03-07: resolve assets and accounts from the merged
// config, read the contract views, enumerate receipt holders and compute pro-rata yield.

import { loadConfig, loadSecrets } from './config.mjs';
import {
  Asset,
  Keypair,
  assetFromConfig,
  listHolders,
  makeClients,
  readContract,
  toStroops,
} from './stellar.mjs';

/**
 * Everything the demo scripts need in one object.
 * Throws if deployments/testnet.contract.json is not there yet.
 */
export function lotusContext() {
  const cfg = loadConfig({ requireContract: true });
  const ctx = makeClients(cfg);
  const c = cfg.contract;
  const underlying = assetFromConfig(c.underlying);
  const receipt = assetFromConfig(c.receipt);
  const underlyingSac = c.underlying?.sac ?? underlying.contractId(cfg.passphrase);
  const receiptSac = c.receipt?.sac ?? receipt.contractId(cfg.passphrase);
  const secrets = loadSecrets();
  const roles = {
    ...(c.accounts ?? {}),
    ...(cfg.classic.accounts ?? {}),
    lotus_vault: c.lotus_vault_contract,
    ...(c.defindex_vault ? { defindex_vault: c.defindex_vault } : {}),
  };
  const roleOf = (g) => Object.entries(roles).find(([, v]) => v === g)?.[0] ?? null;
  return {
    cfg,
    ctx,
    contractId: c.lotus_vault_contract,
    underlying,
    receipt,
    underlyingSac,
    receiptSac,
    defindexVault: c.defindex_vault ?? null,
    accounts: roles,
    secrets,
    roleOf,
    keypair: (name) => {
      const s = secrets[name];
      if (!s) throw new Error(`secret "${name}" missing from deployments/testnet.secrets.json`);
      return Keypair.fromSecret(s);
    },
    /** Any funded account usable as a simulation source for read-only calls. */
    readerPub: cfg.classic.accounts?.maker ?? c.accounts?.keeper ?? c.accounts?.admin,
  };
}

/** surplus(), supply(), vault_value() as BigInt stroops. */
export async function readViews(lt) {
  const call = (method) =>
    readContract(lt.ctx, { contractId: lt.contractId, method, sourcePub: lt.readerPub });
  const [surplus, supply, vaultValue] = await Promise.all([call('surplus'), call('supply'), call('vault_value')]);
  return { surplus: BigInt(surplus), supply: BigInt(supply), vaultValue: BigInt(vaultValue) };
}

/**
 * Receipt holders with balances as BigInt stroops. Discovery goes through Horizon
 * (/accounts?asset=CODE:ISSUER, paginated); each balance is then refreshed from RPC ledger
 * entries so it matches what the contract will read on-chain (Horizon can lag a ledger).
 * The balance INCLUDES amounts locked in open offers (selling_liabilities).
 */
export async function receiptHolders(lt) {
  const rows = await listHolders(lt.ctx, lt.receipt);
  const out = [];
  for (const r of rows) {
    let stroops = toStroops(r.balance);
    let source = 'horizon';
    try {
      const tl = await lt.ctx.rpcServer.getTrustline(r.account, lt.receipt);
      stroops = BigInt(tl.balance);
      source = 'rpc';
    } catch {
      /* keep the Horizon figure */
    }
    out.push({
      account: r.account,
      role: lt.roleOf(r.account),
      stroops,
      selling_liabilities: toStroops(r.selling_liabilities),
      authorized: r.authorized,
      source,
    });
  }
  return out;
}

/**
 * amounts_i = floor(surplus * balance_i / supply), identical to the contract's on-chain cap.
 * Zero lines are dropped, and the sum is always <= surplus because sum(balance_i) <= supply.
 * If Horizon ever reports more receipt than the contract's supply (should not happen), the
 * extra is trimmed from the largest line so the call cannot fail with InsufficientSurplus.
 */
export function computeProRata(surplus, supply, holders) {
  if (surplus <= 0n || supply <= 0n) return [];
  const lines = holders
    .filter((h) => h.stroops > 0n)
    .map((h) => ({ ...h, amount: (surplus * h.stroops) / supply }))
    .filter((h) => h.amount > 0n);
  let total = lines.reduce((s, l) => s + l.amount, 0n);
  if (total > surplus) {
    lines.sort((a, b) => (b.amount > a.amount ? 1 : -1));
    lines[0].amount -= total - surplus;
    total = surplus;
  }
  return lines;
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export { Asset };
