// Transaction building (unsigned XDR) and submission. Port of the flows of web/lib/stellar.ts:
//   - prepareInvoke      : build -> simulate -> assemble one Soroban call (fresh simulation every time)
//   - buildClassic       : classic ops on the next sequence
//   - submit             : Soroban via RPC (TRY_AGAIN_LATER resend of the same XDR, DUPLICATE = keep polling,
//                          poll to SUCCESS / FAILED) or classic via Horizon (bad-seq resend of the same XDR)
//   - submitSequence     : several signed txs in order, stop at the first failure (a 2-tx order never sends tx 2
//                          after a failed tx 1). With a signer, a footprint race on a Soroban tx (shared DeFindex
//                          vault, web/lib/txErrors.ts) re-simulates, re-signs and resends it (twice), re-sequencing
//                          the transactions after it.

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  type FeeBumpTransaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { VAULT_RACE_MESSAGE, classifyFailure, stringifyDeep, type FailureKind } from "./shared/txErrors.ts";
import { explainResultCode, fetchAccount, isBadSeq, prettySimError, rpcServer, txResultCode, type NetCfg } from "./net.ts";
import { explainPoolError } from "./pool.ts";

export type ContractCall = { contractId: string; method: string; args: xdr.ScVal[] };

/** One unsigned transaction, ready for a wallet. */
export type BuiltTx = {
  /** unsigned transaction envelope, base64 */
  xdr: string;
  kind: "soroban" | "classic";
  /** what it does, one line */
  label: string;
  source: string;
  sequence: string;
  /** total fee in stroops (Soroban: inclusion + resource fee from the simulation) */
  fee: string;
  networkPassphrase: string;
};

/** What a builder returns. When `txs` has several entries they MUST be submitted in order, each after the previous succeeded. */
export type BuildResult = {
  txs: BuiltTx[];
  summary: string;
  warnings: string[];
  /** builder specific details (plan, quote, ...), JSON-safe (bigints as strings) */
  details?: Record<string, unknown>;
};

/** Signs a transaction envelope (base64) and returns the signed envelope. */
export type Signer = { publicKey: string; sign: (txXdr: string, networkPassphrase: string) => Promise<string> };

export const DEFAULT_TIMEOUT_SEC = 300;

export async function sourceAccount(net: NetCfg, source: string): Promise<Account> {
  const acct = await fetchAccount(net.horizon, source);
  if (!acct) throw new Error(`account ${source} not found on the network (fund it with Friendbot first)`);
  return new Account(source, acct.sequence);
}

/** Build + simulate + assemble one contract call on `account` (its sequence is bumped by one). */
export async function prepareInvoke(net: NetCfg, account: Account, call: ContractCall, timeoutSec = DEFAULT_TIMEOUT_SEC): Promise<Transaction> {
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(new Contract(call.contractId).call(call.method, ...call.args))
    .setTimeout(timeoutSec)
    .build();
  const sim = await rpcServer(net.rpc).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(explainPoolError(prettySimError(sim.error)));
  return rpc.assembleTransaction(tx, sim).build();
}

export function buildClassic(net: NetCfg, account: Account, ops: xdr.Operation[], timeoutSec = DEFAULT_TIMEOUT_SEC, feePerOp = "1000"): Transaction {
  if (ops.length === 0) throw new Error("no operations");
  if (ops.length > 100) throw new Error("at most 100 operations per transaction");
  const b = new TransactionBuilder(account, { fee: feePerOp, networkPassphrase: net.passphrase });
  for (const op of ops) b.addOperation(op);
  return b.setTimeout(timeoutSec).build();
}

export const toBuilt = (tx: Transaction, kind: BuiltTx["kind"], label: string, passphrase: string): BuiltTx => ({
  xdr: tx.toXDR(),
  kind,
  label,
  source: tx.source,
  sequence: tx.sequence,
  fee: tx.fee,
  networkPassphrase: passphrase,
});

// ---------------------------------------------------------------------------
// submission
// ---------------------------------------------------------------------------

export type SubmitResult = { hash: string; kind: "soroban" | "classic"; ledger?: number; result?: unknown };

export class SubmitError extends Error {
  constructor(
    message: string,
    readonly failureKind: FailureKind,
    readonly hash: string | null,
    /** the transaction made it into a ledger (its sequence number is consumed even though it failed) */
    readonly included: boolean,
  ) {
    super(message);
    this.name = "SubmitError";
  }
}

export function parseTx(signedXdr: string, passphrase: string): Transaction {
  const t = TransactionBuilder.fromXDR(signedXdr, passphrase) as Transaction | FeeBumpTransaction;
  if ("innerTransaction" in t) return t.innerTransaction;
  return t as Transaction;
}

