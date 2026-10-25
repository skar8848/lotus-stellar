// Range builder form state lives in TradeClient so the chart (draggable handles, level lines) and the
// RangeTab share it. `null` fields mean "use the default derived from the market reference price", which
// keeps the defaults live until the user edits a field and avoids syncing state in effects.

import { buildRange, type RangeInput, type RangeMode, type Shape } from "@/lib/range";

export type RangeForm = {
  mode: RangeMode;
  from: string | null;
  to: string | null;
  levels: number;
  total: string;
  shape: Shape;
  split: string | null;
};

export const initialRangeForm: RangeForm = { mode: "sell", from: null, to: null, levels: 8, total: "10", shape: "uniform", split: null };

const fx = (n: number) => String(Number(n.toFixed(4)));

export function defaultRange(mode: RangeMode, ref: number): { from: string; to: string; split: string } {
  const r = ref > 0 ? ref : 1;
  if (mode === "sell") return { from: fx(r * 1.01), to: fx(r * 1.01 * 1.05), split: fx(r) };
  if (mode === "buy") return { from: fx(r * 0.99), to: fx(r * 0.99 * 0.95), split: fx(r) };
  return { from: fx(r * 0.95), to: fx(r * 1.05), split: fx(r) };
}

export function effective(form: RangeForm, ref: number) {
  const d = defaultRange(form.mode, ref);
  return { from: form.from ?? d.from, to: form.to ?? d.to, split: form.split ?? d.split };
}

export function rangeInput(form: RangeForm, ref: number): RangeInput {
  const e = effective(form, ref);
  return { mode: form.mode, from: e.from, to: e.to, levels: form.levels, totalBase: form.total, shape: form.shape, split: e.split };
}

export const computeRange = (form: RangeForm, ref: number) => buildRange(rangeInput(form, ref));
