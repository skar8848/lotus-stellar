// Live Blend supply rate, read from chain (no SDK import here so the math stays unit-testable in plain node).
//
// Blend's reserve data carries b_rate (1e12 fixed point): the value of one bToken in the underlying. It only grows,
// and `get_reserve` re-accrues it to the current ledger on every call, so two reads some seconds apart give the
// supply APR every supplier of the pool earns, independently of our own deposits:
//     APR = (b_rate_end / b_rate_start - 1) * 31_536_000 / (t_end - t_start)       (t = data.last_time, seconds)
// This is the method of deployments/testnet.contract.json observed_apr (gross Blend rate; the Lotus DeFindex vault
// fee is 0, so it is also what Lotus holders net). BLND emissions are not counted. A snapshot, never a forecast.

export type ReserveSample = { bRate: bigint; time: number };

export const YEAR_SECONDS = 31_536_000;
/** Below this window the 1e12 b_rate quantization and ledger timing make the figure too noisy to show. */
export const MIN_WINDOW_SECONDS = 10;

/** Simple (non-compounded) annualized growth between two samples, in percent. null when the window is too short. */
export function aprFromSamples(a: ReserveSample, b: ReserveSample, minWindow = MIN_WINDOW_SECONDS): number | null {
  const dt = b.time - a.time;
  if (!(dt >= minWindow) || a.bRate <= 0n || b.bRate < a.bRate) return null;
  // ratio - 1 computed in integers first (b_rate moves by ~1e-8 per ledger: a float ratio would lose it)
  const growth = Number(((b.bRate - a.bRate) * 1_000_000_000_000n) / a.bRate) / 1e12;
  return (growth * YEAR_SECONDS * 100) / dt;
}

/** Keep the first sample of the session and the latest one: the window grows, the figure gets steadier. */
export function pushSample(prev: { first: ReserveSample | null; last: ReserveSample | null }, s: ReserveSample) {
  if (!prev.first) return { first: s, last: s };
  if (s.time <= (prev.last?.time ?? 0)) return prev;
  return { first: prev.first, last: s };
}

/** Pull the sample out of a decoded `get_reserve` result ({ data: { b_rate, last_time } }). */
export function sampleFromReserve(v: unknown): ReserveSample | null {
  const d = (v as { data?: { b_rate?: unknown; last_time?: unknown } } | null)?.data;
  if (!d) return null;
  const b = typeof d.b_rate === "bigint" ? d.b_rate : typeof d.b_rate === "number" ? BigInt(d.b_rate) : null;
  const t = typeof d.last_time === "bigint" ? Number(d.last_time) : typeof d.last_time === "number" ? d.last_time : null;
  return b !== null && t !== null ? { bRate: b, time: t } : null;
}