export const isSorobanTx = (tx: Transaction): boolean => tx.operations.some((o) => o.type === "invokeHostFunction" || o.type === "extendFootprintTtl" || o.type === "restoreFootprint");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendSoroban(net: NetCfg, signedXdr: string): Promise<SubmitResult> {
  const server = rpcServer(net.rpc);
  const signed = TransactionBuilder.fromXDR(signedXdr, net.passphrase);
  let sent = await server.sendTransaction(signed);
  for (let i = 1; i <= 3 && sent.status === "TRY_AGAIN_LATER"; i++) {
    await sleep(1500 * i);
    sent = await server.sendTransaction(signed);
  }
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    const code = txResultCode(sent.errorResult);
    const kind = sent.status === "TRY_AGAIN_LATER" ? "try-again" : classifyFailure({ txCode: code, detail: stringifyDeep(sent.errorResult) });
    throw new SubmitError(`send failed (${sent.status}${code ? `: ${explainResultCode(code)}` : ""})`, kind, sent.hash ?? null, false);
  }
  for (let i = 0; i < 60; i++) {
    await sleep(1200);
    const got = await server.getTransaction(sent.hash);
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      let result: unknown;
      try {
        result = got.returnValue ? scValToNative(got.returnValue) : undefined;
      } catch {
        /* non-decodable */
      }
      return { hash: sent.hash, kind: "soroban", ledger: got.ledger, result };
    }
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
      const code = txResultCode(got.resultXdr);
      const detail = stringifyDeep([got.resultXdr, (got as { diagnosticEventsXdr?: unknown }).diagnosticEventsXdr]);
      const kind = classifyFailure({ txCode: code, detail });
      const contractErr = detail.match(/Error\(Contract, #\d+\)/)?.[0];
      const msg = `failed on-chain${code ? `: ${explainResultCode(code)}` : ""}${contractErr ? ` ${explainPoolError(contractErr)}` : ""}`;
      throw new SubmitError(kind === "footprint" ? `${msg} (${VAULT_RACE_MESSAGE})` : msg, kind, sent.hash, true);
    }
  }
  throw new SubmitError(`timed out waiting for ${sent.hash}`, "other", sent.hash, false);
}

