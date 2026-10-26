"use client";

// Toolbar primitives of the /trade chart (Hyperliquid / TradingView look: slate panel, grey icons, teal active state).

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export const HL = {
  bg: "#0f1a1f",
  panel: "#0f1a1f",
  border: "rgba(255,255,255,0.07)",
  grid: "rgba(255,255,255,0.045)",
  text: "#949e9c",
  bright: "#d1d4dc",
  accent: "#50d2c1", // Hyperliquid teal (active tools / intervals)
  up: "#26a69a",
  down: "#ef5350",
  hover: "rgba(255,255,255,0.06)",
};

export function Divider({ vertical }: { vertical?: boolean }) {
  return <span className={cn("shrink-0 bg-white/10", vertical ? "my-1 h-px w-5" : "mx-1 h-4 w-px")} aria-hidden />;
}

export function TbBtn({
  children,
  onClick,
  active,
  title,
  testId,
  icon,
  small,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
  testId?: string;
  icon?: boolean;
  small?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testId}
      disabled={disabled}
      className={cn(
        "grid shrink-0 place-items-center rounded font-medium transition-colors hover:bg-white/[0.06] disabled:opacity-40",
        icon ? "size-7" : small ? "h-5 px-1.5 text-[11px]" : "h-7 px-1.5 text-[12px]",
        className,
      )}
      style={{ color: active ? HL.accent : HL.text }}
    >
      {children}
    </button>
  );
}

/** Dropdown anchored under its button; closes on outside click, Escape or after a pick. */
export function Menu({
  label,
  title,
  testId,
  children,
  align = "left",
  width = 168,
}: {
  label: React.ReactNode;
  title: string;
  testId?: string;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-0.5 rounded px-1.5 text-[12px] font-medium transition-colors hover:bg-white/[0.06]"
        style={{ color: open ? HL.bright : HL.text }}
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn("absolute top-8 z-40 rounded-md border py-1 shadow-xl shadow-black/50", align === "right" ? "right-0" : "left-0")}
          style={{ width, background: "#1b2429", borderColor: HL.border }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  active,
  testId,
  right,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  testId?: string;
  right?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={!!active}
      data-testid={testId}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-white/[0.06]"
      style={{ color: active ? HL.accent : HL.bright }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {right}
    </button>
  );
}

export function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider" style={{ color: HL.text }}>
      {children}
    </div>
  );
}

/** Live clock of the bottom bar, in the chart's time zone; rendered after mount only (no SSR / hydration mismatch). */
export function Clock({ tzOff, onToggle }: { tzOff: number; onToggle: () => void }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span className="w-[118px]" />;
  const d = new Date(now + tzOff * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const h = tzOff / 3600;
  const tz = tzOff === 0 ? "UTC" : `UTC${h > 0 ? "+" : "-"}${Number.isInteger(h) ? Math.abs(h) : Math.abs(h).toFixed(1)}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Chart time zone (click: local time / UTC)"
      data-testid="chart-clock"
      className="num rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-white/[0.06]"
      style={{ color: HL.text }}
    >
      {p(d.getUTCHours())}:{p(d.getUTCMinutes())}:{p(d.getUTCSeconds())} ({tz})
    </button>
  );
}
