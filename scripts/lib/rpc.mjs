// Soroban RPC client with a backup endpoint.
//
// makeRpcServer(primaryUrl) returns a real `rpc.Server` for primaryUrl whose JSON-RPC requests are retried
// on the fallback RPC when they fail at the transport level (network error, timeout, HTTP 5xx / 429 / 408,
// or sendTransaction answering TRY_AGAIN_LATER; resending the same signed tx is idempotent).
// After such a failure the fallback is tried first for FALLBACK_STICKY_MS, then the primary again.
// JSON-RPC errors (bad params, simulation errors, ...) are NOT retried: they would fail the same way.
//
// The fallback URL carries an API key, so it is a secret:
//   1. env STELLAR_RPC_FALLBACK (a URL, or "off" / "none" to disable), else
//   2. deployments/testnet.rpc.secrets.json  {"rpc_fallback": "https://..."}  (gitignored, *.secrets.json)
// It is never logged: messages name the host only, and errors coming from the fallback are rethrown
// with the URL scrubbed.

import path from 'node:path';
import { rpc } from '@stellar/stellar-sdk';
import { DEPLOY_DIR, ROOT, readJson } from './config.mjs';

export const RPC_SECRETS_FILE = 'testnet.rpc.secrets.json';
export const FALLBACK_STICKY_MS = 60_000;

/** The fallback RPC URL, or null when none is configured. */
export function loadRpcFallback() {
  const env = process.env.STELLAR_RPC_FALLBACK;
  if (env !== undefined && env.trim() !== '') {
    return /^(off|none|0|false)$/i.test(env.trim()) ? null : env.trim();
  }
  for (const dir of new Set([DEPLOY_DIR, path.join(ROOT, 'deployments')])) {
    try {
      const j = readJson(path.join(dir, RPC_SECRETS_FILE), null);
      if (j && typeof j.rpc_fallback === 'string' && /^https?:\/\//.test(j.rpc_fallback)) return j.rpc_fallback;
    } catch {
      // unreadable / half-written: ignore, no fallback
    }
  }
  return null;
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return 'rpc';
  }
};

/** True for failures that another RPC node could plausibly not have. */
export function isTransportError(e) {
  if (!e) return false;
  const status = e.response?.status ?? e.status;
  if (typeof status === 'number') return status >= 500 || status === 429 || status === 408;
  const code = String(e.code ?? e.cause?.code ?? '');
  if (/^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR|ERR_NETWORK|ECONNABORTED)/.test(code)) return true;
  const msg = String(e.message ?? e);
  return /fetch failed|network error|socket hang up|timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|status code 5\d\d|status code 429|Unexpected token <|not valid JSON/i.test(msg);
}

function scrub(e, url) {
  const clean = (s) => String(s).split(url).join('<fallback-rpc>');
  const out = new Error(clean(e?.message ?? e));
  out.name = e?.name ?? 'Error';
  const status = e?.response?.status ?? e?.status;
  if (status !== undefined) out.status = status;
  if (e?.code !== undefined) out.code = e.code;
  out.viaFallbackRpc = true;
  return out;
}

const isTryAgainLater = (body, res) => body?.method === 'sendTransaction' && res?.data?.result?.status === 'TRY_AGAIN_LATER';

/**
 * A Soroban RPC client for `primaryUrl` that falls back to `fallback` (default: loadRpcFallback()).
 * It IS an rpc.Server for primaryUrl; only its httpClient.post is wrapped, so every method (including
 * the ones that turn any failure into "Account not found", and the nested calls of pollTransaction)
 * gets the fallback. Without a fallback this is exactly `new rpc.Server(primaryUrl, opts)`.
 */
export function makeRpcServer(primaryUrl, { fallback = loadRpcFallback(), log = (m) => console.error(m), ...opts } = {}) {
  const primary = new rpc.Server(primaryUrl, opts);
  if (!fallback || fallback === primaryUrl) return primary;
  const backup = new rpc.Server(fallback, opts);
  const nodes = [
    { name: hostOf(primaryUrl), url: primary.serverURL.toString(), http: primary.httpClient, primary: true },
    { name: `fallback ${hostOf(fallback)}`, url: backup.serverURL.toString(), http: backup.httpClient, primary: false },
  ];
  const ownUrls = new Set(nodes.map((n) => n.url));
  let preferBackupUntil = 0;
  const realPost = primary.httpClient.post.bind(primary.httpClient);

  const post = async (url, body, config) => {
    if (!ownUrls.has(String(url))) return realPost(url, body, config); // friendbot etc.
    const order = Date.now() < preferBackupUntil ? [nodes[1], nodes[0]] : nodes;
    const what = body?.method ?? 'request';
    let lastErr;
    let lastRes;
    for (let i = 0; i < order.length; i++) {
      const n = order[i];
      const next = order[i + 1];
      try {
        const res = await n.http.post(n.url, body, config);
        if (next && isTryAgainLater(body, res)) {
          lastRes = res;
          if (n.primary) preferBackupUntil = Date.now() + FALLBACK_STICKY_MS;
          log(`rpc: ${n.name} answered ${what} TRY_AGAIN_LATER, resending on ${next.name}`);
          continue;
        }
        if (n.primary && i > 0) preferBackupUntil = 0; // primary works again
        return res;
      } catch (e) {
        lastErr = n.primary ? e : scrub(e, fallback);
        if (!next || !isTransportError(e)) break;
        if (n.primary) preferBackupUntil = Date.now() + FALLBACK_STICKY_MS;
        log(`rpc: ${n.name} failed on ${what} (${String(lastErr.message).slice(0, 120)}), retrying on ${next.name}`);
      }
    }
    if (lastErr) throw lastErr;
    return lastRes;
  };

  primary.httpClient = new Proxy(primary.httpClient, {
    get(target, prop, receiver) {
      if (prop === 'post') return post;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return primary;
}