async function submitHorizonOnce(horizon: string, signedXdr: string): Promise<{ hash: string; ledger?: number }> {
  const res = await fetch(`${horizon}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ tx: signedXdr }).toString(),
  });
  const j = (await res.json()) as {
    hash?: string;
    ledger?: number;
    successful?: boolean;
    title?: string;
    detail?: string;
    extras?: { hash?: string; result_codes?: { transaction?: string; operations?: string[] } };
  };
  if (!res.ok || j.successful === false) {
    const rc = j.extras?.result_codes;
    const ops = rc?.operations?.filter((c) => c !== "op_success");
    const msg = rc ? [rc.transaction, ...(ops ?? [])].filter(Boolean).join(" / ") : j.detail || j.title || `HTTP ${res.status}`;
    throw new SubmitError(explainResultCode(msg), isBadSeq(msg) ? "bad-seq" : "other", j.extras?.hash ?? null, rc?.transaction === "tx_failed");
  }
  return { hash: j.hash as string, ledger: j.ledger };
}

async function sendClassic(net: NetCfg, signedXdr: string): Promise<SubmitResult> {
  // bad sequence right after the previous tx of a pair: Horizon / core one ledger behind, resend the SAME XDR
  for (let i = 0; ; i++) {
    try {
      const r = await submitHorizonOnce(net.horizon, signedXdr);
      return { hash: r.hash, kind: "classic", ledger: r.ledger };
    } catch (e) {
      if (!(e instanceof SubmitError) || e.failureKind !== "bad-seq" || i >= 3) throw e;
      await sleep(2000);
    }
  }
}

/** Submit ONE signed transaction (Soroban through RPC, classic through Horizon) and wait for the result. */
export async function submit(net: NetCfg, signedXdr: string): Promise<SubmitResult> {
  const tx = parseTx(signedXdr, net.passphrase);
  if (tx.signatures.length === 0) throw new SubmitError("the transaction is not signed", "other", null, false);
  return isSorobanTx(tx) ? sendSoroban(net, signedXdr) : sendClassic(net, signedXdr);
}

async function waitSequenceAbove(net: NetCfg, source: string, seq: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const a = await fetchAccount(net.horizon, source).catch(() => null);
    if (a && BigInt(a.sequence) >= BigInt(seq)) return;
    await sleep(1500);
  }
}

/** Rebuild a transaction (same operation(s)) on `account`: Soroban is re-simulated, classic keeps its ops. */
export async function rebuildOn(net: NetCfg, account: Account, tx: Transaction): Promise<Transaction> {
  if (isSorobanTx(tx)) {
    const op = tx.operations[0];
    if (op.type !== "invokeHostFunction") throw new Error(`cannot rebuild a ${op.type} transaction`);
    const fn = op.func;
    if (fn.type !== "hostFunctionTypeInvokeContract") throw new Error("cannot rebuild a non-invoke host function");
    const ica = fn.invokeContract;
    const contractId = Address.fromScAddress(ica.contractAddress).toString();
    const method = ica.functionName.toString();
    return prepareInvoke(net, account, { contractId, method, args: ica.args });
  }
  const env = tx.toEnvelope();
  if (env.type !== "envelopeTypeTx") throw new Error("cannot rebuild a v0 / fee-bump envelope");
  const ops = env.v1.tx.operations;
  const perOp = String(Math.max(100, Math.floor(Number(tx.fee) / Math.max(1, ops.length))));
  return buildClassic(net, account, ops, DEFAULT_TIMEOUT_SEC, perOp);
}

export type SequenceResult = {
  ok: boolean;
  results: SubmitResult[];
  /** index of the transaction that failed, and why; the transactions after it were NOT sent */
  failed?: { index: number; error: string; failureKind: FailureKind; hash: string | null };
  notes: string[];
};

/**
 * Submit signed transactions in order; stop at the first failure. With `signer` (it must be the source of every
 * transaction), a footprint race (or a stale sequence) on transaction i rebuilds, re-signs and resends it and every
 * transaction after it, at most twice. Without a signer the caller must rebuild (the error says so).
 */
export async function submitSequence(net: NetCfg, signedXdrs: string[], opts: { signer?: Signer; log?: (m: string) => void } = {}): Promise<SequenceResult> {
  const results: SubmitResult[] = [];
  const notes: string[] = [];
  let queue = [...signedXdrs];
  let retries = 0;
  for (let i = 0; i < queue.length; ) {
    try {
      results.push(await submit(net, queue[i]));
      i++;
    } catch (e) {
      const kind: FailureKind = e instanceof SubmitError ? e.failureKind : isBadSeq(e) ? "bad-seq" : "other";
      const included = e instanceof SubmitError && e.included;
      const hash = e instanceof SubmitError ? e.hash : null;
      const msg = e instanceof Error ? e.message : String(e);
      const tx0 = parseTx(queue[i], net.passphrase);
      const canRebuild = !!opts.signer && tx0.source === opts.signer.publicKey && (kind === "footprint" || kind === "bad-seq") && retries < 2;
      if (canRebuild && opts.signer) {
        retries++;
        if (included) await waitSequenceAbove(net, tx0.source, tx0.sequence);
        await sleep(1200 * retries);
        notes.push(`tx ${i + 1}: ${kind === "footprint" ? "vault state changed" : "stale sequence"}, rebuilt and re-signed (${retries}/2)`);
        opts.log?.(notes[notes.length - 1]);
        const account = await sourceAccount(net, tx0.source);
        const rebuilt: string[] = [];
        for (const x of queue.slice(i)) {
          const t = await rebuildOn(net, account, parseTx(x, net.passphrase));
          rebuilt.push(await opts.signer.sign(t.toXDR(), net.passphrase));
        }
        queue = [...queue.slice(0, i), ...rebuilt];
        continue;
      }
      const extra =
        queue.length > i + 1 ? ` The ${queue.length - i - 1} transaction(s) after it were not sent.` : "";
      const advice = kind === "footprint" || kind === "bad-seq" ? " Rebuild the transaction(s) and sign again." : "";
      return { ok: false, results, failed: { index: i, error: `${msg}${advice}${extra}`, failureKind: kind, hash }, notes };
    }
  }
  return { ok: true, results, notes };
}

/** Sign every transaction of a build with `signer` and submit them in order (autonomous mode). */
export async function signAndSubmit(net: NetCfg, built: BuildResult | BuiltTx[], signer: Signer, log?: (m: string) => void): Promise<SequenceResult> {
  const txs = Array.isArray(built) ? built : built.txs;
  for (const t of txs) if (t.source !== signer.publicKey) throw new Error(`transaction source ${t.source} is not the signer ${signer.publicKey}`);
  const signed = await Promise.all(txs.map((t) => signer.sign(t.xdr, net.passphrase)));
  return submitSequence(net, signed, { signer, log });
}

export { VAULT_RACE_MESSAGE };
