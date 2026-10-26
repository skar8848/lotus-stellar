"use client";

// Small shared building blocks: explorer links, tx status, token icon, stat, asset input.
// Visual language follows the previous Lotus front (shadcn new-york on pure black + pink).

import { Check, ExternalLink, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { explorerAsset, explorerUrl, type ExplorerKind } from "@/lib/explorer";
import { shortAddr, type AssetRef } from "@/lib/stellar";
import type { TxState } from "@/lib/hooks";

// ---------------------------------------------------------------------------
// Explorer links (stellar.expert). Used for every address, contract, asset, tx hash and offer id.
// ---------------------------------------------------------------------------

export function ExplorerLink({
  kind,
  id,
  label,
  network = "testnet",
  n = 4,
  className,
  mono = true,
  title,
}: {
  kind: ExplorerKind;
  /** tx hash / account / contract / offer id / liquidity pool id. For kind="asset" pass "CODE-ISSUER". */
  id: string;
  label?: ReactNode;
  network?: string;
  /** characters kept on each side when shortening an address or hash */
  n?: number;
  className?: string;
  mono?: boolean;
  title?: string;
}) {
  const text = label ?? (kind === "offer" ? `#${id}` : shortAddr(id, n));
  return (
    <a
      href={explorerUrl(kind, id, network)}
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? id}
      className={cn(
        "inline-flex items-center gap-1 text-foreground/90 underline decoration-white/20 underline-offset-2 transition hover:text-primary hover:decoration-primary",
        mono && "num",
        className,
      )}
    >
      {text}
      <ExternalLink className="size-3 shrink-0 opacity-60" aria-hidden />
    </a>
  );
}

