// Stellar helpers: Horizon (classic ops) + Soroban RPC (contract calls), friendbot, XDR parsing.
// Built on @stellar/stellar-sdk v17.

import {
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import { makeRpcServer } from './rpc.mjs';

export { Address, Asset, Contract, Keypair, Operation, StrKey, nativeToScVal, scValToNative, xdr };

const EXPERT = 'https://stellar.expert/explorer/testnet';

// ------------------------------------------------------------------ clients

/**
 * Build Horizon + RPC clients from a merged config (see lib/config.mjs loadConfig).
 * rpcServer retries transport failures on a backup RPC (lib/rpc.mjs): cfg.rpcFallback, else env
 * STELLAR_RPC_FALLBACK, else deployments/testnet.rpc.secrets.json; none configured = plain rpc.Server.
 */
export function makeClients(cfg) {
  return {
    horizon: new Horizon.Server(cfg.horizon),
    rpcServer: makeRpcServer(cfg.rpc, cfg.rpcFallback !== undefined ? { fallback: cfg.rpcFallback } : {}),
    passphrase: cfg.passphrase,
    horizonUrl: cfg.horizon,
    friendbotUrl: cfg.friendbot ?? 'https://friendbot.stellar.org',
  };
}

// ------------------------------------------------------------------- links

export const txLink = (hash) => `${EXPERT}/tx/${hash}`;
export const accountLink = (g) => `${EXPERT}/account/${g}`;
export const contractLink = (c) => `${EXPERT}/contract/${c}`;
export const assetLink = (asset) =>
  asset.isNative() ? `${EXPERT}/asset/XLM` : `${EXPERT}/asset/${asset.getCode()}-${asset.getIssuer()}`;
export const marketLink = (selling, buying) =>
  `${EXPERT}/market/${assetSlug(selling)}/${assetSlug(buying)}`;
export const horizonAccountLink = (ctx, g) => `${ctx.horizonUrl}/accounts/${g}`;
export const horizonOffersLink = (ctx, g) => `${ctx.horizonUrl}/accounts/${g}/offers`;
export const horizonTxLink = (ctx, hash) => `${ctx.horizonUrl}/transactions/${hash}`;
export const horizonHoldersLink = (ctx, asset) =>
  `${ctx.horizonUrl}/accounts?asset=${encodeURIComponent(`${asset.getCode()}:${asset.getIssuer()}`)}&limit=200`;

export function horizonOrderbookLink(ctx, selling, buying) {
  const q = (prefix, a) =>
    a.isNative()
      ? `${prefix}_asset_type=native`
      : `${prefix}_asset_type=${a.getAssetType()}&${prefix}_asset_code=${a.getCode()}&${prefix}_asset_issuer=${a.getIssuer()}`;
  return `${ctx.horizonUrl}/order_book?${q('selling', selling)}&${q('buying', buying)}`;
}

function assetSlug(a) {
  return a.isNative() ? 'XLM' : `${a.getCode()}-${a.getIssuer()}`;
}

// ------------------------------------------------------------------- assets

/** {code, issuer} -> Asset. Native when code is XLM/native and no issuer. */
export function assetFromConfig(a) {
  if (!a) throw new Error('asset config missing');
  const code = a.code ?? a.asset_code;
  const issuer = a.issuer ?? a.asset_issuer;
  if (!issuer || code === 'XLM' || code === 'native') return Asset.native();
  return new Asset(code, issuer);
}

export function assetLabel(a) {
  return a.isNative() ? 'XLM' : a.getCode();
}

export function sameAsset(a, b) {
  return a.equals(b);
}

// ------------------------------------------------------------------ amounts
// Classic amounts are decimal strings with 7 decimals; Soroban i128 amounts are stroops.

const SCALE = 10_000_000n;

export function toStroops(amountStr) {
  const s = String(amountStr).trim();
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.');
  if (frac.length > 7) throw new Error(`too many decimals: ${amountStr}`);
  const v = BigInt(int || '0') * SCALE + BigInt((frac + '0000000').slice(0, 7));
  return neg ? -v : v;
}

export function fromStroops(stroops, { trim = false } = {}) {
  let v = BigInt(stroops);
  const neg = v < 0n;
  if (neg) v = -v;
  const int = v / SCALE;
  let frac = (v % SCALE).toString().padStart(7, '0');
  if (trim) frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

/** Pretty-print a classic amount string: trims trailing zeros, keeps at least 2 decimals. */
export function fmt(amountStr) {
  const [i, f = ''] = String(amountStr).split('.');
  const frac = f.replace(/0+$/, '');
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac.length <= 2 ? `${int}.${frac.padEnd(2, '0')}` : `${int}.${frac}`;
}

export const i128 = (v) => nativeToScVal(BigInt(v), { type: 'i128' });
export const addr = (g) => new Address(g).toScVal();
export const vecAddr = (list) => xdr.ScVal.scvVec(list.map(addr));
export const vecI128 = (list) => xdr.ScVal.scvVec(list.map(i128));

// ---------------------------------------------------------------- friendbot

/** Fund a new testnet account. Returns 'funded' | 'exists'. */
export async function friendbot(ctx, pub) {
  const res = await fetch(`${ctx.friendbotUrl}?addr=${encodeURIComponent(pub)}`);
  if (res.ok) return 'funded';
  const body = await res.text();
  if (res.status === 400 && /createAccountAlreadyExist|already funded/i.test(body)) return 'exists';
  throw new Error(`friendbot failed (${res.status}): ${body.slice(0, 300)}`);
}

// ------------------------------------------------------------------ Horizon

export async function loadAccount(ctx, pub) {
  return ctx.horizon.loadAccount(pub);
}

export async function accountExists(ctx, pub) {
  try {
    await ctx.horizon.loadAccount(pub);
    return true;
  } catch (e) {
    if (e?.response?.status === 404) return false;
    throw e;
  }
}

/** Balance line for `asset` on an account response, or null if no trustline. */
export function balanceLine(account, asset) {
  if (asset.isNative()) return account.balances.find((b) => b.asset_type === 'native') ?? null;
  return (
    account.balances.find(
      (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
    ) ?? null
  );
}

export async function getBalance(ctx, pub, asset) {
  const acc = await ctx.horizon.loadAccount(pub);
  return balanceLine(acc, asset);
}

/** Open a trustline if missing. Returns the tx hash or null if it already existed. */
export async function ensureTrustline(ctx, kp, asset, { limit } = {}) {
  const acc = await ctx.horizon.loadAccount(kp.publicKey());
  if (balanceLine(acc, asset)) return null;
  const res = await submitClassic(ctx, {
    source: kp,
    ops: [Operation.changeTrust({ asset, ...(limit ? { limit } : {}) })],
    memo: `trust ${assetLabel(asset)}`,
  });
  return res.hash;
}

/** All accounts holding a trustline to `asset` (paginated). Balances include open-offer liabilities. */
export async function listHolders(ctx, asset) {
  const out = [];
  let page = await ctx.horizon.accounts().forAsset(asset).limit(200).call();
  for (;;) {
    for (const acc of page.records) {
      const b = balanceLine(acc, asset);
      out.push({
        account: acc.account_id,
        balance: b?.balance ?? '0',
        selling_liabilities: b?.selling_liabilities ?? '0',
        buying_liabilities: b?.buying_liabilities ?? '0',
        authorized: b?.is_authorized ?? true,
      });
    }
    if (page.records.length < 200) break;
    page = await page.next();
    if (!page.records.length) break;
  }
  return out;
}

export async function listOffers(ctx, pub) {
  const page = await ctx.horizon.offers().forAccount(pub).limit(200).call();
  return page.records;
}

export async function orderbook(ctx, selling, buying, limit = 20) {
  return ctx.horizon.orderbook(selling, buying).limit(limit).call();
}

// --------------------------------------------------------- classic submit

export class ClassicTxError extends Error {
  constructor(message, { codes, hash, raw } = {}) {
    super(message);
    this.name = 'ClassicTxError';
    this.codes = codes;
    this.hash = hash;
    this.raw = raw;
  }
}

/** Extract Horizon result codes from an axios-style error. */
export function horizonErrorCodes(e) {
  const extras = e?.response?.data?.extras;
  if (!extras) return null;
  return {
    transaction: extras.result_codes?.transaction,
    operations: extras.result_codes?.operations ?? [],
    result_xdr: extras.result_xdr,
  };
}

export function explainHorizonError(e) {
  const codes = horizonErrorCodes(e);
  if (codes) {
    const ops = codes.operations.length ? ` / ops: [${codes.operations.join(', ')}]` : '';
    return `${codes.transaction ?? 'tx error'}${ops}`;
  }
  const d = e?.response?.data;
  if (d?.detail || d?.title) return `${d.title ?? ''} ${d.detail ?? ''}`.trim();
  return e?.message ?? String(e);
}

/**
 * Build, sign and submit a classic transaction via Horizon.
 *   source: Keypair (tx source + signer), ops: Operation[], signers: extra Keypairs,
 *   fee: inclusion fee per op in stroops (default 1000), memo: text memo (<=28 bytes).
 * Returns { hash, response, link, result } where result is the decoded xdr.TransactionResult.
 */
export async function submitClassic(ctx, { source, ops, signers = [], fee = '1000', memo, timeout = 180 }) {
  const account = await ctx.horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, { fee, networkPassphrase: ctx.passphrase });
  for (const op of ops) builder.addOperation(op);
  if (memo) builder.addMemo(memoText(memo));
  const tx = builder.setTimeout(timeout).build();
  const uniq = new Map();
  for (const k of [source, ...signers]) uniq.set(k.publicKey(), k);
  tx.sign(...uniq.values());
  try {
    const response = await ctx.horizon.submitTransaction(tx, { skipMemoRequiredCheck: true });
    const result = response.result_xdr ? xdr.TransactionResult.fromXdr(response.result_xdr, 'base64') : null;
    return { hash: response.hash, response, result, link: txLink(response.hash) };
  } catch (e) {
    const codes = horizonErrorCodes(e);
    throw new ClassicTxError(explainHorizonError(e), {
      codes,
      hash: Buffer.from(tx.hash()).toString('hex'),
      raw: e,
    });
  }
}

function memoText(text) {
  // Memo.text is limited to 28 bytes
  return Memo.text(String(text).slice(0, 28));
}

// ------------------------------------------------------- result XDR parsing
// stellar-sdk v17 XDR objects are plain data: unions are { type: 'variant', <armName>: value }
// (with a `value` alias), 64-bit ints are bigint, fixed byte arrays expose toBytes().

/** Value of a union's active arm, whatever the arm is called. */
export function arm(u) {
  if (u == null) return u;
  if (u.value !== undefined) return u.value;
  const k = Object.keys(u).find((key) => key !== 'type');
  return k === undefined ? undefined : u[k];
}

const bytesOf = (b) => (typeof b?.toBytes === 'function' ? b.toBytes() : b);
const hexOf = (b) => Buffer.from(bytesOf(b)).toString('hex');

/** AccountID / PublicKey / MuxedAccount -> G... */
export function accountIdToStr(accountId) {
  const inner = arm(accountId);
  // muxed accounts carry { id, ed25519 }
  const ed = inner?.ed25519 !== undefined ? inner.ed25519 : inner;
  return StrKey.encodeEd25519PublicKey(bytesOf(ed));
}

/** Decode a ClaimAtom (a fill against a resting offer) into plain data. */
export function decodeClaimAtom(atom) {
  const kind = atom.type;
  const a = arm(atom);
  const common = {
    assetSold: Asset.fromOperation(a.assetSold),
    amountSold: fromStroops(a.amountSold),
    assetBought: Asset.fromOperation(a.assetBought),
    amountBought: fromStroops(a.amountBought),
  };
  if (kind === 'claimAtomTypeOrderBook') {
    return { type: 'orderbook', seller: accountIdToStr(a.sellerId), offerId: a.offerId.toString(), ...common };
  }
  if (kind === 'claimAtomTypeV0') {
    return {
      type: 'orderbook',
      seller: StrKey.encodeEd25519PublicKey(bytesOf(a.sellerEd25519)),
      offerId: a.offerId.toString(),
      ...common,
    };
  }
  return { type: 'liquidity_pool', pool: hexOf(a.liquidityPoolId), ...common };
}

/** Operation results of a tx result (fee-bump aware). */
export function opResults(result) {
  const inner = result.result;
  if (inner.type === 'txFeeBumpInnerSuccess' || inner.type === 'txFeeBumpInnerFailed') {
    return arm(inner).result.result.results ?? arm(arm(inner).result.result);
  }
  return arm(inner);
}

/** Fills + final delivered amount for the path payment at `opIndex`. */
export function parsePathPaymentStrictSend(result, opIndex = 0) {
  const tr = arm(opResults(result)[opIndex]);
  const r = arm(tr);
  if (r.type !== 'pathPaymentStrictSendSuccess') return { ok: false, code: r.type };
  const s = arm(r);
  const last = s.last;
  return {
    ok: true,
    fills: s.offers.map(decodeClaimAtom),
    delivered: {
      destination: accountIdToStr(last.destination),
      asset: Asset.fromOperation(last.asset),
      amount: fromStroops(last.amount),
    },
  };
}

/** Offer ids created/updated by ManageSellOffer ops in a tx result (null for deleted). */
export function parseManageSellOffers(result) {
  return opResults(result).map((opr) => {
    const tr = arm(opr);
    if (tr?.type !== 'manageSellOffer') return null;
    const r = arm(tr);
    if (r.type !== 'manageSellOfferSuccess') return { ok: false, code: r.type };
    const s = arm(r);
    const effect = s.offer.type; // manageOfferCreated | manageOfferUpdated | manageOfferDeleted
    const entry = effect === 'manageOfferDeleted' ? null : arm(s.offer);
    return {
      ok: true,
      effect,
      offerId: entry ? entry.offerId.toString() : null,
      amountRemaining: entry ? fromStroops(entry.amount) : '0',
      claimed: s.offersClaimed.map(decodeClaimAtom),
    };
  });
}

// ------------------------------------------------------------ Soroban RPC

export class SorobanError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SorobanError';
    Object.assign(this, details);
  }
}

