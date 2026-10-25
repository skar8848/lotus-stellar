"use client";

import { useMemo } from "react";
import { fromStroops } from "@/lib/amount";
import type { BinView } from "@/lib/pool";
import { MAX_BIN, MIN_BIN, priceAt, type PositionPlan } from "@/lib/poolGrid";
import { fmt } from "@/lib/stellar";

/**
 * Depth of the Lotus pool by price bin, with the position you are about to add drawn on top (pink).
 * Asks (inventory in LBOND) are red, bids (USDC inventory shown as LBOND-equivalent) are green.
 * X is the bin index (uniform spacing, like the contract's grid), labelled with each bin's price.
 */
export function PoolRangeChart({
  asks,
  bids,
  plan,
  shapeOnly = false,
  stepBps,
  baseCode,
  height = 240,
}: {
  asks: BinView[];
  bids: BinView[];
  plan: PositionPlan | null;
  /** no amount typed yet: draw the weight shape only (heights are relative, not sizes) */
  shapeOnly?: boolean;
  stepBps: number;
  baseCode: string;
  height?: number;
}) {
  const model = useMemo(() => {
    const askBars = asks.map((b) => ({ bin: b.bin, size: Number(fromStroops(b.inventory)) }));
    const bidBars = bids.map((b) => {
      const p = Number(b.price) / 1e7;
      return { bin: b.bin, size: p > 0 ? Number(fromStroops(b.inventory)) / p : 0 };
    });
    const rawPlan = plan?.ok ? plan.bins.map((b) => ({ bin: b.bin, size: Number(fromStroops(b.baseSize)), weight: b.weight })) : [];
    const poolMax = Math.max(1e-9, ...askBars.map((b) => b.size), ...bidBars.map((b) => b.size));
    const wMax = Math.max(1, ...rawPlan.map((b) => b.weight));
    // shape-only: heights follow the weights, topping out at 45% of the tallest pool bin
    const planBars = shapeOnly ? rawPlan.map((b) => ({ bin: b.bin, size: (b.weight / wMax) * poolMax * 0.45 })) : rawPlan;
    const all = [...askBars, ...bidBars, ...planBars];
    const lo = Math.max(MIN_BIN, Math.min(-20, ...all.map((b) => b.bin)) - 1);
    const hi = Math.min(MAX_BIN, Math.max(20, ...all.map((b) => b.bin)) + 1);
    const max = Math.max(1e-9, ...all.map((b) => b.size));
    return { askBars, bidBars, planBars, lo, hi, max };
  }, [asks, bids, plan, shapeOnly]);

  const W = 640;
  const H = 240;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 26;
  const n = model.hi - model.lo + 1;
  const bw = (W - padL - padR) / n;
  const X = (bin: number) => padL + (bin - model.lo) * bw;
  const Yh = (size: number) => (size / model.max) * (H - padT - padB);
  const tickEvery = n > 120 ? 20 : n > 60 ? 10 : 5;
  const ticks: number[] = [];
  for (let b = Math.ceil(model.lo / tickEvery) * tickEvery; b <= model.hi; b += tickEvery) ticks.push(b);
  const empty = model.askBars.length === 0 && model.bidBars.length === 0 && model.planBars.length === 0;

  return (
    <div data-testid="pool-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Pool depth by price bin">
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke="rgba(255,255,255,0.12)" />
        {/* bin 0 = 1.0000 reference */}
        <line x1={X(0) + bw / 2} x2={X(0) + bw / 2} y1={padT} y2={H - padB} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 4" />
        {plan?.ok ? (
          <rect x={X(plan.loBin)} y={padT} width={(plan.hiBin - plan.loBin + 1) * bw} height={H - padT - padB} fill="rgba(243,177,206,0.07)" />
        ) : null}
        {model.askBars.map((b) => (
          <rect key={`a${b.bin}`} x={X(b.bin) + bw * 0.1} y={H - padB - Yh(b.size)} width={bw * 0.8} height={Math.max(1, Yh(b.size))} fill="rgba(235,54,90,0.55)" />
        ))}
        {model.bidBars.map((b) => (
          <rect key={`b${b.bin}`} x={X(b.bin) + bw * 0.1} y={H - padB - Yh(b.size)} width={bw * 0.8} height={Math.max(1, Yh(b.size))} fill="rgba(2,199,123,0.55)" />
        ))}
        {model.planBars.map((b) => (
          <rect
            key={`p${b.bin}`}
            x={X(b.bin) + bw * 0.1}
            y={H - padB - Yh(b.size)}
            width={bw * 0.8}
            height={Math.max(1.5, Yh(b.size))}
            fill="rgba(243,177,206,0.55)"
            stroke="#F3B1CE"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {ticks.map((b) => (
          <text key={b} x={X(b) + bw / 2} y={H - 8} fontSize="10" textAnchor="middle" fill="#8898a8">
            {fmt(Number(priceAt(b, stepBps)) / 1e7, 4, 4)}
          </text>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mutedfg">
        <Legend color="rgba(235,54,90,0.7)" label={`Asks (${baseCode} for sale)`} />
        <Legend color="rgba(2,199,123,0.7)" label={`Bids (${baseCode}-equivalent)`} />
        <Legend color="#F3B1CE" label={shapeOnly ? "Your new position (shape only: enter an amount for sizes)" : "Your new position"} />
        {empty ? <span className="text-mutedfg">No liquidity in the pool yet.</span> : null}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block size-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
