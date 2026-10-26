// Test cleanup straight on chain, for orders the UI now keeps locked until fully filled (no Remove / Cancel in
// "Your positions" or /portfolio): remove_position on a pool instance, cancel SDEX offers by id.
// Keys come from the environment only (E2E_DEV_SECRET, same "label=S...,label=S..." format as the dev signer's
// NEXT_PUBLIC_DEV_SECRET); nothing is read from disk and no secret is printed.
//   import { chainCleanup } from "./chain-cleanup.mjs"
//   await chainCleanup({ who: "taker", positions: [{ contract, id }], offers: [offerRow] })
// CLI: E2E_DEV_SECRET=... node e2e/chain-cleanup.mjs <who> pool:<contract>:<id> ... offers   (offers = every open offer)
import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { BASE_URL } from "./browser.mjs";

function keyOf(who) {
  const raw = process.env.E2E_DEV_SECRET ?? "";
  for (const part of raw.split(",")) {
    const [label, secret] = part.split("=");
    if (label?.trim() === who && secret?.trim().startsWith("S")) return Keypair.fromSecret(secret.trim());
  }
  return null;
}

export const hasCleanupKey = (who) => keyOf(who) !== null;

const asset = (a) => (a.asset_type === "native" ? Asset.native() : new Asset(a.asset_code, a.asset_issuer));

async function sendClassic(cfg, kp, ops) {
  const hashes = [];
  for (let i = 0; i < ops.length; i += 100) {
    const acc = await (await fetch(`${cfg.horizon}/accounts/${kp.publicKey()}`)).json();
    const src = { accountId: () => kp.publicKey(), sequenceNumber: () => acc.sequence, incrementSequenceNumber() {} };
    const b = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: cfg.passphrase }).setTimeout(120);
    for (const op of ops.slice(i, i + 100)) b.addOperation(op);
    const tx = b.build();
    tx.sign(kp);
    const r = await fetch(`${cfg.horizon}/transactions`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `tx=${encodeURIComponent(tx.toXDR())}` });
    const j = await r.json();
    if (!r.ok || !j.successful) throw new Error(`cancel tx failed: ${JSON.stringify(j.extras?.result_codes ?? j.title ?? j).slice(0, 200)}`);
    hashes.push(j.hash);
  }
  return hashes;
}

async function removePosition(cfg, kp, contract, id) {
  const server = new rpc.Server(cfg.rpc);
  const acc = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: cfg.passphrase })
    .addOperation(
      Operation.invokeContractFunction({
        contract,
        function: "remove_position",
        args: [nativeToScVal(kp.publicKey(), { type: "address" }), nativeToScVal(BigInt(id), { type: "u64" })],
      }),
    )
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`remove_position #${id} rejected`);
  for (let i = 0; i < 30; i++) {
    const g = await server.getTransaction(sent.hash);
    if (g.status === "SUCCESS") return sent.hash;
    if (g.status === "FAILED") throw new Error(`remove_position #${id} failed`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`remove_position #${id}: timeout`);
}

/**
 * positions: [{ contract, id }]; offers: Horizon offer records (or "all" for every open offer of the account).
 * Returns [{ what, hash | error }].
 */
export async function chainCleanup({ who, positions = [], offers = [] }) {
  const kp = keyOf(who);
  if (!kp) throw new Error(`no E2E_DEV_SECRET key for "${who}"`);
  const cfg = await (await fetch(`${BASE_URL}/api/config`)).json();
  const out = [];
  for (const p of positions) {
    try {
      out.push({ what: `remove ${p.contract.slice(0, 6)}#${p.id}`, hash: await removePosition(cfg, kp, p.contract, p.id) });
    } catch (e) {
      out.push({ what: `remove #${p.id}`, error: String(e.message ?? e) });
    }
  }
  let list = offers;
  if (offers === "all") list = (await (await fetch(`${cfg.horizon}/accounts/${kp.publicKey()}/offers?limit=200`)).json())._embedded?.records ?? [];
  if (list.length) {
    const ops = list.map((o) =>
      Operation.manageSellOffer({ selling: asset(o.selling), buying: asset(o.buying), amount: "0", price: { n: o.price_r.n, d: o.price_r.d }, offerId: String(o.id) }),
    );
    try {
      for (const h of await sendClassic(cfg, kp, ops)) out.push({ what: `cancel ${list.length} offer(s)`, hash: h });
    } catch (e) {
      out.push({ what: `cancel ${list.length} offer(s)`, error: String(e.message ?? e) });
    }
  }
  return out;
}

/** Open offers of an account (Horizon records). */
export async function openOffers(account) {
  const cfg = await (await fetch(`${BASE_URL}/api/config`)).json();
  return (await (await fetch(`${cfg.horizon}/accounts/${account}/offers?limit=200`)).json())._embedded?.records ?? [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [who, ...rest] = process.argv.slice(2);
  const positions = rest.filter((x) => x.startsWith("pool:")).map((x) => ({ contract: x.split(":")[1], id: x.split(":")[2] }));
  const res = await chainCleanup({ who, positions, offers: rest.includes("offers") ? "all" : [] });
  console.table(res);
  process.exit(res.every((r) => !r.error) ? 0 : 1);
}