function safeNative(scv) {
  try {
    return scValToNative(scv);
  } catch {
    try {
      return scv.switch().name;
    } catch {
      return '?';
    }
  }
}

const jsonSafe = (_k, v) => {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return v;
};

/** Render diagnostic events (from simulation or getTransaction) as readable lines. */
export function diagnosticsToText(events = []) {
  const lines = [];
  for (const ev of events ?? []) {
    try {
      const e = typeof ev === 'string' ? xdr.DiagnosticEvent.fromXdr(ev, 'base64') : ev;
      const body = arm(e.event.body);
      const topics = body.topics.map(safeNative);
      const data = safeNative(body.data);
      lines.push(`${JSON.stringify(topics, jsonSafe)} -> ${JSON.stringify(data, jsonSafe)}`);
    } catch {
      /* skip unparseable */
    }
  }
  return lines;
}

/** Decode a tx result XDR into a short failure description. */
export function describeTxResult(result) {
  try {
    const name = result.result.type;
    let ops = [];
    try {
      ops = (opResults(result) ?? []).map((o) => {
        const tr = arm(o);
        if (!tr?.type) return o.type;
        if (tr.type === 'invokeHostFunction') return arm(tr).type;
        return `${tr.type}:${arm(tr)?.type ?? ''}`;
      });
    } catch {
      /* no op results */
    }
    return ops.length ? `${name} [${ops.join(', ')}]` : name;
  } catch {
    return 'unknown result';
  }
}

