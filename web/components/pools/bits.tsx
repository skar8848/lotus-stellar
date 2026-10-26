"use client";

// Small dashboard pieces ported from lotus-main (owl/web/components/dashboard/bits.tsx): pair glyph, status badge,
// fill bar. Presentation only.

import { Badge } from "@/components/ui/badge";
import { TokenIcon } from "@/components/common";
import { cn } from "@/lib/utils";

/** Overlapping token icons for the pair. */
export function PairGlyph({ base, quote, size = 26 }: { base: string; quote: string; size?: number }) {
  return (
    <span className="flex shrink-0">
      <TokenIcon code={base} size={size} className="z-10 ring-2 ring-card" />
      <TokenIcon code={quote} size={size} className="-ml-2 ring-2 ring-card" />
    </span>
  );
}

export type PositionStatus = "active" | "filling" | "filled";

const STATUS_STYLES: Record<PositionStatus, { label: string; cls: string; dot: string; pulse: boolean }> = {
  active: { label: "Waiting", cls: "border-primary/30 bg-primary/10 text-primary", dot: "bg-primary", pulse: false },
  filling: { label: "Filling", cls: "border-green/30 bg-green/10 text-green", dot: "bg-green", pulse: true },
  filled: { label: "Filled", cls: "border-line bg-white/5 text-mutedfg", dot: "bg-mutedfg", pulse: false },
};

export function StatusBadge({ status }: { status: PositionStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 py-1 pl-2 pr-2.5 font-medium", s.cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot, s.pulse && "animate-pulse")} />
      {s.label}
    </Badge>
  );
}

/** Thin Uniswap-style progress bar with a trailing percentage. */
export function FillBar({ pct, className }: { pct: number | null; className?: string }) {
  if (pct === null) return <span className={cn("text-[11px] text-mutedfg", className)}>not tracked</span>;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
        <div className="absolute inset-y-0 left-0 rounded-full bg-green transition-all duration-700" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-green">{pct.toFixed(0)}%</span>
    </div>
  );
}

/** Round "checkbox" of the lotus-main option rows: fills pink when on. */
export function RoundCheck({ on }: { on: boolean }) {
  return (
    <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border transition", on ? "border-primary bg-primary text-primary-foreground" : "border-line")}>
      {on ? (
        <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </span>
  );
}
