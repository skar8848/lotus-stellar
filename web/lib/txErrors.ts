// Classification of failed Soroban transactions (pure, no imports, unit-tested in tests/tx-errors.test.mts).
//
// Why this exists: a call that withdraws from a SHARED DeFindex vault (pool sell swaps, claim and
// remove_position on the vault-backed pool, lotus_vault redeem) reads state other users also change. The vault's
// idle USDC can flip between 0 and 1 stroop between our simulation and inclusion, so the transaction touches a
// ledger entry outside the simulated footprint and fails with Error(Storage, ExceededLimit). Re-simulating,
// re-signing and resending fixes it, so the helper retries those (twice) before giving up.

export type FailureKind = "bad-seq" | "try-again" | "footprint" | "other";

/** JSON-ish dump of any value (bigint safe, cycle safe) for pattern matching on diagnostic output. */
export function stringifyDeep(v: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(v, (_k, x) => {
      if (typeof x === "bigint") return x.toString();
      if (x && typeof x === "object") {
        if (seen.has(x as object)) return undefined;
        seen.add(x as object);
      }
      return x;
    });
  } catch {
    return String(v);
  }
}

const FOOTPRINT = /exceeded[_ ]?limit|footprint|invoke_host_function_trapped|trapped/i;

export function classifyFailure(i: { status?: string; txCode?: string; detail?: string }): FailureKind {
  const status = i.status ?? "";
  const code = i.txCode ?? "";
  const detail = i.detail ?? "";
  if (/try_again_later/i.test(status)) return "try-again";
  if (/bad_?seq/i.test(code) || /txBadSeq|tx_bad_seq/i.test(detail)) return "bad-seq";
  // only a transaction that executed and failed (tx_failed) can be a footprint race; a node-side rejection cannot
  if (/^tx_?failed$/i.test(code) && FOOTPRINT.test(detail)) return "footprint";
  if (!code && /Error\(Storage,\s*ExceededLimit\)/i.test(detail)) return "footprint";
  return "other";
}

export const VAULT_RACE_MESSAGE = "The vault state changed while signing (another user of the shared DeFindex vault got in first), retry.";
