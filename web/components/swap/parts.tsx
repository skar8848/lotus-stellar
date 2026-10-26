"use client";

// Pieces of the previous front's order screen (owl/web components/app): token button (SwapPanel / AssetField),
// Lite / Pro switch (VersionSwitcher), settings popover (SlippageSettings), number input (LimitScreen NumberInput).

import { useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TokenIcon } from "@/components/common";
import { assetKey, shortAddr, type AssetRef } from "@/lib/stellar";
import { cn } from "@/lib/utils";

// same formatter as the lite SwapPanel
export const fmtNum = (n: number) =>
  n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 4 }) : n > 0 ? n.toPrecision(4) : "0";

/** LimitScreen fmtBalance */
export function fmtBalance(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return Number(n.toFixed(6)).toString();
}

export function TokenButton({ asset, options, onSelect, testId }: { asset: AssetRef; options: AssetRef[]; onSelect: (a: AssetRef) => void; testId?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className="h-11 shrink-0 gap-2 rounded-full pl-2 pr-3 text-base" data-testid={testId ?? "lite-token"}>
          <TokenIcon code={asset.code} size={24} /> {asset.code}
          <ChevronDown className="size-4 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {options.map((o) => (
          <DropdownMenuItem key={assetKey(o)} onClick={() => onSelect(o)} data-testid={`lite-token-${o.code}`}>
            <TokenIcon code={o.code} size={18} /> {o.code}
            <span className="ml-1 text-[11px] text-mutedfg">{o.issuer ? shortAddr(o.issuer) : "native"}</span>
            {assetKey(asset) === assetKey(o) && <Check className="ml-auto size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// components/app/VersionSwitcher.tsx: two views of the same page (Lite = /swap, Pro = /swap?mode=pro)
const VERSIONS = [
  { mode: "lite", href: "/swap", label: "Lite" },
  { mode: "pro", href: "/swap?mode=pro", label: "Pro" },
] as const;

export function VersionSwitcher({ current }: { current: "lite" | "pro" }) {
  return (
    <div className="flex w-fit items-center gap-0.5 rounded-full border border-line bg-secondary p-0.5 text-xs" data-testid="version-switcher">
      {VERSIONS.map((v) => (
        <Link
          key={v.mode}
          href={v.href}
          scroll={false}
          data-testid={`version-${v.mode}`}
          className={cn("rounded-full px-3 py-1 font-medium transition", current === v.mode ? "bg-white/10 text-white" : "text-mutedfg hover:text-white")}
        >
          {v.label}
        </Link>
      ))}
    </div>
  );
}

// components/app/SlippageSettings.tsx
const SLIP_PRESETS = [0.1, 0.5, 1];
export function SlippageSettings({ slippage, onChange }: { slippage: number; onChange: (v: number) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="size-9" aria-label="Settings" data-testid="lite-settings">
          <Settings className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="text-sm font-medium">Settings</div>
        <div className="mt-1 text-xs text-mutedfg">Max slippage tolerance</div>
        <div className="mt-2 flex items-center gap-2">
          {SLIP_PRESETS.map((p) => (
            <Button key={p} size="sm" variant={slippage === p ? "default" : "outline"} onClick={() => onChange(p)} className="flex-1">
              {p}%
            </Button>
          ))}
          <div className="flex items-center gap-1 rounded-md border border-line px-2">
            <Input
              type="number"
              value={slippage}
              min={0}
              max={50}
              onChange={(e) => onChange(Math.min(50, Math.max(0, Number(e.target.value))))}
              className="h-7 w-12 border-0 bg-transparent px-0 text-right text-sm shadow-none focus-visible:ring-0"
            />
            <span className="text-xs text-mutedfg">%</span>
          </div>
        </div>
        {slippage > 5 && <p className="mt-2 text-[11px] text-red">High slippage — your fill may be front-run.</p>}
      </PopoverContent>
    </Popover>
  );
}

/** LimitScreen NumberInput: can be emptied while typing; external updates flow back in on blur. */
export function NumberInput({ value, onChange, className, placeholder, testId, dp = 7 }: { value: number; onChange: (v: number) => void; className?: string; placeholder?: string; testId?: string; dp?: number }) {
  const [buf, setBuf] = useState<string | null>(null);
  const shown = buf ?? (value === 0 ? "" : String(Number(value.toFixed(dp))));
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={shown}
      placeholder={placeholder ?? "0"}
      data-testid={testId}
      onChange={(e) => {
        const v = e.target.value.replace(/[^0-9.]/g, "");
        setBuf(v);
        onChange(v === "" ? 0 : Number(v));
      }}
      onBlur={() => setBuf(null)}
      className={className}
    />
  );
}

export function Row({ k, v, testId }: { k: string; v: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1" data-testid={testId}>
      <span>{k}</span>
      <span className="text-right tabular-nums text-white">{v}</span>
    </div>
  );
}
