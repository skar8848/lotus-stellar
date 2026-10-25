"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { TxState } from "@/lib/hooks";
import { explorerAccount, explorerTx, shortAddr } from "@/lib/stellar";

export function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`wordmark select-none ${className}`}>LOTUS</span>;
}

export function Panel({
  id,
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  id?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`card flex min-w-0 flex-col ${className}`}>
      <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-muted-fg">{subtitle}</p> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>
      <div className="hairline" />
      <div className="min-w-0 flex-1 px-4 py-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, mono = true }: { label: ReactNode; value: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={`mt-1 truncate text-base font-medium ${mono ? "num" : ""}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-fg">{sub}</div> : null}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3 w-3 animate-spin rounded-full border border-white/30 border-t-white ${className}`}
      aria-hidden
    />
  );
}

export function Dot({ ok, pulse = false }: { ok: boolean | null; pulse?: boolean }) {
  const color = ok === null ? "bg-muted" : ok ? "bg-green" : "bg-red";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color} ${pulse ? "animate-pulse" : ""}`} aria-hidden />;
}

export function TxLink({ hash, network = "testnet", label }: { hash: string; network?: string; label?: string }) {
  return (
    <a
      className="underline decoration-white/30 underline-offset-2 hover:decoration-white"
      href={explorerTx(hash, network)}
      target="_blank"
      rel="noreferrer"
    >
      {label ?? shortAddr(hash, 6)}
    </a>
  );
}

export function AddrLink({ id, network = "testnet", n = 4, label }: { id: string; network?: string; n?: number; label?: string }) {
  return (
    <a
      className="num underline decoration-white/20 underline-offset-2 hover:decoration-white"
      href={explorerAccount(id, network)}
      target="_blank"
      rel="noreferrer"
      title={id}
    >
      {label ?? shortAddr(id, n)}
    </a>
  );
}

const STAGE_TEXT: Record<string, string> = {
  building: "Building transaction",
  simulating: "Simulating",
  signing: "Waiting for wallet signature",
  sending: "Submitting",
  confirming: "Waiting for confirmation",
  done: "Confirmed",
};

export function TxStatus({ state, network = "testnet", onDismiss }: { state: TxState; network?: string; onDismiss?: () => void }) {
  if (state.stage === "idle") return null;
  if (state.stage === "error") {
    return (
      <div className="mt-3 flex items-start justify-between gap-3 rounded-md border border-red/40 bg-red/5 px-3 py-2 text-xs">
        <span className="break-words text-red">{state.error}</span>
        {onDismiss ? (
          <button className="shrink-0 text-muted-fg hover:text-foreground" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        ) : null}
      </div>
    );
  }
  if (state.stage === "success") {
    return (
      <div className="mt-3 flex items-start justify-between gap-3 rounded-md border border-green/40 bg-green/5 px-3 py-2 text-xs">
        <span>
          <span className="text-green">Confirmed</span>
          {state.note ? <span className="text-muted-fg"> · {state.note}</span> : null}
          <span className="text-muted-fg"> · </span>
          <TxLink hash={state.hash} network={network} label="view on stellar.expert" />
        </span>
        {onDismiss ? (
          <button className="shrink-0 text-muted-fg hover:text-foreground" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs text-muted-fg">
      <Spinner />
      <span>
        {STAGE_TEXT[state.stage] ?? state.stage}
        {state.note ? ` · ${state.note}` : ""}…
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-xs text-muted-fg">{children}</div>;
}

export function AmountInput({
  value,
  onChange,
  placeholder = "0.00",
  max,
  suffix,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  max?: string | null;
  suffix?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <input
        className="field pr-24"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, "");
          onChange(v);
        }}
      />
      <div className="absolute inset-y-0 right-2 flex items-center gap-2 text-xs text-muted-fg">
        {max ? (
          <button type="button" className="hover:text-foreground" onClick={() => onChange(max)} disabled={disabled}>
            MAX
          </button>
        ) : null}
        {suffix ? <span className="font-medium text-foreground/80">{suffix}</span> : null}
      </div>
    </div>
  );
}

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-xs text-muted-fg hover:text-foreground">
      {children}
    </Link>
  );
}