/**
 * Simulate-only call (no signature, no fee): returns the native JS value of the return.
 * `sourcePub` is any funded account (needed to build the simulated transaction).
 */
export async function readContract(ctx, { contractId, method, args = [], sourcePub }) {
  const contract = new Contract(contractId);
  const account = await ctx.rpcServer.getAccount(sourcePub);
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: ctx.passphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await ctx.rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new SorobanError(`simulation of ${method}() failed: ${sim.error}`, {
      diagnostics: diagnosticsToText(sim.events),
    });
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : undefined;
}

async function signAuthEntries(ctx, authEntries, signers) {
  const latest = await ctx.rpcServer.getLatestLedger();
  const validUntil = latest.sequence + 200;
  const out = [];
  for (const entry of authEntries) {
    if (entry.credentials.type !== 'sorobanCredentialsAddress') {
      out.push(entry); // source-account credentials: covered by the tx signature
      continue;
    }
    const who = Address.fromScAddress(arm(entry.credentials).address).toString();
    const signer = signers.find((k) => k.publicKey() === who);
    if (!signer) throw new SorobanError(`auth required from ${who} but no signer provided`);
    out.push(await authorizeEntry(entry, signer, validUntil, ctx.passphrase));
  }
  return out;
}

/**
 * Invoke a contract function: simulate -> (restore if needed) -> assemble -> sign -> send -> poll.
 *   source: Keypair paying fees and (normally) the authorizing address.
 *   signers: extra Keypairs for auth entries with address credentials.
 *   inclusionFee: stroops (default 100_000 = 0.01 XLM), resourceFeeMargin: multiplier (default 1.25)
 * Returns { hash, link, returnValue (native), response, feeCharged (stroops BigInt) }.
 */
