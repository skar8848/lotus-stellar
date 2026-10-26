// Server-only: faucet signing keys and the funding transactions. Imported ONLY by app/api/faucet/route.ts.
// Never import this from a client component (it uses node:fs and holds secret keys).
//
// Key lookup, per role, first hit wins:
//   1. deployments/testnet.secrets.json (git-ignored; same directory search as lib/config.ts), keys
//      rwa_issuer, blocked_taker (USDC source), maker (receipt source)
//   2. env FAUCET_RWA_ISSUER_SECRET, FAUCET_USDC_SECRET, FAUCET_RECEIPT_SECRET
// The file is read at request time with fs (never `import`ed), so it can never end up in a bundle.
// Secrets are never logged, never returned, and errors are scrubbed of anything that looks like a key.

import fs from "node:fs";
import path from "node:path";
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";
import type { FaucetRole } from "./faucet";

const SECRETS_FILE = "testnet.secrets.json";
const FILE_KEY: Record<FaucetRole, string> = { rwa: "rwa_issuer", underlying: "blocked_taker", receipt: "maker" };
const ENV_KEY: Record<FaucetRole, string> = {
  rwa: "FAUCET_RWA_ISSUER_SECRET",
  underlying: "FAUCET_USDC_SECRET",
  receipt: "FAUCET_RECEIPT_SECRET",
};

function readSecretsFile(): Record<string, unknown> | null {
  const dirs = [process.env.LOTUS_DEPLOYMENTS_DIR, path.resolve(process.cwd(), "..", "deployments"), path.resolve(process.cwd(), "deployments")];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, SECRETS_FILE);
    try {
      if (!fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

function pickSecret(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const s = [o.secret, o.secretKey, o.secret_key, o.seed].find((x) => typeof x === "string");
    return (s as string | undefined) ?? null;
  }
  return null;
}

/** Signing keypair for a faucet role, or null when not configured. */
export function faucetKeypair(role: FaucetRole): Keypair | null {
  const file = readSecretsFile();
  const candidates = [pickSecret(file?.[FILE_KEY[role]]), process.env[ENV_KEY[role]] ?? null];
  for (const s of candidates) {
    if (!s) continue;
    try {
      return Keypair.fromSecret(s.trim());
    } catch {
      /* malformed: try the next source */
    }
  }
  return null;
}

export const isTestnet = (passphrase: string): boolean => passphrase === Networks.TESTNET;

/** Remove anything shaped like a Stellar secret key from a message before it leaves the server. */
export const scrub = (s: string): string => s.replace(/S[A-Z2-7]{55}/g, "S[redacted]");

/** Horizon result codes of a failed submit, or the message. */
export function horizonError(e: unknown): string {
  const rc = (e as { response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } })?.response?.data?.extras
    ?.result_codes;
  if (rc) return [rc.transaction, ...(rc.operations ?? []).filter((c) => c !== "op_success")].filter(Boolean).join(" / ");
  return scrub(e instanceof Error ? e.message : String(e));
}

// one queue per source key: two claims in the same ledger would otherwise load the same sequence number
const sourceQueues = new Map<string, Promise<unknown>>();

/** Build, sign (server key) and submit one classic transaction; serialised per source, one retry on tx_bad_seq. */
export async function sendClassic(horizonUrl: string, passphrase: string, kp: Keypair, ops: xdr.Operation[]): Promise<string> {
  const key = kp.publicKey();
  const run = async (): Promise<string> => {
    const server = new Horizon.Server(horizonUrl);
    for (let attempt = 0; ; attempt++) {
      const acc = await server.loadAccount(key);
      const b = new TransactionBuilder(acc, { fee: "1000", networkPassphrase: passphrase });
      for (const op of ops) b.addOperation(op);
      const tx = b.setTimeout(60).build();
      tx.sign(kp);
      try {
        const r = await server.submitTransaction(tx);
        return r.hash;
      } catch (e) {
        if (attempt === 0 && horizonError(e).includes("tx_bad_seq")) continue;
        throw e;
      }
    }
  };
  const prev = sourceQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  sourceQueues.set(key, next);
  return next;
}

export function fundingOps(p: { destination: string; asset: { code: string; issuer: string }; amount: string; authorize: boolean }): xdr.Operation[] {
  const asset = new Asset(p.asset.code, p.asset.issuer);
  const ops: xdr.Operation[] = [];
  if (p.authorize) ops.push(Operation.setTrustLineFlags({ trustor: p.destination, asset, flags: { authorized: true } }));
  ops.push(Operation.payment({ destination: p.destination, asset, amount: p.amount }));
  return ops;
}
