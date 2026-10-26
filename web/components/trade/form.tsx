"use client";

// Compact exchange-style form primitives for the /trade order entry column: side toggle, order-type pills,
// boxed inputs with a unit suffix, a % of balance slider, a summary box and inline warnings.

import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Side = "buy" | "sell";

/** Buy / Sell, full-width, green / red when active. Buttons carry data-value for the e2e scripts. */
export function SideToggle({
  value,
  onChange,
  buyLabel = "Buy",
  sellLabel = "Sell",
  testId,
}: {
  value: Side | null;
  onChange: (s: Side) => void;
  buyLabel?: ReactNode;
  sellLabel?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1" data-testid={testId}>
      {(["buy", "sell"] as const).map((s) => (
        <button
          key={s}
          type="button"
          data-value={s}
          data-active={value === s ? "1" : "0"}
          onClick={() => onChange(s)}
          className={cn(
            "truncate rounded-md py-1.5 text-sm font-semibold transition-colors",
            value === s ? (s === "buy" ? "bg-green text-white" : "bg-red text-white") : "text-mutedfg hover:text-foreground",
          )}
        >
          {s === "buy" ? buyLabel : sellLabel}
        </button>
      ))}
    </div>
  );
}

/** Boxed input with a label row and a unit suffix inside the box. */
export function ExField({
  label,
  right,
  value,
  onChange,
  unit,
  testId,
  placeholder = "0.00",
  readOnly,
  className,
}: {
  label: ReactNode;
  right?: ReactNode;
  value: string;
  onChange?: (v: string) => void;
  unit?: ReactNode;
  testId?: string;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-mutedfg">
        <span className="truncate">{label}</span>
        {right ? <span className="shrink-0">{right}</span> : null}
      </div>
      <div className="relative">
        <input
          data-testid={testId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={(e) => onChange?.(e.target.value.replace(/[^0-9.]/g, ""))}
          className={cn(
            "num w-full rounded-lg border border-border bg-secondary px-3 py-2 pr-16 text-sm text-foreground outline-none transition-colors placeholder:text-mutedfg/50 focus:border-primary",
            readOnly && "text-mutedfg",
          )}
        />
        {unit ? <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-mutedfg">{unit}</span> : null}
      </div>
    </div>
  );
}

const PCTS = [25, 50, 75, 100];

/** Range slider + 25/50/75/100% presets, as a share of what can be spent. */
export function PctSlider({ pct, onPct, disabled }: { pct: number; onPct: (p: number) => void; disabled?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="mt-2 space-y-1.5" data-testid="size-slider">
      <input
        type="range"
        min={0}
        max={100}
        value={v}
        disabled={disabled}
        aria-label="Share of available balance"
        onChange={(e) => onPct(Number(e.target.value))}
        style={{ background: `linear-gradient(to right, var(--primary) ${v}%, rgba(243,177,206,0.18) ${v}%)` }}
        className={cn(
          "h-1 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-40",
          "[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm",
          "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-primary",
        )}
      />
      <div className="flex justify-between gap-1">
        {PCTS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onPct(p)}
            className={cn(
              "flex-1 rounded py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              v >= p ? "bg-primary/20 text-primary" : "bg-secondary text-mutedfg hover:text-foreground",
            )}
          >
            {p}%
          </button>
        ))}
      </div>
    </div>
  );
}

export function SummaryBox({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="space-y-1.5 rounded-lg bg-secondary p-2.5" data-testid={testId}>
      {children}
    </div>
  );
}

export function SumRow({ k, v, className, testId, title }: { k: ReactNode; v: ReactNode; className?: string; testId?: string; title?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs" title={title}>
      <span className="shrink-0 text-mutedfg">{k}</span>
      <span className={cn("num min-w-0 truncate text-right text-foreground", className)} data-testid={testId}>
        {v}
      </span>
    </div>
  );
}

export const SumSep = () => <div className="my-1 border-t border-border" />;

/** Inline notice: `warn` (pink, attention), `bad` (red), `info` (muted). */
export function Warn({ tone = "warn", children, testId }: { tone?: "warn" | "bad" | "info"; children: ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-2",
        tone === "warn" && "border-primary/30 bg-primary/5 text-primary",
        tone === "bad" && "border-red/30 bg-red/10 text-red",
        tone === "info" && "border-border bg-secondary/60 text-mutedfg",
      )}
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="text-[11px] leading-snug">{children}</span>
    </div>
  );
}

/** The big action button, coloured by side (pink when the action has no side). */
export function ActionButton({
  side,
  disabled,
  onClick,
  children,
  testId,
  blocked,
}: {
  side: Side | null;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
  /** a blocking reason is shown instead of the action: neutral styling */
  blocked?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "flex h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed",
        blocked
          ? "border border-border bg-secondary text-mutedfg"
          : side === "buy"
            ? "bg-green text-white hover:bg-green/90 disabled:opacity-50"
            : side === "sell"
              ? "bg-red text-white hover:bg-red/90 disabled:opacity-50"
              : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50",
      )}
    >
      {children}
    </button>
  );
}