export async function invokeContract(
  ctx,
  { contractId, method, args = [], source, signers = [], inclusionFee = '100000', resourceFeeMargin = 1.25, timeout = 120, label },
) {
  const contract = new Contract(contractId);
  const tag = label ?? `${method}()`;

  const build = async (auth) => {
    const account = await ctx.rpcServer.getAccount(source.publicKey());
    const op = auth
      ? Operation.invokeHostFunction({ func: arm(contract.call(method, ...args).body).hostFunction, auth })
      : contract.call(method, ...args);
    return new TransactionBuilder(account, { fee: inclusionFee, networkPassphrase: ctx.passphrase })
      .addOperation(op)
      .setTimeout(timeout)
      .build();
  };

  let tx = await build();
  let sim = await ctx.rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationRestore(sim)) {
    await restoreFootprint(ctx, source, sim, inclusionFee);
    tx = await build();
    sim = await ctx.rpcServer.simulateTransaction(tx);
  }
  if (rpc.Api.isSimulationError(sim)) {
    throw new SorobanError(`${tag} simulation failed: ${sim.error}`, {
      diagnostics: diagnosticsToText(sim.events),
    });
  }

  // Auth entries that need a signature from an address other than the source account.
  const authEntries = sim.result?.auth ?? [];
  const needsAddressAuth = authEntries.some((e) => e.credentials.type === 'sorobanCredentialsAddress');
  if (needsAddressAuth) {
    const signed = await signAuthEntries(ctx, authEntries, [source, ...signers]);
    tx = await build(signed);
    sim = await ctx.rpcServer.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new SorobanError(`${tag} re-simulation (signed auth) failed: ${sim.error}`, {
        diagnostics: diagnosticsToText(sim.events),
      });
    }
  }

  // Generous resource fee: the refundable part (rent, events) is estimated by simulation and
  // Blend/DeFindex-touching calls are heavy; unused refundable fee is refunded.
  const minFee = BigInt(sim.minResourceFee);
  const bumped = BigInt(Math.ceil(Number(minFee) * resourceFeeMargin));
  sim.transactionData.setResourceFee(bumped);
  sim.minResourceFee = bumped.toString();

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(source);

  const sent = await ctx.rpcServer.sendTransaction(prepared);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    const why = sent.errorResult ? describeTxResult(sent.errorResult) : sent.status;
    throw new SorobanError(`${tag} rejected on send: ${why}`, {
      hash: sent.hash,
      diagnostics: diagnosticsToText(sent.diagnosticEvents ?? []),
    });
  }
  const hash = sent.hash;

  const final = await ctx.rpcServer.pollTransaction(hash, { attempts: 90 });
  if (final.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    const feeCharged = final.resultXdr ? BigInt(final.resultXdr.feeCharged) : null;
    return {
      hash,
      link: txLink(hash),
      returnValue: final.returnValue ? scValToNative(final.returnValue) : undefined,
      feeCharged,
      response: final,
    };
  }
  if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
    const diag = diagnosticsToText(final.diagnosticEventsXdr ?? []);
    throw new SorobanError(`${tag} FAILED on-chain: ${describeTxResult(final.resultXdr)}`, {
      hash,
      link: txLink(hash),
      diagnostics: diag,
    });
  }
  throw new SorobanError(`${tag} not found after polling (status ${final.status}); check ${txLink(hash)}`, {
    hash,
  });
}

async function restoreFootprint(ctx, source, sim, inclusionFee) {
  const account = await ctx.rpcServer.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: inclusionFee, networkPassphrase: ctx.passphrase })
    .setSorobanData(sim.restorePreamble.transactionData.build())
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();
  tx.sign(source);
  const sent = await ctx.rpcServer.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new SorobanError('restoreFootprint rejected');
  const final = await ctx.rpcServer.pollTransaction(sent.hash, { attempts: 60 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new SorobanError(`restoreFootprint failed (${final.status})`);
  }
}

/** Fee in XLM for a Soroban response (feeCharged stroops -> "0.1234567"). */
export function feeXlm(stroops) {
  return stroops == null ? '?' : fromStroops(stroops, { trim: true });
}

/** Contract methods as listed from the on-chain spec (debug helper). */
export async function contractMethods(ctx, contractId) {
  const methods = await ctx.rpcServer.getContractMethods(contractId, ctx.passphrase);
  return methods.map((m) => {
    const ins = (m.inputs ?? []).map((i) => `${i.name}: ${i.type}`).join(', ');
    const outs = (m.outputs ?? []).join(', ');
    return `${m.name}(${ins})${outs ? ` -> ${outs}` : ''}`;
  });
}