/** Link to an asset page; native XLM links to the XLM asset page. */
export function AssetLink({
  asset,
  network = "testnet",
  label,
  className,
}: {
  asset: AssetRef;
  network?: string;
  label?: ReactNode;
  className?: string;
}) {
  const id = asset.issuer ? `${asset.code}-${asset.issuer}` : "XLM";
  return (
    <a
      href={explorerAsset(asset.code, asset.issuer, network)}
      target="_blank"
      rel="noopener noreferrer"
      title={id}
      className={cn(
        "inline-flex items-center gap-1 text-foreground/90 underline decoration-white/20 underline-offset-2 transition hover:text-primary hover:decoration-primary",
        className,
      )}
    >
      {label ?? asset.code}
      <ExternalLink className="size-3 shrink-0 opacity-60" aria-hidden />
    </a>
  );
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const TOKEN_STYLE: Record<string, { bg: string; fg: string }> = {
  lUSDC: { bg: "#f3b1ce", fg: "#1a0a12" },
  LBOND: { bg: "#8fb6c8", fg: "#06141c" },
  XLM: { bg: "#e8eef4", fg: "#06141c" },
};

const TOKEN_IMG: Record<string, string> = {
  USDC: "/tokens/usdc.png",
  lUSDC: "/tokens/lusdc.svg",
  lUSDCb: "/tokens/lusdcb.svg",
};

/** Token logo with a coloured-initial fallback (USDC and the Lotus receipts have images). */
export function TokenIcon({ code, size = 20, className }: { code: string; size?: number; className?: string }) {
  const src = TOKEN_IMG[code];
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={code} width={size} height={size} className={cn("shrink-0 rounded-full", className)} style={{ width: size, height: size }} />;
  }
  const st = TOKEN_STYLE[code] ?? { bg: "#2a2f36", fg: "#e8eef4" };
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold", className)}
      style={{ width: size, height: size, background: st.bg, color: st.fg, fontSize: size * 0.46 }}
      aria-hidden
    >
      {code.slice(0, 1)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status bits
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-3.5 animate-spin", className)} aria-hidden />;
}

export function Dot({ ok, pulse = false, className }: { ok: boolean | null; pulse?: boolean; className?: string }) {
  const color = ok === null ? "bg-mutedfg/60" : ok ? "bg-green" : "bg-red";
  return <span className={cn("inline-block size-1.5 rounded-full", color, pulse && "animate-pulse", className)} aria-hidden />;
}

export function Stat({ label, value, sub, mono = true }: { label: ReactNode; value: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className={cn("mt-1 truncate text-base font-medium", mono && "num")}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-mutedfg">{sub}</div> : null}
    </div>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("py-6 text-center text-xs text-mutedfg", className)}>{children}</div>;
}

/** Card with the previous front's header rhythm. */
export function Panel({
  id,
  title,
  subtitle,
  right,
  children,
  className,
  bodyClassName,
}: {
  id?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section id={id} className={cn("card flex min-w-0 flex-col", className)}>
      <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-mutedfg">{subtitle}</p> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>
      <div className={cn("min-w-0 flex-1 px-5 pb-5", bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Transaction status line (one per flow)
// ---------------------------------------------------------------------------

const STAGE_TEXT: Record<string, string> = {
  building: "Building transaction",
  simulating: "Simulating",
  signing: "Waiting for signature",
  sending: "Submitting",
  confirming: "Waiting for confirmation",
  done: "Confirmed",
};

export function TxStatus({ state, network = "testnet", onDismiss }: { state: TxState; network?: string; onDismiss?: () => void }) {
  if (state.stage === "idle") return null;
  if (state.stage === "error") {
    return (
      <div data-testid="tx-error" className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs">
        <span className="min-w-0 break-words text-destructive">{state.error}</span>
        {onDismiss ? (
          <button className="shrink-0 text-mutedfg hover:text-foreground" onClick={onDismiss} aria-label="Dismiss">
            x
          </button>
        ) : null}
      </div>
    );
  }
  if (state.stage === "success") {
    const hashes = (state.hashes && state.hashes.length > 0 ? state.hashes : [state.hash]).filter(Boolean);
    return (
      <div
        data-testid="tx-success"
        data-hash={state.hash}
        data-hashes={hashes.join(",")}
        data-result={state.result === undefined || state.result === null || typeof state.result === "object" ? undefined : String(state.result)}
        className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-green/40 bg-green/5 px-3 py-2.5 text-xs"
      >
        <span className="min-w-0 break-words">
          <Check className="mr-1 inline size-3.5 text-green" aria-hidden />
          <span className="text-green">Confirmed</span>
          {state.note ? <span className="text-mutedfg"> · {state.note}</span> : null}
          {hashes.length > 0 ? <span className="text-mutedfg"> · </span> : null}
          {hashes.map((h, i) => (
            <span key={h}>
              {i > 0 ? <span className="text-mutedfg">, </span> : null}
              <ExplorerLink kind="tx" id={h} network={network} n={6} />
            </span>
          ))}
        </span>
        {onDismiss ? (
          <button className="shrink-0 text-mutedfg hover:text-foreground" onClick={onDismiss} aria-label="Dismiss">
            x
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div data-testid="tx-pending" className="mt-3 flex items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-xs text-mutedfg">
      <Spinner />
      <span>
        {STAGE_TEXT[state.stage] ?? state.stage}
        {state.note ? ` · ${state.note}` : ""}...
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Amount input in the previous front's "AssetField" style
// ---------------------------------------------------------------------------

export function AssetField({
  label,
  value,
  onChange,
  asset,
  balance,
  readOnly,
  testId,
  hint,
  pill,
  placeholder = "0",
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  /** token shown in the pill (ignored when `pill` is given) */
  asset?: AssetRef;
  /** spendable balance shown under the input; clicking it fills the field */
  balance?: string | null;
  readOnly?: boolean;
  testId?: string;
  hint?: ReactNode;
  /** custom pill (e.g. a token selector) */
  pill?: ReactNode;
  placeholder?: string;
}) {
  return (
    <div className="rounded-2xl bg-secondary px-4 py-3.5">
      <div className="text-sm text-mutedfg">{label}</div>
      <div className="mt-1 flex items-center justify-between gap-3">
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
            "w-full min-w-0 bg-transparent text-3xl font-medium tabular-nums outline-none placeholder:text-mutedfg/50 sm:text-4xl",
            readOnly && "text-mutedfg",
          )}
        />
        {pill ??
          (asset ? (
            <span className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-accent pl-2 pr-3.5 text-base font-medium">
              <TokenIcon code={asset.code} size={24} /> {asset.code}
            </span>
          ) : null)}
      </div>
      <div className="mt-1 flex items-center justify-between text-sm text-mutedfg tabular-nums">
        <span>{hint ?? " "}</span>
        {balance !== undefined && balance !== null ? (
          onChange && !readOnly ? (
            <button type="button" onClick={() => onChange(balance)} className="transition hover:text-foreground" title="Use the full available balance">
              Balance: {balance}
            </button>
          ) : (
            <span>Balance: {balance}</span>
          )
        ) : null}
      </div>
    </div>
  );
}

/** Small pill row used for segmented selectors (modes, shapes, timeframes). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
  testId,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  className?: string;
  size?: "sm" | "md";
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={cn("flex w-full items-center gap-0.5 rounded-full border border-border bg-secondary p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          data-value={o.value}
          data-active={value === o.value ? "1" : "0"}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-full font-medium transition",
            size === "sm" ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
            value === o.value ? "bg-white/10 text-foreground" : "text-mutedfg hover:text-foreground",
            o.disabled && "cursor-not-allowed text-mutedfg/40 hover:text-mutedfg/40",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
